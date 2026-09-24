#!/usr/bin/env python3
"""The relay's one write path to its per-exchange secrets table.

coturn reads its secrets from the turn_secret table of the SQLite file
/var/lib/alcove-relay/turndb, one (realm, value) row per key, per request. This
module writes that table directly, and keeps the exchange id -> key mapping as
a second table, alcove_exchange, in the same file, so a register, revoke, or
sweep is one transaction and its result is the write's own return.
register-exchange.sh, revoke-exchange.sh, sweep-exchanges.sh, verify.sh, the
sweep unit, and registrar.py all come through here. infra/relay/README.md,
Per-exchange keys, is the contract.

    relay_table.py register <exchange-id> <max-age-days|none>   key on stdin
    relay_table.py revoke <exchange-id>
    relay_table.py sweep
    relay_table.py status <exchange-id>                         key on stdin
    relay_table.py forget-key                                   key on stdin
    relay_table.py import-mapping <file>

A key is only ever read from standard input, so it is never on a command line.
Run as root, it drops to the account owning turndb -- the relay image's -- before
opening it, so a file it creates is one coturn can use. Exit status: 0 done, 1
the table could not be read or written and nothing changed, 2 usage, 3 refused
(a malformed argument, or the exchange's state), nothing changed.

Python 3.9 standard library only: the version Amazon Linux 2023 ships.
"""

import datetime
import os
import re
import sqlite3
import sys
import time
import urllib.parse

TURNDB = os.environ.get("ALCOVE_RELAY_TURNDB") or "/var/lib/alcove-relay/turndb"

EXCHANGE_ID = re.compile(r"[A-Za-z0-9._][A-Za-z0-9._-]{0,127}")
KEY = re.compile(r"[0-9a-f]{64}")
HEX_RUN = re.compile(r"[0-9A-Fa-f]{64}")
# The ceiling of the managed-exchange record's tokenMaxAgeDays,
# MAX_TOKEN_MAX_AGE_DAYS in packages/core/src/config/connection.ts.
MAX_AGE_DAYS_CEILING = 36500
# verify.sh registers, and on exit revokes, fixed ids under this prefix.
VERIFY_ID_PREFIX = "alcove-verify-"
ID_REFUSAL = (
    "exchange-id must be 1 to 128 of [A-Za-z0-9._-], not starting with '-' and "
    "not containing a run of 64 hex characters"
)
VERIFY_ID_REFUSAL = (
    "exchange-id may not start with '%s': verify.sh registers and revokes those ids "
    "on every run; give the exchange another id" % VERIFY_ID_PREFIX
)
KEY_REFUSAL = "key must be 64 lowercase hex characters [0-9a-f]"
MAX_AGE_REFUSAL = "max-age-days must be a whole number of days from 1 to %d, or none" % MAX_AGE_DAYS_CEILING
DAY_SECONDS = 86400
BUSY_TIMEOUT_SECONDS = 10

# The columns of coturn's turn_secret this module writes. The schema check in
# scripts/relay-turn-secret-schema.test.mjs holds them against the pinned image.
TURN_SECRET_COLUMNS = ("realm", "value")
MAPPING_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS alcove_exchange ("
    "exchange_id TEXT PRIMARY KEY NOT NULL, "
    "realm TEXT NOT NULL, "
    "key TEXT NOT NULL UNIQUE, "
    "registered_at INTEGER NOT NULL, "
    "max_age_days INTEGER)"
)


class Refused(Exception):
    """A request refused on its arguments or the exchange's state; the message
    never holds a key."""


class TableError(Exception):
    """The table could not be read or written; the message never holds a key."""


def valid_exchange_id(exchange_id):
    return (
        isinstance(exchange_id, str)
        and EXCHANGE_ID.fullmatch(exchange_id) is not None
        and HEX_RUN.search(exchange_id) is None
    )


def valid_key(key):
    return isinstance(key, str) and KEY.fullmatch(key) is not None


