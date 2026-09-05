import * as childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getLogger,
  joinErrorCauseChain,
  sanitizeErrorForDisplay,
} from "@psilink/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createOwnerOnlyWriteStream,
  detectFileConflicts,
  expandTilde,
  FileExistsError,
  warnIfFileOverPermissive,
  writeFileAtomic,
  writeFileOwnerOnly,
} from "../../src/fileUtils";

// Captures every execFileSync argument vector the extended-ACL strip
// (`/bin/chmod`) makes. `stubbed` answers without running it, for a host
// whose `chmod` rejects the macOS flags. `failure` throws that value only for
// the strip's own command line, so other commands (`whoami`, `icacls`,
// `ls -le`) still get real answers. Mocked rather than spied: a builtin
// module's ESM namespace is not configurable.
const execFile = vi.hoisted(() => ({
  commands: [] as string[][],
  stubbed: false,
  failure: undefined as unknown,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  // The strip's command line and no other: `/bin/chmod` with `-N` as the flag
  // immediately before the operand, which covers both postures (`-h -N path`
  // and `-N path`).
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

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-fileutils-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  execFile.commands.length = 0;
  execFile.stubbed = false;
  execFile.failure = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

// Drive the writer's first `fs.unlinkSync` (its stale-temp cleanup) and then,
// in the window before the writer creates the temp file, plant `target` as a
// symlink at `tmp` -- simulating an attacker who wins the unlink->create race.
// A symlink planted *before* the writer runs would just be removed by that same
// stale-temp unlink, so exercising the actual TOCTOU window is the only way a
// test distinguishes the hardened create from the old write-through.
function plantSymlinkInCreateWindow(tmp: string, target: string): void {
  const realUnlink = fs.unlinkSync.bind(fs);
  vi.spyOn(fs, "unlinkSync")
    .mockImplementationOnce((p) => {
      try {
        realUnlink(p);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      fs.symlinkSync(target, tmp);
    })
    .mockImplementation((p) => realUnlink(p));
}

// Spies on openSync/fsyncSync and the two commit steps (rename, link),
// recording the order of the durability fsyncs relative to the commit. Each
// fsync is mapped back to the path its fd was opened on, looked up at fsync
// time, so a fd number reused for the directory (the temp fd closes first)
// still resolves to its own target. Returns the event log; spies are
// restored in afterEach.
function recordDurabilitySyncs(): string[] {
  const fdPaths = new Map<number, string>();
  const events: string[] = [];
  const realOpen = fs.openSync;
  vi.spyOn(fs, "openSync").mockImplementation(
    (...args: Parameters<typeof fs.openSync>) => {
      const fd = realOpen(...args);
      fdPaths.set(fd, String(args[0]));
      return fd;
    },
  );
  const realFsync = fs.fsyncSync;
  vi.spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
    events.push(`fsync:${fdPaths.get(fd)}`);
    return realFsync(fd);
  });
  const realRename = fs.renameSync;
  vi.spyOn(fs, "renameSync").mockImplementation(
    (...args: Parameters<typeof fs.renameSync>) => {
      events.push("rename");
      return realRename(args[0], args[1]);
    },
  );
  const realLink = fs.linkSync;
  vi.spyOn(fs, "linkSync").mockImplementation(
    (...args: Parameters<typeof fs.linkSync>) => {
      events.push("link");
      return realLink(args[0], args[1]);
    },
  );
  return events;
}

// --- detectFileConflicts -----------------------------------------------------

describe("detectFileConflicts", () => {
  test("returns only the paths that already exist", () => {
    const existing = path.join(dir, "psilink.yaml");
    const missing = path.join(dir, ".psilink.key");
    fs.writeFileSync(existing, "channel: filedrop\n");
    expect(detectFileConflicts([existing, missing])).toEqual([existing]);
  });

  test("returns an empty array when nothing exists", () => {
    expect(
      detectFileConflicts([path.join(dir, "a"), path.join(dir, "b")]),
    ).toEqual([]);
  });

  test("reports a dangling symlink as a conflict", () => {
    // existsSync follows the link and would report this absent; lstatSync sees
    // the link itself, so the gate refuses rather than letting a write follow it.
    const link = path.join(dir, "dangling.yaml");
    fs.symlinkSync(path.join(dir, "no-such-target"), link);
    expect(detectFileConflicts([link])).toEqual([link]);
  });
});

// --- writeFileOwnerOnly ------------------------------------------------------

describe("writeFileOwnerOnly", () => {
  test("writes content and creates missing parent directories", () => {
    const p = path.join(dir, "nested", "deep", "secret");
    writeFileOwnerOnly(p, "x");
    expect(fs.readFileSync(p, "utf8")).toBe("x");
  });

  test("overwrites an existing file by default", () => {
    const p = path.join(dir, "secret");
    writeFileOwnerOnly(p, "first");
    writeFileOwnerOnly(p, "second");
    expect(fs.readFileSync(p, "utf8")).toBe("second");
  });

  test("with exclusive, creates a new file", () => {
    const p = path.join(dir, "secret");
    writeFileOwnerOnly(p, "only", { exclusive: true });
    expect(fs.readFileSync(p, "utf8")).toBe("only");
  });

  test("with exclusive, refuses to overwrite and preserves the original", () => {
    const p = path.join(dir, "secret");
    writeFileOwnerOnly(p, "original", { exclusive: true });
    expect(() => writeFileOwnerOnly(p, "clobber", { exclusive: true })).toThrow(
      FileExistsError,
    );
    expect(fs.readFileSync(p, "utf8")).toBe("original");
    // no stray temp file left behind
    expect(fs.readdirSync(dir).filter((n) => n.includes(".tmp."))).toEqual([]);
  });

  test.skipIf(process.platform === "win32")(
    "writes owner-only (0600) on POSIX",
    () => {
      const p = path.join(dir, "secret");
      writeFileOwnerOnly(p, "x");
      expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    },
  );

  test.skipIf(process.platform === "win32")(
    "does not write through a symlink pre-planted at the temp path",
    () => {
      // POSIX symlink-follow hardening; the Windows branch already creates its
      // placeholder with O_CREAT | O_EXCL. A symlink sitting at the temp path
      // before the writer runs is removed by the writer's stale-temp unlink, so
      // the secret lands in the destination, never the link's target.
      const dest = path.join(dir, "secret");
      const target = path.join(dir, "attacker-target");
      fs.writeFileSync(target, "original-target");
      const tmp = `${dest}.tmp.${process.pid}`;
      fs.symlinkSync(target, tmp);
      writeFileOwnerOnly(dest, "secret-content");
      expect(fs.readFileSync(target, "utf8")).toBe("original-target");
      expect(fs.readFileSync(dest, "utf8")).toBe("secret-content");
    },
  );

  test.skipIf(process.platform === "win32")(
    "refuses a symlink planted in the temp-path create window",
    () => {
      const dest = path.join(dir, "secret");
      const target = path.join(dir, "attacker-target");
      fs.writeFileSync(target, "original-target");
      const tmp = `${dest}.tmp.${process.pid}`;
      plantSymlinkInCreateWindow(tmp, target);
      // The exclusive, non-following create must refuse the planted link rather
      // than write the secret through to its target.
      expect(() => writeFileOwnerOnly(dest, "secret-content")).toThrow();
      expect(fs.readFileSync(target, "utf8")).toBe("original-target");
      expect(fs.existsSync(dest)).toBe(false);
      // the catch-path cleanup removes the planted link (not its target)
      expect(fs.existsSync(tmp)).toBe(false);
      expect(fs.existsSync(target)).toBe(true);
    },
  );

  test.skipIf(process.platform === "win32")(
    "fsyncs the temp file before the rename and the parent dir after it (POSIX)",
    () => {
      // The directory fsync opens a directory handle, which Node's fs cannot do on
      // Windows; the directory-flush path is POSIX-only by design.
      const dest = path.join(dir, "secret");
      const tmp = `${dest}.tmp.${process.pid}`;
      const events = recordDurabilitySyncs();

      writeFileOwnerOnly(dest, "x");

      // data flushed before the rename, the directory entry flushed after it
      expect(events).toEqual([`fsync:${tmp}`, "rename", `fsync:${dir}`]);
      expect(fs.readFileSync(dest, "utf8")).toBe("x");
      // exercising the durability syncs leaves no orphaned temp file
      expect(fs.readdirSync(dir).filter((n) => n.includes(".tmp."))).toEqual(
        [],
      );
    },
  );

  test.skipIf(process.platform === "win32")(
    "with exclusive, fsyncs the temp file before the link and the parent dir after it (POSIX)",
    () => {
      const dest = path.join(dir, "secret");
      const tmp = `${dest}.tmp.${process.pid}`;
      const events = recordDurabilitySyncs();

      writeFileOwnerOnly(dest, "only", { exclusive: true });

      // the exclusive create-if-absent (linkSync) gets the same fsync bracketing
      expect(events).toEqual([`fsync:${tmp}`, "link", `fsync:${dir}`]);
      expect(fs.readFileSync(dest, "utf8")).toBe("only");
      expect(fs.readdirSync(dir).filter((n) => n.includes(".tmp."))).toEqual(
        [],
      );
    },
  );
});

// --- writeFileAtomic ---------------------------------------------------------

describe("writeFileAtomic", () => {
  test("writes content and creates missing parent directories", () => {
    const p = path.join(dir, "nested", "deep", "cert.json");
    writeFileAtomic(p, "x");
    expect(fs.readFileSync(p, "utf8")).toBe("x");
  });

  test("overwrites an existing file", () => {
    const p = path.join(dir, "cert.json");
    writeFileAtomic(p, "first");
    writeFileAtomic(p, "second");
    expect(fs.readFileSync(p, "utf8")).toBe("second");
  });

  test.skipIf(process.platform === "win32")(
    "writes world-readable (0644) by default on POSIX",
    () => {
      const p = path.join(dir, "cert.json");
      writeFileAtomic(p, "x");
      expect(fs.statSync(p).mode & 0o777).toBe(0o644);
    },
  );

  test.skipIf(process.platform === "win32")(
    "honors an explicit mode and leaves no temp file behind",
    () => {
      const p = path.join(dir, "cert.json");
      writeFileAtomic(p, "x", 0o600);
      expect(fs.statSync(p).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(dir).filter((n) => n.includes(".tmp."))).toEqual(
        [],
      );
    },
  );

  test.skipIf(process.platform === "win32")(
    "does not write through a symlink pre-planted at the temp path",
    () => {
      // POSIX symlink-follow hardening, mirroring writeFileOwnerOnly.
      const dest = path.join(dir, "cert.json");
      const target = path.join(dir, "attacker-target");
      fs.writeFileSync(target, "original-target");
      const tmp = `${dest}.tmp.${process.pid}`;
      fs.symlinkSync(target, tmp);
      writeFileAtomic(dest, "public-content");
      expect(fs.readFileSync(target, "utf8")).toBe("original-target");
      expect(fs.readFileSync(dest, "utf8")).toBe("public-content");
    },
  );

  test.skipIf(process.platform === "win32")(
    "refuses a symlink planted in the temp-path create window",
    () => {
      const dest = path.join(dir, "cert.json");
      const target = path.join(dir, "attacker-target");
      fs.writeFileSync(target, "original-target");
      const tmp = `${dest}.tmp.${process.pid}`;
      plantSymlinkInCreateWindow(tmp, target);
      expect(() => writeFileAtomic(dest, "public-content")).toThrow();
      expect(fs.readFileSync(target, "utf8")).toBe("original-target");
      expect(fs.existsSync(dest)).toBe(false);
      // the catch-path cleanup removes the planted link (not its target)
      expect(fs.existsSync(tmp)).toBe(false);
      expect(fs.existsSync(target)).toBe(true);
    },
  );

  test.skipIf(process.platform === "win32")(
    "fsyncs the temp file before the rename and the parent dir after it (POSIX)",
    () => {
      // Durability parity with writeFileOwnerOnly, via the shared fsyncParentDir.
      const dest = path.join(dir, "cert.json");
      const tmp = `${dest}.tmp.${process.pid}`;
      const events = recordDurabilitySyncs();

      writeFileAtomic(dest, "x");

      expect(events).toEqual([`fsync:${tmp}`, "rename", `fsync:${dir}`]);
      expect(fs.readFileSync(dest, "utf8")).toBe("x");
      expect(fs.readdirSync(dir).filter((n) => n.includes(".tmp."))).toEqual(
        [],
      );
    },
  );
});

// --- createOwnerOnlyWriteStream ----------------------------------------------

// Write `text` through the stream and resolve once it is fully flushed and
// closed. createOwnerOnlyWriteStream returns the raw stream to its caller, so the
// test drives the write/close lifecycle explicitly before stat'ing the file.
function writeAndClose(stream: fs.WriteStream, text: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    stream.on("error", reject);
    stream.on("close", () => resolve());
    stream.write(text);
    stream.close();
  });
}

