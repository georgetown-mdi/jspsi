import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { isNativeUnavailable } from "../../src/psiBackend";

// Pins the classification the WASM fallback depends on: which native-load errors
// are the ordinary "no prebuild here" case (resolve null, fall back quietly)
// versus a genuinely broken addon that must surface. Getting this wrong either
// hides a real regression -- a present-but-broken prebuild silently treated as
// "absent" -- or warns on every run of a platform that simply has no prebuild.
describe("isNativeUnavailable", () => {
  test("treats a missing ESM subpath / module as unavailable (quiet fallback)", () => {
    // The dynamic import of the native entry throws ERR_MODULE_NOT_FOUND when the
    // subpath is absent from an older vendored package; MODULE_NOT_FOUND is the
    // CJS-resolution equivalent.
    expect(isNativeUnavailable({ code: "ERR_MODULE_NOT_FOUND" })).toBe(true);
    expect(isNativeUnavailable({ code: "MODULE_NOT_FOUND" })).toBe(true);
  });

  test("treats node-gyp-build's 'No native build was found' as unavailable", () => {
    // node-gyp-build throws this (no `code`) when no prebuild matches the running
    // platform/libc -- the expected case on an unsupported platform.
    expect(
      isNativeUnavailable(
        new Error("No native build was found for platform=linuxmusl arch=x64"),
      ),
    ).toBe(true);
  });

  test("treats a dlopen / ABI / libc mismatch as a genuine failure, not unavailable", () => {
    // What a glibc-linked addon throws on musl, or when the host glibc is older
    // than the prebuild requires (verified real-world: ERR_DLOPEN_FAILED with a
    // "GLIBC_2.38 not found" message). A prebuild exists but won't load here, so
    // it must NOT be swallowed as "no prebuild" -- the selector still falls back
    // to WASM, but the CLI surfaces it at warn instead of hiding it.
    const dlopen = Object.assign(
      new Error(
        "/lib/aarch64-linux-gnu/libc.so.6: version `GLIBC_2.38' not found",
      ),
      { code: "ERR_DLOPEN_FAILED" },
    );
    expect(isNativeUnavailable(dlopen)).toBe(false);
  });

  test("treats an exports-map subpath rejection as a genuine failure", () => {
    // If a future vendored package adds an `exports` map without listing the
    // native subpath, resolution throws ERR_PACKAGE_PATH_NOT_EXPORTED -- not the
    // "no prebuild" case, so it surfaces rather than being mislabeled. Pinning
    // current behavior; flip this if the classifier is taught to absorb it.
    expect(isNativeUnavailable({ code: "ERR_PACKAGE_PATH_NOT_EXPORTED" })).toBe(
      false,
    );
  });

  test("treats an unrecognized or non-error value as a genuine failure", () => {
    expect(isNativeUnavailable(new Error("boom"))).toBe(false);
    expect(isNativeUnavailable(null)).toBe(false);
    expect(isNativeUnavailable(undefined)).toBe(false);
  });

  test("node-gyp-build still throws the message the classifier keys on", () => {
    // The quiet path above keys on a substring of node-gyp-build's no-match
    // error -- an external contract, not a language guarantee. A future
    // node-gyp-build reword, or a Node that stabilizes the experimental
    // require.addon resolver node-gyp-build can dispatch to instead of its
    // string-throwing JS path, would silently flip a genuine "no prebuild here"
    // from quiet to a warning on every unsupported-platform run. Pin the
    // contract at its source: invoke the node-gyp-build the vendored package
    // actually loads (resolved through it, not a hoisted copy) against a dir
    // with no prebuilds, and assert both the message and the classification.
    const requireFrom = createRequire(import.meta.url);
    const nodeGypBuild = createRequire(
      requireFrom.resolve("@openmined/psi.js/package.json"),
    )("node-gyp-build") as (dir: string) => unknown;
    const emptyDir = mkdtempSync(join(tmpdir(), "ngb-contract-"));
    try {
      let thrown: unknown;
      try {
        nodeGypBuild(emptyDir);
      } catch (error) {
        thrown = error;
      }
      expect(
        thrown,
        "node-gyp-build resolved a prebuild in an empty dir",
      ).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/No native build was found/i);
      // The classifier must still map that real error to the quiet fallback.
      expect(isNativeUnavailable(thrown)).toBe(true);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
