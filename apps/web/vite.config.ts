/// <reference types="vitest/config" />
import path from "node:path";

import { defineConfig } from "vite";
import logLibrary from "loglevel";
import { nitroV2Plugin } from "@tanstack/nitro-v2-vite-plugin";
import { playwright } from "@vitest/browser-playwright";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";

import { ConfigManager } from "./src/utils/serverConfig";

import { registerServer } from "./src/httpServer";

import type { PreviewServer, ViteDevServer } from "vite";

const configManager = new ConfigManager();
const config = await configManager.load({ dotenv: true });

logLibrary.setDefaultLevel(config.LOG_LEVEL);

// Vite resolution for the `@`-prefixed imports the app uses, shared so the
// inline vitest projects (which do not inherit the root `resolve`) resolve them
// too. tsconfig provides these via explicit `paths` plus a `@*` -> `./src/*`
// catch-all; `@psi` here stands in for that catch-all, which the unit project
// needs because its `src/psi` sources pull in `@utils/*`.
const srcAliases = {
  "@components": path.resolve(__dirname, "src/components"),
  "@utils": path.resolve(__dirname, "src/utils"),
  "@util": path.resolve(__dirname, "src/util"),
  "@peerjs-server": path.resolve(__dirname, "src/contrib/peerjs-server"),
  "@psi": path.resolve(__dirname, "src/psi"),
  "@": path.resolve(__dirname, "src"),
};

export default defineConfig((_configEnv) => {
  return {
    server: {
      host: "127.0.0.1",
      port: config.PORT,
    },
    test: {
      projects: [
        {
          test: {
            include: [
              "test/unit/**/*.{test,spec}.ts",
              "test/**/*.unit.{test,spec}.ts",
            ],
            name: "unit",
            environment: "node",
          },
          resolve: { alias: srcAliases },
        },
        {
          test: {
            include: [
              "test/integration/**/*.{test,spec}.ts",
              "test/**/*.integration.{test,spec}.ts",
            ],
            name: "integration",
            environment: "node",
          },
        },
        {
          test: {
            include: [
              "test/browser/**/*.{test,spec}.ts",
              "test/**/*.browser.{test,spec}.ts",
            ],
            name: "browser",
            browser: {
              provider: playwright(),
              headless: true,
              enabled: true,
              instances: [{ browser: "chromium" }],
            },
          },
        },
      ],
    },
    plugins: [
      tanstackStart({
        srcDirectory: "src",
      }),
      nitroV2Plugin({ preset: "node-server" }),
      viteReact(),
      {
        name: "dev-server-snagger",
        configureServer(server: ViteDevServer) {
          if (server.httpServer) {
            registerServer(server.httpServer);
          } else {
            console.warn("http server is undefined");
          }
        },
      },
      {
        name: "preview-server-snagger",
        configurePreviewServer(server: PreviewServer) {
          registerServer(server.httpServer);
        },
      },
    ],
    resolve: {
      tsconfigPaths: true,
      alias: srcAliases,
    },
  };
});