describe("createOwnerOnlyWriteStream", () => {
  test.skipIf(process.platform === "win32")(
    "creates the file owner-only (0600) regardless of umask (POSIX)",
    async () => {
      // The fchmod forces exactly 0600 whatever the process umask, including the
      // 0o022 under which the prior unprotected createWriteStream left it 0644.
      for (const umask of [0o022, 0o077, 0o000]) {
        const prev = process.umask(umask);
        try {
          const p = path.join(dir, `out-${umask.toString(8)}.csv`);
          await writeAndClose(createOwnerOnlyWriteStream(p), "a,b\n1,2\n");
          expect(fs.statSync(p).mode & 0o777).toBe(0o600);
          expect(fs.readFileSync(p, "utf8")).toBe("a,b\n1,2\n");
        } finally {
          process.umask(prev);
        }
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "tightens a pre-existing world/group-readable file to 0600 (POSIX)",
    async () => {
      const p = path.join(dir, "stale.csv");
      fs.writeFileSync(p, "stale,data\n");
      // writeFileSync's mode is umask-masked; force 0644 so the test starts from an
      // over-permissive file the writer must tighten.
      fs.chmodSync(p, 0o644);
      expect(fs.statSync(p).mode & 0o777).toBe(0o644);

      await writeAndClose(createOwnerOnlyWriteStream(p), "fresh,data\n");

      expect(fs.statSync(p).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(p, "utf8")).toBe("fresh,data\n");
    },
  );

  test.skipIf(process.platform === "win32")(
    "preserves an existing file's content when the mode cannot be secured (POSIX)",
    () => {
      // Simulates fchmod failing as it would on a file owned by another user
      // (EPERM): the writer must refuse rather than leave PII at relaxed
      // permissions, and -- because it opens without O_TRUNC -- must not have
      // emptied the existing file before that failure.
      const p = path.join(dir, "foreign.csv");
      fs.writeFileSync(p, "original,content\n");
      vi.spyOn(fs, "fchmodSync").mockImplementation(() => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      });

      expect(() => createOwnerOnlyWriteStream(p)).toThrow("EPERM");

      expect(fs.readFileSync(p, "utf8")).toBe("original,content\n");
    },
  );

  test.skipIf(process.platform === "win32")(
    "closes the descriptor if truncation fails rather than leaking it (POSIX)",
    () => {
      // fchmod succeeds but the truncate (which runs before createWriteStream takes
      // ownership of the fd) fails: the writer must close the open descriptor on the
      // way out rather than leak it.
      const p = path.join(dir, "trunc-fail.csv");
      let openedFd: number | undefined;
      const realOpen = fs.openSync;
      const openSpy = vi
        .spyOn(fs, "openSync")
        .mockImplementation((...args: Parameters<typeof fs.openSync>) => {
          openedFd = realOpen(...args);
          return openedFd;
        });
      const closeSpy = vi.spyOn(fs, "closeSync");
      vi.spyOn(fs, "ftruncateSync").mockImplementation(() => {
        throw Object.assign(new Error("EINVAL"), { code: "EINVAL" });
      });

      expect(() => createOwnerOnlyWriteStream(p)).toThrow("EINVAL");

      // The failing path opens exactly one descriptor, so `openedFd` is
      // unambiguous; that exact fd is the one closed, not leaked. The
      // called-once assertion pins the single-open assumption: were a second open
      // ever added before the truncate, this would catch the now-ambiguous capture.
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(openedFd).toBeDefined();
      expect(closeSpy).toHaveBeenCalledWith(openedFd);
    },
  );
});

// --- macOS extended ACL ------------------------------------------------------

// The extended-ACL entries `ls -le` prints under a file's mode line, each
// numbered ("0: group:everyone allow read"). An empty array means the file
// has no extended ACL at all, which is what the writers must produce.
function readExtendedAcl(filePath: string): string[] {
  const output = childProcess.execFileSync("/bin/ls", ["-le", filePath], {
    encoding: "utf8",
  });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+:\s/.test(line));
}

