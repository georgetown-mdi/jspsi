import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import tsConfigPaths from 'vite-tsconfig-paths'
import viteReact from '@vitejs/plugin-react'

import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 3000,
  },
  plugins: [
    tsConfigPaths({
      projects: ['./tsconfig.json']
    }),
    tanstackStart({ customViteReactPlugin: true, target: 'netlify' }),
    viteReact()
  ],
})