def valid_max_age_days(days):
    """None is a registration with no lapse."""
    if days is None:
        return True
    return isinstance(days, int) and not isinstance(days, bool) and 1 <= days <= MAX_AGE_DAYS_CEILING


def is_verify_id(exchange_id):
    return exchange_id.startswith(VERIFY_ID_PREFIX)


def check_registration(exchange_id, key, max_age_days, allow_verify_id=False):
    if not valid_exchange_id(exchange_id):
        raise Refused(ID_REFUSAL)
    if is_verify_id(exchange_id) and not allow_verify_id:
        raise Refused(VERIFY_ID_REFUSAL)
    if not valid_key(key):
        raise Refused(KEY_REFUSAL)
    if not valid_max_age_days(max_age_days):
        raise Refused(MAX_AGE_REFUSAL)


def open_table(path=None):
    """Opens coturn's existing turndb for writing, never creating it, and adds the
    mapping table when absent."""
    path = path or TURNDB
    if not os.path.exists(path):
        raise TableError(
            "no secrets table at %s; alcove-relay.service creates it at its first start, so start it and run again"
            % path
        )
    try:
        conn = sqlite3.connect(
            "file:%s?mode=rw" % urllib.parse.quote(path),
            uri=True,
            timeout=BUSY_TIMEOUT_SECONDS,
            isolation_level=None,
        )
    except sqlite3.Error as error:
        raise TableError("could not open the secrets table %s: %s; nothing changed" % (path, error))
    try:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(turn_secret)")}
        if not set(TURN_SECRET_COLUMNS) <= columns:
            raise TableError(
                "%s has no turn_secret table with columns %s; it is not coturn's database, or the pinned coturn changed its schema"
                % (path, ", ".join(TURN_SECRET_COLUMNS))
            )
        conn.execute(MAPPING_SCHEMA)
    except sqlite3.Error as error:
        conn.close()
        raise TableError("could not open the secrets table %s for writing: %s; nothing changed" % (path, error))
    except TableError:
        conn.close()
        raise
    return conn


def _transaction(conn, body):
    try:
        conn.execute("BEGIN IMMEDIATE")
    except sqlite3.Error as error:
        raise TableError("could not lock the secrets table: %s; nothing changed" % error)
    try:
        result = body()
        conn.execute("COMMIT")
        return result
    except BaseException as error:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        if isinstance(error, sqlite3.Error):
            raise TableError("could not write the secrets table: %s; nothing changed" % error)
        raise


def lapses_at(registered_at, max_age_days):
    if max_age_days is None:
        return None
    return registered_at + max_age_days * DAY_SECONDS


def iso_time(seconds):
    return datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def register(conn, realm, exchange_id, key, max_age_days, now, allow_verify_id=False):
    """Adds the key's row and points the exchange at it, deleting the exchange's
    prior row in the same transaction. Registering the key the exchange already
    holds renews its stamp and lapse. Returns the registration."""
    check_registration(exchange_id, key, max_age_days, allow_verify_id)
    if not realm:
        raise Refused("ALCOVE_RELAY_REALM is unset")
    now = int(now)

    def body():
        holder = conn.execute("SELECT exchange_id FROM alcove_exchange WHERE key = ?", (key,)).fetchone()
        if holder is not None and holder[0] != exchange_id:
            raise Refused("the key is already registered for exchange %s; revoke that exchange first" % holder[0])
        prior = conn.execute(
            "SELECT realm, key FROM alcove_exchange WHERE exchange_id = ?", (exchange_id,)
        ).fetchone()
        conn.execute("INSERT OR IGNORE INTO turn_secret (realm, value) VALUES (?, ?)", (realm, key))
        if prior is not None and (prior[0], prior[1]) != (realm, key):
            conn.execute("DELETE FROM turn_secret WHERE realm = ? AND value = ?", prior)
        conn.execute(
            "INSERT OR REPLACE INTO alcove_exchange (exchange_id, realm, key, registered_at, max_age_days) "
            "VALUES (?, ?, ?, ?, ?)",
            (exchange_id, realm, key, now, max_age_days),
        )
        if prior is None:
            return "registered"
        return "renewed" if prior[1] == key else "replaced"

    outcome = _transaction(conn, body)
    return {
        "outcome": outcome,
        "exchange_id": exchange_id,
        "realm": realm,
        "registered_at": now,
        "max_age_days": max_age_days,
        "lapses_at": lapses_at(now, max_age_days),
    }


