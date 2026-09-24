#!/usr/bin/env python3
"""The relay's registrar: register and revoke an exchange's relay key over HTTPS.

    PUT    /exchanges/<exchange-id>   {"key": "<key-hex64>", "maxAgeDays": <n>}
    DELETE /exchanges/<exchange-id>

Every request but a CORS preflight must carry "Authorization: Bearer <token>",
the relay-owner token in /etc/psilink-relay/registrar-token; any other request
is answered 401 before its body is parsed. A registration or revocation runs
register-exchange.sh or revoke-exchange.sh beside this file, so the secrets
table has one write path. infra/relay/README.md, The registrar, is the contract.

Python 3.9 standard library only: the version Amazon Linux 2023 ships.
"""

import hmac
import http.server
import json
import os
import ssl
import subprocess
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
ETC = "/etc/psilink-relay"
TOKEN_FILE = os.environ.get("PSILINK_RELAY_REGISTRAR_TOKEN_FILE", ETC + "/registrar-token")
CERT_DIR = os.environ.get("PSILINK_RELAY_CERT_DIR", ETC + "/certs")
PORT = os.environ.get("PSILINK_RELAY_REGISTRAR_PORT") or "8443"

PREFIX = "/exchanges/"
MAX_BODY_BYTES = 1024
# A slow or silent client holds one thread for at most this long.
CONNECTION_TIMEOUT_SECONDS = 15
# Each script runs turnadmin in a throwaway container two to four times.
SCRIPT_TIMEOUT_SECONDS = 120
MIN_TOKEN_LENGTH = 32


def fail_start(message):
    sys.stderr.write("ABORTING: %s\n" % message)
    sys.exit(1)


def read_token():
    try:
        with open(TOKEN_FILE, encoding="ascii") as handle:
            token = handle.read().strip()
    except (OSError, UnicodeDecodeError) as error:
        fail_start("could not read the registrar token %s: %s" % (TOKEN_FILE, error))
    if len(token) < MIN_TOKEN_LENGTH or not token.isalnum():
        fail_start(
            "%s must hold one line of at least %d letters and digits; regenerate it with: openssl rand -hex 32"
            % (TOKEN_FILE, MIN_TOKEN_LENGTH)
        )
    return token.encode("ascii")


def last_line(text):
    lines = [line for line in text.strip().splitlines() if line.strip()]
    return lines[-1] if lines else ""


