import { readdirSync, readFileSync } from "node:fs";
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
// same platform set, per-platform libc tagging, and glibc floor -- so a re-vendor
// that quietly drops a platform, mis-tags a libc, corrupts the WASM fallback, or
// raises the floor fails here instead of degrading to WASM unnoticed. Contract
// lives in ./vectors/psi-prebuild-manifest.json; the target state (which the
// contract asserts below force a deliberate update toward) is board item
// 208541964.

interface Manifest {
  tarball: string;
  platforms: string[];
  wasmEngines: string[];
  linux: { libcTags: string[]; maxGlibcFloor: string };
  target: { maxGlibcFloor: string; requiredLibcTags: string[]; note: string };
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
const tarballName = manifest.tarball.split("/").pop() as string;
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
const linuxPlatforms = [...new Set(linuxPrebuilds.map((p) => p.platform))];

describe("vendored PSI prebuild tarball manifest", () => {
  test("names the one tarball the apps install, the sidecar pins, and lib/ holds", () => {
    // Without this, the guard could validate an artifact the app never loads: a
    // seclink.N bump that updates package.json but leaves the old .tgz in lib/
    // (a forgotten `git rm`) would have this suite check the stale file green.
    // Tie the manifest to every place the vendored version is named.
    const libFiles = readdirSync(`${repoRoot}lib`);
    expect(libFiles.filter((f) => f.endsWith(".tgz"))).toEqual([tarballName]);
    expect(libFiles.filter((f) => f.endsWith(".tgz.sha256"))).toEqual([
      `${tarballName}.sha256`,
    ]);
    expect(
      readFileSync(`${repoRoot}lib/${tarballName}.sha256`, "utf8"),
    ).toContain(tarballName);
    for (const pkg of ["apps/cli", "apps/web", "packages/core"]) {
      const dep = (
        JSON.parse(readFileSync(`${repoRoot}${pkg}/package.json`, "utf8")) as {
          dependencies?: Record<string, string>;
        }
      ).dependencies?.["@openmined/psi.js"];
      expect(dep, `${pkg} @openmined/psi.js dependency`).toContain(tarballName);
    }
  });

  test("ships exactly the recorded platform set", () => {
    const platforms = [...new Set(prebuilds.map((p) => p.platform))].sort();
    expect(platforms).toEqual([...manifest.platforms].sort());
  });

  test("ships exactly the recorded WASM engines, none truncated", () => {
    const engineRe = /^package\/(psi_wasm_[^/]+\.js)$/;
    const engines = new Map<string, Buffer>();
    for (const entry of entries) {
      const m = engineRe.exec(entry.name);
      if (m) engines.set(m[1], entry.data);
    }
    // Set-equality, not subset: a dropped, renamed, OR extra engine fails.
    expect([...engines.keys()].sort()).toEqual(
      [...manifest.wasmEngines].sort(),
    );
    for (const [name, data] of engines) {
      // The WASM engine is the default-correct fallback; a 0-byte or truncated
      // one must not pass. Real engines are ~2MB; 100KB is a generous floor.
      expect(data.length, `${name} is implausibly small`).toBeGreaterThan(
        100_000,
      );
    }
  });

  test("tags every linux prebuild exactly as recorded", () => {
    // Per-platform, not a union across platforms: seclink.3 must ship both the
    // glibc and musl tag on EVERY linux arch, so node-gyp-build can never select
    // a glibc binary under musl on any of them. A union check would miss an arch
    // that shipped only glibc. Untagged today ([] -> [""]) -- board 208541964.
    const expected = [
      ...new Set(
        manifest.linux.libcTags.length ? manifest.linux.libcTags : [""],
      ),
    ].sort();
    expect(linuxPlatforms.length).toBeGreaterThan(0);
    for (const platform of linuxPlatforms) {
      const tags = [
        ...new Set(
          linuxPrebuilds
            .filter((p) => p.platform === platform)
            .map((p) => p.tag ?? ""),
        ),
      ].sort();
      expect(tags, `linux platform ${platform} libc tags`).toEqual(expected);
    }
  });

  test("records the exact linux glibc floor", () => {
    expect(linuxPrebuilds.length).toBeGreaterThan(0);
    const floors = linuxPrebuilds.map((prebuild) => {
      const floor = maxGlibcFloor(prebuild.data);
      expect(
        floor,
        `${prebuild.platform} references no GLIBC symbols`,
      ).not.toBeNull();
      return floor as string;
    });
    // Exact equality with the highest floor across the linux prebuilds. A RISE
    // (regression -- fewer hosts can load it, the GLIBC_2.38 class this guard
    // exists for) fails; a DROP (the seclink.3 improvement) also fails, forcing a
    // deliberate manifest update toward `target` rather than letting the recorded
    // value silently rot out of date.
    const observed = floors.reduce((a, b) =>
      compareVersion(a, b) >= 0 ? a : b,
    );
    expect(observed).toBe(manifest.linux.maxGlibcFloor);
  });
});
