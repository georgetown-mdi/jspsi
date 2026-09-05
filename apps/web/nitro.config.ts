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
  "@components": resolve(srcDir, "components"),
  "@console": resolve(srcDir, "console"),
  "@exchange": resolve(srcDir, "exchange"),
  "@jobs": resolve(srcDir, "jobs"),
  "@recurring": resolve(srcDir, "recurring"),
  "@styles": resolve(srcDir, "styles"),
  "@utils": resolve(srcDir, "utils"),
  "@psi": resolve(srcDir, "psi"),
  "@theme": resolve(srcDir, "theme"),
};

export default defineNitroConfig({
  // Nitro gates its preset behavior changes behind this date, and an unset one
  // silently builds on its 2024-04-03 fallback: the deployed server would take
  // whatever defaults a date nobody chose implies. Moving it forward opts into
  // the changes dated between the two, so it is a deliberate, deployed edit.
  compatibilityDate: "2026-08-22",
  preset: "node_server",
  entry: "./server/custom-entry.ts",
  alias: serverAliases,
  esbuild: {
    options: {
      target: "esnext",
    },
  },
});
