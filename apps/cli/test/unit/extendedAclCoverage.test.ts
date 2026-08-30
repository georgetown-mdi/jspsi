import * as childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import logLibrary from "loglevel";
import {
  getDiagnosticSink,
  getLogger,
  joinErrorCauseChain,
  sanitizeErrorForDisplay,
  UsageError,
} from "@psilink/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { configureLogFile } from "../../src/util/cli";
import { runProbe } from "../../src/doctor/probe";
import type { ProbeDeps } from "../../src/doctor/probe";
import type { CommandResult } from "../../src/doctor/runner";
import type { SmbProbeInput } from "../../src/doctor/smbEnvironment";
import { snapshotDiagnosticSinkAndLevel } from "../loggingTestSupport";

// The two owner-only artifacts written outside `fileUtils`' shared writers: the
// `--log-file` descriptor, opened append and stripped in place, and the doctor's
// smbclient credentials file, routed through `writeFileOwnerOnly`. The writers'
// own coverage is in fileUtils.test.ts; what these tests hold is that each of
// these two sites reaches the strip, aims it at the entry its own write reached,
// and refuses rather than putting a log line or a password into a file whose
// extended ACL it could not clear.

// The strip shells out to `/bin/chmod`, so which entry a site aims it at lives
// in the command line and nowhere else. This records every `execFileSync`
// argument vector; while `stubbed` is set it answers the call instead of running
// it, so a command-line assertion holds on a host whose `chmod` rejects the macOS
// flags. With `failure` set it throws that value instead of running the strip,
// which is how a test puts a failure -- captured from the runtime, never
// hand-built -- in front of a site on any host. That throw is scoped to the
// strip's own command line, so every other command still runs for real.
const execFile = vi.hoisted(() => ({
  commands: [] as string[][],
  stubbed: false,
  failure: undefined as unknown,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const isAclStrip = (file: string, args: readonly string[]) =>
    file === "/bin/chmod" && args.length >= 2 && args[args.length - 2] === "-N";
  return {
    ...actual,
    execFileSync: (
      file: string,
      args: readonly string[],
      options?: Parameters<typeof actual.execFileSync>[2],
    ) => {
      execFile.commands.push([file, ...args]);
      if (execFile.failure !== undefined && isAclStrip(file, args))
        throw execFile.failure;
      return execFile.stubbed ? "" : actual.execFileSync(file, args, options);
    },
  };
});

const PASSWORD = "correct horse battery";

const INPUT: SmbProbeInput = {
  server: "files.example.org",
  share: "exchange",
  subdirectory: "dropbox",
  username: "svc-psilink",
  domain: "AGENCY",
  password: PASSWORD,
  dialect: "",
  marker: "psilink-check.txt",
  token: "abc123",
};

let dir: string;

snapshotDiagnosticSinkAndLevel();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-acl-sites-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  execFile.commands.length = 0;
  execFile.stubbed = false;
  execFile.failure = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

// The extended-ACL entries `ls -le` prints under a file's mode line, each
// numbered ("0: group:everyone allow read"). An empty array means the file
// carries no extended ACL at all, which is what each site must produce.
function readExtendedAcl(filePath: string): string[] {
  const output = childProcess.execFileSync("/bin/ls", ["-le", filePath], {
    encoding: "utf8",
  });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+:\s/.test(line));
}

// A directory whose inheritable `everyone allow read` ACE every file created
// inside it picks up -- the configuration that leaves a 0600 artifact readable
// by another principal on macOS. `directory_inherit` carries the ACE down to a
// subdirectory too, which is what a `mkdtemp` directory under the operator's
// TMPDIR is.
function makeAclInheritingDir(name: string): string {
  const aclDir = path.join(dir, name);
  fs.mkdirSync(aclDir);
  childProcess.execFileSync(
    "/bin/chmod",
    ["+a", "everyone allow read,file_inherit,directory_inherit", aclDir],
    { stdio: "ignore" },
  );
  return aclDir;
}