describe.skipIf(process.platform !== "darwin")("macOS extended ACL", () => {
  // A directory whose inheritable `everyone allow read` ACE every file created
  // inside it picks up -- the configuration that leaves a 0600 artifact
  // readable by another principal on macOS.
  function makeAclInheritingDir(name: string): string {
    const aclDir = path.join(dir, name);
    fs.mkdirSync(aclDir);
    childProcess.execFileSync(
      "/bin/chmod",
      ["+a", "everyone allow read,file_inherit", aclDir],
      { stdio: "ignore" },
    );
    return aclDir;
  }

  test("each writer clears an inherited non-owner ACE", async () => {
    const aclDir = makeAclInheritingDir("inheriting");

    // Pin the gap the writers close: a plain 0600 write into this directory
    // inherits the ACE, so the assertions below are about the strip and not
    // about a directory that failed to hand its ACE down.
    const control = path.join(aclDir, "control");
    fs.writeFileSync(control, "x", { mode: 0o600 });
    fs.chmodSync(control, 0o600);
    expect(readExtendedAcl(control)).not.toEqual([]);
    expect(fs.statSync(control).mode & 0o777).toBe(0o600);

    const secret = path.join(aclDir, "secret");
    writeFileOwnerOnly(secret, "x");
    expect(readExtendedAcl(secret)).toEqual([]);
    expect(fs.statSync(secret).mode & 0o777).toBe(0o600);

    const exclusive = path.join(aclDir, "exclusive");
    writeFileOwnerOnly(exclusive, "x", { exclusive: true });
    expect(readExtendedAcl(exclusive)).toEqual([]);
    expect(fs.statSync(exclusive).mode & 0o777).toBe(0o600);

    const atomic = path.join(aclDir, "atomic");
    writeFileAtomic(atomic, "x", 0o600);
    expect(readExtendedAcl(atomic)).toEqual([]);
    expect(fs.statSync(atomic).mode & 0o777).toBe(0o600);

    // writeFileAtomic strips at its public default mode too: an inherited ACE
    // can grant write, which 0644 withholds from everyone but the owner.
    const shared = path.join(aclDir, "cert.json");
    writeFileAtomic(shared, "x");
    expect(readExtendedAcl(shared)).toEqual([]);
    expect(fs.statSync(shared).mode & 0o777).toBe(0o644);

    const streamed = path.join(aclDir, "streamed.csv");
    await writeAndClose(createOwnerOnlyWriteStream(streamed), "a,b\n1,2\n");
    expect(readExtendedAcl(streamed)).toEqual([]);
    expect(fs.statSync(streamed).mode & 0o777).toBe(0o600);
  });

  test("the streaming writer clears an ACE already on the destination", async () => {
    // The stream writes the destination in place rather than renaming a fresh
    // temp inode over it, so a foreign ACE left on a pre-existing file is the
    // case the strip has to reach.
    const p = path.join(dir, "stale.csv");
    fs.writeFileSync(p, "stale,data\n");
    childProcess.execFileSync("/bin/chmod", ["+a", "everyone allow read", p], {
      stdio: "ignore",
    });
    expect(readExtendedAcl(p)).not.toEqual([]);

    await writeAndClose(createOwnerOnlyWriteStream(p), "fresh,data\n");

    expect(readExtendedAcl(p)).toEqual([]);
    expect(fs.readFileSync(p, "utf8")).toBe("fresh,data\n");
  });

  test("the streaming writer clears the ACE on a symlinked destination's target", async () => {
    // An operator-supplied output path may be a symlink, and the stream follows
    // it by design (no O_NOFOLLOW, fchmod on the descriptor), so the rows
    // land in the link's target and the ACE that has to go is the target's --
    // the strip acting on the link node instead would report success while the
    // real file stayed readable by the inherited principal.
    const targetDir = makeAclInheritingDir("stream-target");
    const target = path.join(targetDir, "real-result.csv");
    fs.writeFileSync(target, "stale,data\n", { mode: 0o600 });
    expect(readExtendedAcl(target)).not.toEqual([]);

    const link = path.join(dir, "result.csv");
    fs.symlinkSync(target, link);

    await writeAndClose(createOwnerOnlyWriteStream(link), "fresh,data\n");

    expect(readExtendedAcl(target)).toEqual([]);
    expect(fs.readFileSync(target, "utf8")).toBe("fresh,data\n");
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    // The write goes through the link rather than replacing it.
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe(target);
  });
});

