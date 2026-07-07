import { createRequire } from "node:module";
import { defineConfig } from "rollup";

import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import typescript from "@rollup/plugin-typescript";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

// Keep every dependency external -- and any subpath of one, so the native PSI addon
// entry (@openmined/psi.js/psi_native_node.js) is resolved at runtime rather than
// bundled (its prebuilds/ are located relative to the installed package, which
// bundling would break). Shared by the CLI entry and the PSI worker entry.
const external = (id: string): boolean =>
  Object.keys(pkg.dependencies).some(
    (dep) => id === dep || id.startsWith(`${dep}/`),
  );

// Fresh plugin instances per output so the two builds do not share plugin state.
const plugins = () => [
  resolve({
    preferBuiltins: true, // let Node built-ins (fs, path, etc.) be external
  }),
  commonjs(),
  json(),
  typescript({
    tsconfig: "./tsconfig.json",
  }),
];

export default defineConfig([
  {
    input: "src/index.ts",
    output: {
      file: "dist/index.js",
      format: "cjs", // CLI = CommonJS for Node
      banner: "#!/usr/bin/env node", // shebang for execution
    },
    external,
    plugins: plugins(),
  },
  {
    // The PSI crypto worker (board item 208035324): a separate CJS entry emitted
    // beside dist/index.js so worker_threads can spawn it at runtime. It keeps
    // @openmined/psi.js external for the same prebuild-resolution reason as the CLI
    // entry, and carries no shebang (it is spawned as a worker, never run directly).
    input: "src/psiWorker.worker.ts",
    output: {
      file: "dist/psiWorker.worker.js",
      format: "cjs",
    },
    external,
    plugins: plugins(),
  },
]);