// Run `body` with `process.platform` reporting `platform`, restoring the real
// descriptor afterwards. The strip is the only platform-gated step these sites
// take, and their write paths are otherwise identical on darwin and linux, so
// this makes the darwin branch reachable on any POSIX host.
function withPlatform<T>(platform: string, body: () => T): T {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  if (real === undefined) throw new Error("process.platform is not defined");
  Object.defineProperty(process, "platform", { ...real, value: platform });
  try {
    return body();
  } finally {
    Object.defineProperty(process, "platform", real);
  }
}

// The same for a site reached through `await`: the doctor's credentials write
// sits several awaits into `runProbe`, so the patch has to span the whole run
// rather than one synchronous call.
async function withPlatformAsync<T>(
  platform: string,
  body: () => Promise<T>,
): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  if (real === undefined) throw new Error("process.platform is not defined");
  Object.defineProperty(process, "platform", { ...real, value: platform });
  try {
    return await body();
  } finally {
    Object.defineProperty(process, "platform", real);
  }
}

// A real run of the strip's own command line that fails by exiting nonzero, so
// the failure a site is put in front of is the shape Node produces rather than
// this file's model of it. The operand is absent, which no chmod build can act
// on. `args` carries the flags of the site under test, so the command line an
// operator reads off the rendered cause is that site's own.
function capturedChmodRefusal(args: string[]): NodeJS.ErrnoException {
  try {
    childProcess.execFileSync("/bin/chmod", args, { stdio: "ignore" });
  } catch (thrown) {
    return thrown as NodeJS.ErrnoException;
  }
  throw new Error("expected the command to fail");
}

// Arm the recorder so the strip's `execFileSync` throws `failure` instead of
// running, putting a site in front of that exact failure on any host.
function failAclStripWith(failure: unknown): void {
  execFile.commands.length = 0;
  execFile.failure = failure;
}

// Arm the recorder and hand back the (empty) log the sites append to.
function recordAclStripCommands(): string[][] {
  execFile.commands.length = 0;
  execFile.stubbed = true;
  return execFile.commands;
}

// Run `body` and hand back whatever it threw: `expect(...).toThrow` matches only
// the message, and these tests assert on the cause chain a refusal carries.
function catchThrown(body: () => unknown): unknown {
  try {
    body();
  } catch (thrown) {
    return thrown;
  }
  throw new Error("expected the call to throw");
}

/**
 * A doctor run whose `smbclient` answers come from a stub. `onAuthFile` is
 * called with the credentials path on every invocation that carries one, while
 * the file is still on disk -- the run removes it before returning, so that is
 * the only window it can be inspected from.
 */
function probeDeps(onAuthFile?: (authFile: string) => void): ProbeDeps {
  return {
    lookupHost: () => Promise.resolve("10.10.0.5"),
    connectTcp: () => Promise.resolve(true),
    runner: {
      run(_file, args): Promise<CommandResult> {
        const index = args.indexOf("-A");
        if (index !== -1 && onAuthFile !== undefined)
          onAuthFile(args[index + 1]);
        return Promise.resolve({
          code: 0,
          output: args.includes("--version") ? "Version 4.19.5" : "",
          timedOut: false,
        });
      },
    },
  };
}

