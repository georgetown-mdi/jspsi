#!/usr/bin/env node
// nitro.config.ts websocket-unset check, run by static_checks.yaml on every PR.
//
// apps/web/server/custom-entry.ts wires exactly one production upgrade
// listener onto the shared HTTP server: usePeerServer()'s PeerJS signaling
// route, attached lazily the first time it is requested, and path-routed to
// its own endpoint. Nitro's own WebSocket support -- crossws's node adapter,
// gated behind `experimental.websocket` in the Nitro config -- would attach a
// SECOND, independent `server.on("upgrade", ...)` listener with no path check
// of its own. Two such listeners on one HTTP server mis-route: whichever
// attaches first sees every upgrade request, so turning Nitro's WebSocket
// support on while PeerJS shares this server would grab PeerJS's signaling
// upgrades too (or leave crossws's own upgrades unserved, depending on
// attachment order), and neither listener coordinates with the other to sort
// that out. Coexisting safely needs a single path-routed upgrade dispatcher in
// front of both, not two independent listeners -- work nothing in this
// codebase does today, so `experimental.websocket` must stay unset.
//
// This is a "does not happen at runtime" claim, which CLAUDE.md's Agent
// conventions and CONTRIBUTING.md's Code Conventions say belongs in an
// executable check rather than a comment that can rot silently -- so this
// check is that gate: it fails when apps/web/nitro.config.ts turns
// `experimental.websocket` on.
//
// Driven against the REAL config, not a model of it: this loads
// apps/web/nitro.config.ts through a plain `node` import -- Node's strip-only
// type stripping loads it cleanly, the same load path
// check-web-config-native-load.mjs drives against apps/web/vite.config.ts --
// and reads the resulting object, rather than parsing the source text or
// reimplementing defineNitroConfig's own resolution.
//
// What this check does not cover:
//   - Any OTHER way a second upgrade listener could be attached to the shared
//     server. It watches only the one setting -- `experimental.websocket` --
//     that wires the crossws adapter through Nitro's own build.
//   - Whether PeerJS's own listener still path-checks; that is
//     apps/web/server/upgradeHardening.ts's and the PeerJS signaling route's
//     concern.

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The config this check guards, relative to the repository root. */
export const NITRO_CONFIG = "apps/web/nitro.config.ts";

/**
 * Loads NITRO_CONFIG under `root` through a plain `node` import and returns
 * its default export -- the real, resolved Nitro config object.
 */
export async function loadNitroConfig(root) {
  const configFile = resolve(root, NITRO_CONFIG);
  const loaded = await import(pathToFileURL(configFile).href);
  return loaded.default;
}

/** Whether a loaded Nitro config object turns `experimental.websocket` on. */
export function websocketEnabled(config) {
  return Boolean(config?.experimental?.websocket);
}

const FAILURE_MESSAGE = [
  `${NITRO_CONFIG} sets experimental.websocket, which wires a second,`,
  "independent WebSocket upgrade listener onto the HTTP server PeerJS",
  "signaling already shares. Two such listeners mis-route -- see this",
  "script's header comment for why, and apps/web/server/custom-entry.ts for",
  "the listener this would collide with.",
].join(" ");

/**
 * Loads NITRO_CONFIG under `root` (via `load`, injectable for a test) and
 * reports `{ok, message}`.
 */
export async function checkNitroWebsocketUnset({
  root,
  load = loadNitroConfig,
} = {}) {
  const config = await load(root);
  if (websocketEnabled(config)) {
    return { ok: false, message: FAILURE_MESSAGE };
  }
  return {
    ok: true,
    message: `${NITRO_CONFIG} sets no experimental.websocket.`,
  };
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit. `--root` points the run at another
// tree, which is how the test drives a fixture config this repository does
// not hold.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootFlag = args.indexOf("--root");
  if (rootFlag !== -1 && args[rootFlag + 1] === undefined) {
    console.error(
      "usage: node scripts/check-nitro-websocket-unset.mjs [--root <tree>]",
    );
    process.exit(2);
  }
  const root =
    rootFlag === -1
      ? resolve(dirname(fileURLToPath(import.meta.url)), "..")
      : resolve(args[rootFlag + 1]);

  const { ok, message } = await checkNitroWebsocketUnset({ root });
  (ok ? console.log : console.error)(
    `nitro websocket-unset check ${ok ? "passed" : "failed"}: ${message}`,
  );
  if (!ok) process.exit(1);
}
