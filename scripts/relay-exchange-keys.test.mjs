import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// The relay's per-exchange key scripts, the lapse sweep, the registrar service,
// and the configuration render, driven against a fixture host. The container
// runtime is a stub on PATH that records the turnadmin arguments it is handed
// and keeps the secrets table as one "<key>[<realm>]" line per row, the form
// turnadmin -S lists, so the test needs no image and no sqlite3; what coturn
// does with those arguments is verify.sh's to drive against a running relay.

const here = dirname(fileURLToPath(import.meta.url));
const relay = resolve(here, "..", "infra/relay");
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";

const KEY_A = "a".repeat(64);
const KEY_B = "0123456789abcdef".repeat(4);
const KEY_C = "fedcba9876543210".repeat(4);
// A row every fixture table starts with, and a line only a listing prints: the
// scripts must print neither.
const KEY_LISTED = "5".repeat(64);
const LISTING_MARKER = "listing-marker";
// The Unix time the fixture's clock reads until a test moves it.
const NOW = 1790000000;
const DAY = 86400;
const UNOPENABLE_ERROR =
  "ERROR Cannot open SQLite DB connection: <relay.example>: unable to open database file";

const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

const fixtureHost = () => {
  const root = mkdtempSync(join(tmpdir(), "relay-exchange-keys-"));
  tmpDirs.push(root);
  const calls = join(root, "calls.log");
  const failOn = join(root, "fail-on");
  // turnadmin's measured failure modes: a read-only table takes no write and
  // says nothing, an unopenable one prints its error to stdout, and both exit 0.
  // The ignored-writes file names the write flags a read-only table ignores.
  const ignoredWrites = join(root, "ignored-writes");
  const unopenable = join(root, "table-unopenable");
  const echoValue = join(root, "echo-value");
  const failListingOnce = join(root, "fail-listing-once");
  const table = join(root, "turndb");
  writeFileSync(calls, "");
  writeFileSync(table, `${KEY_LISTED}[relay.example]\n`);
  const stub = join(root, "docker");
  writeFileSync(
    stub,
    [
      "#!/bin/bash",
      `printf '%s\\n' "$*" >> '${calls}'`,
      // verify.sh's TURNS client runs through the same runtime; it gets no answer.
      '[[ " $* " == *" --entrypoint turnadmin "* ]] || exit 0',
      `if [ -f '${failOn}' ] && [[ " $* " == *" $(cat '${failOn}') "* ]]; then exit 1; fi`,
      'op=; value=; realm=; args=("$@")',
      "for ((i = 0; i < $#; i++)); do",
      '  case "${args[i]}" in',
      '    -s|-X) op="${args[i]}"; value="${args[i+1]}" ;;',
      "    -S) op=-S ;;",
      '    -r) realm="${args[i+1]}" ;;',
      "  esac",
      "done",
      `[ -f '${echoValue}' ] && echo "ERROR could not write $value"`,
      `if [ "$op" = -S ] && [ -f '${failListingOnce}' ]; then rm '${failListingOnce}'; exit 1; fi`,
      `if [ -f '${unopenable}' ]; then echo '${UNOPENABLE_ERROR}'; exit 0; fi`,
      'case "$op" in',
      `  -S) echo 'INFO ${LISTING_MARKER}'; cat '${table}' ;;`,
      `  -s) grep -qxF -- -s '${ignoredWrites}' 2>/dev/null || echo "$value[$realm]" >> '${table}' ;;`,
      `  -X) grep -qxF -- -X '${ignoredWrites}' 2>/dev/null || { rows="$(grep -vxF -- "$value[$realm]" '${table}')"; printf '%s' "\${rows:+$rows$'\\n'}" > '${table}'; } ;;`,
      "esac",
      "exit 0",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);
  // mv and the mapping rewrite's awk fail while their flag file exists, so a
  // failed mapping write can be driven without root.
  const failMv = join(root, "fail-mv");
  const failAwk = join(root, "fail-awk");
  const mvStub = join(root, "mv");
  writeFileSync(
    mvStub,
    `#!/bin/bash\n[ -f '${failMv}' ] && exit 1\nexec ${process.env.PATH.split(
      ":",
    )
      .map((dir) => join(dir, "mv"))
      .find(existsSync)} "$@"\n`,
  );
  chmodSync(mvStub, 0o755);
  const awkStub = join(root, "awk");
  writeFileSync(
    awkStub,
    `#!/bin/bash\n[ -f '${failAwk}' ] && [[ "$*" == *'!='* ]] && exit 1\nexec ${process.env.PATH.split(
      ":",
    )
      .map((dir) => join(dir, "awk"))
      .find(existsSync)} "$@"\n`,
  );
  chmodSync(awkStub, 0o755);
  // The scripts read the clock as `date -u +%s`; the stub answers that from a
  // file a test can move, and passes every other use to the real date.
  const clock = join(root, "now");
  writeFileSync(clock, `${NOW}\n`);
  const dateStub = join(root, "date");
  writeFileSync(
    dateStub,
    `#!/bin/bash\nif [ "$*" = '-u +%s' ]; then cat '${clock}'; exit 0; fi\nexec ${process.env.PATH.split(
      ":",
    )
      .map((dir) => join(dir, "date"))
      .find(existsSync)} "$@"\n`,
  );
  chmodSync(dateStub, 0o755);
  const ipHelper = join(root, "external-ip");
  writeFileSync(ipHelper, "#!/bin/bash\necho 192.0.2.10/10.0.0.5\n");
  chmodSync(ipHelper, 0o755);
  const envFile = join(root, "relay.env");
  writeFileSync(
    envFile,
    [
      "PSILINK_RELAY_REALM=relay.example",
      "PSILINK_RELAY_RUNTIME=docker",
      `PSILINK_RELAY_EXTERNAL_IP_HELPER=${ipHelper}`,
      "",
    ].join("\n"),
  );
  const mapFile = join(root, "exchange-keys");
  const secretFile = join(root, "static-auth-secret");
  const conf = join(root, "turnserver.conf");
  const env = {
    ...process.env,
    PATH: `${root}:${process.env.PATH}`,
    PSILINK_RELAY_ENV_FILE: envFile,
    PSILINK_RELAY_EXCHANGE_KEYS: mapFile,
    PSILINK_RELAY_SECRET_FILE: secretFile,
    PSILINK_RELAY_CONF: conf,
    PSILINK_RELAY_REGISTRAR_TOKEN_FILE: join(root, "registrar-token"),
  };
  const runWith = (extraEnv, script, ...args) => {
    writeFileSync(calls, "");
    const result = spawnSync(BASH, [join(relay, script), ...args], {
      encoding: "utf8",
      env: { ...env, ...extraEnv },
    });
    const invocations = readFileSync(calls, "utf8")
      .split("\n")
      .filter((line) => line.includes("--entrypoint turnadmin"))
      .map((line) => line.slice(line.indexOf("turnadmin") + 10));
    for (const stream of [result.stdout, result.stderr]) {
      expect(stream).not.toContain(KEY_LISTED);
      expect(stream).not.toContain(LISTING_MARKER);
    }
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      turnadmin: invocations.filter((line) => line.split(" ")[1] !== "-S"),
      listings: invocations.filter((line) => line.split(" ")[1] === "-S")
        .length,
    };
  };
  const run = (script, ...args) => runWith({}, script, ...args);
  return {
    register: (...args) => run("register-exchange.sh", ...args),
    // No listener answers on the connect target, so the network probes fail
    // at once and the run reaches the secrets-table steps and its cleanup.
    verify: () =>
      runWith(
        {
          PSILINK_RELAY_VERIFY_CONNECT: "127.0.0.1",
          PSILINK_RELAY_VERIFY_WAIT: "0",
        },
        "verify.sh",
      ),
    revoke: (...args) => run("revoke-exchange.sh", ...args),
    sweep: () => run("sweep-exchanges.sh"),
    render: () => run("render-config.sh"),
    setClock: (seconds) => writeFileSync(clock, `${seconds}\n`),
    writeMapping: (text) => writeFileSync(mapFile, text, { mode: 0o600 }),
    env,
    root,
    calls: () => readFileSync(calls, "utf8"),
    clearCalls: () => writeFileSync(calls, ""),
    mapFile,
    mapping: () => (existsSync(mapFile) ? readFileSync(mapFile, "utf8") : ""),
    mapMode: () => statSync(mapFile).mode & 0o777,
    conf: () => readFileSync(conf, "utf8"),
    table: () => readFileSync(table, "utf8"),
    failTurnadminOn: (flag) => writeFileSync(failOn, flag),
    makeTableReadOnly: () => writeFileSync(ignoredWrites, "-s\n-X\n"),
    ignoreTableWrites: (flag) => writeFileSync(ignoredWrites, `${flag}\n`),
    makeTableUnopenable: () => writeFileSync(unopenable, ""),
    echoValueInErrors: () => writeFileSync(echoValue, ""),
    failNextListing: () => writeFileSync(failListingOnce, ""),
    failMappingWriteAt: (tool) =>
      writeFileSync(tool === "mv" ? failMv : failAwk, ""),
    mappingTemporaries: () =>
      readdirSync(root).filter(
        (name) =>
          name.startsWith("exchange-keys.") && name !== "exchange-keys.lock",
      ),
    secretFile,
  };
};

