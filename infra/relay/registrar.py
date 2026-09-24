#!/usr/bin/env python3
"""The relay's registrar: register and revoke an exchange's relay key over HTTPS.

    PUT    /exchanges/<exchange-id>   {"key": "<key-hex64>", "maxAgeDays": <n> | null}
    DELETE /exchanges/<exchange-id>

Every request but a CORS preflight must carry "Authorization: Bearer <token>",
the relay-owner token; any other request is answered 401 before its body is
parsed. Authentication reads that header and nothing else, and no answer allows
credentials, so a browser's cookies never authenticate a call. A registration or
revocation is one transaction through relay_table.py beside this file, the
secrets table's one write path. infra/relay/README.md, The registrar, is the
contract.

Runs as the relay image's account, which owns the table, and reads the token and
certificate from the credentials systemd hands the unit.

Python 3.9 standard library only: the version Amazon Linux 2023 ships.
"""

import hmac
import http.server
import json
import os
import ssl
import sys
import threading
import time

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import relay_table  # noqa: E402

ETC = "/etc/alcove-relay"
# systemd's LoadCredential= copies the root-only files into this directory.
CREDENTIALS = os.environ.get("CREDENTIALS_DIRECTORY")
TOKEN_FILE = os.environ.get("ALCOVE_RELAY_REGISTRAR_TOKEN_FILE") or (
    os.path.join(CREDENTIALS, "registrar-token") if CREDENTIALS else ETC + "/registrar-token"
)
CERT_DIR = os.environ.get("ALCOVE_RELAY_CERT_DIR") or (CREDENTIALS or ETC + "/certs")
PORT = os.environ.get("ALCOVE_RELAY_REGISTRAR_PORT") or "8443"
REALM = os.environ.get("ALCOVE_RELAY_REALM") or ""

PREFIX = "/exchanges/"
MAX_BODY_BYTES = 1024
# A slow or silent client holds one thread for at most this long.
CONNECTION_TIMEOUT_SECONDS = 15
MIN_TOKEN_LENGTH = 32
ID_REFUSAL = relay_table.ID_REFUSAL
VERIFY_ID_REFUSAL = relay_table.VERIFY_ID_REFUSAL
KEY_REFUSAL = "key must be 64 lowercase hex characters [0-9a-f]"
MAX_AGE_REFUSAL = (
    "maxAgeDays must be a whole number of days from 1 to %d, or null for no lapse" % relay_table.MAX_AGE_DAYS_CEILING
)
BODY_REFUSAL = 'the request body must be {"key": "<key-hex64>", "maxAgeDays": <days> | null}; maxAgeDays is required'
# The header verify.sh sends to register its own ids under the reserved prefix.
# A browser cannot send it: the preflight does not allow it.
VERIFY_RUN_HEADER = "Alcove-Relay-Verify-Run"
# The journal names a request's method only from this list.
KNOWN_METHODS = frozenset(("GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS", "PATCH", "TRACE", "CONNECT"))


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


valid_exchange_id = relay_table.valid_exchange_id
valid_key = relay_table.valid_key
valid_max_age_days = relay_table.valid_max_age_days


