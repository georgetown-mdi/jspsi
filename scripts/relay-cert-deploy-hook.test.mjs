import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The relay's certificate deploy hook, driven against a fixture host.
//
// What it stands in for: renew.sh handing the hook the ACME client's
// certificate and key every day, renewed or not. `systemctl` and `chown` are
// stubs on PATH that record their calls, so the test needs no root and no
// systemd; everything else the hook runs is the real tool.
//
// What it cannot reach: a real lego or acme.sh run. The hook decides from the
// files it is handed, so a fixture file standing in for the client's output
// exercises the same decision.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";
const HOOK = resolve(repoRoot, "infra/relay/certs/deploy-hook.sh");

const OWN_UID = execFileSync("id", ["-u"], { encoding: "utf8" }).trim();
const OTHER_UID = OWN_UID === "65534" ? "65533" : "65534";

const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

const writeStub = (path, body) => {
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
};

const fixtureHost = ({ imageUid = OWN_UID } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "relay-cert-hook-"));
  tmpDirs.push(root);
  const bin = join(root, "bin");
  const acme = join(root, "acme");
  mkdirSync(bin);
  mkdirSync(acme);
  const calls = join(root, "calls.log");
  writeFileSync(calls, "");
  const active = join(root, "service-active");
  writeFileSync(active, "");
  writeStub(
    join(bin, "systemctl"),
    [
      `printf 'systemctl %s\\n' "$*" >> '${calls}'`,
      `if [ "$1" = is-active ]; then [ -f '${active}' ]; fi`,
    ].join("\n"),
  );
  writeStub(join(bin, "chown"), `printf 'chown %s\\n' "$*" >> '${calls}'`);
  const envFile = join(root, "relay.env");
  writeFileSync(envFile, `PSILINK_RELAY_IMAGE_UID=${imageUid}\n`);
  const crt = join(acme, "relay.example.crt");
  const key = join(acme, "relay.example.key");
  const dest = join(root, "certs");
  const host = {
    dest,
    issue: (serial) => {
      writeFileSync(crt, `certificate ${serial}\n`);
      writeFileSync(key, `key ${serial}\n`);
    },
    stopService: () => rmSync(active),
    run: () => {
      writeFileSync(calls, "");
      const result = spawnSync(BASH, [HOOK], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          PSILINK_RELAY_ENV_FILE: envFile,
          PSILINK_RELAY_CERT_DIR: dest,
          PSILINK_RELAY_CERT_SOURCE: crt,
          PSILINK_RELAY_KEY_SOURCE: key,
        },
      });
      expect(result.status, `the hook failed with:\n${result.stderr}`).toBe(0);
      return {
        restarted: readFileSync(calls, "utf8")
          .split("\n")
          .includes("systemctl restart psilink-relay.service"),
        stderr: result.stderr,
      };
    },
    key,
  };
  return host;
};

describe("the relay certificate deploy hook", () => {
  it("restarts a running relay onto a first certificate", () => {
    const host = fixtureHost();
    host.issue(1);
    expect(host.run().restarted).toBe(true);
    expect(readFileSync(join(host.dest, "fullchain.pem"), "utf8")).toBe(
      "certificate 1\n",
    );
    expect(readFileSync(join(host.dest, "privkey.pem"), "utf8")).toBe(
      "key 1\n",
    );
  });

  it("leaves the relay running on a day the client renewed nothing", () => {
    const host = fixtureHost();
    host.issue(1);
    host.run();
    const noop = host.run();
    expect(noop.restarted).toBe(false);
    expect(noop.stderr).toContain("unchanged");
  });

  it("restarts the relay once the client renews the certificate", () => {
    const host = fixtureHost();
    host.issue(1);
    host.run();
    host.issue(2);
    expect(host.run().restarted).toBe(true);
    expect(host.run().restarted).toBe(false);
  });

  it("restarts the relay when only the key changed", () => {
    const host = fixtureHost();
    host.issue(1);
    host.run();
    writeFileSync(host.key, "key 2\n");
    expect(host.run().restarted).toBe(true);
  });

  it("restarts the relay while the deployed files are not owned by the image's account", () => {
    // The chown stub leaves the files owned by the test's own uid, so a
    // different image uid is a deployed copy that never reached that account.
    const host = fixtureHost({ imageUid: OTHER_UID });
    host.issue(1);
    host.run();
    expect(host.run().restarted).toBe(true);
  });

  it("starts nothing on a first install, before the relay is running", () => {
    const host = fixtureHost();
    host.stopService();
    host.issue(1);
    expect(host.run().restarted).toBe(false);
  });
});