describe("register-exchange.sh", () => {
  it("adds the key to the table under the realm and records the exchange", () => {
    const host = fixtureHost();
    const result = host.register("exchange-1", KEY_A);
    expect(result.status, result.stderr).toBe(0);
    expect(result.turnadmin).toEqual([
      `localhost/psilink-relay:installed -s ${KEY_A} -r relay.example -b /var/lib/coturn/turndb`,
    ]);
    expect(host.mapping()).toBe(`exchange-1 ${KEY_A} ${NOW} -\n`);
    expect(host.mapMode()).toBe(0o600);
  });

  it("rotates by adding the new key, then deleting the prior one", () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A);
    host.register("exchange-2", KEY_B);
    const result = host.register("exchange-1", KEY_C);
    expect(result.status, result.stderr).toBe(0);
    expect(result.turnadmin.map((line) => line.split(" ").slice(1, 3))).toEqual(
      [
        ["-s", KEY_C],
        ["-X", KEY_A],
      ],
    );
    expect(host.mapping()).toBe(
      `exchange-2 ${KEY_B} ${NOW} -\nexchange-1 ${KEY_C} ${NOW} -\n`,
    );
  });

  it("keeps the prior key and mapping when the new key's add fails", () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A);
    host.failTurnadminOn("-s");
    const result = host.register("exchange-1", KEY_C);
    expect(result.status).toBe(1);
    expect(result.turnadmin.map((line) => line.split(" ")[1])).toEqual(["-s"]);
    expect(host.mapping()).toBe(`exchange-1 ${KEY_A} ${NOW} -\n`);
  });

  it("maps the new key and does not print the prior one when its delete fails", () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A);
    host.failTurnadminOn("-X");
    const result = host.register("exchange-1", KEY_C);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not remove its prior key");
    expect(result.stderr).toContain(host.mapFile);
    expect(result.stderr).toContain("-S -r relay.example");
    for (const key of [KEY_A, KEY_C]) {
      expect(result.stdout).not.toContain(key);
      expect(result.stderr).not.toContain(key);
    }
    expect(host.mapping()).toBe(`exchange-1 ${KEY_C} ${NOW} -\n`);
  });

  it.each(["mv", "awk"])(
    "leaves the mapping and no temporary when the mapping write fails at %s",
    (tool) => {
      const host = fixtureHost();
      host.register("exchange-1", KEY_A);
      host.failMappingWriteAt(tool);
      const result = host.register("exchange-1", KEY_C);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`could not record it in ${host.mapFile}`);
      expect(result.stderr).not.toContain(KEY_C);
      expect(host.mapping()).toBe(`exchange-1 ${KEY_A} ${NOW} -\n`);
      expect(host.mappingTemporaries()).toEqual([]);
    },
  );

  it.each([
    ["1.0", "1"],
    ["1e0", "1"],
    ["01", "1"],
    ["123e4567", "123e4568"],
    ["1230000000", "123e7"],
  ])("registers %s as its own exchange beside %s", (id, registered) => {
    const host = fixtureHost();
    host.register(registered, KEY_A);
    const result = host.register(id, KEY_B);
    expect(result.status, result.stderr).toBe(0);
    expect(result.turnadmin.map((line) => line.split(" ").slice(1, 3))).toEqual(
      [["-s", KEY_B]],
    );
    expect(host.mapping()).toBe(
      `${registered} ${KEY_A} ${NOW} -\n${id} ${KEY_B} ${NOW} -\n`,
    );
  });

  it("tells apart all-digit keys that are equal as floating-point numbers", () => {
    const host = fixtureHost();
    const key1 = "1" + "0".repeat(63);
    const key2 = "1" + "0".repeat(62) + "1";
    host.register("exchange-1", key1);
    const result = host.register("exchange-2", key2);
    expect(result.status, result.stderr).toBe(0);
    expect(host.mapping()).toBe(
      `exchange-1 ${key1} ${NOW} -\nexchange-2 ${key2} ${NOW} -\n`,
    );
  });

  it("changes nothing when the exchange already holds the key", () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A);
    const result = host.register("exchange-1", KEY_A);
    expect(result.status, result.stderr).toBe(0);
    expect(result.turnadmin).toEqual([]);
    expect(host.mapping()).toBe(`exchange-1 ${KEY_A} ${NOW} -\n`);
  });

  it("refuses a key another exchange holds", () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A);
    const result = host.register("exchange-2", KEY_A);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "already registered for exchange exchange-1",
    );
    expect(result.turnadmin).toEqual([]);
  });

  it("leaves the mapping alone when the table refuses the key", () => {
    const host = fixtureHost();
    host.failTurnadminOn("-s");
    const result = host.register("exchange-1", KEY_A);
    expect(result.status).toBe(1);
    expect(host.mapping()).toBe("");
  });

  it("keeps the table and mapping in step on the happy paths", () => {
    const host = fixtureHost();
    const first = host.register("exchange-1", KEY_A);
    expect(first.status, first.stderr).toBe(0);
    expect(first.listings).toBe(1);
    const rotated = host.register("exchange-1", KEY_B);
    expect(rotated.status, rotated.stderr).toBe(0);
    expect(rotated.listings).toBe(2);
    expect(host.table()).toBe(
      `${KEY_LISTED}[relay.example]\n${KEY_B}[relay.example]\n`,
    );
    expect(host.mapping()).toBe(`exchange-1 ${KEY_B} ${NOW} -\n`);
  });

  it("aborts before the mapping when the table silently takes no row", () => {
    const host = fixtureHost();
    host.makeTableReadOnly();
    const result = host.register("exchange-1", KEY_A);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the secrets table was not updated");
    expect(result.stderr).toContain(`${host.mapFile} is unchanged`);
    expect(result.stdout).not.toContain(KEY_A);
    expect(result.stderr).not.toContain(KEY_A);
    expect(host.mapping()).toBe("");
  });

  it("passes coturn's error through when the table cannot be opened", () => {
    const host = fixtureHost();
    host.makeTableUnopenable();
    const result = host.register("exchange-1", KEY_A);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(UNOPENABLE_ERROR);
    expect(result.stderr).toContain("could not read the secrets table");
    expect(result.stderr).not.toContain(KEY_A);
    expect(host.mapping()).toBe("");
  });

  it("keeps the prior key mapped when a rotation's add silently fails", () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A);
    host.makeTableReadOnly();
    const result = host.register("exchange-1", KEY_C);
    expect(result.status).toBe(1);
    expect(result.turnadmin.map((line) => line.split(" ")[1])).toEqual(["-s"]);
    expect(host.mapping()).toBe(`exchange-1 ${KEY_A} ${NOW} -\n`);
  });

  it("maps the new key and aborts when the prior key's delete silently fails", () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A);
    host.ignoreTableWrites("-X");
    const result = host.register("exchange-1", KEY_C);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not remove its prior key");
    expect(host.mapping()).toBe(`exchange-1 ${KEY_C} ${NOW} -\n`);
    expect(host.table()).toContain(`${KEY_A}[relay.example]`);
  });

  it("replaces the key wherever a table error echoes it", () => {
    const host = fixtureHost();
    host.makeTableReadOnly();
    host.echoValueInErrors();
    const result = host.register("exchange-1", KEY_A);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ERROR could not write <key>");
    expect(result.stderr).not.toContain(KEY_A);
  });

  it.each([
    ["an id starting with '-'", "-s", KEY_A, "exchange-id"],
    ["an id with a space", "a b", KEY_A, "exchange-id"],
    ["an id with a slash", "a/b", KEY_A, "exchange-id"],
    ["an id over 128 characters", "x".repeat(129), KEY_A, "exchange-id"],
    ["an uppercase key", "exchange-1", KEY_A.toUpperCase(), "key-hex64"],
    ["a 63-character key", "exchange-1", KEY_A.slice(1), "key-hex64"],
    ["a base64 key", "exchange-1", "q".repeat(43) + "=", "key-hex64"],
    ["a key given as the id", KEY_B, KEY_A, "exchange-id"],
  ])("refuses %s, naming the argument", (_, id, key, argument) => {
    const host = fixtureHost();
    const result = host.register(id, key);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(argument);
    const rejected = argument === "exchange-id" ? id : key;
    expect(result.stdout).not.toContain(rejected);
    expect(result.stderr).not.toContain(rejected);
    expect(result.turnadmin).toEqual([]);
    expect(result.listings).toBe(0);
  });

  it("registers an id of 64 hex characters that is not all lowercase", () => {
    const host = fixtureHost();
    const result = host.register(KEY_B.toUpperCase(), KEY_A);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([[["exchange-1"]], [["exchange-1", KEY_A, "30", "extra"]]])(
    "prints usage on the wrong argument count (%j)",
    (args) => {
      const result = fixtureHost().register(...args);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("usage: register-exchange.sh");
    },
  );
});