class RegistrarHandler(http.server.BaseHTTPRequestHandler):
    server_version = "alcove-relay-registrar"
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

    def log_request(self, code="-", size="-"):
        # The request line can carry a key -- in the path, or anywhere in a
        # malformed line -- so the journal gets the method and path only when
        # they have a shape no key has.
        command = self.command or ""
        method = command if command in KNOWN_METHODS else "(other method)"
        exchange_id = self.exchange_id() if command else None
        path = self.path if exchange_id is not None and valid_exchange_id(exchange_id) else "(path withheld)"
        self.log_message("%s %s %s", method, path, str(int(code)) if code != "-" else code)

    def send_error(self, code, message=None, explain=None):
        # Every error the standard library answers itself -- an unsupported
        # method, a malformed request line or header block -- is answered here,
        # in JSON, and with nothing from the request logged or echoed back.
        if code == 501:
            self.refuse_method()
            return
        self.close_connection = True
        try:
            reason = self.responses[code][0]
        except KeyError:
            reason = "error"
        self.send_json(code, {"error": "the request is malformed: %s" % reason.lower()}, (("Connection", "close"),))

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

    def discard_body(self):
        # A small body is read and discarded, so the next request on the
        # connection starts where this one ends, and because closing a socket
        # with unread data resets it and can lose the answer; any other body
        # ends the connection unread. Returns the headers the answer carries.
        length = self.headers.get("Content-Length") or "0"
        if "Transfer-Encoding" not in self.headers and length.isdigit() and int(length) <= MAX_BODY_BYTES:
            self.rfile.read(int(length))
            return ()
        self.close_connection = True
        return (("Connection", "close"),)

    def refuse(self, status, message, extra_headers=()):
        self.send_json(status, {"error": message}, self.discard_body() + tuple(extra_headers))

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
            (("WWW-Authenticate", 'Bearer realm="alcove-relay-registrar"'),),
        )
        return False

    def exchange_id(self):
        path = getattr(self, "path", "")
        if not path.startswith(PREFIX):
            return None
        exchange_id = path[len(PREFIX) :]
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

    def write_table(self, operation, extra_headers=()):
        # One write at a time from this process; SQLite's lock orders it
        # against the scripts and the sweep.
        with self.server.table_lock:
            try:
                conn = relay_table.open_table()
                try:
                    return operation(conn)
                finally:
                    conn.close()
            except relay_table.Refused as error:
                self.send_json(409, {"error": str(error)}, extra_headers)
            except relay_table.TableError as error:
                sys.stderr.write("%s\n" % error)
                self.send_json(500, {"error": str(error)}, extra_headers)
        return None

    def do_OPTIONS(self):
        # A browser's CORS preflight carries no Authorization header, so it is
        # answered without one and does nothing.
        closing = self.discard_body()
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "PUT, DELETE")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        for name, value in closing:
            self.send_header(name, value)
        self.end_headers()

    def do_PUT(self):
        if not self.authorized():
            return
        exchange_id = self.exchange_id()
        if exchange_id is None:
            self.refuse(404, "register at PUT %s<exchange-id>" % PREFIX)
            return
        if not valid_exchange_id(exchange_id):
            self.refuse(400, ID_REFUSAL)
            return
        if relay_table.is_verify_id(exchange_id) and self.headers.get(VERIFY_RUN_HEADER) != "1":
            self.refuse(400, VERIFY_ID_REFUSAL)
            return
        raw = self.read_body()
        if raw is None:
            return
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            self.send_json(400, {"error": "the request body is not JSON"})
            return
        if not isinstance(body, dict) or set(body) != {"key", "maxAgeDays"}:
            self.send_json(400, {"error": BODY_REFUSAL})
            return
        key = body["key"]
        max_age_days = body["maxAgeDays"]
        if not valid_key(key):
            self.send_json(400, {"error": KEY_REFUSAL})
            return
        if not valid_max_age_days(max_age_days):
            self.send_json(400, {"error": MAX_AGE_REFUSAL})
            return
        registration = self.write_table(
            lambda conn: relay_table.register(conn, REALM, exchange_id, key, max_age_days, time.time(), True)
        )
        if registration is None:
            return
        message = relay_table.describe_registration(registration)
        sys.stderr.write("register: %s\n" % message)
        lapses_at = registration["lapses_at"]
        self.send_json(
            200,
            {
                "message": message,
                "maxAgeDays": registration["max_age_days"],
                "lapsesAt": None if lapses_at is None else relay_table.iso_time(lapses_at),
            },
        )

    def do_DELETE(self):
        if not self.authorized():
            return
        exchange_id = self.exchange_id()
        if exchange_id is None:
            self.refuse(404, "revoke at DELETE %s<exchange-id>" % PREFIX)
            return
        if not valid_exchange_id(exchange_id):
            self.refuse(400, ID_REFUSAL)
            return
        closing = self.discard_body()
        revocation = self.write_table(lambda conn: relay_table.revoke(conn, exchange_id), closing)
        if revocation is None:
            return
        message = relay_table.describe_revocation(revocation)
        sys.stderr.write("revoke: %s\n" % message)
        self.send_json(200, {"message": message}, closing)

    def refuse_method(self):
        # Reached through send_error's 501 for every method with no do_ handler.
        if self.authorized():
            self.refuse(405, "use PUT or DELETE on %s<exchange-id>" % PREFIX, (("Allow", "PUT, DELETE"),))


class RegistrarServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        error = sys.exc_info()[1]
        sys.stderr.write("%s connection ended: %s\n" % (client_address[0], error))


def main():
    if not PORT.isdigit() or int(PORT) > 65535:
        fail_start("ALCOVE_RELAY_REGISTRAR_PORT is '%s'; set it to a port number" % PORT)
    if not REALM:
        fail_start("ALCOVE_RELAY_REALM is unset; the unit reads it from /etc/alcove-relay/relay.env")
    token = read_token()
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    try:
        context.load_cert_chain(os.path.join(CERT_DIR, "fullchain.pem"), os.path.join(CERT_DIR, "privkey.pem"))
    except (OSError, ssl.SSLError) as error:
        fail_start("could not load the certificate in %s: %s" % (CERT_DIR, error))

    try:
        server = RegistrarServer(("", int(PORT)), RegistrarHandler)
    except OSError as error:
        fail_start("could not listen on port %s: %s" % (PORT, error))
    server.token = token
    server.table_lock = threading.Lock()
    server.socket = context.wrap_socket(server.socket, server_side=True, do_handshake_on_connect=False)
    sys.stdout.write("Alcove relay registrar listening on port %d\n" % server.server_address[1])
    sys.stdout.flush()
    server.serve_forever()


if __name__ == "__main__":
    main()
