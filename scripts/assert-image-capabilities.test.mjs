import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  deriveImageDependencies,
  repositoryRoot,
} from "./derive-image-dependencies.mjs";
import {
  batteryRan,
  coverageGaps,
  CLI_RECIPES,
  FIXTURE_ENVIRONMENT,
  GENERATED_ENVIRONMENT,
  HELPER_EXPECTATIONS,
  readVerdict,
  recipeKey,
} from "./assert-image-capabilities.mjs";

// The image gate, driven end to end against a stub container engine, plus the
// half of it that needs no engine at all: whether every dependency derived from
// the shipped support scripts has something here that exercises it.
//
// The engine is stubbed rather than mocked out of the script -- a real process
// reads a real argument vector and answers on its own streams -- so the mounts,
// the way a credential reaches a container, and the verdict handling are
// asserted as Docker would receive and answer them.
//
// What it cannot reach: the image, and therefore every verdict the gate exists
// to reach. Only a run with a daemon determines whether an image answers the
// set below.

const derived = deriveImageDependencies(repositoryRoot());
const GATE = resolve(repositoryRoot(), "scripts/assert-image-capabilities.mjs");

describe("recipe coverage of the derived set", () => {
  it("leaves no dependency of the shipped scripts unexercised", () => {
    expect(coverageGaps(derived)).toEqual([]);
  });

  it("keys a recipe by the command and its mode, not the whole vector", () => {
    expect(recipeKey(["doctor", "mount", "/rz", "--json"])).toBe(
      "doctor mount",
    );
    expect(recipeKey(["serve"])).toBe("serve");
  });

  it("reports a call site asking for something no recipe exercises", () => {
    const grown = {
      ...derived,
      cli: [
        ...derived.cli,
        { argv: ["doctor", "network"], sites: ["Start-Psilink.ps1:900"] },
      ],
    };
    expect(coverageGaps(grown)).toEqual([
      expect.stringContaining('no recipe named "doctor network"'),
    ]);
  });

  it("reports a helper script whose run nothing grades", () => {
    const grown = {
      ...derived,
      helpers: [
        ...derived.helpers,
        {
          script: "cmd_psilink-newcheck.sh",
          env: [],
          mounts: [],
          sites: ["cmd_Setup-PsilinkFileDrop.cmd:900"],
        },
      ],
    };
    expect(coverageGaps(grown)).toEqual([
      expect.stringContaining("nothing says what its run must show"),
    ]);
  });

  it("reports a helper environment name no fixture supplies", () => {
    const grown = {
      ...derived,
      helpers: derived.helpers.map((helper) => ({
        ...helper,
        env: [...helper.env, "SMB_NEW_INPUT"],
      })),
    };
    expect(coverageGaps(grown)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("no fixture supplies a value for it"),
      ]),
    );
  });

  it("reports a recipe the scripts no longer ask for", () => {
    const shrunk = { ...derived, cli: derived.cli.slice(1) };
    expect(coverageGaps(shrunk)).toEqual([
      expect.stringContaining("no support script asks the image for it"),
    ]);
  });

  it("supplies a value for every environment name the call sites pass", () => {
    for (const helper of derived.helpers) {
      for (const name of helper.env) {
        expect(
          name in FIXTURE_ENVIRONMENT || GENERATED_ENVIRONMENT.includes(name),
        ).toBe(true);
      }
    }
  });

  it("grades every helper on reaching something past the tools it needs", () => {
    for (const expectation of Object.values(HELPER_EXPECTATIONS)) {
      expect(expectation.reaches.length).toBeGreaterThan(0);
    }
  });

  it("exercises each recipe through a function rather than a description", () => {
    for (const recipe of Object.values(CLI_RECIPES)) {
      expect(typeof recipe).toBe("function");
    }
  });
});

describe("what an exit code is taken as evidence of", () => {
  it("accepts the two codes a run reaches", () => {
    expect(batteryRan(0)).toBe(true);
    expect(batteryRan(78)).toBe(true);
  });

  it("refuses the refused-input code, which an image with no doctor also gives", () => {
    expect(batteryRan(64)).toBe(false);
  });

  it("refuses the code a run gives when a dependency was missing", () => {
    expect(batteryRan(69)).toBe(false);
  });

  it("refuses the range the engine keeps for failing to start a container", () => {
    expect(batteryRan(125)).toBe(false);
    expect(batteryRan(127)).toBe(false);
  });
});