def describe_registration(registration):
    head = {
        "registered": "registered exchange %s (realm %s)",
        "replaced": "registered exchange %s (realm %s), replacing its prior key",
        "renewed": "renewed exchange %s (realm %s), which already had this key registered",
    }[registration["outcome"]] % (registration["exchange_id"], registration["realm"])
    if registration["max_age_days"] is None:
        return head + "; it has no lapse and stays registered until revoked or replaced"
    return head + "; it lapses %d day(s) after this registration, at %s, unless registered again" % (
        registration["max_age_days"],
        iso_time(registration["lapses_at"]),
    )


def revoke(conn, exchange_id):
    """Deletes the exchange's row and its mapping in one transaction."""
    if not valid_exchange_id(exchange_id):
        raise Refused(ID_REFUSAL)

    def body():
        mapped = conn.execute(
            "SELECT realm, key FROM alcove_exchange WHERE exchange_id = ?", (exchange_id,)
        ).fetchone()
        if mapped is None:
            raise Refused("exchange-id %s is not registered on this relay" % exchange_id)
        deleted = conn.execute("DELETE FROM turn_secret WHERE realm = ? AND value = ?", mapped).rowcount
        conn.execute("DELETE FROM alcove_exchange WHERE exchange_id = ?", (exchange_id,))
        return {"exchange_id": exchange_id, "realm": mapped[0], "key_was_listed": deleted > 0}

    return _transaction(conn, body)


def describe_revocation(revocation):
    text = "revoked exchange %s (realm %s)" % (revocation["exchange_id"], revocation["realm"])
    if not revocation["key_was_listed"]:
        text += "; its key was not in the secrets table"
    return text


def sweep(conn, now):
    """Revokes, in one transaction, every exchange whose registration is at least
    its max-age-days old at `now`. Returns the revoked exchanges."""
    now = int(now)

    def body():
        lapsed = conn.execute(
            "SELECT exchange_id, realm, key FROM alcove_exchange "
            "WHERE max_age_days IS NOT NULL AND ? - registered_at >= max_age_days * ? "
            "ORDER BY exchange_id",
            (now, DAY_SECONDS),
        ).fetchall()
        revoked = []
        for exchange_id, realm, key in lapsed:
            deleted = conn.execute("DELETE FROM turn_secret WHERE realm = ? AND value = ?", (realm, key)).rowcount
            conn.execute("DELETE FROM alcove_exchange WHERE exchange_id = ?", (exchange_id,))
            revoked.append({"exchange_id": exchange_id, "realm": realm, "key_was_listed": deleted > 0})
        return revoked

    return _transaction(conn, body)


def status(conn, realm, exchange_id, key):
    """"both" when the mapping points the exchange at the key and the table lists
    it, "neither" when neither holds it, and "disagree" otherwise."""
    mapped = conn.execute(
        "SELECT 1 FROM alcove_exchange WHERE exchange_id = ? AND realm = ? AND key = ?",
        (exchange_id, realm, key),
    ).fetchone()
    listed = conn.execute("SELECT 1 FROM turn_secret WHERE realm = ? AND value = ?", (realm, key)).fetchone()
    if mapped and listed:
        return "both"
    if not mapped and not listed:
        return "neither"
    return "disagree"


def forget_key(conn, realm, key):
    """Deletes the key's row and any mapping holding it. Returns whether a row
    was deleted."""
    if not valid_key(key):
        raise Refused(KEY_REFUSAL)

    def body():
        deleted = conn.execute("DELETE FROM turn_secret WHERE realm = ? AND value = ?", (realm, key)).rowcount
        conn.execute("DELETE FROM alcove_exchange WHERE key = ?", (key,))
        return deleted > 0

    return _transaction(conn, body)


