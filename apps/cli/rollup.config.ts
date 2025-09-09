import { createRequire } from 'node:module';
import { defineConfig } from 'rollup';

import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import json from '@rollup/plugin-json'
import typescript from "@rollup/plugin-typescript";

const require = createRequire(import.meta.url);
// eslint-disable-next-line import/no-commonjs
const pkg = require('./package.json');

export default defineConfig({
  input: "src/index.ts",
  output: {
    file: "dist/index.js",
    format: "cjs",         // CLI = CommonJS for Node
    banner: "#!/usr/bin/env node", // shebang for execution
  },
  //external: ['ssh2'],
  external: Object.keys(pkg.dependencies),
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
