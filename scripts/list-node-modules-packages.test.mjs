import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { listNodeModulesPackages } from "./list-node-modules-packages.mjs";

let root;

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

// A node_modules tree on disk: each entry is a path relative to it, and its
// value the manifest to write there, `null` for a directory with no manifest.
function tree(entries) {
  root = mkdtempSync(join(tmpdir(), "node-modules-listing-"));
  const nodeModules = join(root, "node_modules");
  for (const [path, manifest] of Object.entries(entries)) {
    const directory = join(nodeModules, path);
    mkdirSync(directory, { recursive: true });
    if (manifest !== null) {
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify(manifest),
        "utf8",
      );
    }
  }
  return nodeModules;
}

describe("listNodeModulesPackages", () => {
  it("reports every package, hoisted, scoped and nested alike", () => {
    const nodeModules = tree({
      re2js: { name: "re2js", version: "0.4.3" },
      "@noble/curves": { name: "@noble/curves", version: "2.4.0" },
      ssh2: { name: "ssh2", version: "1.17.0" },
      "ssh2/node_modules/asn1": { name: "asn1", version: "0.2.6" },
    });

    expect(listNodeModulesPackages(nodeModules)).toEqual([
      "@noble/curves@2.4.0",
      "asn1@0.2.6",
      "re2js@0.4.3",
      "ssh2@1.17.0",
    ]);
  });

  it("skips npm's own bookkeeping entries", () => {
    const nodeModules = tree({
      ".bin": null,
      ".cache/one": null,
      yaml: { name: "yaml", version: "2.8.1" },
    });
    writeFileSync(join(nodeModules, ".package-lock.json"), "{}", "utf8");

    expect(listNodeModulesPackages(nodeModules)).toEqual(["yaml@2.8.1"]);
  });

  // What something other than npm looks like in the tree: an unpacked directory
  // with no manifest is reported rather than passed over, so it lands in the
  // diff the measurement step runs.
  it("reports a directory carrying no manifest by its path", () => {
    const nodeModules = tree({
      "planted/lib": null,
      yaml: { name: "yaml", version: "2.8.1" },
    });

    expect(listNodeModulesPackages(nodeModules)).toEqual([
      "planted (no package.json)",
      "yaml@2.8.1",
    ]);
  });

  it("skips a dotted entry inside a scope directory", () => {
    const nodeModules = tree({
      "@psilink/.cache": null,
      "@psilink/core": { name: "@psilink/core", version: "0.1.0" },
    });

    expect(listNodeModulesPackages(nodeModules)).toEqual([
      "@psilink/core@0.1.0",
    ]);
  });

  it("reads a workspace link from its target without descending into it", () => {
    const nodeModules = tree({
      "../packages/core": { name: "@psilink/core", version: "0.1.0" },
      "../packages/core/node_modules/vitest": {
        name: "vitest",
        version: "4.0.0",
      },
      "@psilink": null,
    });
    symlinkSync("../../packages/core", join(nodeModules, "@psilink/core"));

    expect(listNodeModulesPackages(nodeModules)).toEqual([
      "@psilink/core@0.1.0",
    ]);
  });

  it("is empty for a tree that does not exist", () => {
    expect(listNodeModulesPackages(join(tmpdir(), "no-such-tree"))).toEqual([]);
  });

  // The two cases below stage a directory that denies the account reading it,
  // which root ignores and a platform with no uid to read cannot stage at all.
  const modesDenyTheReader =
    process.getuid !== undefined && process.getuid() !== 0;

  it.skipIf(!modesDenyTheReader)(
    "refuses a scope directory it cannot list",
    () => {
      const nodeModules = tree({
        "@noble/curves": { name: "@noble/curves", version: "2.4.0" },
        yaml: { name: "yaml", version: "2.8.1" },
      });
      const scope = join(nodeModules, "@noble");
      chmodSync(scope, 0o000);

      try {
        expect(() => listNodeModulesPackages(nodeModules)).toThrow(scope);
        expect(() => listNodeModulesPackages(nodeModules)).toThrow("EACCES");
      } finally {
        chmodSync(scope, 0o755);
      }
    },
  );

  it.skipIf(!modesDenyTheReader)(
    "refuses a nested node_modules it cannot list",
    () => {
      const nodeModules = tree({
        ssh2: { name: "ssh2", version: "1.17.0" },
        "ssh2/node_modules/asn1": { name: "asn1", version: "0.2.6" },
      });
      const nested = join(nodeModules, "ssh2", "node_modules");
      chmodSync(nested, 0o000);

      try {
        expect(() => listNodeModulesPackages(nodeModules)).toThrow(nested);
        expect(() => listNodeModulesPackages(nodeModules)).toThrow("EACCES");
      } finally {
        chmodSync(nested, 0o755);
      }
    },
  );
});
