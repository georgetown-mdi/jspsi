import { createRequire } from "node:module";
import { defineConfig } from "rollup";

import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import typescript from "@rollup/plugin-typescript";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

export default defineConfig({
  input: "src/index.ts",
  output: {
    file: "dist/index.js",
    format: "cjs", // CLI = CommonJS for Node
    banner: "#!/usr/bin/env node", // shebang for execution
  },
  //external: ['ssh2'],
  // Keep every dependency external -- and any subpath of one, so the native PSI
  // addon entry (@openmined/psi.js/psi_native_node.js) is resolved at runtime
  // rather than bundled (its prebuilds/ are located relative to the installed
  // package, which bundling would break).
  external: (id: string) =>
    Object.keys(pkg.dependencies).some(
      (dep) => id === dep || id.startsWith(`${dep}/`),
    ),
  plugins: [
    resolve({
      preferBuiltins: true, // let Node built-ins (fs, path, etc.) be external
    }),
    commonjs(),
    json(),
    typescript({
      tsconfig: "./tsconfig.json",
    }),
  ],
});
