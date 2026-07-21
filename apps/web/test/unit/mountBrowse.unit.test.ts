import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { listMountEntries, resolveMountFile } from "@jobs/mountBrowse";

// The browse contract lists and resolves paths under a server-anchored mount
// root, admitting dot-prefixed segments (SSH key material) but confining every
// resolution to the mount by realpath so a symlink cannot escape. It never reads
// file bytes.

const dirs: Array<string> = [];

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `psilink-${label}-`));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

/** A mount holding a loose file, an .ssh dir with a key, and a plain subdir. */
function mountWithKeys(): string {
  const mount = tempDir("mount");
  fs.writeFileSync(path.join(mount, "partner-password"), "s3cret\n");
  fs.mkdirSync(path.join(mount, ".ssh"));
  fs.writeFileSync(path.join(mount, ".ssh", "id_ed25519"), "PRIVATE KEY\n");
  fs.mkdirSync(path.join(mount, "certs"));
  return mount;
}

describe("listMountEntries", () => {
  test("lists files and dirs at the root, sorted, with kinds", () => {
    const mount = mountWithKeys();
    const listing = listMountEntries(mount, []);
    expect(listing.readable).toBe(true);
    expect(listing.entries).toEqual([
      { name: ".ssh", kind: "dir" },
      { name: "certs", kind: "dir" },
      { name: "partner-password", kind: "file" },
    ]);
  });

  test("navigates into a dot-prefixed subdirectory", () => {
    const mount = mountWithKeys();
    const listing = listMountEntries(mount, [".ssh"]);
    expect(listing.readable).toBe(true);
    expect(listing.entries).toEqual([{ name: "id_ed25519", kind: "file" }]);
  });

  test("an inadmissible segment (dot-dot) is readable:false, empty", () => {
    const mount = mountWithKeys();
    expect(listMountEntries(mount, [".."])).toEqual({
      readable: false,
      entries: [],
    });
  });

  test("a segment carrying a separator is readable:false", () => {
    const mount = mountWithKeys();
    expect(listMountEntries(mount, ["a/b"]).readable).toBe(false);
  });

  test("an unreadable (missing) subpath is readable:false, empty", () => {
    const mount = mountWithKeys();
    expect(listMountEntries(mount, ["no-such-dir"])).toEqual({
      readable: false,
      entries: [],
    });
  });

  test("a symlink to a dir OUTSIDE the mount is listed but not navigable", () => {
    const mount = mountWithKeys();
    const outside = tempDir("outside");
    fs.writeFileSync(path.join(outside, "loot"), "x\n");
    fs.symlinkSync(outside, path.join(mount, "escape"), "dir");
    // statSync follows the link, so it shows as a dir in the root listing...
    const root = listMountEntries(mount, []);
    expect(root.entries).toContainEqual({ name: "escape", kind: "dir" });
    // ...but navigating through it is refused: its realpath escapes the mount.
    expect(listMountEntries(mount, ["escape"]).readable).toBe(false);
  });

  test("never reads file bytes while listing", () => {
    const mount = mountWithKeys();
    const readFile = vi.spyOn(fs, "readFileSync");
    listMountEntries(mount, []);
    listMountEntries(mount, [".ssh"]);
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe("resolveMountFile", () => {
  test("resolves a regular file to its confined realpath", () => {
    const mount = mountWithKeys();
    const resolved = resolveMountFile(mount, [".ssh", "id_ed25519"]);
    expect(resolved).not.toBeNull();
    expect(resolved?.absolutePath).toBe(
      fs.realpathSync(path.join(mount, ".ssh", "id_ed25519")),
    );
  });

  test("an empty subpath resolves nothing", () => {
    const mount = mountWithKeys();
    expect(resolveMountFile(mount, [])).toBeNull();
  });

  test("a directory is not a file", () => {
    const mount = mountWithKeys();
    expect(resolveMountFile(mount, [".ssh"])).toBeNull();
  });

  test("a missing file resolves nothing", () => {
    const mount = mountWithKeys();
    expect(resolveMountFile(mount, ["absent"])).toBeNull();
  });

  test("a file reached through a symlink that escapes the mount is refused", () => {
    const mount = mountWithKeys();
    const outside = tempDir("outside");
    fs.writeFileSync(path.join(outside, "loot"), "x\n");
    fs.symlinkSync(outside, path.join(mount, "escape"), "dir");
    expect(resolveMountFile(mount, ["escape", "loot"])).toBeNull();
  });

  test("never reads file bytes while resolving", () => {
    const mount = mountWithKeys();
    const readFile = vi.spyOn(fs, "readFileSync");
    resolveMountFile(mount, [".ssh", "id_ed25519"]);
    expect(readFile).not.toHaveBeenCalled();
  });
});