class RegistrarHandler(http.server.BaseHTTPRequestHandler):
    server_version = "psilink-relay-registrar"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    timeout = CONNECTION_TIMEOUT_SECONDS

    def setup(self):
        super().setup()
        # The listening socket defers the handshake, so a client that connects
        # and never completes one holds this thread, not the accept loop.
        self.connection.do_handshake()

    def log_message(self, format, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), format % args))

    def send_json(self, status, body, extra_headers=()):
        payload = (json.dumps(body) + "\n").encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        for name, value in extra_headers:
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def refuse(self, status, message, extra_headers=()):
        # A small body is read and discarded, because closing a socket with
        # unread data resets it and can lose the answer; any other body ends
        # the connection unread.
        length = self.headers.get("Content-Length") or "0"
        if "Transfer-Encoding" not in self.headers and length.isdigit() and int(length) <= MAX_BODY_BYTES:
            self.rfile.read(int(length))
        else:
            self.close_connection = True
            extra_headers = (("Connection", "close"),) + tuple(extra_headers)
        self.send_json(status, {"error": message}, extra_headers)

    def authorized(self):
        header = self.headers.get("Authorization", "")
        scheme, _, presented = header.partition(" ")
        if scheme.lower() == "bearer" and hmac.compare_digest(
            presented.strip().encode("utf-8", "replace"), self.server.token
        ):
            return True
        self.refuse(
            401,
            "missing or wrong relay-owner token; send Authorization: Bearer <token>",
            (("WWW-Authenticate", 'Bearer realm="psilink-relay-registrar"'),),
        )
        return False

    def exchange_id(self):
        if not self.path.startswith(PREFIX):
            return None
        exchange_id = self.path[len(PREFIX) :]
        if not exchange_id or "/" in exchange_id or "?" in exchange_id or "#" in exchange_id:
            return None
        return exchange_id

    def read_body(self):
        length = self.headers.get("Content-Length")
        if length is None or not length.isdigit():
            self.refuse(411, "send the request body with a Content-Length")
            return None
        if int(length) > MAX_BODY_BYTES:
            self.refuse(413, "the request body is over %d bytes" % MAX_BODY_BYTES)
            return None
        return self.rfile.read(int(length))

    def run_script(self, arguments):
        # One registration or revocation at a time; the scripts also lock.
        with self.server.script_lock:
            try:
                result = subprocess.run(
                    [os.path.join(HERE, arguments[0])] + arguments[1:],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    universal_newlines=True,
                    timeout=SCRIPT_TIMEOUT_SECONDS,
                )
            except subprocess.TimeoutExpired:
                self.send_json(500, {"error": "%s did not finish within %d s" % (arguments[0], SCRIPT_TIMEOUT_SECONDS)})
                return
        if result.returncode == 0:
            self.send_json(200, {"message": last_line(result.stdout)})
        else:
            sys.stderr.write(result.stderr)
            message = last_line(result.stderr)
            if message.startswith("ABORTING: "):
                message = message[len("ABORTING: ") :]
            self.send_json(409, {"error": message or "%s exited %d" % (arguments[0], result.returncode)})

    def do_OPTIONS(self):
        # A browser's CORS preflight carries no Authorization header, so it is
        # answered without one and does nothing.
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "PUT, DELETE")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_PUT(self):
        if not self.authorized():
            return
        exchange_id = self.exchange_id()
        if exchange_id is None:
            self.refuse(404, "register at PUT %s<exchange-id>" % PREFIX)
            return
        raw = self.read_body()
        if raw is None:
            return
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            self.send_json(400, {"error": "the request body is not JSON"})
            return
        if not isinstance(body, dict) or not set(body) <= {"key", "maxAgeDays"} or "key" not in body:
            self.send_json(400, {"error": 'the request body must be {"key": "<key-hex64>", "maxAgeDays": <days>}, maxAgeDays optional'})
            return
        key = body["key"]
        max_age_days = body.get("maxAgeDays")
        if not isinstance(key, str):
            self.send_json(400, {"error": "key must be a string"})
            return
        if max_age_days is not None and (isinstance(max_age_days, bool) or not isinstance(max_age_days, int)):
            self.send_json(400, {"error": "maxAgeDays must be a whole number of days"})
            return
        arguments = ["register-exchange.sh", exchange_id, key]
        if max_age_days is not None:
            arguments.append(str(max_age_days))
        self.run_script(arguments)

    def do_DELETE(self):
        if not self.authorized():
            return
        exchange_id = self.exchange_id()
        if exchange_id is None:
            self.refuse(404, "revoke at DELETE %s<exchange-id>" % PREFIX)
            return
        self.run_script(["revoke-exchange.sh", exchange_id])

    def refuse_method(self):
        if self.authorized():
            self.refuse(405, "use PUT or DELETE on %s<exchange-id>" % PREFIX, (("Allow", "PUT, DELETE"),))

    do_GET = refuse_method
    do_HEAD = refuse_method
    do_POST = refuse_method
    do_PATCH = refuse_method


class RegistrarServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        error = sys.exc_info()[1]
        sys.stderr.write("%s connection ended: %s\n" % (client_address[0], error))


def main():
    if not PORT.isdigit() or int(PORT) > 65535:
        fail_start("PSILINK_RELAY_REGISTRAR_PORT is '%s'; set it to a port number" % PORT)
    token = read_token()
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    try:
        context.load_cert_chain(os.path.join(CERT_DIR, "fullchain.pem"), os.path.join(CERT_DIR, "privkey.pem"))
    except (OSError, ssl.SSLError) as error:
        fail_start("could not load the certificate in %s: %s" % (CERT_DIR, error))

    server = RegistrarServer(("", int(PORT)), RegistrarHandler)
    server.token = token
    server.script_lock = threading.Lock()
    server.socket = context.wrap_socket(server.socket, server_side=True, do_handshake_on_connect=False)
    sys.stdout.write("psilink relay registrar listening on port %d\n" % server.server_address[1])
    sys.stdout.flush()
    server.serve_forever()


if __name__ == "__main__":
    main()
