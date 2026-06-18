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
            "Parse operator/credential files through apps/cli/src/sensitiveFile.ts (parseSensitiveYaml / parseSensitiveYamlDocument); raw YAML.parse leaks source into errors and stderr. Non-sensitive parse: eslint-disable-next-line with a one-line justification.",
        },
        {
          selector:
            "CallExpression[callee.object.name='JSON'][callee.property.name='parse']",
          message:
            "Parse credential files through apps/cli/src/sensitiveFile.ts (parseSensitiveJson); raw JSON.parse can echo a leading span of the source. Non-sensitive parse: eslint-disable-next-line with a one-line justification.",
        },
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
  ...scopeToDir("apps/web", webConfig),
);