// The managed-exchange record's max-age ceiling, read from core rather than
// restated, so the shell's bound cannot drift from the record's.
const MAX_TOKEN_MAX_AGE_DAYS = Number(
  /export const MAX_TOKEN_MAX_AGE_DAYS = (\d+);/.exec(
    readFileSync(
      resolve(here, "..", "packages/core/src/config/connection.ts"),
      "utf8",
    ),
  )[1],
);

describe("register-exchange.sh max-age-days", () => {
  it("stamps the row with the registration time and its lapse", () => {
    const host = fixtureHost();
    const result = host.register("exchange-1", KEY_A, "30");
    expect(result.status, result.stderr).toBe(0);
    expect(host.mapping()).toBe(`exchange-1 ${KEY_A} ${NOW} 30\n`);
  });

  it("accepts the managed-exchange record's largest max age and refuses one day more", () => {
    const host = fixtureHost();
    const most = host.register(
      "exchange-1",
      KEY_A,
      `${MAX_TOKEN_MAX_AGE_DAYS}`,
    );
    expect(most.status, most.stderr).toBe(0);
    const over = host.register(
      "exchange-2",
      KEY_B,
      `${MAX_TOKEN_MAX_AGE_DAYS + 1}`,
    );
    expect(over.status).toBe(1);
    expect(over.stderr).toContain("max-age-days");
    expect(over.turnadmin).toEqual([]);
  });

  it.each(["", "0", "007", "1.5", "-1", "1e3", "99999999999999999999"])(
    "refuses max-age-days %j before touching the table",
    (days) => {
      const host = fixtureHost();
      const result = host.register("exchange-1", KEY_A, days);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("max-age-days");
      expect(result.turnadmin).toEqual([]);
      expect(result.listings).toBe(0);
    },
  );
});

