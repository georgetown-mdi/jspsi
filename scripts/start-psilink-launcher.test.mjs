import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The POSIX launcher, driven end to end against a stub container engine.
//
// What it stands in for: an operator on macOS or Linux with a folder and an
// engine, and a container whose doctor verdict decides whether the console
// starts. The engine is stubbed rather than mocked out of the script -- the
// launcher builds a real argument vector and a real process reads it -- so the
// mount flags, the publish binding and the verdict handling are asserted as the
// engine would receive them.
//
// What it cannot reach: the real image (nothing here pulls one), the browser,
// and Windows. Start-Psilink.ps1's share of this ground is covered by the Pester
// suite the windows_resolution workflow runs.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const LAUNCHER = resolve(
  repoRoot,
  "support/windows-network-filedrop/start-psilink.sh",
);

// Named absolutely for the one case that strips PATH down to a directory
// holding no engine: Node resolves a child's program through the child's own
// PATH, so a bare "bash" would not be found there.
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";

const PLACEHOLDER_LINE = "PSILINK_IMAGE_DIGEST='@@PSILINK_IMAGE_DIGEST@@'";
const TEST_DIGEST = `sha256:${"a1b2c3d4".repeat(8)}`;

// A container engine that records its argument vectors, answers the doctor from
// fixture files in turn, and can hold a port open for the console.
const STUB_ENGINE = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const dir = process.env.PSILINK_STUB_DIR;
const args = process.argv.slice(2);
const engine = path.basename(process.argv[1]);
fs.appendFileSync(path.join(dir, "calls.log"), engine + " " + args.join(" ") + "\\n");

if (fs.existsSync(path.join(dir, engine + ".broken"))) process.exit(1);
if (args[0] === "version") process.exit(0);

if (args.includes("doctor")) {
  const turnFile = path.join(dir, "turn");
  let turn = 0;
  try { turn = Number(fs.readFileSync(turnFile, "utf8")) || 0; } catch { turn = 0; }
  turn += 1;
  fs.writeFileSync(turnFile, String(turn));
  let fixture = path.join(dir, "verdict-" + turn);
  if (!fs.existsSync(fixture)) fixture = path.join(dir, "verdict-last");
  const lines = fs.readFileSync(fixture, "utf8").split("\\n");
  const code = Number(lines[0]);
  const body = lines.slice(1).join("\\n").trim();
  if (body) process.stdout.write(body + "\\n");
  process.exit(code);
}

if (args.includes("serve")) {
  const publish = args[args.indexOf("--publish") + 1];
  const port = Number(publish.split(":")[1]);
  const server = net.createServer((socket) => socket.end());
  server.listen(port, "127.0.0.1");
  setTimeout(() => process.exit(0), 60000);
  return;
}

process.exit(0);
`;

const workspaces = [];

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "psilink-launcher-"));
  workspaces.push(root);
  const binDir = join(root, "bin");
  const stubDir = join(root, "stub");
  const dataDir = join(root, "data");
  for (const dir of [binDir, stubDir, dataDir]) mkdirSync(dir);
  return { root, binDir, stubDir, dataDir };
}

afterEach(() => {
  while (workspaces.length > 0) {
    rmSync(workspaces.pop(), { recursive: true, force: true });
  }
});

function installEngine(workspace, name) {
  const target = join(workspace.binDir, name);
  writeFileSync(target, STUB_ENGINE);
  chmodSync(target, 0o755);
}

/**
 * A `uname` ahead of the real one, answering with `system`. The launcher reads
 * the host's kind to decide whether a bind mount carries ownership into the
 * container, so stubbing it is what lets both answers be driven from one host.
 */
function stubUname(workspace, system) {
  const target = join(workspace.binDir, "uname");
  writeFileSync(target, `#!/bin/sh\necho ${system}\n`);
  chmodSync(target, 0o755);
}

/** The account the launcher runs the container as on a host that carries
 * ownership through: the one running this suite. */
const OPERATOR_IDENTITY = `${process.getuid()}:${process.getgid()}`;

/** The console argument vector the launcher would hand the engine, one argument
 * per line, for the folders given. */
function consoleArguments(workspace, folders) {
  const assignments = Object.entries(folders)
    .map(([name, value]) => `${name}='${value}'`)
    .join("\n");
  const run = sourced(
    workspace,
    `${assignments}\nPSILINK_CONTAINER_NAME=psilink-console-1\nPSILINK_PORT=3000\n` +
      'psilink_build_console_arguments\nprintf "%s\\n" "${PSILINK_CONSOLE_ARGUMENTS[@]}"',
  );
  expect(run.status).toBe(0);
  return run.stdout.trim().split("\n");
}

