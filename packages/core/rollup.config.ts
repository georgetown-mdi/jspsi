import { createRequire } from "node:module";
import { defineConfig } from "rollup";

import commonjs from "@rollup/plugin-commonjs";
import { dts } from "rollup-plugin-dts";
import resolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

// Packages bundled into the output rather than kept as peer dependencies.
// @openmined/psi.js is always bundled (WASM, no npm-installable form).
// canonicalize is always bundled because it is ESM-only: from 3.0.0 its package
// `exports` declares only an `import` condition (no `require`, no `default`), so
// a `require("canonicalize")` left in the CJS build resolves to nothing and
// crashes at load with ERR_PACKAGE_PATH_NOT_EXPORTED. Only the ESM-resolving dev
// paths (vitest via Vite, the CLI's `node --import=tsx`) take the `import`
// condition and so never hit it; the shipped CJS bundle (e.g. the Docker CLI run
// as plain `node`) does. Its source is a single function, so inlining it into
// every build is cheap and removes the runtime resolution of it entirely.
// @noble/curves is bundled in the UMD browser build only because it ships
// ESM-only and has no UMD global name; the ESM/CJS builds keep it external.
const ALWAYS_BUNDLED = new Set(["@openmined/psi.js", "canonicalize"]);
// re2js and yaml are bundled into the standalone UMD browser build because they
// ship with no UMD global name; the ESM/CJS builds keep them external (the
// consuming apps bundle them). re2js is the linear-time regex engine that
// executes partner transform patterns; it is pure JS, so the same build serves
// both the CLI (Node) and the web (browser) -- see docs/spec/PROTOCOL.md
// "Transform regular-expression dialect". yaml reaches the browser via the
// sensitiveFile.ts config-import chokepoint. (canonicalize is bundled here too,
// via ALWAYS_BUNDLED above.)
const UMD_BUNDLED = new Set([
  "@openmined/psi.js",
  "@noble/curves",
  "canonicalize",
  "re2js",
  "yaml",
]);

// Returns an `external` predicate that matches bare package names and their
// subpath exports (e.g. both "@noble/curves" and "@noble/curves/p256").
function makeExternal(bundled: Set<string>) {
  const allDeps = Object.keys(pkg.dependencies as Record<string, string>);
  const externalRoots = allDeps.filter((name) => !bundled.has(name));
  return (id: string) =>
    externalRoots.some((dep) => id === dep || id.startsWith(dep + "/"));
}

export default defineConfig([
  {
    input: "src/main.ts",
    external: makeExternal(UMD_BUNDLED),
    output: {
      name: "psi-link",
      file: pkg.browser,
      format: "umd",
      globals: {
        zod: "z",
        loglevel: "log",
        eventemitter3: "EventEmitter",
        uuid: "uuid",
        papaparse: "Papa",
        luxon: "luxon",
      },
    },
    plugins: [resolve(), typescript({ outputToFilesystem: true }), commonjs()],
  },
  // The published entry points build TOGETHER, with code splitting, so a module
  // more than one of them reaches exists once at run time. Built separately they
  // would each hold their own copy, and a module holding mutable state -- the
  // fan-out listing the testing entry's lever rewrites (src/fanOutFunctions.ts)
  // -- would be two independent states, so the lever would rewrite a listing the
  // main entry's code never reads. A class is the same shape of problem: the
  // untrusted-text entry publishes JsonStructureBoundError, and two copies of it
  // would fail an `instanceof` against a refusal the main entry threw.
  {
    input: {
      core: "src/main.ts",
      testing: "src/testing.ts",
      "untrusted-text": "src/untrustedText.ts",
    },
    external: makeExternal(ALWAYS_BUNDLED),
    // resolve() lets rollup inline the ALWAYS_BUNDLED packages (currently
    // canonicalize) from node_modules; everything else is held external by the
    // `external` predicate above, so only the bundled set is pulled in.
    plugins: [resolve(), typescript({ outputToFilesystem: true })],
    // `[name]` is the input key above, so the entry names have to stay `core`,
    // `testing` and `untrusted-text`: package.json points main, module, and
    // every `exports` condition at dist/core.*, dist/testing.* and
    // dist/untrusted-text.*. A manifest rename that left these alone is caught
    // by the dist freshness guard, which derives the files it looks for from
    // that exports map (scripts/lib/coreDistFreshness.mjs). The chunk name is
    // fixed rather than hashed so a rebuild overwrites the shared chunk instead
    // of leaving the previous one behind in a published dist.
    output: [
      {
        dir: "dist",
        format: "cjs",
        entryFileNames: "[name].cjs",
        chunkFileNames: "shared.cjs",
      },
      {
        dir: "dist",
        format: "es",
        entryFileNames: "[name].esm.js",
        chunkFileNames: "shared.esm.js",
      },
    ],
  },
  // The main and testing entries' declaration files build TOGETHER for the same
  // reason their JS output does above: a type testing.ts's surface shares with
  // main.ts's -- PreparedExchange and ExchangeResult, whose dataset field holds
  // a StandardizedDataset, a class with a private member -- has to resolve to
  // ONE declaration. Built as two independent dts() passes, each would emit its
  // own private-field-bearing copy of that class, and TypeScript treats two such
  // copies as different types even though the source is identical: a testing.ts
  // fixture typed against one copy would not assign to a main-entry parameter
  // typed against the other. untrusted-text.ts stays a separate pass: its public
  // surface (JsonStructureBoundError and the display/JSON chokepoints) shares no
  // class with main.ts's.
  {
    input: {
      index: "src/main.ts",
      testing: "src/testing.ts",
    },
    output: {
      dir: "dist",
      format: "es",
      entryFileNames: "[name].d.ts",
      chunkFileNames: "shared-types.d.ts",
    },
    plugins: [dts()],
  },
  {
    input: "src/untrustedText.ts",
    output: { file: "dist/untrusted-text.d.ts", format: "es" },
    plugins: [dts()],
  },
]);
