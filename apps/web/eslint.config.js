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
    // The sensitive-file parsing ban for the web app. The credential-leak-via-
    // parse channel is real in the browser too -- a raw YAML parser echoes a span
    // of source into its error, and an imported config document an operator pastes
    // could hold a secret by mistake -- so raw `yaml` parsers are banned here:
    // route YAML/JSON parsing through the shared chokepoint now promoted to
    // packages/core (`@psilink/core`'s parseSensitiveYaml / parseSensitiveJson),
    // which reports path-only. `stringify` carries no such channel and is allowed.
    // JSON.parse is not banned yet: the web app's existing JSON.parse is
    // non-secret peer/wire data; the JSON half lands with the browser secret-store
    // work (tracked on the board).
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
            "Parse config/credential or imported documents through @psilink/core's sensitive-file chokepoint (parseSensitiveYaml / parseSensitiveJson), not a raw YAML parser (it leaks source into errors).",
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
                "Do not import yaml's raw parsers in the web app; route parsing through @psilink/core's parseSensitiveYaml / parseSensitiveJson (the shared sensitive-file chokepoint). yaml's `stringify` is allowed.",
            },
          ],
        },
      ],
    },
  },
  // Any other config...
];