function breakEngine(workspace, name) {
  writeFileSync(join(workspace.stubDir, `${name}.broken`), "");
}

/** A verdict the stub answers with on its `turn`-th doctor run. */
function stageVerdict(workspace, turn, exitCode, verdict) {
  writeFileSync(
    join(workspace.stubDir, `verdict-${turn}`),
    `${exitCode}\n${JSON.stringify(verdict)}\n`,
  );
  writeFileSync(
    join(workspace.stubDir, "verdict-last"),
    `${exitCode}\n${JSON.stringify(verdict)}\n`,
  );
}

/** The launcher with its digest line stamped, as a release copy would be. */
function stampedLauncher(workspace) {
  const source = readFileSync(LAUNCHER, "utf8");
  const stamped = source.replace(
    PLACEHOLDER_LINE,
    `PSILINK_IMAGE_DIGEST='${TEST_DIGEST}'`,
  );
  expect(stamped).not.toBe(source);
  const target = join(workspace.root, "start-psilink.sh");
  writeFileSync(target, stamped);
  chmodSync(target, 0o755);
  return target;
}

function launcherEnvironment(workspace) {
  return {
    ...process.env,
    PATH: `${workspace.binDir}:${process.env.PATH}`,
    PSILINK_STUB_DIR: workspace.stubDir,
  };
}

function runLauncher(workspace, script, args, input = "") {
  return spawnSync(BASH, [script, ...args], {
    input,
    encoding: "utf8",
    timeout: 60_000,
    env: launcherEnvironment(workspace),
  });
}

function engineCalls(workspace) {
  try {
    return readFileSync(join(workspace.stubDir, "calls.log"), "utf8");
  } catch {
    return "";
  }
}

/** Run a shell snippet with the launcher sourced, as the suite's own harness. */
function sourced(workspace, snippet) {
  return spawnSync(BASH, ["-c", `. '${LAUNCHER}'\n${snippet}`], {
    encoding: "utf8",
    timeout: 30_000,
    env: launcherEnvironment(workspace),
  });
}

const FIX_AND_RETRY = {
  version: 1,
  mode: "mount",
  overall: "fix_and_retry",
  checks: [
    { id: "mount_readable", status: "ok" },
    {
      id: "write_rename",
      status: "fail",
      meaning: "the folder cannot be written to, {even} as this account.",
      action: 'ask for write permission on "the folder".',
    },
    {
      id: "rename_onto_existing",
      status: "warn",
      meaning: "this share will not rename a file onto an existing one.",
      action: "pass --lockless-rendezvous on both sides.",
    },
  ],
};

const ALL_OK = {
  version: 1,
  mode: "mount",
  overall: "ok",
  checks: [
    { id: "mount_readable", status: "ok" },
    {
      id: "exclusive_create",
      status: "warn",
      meaning: "this share does not refuse a create of a file that exists.",
      action: "pass --lockless-rendezvous on both sides.",
    },
  ],
};

const FATAL = {
  version: 1,
  mode: "mount",
  overall: "fatal",
  checks: [
    {
      id: "mount_readable",
      status: "fail",
      meaning: "the directory could not be listed.",
      action: "check that the folder still exists.",
    },
    { id: "marker", status: "skipped", meaning: "an earlier check stopped." },
  ],
};

describe("the release stamp", () => {
  it("refuses to run an unstamped copy, before touching the engine", () => {
    const workspace = makeWorkspace();
    installEngine(workspace, "docker");

    const run = runLauncher(workspace, LAUNCHER, [
      "--data-root",
      workspace.dataDir,
    ]);

    expect(run.status).not.toBe(0);
    expect(run.stdout).toMatch(/did not come from a release/);
    expect(run.stdout).toMatch(/github\.com\/georgetown-mdi\/jspsi\/releases/);
    // Nothing ran: an unpinned launcher must not reach an engine at all.
    expect(engineCalls(workspace)).toBe("");
  });
});

