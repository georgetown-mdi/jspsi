import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// relay_table.py writes coturn's turn_secret table directly rather than through
// turnadmin, so the table's shape is a coupling to the pinned image. This
// drives it both ways against the image infra/relay/Dockerfile pins: turnadmin
// creates a table and adds a row, relay_table.py opens that file, finds the
// row, and adds and removes its own, and turnadmin lists what relay_table.py
// left.
//
// It needs a container runtime that answers and the image, pulled by digest.
// Without a runtime the leg is skipped and says so -- the skip reporter names
// it -- rather than passing; a runtime that answers but cannot pull the image
// fails the leg. A base bump through Dependabot runs it on CI, whose runner
// has docker.

const here = dirname(fileURLToPath(import.meta.url));
const relay = resolve(here, "..", "infra/relay");
const dockerfile = readFileSync(join(relay, "Dockerfile"), "utf8");
const REALM = "schema.example";
const KEY_TURNADMIN = "1".repeat(64);
const KEY_MODULE = "2".repeat(64);

const from = /^FROM (\S+)$/m.exec(dockerfile)?.[1];

describe("the relay Dockerfile's pin", () => {
  it("is registry-qualified, digest-pinned, and named by its version comment", () => {
    const match =
      /^docker\.io\/coturn\/coturn:(\d+\.\d+\.\d+)@sha256:[0-9a-f]{64}$/.exec(
        from ?? "",
      );
    expect(match, `FROM ${from}`).not.toBeNull();
    expect(dockerfile).toContain(`# coturn/coturn:${match[1]}, pinned`);
  });
});

const answeringRuntime = ["docker", "podman"].find(
  (runtime) =>
    spawnSync(runtime, ["info"], { stdio: "ignore", timeout: 30000 }).status ===
    0,
);

const dirs = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const turnadmin = (dir, ...args) =>
  spawnSync(
    answeringRuntime,
    [
      "run",
      "--rm",
      "--network",
      "none",
      "-v",
      `${dir}:/work`,
      "--entrypoint",
      "turnadmin",
      from,
      ...args,
      "-r",
      REALM,
      "-b",
      "/work/turndb",
    ],
    { encoding: "utf8", timeout: 240000 },
  );

const relayTable = (turndb, code) => {
  const result = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      `import json, sys, relay_table\nconn = relay_table.open_table(sys.argv[1])\n${code}`,
      turndb,
    ],
    { encoding: "utf8", env: { ...process.env, PYTHONPATH: relay } },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
};

describe("coturn's turn_secret table against relay_table.py", () => {
  it.skipIf(!answeringRuntime)(
    `reads and writes the table the pinned image creates (${answeringRuntime ?? "no docker or podman answers on this host"})`,
    { timeout: 600000 },
    () => {
      const created = mkdtempSync(join(tmpdir(), "relay-schema-"));
      dirs.push(created);
      // The image runs as its own account, which must be able to write here.
      chmodSync(created, 0o777);
      const added = turnadmin(created, "-s", KEY_TURNADMIN);
      expect(added.status, `${added.stdout}\n${added.stderr}`).toBe(0);

      // A copy this process owns, so relay_table.py can write it whatever uid
      // the container wrote the original as.
      const copied = join(created, "copy");
      mkdirSync(copied);
      chmodSync(copied, 0o777);
      const turndb = join(copied, "turndb");
      copyFileSync(join(created, "turndb"), turndb);
      chmodSync(turndb, 0o666);

      const found = relayTable(
        turndb,
        `print(json.dumps([
    relay_table.status(conn, "${REALM}", "none", "${KEY_TURNADMIN}"),
    relay_table.register(conn, "${REALM}", "schema-probe", "${KEY_MODULE}", None, 0)["outcome"],
    relay_table.forget_key(conn, "${REALM}", "${KEY_TURNADMIN}"),
]))`,
      );
      expect(found).toEqual(["disagree", "registered", true]);

      const listing = turnadmin(copied, "-S");
      expect(listing.status, listing.stderr).toBe(0);
      const rows = listing.stdout
        .split("\n")
        .filter((line) => line.endsWith(`[${REALM}]`));
      expect(rows).toEqual([`${KEY_MODULE}[${REALM}]`]);
    },
  );
});