describe("the log file's extended ACL", () => {
  test("a log file created under an inheriting directory carries no ACE", () => {
    if (process.platform !== "darwin") return;
    const aclDir = makeAclInheritingDir("log-dir");

    // Pin the gap the strip closes: a plain 0600 create in this directory
    // inherits the ACE, so the assertion below is about the strip and not about
    // a directory that failed to hand its ACE down.
    const control = path.join(aclDir, "control.log");
    fs.closeSync(fs.openSync(control, "a", 0o600));
    expect(readExtendedAcl(control)).not.toEqual([]);

    const logPath = path.join(aclDir, "run.log");
    const sink = configureLogFile(logPath);
    logLibrary.setDefaultLevel(logLibrary.levels.INFO);
    getLogger("acl-sites-created").info("partner identity line");
    sink.close();

    expect(readExtendedAcl(logPath)).toEqual([]);
    expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(logPath, "utf8")).toContain("partner identity line");
  });

  test("an ACE already on an existing log file is cleared before a line is appended", () => {
    // The log is opened in place rather than renamed over from a fresh inode, so
    // an ACE sitting on the file the operator named is the case the strip has to
    // reach -- and the run is about to append partner identity to it.
    if (process.platform !== "darwin") return;
    const logPath = path.join(dir, "existing.log");
    fs.writeFileSync(logPath, "PRE-EXISTING LINE\n", { mode: 0o600 });
    childProcess.execFileSync(
      "/bin/chmod",
      ["+a", "everyone allow read", logPath],
      { stdio: "ignore" },
    );
    expect(readExtendedAcl(logPath)).not.toEqual([]);

    const sink = configureLogFile(logPath);
    logLibrary.setDefaultLevel(logLibrary.levels.INFO);
    getLogger("acl-sites-existing").info("appended line");
    sink.close();

    expect(readExtendedAcl(logPath)).toEqual([]);
    const contents = fs.readFileSync(logPath, "utf8");
    expect(contents).toContain("PRE-EXISTING LINE");
    expect(contents).toContain("appended line");
  });

  test("the strip follows a symlink at the log path, as the open does", () => {
    // No -h: the path is an operator-supplied flag value the open resolves, so
    // acting on the link node would clear an ACL that governs nothing while the
    // lines landed in a target whose ACEs still stood.
    if (process.platform === "win32") return;
    const commands = recordAclStripCommands();
    const logPath = path.join(dir, "posture.log");

    const sink = withPlatform("darwin", () => configureLogFile(logPath));
    sink.close();

    expect(commands).toEqual([["/bin/chmod", "-N", logPath]]);
  });

  test("a refused strip writes no line and leaves the diagnostic sink alone", () => {
    if (process.platform === "win32") return;
    const logPath = path.join(dir, "refused.log");
    const sinkBefore = getDiagnosticSink();
    failAclStripWith(capturedChmodRefusal(["-N", logPath]));

    const thrown = catchThrown(() =>
      withPlatform("darwin", () => configureLogFile(logPath)),
    );

    expect(thrown).toBeInstanceOf(UsageError);
    // The refusal is reported through configureLogFile's own usage boundary, and
    // what an operator reads under it is the strip's refusal and the command line
    // that failed.
    expect(sanitizeErrorForDisplay(thrown)).toBe(
      joinErrorCauseChain([
        `could not secure log file ${logPath}`,
        `Could not clear extended ACLs on ${logPath}; inspect them with ` +
          "`ls -le` and clear them manually with `chmod -N`",
        `Command failed: /bin/chmod -N ${logPath}`,
      ]),
    );
    // The open created the file before the strip ran, so the refusal cannot
    // leave it absent -- it leaves it empty and already owner-only, mirroring
    // the streaming writer's placeholder. Nothing was logged into it, because
    // the sink is installed only after the strip succeeds.
    expect(fs.readFileSync(logPath, "utf8")).toBe("");
    expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
    expect(getDiagnosticSink()).toBe(sinkBefore);
  });

  test("a refused strip leaves an existing log file's content untouched", () => {
    if (process.platform === "win32") return;
    const logPath = path.join(dir, "kept.log");
    fs.writeFileSync(logPath, "PRE-EXISTING LINE\n", { mode: 0o600 });
    failAclStripWith(capturedChmodRefusal(["-N", path.join(dir, "absent")]));

    expect(() =>
      withPlatform("darwin", () => configureLogFile(logPath)),
    ).toThrow(/could not secure log file/);

    expect(fs.readFileSync(logPath, "utf8")).toBe("PRE-EXISTING LINE\n");
  });

  test("a refused strip closes the descriptor the open took", () => {
    // The open owns a descriptor the refusal has to release: nothing else can,
    // since no sink was installed to close later.
    if (process.platform === "win32") return;
    const logPath = path.join(dir, "fd.log");
    failAclStripWith(capturedChmodRefusal(["-N", logPath]));
    let openedFd: number | undefined;
    const realOpen = fs.openSync;
    const openSpy = vi
      .spyOn(fs, "openSync")
      .mockImplementation((...args: Parameters<typeof fs.openSync>) => {
        openedFd = realOpen(...args);
        return openedFd;
      });
    const closeSpy = vi.spyOn(fs, "closeSync");

    expect(() =>
      withPlatform("darwin", () => configureLogFile(logPath)),
    ).toThrow(UsageError);

    // The refusing path opens exactly one descriptor, so `openedFd` is
    // unambiguous; that exact fd is the one closed, not leaked.
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openedFd).toBeDefined();
    expect(closeSpy).toHaveBeenCalledWith(openedFd);
  });

  test("no strip is attempted on the host's real platform", () => {
    // The gate is what separates the refusals above from an ordinary run: the
    // same call on the same host, differing only in what process.platform
    // reports. On Linux -- the production/Docker target -- the log file opens
    // and logging proceeds.
    if (process.platform === "darwin" || process.platform === "win32") return;
    const commands = recordAclStripCommands();
    const logPath = path.join(dir, "linux.log");

    const sink = configureLogFile(logPath);
    logLibrary.setDefaultLevel(logLibrary.levels.INFO);
    getLogger("acl-sites-gate").info("a line");
    sink.close();

    expect(commands).toEqual([]);
    expect(fs.readFileSync(logPath, "utf8")).toContain("a line");
  });
});