describe("the sourcing contract", () => {
  it("defines the functions and runs nothing when sourced", () => {
    const workspace = makeWorkspace();
    const run = sourced(workspace, "type -t psilink_json_load psilink_main");

    expect(run.status).toBe(0);
    expect(run.stderr.trim()).toBe("");
    // Exactly the two words: the flow announces itself with a banner before it
    // does anything, so any of it running shows up here.
    expect(run.stdout.trim().split("\n")).toEqual(["function", "function"]);
  });

  it("leaves an ordinary run running the flow", () => {
    const workspace = makeWorkspace();
    const run = runLauncher(workspace, LAUNCHER, [
      "--data-root",
      workspace.dataDir,
    ]);

    expect(run.stdout).toMatch(/psilink console/);
    expect(run.status).not.toBe(0);
  });
});

describe("the shared folder's name passed to the console", () => {
  it("names the rendezvous folder the operator picked", () => {
    // The container is shown /rendezvous whatever folder was picked, so the
    // folder's own name has to travel beside the mount.
    const args = consoleArguments(makeWorkspace(), {
      PSILINK_DATA_ROOT: "/home/dana/psilink-work",
      PSILINK_RENDEZVOUS_DIR: "/home/dana/Egnyte/agency-a-agency-b",
    });

    expect(args).toContain("JOB_RENDEZVOUS_DIR=/rendezvous");
    expect(args).toContain("JOB_RENDEZVOUS_NAME=agency-a-agency-b");
  });

  it("names the working folder when it is the only one", () => {
    // A single-folder console rendezvouses out of the data mount, which the
    // container sees as /data -- a name no partner could match.
    const args = consoleArguments(makeWorkspace(), {
      PSILINK_DATA_ROOT: "/home/dana/county-exchange",
    });

    expect(args.join(" ")).not.toContain("JOB_RENDEZVOUS_DIR");
    expect(args).toContain("JOB_RENDEZVOUS_NAME=county-exchange");
  });

  it("keeps a folder name carrying a space in one argument", () => {
    const args = consoleArguments(makeWorkspace(), {
      PSILINK_DATA_ROOT: "/home/dana/Shared Drive/County Exchange/",
    });

    expect(args).toContain("JOB_RENDEZVOUS_NAME=County Exchange");
  });

  it("passes an empty name for a folder that has none", () => {
    // The filesystem root reduces to no name at all. The variable still travels,
    // empty: leaving it out has the console name the folder after the mount point
    // THIS launcher picked -- /data or /rendezvous -- and mint that as the name
    // the partner is told to look for.
    for (const folders of [
      { PSILINK_DATA_ROOT: "/" },
      {
        PSILINK_DATA_ROOT: "/home/dana/psilink-work",
        PSILINK_RENDEZVOUS_DIR: "/",
      },
    ]) {
      const args = consoleArguments(makeWorkspace(), folders);

      expect(args).toContain("JOB_RENDEZVOUS_NAME=");
      expect(args.join(" ")).not.toMatch(/JOB_RENDEZVOUS_NAME=\S/);
    }
  });
});