// --- extended-ACL strip: platform gate and fail-closed ------------------------

// Run `body` with `process.platform` reporting `platform`. The strip is the
// only platform-gated step these tests exercise, and the POSIX write path is
// otherwise identical on darwin and linux, so this makes the darwin branch
// reachable on any POSIX host. Restores the real descriptor afterwards.
function withPlatform<T>(platform: string, body: () => T): T {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  if (real === undefined) throw new Error("process.platform is not defined");
  Object.defineProperty(process, "platform", {
    ...real,
    value: platform,
  });
  try {
    return body();
  } finally {
    Object.defineProperty(process, "platform", real);
  }
}

// This flag is true only where the darwin strip branch can be exercised as a
// failure: GNU `chmod` rejects `-N`, or a host without `/bin/chmod` fails to
// spawn it -- either way a failed strip, the fail-closed contract under test.
// Skipped on a real darwin host (the strip would succeed) and on Windows
// (writers take the icacls branch; `fs.constants` has no `O_NOFOLLOW` for the
// POSIX branch the stub would otherwise force them into).
const stripFailsHere =
  process.platform !== "darwin" && process.platform !== "win32";

const stripFailureOnly = test.skipIf(!stripFailsHere);

// Either refusal the strip raises, since which one a host produces depends on
// how its `chmod` fails: GNU `chmod` runs and exits nonzero on `-N`, which is
// the ACL-remedy message, while a host with no `/bin/chmod` fails the spawn and
// gets the could-not-run one. The tests below are about what each writer leaves
// on disk, not about which refusal it throws -- that split is pinned, against
// failures captured from the runtime, in the reporting suite further down.
const STRIP_REFUSAL =
  /Could not (clear extended ACLs|run the extended-ACL strip) on /;

// Run `body` and hand back whatever it threw. `expect(...).toThrow` matches only
// the message, so a test that asserts on the `cause` a refusal holds needs the
// thrown value itself.
function catchThrown(body: () => unknown): unknown {
  try {
    body();
  } catch (thrown) {
    return thrown;
  }
  throw new Error("expected the call to throw");
}

// The three fields the refusal message reads across, widened past
// `ErrnoException` because Node declares neither the exit status nor the
// termination signal on the error it throws.
type CapturedExecFileFailure = NodeJS.ErrnoException & {
  status?: number | null;
  signal?: NodeJS.Signals | null;
};

// What `execFileSync` really throws for `run`, captured from the runtime rather
// than hand-built: the refusal message keys on the shape Node produces -- a
// numeric `status` for a child that ran to completion, a termination signal for
// one that died on a kill, a spawn errno and neither of those for one that never
// ran -- so the shapes under test have to be Node's own rather than this file's
// model of them.
function capturedExecFileFailure(run: () => void): CapturedExecFileFailure {
  try {
    run();
  } catch (thrown) {
    return thrown as CapturedExecFileFailure;
  }
  throw new Error("expected the command to fail");
}

// A real run of the strip's own command line that fails by exiting nonzero: the
// operand names a file that is not there, which no chmod build can act on. This
// is the shape a macOS `chmod -N` produces when it cannot clear the ACL -- the
// one case where the ACL itself is the obstacle -- and because the command line
// is the strip's, it is also the text an operator reads off the rendered cause.
function capturedChmodRefusal(
  operand: string = path.join(dir, "absent"),
): CapturedExecFileFailure {
  return capturedExecFileFailure(() =>
    childProcess.execFileSync("/bin/chmod", ["-h", "-N", operand], {
      stdio: "ignore",
    }),
  );
}

// Arm the recorder so the strip's `execFileSync` throws `failure` instead of
// running, putting a writer in front of that exact failure on any host. Every
// other command still runs for real.
function failAclStripWith(failure: unknown): void {
  execFile.commands.length = 0;
  execFile.failure = failure;
}

