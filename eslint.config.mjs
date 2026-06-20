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
    // .psilink.key, the signing identity) through the single hardened chokepoint
    // in apps/cli/src/sensitiveFile.ts. The raw parsers leak source bytes -- a
    // credential -- into errors (YAML/JSON throw messages, parseDocument's
    // doc.errors and deferred-alias toString) and stderr (YAML's non-fatal
    // warnings). Routing through sensitiveFile.ts closes every channel in one
    // place; banning the raw calls here stops a new reader silently reopening any
    // of them. The chokepoint module itself is exempt (it owns the raw calls), as
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
    files: ["packages/core/src/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", noBareRootLoglevelEmit],
    },
  },
  ...scopeToDir("apps/web", webConfig),
);