describe("sweep-exchanges.sh", () => {
  it("revokes a row once it is max-age-days old, and not a second before", () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A, "1");
    host.setClock(NOW + DAY - 1);
    const early = host.sweep();
    expect(early.status, early.stderr).toBe(0);
    expect(early.turnadmin).toEqual([]);
    expect(host.mapping()).toBe(`exchange-1 ${KEY_A} ${NOW} 1\n`);
    host.setClock(NOW + DAY);
    const due = host.sweep();
    expect(due.status, due.stderr).toBe(0);
    expect(due.turnadmin.map((line) => line.split(" ").slice(1, 3))).toEqual([
      ["-X", KEY_A],
    ]);
    expect(due.stdout).toContain("revoked exchange exchange-1");
    expect(host.mapping()).toBe("");
    expect(host.table()).toBe(`${KEY_LISTED}[relay.example]\n`);
  });

  it("never sweeps a row registered without a lapse, or one with no stamp", () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A);
    host.writeMapping(`${host.mapping()}exchange-2 ${KEY_B}\n`);
    host.setClock(NOW + 100 * 365 * DAY);
    const result = host.sweep();
    expect(result.status, result.stderr).toBe(0);
    expect(result.turnadmin).toEqual([]);
    expect(host.mapping()).toBe(
      `exchange-1 ${KEY_A} ${NOW} -\nexchange-2 ${KEY_B}\n`,
    );
  });

  it("restarts the count at each registration of a new key", () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A, "1");
    host.setClock(NOW + DAY - 10);
    host.register("exchange-1", KEY_B, "1");
    host.setClock(NOW + DAY);
    expect(host.sweep().turnadmin).toEqual([]);
    host.setClock(NOW + 2 * DAY - 10);
    const due = host.sweep();
    expect(due.turnadmin.map((line) => line.split(" ").slice(1, 3))).toEqual([
      ["-X", KEY_B],
    ]);
    expect(host.mapping()).toBe("");
  });

  it("sweeps only the lapsed id among ids equal as numbers", () => {
    const host = fixtureHost();
    host.register("1", KEY_A, "1");
    host.setClock(NOW + DAY / 2);
    host.register("1.0", KEY_B, "1");
    host.register("01", KEY_C);
    host.setClock(NOW + DAY);
    const result = host.sweep();
    expect(result.status, result.stderr).toBe(0);
    expect(result.turnadmin.map((line) => line.split(" ").slice(1, 3))).toEqual(
      [["-X", KEY_A]],
    );
    expect(host.mapping()).toBe(
      `1.0 ${KEY_B} ${NOW + DAY / 2} 1\n01 ${KEY_C} ${NOW + DAY / 2} -\n`,
    );
  });

  it("revokes the rest past a failed revoke, keeps its line, and exits non-zero", () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A, "1");
    host.register("exchange-2", KEY_B, "1");
    host.failTurnadminOn(KEY_A);
    host.setClock(NOW + DAY);
    const result = host.sweep();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "could not revoke lapsed exchange exchange-1",
    );
    expect(result.stdout).toContain("revoked exchange exchange-2");
    for (const stream of [result.stdout, result.stderr]) {
      expect(stream).not.toContain(KEY_A);
      expect(stream).not.toContain(KEY_B);
    }
    expect(host.mapping()).toBe(`exchange-1 ${KEY_A} ${NOW} 1\n`);
  });
});