describe("reading a verdict out of what a container printed", () => {
  it("finds the document under an entrypoint preamble", () => {
    const stdout = [
      "FIPS provider active",
      "host kernel reports fips=0",
      '{"version":1,"mode":"mount","overall":"ok","checks":[]}',
    ].join("\n");
    expect(readVerdict(stdout)).toEqual({
      version: 1,
      mode: "mount",
      overall: "ok",
      checks: [],
    });
  });

  it("finds nothing in a stream containing no document", () => {
    expect(readVerdict("mount_readable: ok\nmarker: skipped\n")).toBeNull();
  });

  it("finds nothing in a JSON line that is not a verdict", () => {
    expect(readVerdict('{"error":"broken"}')).toBeNull();
  });

  it("finds nothing in a line that only starts like one", () => {
    expect(readVerdict('{"version":1')).toBeNull();
  });
});

// A container engine that records the argument vector it was handed and answers
// on its own streams. Every branch answers the shape the real engine answers,
// and an argument vector it does not recognise fails loudly rather than
// returning a success the gate would treat as a capability.
const STUB_ENGINE = `#!/bin/sh
printf '%s\\n' "$*" >>"$STUB_LOG"
case "$*" in
  "image inspect"*)
    printf 'sha256:1111 ["vdorie/psi-link@sha256:2222"]\\n' ;;
  "network create"*|"network rm"*|"rm --force"*|"logs "*)
    printf 'ok\\n' ;;
  *"--entrypoint node"*)
    printf 'stub-peer-id\\n' ;;
  *"doctor --help")
    printf 'Usage: psilink doctor <probe | mount DIRECTORY> [options]\\n' ;;
  *"doctor probe --json")
    printf '%s\\n' "$STUB_PROBE_VERDICT"; exit "$STUB_PROBE_STATUS" ;;
  *"doctor mount /rz --json")
    printf '%s\\n' "$STUB_MOUNT_VERDICT"; exit "$STUB_MOUNT_STATUS" ;;
  *serve)
    node -e 'const s = require("http").createServer((q, r) => r.end("ok")); s.listen(3111, "127.0.0.1"); setTimeout(() => process.exit(0), 60000);' >/dev/null 2>&1 &
    printf '%s\\n' "$!" >"$STUB_SERVE_PID"
    printf 'serve-container-id\\n' ;;
  *"tr -d"*)
    piped=$(cat)
    case "$piped" in
      *"mints the run token"*)
        printf 'VERDICT=OK\\nWARN=\\nTOKEN=0123456789abcdef0123456789abcdef\\n' ;;
      *"Container-side checks"*)
        printf '%s\\n' "-- 1. Name resolution" "-- 2. TCP reachability" "-- 3. Authentication" ;;
      *"Runs over the mounted volume"*)
        printf 'MARKER_MISSING\\nWRITE_OK\\nEXCL_OK\\nRENAME_OK\\n' ;;
      *) printf 'no stub answer for this helper\\n' >&2; exit 9 ;;
    esac ;;
  *)
    printf 'no stub answer for: %s\\n' "$*" >&2; exit 99 ;;
esac
`;

const OK_PROBE_VERDICT = JSON.stringify({
  version: 1,
  mode: "probe",
  overall: "fix_and_retry",
  checks: [
    { id: "tcp_445", status: "ok" },
    { id: "smbclient_available", status: "ok" },
    { id: "authentication", status: "fail" },
  ],
});
const OK_MOUNT_VERDICT = JSON.stringify({
  version: 1,
  mode: "mount",
  overall: "ok",
  checks: [
    { id: "mount_readable", status: "ok" },
    { id: "marker", status: "ok" },
  ],
});