describe("extended-ACL strip failure", () => {
  stripFailureOnly(
    "writeFileOwnerOnly writes nothing and leaves no temp file",
    () => {
      const dest = path.join(dir, "secret");
      withPlatform("darwin", () => {
        expect(() => writeFileOwnerOnly(dest, "secret-content")).toThrow(
          STRIP_REFUSAL,
        );
      });
      expect(fs.existsSync(dest)).toBe(false);
      expect(fs.readdirSync(dir).filter((n) => n.includes(".tmp."))).toEqual(
        [],
      );
    },
  );

  stripFailureOnly(
    "writeFileOwnerOnly leaves an existing destination untouched",
    () => {
      const dest = path.join(dir, "secret");
      writeFileOwnerOnly(dest, "original");
      withPlatform("darwin", () => {
        expect(() => writeFileOwnerOnly(dest, "rotated")).toThrow(
          STRIP_REFUSAL,
        );
      });
      expect(fs.readFileSync(dest, "utf8")).toBe("original");
      expect(fs.readdirSync(dir).filter((n) => n.includes(".tmp."))).toEqual(
        [],
      );
    },
  );

  stripFailureOnly(
    "writeFileOwnerOnly with exclusive writes nothing and leaves no temp file",
    () => {
      // exclusive's final step is linkSync rather than renameSync (the
      // signing-identity path), but the strip runs on the temp file before
      // either commit step, so the failure has to close this out the same way.
      const dest = path.join(dir, "identity");
      withPlatform("darwin", () => {
        expect(() =>
          writeFileOwnerOnly(dest, "identity-content", { exclusive: true }),
        ).toThrow(STRIP_REFUSAL);
      });
      expect(fs.existsSync(dest)).toBe(false);
      expect(fs.readdirSync(dir).filter((n) => n.includes(".tmp."))).toEqual(
        [],
      );
    },
  );

  stripFailureOnly(
    "writeFileAtomic writes nothing and leaves no temp file",
    () => {
      const dest = path.join(dir, "cert.json");
      withPlatform("darwin", () => {
        expect(() => writeFileAtomic(dest, "x")).toThrow(STRIP_REFUSAL);
      });
      expect(fs.existsSync(dest)).toBe(false);
      expect(fs.readdirSync(dir).filter((n) => n.includes(".tmp."))).toEqual(
        [],
      );
    },
  );

  stripFailureOnly(
    "createOwnerOnlyWriteStream refuses before truncating an existing file",
    () => {
      const p = path.join(dir, "result.csv");
      fs.writeFileSync(p, "original,content\n");
      withPlatform("darwin", () => {
        expect(() => createOwnerOnlyWriteStream(p)).toThrow(STRIP_REFUSAL);
      });
      // The strip runs before the truncate, so the operator's existing rows
      // survive a refusal rather than being emptied by a write that never landed.
      expect(fs.readFileSync(p, "utf8")).toBe("original,content\n");
    },
  );

  test.skipIf(process.platform === "win32")(
    "createOwnerOnlyWriteStream leaves a destination it created empty and owner-only",
    () => {
      // The open creates the destination before the strip runs, so a refusal
      // leaves it in place rather than deleting it -- an empty, already owner-only
      // file, mirroring the Windows placeholder. Driven from a captured failure so
      // the shape is testable on macOS too, where a real strip would succeed.
      const p = path.join(dir, "new-result.csv");
      failAclStripWith(capturedChmodRefusal());
      withPlatform("darwin", () => {
        expect(() => createOwnerOnlyWriteStream(p)).toThrow(STRIP_REFUSAL);
      });
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.readFileSync(p, "utf8")).toBe("");
      expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    },
  );

  stripFailureOnly(
    "the same writes succeed on the host's real platform",
    async () => {
      // The gate is what separates this from the refusals above: the same
      // writers on the same host, differing only in what process.platform
      // reports. On Linux -- the production/Docker target -- no strip is
      // attempted and every writer completes.
      const secret = path.join(dir, "secret");
      writeFileOwnerOnly(secret, "x");
      expect(fs.readFileSync(secret, "utf8")).toBe("x");

      const cert = path.join(dir, "cert.json");
      writeFileAtomic(cert, "x");
      expect(fs.readFileSync(cert, "utf8")).toBe("x");

      const csv = path.join(dir, "result.csv");
      await writeAndClose(createOwnerOnlyWriteStream(csv), "a,b\n1,2\n");
      expect(fs.readFileSync(csv, "utf8")).toBe("a,b\n1,2\n");
    },
  );
});

// --- extended-ACL strip: failure reporting -----------------------------------

