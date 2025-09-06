import { defineNitroConfig } from 'nitropack/config'

export default defineNitroConfig({
  preset: 'node_server',
  entry: './server/custom-entry.ts',
  esbuild: {
			options: {
				target: "esnext",
			},
		},
  // plugins: ['nitro/plugins/serverHook.ts']
})
