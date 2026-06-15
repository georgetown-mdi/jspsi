import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createOwnerOnlyWriteStream,
  detectFileConflicts,
  expandTilde,
  FileExistsError,
  writeFileAtomic,
  writeFileOwnerOnly,
} from "../../src/fileUtils";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-fileutils-"));
});

afterEach(() => {
  vi.restoreAllMocks();
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

// Spy on openSync/fsyncSync and both commit steps (rename and link), recording
// the order of the durability fsyncs relative to the commit. Each fsync is
// mapped back to the path its fd was opened on: the path is stored when the fd
// is opened and looked up at fsync time, so a reused fd number -- the temp fd is
// closed before the directory is opened, so the OS may hand the directory the
// same number -- still resolves to its real target (the second open overwrites
// the map entry). Returns the event log the caller asserts on; spies are
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

  test("writes owner-only (0600) on POSIX", () => {
    if (process.platform === "win32") return;
    const p = path.join(dir, "secret");
    writeFileOwnerOnly(p, "x");
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });

  test("does not write through a symlink pre-planted at the temp path", () => {
    // POSIX symlink-follow hardening; the Windows branch already creates its
    // placeholder with O_CREAT | O_EXCL. A symlink sitting at the temp path
    // before the writer runs is removed by the writer's stale-temp unlink, so
    // the secret lands in the destination, never the link's target.
    if (process.platform === "win32") return;
    const dest = path.join(dir, "secret");
    const target = path.join(dir, "attacker-target");
    fs.writeFileSync(target, "original-target");
    const tmp = `${dest}.tmp.${process.pid}`;
    fs.symlinkSync(target, tmp);
    writeFileOwnerOnly(dest, "secret-content");
    expect(fs.readFileSync(target, "utf8")).toBe("original-target");
    expect(fs.readFileSync(dest, "utf8")).toBe("secret-content");
  });

  test("refuses a symlink planted in the temp-path create window", () => {
    if (process.platform === "win32") return;
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
  });

  test("fsyncs the temp file before the rename and the parent dir after it (POSIX)", () => {
    // The directory fsync opens a directory handle, which Node's fs cannot do on
    // Windows; the directory-flush path is POSIX-only by design.
    if (process.platform === "win32") return;
    const dest = path.join(dir, "secret");
    const tmp = `${dest}.tmp.${process.pid}`;
    const events = recordDurabilitySyncs();

    writeFileOwnerOnly(dest, "x");

    // data flushed before the rename, the directory entry flushed after it
    expect(events).toEqual([`fsync:${tmp}`, "rename", `fsync:${dir}`]);
    expect(fs.readFileSync(dest, "utf8")).toBe("x");
    // exercising the durability syncs leaves no orphaned temp file
    expect(fs.readdirSync(dir).filter((n) => n.includes(".tmp."))).toEqual([]);
  });

  test("with exclusive, fsyncs the temp file before the link and the parent dir after it (POSIX)", () => {
    if (process.platform === "win32") return;
    const dest = path.join(dir, "secret");
    const tmp = `${dest}.tmp.${process.pid}`;
    const events = recordDurabilitySyncs();

    writeFileOwnerOnly(dest, "only", { exclusive: true });

    // the exclusive create-if-absent (linkSync) gets the same fsync bracketing
    expect(events).toEqual([`fsync:${tmp}`, "link", `fsync:${dir}`]);
    expect(fs.readFileSync(dest, "utf8")).toBe("only");
    expect(fs.readdirSync(dir).filter((n) => n.includes(".tmp."))).toEqual([]);
  });
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

  test("writes world-readable (0644) by default on POSIX", () => {
    if (process.platform === "win32") return;
    const p = path.join(dir, "cert.json");
    writeFileAtomic(p, "x");
    expect(fs.statSync(p).mode & 0o777).toBe(0o644);
  });

  test("honors an explicit mode and leaves no temp file behind", () => {
    if (process.platform === "win32") return;
    const p = path.join(dir, "cert.json");
    writeFileAtomic(p, "x", 0o600);
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir).filter((n) => n.includes(".tmp."))).toEqual([]);
  });

  test("does not write through a symlink pre-planted at the temp path", () => {
    // POSIX symlink-follow hardening, mirroring writeFileOwnerOnly.
    if (process.platform === "win32") return;
    const dest = path.join(dir, "cert.json");
    const target = path.join(dir, "attacker-target");
    fs.writeFileSync(target, "original-target");
    const tmp = `${dest}.tmp.${process.pid}`;
    fs.symlinkSync(target, tmp);
    writeFileAtomic(dest, "public-content");
    expect(fs.readFileSync(target, "utf8")).toBe("original-target");
    expect(fs.readFileSync(dest, "utf8")).toBe("public-content");
  });

  test("refuses a symlink planted in the temp-path create window", () => {
    if (process.platform === "win32") return;
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
  });

  test("fsyncs the temp file before the rename and the parent dir after it (POSIX)", () => {
    // Durability parity with writeFileOwnerOnly, via the shared fsyncParentDir.
    if (process.platform === "win32") return;
    const dest = path.join(dir, "cert.json");
    const tmp = `${dest}.tmp.${process.pid}`;
    const events = recordDurabilitySyncs();

    writeFileAtomic(dest, "x");

    expect(events).toEqual([`fsync:${tmp}`, "rename", `fsync:${dir}`]);
    expect(fs.readFileSync(dest, "utf8")).toBe("x");
    expect(fs.readdirSync(dir).filter((n) => n.includes(".tmp."))).toEqual([]);
  });
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
  test("creates the file owner-only (0600) regardless of umask (POSIX)", async () => {
    if (process.platform === "win32") return;
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
  });

  test("tightens a pre-existing world/group-readable file to 0600 (POSIX)", async () => {
    if (process.platform === "win32") return;
    const p = path.join(dir, "stale.csv");
    fs.writeFileSync(p, "stale,data\n");
    // writeFileSync's mode is umask-masked; force 0644 so the test starts from a
    // genuinely over-permissive file the writer must tighten.
    fs.chmodSync(p, 0o644);
    expect(fs.statSync(p).mode & 0o777).toBe(0o644);

    await writeAndClose(createOwnerOnlyWriteStream(p), "fresh,data\n");

    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(p, "utf8")).toBe("fresh,data\n");
  });

  test("preserves an existing file's content when the mode cannot be secured (POSIX)", () => {
    // Simulates fchmod failing as it would on a file owned by another user
    // (EPERM): the writer must refuse rather than leave PII at relaxed
    // permissions, and -- because it opens without O_TRUNC -- must not have
    // emptied the existing file before that failure.
    if (process.platform === "win32") return;
    const p = path.join(dir, "foreign.csv");
    fs.writeFileSync(p, "original,content\n");
    vi.spyOn(fs, "fchmodSync").mockImplementation(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });

    expect(() => createOwnerOnlyWriteStream(p)).toThrow("EPERM");

    expect(fs.readFileSync(p, "utf8")).toBe("original,content\n");
  });

  test("closes the descriptor if truncation fails rather than leaking it (POSIX)", () => {
    // fchmod succeeds but the truncate (which runs before createWriteStream takes
    // ownership of the fd) fails: the writer must close the open descriptor on the
    // way out rather than leak it.
    if (process.platform === "win32") return;
    const p = path.join(dir, "trunc-fail.csv");
    const closeSpy = vi.spyOn(fs, "closeSync");
    vi.spyOn(fs, "ftruncateSync").mockImplementation(() => {
      throw Object.assign(new Error("EINVAL"), { code: "EINVAL" });
    });

    expect(() => createOwnerOnlyWriteStream(p)).toThrow("EINVAL");

    expect(closeSpy).toHaveBeenCalled();
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