describe("the gate driven against a stub engine", () => {
  let workspace = null;

  afterEach(() => {
    if (workspace === null) return;
    const pidFile = join(workspace, "serve.pid");
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      try {
        process.kill(pid);
      } catch {
        // Already gone: the stub's server exits on its own timer too.
      }
    }
    rmSync(workspace, { recursive: true, force: true });
    workspace = null;
  });

  function drive(overrides = {}) {
    workspace = mkdtempSync(join(tmpdir(), "psilink-gate-stub-"));
    const engine = join(workspace, "docker");
    writeFileSync(engine, STUB_ENGINE);
    chmodSync(engine, 0o755);
    const log = join(workspace, "engine.log");
    writeFileSync(log, "");
    const result = spawnSync(process.execPath, [GATE, "psi-link:smoke"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${workspace}:${process.env.PATH}`,
        STUB_LOG: log,
        STUB_SERVE_PID: join(workspace, "serve.pid"),
        STUB_PROBE_VERDICT: OK_PROBE_VERDICT,
        STUB_PROBE_STATUS: "78",
        STUB_MOUNT_VERDICT: OK_MOUNT_VERDICT,
        STUB_MOUNT_STATUS: "0",
        ...overrides,
      },
    });
    return { result, invocations: readFileSync(log, "utf8").split("\n") };
  }

  it("exercises every derived dependency and says so", () => {
    const { result } = drive();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `all ${derived.cli.length + derived.helpers.length} dependencies`,
    );
  });

  it("reports the digest the reference resolved to, not the reference", () => {
    const { result } = drive();
    expect(result.stdout).toContain("vdorie/psi-link@sha256:2222");
  });

  it("hands the credential by name, never as an argument", () => {
    const { result, invocations } = drive();
    const passing = invocations.filter((line) => line.includes("SMB_PASS"));
    expect(passing.length).toBeGreaterThan(0);
    for (const line of passing) expect(line).toContain("--env SMB_PASS");
    for (const line of invocations)
      expect(line).not.toContain(FIXTURE_ENVIRONMENT.SMB_PASS);
    expect(result.stdout).not.toContain(FIXTURE_ENVIRONMENT.SMB_PASS);
  });

  it("mounts a directory the image's own account can write at the checks' path", () => {
    const { invocations } = drive();
    const mounted = invocations.filter((line) =>
      line.includes("doctor mount /rz --json"),
    );
    expect(mounted.length).toBe(2);
    for (const line of mounted) expect(line).toMatch(/--volume \S+:\/rz /);
  });

  it("puts the probe and its stub peer on one network, and takes it down", () => {
    const { invocations } = drive();
    const created = invocations.find((line) =>
      line.startsWith("network create"),
    );
    expect(created).toBeDefined();
    const network = created.split(" ")[2];
    expect(
      invocations.find((line) => line.includes("doctor probe --json")),
    ).toContain(`--network ${network}`);
    expect(
      invocations.find((line) => line.includes("--entrypoint node")),
    ).toContain(`--network ${network}`);
    expect(invocations).toContain(`network rm ${network}`);
    expect(invocations.some((line) => line.startsWith("rm --force"))).toBe(
      true,
    );
  });

  it("pipes each helper in with the environment and mount its call site gives it", () => {
    const { invocations } = drive();
    const piped = invocations.filter((line) =>
      line.includes("--entrypoint sh"),
    );
    expect(piped.length).toBe(derived.helpers.length);
    const volcheck = piped.find((line) => line.includes("--env MARKER"));
    expect(volcheck).toContain("--env TOKEN");
    expect(volcheck).toMatch(/--volume \S+:\/rz /);
  });

  it("fails on a verdict version the shipped launchers would not read", () => {
    const { result } = drive({
      STUB_MOUNT_VERDICT: JSON.stringify({
        version: 2,
        overall: "ok",
        checks: [],
      }),
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("verdict version 2");
    expect(result.stderr).toContain("went unanswered");
  });

  it("fails on the exit code a refused input gives, which proves nothing ran", () => {
    const { result } = drive({
      STUB_PROBE_VERDICT: "",
      STUB_PROBE_STATUS: "64",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("64 is a refused input");
  });

  it("fails when the run could not reach smbclient", () => {
    const { result } = drive({
      STUB_PROBE_VERDICT: JSON.stringify({
        version: 1,
        overall: "fatal",
        checks: [{ id: "smbclient_available", status: "fail" }],
      }),
      STUB_PROBE_STATUS: "78",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("smbclient_available as fail");
  });
});