describe("the account the container runs as", () => {
  // A Linux bind mount carries its host directory's ownership into the
  // container, so an image running as its own fixed account can only write what
  // that account's number owns -- and an operator numbered from a directory
  // service is not it. The launcher runs the container as the operator instead,
  // which moves the one thing that account cannot then reach: the directory the
  // image built for itself to hold a pasted SFTP credential.

  it("runs the console as the operator's own account", () => {
    const workspace = makeWorkspace();
    stubUname(workspace, "Linux");

    const args = consoleArguments(workspace, {
      PSILINK_DATA_ROOT: "/home/dana/psilink-work",
    });

    expect(args).toContain("--user");
    expect(args[args.indexOf("--user") + 1]).toBe(OPERATOR_IDENTITY);
  });

  it("points the pasted-credential scratch outside every mount it makes", () => {
    const workspace = makeWorkspace();
    stubUname(workspace, "Linux");

    const args = consoleArguments(workspace, {
      PSILINK_DATA_ROOT: "/home/dana/work",
      PSILINK_INPUT_DIR: "/home/dana/input",
      PSILINK_RENDEZVOUS_DIR: "/home/dana/shared",
    });

    const override = args.find((value) =>
      value.startsWith("JOB_SFTP_CREDENTIAL_DIR="),
    );
    expect(override).toBeDefined();
    const scratch = override.slice("JOB_SFTP_CREDENTIAL_DIR=".length);
    const mountPoints = args
      .map((value, index) => (args[index - 1] === "--volume" ? value : null))
      .filter((value) => value !== null)
      .map((value) => value.slice(value.lastIndexOf(":") + 1));
    expect(mountPoints).toEqual(["/data", "/input", "/rendezvous"]);
    // The console refuses to start when the scratch directory is, contains, or
    // sits inside a mounted folder: a pasted secret there would land where the
    // partner's sync or the operator's own results already are.
    for (const mount of mountPoints) {
      expect(scratch).not.toBe(mount);
      expect(scratch.startsWith(`${mount}/`)).toBe(false);
      expect(mount.startsWith(`${scratch}/`)).toBe(false);
    }
  });

  it("passes no identity where the mount carries no ownership through", () => {
    // A macOS engine runs the container in a virtual machine and presents the
    // mount to whichever account it runs as, so there is nothing to match and
    // the image's own account keeps its own scratch directory.
    const workspace = makeWorkspace();
    stubUname(workspace, "Darwin");

    const args = consoleArguments(workspace, {
      PSILINK_DATA_ROOT: "/Users/dana/psilink-work",
    });

    expect(args).not.toContain("--user");
    expect(args.join(" ")).not.toContain("JOB_SFTP_CREDENTIAL_DIR");
  });

  it("runs the checks as the account the console will run as", () => {
    // A battery run as some other account reports on that account: the check
    // and the console it gates have to be the same one.
    const workspace = makeWorkspace();
    stubUname(workspace, "Linux");
    installEngine(workspace, "docker");
    stageVerdict(workspace, 1, 78, FIX_AND_RETRY);
    const launcher = stampedLauncher(workspace);

    runLauncher(
      workspace,
      launcher,
      ["--data-root", workspace.dataDir, "--no-browser"],
      "n\n",
    );

    const doctorRun = engineCalls(workspace)
      .split("\n")
      .find((line) => line.includes("doctor"));
    expect(doctorRun).toContain(`--user ${OPERATOR_IDENTITY}`);
  });
});

describe("option validation", () => {
  it("refuses a port outside 1-65535, before touching the engine", () => {
    const workspace = makeWorkspace();
    installEngine(workspace, "docker");
    const launcher = stampedLauncher(workspace);

    for (const port of ["0", "65536", "999999999999999999999"]) {
      const run = runLauncher(workspace, launcher, [
        "--data-root",
        workspace.dataDir,
        "--port",
        port,
      ]);
      expect(run.status).not.toBe(0);
      expect(run.stdout).toMatch(/between 1 and 65535/);
    }
    expect(engineCalls(workspace)).toBe("");
  });
});

