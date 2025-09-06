import { createRequire } from 'node:module';
import { defineConfig } from 'rollup';

import commonjs from '@rollup/plugin-commonjs';
import { dts } from "rollup-plugin-dts";
import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';

const require = createRequire(import.meta.url);
// eslint-disable-next-line import/no-commonjs
const pkg = require('./package.json');

export default defineConfig([
	{
		input: 'src/main.ts',
		external: Object.keys(pkg.dependencies).filter(name => name != '@openmined/psi.js'),
		output: {
			name: 'psi-link',
			file: pkg.browser,
			format: 'umd'
		},
		plugins: [
			resolve(),
			commonjs(),
			typescript()
		]
	},
	{
		input: 'src/main.ts',
		external: Object.keys(pkg.dependencies).filter(name => name != '@openmined/psi.js'),
		plugins: [
			typescript()
		],
		output: [
			{ file: pkg.main, format: 'cjs', entryFileNames: "[name].cjs" },
			{ file: pkg.module, format: 'es' }
		]
	},
	{
		input: "src/main.ts",
		output: { file: "dist/index.d.ts", format: "es" },
		plugins: [dts()]
	}
]);
