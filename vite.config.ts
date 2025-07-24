import path from 'node:path';

import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import tsConfigPaths from 'vite-tsconfig-paths'
import viteReact from '@vitejs/plugin-react'


export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 3000,
  },
  build: {
    rollupOptions: {
      logLevel: 'debug'
    }
  },
  plugins: [
    tsConfigPaths({
      projects: ['./tsconfig.json']
    }),
    tanstackStart({ customViteReactPlugin: true, target: 'netlifly' }),
    viteReact()
  ],
  resolve: {
    alias: {
      "@components": path.resolve(__dirname, "src/components"),
      "@util": path.resolve(__dirname, "src/util"),
      "@": path.resolve(__dirname, "src"),
    },
  }
})