describe("the doctor credentials file's extended ACL", () => {
  test("the credentials file carries no ACE under an inheriting TMPDIR", async () => {
    // The credentials directory is `mkdtemp`'d under the operator's TMPDIR, so
    // an inheritable ACE there reaches the password file through it.
    if (process.platform !== "darwin") return;
    const tmpRoot = makeAclInheritingDir("doctor-tmp");
    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = tmpRoot;
    let acl: string[] | undefined;
    let controlAcl: string[] | undefined;
    let mode: number | undefined;
    try {
      await runProbe(
        INPUT,
        probeDeps((authFile) => {
          if (acl !== undefined) return;
          // A plain create beside it pins that the directory really does hand
          // its ACE down, so the assertion below is about the strip.
          const control = path.join(path.dirname(authFile), "control");
          fs.writeFileSync(control, "x", { mode: 0o600 });
          controlAcl = readExtendedAcl(control);
          acl = readExtendedAcl(authFile);
          mode = fs.statSync(authFile).mode & 0o777;
        }),
      );
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
    }

    expect(controlAcl).not.toEqual([]);
    expect(acl).toEqual([]);
    expect(mode).toBe(0o600);
  });

  test("the password goes through the owner-only writer's temp path and strip", async () => {
    // The credentials file is written through `writeFileOwnerOnly`, so the strip
    // lands on psilink's own temp path with -h -- following a symlink planted
    // there would clear another file's ACL while the password went to the temp
    // file -- and it runs before the password is written, since the writer
    // strips between its fchmod and its write.
    if (process.platform === "win32") return;
    const commands = recordAclStripCommands();
    let authFile: string | undefined;

    await withPlatformAsync("darwin", () =>
      runProbe(
        INPUT,
        probeDeps((seen) => {
          authFile ??= seen;
        }),
      ),
    );

    expect(authFile).toBeDefined();
    expect(commands).toEqual([
      ["/bin/chmod", "-h", "-N", `${authFile}.tmp.${process.pid}`],
    ]);
  });

  test("a refused strip writes no password and removes the work directory", async () => {
    if (process.platform === "win32") return;
    failAclStripWith(
      capturedChmodRefusal(["-h", "-N", path.join(dir, "absent")]),
    );
    let workDir: string | undefined;
    const realMkdtemp = fs.mkdtempSync;
    vi.spyOn(fs, "mkdtempSync").mockImplementation(
      (...args: Parameters<typeof fs.mkdtempSync>) => {
        const made = realMkdtemp(...args) as string;
        if (path.basename(made).startsWith("psilink-doctor-")) workDir = made;
        return made;
      },
    );
    let authFileSeen = false;

    await expect(
      withPlatformAsync("darwin", () =>
        runProbe(
          INPUT,
          probeDeps(() => {
            authFileSeen = true;
          }),
        ),
      ),
    ).rejects.toThrow(/Could not clear extended ACLs on /);

    // The refusal lands before the first invocation that would have read the
    // credentials file, and takes the whole directory with it, so no password
    // reached the disk the run leaves behind.
    expect(authFileSeen).toBe(false);
    expect(workDir).toBeDefined();
    expect(fs.existsSync(workDir as string)).toBe(false);
  });
});
