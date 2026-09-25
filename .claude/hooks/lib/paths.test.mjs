import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalPath, nearestExistingDirectory } from "./paths.mjs";

describe("lib/paths", () => {
  const dirs = [];
  const scratch = () => {
    // Resolved, since the temporary directory can itself sit behind a symlink.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "hook-paths-")));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    while (dirs.length > 0)
      rmSync(dirs.pop(), { recursive: true, force: true });
  });

  describe("canonicalPath", () => {
    it("resolves a symlinked parent of a path that exists", () => {
      const dir = scratch();
      mkdirSync(join(dir, "real", "nested"), { recursive: true });
      symlinkSync(join(dir, "real"), join(dir, "link"));
      expect(canonicalPath(join(dir, "link", "nested"))).toBe(
        join(dir, "real", "nested"),
      );
    });

    it("keeps the components of a path that does not exist yet", () => {
      const dir = scratch();
      mkdirSync(join(dir, "real"));
      symlinkSync(join(dir, "real"), join(dir, "link"));
      expect(canonicalPath(join(dir, "link", "new", "file.txt"))).toBe(
        join(dir, "real", "new", "file.txt"),
      );
    });

    it("returns a path nothing of which resolves unchanged", () => {
      expect(canonicalPath("/nowhere/at/all")).toBe("/nowhere/at/all");
    });
  });

  describe("nearestExistingDirectory", () => {
    it("is the deepest existing directory above the path", () => {
      const dir = scratch();
      mkdirSync(join(dir, "real"));
      expect(nearestExistingDirectory(join(dir, "real", "gone", "file"))).toBe(
        join(dir, "real"),
      );
      expect(nearestExistingDirectory(join(dir, "file"))).toBe(dir);
    });

    it("walks up to the root rather than answering nothing", () => {
      expect(nearestExistingDirectory("/nowhere/at/all")).toBe("/");
    });
  });
});
