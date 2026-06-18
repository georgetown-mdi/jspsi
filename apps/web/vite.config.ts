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

// The PeerJS signaling server attaches its WebSocket `upgrade` handler only when
// the /api/peerjs route module first runs usePeerServer() -- triggered by an HTTP
// GET to /api/peerjs/id|peers. The real client dials the signaling WebSocket with
// an explicit, pre-derived id, so it never makes that GET; the upgrade then goes
// unhandled and surfaces to the peer as "Lost connection to server." Warm the id
// endpoint at dev-server startup to load the module and attach the handler before
// any peer connects. Mirrors test/devServer/globalSetup's warmPeerSignaling (kept
// separate: that one bootstraps the test harness, this one fixes a plain
// `npm run dev`). Retries until the route answers text/plain, since Vite compiles
// the route module lazily and the first hits may fall through to the SPA fallback.
async function warmPeerSignaling(port: number): Promise<void> {
  const url = `http://127.0.0.1:${port}/api/peerjs/id`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(url);
      const ready =
        res.ok && !!res.headers.get("content-type")?.includes("text/plain");
      // Release the socket: we read only status/headers, never the body. Left
      // unconsumed, undici holds the socket open until GC, and the SPA-fallback
      // retries (before the route module compiles) hit this path repeatedly.
      await res.body?.cancel();
      if (ready) return;
    } catch {
      // Server still coming up; fall through to the deadline check and retry.
    }
    if (Date.now() >= deadline) {
      logLibrary.warn("peer signaling warm-up did not complete within 60s");
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

export default defineConfig((_configEnv) => {
  // Vitest evaluates this config but starts no dev/preview server, so the server
  // snagger plugins below have no httpServer to capture (the hook would just warn
  // "http server is undefined"). Skip them under test.
  const underVitest = !!process.env.VITEST;
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
            globalSetup: ["./test/devServer/globalSetup.ts"],
          },
        },
        {
          test: {
            include: [
              "test/browser/**/*.{test,spec}.ts",
              "test/**/*.browser.{test,spec}.ts",
            ],
            name: "browser",
            // Stand up the dev server (PeerJS coordination + /api) the same way
            // the integration project does, so a cold `test:browser` is green:
            // the server-dependent suite (invitedPSI) needs :3000, and the setup
            // reuses a developer's running `npm run dev` rather than starting a
            // second one. The server-less vector suites pay a reuse-aware probe.
            globalSetup: ["./test/devServer/globalSetup.ts"],
            browser: {
              // invitedPSI opens a real WebRTC DataConnection between two
              // same-machine peers that configure no STUN/TURN (hermetic -- see
              // invitedPSI.test.ts), so a loopback host candidate is the only way
              // they can connect. Chromium otherwise obfuscates host candidates
              // as `.local` mDNS names that do not resolve in containers/CI (no
              // mDNS responder), leaving no usable candidate -- the connection
              // never opens and the exchange hangs. Disabling the mDNS
              // obfuscation exposes the real loopback host candidate so the peers
              // connect directly. Test browser only -- no effect on the dev
              // server or `npm run build`.
              provider: playwright({
                launchOptions: {
                  args: ["--disable-features=WebRtcHideLocalIpsWithMdns"],
                },
              }),
              headless: true,
              enabled: true,
              instances: [{ browser: "chromium" }],
            },
          },
          // Component browser tests import app sources that use the `@`-prefixed
          // aliases (e.g. `@components/*`, `@psi/*`); like the unit project, the
          // browser project must resolve them since the inline projects do not
          // inherit the root `resolve`.
          resolve: { alias: srcAliases },
        },
      ],
    },
    plugins: [
      tanstackStart({
        srcDirectory: "src",
      }),
      nitroV2Plugin({ preset: "node-server" }),
      viteReact(),
      ...(underVitest
        ? []
        : [
            {
              name: "dev-server-snagger",
              configureServer(server: ViteDevServer) {
                if (server.httpServer) {
                  registerServer(server.httpServer);
                  // Once listening, warm the signaling module so its WebSocket
                  // `upgrade` handler is attached before any peer dials it (see
                  // warmPeerSignaling). Read the actual bound port: Vite does not
                  // set strictPort, so if config.PORT is occupied it auto-
                  // increments, and config.PORT would then warm the wrong port,
                  // leaving the handler unattached.
                  server.httpServer.once("listening", () => {
                    const address = server.httpServer?.address();
                    const boundPort =
                      typeof address === "object" && address
                        ? address.port
                        : config.PORT;
                    void warmPeerSignaling(boundPort);
                  });
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
          ]),
    ],
    resolve: {
      tsconfigPaths: true,
      alias: srcAliases,
    },
  };
});