def parse_mapping(text, now):
    """The rows of the text mapping the shell scripts kept before this module:
    "<id> <key> [<registered-at> <max-age-days|->]" per line. A row is held to
    a fresh registration's rules, and its stamp to at most `now`, except a row
    under verify.sh's reserved prefix (is_verify_id) is skipped rather than
    refusing the whole file: a verify run that died before cleanup can leave
    one behind. Every other refusal still refuses the whole file. Returns
    (rows, skipped_verify_count)."""
    now = int(now)
    rows = []
    skipped_verify = 0
    for number, line in enumerate(text.split("\n"), 1):
        if line.endswith("\r"):
            line = line[:-1]
        fields = line.split()
        if not fields:
            continue
        if len(fields) not in (2, 4):
            raise Refused("line %d of the mapping is not '<exchange-id> <key> [<registered-at> <max-age-days>]'" % number)
        registered_at, max_age_days = None, None
        if len(fields) == 4:
            if not fields[2].isdigit() or not (fields[3] == "-" or fields[3].isdigit()):
                raise Refused("line %d of the mapping has a malformed stamp or max-age-days" % number)
            registered_at = int(fields[2])
            max_age_days = None if fields[3] == "-" else int(fields[3])
            if registered_at > now:
                raise Refused("line %d of the mapping has a registered-at stamp later than now" % number)
        try:
            check_registration(fields[0], fields[1], max_age_days, allow_verify_id=True)
        except Refused as refusal:
            raise Refused("line %d of the mapping: %s" % (number, refusal))
        if is_verify_id(fields[0]):
            skipped_verify += 1
            continue
        rows.append((fields[0], fields[1], registered_at, max_age_days))
    return rows, skipped_verify


def import_mapping(conn, realm, rows, now):
    """Adds each row an earlier mapping held, in one transaction, leaving an
    exchange this table already maps alone. Returns (imported, skipped)."""

    def body():
        imported = skipped = 0
        for exchange_id, key, registered_at, max_age_days in rows:
            known = conn.execute(
                "SELECT 1 FROM alcove_exchange WHERE exchange_id = ? OR key = ?", (exchange_id, key)
            ).fetchone()
            if known is not None:
                skipped += 1
                continue
            conn.execute("INSERT OR IGNORE INTO turn_secret (realm, value) VALUES (?, ?)", (realm, key))
            conn.execute(
                "INSERT INTO alcove_exchange (exchange_id, realm, key, registered_at, max_age_days) VALUES (?, ?, ?, ?, ?)",
                (exchange_id, realm, key, registered_at if registered_at is not None else int(now), max_age_days),
            )
            imported += 1
        return imported, skipped

    return _transaction(conn, body)


# --- the command line ------------------------------------------------------------

USAGE = """usage: relay_table.py register <exchange-id> <max-age-days|none>   (key on stdin)
       relay_table.py revoke <exchange-id>
       relay_table.py sweep
       relay_table.py status <exchange-id>                         (key on stdin)
       relay_table.py forget-key                                   (key on stdin)
       relay_table.py import-mapping <file>
"""
ARITY = {"register": 2, "revoke": 1, "sweep": 0, "status": 1, "forget-key": 0, "import-mapping": 1}


def read_key():
    line = sys.stdin.readline(4096)
    return line[:-1] if line.endswith("\n") else line


def parse_max_age_days(text):
    if text == "none":
        return None
    if not text.isdigit() or text.startswith("0") or len(text) > len(str(MAX_AGE_DAYS_CEILING)):
        raise Refused(MAX_AGE_REFUSAL)
    return int(text)


