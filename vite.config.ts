import path from 'node:path';


import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import tsConfigPaths from 'vite-tsconfig-paths';
import viteReact from '@vitejs/plugin-react';

import { Config } from './src/utils/config';

import { registerServer } from './src/httpServer';

import type { PreviewServer, ViteDevServer } from 'vite'


const configManager = new Config();
const config = await configManager.load({dotenv: true});

export default defineConfig((_configEnv) => {
  return {
    server: {
      host: '127.0.0.1',
      port: config.PORT,
    },
    build: {
      rollupOptions: {
        logLevel: 'debug'
      }
    },
    plugins: [
      tsConfigPaths({
        projects: ['./tsconfig.json'],
        skip: (dir: string) => { return ['.netlify', '.nitro', '.tanstack', 'dist'].includes(dir); }
      }),
      tanstackStart({
        customViteReactPlugin: true,
        target: 'node-server',
      }),
      viteReact(),
      {
        name: 'dev-server-snagger',
        configureServer(server: ViteDevServer) {
          if (server.httpServer) {
            registerServer(server.httpServer)
          }
          else {
            console.warn('http server is undefined')
          }
        }
      },
      {
        name: 'preview-server-snagger',
        configurePreviewServer(server: PreviewServer) {
          registerServer(server.httpServer)
        }
      },
    ],
    resolve: {
      alias: {
        "@components": path.resolve(__dirname, "src/components"),
        "@util": path.resolve(__dirname, "src/util"),
        "@peerjs-server": path.resolve(__dirname, "src/contrib/peerjs-server"),
        "@": path.resolve(__dirname, "src"),
      },
    }
  }
})
