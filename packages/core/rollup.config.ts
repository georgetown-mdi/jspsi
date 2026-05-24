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
// @noble/curves is bundled in the UMD browser build only because it ships
// ESM-only and has no UMD global name; the ESM/CJS builds keep it external.
const ALWAYS_BUNDLED = new Set(["@openmined/psi.js"]);
const UMD_BUNDLED = new Set(["@openmined/psi.js", "@noble/curves"]);

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
  {
    input: "src/main.ts",
    external: makeExternal(ALWAYS_BUNDLED),
    plugins: [typescript({ outputToFilesystem: true })],
    output: [
      { file: pkg.main, format: "cjs", entryFileNames: "[name].cjs" },
      { file: pkg.module, format: "es" },
    ],
  },
  {
    input: "src/main.ts",
    output: { file: "dist/index.d.ts", format: "es" },
    plugins: [dts()],
  },
]);