describe("the verdict reader", () => {
  const read = (workspace, document, snippet) =>
    sourced(
      workspace,
      `psilink_json_load ${JSON.stringify(document)} || { echo REFUSED; exit 0; }\n${snippet}`,
    );

  it("reports an absent optional field as absent", () => {
    const workspace = makeWorkspace();
    const run = read(
      workspace,
      '{"version":1,"checks":[{"id":"a","status":"ok"}]}',
      [
        'checks=$(psilink_json_member "$PSILINK_JSON_SKELETON" checks)',
        'first=$(psilink_json_elements "$checks" | head -1)',
        'psilink_json_member "$first" meaning >/dev/null && echo PRESENT || echo ABSENT',
      ].join("\n"),
    );

    expect(run.stdout.trim()).toBe("ABSENT");
  });

  it("reports an explicit null as absent rather than as a value", () => {
    const workspace = makeWorkspace();
    const run = read(
      workspace,
      '{"version":1,"checks":[{"id":"a","status":"warn","action":null}]}',
      [
        'checks=$(psilink_json_member "$PSILINK_JSON_SKELETON" checks)',
        'first=$(psilink_json_elements "$checks" | head -1)',
        'psilink_json_member "$first" action >/dev/null && echo PRESENT || echo ABSENT',
      ].join("\n"),
    );

    expect(run.stdout.trim()).toBe("ABSENT");
  });

  it("keeps prose that holds a brace, a comma and a quote intact", () => {
    const workspace = makeWorkspace();
    const document = JSON.stringify({
      version: 1,
      checks: [
        {
          id: "write",
          status: "fail",
          meaning: 'a folder named "q3,final" {here} cannot be written.',
        },
      ],
    });
    const run = read(
      workspace,
      document,
      [
        'checks=$(psilink_json_member "$PSILINK_JSON_SKELETON" checks)',
        'first=$(psilink_json_elements "$checks" | head -1)',
        'psilink_json_text "$(psilink_json_member "$first" meaning)"',
      ].join("\n"),
    );

    expect(run.stdout).toBe(
      'a folder named "q3,final" {here} cannot be written.',
    );
  });

  it("turns an escaped control character into a space", () => {
    const workspace = makeWorkspace();
    const document = JSON.stringify({
      version: 1,
      checks: [{ id: "a", status: "warn", meaning: "before[31mafter" }],
    });
    const run = read(
      workspace,
      document,
      [
        'checks=$(psilink_json_member "$PSILINK_JSON_SKELETON" checks)',
        'first=$(psilink_json_elements "$checks" | head -1)',
        'psilink_json_text "$(psilink_json_member "$first" meaning)" | cat -v',
      ].join("\n"),
    );

    expect(run.stdout).toBe("before [31mafter");
    expect(run.stdout).not.toContain("^[");
  });

  it("refuses a line that is not a JSON object", () => {
    const workspace = makeWorkspace();
    const run = read(workspace, "docker: command not found", "echo READ");

    expect(run.stdout.trim()).toBe("REFUSED");
  });

  it("drops a raw carriage return from container text", () => {
    const workspace = makeWorkspace();
    // A raw CR is not JSON-escaped prose: it reaches the byte filter directly,
    // and left alone it rewrites the terminal line it lands on.
    const run = sourced(
      workspace,
      `psilink_say_from_container "$(printf 'before\\rafter')" | cat -v`,
    );

    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe("beforeafter");
  });

  it("finds a check by its id rather than its position", () => {
    const workspace = makeWorkspace();
    const document = JSON.stringify({
      version: 1,
      checks: [
        { id: "added_later", status: "ok" },
        { id: "marker", status: "warn", meaning: "a marker from another run." },
      ],
    });
    const run = read(
      workspace,
      document,
      [
        'checks=$(psilink_json_member "$PSILINK_JSON_SKELETON" checks)',
        'psilink_show_checks_with_status "$checks" warn',
      ].join("\n"),
    );

    expect(run.stdout).toMatch(/WARN\s+marker/);
    expect(run.stdout).toMatch(/a marker from another run\./);
  });
});

