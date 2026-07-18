// eslint.config.js
import pluginRouter from "@tanstack/eslint-plugin-router";
import { tanstackConfig } from "@tanstack/eslint-config";
import filledPrimaryContrastScope from "./eslint-rules/filled-primary-contrast-scope.mjs";

// The sensitive-file YAML-parse ban (shared by the broad block and the rawRows
// allowlist block, since flat config replaces -- does not merge -- a rule's options,
// so the allowlist block must re-carry it).
const sensitiveYamlParseBan = {
  selector:
    "CallExpression[callee.object.name='YAML'][callee.property.name=/^(parse|parseDocument|parseAllDocuments)$/]",
  message:
    "Parse config/credential or imported documents through @psilink/core's sensitive-file chokepoint (parseSensitiveYaml / parseSensitiveJson), not a raw YAML parser (it leaks source into errors).",
};

// Confine reads of an acquired CSV's `rawRows` to the enumerated file-intake, draft,
// and coverage/preview consumers. The console acquires only a server-side profile
// (row count, date format, column samples) and never the rows, so its acquired shape
// exposes `rawRows` as a getter that throws in dev/test; this restriction is the
// static half of that backstop, catching a new `.rawRows` reader at lint time rather
// than at a stray runtime throw. A legitimate new consumer is added to
// `rawRowsConsumers` below (and reviewed), never silenced inline.
const rawRowsAccessBan = {
  selector: "MemberExpression[property.name='rawRows']",
  message:
    "Read `.rawRows` only in the enumerated consumers (see rawRowsConsumers in apps/web/eslint.config.js). The console acquired CSV has no rows (a throwing getter); author from the profiled rowCount / dateInputFormat / column samples instead. If this is a legitimate new rawRows consumer, add its file to rawRowsConsumers.",
};

// The files that legitimately read `.rawRows`: the hosted file-intake and draft
// consumers plus the exchange-run and coverage-worker internals that read rawRows off
// non-acquired shapes (a prepared/minted invitation, a worker request, the
// controller's own field).
const rawRowsConsumers = [
  "src/bench/inviterModel.ts",
  "src/bench/AcceptorBench.tsx",
  "src/bench/InviterBench.tsx",
  "src/bench/runOutputs.ts",
  "src/bench/useInviterExchange.ts",
  "src/psi/nonEmptyAggregate.worker.ts",
  "src/psi/nonEmptyAggregateController.ts",
];

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
    plugins: { "filled-primary-contrast": filledPrimaryContrastScope },
    rules: {
      "filled-primary-contrast/filled-primary-contrast-scope": "error",
      "no-restricted-syntax": [
        "error",
        sensitiveYamlParseBan,
        rawRowsAccessBan,
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
  {
    // The enumerated rawRows consumers keep the sensitive-parse ban but are exempt
    // from the rawRows-access ban. A separate block (not an `ignores`) because flat
    // config replaces a rule's whole options across blocks: re-setting
    // no-restricted-syntax to the YAML ban alone drops the rawRows selector for these
    // files while the broad block above still applies it everywhere else.
    files: rawRowsConsumers,
    rules: {
      "no-restricted-syntax": ["error", sensitiveYamlParseBan],
    },
  },
  // Any other config...
];