def run_as_table_owner(path):
    """As root, becomes the account that owns turndb; otherwise requires being it."""
    try:
        owner = os.stat(path)
    except OSError:
        return
    recorded = os.environ.get("ALCOVE_RELAY_IMAGE_UID") or ""
    if recorded.isdigit() and int(recorded) != owner.st_uid:
        raise TableError(
            "%s is owned by uid %d, but the relay image runs as uid %s; chown it to %s so coturn can read what is written"
            % (path, owner.st_uid, recorded, recorded)
        )
    if os.geteuid() == 0:
        if owner.st_uid == 0:
            raise TableError("%s is owned by root; chown it to the relay image's uid so coturn can read it" % path)
        os.setgroups([])
        os.setgid(owner.st_gid)
        os.setuid(owner.st_uid)
    elif os.geteuid() != owner.st_uid:
        raise TableError("run this as root or as uid %d, which owns %s" % (owner.st_uid, path))


def run_command(command, args):
    realm = os.environ.get("ALCOVE_RELAY_REALM") or ""
    if command == "register":
        exchange_id, days_text = args
        key = read_key()
        max_age_days = parse_max_age_days(days_text)
        check_registration(exchange_id, key, max_age_days, os.environ.get("ALCOVE_RELAY_VERIFY_RUN") == "1")
        if not realm:
            raise Refused("ALCOVE_RELAY_REALM is unset in relay.env")
        run_as_table_owner(TURNDB)
        conn = open_table()
        print(describe_registration(register(conn, realm, exchange_id, key, max_age_days, time.time(), True)))
        return 0
    if command == "revoke":
        if not valid_exchange_id(args[0]):
            raise Refused(ID_REFUSAL)
        run_as_table_owner(TURNDB)
        print(describe_revocation(revoke(open_table(), args[0])))
        return 0
    if command == "sweep":
        run_as_table_owner(TURNDB)
        revoked = sweep(open_table(), time.time())
        for revocation in revoked:
            print("%s: its registration lapsed" % describe_revocation(revocation))
        print("swept %d lapsed exchange(s)" % len(revoked))
        return 0
    if command == "status":
        key = read_key()
        if not valid_exchange_id(args[0]):
            raise Refused(ID_REFUSAL)
        if not valid_key(key):
            raise Refused(KEY_REFUSAL)
        run_as_table_owner(TURNDB)
        return {"both": 0, "neither": 3, "disagree": 4}[status(open_table(), realm, args[0], key)]
    if command == "forget-key":
        key = read_key()
        if not valid_key(key):
            raise Refused(KEY_REFUSAL)
        run_as_table_owner(TURNDB)
        if forget_key(open_table(), realm, key):
            print("removed the key's row (realm %s)" % realm)
        else:
            print("no row in realm %s held the key" % realm)
        return 0
    if command == "import-mapping":
        if not realm:
            raise Refused("ALCOVE_RELAY_REALM is unset in relay.env")
        try:
            with open(args[0], encoding="ascii") as handle:
                text = handle.read()
        except (OSError, UnicodeDecodeError) as error:
            raise TableError("could not read the mapping %s: %s" % (args[0], error))
        now = time.time()
        rows, skipped_verify = parse_mapping(text, now)
        run_as_table_owner(TURNDB)
        imported, skipped = import_mapping(open_table(), realm, rows, now)
        print("imported %d exchange(s) from %s; %d already registered here were left alone" % (imported, args[0], skipped))
        if skipped_verify:
            print(
                "skipped %d row(s) under verify.sh's '%s' prefix, never inserted: a verify run that died before "
                "cleanup can leave those behind" % (skipped_verify, VERIFY_ID_PREFIX)
            )
        return 0
    raise AssertionError(command)


def main(argv):
    if len(argv) < 1 or argv[0] not in ARITY or len(argv) - 1 != ARITY[argv[0]]:
        sys.stderr.write(USAGE)
        return 2
    try:
        return run_command(argv[0], argv[1:])
    except Refused as error:
        sys.stderr.write("ABORTING: %s\n" % error)
        return 3
    except TableError as error:
        sys.stderr.write("ABORTING: %s\n" % error)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
