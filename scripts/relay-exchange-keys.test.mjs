import { spawnSync } from "node:child_process";
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
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The relay's per-exchange key scripts and the configuration render, driven
// against a fixture host. The container runtime is a stub on PATH that records
// the turnadmin arguments it is handed, so the test needs no image and no
// sqlite3; what coturn does with those arguments is verify.sh's to drive
// against a running relay.

const here = dirname(fileURLToPath(import.meta.url));
const relay = resolve(here, "..", "infra/relay");
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";

const KEY_A = "a".repeat(64);
const KEY_B = "0123456789abcdef".repeat(4);
const KEY_C = "fedcba9876543210".repeat(4);

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
  writeFileSync(calls, "");
  const stub = join(root, "docker");
  writeFileSync(
    stub,
    [
      "#!/bin/bash",
      `printf '%s\\n' "$*" >> '${calls}'`,
      `if [ -f '${failOn}' ] && [[ " $* " == *" $(cat '${failOn}') "* ]]; then exit 1; fi`,
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
  };
  const run = (script, ...args) => {
    writeFileSync(calls, "");
    const result = spawnSync(BASH, [join(relay, script), ...args], {
      encoding: "utf8",
      env,
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      turnadmin: readFileSync(calls, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.slice(line.indexOf("turnadmin") + 10)),
    };
  };
  return {
    register: (...args) => run("register-exchange.sh", ...args),
    revoke: (...args) => run("revoke-exchange.sh", ...args),
    render: () => run("render-config.sh"),
    mapFile,
    mapping: () => (existsSync(mapFile) ? readFileSync(mapFile, "utf8") : ""),
    mapMode: () => statSync(mapFile).mode & 0o777,
    conf: () => readFileSync(conf, "utf8"),
    failTurnadminOn: (flag) => writeFileSync(failOn, flag),
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
    expect(host.mapping()).toBe(`exchange-1 ${KEY_A}\n`);
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
    expect(host.mapping()).toBe(`exchange-2 ${KEY_B}\nexchange-1 ${KEY_C}\n`);
  });

  it("keeps the prior key and mapping when the new key's add fails", () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A);
    host.failTurnadminOn("-s");
    const result = host.register("exchange-1", KEY_C);
    expect(result.status).toBe(1);
    expect(result.turnadmin.map((line) => line.split(" ")[1])).toEqual(["-s"]);
    expect(host.mapping()).toBe(`exchange-1 ${KEY_A}\n`);
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
    expect(host.mapping()).toBe(`exchange-1 ${KEY_C}\n`);
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
      expect(host.mapping()).toBe(`exchange-1 ${KEY_A}\n`);
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
    expect(host.mapping()).toBe(`${registered} ${KEY_A}\n${id} ${KEY_B}\n`);
  });

  it("tells apart all-digit keys that are equal as floating-point numbers", () => {
    const host = fixtureHost();
    const key1 = "1" + "0".repeat(63);
    const key2 = "1" + "0".repeat(62) + "1";
    host.register("exchange-1", key1);
    const result = host.register("exchange-2", key2);
    expect(result.status, result.stderr).toBe(0);
    expect(host.mapping()).toBe(`exchange-1 ${key1}\nexchange-2 ${key2}\n`);
  });

  it("changes nothing when the exchange already holds the key", () => {
    const host = fixtureHost();
    host.register("exchange-1", KEY_A);
    const result = host.register("exchange-1", KEY_A);
    expect(result.status, result.stderr).toBe(0);
    expect(result.turnadmin).toEqual([]);
    expect(host.mapping()).toBe(`exchange-1 ${KEY_A}\n`);
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

  it.each([
    ["an id starting with '-'", "-s", KEY_A, "exchange-id"],
    ["an id with a space", "a b", KEY_A, "exchange-id"],
    ["an id with a slash", "a/b", KEY_A, "exchange-id"],
    ["an id over 128 characters", "x".repeat(129), KEY_A, "exchange-id"],
    ["an uppercase key", "exchange-1", KEY_A.toUpperCase(), "key-hex64"],
    ["a 63-character key", "exchange-1", KEY_A.slice(1), "key-hex64"],
    ["a base64 key", "exchange-1", "q".repeat(43) + "=", "key-hex64"],
  ])("refuses %s, naming the argument", (_, id, key, argument) => {
    const host = fixtureHost();
    const result = host.register(id, key);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(argument);
    expect(result.turnadmin).toEqual([]);
  });

  it("prints usage on the wrong argument count", () => {
    const result = fixtureHost().register("exchange-1");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage: register-exchange.sh");
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
    expect(host.mapping()).toBe(`exchange-2 ${KEY_B}\n`);
  });

  it("refuses an id equal as a number to a registered one", () => {
    const host = fixtureHost();
    host.register("1", KEY_A);
    host.register("1.0", KEY_B);
    const result = host.revoke("01");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exchange-id 01 is not registered");
    expect(result.turnadmin).toEqual([]);
    expect(host.mapping()).toBe(`1 ${KEY_A}\n1.0 ${KEY_B}\n`);
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
    expect(host.mapping()).toBe(`1 ${KEY_A}\n1e0 ${KEY_B}\n`);
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
    expect(host.mapping()).toBe(`exchange-1 ${KEY_A}\n`);
  });

  it("refuses a malformed id, naming the argument", () => {
    const result = fixtureHost().revoke("../x y");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exchange-id");
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
