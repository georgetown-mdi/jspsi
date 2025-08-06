import { defineNitroConfig } from 'nitropack/config'

export default defineNitroConfig({
  preset: 'node_server',
  entry: './server/custom-entry.ts',
  // plugins: ['nitro/plugins/serverHook.ts']
})