const REGISTRAR_TOKEN = "7".repeat(64);
let certDir;

beforeAll(() => {
  certDir = mkdtempSync(join(tmpdir(), "relay-registrar-cert-"));
  const made = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-days",
      "2",
      "-subj",
      "/CN=relay.example",
      "-addext",
      "subjectAltName=DNS:relay.example",
      "-keyout",
      join(certDir, "privkey.pem"),
      "-out",
      join(certDir, "fullchain.pem"),
    ],
    { encoding: "utf8" },
  );
  expect(made.status, made.stderr).toBe(0);
});

afterAll(() => {
  rmSync(certDir, { recursive: true, force: true });
});

const registrars = [];

afterEach(() => {
  while (registrars.length > 0) registrars.pop().kill();
});

const registrarEnv = (host, token = REGISTRAR_TOKEN) => {
  const tokenFile = join(host.root, "registrar-token");
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  return {
    ...host.env,
    PSILINK_RELAY_REGISTRAR_TOKEN_FILE: tokenFile,
    PSILINK_RELAY_CERT_DIR: certDir,
  };
};

// Starts the registrar on a free port and resolves once it is listening.
const startRegistrar = (host) =>
  new Promise((resolvePort, reject) => {
    const child = spawn("python3", [join(relay, "registrar.py")], {
      env: { ...registrarEnv(host), PSILINK_RELAY_REGISTRAR_PORT: "0" },
    });
    registrars.push(child);
    const log = { stderr: "" };
    child.stderr.on("data", (chunk) => {
      log.stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      const match = /listening on port (\d+)/.exec(String(chunk));
      if (match) resolvePort({ port: Number(match[1]), log });
    });
    child.on("exit", (code) =>
      reject(new Error(`registrar exited ${code}: ${log.stderr}`)),
    );
  });

