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

import { configureLogFile } from "../../../src/util/logging";
import { runProbe } from "../../../src/doctor/probe";
import type { ProbeDeps } from "../../../src/doctor/probe";
import type { CommandResult } from "../../../src/doctor/runner";
import type { SmbProbeInput } from "../../../src/doctor/smbEnvironment";
import { snapshotDiagnosticSinkAndLevel } from "../../loggingTestSupport";

// The two hosts nothing can stand in for: on macOS the strip really runs and
// really succeeds, and on a POSIX host that is not macOS it is never attempted
// at all. Every other case below reaches its branch through `withPlatform`.
const macOnly = test.skipIf(process.platform !== "darwin");
const plainPosixOnly = test.skipIf(
  process.platform === "darwin" || process.platform === "win32",
);

// The owner-only artifacts written outside `fileUtils`' shared writers: the
// `--log-file` descriptor, opened append and stripped in place, and the
// doctor's smbclient credentials file, routed through `writeFileOwnerOnly`
// into a `mkdtemp` work directory the doctor strips itself at creation. Each
// site here must reach the strip and refuse rather than leave a log line or a
// password under an extended ACL it could not clear.

// The strip shells out to `/bin/chmod`, so which entry a site aims it at lives
// in the command line and nowhere else. This records every `execFileSync`
// argument vector; while `stubbed` is set it answers the call instead of
// running it, so a command-line assertion holds on a host whose `chmod`
// rejects the macOS flags. With `failure` set it throws that value instead of
// running the strip, and `failOperand` narrows the throw to one of the strips
// a single run makes -- scoped to that strip's own command line, so every
// other command still runs for real.
const execFile = vi.hoisted(() => ({
  commands: [] as string[][],
  stubbed: false,
  failure: undefined as unknown,
  failOperand: undefined as RegExp | undefined,
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
      if (
        execFile.failure !== undefined &&
        isAclStrip(file, args) &&
        (execFile.failOperand === undefined ||
          execFile.failOperand.test(args[args.length - 1]))
      )
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
  execFile.failOperand = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

// The extended-ACL entries `ls -lde` prints under a mode line, each numbered
// ("0: group:everyone allow read"). An empty array means the entry has no
// extended ACL at all, which is what each site must produce. `-d` keeps a
// directory operand listed as itself rather than by its contents, and changes
// nothing for a file.
function readExtendedAcl(targetPath: string): string[] {
  const output = childProcess.execFileSync("/bin/ls", ["-lde", targetPath], {
    encoding: "utf8",
  });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+:\s/.test(line));
}

// A directory whose inheritable `everyone allow read` ACE every file created
// inside it picks up -- the configuration that leaves a 0600 artifact readable
// by another principal on macOS. `directory_inherit` passes the ACE down to a
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
// on. `args` has the flags of the site under test, so the command line an
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
// `onlyOperand` restricts that to the strips whose operand matches it, which is
// how a site that strips twice is put in front of a refusal of the second one:
// the strips it spares are then answered rather than run, since a host whose
// `chmod` has no `-N` would otherwise refuse the first.
function failAclStripWith(failure: unknown, onlyOperand?: RegExp): void {
  execFile.commands.length = 0;
  execFile.failure = failure;
  execFile.failOperand = onlyOperand;
  execFile.stubbed = onlyOperand !== undefined;
}

// Arm the recorder and hand back the (empty) log the sites append to.
function recordAclStripCommands(): string[][] {
  execFile.commands.length = 0;
  execFile.stubbed = true;
  return execFile.commands;
}

// Run `body` and hand back whatever it threw: `expect(...).toThrow` matches only
// the message, and these tests assert on the cause chain a refusal has.
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
 * called with the credentials path on every invocation that has one, while
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
  macOnly("a log file created under an inheriting directory has no ACE", () => {
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

  macOnly(
    "an ACE already on an existing log file is cleared before a line is appended",
    () => {
      // The log is opened in place rather than renamed over from a fresh inode, so
      // an ACE sitting on the file the operator named is the case the strip has to
      // reach -- and the run is about to append partner identity to it.
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
    },
  );

  test.skipIf(process.platform === "win32")(
    "the strip follows a symlink at the log path, as the open does",
    () => {
      // No -h: the path is an operator-supplied flag value the open resolves, so
      // acting on the link node would clear an ACL that governs nothing while the
      // lines landed in a target whose ACEs still stood.
      const commands = recordAclStripCommands();
      const logPath = path.join(dir, "posture.log");

      const sink = withPlatform("darwin", () => configureLogFile(logPath));
      sink.close();

      expect(commands).toEqual([["/bin/chmod", "-N", logPath]]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a refused strip writes no line and leaves the diagnostic sink alone",
    () => {
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
    },
  );

  test.skipIf(process.platform === "win32")(
    "a refused strip leaves an existing log file's content untouched",
    () => {
      const logPath = path.join(dir, "kept.log");
      fs.writeFileSync(logPath, "PRE-EXISTING LINE\n", { mode: 0o600 });
      failAclStripWith(capturedChmodRefusal(["-N", path.join(dir, "absent")]));

      expect(() =>
        withPlatform("darwin", () => configureLogFile(logPath)),
      ).toThrow(/could not secure log file/);

      expect(fs.readFileSync(logPath, "utf8")).toBe("PRE-EXISTING LINE\n");
    },
  );

  test.skipIf(process.platform === "win32")(
    "a refused strip closes the descriptor the open took",
    () => {
      // The open owns a descriptor the refusal has to release: nothing else can,
      // since no sink was installed to close later.
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
    },
  );

  plainPosixOnly("no strip is attempted on the host's real platform", () => {
    // The gate is what separates the refusals above from an ordinary run: the
    // same call on the same host, differing only in what process.platform
    // reports. On Linux -- the production/Docker target -- the log file opens
    // and logging proceeds.
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

// Watch for the `mkdtemp` directory the doctor holds its credentials file in,
// which the run removes on its way out: this is the only handle a test has on
// the path after the fact.
function recordDoctorWorkDir(): { path?: string } {
  const seen: { path?: string } = {};
  const realMkdtemp = fs.mkdtempSync;
  vi.spyOn(fs, "mkdtempSync").mockImplementation(
    (...args: Parameters<typeof fs.mkdtempSync>) => {
      const made = realMkdtemp(...args) as string;
      if (path.basename(made).startsWith("psilink-doctor-")) seen.path = made;
      return made;
    },
  );
  return seen;
}

describe("the doctor credentials directory's and file's extended ACL", () => {
  macOnly(
    "nothing under an inheriting TMPDIR has an ACE: not the work directory, the credentials file, or a file created beside it",
    async () => {
      // The credentials directory is `mkdtemp`'d under the operator's TMPDIR, so
      // an inheritable ACE there sits on the directory itself and reaches the
      // password file through it.
      const tmpRoot = makeAclInheritingDir("doctor-tmp");
      // Pin both inheritances the strip has to close, so the assertions below
      // are about the strip and not about a TMPDIR that failed to hand its ACE
      // down: a directory created under this root has the ACE, and so does a
      // file created inside that directory.
      const controlDir = path.join(tmpRoot, "control-dir");
      fs.mkdirSync(controlDir);
      const controlFile = path.join(controlDir, "control");
      fs.writeFileSync(controlFile, "x", { mode: 0o600 });
      expect(readExtendedAcl(controlDir)).not.toEqual([]);
      expect(readExtendedAcl(controlFile)).not.toEqual([]);

      const previousTmpdir = process.env.TMPDIR;
      process.env.TMPDIR = tmpRoot;
      let workDirAcl: string[] | undefined;
      let createdInsideAcl: string[] | undefined;
      let acl: string[] | undefined;
      let mode: number | undefined;
      try {
        await runProbe(
          INPUT,
          probeDeps((authFile) => {
            if (acl !== undefined) return;
            const workDir = path.dirname(authFile);
            // A plain create in the stripped directory, which is how the run
            // makes its own write probe and marker file in here: an ACE
            // reaching this one would reach those too.
            const createdInside = path.join(workDir, "created-inside");
            fs.writeFileSync(createdInside, "x", { mode: 0o600 });
            workDirAcl = readExtendedAcl(workDir);
            createdInsideAcl = readExtendedAcl(createdInside);
            acl = readExtendedAcl(authFile);
            mode = fs.statSync(authFile).mode & 0o777;
          }),
        );
      } finally {
        if (previousTmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmpdir;
      }

      expect(workDirAcl).toEqual([]);
      expect(createdInsideAcl).toEqual([]);
      expect(acl).toEqual([]);
      expect(mode).toBe(0o600);
    },
  );

  test.skipIf(process.platform === "win32")(
    "the work directory is stripped before the credentials file exists, and the password through the owner-only writer's temp path",
    async () => {
      // Two strips in the order the run makes them: the directory at `mkdtemp`,
      // before anything is created in it, and then the writer's own on psilink's
      // temp path, before the password is written -- the writer strips between its
      // fchmod and its write. Both have -h: each entry is one psilink created
      // itself, so a symlink at it is a plant, and following it would clear an
      // unrelated ACL while the password landed under one that still stood.
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
        ["/bin/chmod", "-h", "-N", path.dirname(authFile as string)],
        ["/bin/chmod", "-h", "-N", `${authFile}.tmp.${process.pid}`],
      ]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a refused directory strip removes the directory before a password is composed",
    async () => {
      failAclStripWith(
        capturedChmodRefusal(["-h", "-N", path.join(dir, "absent")]),
      );
      const workDir = recordDoctorWorkDir();
      let authFileSeen = false;

      const thrown = await withPlatformAsync("darwin", () =>
        runProbe(
          INPUT,
          probeDeps(() => {
            authFileSeen = true;
          }),
        ),
      ).catch((err: unknown) => err);

      expect(workDir.path).toBeDefined();
      // The refusal names the operator's temp root rather than the removed work
      // directory: that is where the inheritable ACE lives, and the mkdtemp path
      // is already gone by the time the message would be read. The strip's own
      // operand is still the work directory, asserted below.
      expect(sanitizeErrorForDisplay(thrown)).toBe(
        joinErrorCauseChain([
          `Could not clear extended ACLs on ${os.tmpdir()}; inspect ` +
            "them with `ls -le` and clear them manually with `chmod -N`",
          `Command failed: /bin/chmod -h -N ${path.join(dir, "absent")}`,
        ]),
      );
      expect(execFile.commands).toEqual([
        ["/bin/chmod", "-h", "-N", workDir.path as string],
      ]);
      expect(authFileSeen).toBe(false);
      expect(fs.existsSync(workDir.path as string)).toBe(false);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a refused credentials-file strip writes no password and removes the work directory",
    async () => {
      failAclStripWith(
        capturedChmodRefusal(["-h", "-N", path.join(dir, "absent")]),
        /\.tmp\.\d+$/,
      );
      const workDir = recordDoctorWorkDir();
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
      expect(workDir.path).toBeDefined();
      expect(fs.existsSync(workDir.path as string)).toBe(false);
    },
  );
});
