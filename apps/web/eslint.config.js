// eslint.config.js
import pluginRouter from "@tanstack/eslint-plugin-router";
import { tanstackConfig } from "@tanstack/eslint-config";
import filledPrimaryContrastScope from "./eslint-rules/filled-primary-contrast-scope.mjs";
import { crossWorkspaceImportBans } from "../../eslint.boundaries.mjs";

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

// Every seat that hands the exchange driver an `onWarning` slot must fold the
// message through `appendSanitizedRunWarning` (src/bench/runWarnings.ts), the one
// display boundary the console's run surfaces share. The manager's own preflight
// warnings are composed RAW precisely because that boundary escapes them exactly
// once: a seat that escaped again would show one backslash in a partner filename as
// four, and a seat that escaped not at all would put a partner's ESC, bidi override,
// or confusable straight into the operator's page. Neither failure is visible in a
// unit test of the boundary itself -- both are a seat routing AROUND it -- so this is
// the executable form of that routing, which was prose until it was a rule.
//
// The bound is the call shape: an `onWarning` property of an object LITERAL --
// keyed plainly, quoted, or computed -- whose value is a function literal or a
// named reference. A function literal has to name the boundary somewhere in its
// body, so a seat that reaches the boundary through an intermediate helper reads as
// a violation (add the helper's own site, do not silence it) and one that merely
// mentions the name without folding through it reads as clean; a named reference
// reads as a violation on sight, since a selector cannot follow it to the body. A
// type declaration and a destructuring pattern are not seats and are not matched.
//
// One bypass shape stays open: a bare shorthand `{ onWarning }`. A seat forwarding a
// slot its own caller owns -- a prop, or the handler the driver destructured -- is
// written exactly that way, and telling it from a locally-defined handler needs
// scope, which a selector does not have. Every shape that IS matched is pinned case
// by case in scripts/eslint-seat-warning-sink-ban.test.mjs.
const seatWarningSinkBan = {
  selector:
    "ObjectExpression > Property" +
    ":matches([key.name='onWarning'],[key.value='onWarning'])" +
    ":not([shorthand=true])" +
    "[value.type=/^(ArrowFunctionExpression|FunctionExpression|Identifier|MemberExpression)$/]" +
    ":not(:has(CallExpression[callee.name='appendSanitizedRunWarning']))",
  message:
    "Fold an onWarning message through appendSanitizedRunWarning (src/bench/runWarnings.ts): it is the one display boundary the run surfaces share, and the manager composes its warnings raw because that boundary escapes them exactly once.",
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
    // The web app's half of the workspace-boundary ban, covering test and
    // build-config sources as well as src. It lives here rather than in the
    // repo-root config because ESLint resolves the nearest config file for a
    // subtree, so this file -- not eslint.config.mjs -- is what governs
    // apps/web. The src block below re-carries the same groups.
    files: ["**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: crossWorkspaceImportBans.web },
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
        seatWarningSinkBan,
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
          // Re-carried from the boundary block above, which this block would
          // otherwise replace for src/ (flat config replaces a rule's options).
          patterns: crossWorkspaceImportBans.web,
        },
      ],
    },
  },
  {
    // The app-shell service worker is a classic (non-module) script served as a
    // static asset from public/: it declares globals rather than exports, so the
    // shared config's `sourceType: "module"` would misread its top level. It is
    // linted rather than ignored -- a fetch interceptor in front of the whole
    // origin is the last file that should go unlinted -- which is also why
    // apps/web/tsconfig.json lists it, since the shared config's type-aware
    // rules need it inside the project. The browser globals the shared config
    // supplies cover everything it touches; the service-worker extras
    // (skipWaiting, clients) it reaches through `self`.
    files: ["public/serviceWorker.js"],
    languageOptions: { sourceType: "script" },
  },
  {
    // The enumerated rawRows consumers keep the sensitive-parse and warning-sink
    // bans but are exempt from the rawRows-access ban. A separate block (not an
    // `ignores`) because flat config replaces a rule's whole options across blocks:
    // re-setting no-restricted-syntax to a subset drops the other selectors for these
    // files while the broad block above still applies them everywhere else. One of
    // these files (useInviterExchange.ts) is a warning seat, so dropping the
    // warning-sink ban here would leave a quarter of the seats uncovered.
    files: rawRowsConsumers,
    rules: {
      "no-restricted-syntax": [
        "error",
        sensitiveYamlParseBan,
        seatWarningSinkBan,
      ],
    },
  },
  // Any other config...
];