const call = (port, method, path, { token, body, headers = {} } = {}) =>
  new Promise((resolveResponse, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        servername: "relay.example",
        ca: readFileSync(join(certDir, "fullchain.pem")),
        headers: {
          ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
          ...(payload === undefined
            ? {}
            : { "Content-Length": String(payload.length) }),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () =>
          resolveResponse({
            status: res.statusCode,
            headers: res.headers,
            text,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(payload);
  });

// Each test starts a Python process and runs the key scripts; a loaded host
// takes longer than the default five seconds.
describe("registrar.py", { timeout: 60000 }, () => {
  it.each([
    ["PUT", undefined, {}],
    ["PUT", "8".repeat(64), {}],
    ["PUT", undefined, { Authorization: `Basic ${REGISTRAR_TOKEN}` }],
    ["PUT", undefined, { Authorization: REGISTRAR_TOKEN }],
    ["DELETE", undefined, {}],
    ["DELETE", REGISTRAR_TOKEN.slice(1), {}],
    ["GET", undefined, {}],
    ["POST", undefined, {}],
  ])(
    "refuses %s without the token (%j, %j) and runs nothing",
    async (method, token, headers) => {
      const host = fixtureHost();
      host.register("exchange-1", KEY_A);
      const { port } = await startRegistrar(host);
      const before = host.mapping();
      host.clearCalls();
      const response = await call(port, method, "/exchanges/exchange-1", {
        token,
        headers,
        body: JSON.stringify({ key: KEY_B }),
      });
      expect(response.status).toBe(401);
      expect(response.headers["www-authenticate"]).toContain("Bearer");
      expect(host.calls()).toBe("");
      expect(host.mapping()).toBe(before);
    },
  );

  it("answers a CORS preflight without the token and runs nothing", async () => {
    const host = fixtureHost();
    const { port } = await startRegistrar(host);
    const response = await call(port, "OPTIONS", "/exchanges/exchange-1");
    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-methods"]).toBe(
      "PUT, DELETE",
    );
    expect(response.headers["access-control-allow-headers"]).toContain(
      "Authorization",
    );
    expect(host.calls()).toBe("");
  });

  it("registers, replaces the prior row, and revokes", async () => {
    const host = fixtureHost();
    const { port, log } = await startRegistrar(host);
    const first = await call(port, "PUT", "/exchanges/exchange-1", {
      token: REGISTRAR_TOKEN,
      body: JSON.stringify({ key: KEY_A, maxAgeDays: 30 }),
    });
    expect(first.status, first.text).toBe(200);
    expect(JSON.parse(first.text).message).toContain(
      "registered exchange exchange-1",
    );
    expect(host.mapping()).toBe(`exchange-1 ${KEY_A} ${NOW} 30\n`);
    expect(host.table()).toContain(`${KEY_A}[relay.example]`);

    const second = await call(port, "PUT", "/exchanges/exchange-1", {
      token: REGISTRAR_TOKEN,
      body: JSON.stringify({ key: KEY_B }),
    });
    expect(second.status, second.text).toBe(200);
    expect(host.mapping()).toBe(`exchange-1 ${KEY_B} ${NOW} -\n`);
    expect(host.table()).not.toContain(KEY_A);
    expect(host.table()).toContain(`${KEY_B}[relay.example]`);

    const revoked = await call(port, "DELETE", "/exchanges/exchange-1", {
      token: REGISTRAR_TOKEN,
    });
    expect(revoked.status, revoked.text).toBe(200);
    expect(host.mapping()).toBe("");
    expect(host.table()).toBe(`${KEY_LISTED}[relay.example]\n`);

    for (const text of [first.text, second.text, revoked.text, log.stderr]) {
      expect(text).not.toContain(KEY_A);
      expect(text).not.toContain(KEY_B);
      expect(text).not.toContain(REGISTRAR_TOKEN);
    }
  });

  it("answers a script's refusal 409 with its reason and never the key", async () => {
    const host = fixtureHost();
    const { port, log } = await startRegistrar(host);
    const malformed = await call(port, "PUT", "/exchanges/exchange-1", {
      token: REGISTRAR_TOKEN,
      body: JSON.stringify({ key: KEY_A.toUpperCase() }),
    });
    expect(malformed.status).toBe(409);
    expect(JSON.parse(malformed.text).error).toContain("key-hex64");
    const tooOld = await call(port, "PUT", "/exchanges/exchange-1", {
      token: REGISTRAR_TOKEN,
      body: JSON.stringify({
        key: KEY_A,
        maxAgeDays: MAX_TOKEN_MAX_AGE_DAYS + 1,
      }),
    });
    expect(tooOld.status).toBe(409);
    expect(JSON.parse(tooOld.text).error).toContain("max-age-days");
    const unregistered = await call(port, "DELETE", "/exchanges/exchange-9", {
      token: REGISTRAR_TOKEN,
    });
    expect(unregistered.status).toBe(409);
    expect(JSON.parse(unregistered.text).error).toContain(
      "exchange-id exchange-9 is not registered",
    );
    for (const text of [malformed.text, tooOld.text, log.stderr]) {
      expect(text).not.toContain(KEY_A);
      expect(text).not.toContain(KEY_A.toUpperCase());
    }
    expect(host.mapping()).toBe("");
  });

  it.each([
    ["not JSON", "{"],
    ["an array", JSON.stringify([KEY_A])],
    ["no key", JSON.stringify({ maxAgeDays: 3 })],
    ["an unknown field", JSON.stringify({ key: KEY_A, label: "x" })],
    ["a numeric key", JSON.stringify({ key: 7 })],
    ["maxAgeDays as a string", JSON.stringify({ key: KEY_A, maxAgeDays: "3" })],
    [
      "maxAgeDays as a boolean",
      JSON.stringify({ key: KEY_A, maxAgeDays: true }),
    ],
    [
      "a fractional maxAgeDays",
      JSON.stringify({ key: KEY_A, maxAgeDays: 1.5 }),
    ],
  ])("refuses a body with %s 400 before running a script", async (_, body) => {
    const host = fixtureHost();
    const { port } = await startRegistrar(host);
    const response = await call(port, "PUT", "/exchanges/exchange-1", {
      token: REGISTRAR_TOKEN,
      body,
    });
    expect(response.status).toBe(400);
    expect(response.text).not.toContain(KEY_A);
    expect(host.calls()).toBe("");
  });

  it("refuses an oversized or unsized body before reading it", async () => {
    const host = fixtureHost();
    const { port } = await startRegistrar(host);
    const oversized = await call(port, "PUT", "/exchanges/exchange-1", {
      token: REGISTRAR_TOKEN,
      body: JSON.stringify({ key: KEY_A, pad: "x".repeat(2000) }),
    });
    expect(oversized.status).toBe(413);
    const chunked = await call(port, "PUT", "/exchanges/exchange-1", {
      token: REGISTRAR_TOKEN,
      headers: { "Transfer-Encoding": "chunked" },
    });
    expect(chunked.status).toBe(411);
    expect(host.calls()).toBe("");
  });

  it.each(["/exchanges/", "/exchanges/a/b", "/exchanges/a?b=c", "/other"])(
    "answers %s 404 with the token and runs nothing",
    async (path) => {
      const host = fixtureHost();
      const { port } = await startRegistrar(host);
      const response = await call(port, "DELETE", path, {
        token: REGISTRAR_TOKEN,
      });
      expect(response.status).toBe(404);
      expect(host.calls()).toBe("");
    },
  );

  it.each([
    ["a short token", "a".repeat(31)],
    ["a token with punctuation", `${"a".repeat(40)}!`],
    ["an empty token", ""],
  ])("refuses to start with %s", (_, token) => {
    const host = fixtureHost();
    const result = spawnSync("python3", [join(relay, "registrar.py")], {
      encoding: "utf8",
      env: { ...registrarEnv(host, token), PSILINK_RELAY_REGISTRAR_PORT: "0" },
      timeout: 10000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("registrar-token");
  });
});

describe("revoke-exchange.sh", () => {
  it("deletes the exchange's key from the table and the mapping", () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A);
    host.register("exchange-2", KEY_B);
    const result = host.revoke("exchange-1");
    expect(result.status, result.stderr).toBe(0);
    expect(result.turnadmin).toEqual([
      `localhost/psilink-relay:installed -X ${KEY_A} -r relay.example -b /var/lib/coturn/turndb`,
    ]);
    expect(host.mapping()).toBe(`exchange-2 ${KEY_B} ${NOW} -\n`);
  });

  it("refuses an id equal as a number to a registered one", () => {
    const host = fixtureHost();
    host.register("1", KEY_A);
    host.register("1.0", KEY_B);
    const result = host.revoke("01");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exchange-id 01 is not registered");
    expect(result.turnadmin).toEqual([]);
    expect(host.mapping()).toBe(`1 ${KEY_A} ${NOW} -\n1.0 ${KEY_B} ${NOW} -\n`);
  });

  it("revokes only the exact id among ids equal as numbers", () => {
    const host = fixtureHost();
    host.register("1", KEY_A);
    host.register("1e0", KEY_B);
    host.register("01", KEY_C);
    const result = host.revoke("01");
    expect(result.status, result.stderr).toBe(0);
    expect(result.turnadmin.map((line) => line.split(" ").slice(1, 3))).toEqual(
      [["-X", KEY_C]],
    );
    expect(host.mapping()).toBe(`1 ${KEY_A} ${NOW} -\n1e0 ${KEY_B} ${NOW} -\n`);
  });

  it("refuses an exchange that is not registered", () => {
    const host = fixtureHost();
    const result = host.revoke("exchange-1");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exchange-id exchange-1 is not registered");
    expect(result.turnadmin).toEqual([]);
  });

  it("keeps the mapping when the table delete fails", () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A);
    host.failTurnadminOn("-X");
    expect(host.revoke("exchange-1").status).toBe(1);
    expect(host.mapping()).toBe(`exchange-1 ${KEY_A} ${NOW} -\n`);
  });

  it("keeps the mapping when the table silently keeps the key", () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A);
    host.makeTableReadOnly();
    const result = host.revoke("exchange-1");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("still authenticates");
    expect(result.stderr).toContain("revoke-exchange.sh exchange-1 again");
    expect(result.stdout).not.toContain(KEY_A);
    expect(result.stderr).not.toContain(KEY_A);
    expect(host.mapping()).toBe(`exchange-1 ${KEY_A} ${NOW} -\n`);
    expect(host.table()).toContain(`${KEY_A}[relay.example]`);
  });

  it("keeps the mapping when the table cannot be read back", () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A);
    host.makeTableUnopenable();
    const result = host.revoke("exchange-1");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(UNOPENABLE_ERROR);
    expect(result.stderr).toContain("treat the key as still authenticating");
    expect(result.stderr).not.toContain(KEY_A);
    expect(host.mapping()).toBe(`exchange-1 ${KEY_A} ${NOW} -\n`);
  });

  it("refuses a malformed id, naming the argument", () => {
    const result = fixtureHost().revoke("../x y");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exchange-id");
    expect(result.stderr).not.toContain("../x y");
  });

  it("refuses a registered key given as the id, without printing it", () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A);
    const result = host.revoke(KEY_A);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the shape of a relay key");
    expect(result.stdout).not.toContain(KEY_A);
    expect(result.stderr).not.toContain(KEY_A);
    expect(result.turnadmin).toEqual([]);
    expect(result.listings).toBe(0);
    expect(host.mapping()).toBe(`exchange-1 ${KEY_A} ${NOW} -\n`);
  });
});