describe("the doctor loop", () => {
  it("refuses a verdict version it does not read, and starts nothing", () => {
    const workspace = makeWorkspace();
    installEngine(workspace, "docker");
    stageVerdict(workspace, 1, 0, {
      version: 2,
      mode: "mount",
      overall: "ok",
      checks: [],
    });
    const launcher = stampedLauncher(workspace);

    const run = runLauncher(workspace, launcher, [
      "--data-root",
      workspace.dataDir,
      "--no-browser",
    ]);

    expect(run.status).not.toBe(0);
    expect(run.stdout).toMatch(/verdict version 2/);
    expect(engineCalls(workspace)).not.toMatch(/serve/);
  });

  it("prints each failing check's meaning and action, and runs again", () => {
    const workspace = makeWorkspace();
    installEngine(workspace, "docker");
    stageVerdict(workspace, 1, 78, FIX_AND_RETRY);
    const launcher = stampedLauncher(workspace);

    // Accept the first retry, decline the second: two batteries run, and the
    // console is never reached.
    const run = runLauncher(
      workspace,
      launcher,
      ["--data-root", workspace.dataDir, "--no-browser"],
      "y\nn\n",
    );

    // Verbatim, as the container wrote it: the launcher classifies, the image
    // owns the words.
    expect(run.stdout).toContain(
      "MEANING: the folder cannot be written to, {even} as this account.",
    );
    expect(run.stdout).toContain(
      'ACTION:  ask for write permission on "the folder".',
    );
    // A warn alongside the failure is shown too: it does not stop an exchange
    // and still has to be read.
    expect(run.stdout).toContain(
      "MEANING: this share will not rename a file onto an existing one.",
    );
    const doctorRuns = engineCalls(workspace)
      .split("\n")
      .filter((line) => line.includes("doctor"));
    expect(doctorRuns).toHaveLength(2);
    expect(engineCalls(workspace)).not.toMatch(/serve/);
  });

  it("stops on a declined retry without starting the console", () => {
    const workspace = makeWorkspace();
    installEngine(workspace, "docker");
    stageVerdict(workspace, 1, 78, FIX_AND_RETRY);
    const launcher = stampedLauncher(workspace);

    const run = runLauncher(
      workspace,
      launcher,
      ["--data-root", workspace.dataDir, "--no-browser"],
      "n\n",
    );

    expect(run.status).not.toBe(0);
    expect(run.stdout).toMatch(/Stopping without starting the console/);
    expect(engineCalls(workspace)).not.toMatch(/serve/);
  });

  it("stops rather than loops when stdin closes during the retry prompt", () => {
    const workspace = makeWorkspace();
    installEngine(workspace, "docker");
    stageVerdict(workspace, 1, 78, FIX_AND_RETRY);
    const launcher = stampedLauncher(workspace);

    // No input at all: a run without a TTY whose verdict stays fix_and_retry
    // must stop after one battery, not spin the engine on a prompt nobody
    // will answer.
    const run = runLauncher(workspace, launcher, [
      "--data-root",
      workspace.dataDir,
      "--no-browser",
    ]);

    expect(run.status).not.toBe(0);
    const doctorRuns = engineCalls(workspace)
      .split("\n")
      .filter((line) => line.includes("doctor"));
    expect(doctorRuns).toHaveLength(1);
    expect(engineCalls(workspace)).not.toMatch(/serve/);
  });

  it("stops on a fatal verdict and points at the troubleshooting page", () => {
    const workspace = makeWorkspace();
    installEngine(workspace, "docker");
    stageVerdict(workspace, 1, 69, FATAL);
    const launcher = stampedLauncher(workspace);

    const run = runLauncher(workspace, launcher, [
      "--data-root",
      workspace.dataDir,
      "--no-browser",
    ]);

    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain("MEANING: the directory could not be listed.");
    expect(run.stdout).toMatch(/nothing was established/);
    expect(run.stdout).toMatch(/troubleshooting\.md/);
    // A fatal verdict is not retried: there is no ACTION to follow.
    const doctorRuns = engineCalls(workspace)
      .split("\n")
      .filter((line) => line.includes("doctor"));
    expect(doctorRuns).toHaveLength(1);
    expect(engineCalls(workspace)).not.toMatch(/serve/);
  });

  it("runs the mount battery against every folder the console is given", () => {
    // The console reads and writes all of them, so a fault in any one of them
    // is a reason not to start. Checking the shared folder alone leaves the
    // other two to fail as an EACCES after the browser has opened.
    const workspace = makeWorkspace();
    installEngine(workspace, "docker");
    const inputDir = join(workspace.root, "input");
    const rendezvous = join(workspace.root, "shared");
    mkdirSync(inputDir);
    mkdirSync(rendezvous);
    stageVerdict(workspace, 1, 0, ALL_OK);
    stageVerdict(workspace, 2, 0, ALL_OK);
    stageVerdict(workspace, 3, 78, FIX_AND_RETRY);
    const launcher = stampedLauncher(workspace);

    runLauncher(
      workspace,
      launcher,
      [
        "--data-root",
        workspace.dataDir,
        "--input-dir",
        inputDir,
        "--rendezvous-dir",
        rendezvous,
        "--no-browser",
      ],
      "n\n",
    );

    const doctorRuns = engineCalls(workspace)
      .split("\n")
      .filter((line) => line.includes("doctor"));
    expect(doctorRuns).toHaveLength(3);
    expect(doctorRuns[0]).toContain(`--volume ${workspace.dataDir}:/rz`);
    expect(doctorRuns[1]).toContain(`--volume ${inputDir}:/rz`);
    expect(doctorRuns[2]).toContain(`--volume ${rendezvous}:/rz`);
    expect(doctorRuns[0]).toContain("doctor mount /rz --json");
    expect(doctorRuns[0]).toContain(`vdorie/psi-link@${TEST_DIGEST}`);
    expect(engineCalls(workspace)).not.toMatch(/serve/);
  });

  it("runs one battery when the same folder was given for everything", () => {
    const workspace = makeWorkspace();
    installEngine(workspace, "docker");
    stageVerdict(workspace, 1, 78, FIX_AND_RETRY);
    const launcher = stampedLauncher(workspace);

    runLauncher(
      workspace,
      launcher,
      [
        "--data-root",
        workspace.dataDir,
        "--input-dir",
        workspace.dataDir,
        "--rendezvous-dir",
        workspace.dataDir,
        "--no-browser",
      ],
      "n\n",
    );

    const doctorRuns = engineCalls(workspace)
      .split("\n")
      .filter((line) => line.includes("doctor"));
    expect(doctorRuns).toHaveLength(1);
  });
});