// A refusal must say which of two things went wrong: a spawned `chmod` that
// may have started clearing the ACL (the case `ls -le` and `chmod -N`
// address), or a strip that never ran at all -- no `/bin/chmod`, a refused
// exec, a removed working directory -- where that remedy does not apply.
// Every failure below is captured from the runtime, not modeled.
describe("extended-ACL strip failure reporting", () => {
  test.skipIf(process.platform === "win32")(
    "a chmod that ran and refused keeps the ACL remedy and holds its cause",
    () => {
      const refused = capturedChmodRefusal();
      // The discriminant: a child that ran to completion reports its exit status.
      expect(typeof refused.status).toBe("number");
      failAclStripWith(refused);
      const dest = path.join(dir, "secret");

      const thrown = catchThrown(() =>
        withPlatform("darwin", () => writeFileOwnerOnly(dest, "x")),
      ) as Error;

      expect(thrown.message).toMatch(/^Could not clear extended ACLs on /);
      expect(thrown.message).toContain(dest);
      expect(thrown.message).toContain("ls -le");
      expect(thrown.message).toContain("chmod -N");
      expect(thrown.cause).toBe(refused);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a strip that never ran is reported apart from an ACL that resisted clearing",
    () => {
      const unexecutable = path.join(dir, "not-executable");
      fs.writeFileSync(unexecutable, "", { mode: 0o600 });
      const failures = {
        "missing binary": capturedExecFileFailure(() =>
          childProcess.execFileSync(path.join(dir, "no-such-chmod"), [], {
            stdio: "ignore",
          }),
        ),
        "exec the OS refused": capturedExecFileFailure(() =>
          childProcess.execFileSync(unexecutable, [], { stdio: "ignore" }),
        ),
      };
      // Each arrives with its own errno and no exit status, which is what the
      // refusal reads: the two stay distinguishable to an operator through the
      // cause, without the message having to enumerate them.
      expect(
        new Set(Object.values(failures).map((failure) => failure.code)).size,
      ).toBe(2);

      for (const [label, failure] of Object.entries(failures)) {
        expect(failure.status ?? null).toBeNull();
        expect(failure.signal ?? null).toBeNull();
        failAclStripWith(failure);
        const dest = path.join(dir, `secret-${label.replace(/\s+/g, "-")}`);

        const thrown = catchThrown(() =>
          withPlatform("darwin", () => writeFileOwnerOnly(dest, "x")),
        ) as Error;

        expect(thrown.message).toMatch(
          /^Could not run the extended-ACL strip on /,
        );
        expect(thrown.message).toContain(dest);
        expect(thrown.message).not.toContain("chmod -N");
        expect(thrown.cause).toBe(failure);
        expect(fs.existsSync(dest)).toBe(false);
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "both timeout shapes keep the ACL remedy and leave the write refused",
    () => {
      // The 5 s timeout kills a spawned child; `chmod -N` may already have altered
      // an existing destination's ACL, so this is the case the operator most wants
      // `ls -le` and `chmod -N` for. Node reports the kill in two shapes, both read
      // as a `chmod` that ran: one dies on the signal (a termination signal, no
      // exit status); one ignores `SIGTERM` and exits normally (a status, even `0`,
      // and no signal). A strip that never ran has neither field.
      const shapes = {
        "died on the signal": {
          binary: "/bin/sleep",
          failure: capturedExecFileFailure(() =>
            childProcess.execFileSync("/bin/sleep", ["5"], {
              stdio: "ignore",
              timeout: 50,
            }),
          ),
        },
        "outlived the kill": {
          binary: "/bin/sh",
          failure: capturedExecFileFailure(() =>
            childProcess.execFileSync(
              "/bin/sh",
              ["-c", "trap '' TERM; sleep 1"],
              {
                stdio: "ignore",
                timeout: 100,
              },
            ),
          ),
        },
      };
      expect(shapes["died on the signal"].failure.status ?? null).toBeNull();
      expect(typeof shapes["died on the signal"].failure.signal).toBe("string");
      // The shape the classification turns on: a status of zero is still a status,
      // so a `chmod` that outlasted the kill must not read as one that never ran.
      expect(shapes["outlived the kill"].failure.status).toBe(0);
      expect(shapes["outlived the kill"].failure.signal ?? null).toBeNull();

      for (const [label, { binary, failure }] of Object.entries(shapes)) {
        expect(failure.code).toBe("ETIMEDOUT");
        failAclStripWith(failure);
        const dest = path.join(dir, `secret-${label.replace(/\s+/g, "-")}`);

        const thrown = catchThrown(() =>
          withPlatform("darwin", () => writeFileOwnerOnly(dest, "x")),
        ) as Error;

        expect(thrown.message).toMatch(/^Could not clear extended ACLs on /);
        expect(thrown.message).toContain(dest);
        expect(thrown.message).toContain("ls -le");
        expect(thrown.cause).toBe(failure);
        // A timeout's cause is Node's spawn-failure text, which names the binary
        // and no operand -- so unlike the completed-child refusal below, this
        // route discloses no path beyond the destination the message already
        // names. The binary is the captured failure's own, standing in for
        // `/bin/chmod` on a host whose `chmod` cannot be made to hang.
        expect(sanitizeErrorForDisplay(thrown)).toBe(
          joinErrorCauseChain([
            thrown.message,
            `spawnSync ${binary} ETIMEDOUT`,
          ]),
        );
        // The pointer is about an ACL that may be half-cleared, not about content:
        // the write is refused outright, leaving the destination absent and no
        // temp file behind, the same on-disk state every other refusal leaves.
        expect(fs.existsSync(dest)).toBe(false);
        expect(fs.readdirSync(dir).filter((n) => n.includes(".tmp."))).toEqual(
          [],
        );
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "a working directory removed underfoot refuses rather than raising a bare errno",
    () => {
      // `process.cwd()` throws once the working directory is gone, but only after
      // a `chdir` invalidates Node's cached value -- so the removal has to land
      // after the chdir and before the strip, where the stream writer's fchmod
      // sits. The `uv_cwd` assertion proves that window was hit; a still-warm cache
      // would have let the strip run and the cause would be a `chmod` failure
      // instead.
      const gone = path.join(dir, "gone");
      fs.mkdirSync(gone);
      const realFchmod = fs.fchmodSync.bind(fs);
      vi.spyOn(fs, "fchmodSync").mockImplementationOnce((fd, mode) => {
        realFchmod(fd, mode);
        fs.rmSync(gone, { recursive: true });
      });
      const previousCwd = process.cwd();
      let thrown: unknown;
      process.chdir(gone);
      try {
        thrown = catchThrown(() =>
          withPlatform("darwin", () =>
            createOwnerOnlyWriteStream("result.csv"),
          ),
        );
      } finally {
        process.chdir(previousCwd);
      }

      expect((thrown as Error).message).toBe(
        "Could not run the extended-ACL strip on result.csv; no content was written",
      );
      expect((thrown as Error).cause).toBeDefined();
      expect(((thrown as Error).cause as NodeJS.ErrnoException).syscall).toBe(
        "uv_cwd",
      );
    },
  );

  test.skipIf(process.platform === "win32")(
    "the rendered refusal shows the failed command line, temp path included",
    () => {
      // What the operator actually reads: the refusal, then the failure it holds
      // as its `cause` rendered as the display sink's own chain link. That second
      // line is `execFileSync`'s command line, so it discloses the temp path the
      // writer strips -- the destination plus this process's pid -- which is the
      // one operator-visible detail the cause adds beyond the errno.
      const dest = path.join(dir, "secret");
      const temp = `${dest}.tmp.${process.pid}`;
      const refused = capturedChmodRefusal(temp);
      failAclStripWith(refused);

      const thrown = catchThrown(() =>
        withPlatform("darwin", () => writeFileOwnerOnly(dest, "x")),
      );

      expect(sanitizeErrorForDisplay(thrown)).toBe(
        joinErrorCauseChain([
          `Could not clear extended ACLs on ${dest}; inspect them with ` +
            "`ls -le` and clear them manually with `chmod -N`",
          `Command failed: /bin/chmod -h -N ${temp}`,
        ]),
      );
    },
  );
});

// --- extended-ACL strip: symlink posture -------------------------------------

// Arm the `execFileSync` recorder declared at the top of this file and hand back
// the (empty) log the writers append to. macOS symlink-and-ACL semantics cannot
// be observed on another host, but which entry each writer aims its strip at is
// a property of the command line, so this pins it anywhere: without it, only a
// macOS host with a planted symlink separates a strip on a link node from one on
// its target.
function recordAclStripCommands(): string[][] {
  execFile.commands.length = 0;
  execFile.stubbed = true;
  return execFile.commands;
}

describe("extended-ACL strip symlink posture", () => {
  test.skipIf(process.platform === "win32")(
    "the temp-file writers strip the temp path without following a symlink",
    () => {
      // -h keeps the strip on the named entry: the temp path is psilink's own and
      // a symlink at it is an attacker's, so following one would aim the strip at
      // another file's ACL while the content went to the temp file.
      const commands = recordAclStripCommands();
      const secret = path.join(dir, "secret");
      const cert = path.join(dir, "cert.json");

      withPlatform("darwin", () => {
        writeFileOwnerOnly(secret, "x");
        writeFileAtomic(cert, "x");
      });

      expect(commands).toEqual([
        ["/bin/chmod", "-h", "-N", `${secret}.tmp.${process.pid}`],
        ["/bin/chmod", "-h", "-N", `${cert}.tmp.${process.pid}`],
      ]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "the streaming writer strips the destination through a symlink",
    async () => {
      // No -h: destPath is an operator-supplied path the open and the fchmod both
      // resolve, so the strip has to resolve it too or it clears the ACL of a link
      // node while the rows land in a target whose ACEs still stand.
      const commands = recordAclStripCommands();
      const dest = path.join(dir, "result.csv");

      const stream = withPlatform("darwin", () =>
        createOwnerOnlyWriteStream(dest),
      );

      expect(commands).toEqual([["/bin/chmod", "-N", dest]]);
      await writeAndClose(stream, "a,b\n1,2\n");
    },
  );

  test.skipIf(process.platform === "win32")(
    "absolutizes a relative dash-leading destination for the chmod operand",
    () => {
      // No `--` separator exists to keep a dash-leading operand out of the option
      // position (see the comment on stripExtendedAcls); absolutizing the operand
      // is what guarantees that instead, on a relative path too.
      const commands = recordAclStripCommands();
      const cwd = process.cwd();
      process.chdir(dir);
      let expected: string;
      try {
        // Built from the working directory the writer itself prefixes, which the
        // kernel reports canonicalized: under a symlinked TMPDIR (macOS's
        // /var -> /private/var) it is not the mkdtemp path this test holds.
        expected = `${process.cwd()}/-dashed-secret.tmp.${process.pid}`;
        withPlatform("darwin", () => {
          writeFileOwnerOnly("-dashed-secret", "x");
        });
      } finally {
        process.chdir(cwd);
      }

      expect(commands).toHaveLength(1);
      const operand = commands[0][commands[0].length - 1];
      expect(operand.startsWith("/")).toBe(true);
      expect(operand).toBe(expected);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a working directory of `/` leaves the operand one leading separator",
    () => {
      // The root is the one working directory that already ends in a separator, so
      // the plain prefix would emit `//name` -- a leading `//` POSIX leaves to the
      // implementation. The prefix drops the root's own separator instead, and
      // nothing else about the operand changes: the rest of the path is still the
      // writer's own bytes.
      const commands = recordAclStripCommands();
      // Relative to the root, so the kernel resolves it back into this test's
      // directory while the writer sees a path it has to absolutize.
      const relative = `${path.relative("/", dir)}/rooted-secret`;
      const cwd = process.cwd();
      process.chdir("/");
      try {
        withPlatform("darwin", () => writeFileOwnerOnly(relative, "x"));
      } finally {
        process.chdir(cwd);
      }

      expect(commands).toEqual([
        ["/bin/chmod", "-h", "-N", `/${relative}.tmp.${process.pid}`],
      ]);
      expect(fs.readFileSync(path.join(dir, "rooted-secret"), "utf8")).toBe(
        "x",
      );
    },
  );

  test.skipIf(process.platform === "win32")(
    "an absolute destination strips with the working directory removed",
    async () => {
      // An absolute path is already the operand, so nothing about it needs the
      // working directory -- and a strip that reached for one anyway would refuse
      // every write on a host whose working directory has been removed, since
      // `process.cwd()` throws there once a `chdir` has invalidated Node's cached
      // value. The removal lands in the stream writer's fchmod, the step before
      // the strip -- the same window the relative-path refusal above is driven
      // through, so the two differ only in whether the path needed a prefix.
      const commands = recordAclStripCommands();
      const gone = path.join(dir, "gone");
      fs.mkdirSync(gone);
      const dest = path.join(dir, "result.csv");
      const realFchmod = fs.fchmodSync.bind(fs);
      vi.spyOn(fs, "fchmodSync").mockImplementationOnce((fd, mode) => {
        realFchmod(fd, mode);
        fs.rmSync(gone, { recursive: true });
      });
      const previousCwd = process.cwd();
      let stream: fs.WriteStream;
      process.chdir(gone);
      try {
        stream = withPlatform("darwin", () => createOwnerOnlyWriteStream(dest));
      } finally {
        process.chdir(previousCwd);
      }

      expect(commands).toEqual([["/bin/chmod", "-N", dest]]);
      await writeAndClose(stream, "a,b\n1,2\n");
      expect(fs.readFileSync(dest, "utf8")).toBe("a,b\n1,2\n");
    },
  );

  test.skipIf(process.platform === "win32")(
    "an operand keeps a `..` segment that only the kernel can resolve",
    async () => {
      // `out/link` is a symlink to a sibling directory, so `out/link/../x` names
      // dir/x to the kernel and dir/out/x to any lexical collapse of the `..`.
      // Each writer's own open takes the kernel's answer, so its strip has to aim
      // at the same file: the operand holds the `link/..` segment verbatim rather
      // than being normalized or realpath'd on the way to chmod.
      const commands = recordAclStripCommands();
      fs.mkdirSync(path.join(dir, "out"));
      fs.mkdirSync(path.join(dir, "elsewhere"));
      fs.symlinkSync(
        path.join(dir, "elsewhere"),
        path.join(dir, "out", "link"),
      );
      const streamed = `${dir}/out/link/../result.csv`;
      const secret = `${dir}/out/link/../secret`;

      const stream = withPlatform("darwin", () =>
        createOwnerOnlyWriteStream(streamed),
      );
      await writeAndClose(stream, "a,b\n1,2\n");
      withPlatform("darwin", () => writeFileOwnerOnly(secret, "x"));

      expect(commands).toEqual([
        ["/bin/chmod", "-N", streamed],
        ["/bin/chmod", "-h", "-N", `${secret}.tmp.${process.pid}`],
      ]);
      // Both writes landed where the kernel resolves their paths, and nothing
      // landed at the lexically collapsed one.
      expect(fs.readFileSync(path.join(dir, "result.csv"), "utf8")).toBe(
        "a,b\n1,2\n",
      );
      expect(fs.readFileSync(path.join(dir, "secret"), "utf8")).toBe("x");
      expect(fs.readdirSync(path.join(dir, "out"))).toEqual(["link"]);
      // The streamed operand still names the file the rows went into; the temp
      // writer's operand named a temp file the rename has since consumed.
      const operand = commands[0][commands[0].length - 1];
      expect(fs.statSync(operand).ino).toBe(
        fs.statSync(path.join(dir, "result.csv")).ino,
      );
    },
  );
});

// --- Windows owner-only ACL --------------------------------------------------

// The current user's domain-qualified name (DOMAIN\user), the principal the
// writers grant Modify and the only non-inherited ACE a narrowed file may have.
function currentWindowsUser(): string {
  return childProcess.execFileSync("whoami", [], { encoding: "utf8" }).trim();
}

// One parsed line of `icacls <file>` output: the principal and the raw flag/
// rights token after the `:(` separator (e.g. "(I)(M)" or "(R)"). The first
// line of icacls output echoes the path before the first ACE; the trailing
// "Successfully processed" summary line has no `:(` and is skipped.
type Ace = { principal: string; rights: string };

function readAcl(filePath: string): Ace[] {
  const output = childProcess.execFileSync("icacls", [filePath], {
    encoding: "utf8",
  });
  const echoed = filePath.replace(/\//g, "\\");
  const aces: Ace[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    let line = rawLine;
    if (line.startsWith(echoed)) line = line.slice(echoed.length).trimStart();
    const trimmed = line.trim();
    const sep = trimmed.indexOf(":(");
    if (sep === -1) continue;
    aces.push({
      principal: trimmed.slice(0, sep).trim(),
      rights: trimmed.slice(sep + 1),
    });
  }
  return aces;
}

// True when the file's ACL grants only the current user, with no inherited (I)
// ACE and no other explicit principal -- the owner-only state the writers must
// produce. Deny ACEs are restrictive and ignored.
function isOwnerOnly(filePath: string, owner: string): boolean {
  const aces = readAcl(filePath);
  if (aces.length === 0) return false;
  return aces.every((ace) => {
    if (ace.rights.includes("(DENY)")) return true;
    if (ace.rights.includes("(I)")) return false;
    return ace.principal.toLowerCase() === owner.toLowerCase();
  });
}

describe.skipIf(process.platform !== "win32")("Windows owner-only ACL", () => {
  test("each owner-only writer grants Modify to the current user only", async () => {
    const owner = currentWindowsUser();

    const secret = path.join(dir, "secret");
    writeFileOwnerOnly(secret, "x");
    expect(isOwnerOnly(secret, owner)).toBe(true);
    expect(readAcl(secret).some((a) => a.rights.includes("(M)"))).toBe(true);

    const atomic = path.join(dir, "atomic");
    writeFileAtomic(atomic, "x", 0o600);
    expect(isOwnerOnly(atomic, owner)).toBe(true);

    const streamed = path.join(dir, "streamed.csv");
    await writeAndClose(createOwnerOnlyWriteStream(streamed), "a,b\n1,2\n");
    expect(isOwnerOnly(streamed, owner)).toBe(true);
    expect(readAcl(streamed).some((a) => a.rights.includes("(M)"))).toBe(true);
  });

  test("createOwnerOnlyWriteStream overwrite drops a foreign explicit ACE", async () => {
    const owner = currentWindowsUser();
    const p = path.join(dir, "result.csv");

    // Seed a pre-existing file holding a foreign principal's explicit
    // (non-inherited) grant, the ACE an in-place narrow would miss.
    fs.writeFileSync(p, "stale\n");
    childProcess.execFileSync("icacls", [p, "/grant", "Guests:(R)"], {
      stdio: "ignore",
    });
    expect(
      readAcl(p).some((a) => a.principal.toLowerCase().includes("guests")),
    ).toBe(true);

    await writeAndClose(createOwnerOnlyWriteStream(p), "fresh\n");

    // The fresh-inode recreation must have dropped the Guests ACE.
    expect(
      readAcl(p).some((a) => a.principal.toLowerCase().includes("guests")),
    ).toBe(false);
    expect(isOwnerOnly(p, owner)).toBe(true);
  });

  test("the load-time check warns on a loosened ACL and stays quiet on an owner-only file", () => {
    const p = path.join(dir, "secret");
    writeFileOwnerOnly(p, "x");

    const log = getLogger("file-utils");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    // A correctly-narrowed file must not warn.
    warnIfFileOverPermissive(p, "shared secret");
    expect(warn).not.toHaveBeenCalled();

    // Grant a foreign principal read, defeating owner-only; the next load warns.
    childProcess.execFileSync("icacls", [p, "/grant", "Guests:(R)"], {
      stdio: "ignore",
    });
    warnIfFileOverPermissive(p, "shared secret");
    expect(warn).toHaveBeenCalled();
  });
});

// --- expandTilde -------------------------------------------------------------

describe("expandTilde", () => {
  const home = os.homedir();

  test("expands a bare ~ to the home directory", () => {
    expect(expandTilde("~")).toBe(home);
  });

  test("expands a leading ~/ to a path under home", () => {
    expect(expandTilde("~/.psilink/signing-identity.json")).toBe(
      path.join(home, ".psilink/signing-identity.json"),
    );
  });

  test("leaves an absolute path unchanged", () => {
    expect(expandTilde("/etc/psilink/id.json")).toBe("/etc/psilink/id.json");
  });

  test("leaves a relative path unchanged", () => {
    expect(expandTilde("./id.json")).toBe("./id.json");
  });

  test("does not expand another user's home (~user)", () => {
    expect(expandTilde("~other/id.json")).toBe("~other/id.json");
  });

  test("does not expand an embedded ~", () => {
    expect(expandTilde("/a/~/b")).toBe("/a/~/b");
  });

  test("passes undefined through (for optional path options)", () => {
    expect(expandTilde(undefined)).toBeUndefined();
  });
});
