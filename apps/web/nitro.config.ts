import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineNitroConfig } from "nitropack/config";

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "src");

// The `@`-prefixed source aliases (mirrored from vite.config.ts `srcAliases`).
// Vite's `resolve.alias` governs only the client and SSR rollup passes; Nitro's
// own server rollup pass reads its aliases from the Nitro config alone, so an
// aliased import that Nitro externalizes into the server entry (rather than
// inlining) would otherwise survive as an unresolved bare specifier and crash
// the server at boot with ERR_MODULE_NOT_FOUND. Resolving the whole prefix set
// here keeps any `@`-aliased server-graph import resolvable regardless of
// Nitro's inline-vs-externalize decision.
const serverAliases = {
  "@bench": resolve(srcDir, "bench"),
  "@components": resolve(srcDir, "components"),
  "@jobs": resolve(srcDir, "jobs"),
  "@utils": resolve(srcDir, "utils"),
  "@util": resolve(srcDir, "util"),
  "@peerjs-server": resolve(srcDir, "contrib/peerjs-server"),
  "@psi": resolve(srcDir, "psi"),
  "@theme": resolve(srcDir, "theme"),
};

export default defineNitroConfig({
  preset: "node_server",
  entry: "./server/custom-entry.ts",
  alias: serverAliases,
  esbuild: {
    options: {
      target: "esnext",
    },
  },
});