describe("engine detection", () => {
  it("prefers docker", () => {
    const workspace = makeWorkspace();
    installEngine(workspace, "docker");
    installEngine(workspace, "podman");
    stageVerdict(workspace, 1, 78, FIX_AND_RETRY);
    const launcher = stampedLauncher(workspace);

    const run = runLauncher(
      workspace,
      launcher,
      ["--data-root", workspace.dataDir, "--no-browser"],
      "n\n",
    );

    expect(run.stdout).toMatch(/Using docker\./);
  });

  it("falls back to podman when docker does not answer", () => {
    const workspace = makeWorkspace();
    installEngine(workspace, "docker");
    installEngine(workspace, "podman");
    breakEngine(workspace, "docker");
    stageVerdict(workspace, 1, 78, FIX_AND_RETRY);
    const launcher = stampedLauncher(workspace);

    const run = runLauncher(
      workspace,
      launcher,
      ["--data-root", workspace.dataDir, "--no-browser"],
      "n\n",
    );

    expect(run.stdout).toMatch(/Using podman\./);
  });

  it("says so when neither answers", () => {
    const workspace = makeWorkspace();
    const launcher = stampedLauncher(workspace);

    const run = spawnSync(BASH, [launcher, "--data-root", workspace.dataDir], {
      encoding: "utf8",
      timeout: 60_000,
      input: "",
      // Only the stub directory and node's own: no engine of any kind.
      env: { ...process.env, PATH: workspace.binDir },
    });

    expect(run.status).not.toBe(0);
    expect(run.stdout).toMatch(/Neither docker nor podman answered/);
  });
});

describe("starting the console", () => {
  async function freePort() {
    return await new Promise((settle) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address();
        probe.close(() => settle(port));
      });
    });
  }

  it("publishes to host loopback and opens on the port it published", async () => {
    const workspace = makeWorkspace();
    stubUname(workspace, "Linux");
    installEngine(workspace, "docker");
    stageVerdict(workspace, 1, 0, ALL_OK);
    const launcher = stampedLauncher(workspace);
    const port = await freePort();

    const child = spawn(
      BASH,
      [
        launcher,
        "--data-root",
        workspace.dataDir,
        "--port",
        String(port),
        "--no-browser",
      ],
      { env: launcherEnvironment(workspace), detached: true },
    );

    let output = "";
    const ready = new Promise((settle, fail) => {
      const giveUp = setTimeout(() => fail(new Error(output)), 30_000);
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("The console is at")) {
          clearTimeout(giveUp);
          settle();
        }
      });
      child.on("exit", () => {
        clearTimeout(giveUp);
        fail(new Error(`the launcher exited early:\n${output}`));
      });
    });

    try {
      await ready;
    } finally {
      // The whole group: the stub holding the port is the launcher's own child.
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }

    expect(output).toContain(`The console is at http://127.0.0.1:${port}`);

    const serveRun = engineCalls(workspace)
      .split("\n")
      .find((line) => line.includes("serve"));
    // The publish binding is the console's whole reachability control, and --rm
    // is what makes "nothing persists between runs" true.
    expect(serveRun).toContain(`--publish 127.0.0.1:${port}:3000`);
    expect(serveRun).toContain("run --rm");
    expect(serveRun).toContain("--env JOB_DATA_ROOT=/data");
    expect(serveRun).toContain(`--volume ${workspace.dataDir}:/data`);
    // Running as the operator is what makes the mounted folder writable, and
    // the override is what gives the console somewhere it can still put a
    // pasted SFTP credential once it is no longer the image's own account.
    expect(serveRun).toContain(`--user ${OPERATOR_IDENTITY}`);
    expect(serveRun).toContain(
      "--env JOB_SFTP_CREDENTIAL_DIR=/tmp/psilink-sftp-credentials",
    );
    // With one folder for everything, the input and rendezvous directories are
    // left to fall back to JOB_DATA_ROOT rather than mounted a second time.
    expect(serveRun).not.toContain("JOB_INPUT_DIR");
    expect(serveRun).not.toContain("JOB_RENDEZVOUS_DIR");
    // The folder's own name still travels: the container sees only /data, which
    // is this launcher's name for it rather than the operator's.
    expect(serveRun).toContain(
      `--env JOB_RENDEZVOUS_NAME=${basename(workspace.dataDir)}`,
    );
  }, 45_000);
});
