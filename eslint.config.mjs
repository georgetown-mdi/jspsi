import tseslint from "typescript-eslint";
import webConfig from "./apps/web/eslint.config.js";

function scopeToDir(dir, configs) {
  return configs.map((config) => {
    if (config.ignores && !config.files) return config;
    const files = config.files
      ? config.files.map((f) => `${dir}/${f}`)
      : [`${dir}/**/*.{ts,tsx,js,jsx}`];
    return { ...config, files };
  });
}

// Ban emitting through loglevel's bare root logger (the `logLibrary` default
// import) in source that runs inside the CLI integration workers. The suite's
// two leak-detection backstops -- the console sentinel and withCapturedLogs
// capture -- only observe NAMED loggers: a named logger binds the
// sentinel-wrapped console (and the capture interceptor) at getLogger time,
// whereas the eager capture install rebinds the root logger against the raw,
// pre-sentinel console (capturedLogs.setup.ts runs before the sentinel wraps
// console). So a bare `logLibrary.<level>(...)` would silently escape BOTH
// backstops. This rule is the executable form of that invariant -- the prose
// "nothing emits through the bare root logger" the eager-install ordering rests
// on -- so a future bare-root emit fails the lint check instead of quietly
// reopening the blind spot. Emit through getLogger / getLoggerForVerbosity; the
// root `logLibrary` is for setLevel / levels / getLogger only. (In core/src and
// cli/src the loglevel default is uniformly imported as `logLibrary` and is
// never a named-logger variable, so keying on that identifier is exact.)
const noBareRootLoglevelEmit = {
  selector:
    "CallExpression[callee.object.name='logLibrary'][callee.property.name=/^(trace|debug|info|warn|error)$/]",
  message:
    "Do not emit through the bare root logger (logLibrary.<level>()): the CLI integration console sentinel and withCapturedLogs capture only see named loggers, so a bare-root emit escapes both leak-detection backstops. Use getLogger / getLoggerForVerbosity; logLibrary is for setLevel / levels / getLogger only.",
};

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "apps/web/eslint.config.js",
      "scratch/**",
      "**/.rollup.cache/**",
    ],
  },
  {
    files: ["packages/**/*.{ts,tsx}", "apps/cli/**/*.{ts,tsx}"],
    extends: tseslint.configs.recommended,
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // Force all parsing of operator config and credential files (psilink.yaml,
    // .psilink.key, the signing identity) through the single hardened chokepoint.
    // The chokepoint now lives in packages/core/src/sensitiveFile.ts (promoted
    // from the CLI); apps/cli/src/sensitiveFile.ts is a thin re-export the CLI
    // call sites import. The raw parsers leak source bytes -- a credential -- into
    // errors (YAML/JSON throw messages, parseDocument's doc.errors and
    // deferred-alias toString) and stderr (YAML's non-fatal warnings). Routing
    // through the chokepoint closes every channel in one place; banning the raw
    // calls here stops a new reader silently reopening any of them. The CLI's
    // re-export shim is exempt (it owns no raw calls but mirrors the boundary), as
    // are tests. A genuinely non-sensitive parse (e.g. parsing a command's JSON
    // output) opts out with an eslint-disable-next-line carrying a one-line why.
    files: ["apps/cli/src/**/*.ts"],
    ignores: ["apps/cli/src/sensitiveFile.ts"],
    // Fail CI on a stray or rule-silencing disable so the ban cannot be quietly
    // turned off on a genuinely sensitive parse (a bare `eslint .` only warns).
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.object.name='YAML'][callee.property.name=/^(parse|parseDocument|parseAllDocuments)$/]",
          message:
            "Parse operator/credential files through apps/cli/src/sensitiveFile.ts (parseSensitiveYaml / editSensitiveYamlDocument); raw YAML.parse leaks source into errors and stderr. Non-sensitive parse: eslint-disable-next-line with a one-line justification.",
        },
        {
          selector:
            "CallExpression[callee.object.name='JSON'][callee.property.name='parse']",
          message:
            "Parse credential files through apps/cli/src/sensitiveFile.ts (parseSensitiveJson); raw JSON.parse can echo a leading span of the source. Non-sensitive parse: eslint-disable-next-line with a one-line justification.",
        },
        noBareRootLoglevelEmit,
      ],
      // Close the named-import bypass (`import { parse } from "yaml"`); the
      // chokepoint imports the YAML default, so this never hits legitimate code.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "yaml",
              importNames: ["parse", "parseDocument", "parseAllDocuments"],
              message:
                "Parse operator/credential files through apps/cli/src/sensitiveFile.ts; do not import yaml's raw parsers directly.",
            },
          ],
        },
      ],
    },
  },
  {
    // The bare-root-logger emit ban also covers core/src, which runs inside the
    // CLI integration workers; cli/src gets the same selector folded into its
    // no-restricted-syntax block above. Separate block because flat config
    // replaces (does not merge) a rule's options across blocks, and cli/src
    // already owns a no-restricted-syntax block for the sensitive-parse ban.
    //
    // This block also forces all parsing of untrusted JSON (a partner wire
    // frame, a transport-controlled file, an invitation token) through the
    // single chokepoint in packages/core/src/utils/boundedJson.ts, which
    // structurally bounds the body before JSON.parse so a pathological object or
    // array cannot drive the parser into an uncatchable, process-terminating
    // abort. Banning the raw access here stops a new reader silently reopening
    // the crash at a fresh parse site.
    //
    // And it bans the raw YAML parsers: sensitiveFile.ts (the secret-redacting
    // chokepoint, parseSensitiveYaml / editSensitiveYamlDocument) was promoted
    // from apps/cli into core, so the same ban that guards apps/cli/src and
    // apps/web/src must guard core/src -- a raw YAML.parse leaks source bytes (a
    // credential) into its error and warning channels, and core is now where the
    // chokepoint and any future config reader live. The two chokepoint modules
    // are exempt (each owns its raw parser); tests are not matched. A genuinely
    // trusted/non-sensitive parse opts out with an eslint-disable-next-line
    // carrying a one-line why.
    files: ["packages/core/src/**/*.ts"],
    ignores: [
      "packages/core/src/utils/boundedJson.ts",
      "packages/core/src/sensitiveFile.ts",
    ],
    // Fail CI on a stray or rule-silencing disable so the ban cannot be quietly
    // turned off on an untrusted parse (a bare `eslint .` only warns).
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.object.name='YAML'][callee.property.name=/^(parse|parseDocument|parseAllDocuments)$/]",
          message:
            "Parse operator/credential files through packages/core/src/sensitiveFile.ts (parseSensitiveYaml / editSensitiveYamlDocument); raw YAML.parse leaks source into errors and the warning channel. Non-sensitive parse: eslint-disable-next-line with a one-line justification.",
        },
        noBareRootLoglevelEmit,
      ],
      // Close the named-import bypass (`import { parse } from "yaml"`); the
      // chokepoint imports the YAML default, so this never hits legitimate code.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "yaml",
              importNames: ["parse", "parseDocument", "parseAllDocuments"],
              message:
                "Parse operator/credential files through packages/core/src/sensitiveFile.ts; do not import yaml's raw parsers directly.",
            },
          ],
        },
      ],
      // no-restricted-properties (a property-access ban, not a CallExpression
      // selector) so the ban catches not just a direct `JSON.parse(...)` call
      // but also an alias `const p = JSON.parse`, a computed `JSON['parse']`,
      // and a destructured `const { parse } = JSON`. It does NOT catch a renamed
      // JSON object (`const J = JSON; J.parse(...)`) or `globalThis.JSON.parse`:
      // those need value-flow analysis, not a syntactic shape, and are left to
      // review (the cli sensitive-parse ban, a CallExpression selector, catches
      // strictly less). The runtime is clean -- the chokepoint owns the package's
      // only JSON.parse -- so this ban is regression-prevention, not a live hole.
      "no-restricted-properties": [
        "error",
        {
          object: "JSON",
          property: "parse",
          message:
            "Parse untrusted JSON (a partner frame, transport file, or invitation token) through packages/core/src/utils/boundedJson.ts (parseBoundedJson); it structurally bounds the body before JSON.parse so a pathological object/array cannot crash the parser. A trusted parse: eslint-disable-next-line with a one-line justification.",
        },
      ],
    },
  },
  ...scopeToDir("apps/web", webConfig),
);
