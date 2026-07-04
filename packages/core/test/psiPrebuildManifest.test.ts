import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  compareVersion,
  maxGlibcFloor,
  readTgz,
} from "./utils/prebuildTarball";

// Guards the vendored @openmined/psi.js native prebuild tarball against silent
// drift. The sha256 sidecar (verified in CI before npm ci) proves the bytes are
// the committed ones; this proves those bytes still mean what we expect -- the
// same platform set, libc tagging, and glibc floor -- so a re-vendor that quietly
// drops a platform or raises the floor fails here instead of degrading to WASM
// unnoticed in production. Contract lives in ./vectors/psi-prebuild-manifest.json;
// the target state is board item 208541964.

interface Manifest {
  tarball: string;
  platforms: string[];
  wasmEngines: string[];
  linux: { libcTags: string[]; maxGlibcFloor: string };
}

const manifest = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("./vectors/psi-prebuild-manifest.json", import.meta.url),
    ),
    "utf8",
  ),
) as Manifest;

// Repo root is three levels up from packages/core/test/.
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const entries = readTgz(`${repoRoot}${manifest.tarball}`);

// A vendored addon is `package/prebuilds/<platform>/node.napi[.<libcTag>].node`.
const prebuildRe =
  /^package\/prebuilds\/([^/]+)\/node\.napi(?:\.([^/]+))?\.node$/;
interface Prebuild {
  platform: string;
  tag: string | null;
  data: Buffer;
}
const prebuilds: Prebuild[] = entries.flatMap((entry) => {
  const m = prebuildRe.exec(entry.name);
  return m ? [{ platform: m[1], tag: m[2] ?? null, data: entry.data }] : [];
});
const linuxPrebuilds = prebuilds.filter((p) => p.platform.startsWith("linux-"));

describe("vendored PSI prebuild tarball manifest", () => {
  test("resolves the committed tarball named in the manifest", () => {
    // A version bump that renames the tarball but forgets this manifest lands
    // here (readTgz would have thrown on a missing path) rather than silently
    // checking a stale artifact.
    expect(entries.length).toBeGreaterThan(0);
  });

  test("ships exactly the recorded platform set", () => {
    const platforms = [...new Set(prebuilds.map((p) => p.platform))].sort();
    expect(platforms).toEqual([...manifest.platforms].sort());
  });

  test("ships the recorded WASM engines (the default-correct fallback)", () => {
    const names = new Set(entries.map((entry) => entry.name));
    for (const engine of manifest.wasmEngines) {
      expect(names.has(`package/${engine}`)).toBe(true);
    }
  });

  test("tags the linux prebuilds exactly as recorded", () => {
    // Untagged today ([]). seclink.3 adds glibc/musl tags so node-gyp-build can
    // never select a glibc binary under musl; that change must update the
    // manifest deliberately -- board 208541964.
    const tags = [...new Set(linuxPrebuilds.map((p) => p.tag ?? ""))].sort();
    const expected = [
      ...new Set(
        manifest.linux.libcTags.length ? manifest.linux.libcTags : [""],
      ),
    ].sort();
    expect(tags).toEqual(expected);
  });

  test("keeps the linux glibc floor at or below the recorded ceiling", () => {
    expect(linuxPrebuilds.length).toBeGreaterThan(0);
    for (const prebuild of linuxPrebuilds) {
      const floor = maxGlibcFloor(prebuild.data);
      expect(
        floor,
        `${prebuild.platform} references no GLIBC symbols`,
      ).not.toBeNull();
      // <= ceiling: a rebuild that RAISES the floor (fewer hosts can load it, the
      // exact GLIBC_2.38 regression this guard exists for) fails here.
      expect(
        compareVersion(floor as string, manifest.linux.maxGlibcFloor),
        `${prebuild.platform} requires GLIBC_${floor}, above the recorded ceiling ${manifest.linux.maxGlibcFloor}`,
      ).toBeLessThanOrEqual(0);
    }
  });

  // Target state (board 208541964): the fork must lower the linux glibc floor to
  // <= 2.28 and ship tagged musl prebuilds so the native backend engages on the
  // shipped Alpine image and on glibc 2.28-2.36 hosts. Turn this into a real
  // assertion (and tighten the manifest ceiling + libcTags) when seclink.3 lands.
  test.todo(
    "linux prebuilds meet the target glibc floor (<= 2.28) and ship tagged musl builds",
  );
});
