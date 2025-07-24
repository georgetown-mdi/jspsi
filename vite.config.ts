import path from 'node:path';

import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import tsConfigPaths from 'vite-tsconfig-paths'
import viteReact from '@vitejs/plugin-react'


export default defineConfig({
   resolve: {
    alias: {
      "@components": path.resolve(__dirname, "src/components"),
      "@util": path.resolve(__dirname, "src/util"),
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 3000,
  },
  plugins: [
    tsConfigPaths(),
    tanstackStart({ customViteReactPlugin: true, target: 'netlify' }),
    viteReact()
  ],
})
