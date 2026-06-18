// eslint.config.js
import pluginRouter from "@tanstack/eslint-plugin-router";
import { tanstackConfig } from "@tanstack/eslint-config";

export default [
  {
    ignores: [
      "eslint.config.js",
      "src/contrib/**",
      ".output/**",
      ".nitro/**",
      ".tanstack/**",
      "dist/**",
    ],
  },
  ...tanstackConfig,
  ...pluginRouter.configs["flat/recommended"],
  {
    rules: {
      "sort-imports": [
        "error",
        {
          allowSeparatedGroups: true,
        },
      ],
    },
  },
  {
    // Pre-stage the sensitive-file parsing ban: the web app will gain YAML config
    // import/export and browser-stored configs/secrets. It parses no YAML today,
    // so this is a zero-cost tripwire -- the first YAML.parse / parseDocument (or
    // a yaml named import) fails CI and points the author at the chokepoint,
    // instead of silently reopening the credential-leak-via-parse channel in the
    // browser. The chokepoint (apps/cli/src/sensitiveFile.ts) must be promoted to
    // a shared module (packages/core) before web can route through it. JSON.parse
    // is not banned yet: the web app's existing JSON.parse is non-secret peer/wire
    // data; the JSON half lands with the browser secret-store work (tracked on the
    // board).
    files: ["src/**/*.{ts,tsx}"],
    // Fail CI on a stray or rule-silencing disable so the tripwire cannot be
    // quietly turned off on a sensitive parse (a bare `eslint .` only warns).
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.object.name='YAML'][callee.property.name=/^(parse|parseDocument|parseAllDocuments)$/]",
          message:
            "Parse operator/credential files through the sensitive-file chokepoint, not a raw YAML parser (it leaks source into errors). Promote apps/cli/src/sensitiveFile.ts to a shared module (packages/core) before parsing configs in the web app. See the board item for the web sensitive-file parsing work.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "yaml",
              importNames: ["parse", "parseDocument", "parseAllDocuments"],
              message:
                "Do not import yaml's raw parsers in the web app; route config parsing through the shared sensitive-file chokepoint (promote apps/cli/src/sensitiveFile.ts to packages/core first). See the board item for the web sensitive-file parsing work.",
            },
          ],
        },
      ],
    },
  },
  // Any other config...
];