const HEX64 = /[0-9a-f]{64}/;

describe("verify.sh registrar probe", { timeout: 60000 }, () => {
  it("says it skipped the registrar on a host with no token", () => {
    const result = fixtureHost().verify();
    expect(result.stdout).toContain(
      "SKIP     the registrar is not configured on this host",
    );
  });

  it("passes against a registrar that refuses without the token and writes with it", async () => {
    const host = fixtureHost();
    const { port } = await startRegistrar(host);
    const result = spawnSync(BASH, [join(relay, "verify.sh")], {
      encoding: "utf8",
      env: {
        ...registrarEnv(host),
        PSILINK_RELAY_REGISTRAR_PORT: String(port),
        PSILINK_RELAY_VERIFY_CONNECT: "127.0.0.1",
        PSILINK_RELAY_VERIFY_WAIT: "0",
        CURL_CA_BUNDLE: join(certDir, "fullchain.pem"),
      },
    });
    const registrarLines = result.stdout.slice(
      result.stdout.indexOf("a registration with no token"),
    );
    expect(result.stdout).toContain(
      "PASS     a registration with no token was answered 401",
    );
    expect(result.stdout).toContain(
      "PASS     a registration with a wrong token was answered 401",
    );
    expect(result.stdout).toContain(
      "PASS     a revocation with no token was answered 401",
    );
    expect(result.stdout).toContain(
      "PASS     the refused registration left no row",
    );
    expect(result.stdout).toContain(
      "PASS     a registration with the token was answered 200",
    );
    expect(result.stdout).toContain(
      "PASS     the registration is in the mapping and the secrets table",
    );
    expect(result.stdout).toContain(
      "PASS     a revocation with the token was answered 200",
    );
    expect(result.stdout).toContain(
      "PASS     the revocation left the mapping and the secrets table",
    );
    expect(registrarLines).not.toMatch(/FAIL|UNCLEAR/);
    for (const stream of [result.stdout, result.stderr]) {
      expect(stream).not.toMatch(HEX64);
      expect(stream).not.toContain(REGISTRAR_TOKEN);
    }
    expect(host.mapping()).toBe("");
    expect(host.table()).toBe(`${KEY_LISTED}[relay.example]\n`);
  });

  it("reports a registrar that does not answer as unclear", () => {
    const host = fixtureHost();
    const result = spawnSync(BASH, [join(relay, "verify.sh")], {
      encoding: "utf8",
      env: {
        ...registrarEnv(host),
        PSILINK_RELAY_REGISTRAR_PORT: "1",
        PSILINK_RELAY_VERIFY_CONNECT: "127.0.0.1",
        PSILINK_RELAY_VERIFY_WAIT: "0",
      },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "UNCLEAR  a registration with no token got no answer",
    );
    expect(result.stdout).not.toContain("SKIP     the registrar");
  });
});

describe("verify.sh cleanup", () => {
  it("removes every key the run registered from the table", () => {
    const host = fixtureHost();
    const result = host.verify();
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("WARNING");
    expect(host.table()).toBe(`${KEY_LISTED}[relay.example]\n`);
    expect(host.mapping()).toBe("");
  });

  it("removes a key whose register added the row and then failed", () => {
    const host = fixtureHost();
    host.failNextListing();
    const result = host.verify();
    expect(result.stdout).toContain(
      "could not register psilink-verify-a for this run",
    );
    expect(result.stdout).toContain("remove each listed key no line of");
    expect(result.stderr).not.toContain("WARNING");
    for (const stream of [result.stdout, result.stderr]) {
      expect(stream).not.toMatch(HEX64);
    }
    expect(host.table()).toBe(`${KEY_LISTED}[relay.example]\n`);
    expect(host.mapping()).toBe("");
  });

  it("warns naming the exchange id, not the key, for a key still listed", () => {
    const host = fixtureHost();
    host.failNextListing();
    host.ignoreTableWrites("-X");
    const result = host.verify();
    expect(result.stderr).toContain(
      "WARNING: the key this run registered for psilink-verify-a is still in the secrets table",
    );
    expect(result.stderr).toContain(
      "WARNING: the key this run registered for psilink-verify-b is still in the secrets table",
    );
    for (const stream of [result.stdout, result.stderr]) {
      expect(stream).not.toMatch(HEX64);
    }
    expect(host.table().trim().split("\n")).toHaveLength(3);
  });

  it("warns naming the exchange id when the table cannot be read", () => {
    const host = fixtureHost();
    host.register("psilink-verify-a", KEY_A);
    host.makeTableUnopenable();
    const result = host.verify();
    expect(result.stderr).toContain(
      "WARNING: could not read the secrets table to confirm the key this run registered for psilink-verify-a left it",
    );
    for (const stream of [result.stdout, result.stderr]) {
      expect(stream).not.toMatch(HEX64);
    }
  });
});

describe("render-config.sh and the secrets table", () => {
  it("renders the table and no static secret when the host holds none", () => {
    const host = fixtureHost();
    const result = host.render();
    expect(result.status, result.stderr).toBe(0);
    const settings = host
      .conf()
      .split("\n")
      .filter((line) => !line.startsWith("#"));
    expect(settings).toContain("use-auth-secret");
    expect(settings).toContain("userdb=/var/lib/coturn/turndb");
    expect(settings.some((line) => line.startsWith("static-auth-secret"))).toBe(
      false,
    );
  });

  it("renders the static secret beside the table when the host holds one", () => {
    const host = fixtureHost();
    writeFileSync(host.secretFile, "c".repeat(64));
    const result = host.render();
    expect(result.status, result.stderr).toBe(0);
    expect(host.conf()).toContain(`static-auth-secret=${"c".repeat(64)}\n`);
    expect(host.conf()).toContain("userdb=/var/lib/coturn/turndb\n");
  });
});
