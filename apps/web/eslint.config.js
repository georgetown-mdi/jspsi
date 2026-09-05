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

// The raw-YAML-parser import ban (shared by the src block and the linkage-compare
// block below, for the same replace-not-merge reason).
const rawYamlParserImportBan = {
  name: "yaml",
  importNames: ["parse", "parseDocument", "parseAllDocuments"],
  message:
    "Do not import yaml's raw parsers in the web app; route parsing through @psilink/core's parseSensitiveYaml / parseSensitiveJson (the shared sensitive-file chokepoint). yaml's `stringify` is allowed.",
};

// Hold the draft-side rule-set membership compares at the one chokepoint that
// prunes explicitly-`undefined` optional properties first, src/psi/linkageComparison.ts
// (exempted below, since it is the module that calls core). Core answers these
// questions by byte equality under the canonical encoding, which rejects an explicit
// `undefined` where it accepts an absent property -- and a draft is live objects the
// editor rebuilds, where a spread restates an unset property as `undefined`. So a
// direct import of core's predicate reads a key that says exactly what the offer says
// as a non-match, dropping its opt-in badge on the bench and its rule-set citation
// from the built terms: a partner-visible provenance claim lost over a property that
// says nothing. The failure is silent at the call site, which is why the routing is a
// rule rather than a note in the module.
const linkageComparisonChokepointBan = {
  name: "@psilink/core",
  importNames: [
    "encodeForComparison",
    "isDrawnFromLinkageRuleSet",
    "isOptInLinkageKey",
    "linkageRuleSetReferenceFor",
  ],
  message:
    "Ask rule-set membership about a draft through src/psi/linkageComparison.ts (encodeKeyForComparison / isOptInDraftKey / isDraftDrawnFromLinkageRuleSet / linkageRuleSetReferenceForDraft, re-exported from @psi/advancedInvite), not core's strict predicates: those compare by canonical byte equality, which reads an explicitly-`undefined` optional property -- what a draft rebuild spreads in -- as a difference and silently drops the key's opt-in badge and the terms' rule-set citation.",
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
// message through `appendSanitizedRunWarning` (src/psi/runWarnings.ts), the one
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
    "Fold an onWarning message through appendSanitizedRunWarning (src/psi/runWarnings.ts): it is the one display boundary the run surfaces share, and the manager composes its warnings raw because that boundary escapes them exactly once.",
};

// The files that legitimately read `.rawRows`: the hosted file-intake and draft
// consumers plus the exchange-run and coverage-worker internals that read rawRows off
// non-acquired shapes (a prepared/minted invitation, a worker request, the
// controller's own field).
const rawRowsConsumers = [
  "src/exchange/AcceptorScreen.tsx",
  "src/exchange/InviterScreen.tsx",
  "src/exchange/useInviterExchange.ts",
  "src/psi/inviterModel.ts",
  "src/psi/nonEmptyAggregate.worker.ts",
  "src/psi/nonEmptyAggregateController.ts",
  "src/psi/runOutputs.ts",
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
    // The sensitive-file parsing ban for the web app, covering the browser bundle
    // (src/) and the server boot code (server/) it shares the credential-leak-via-
    // parse channel with -- a raw YAML parser echoes a span of source into its
    // error, and an imported config document an operator pastes could hold a
    // secret by mistake -- so raw `yaml` parsers are banned here: route YAML/JSON
    // parsing through the shared chokepoint now promoted to packages/core
    // (`@psilink/core`'s parseSensitiveYaml / parseSensitiveJson), which reports
    // path-only. `stringify` carries no such channel and is allowed.
    files: ["src/**/*.{ts,tsx}", "server/**/*.ts"],
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
          paths: [rawYamlParserImportBan],
          // Re-carried from the boundary block above, which this block would
          // otherwise replace for src/ (flat config replaces a rule's options).
          patterns: crossWorkspaceImportBans.web,
        },
      ],
    },
  },
  {
    // The raw-JSON.parse ban for the web app, over the two trees its files list
    // names: src/ and server/. src/ is not only the browser bundle -- the
    // console server's own code lives there too (src/jobs, and the API route
    // handlers under src/routes/api), and a request body is the untrusted input
    // the ban exists for. server/ is the Nitro entry and its upgrade hardening,
    // which reach the socket earlier still. The test tree is outside the ban,
    // parsing fixtures it wrote itself. Raw `JSON.parse` is banned in the
    // no-restricted-properties form packages/core/src and apps/cli/src already
    // use, which also catches an alias, a computed access, and a destructure. A
    // request body, a relayed CLI line, and a persisted record are input this
    // app did not produce, so each is parsed through `@psilink/core`'s
    // parseBoundedJson; its bound and the rationale for it are in
    // packages/core/src/utils/boundedJson.ts and docs/spec/CHANNEL_SECURITY.md.
    // A parse of a value this process serialized itself opts out with an
    // eslint-disable-next-line carrying a one-line why.
    //
    // Beside it, the `json` ban closes ONE route to a fetched body: the platform
    // `.json()`, which a JSON.parse ban does not see, since that parse happens
    // inside the method. It does not reach a `response.text()` or
    // `response.arrayBuffer()` read, each of which buffers the whole body before
    // any parse; what a client takes instead of either is the bounded read in
    // src/psi/jobApiBody.ts, and docs/spec/SERVER_JOB_API.md (Size caps) states
    // that limit. It is a property ban with no object name, because the receiver
    // of a `.json()` is a variable a selector cannot resolve -- so it also
    // matches `Response.json()` the response builder, which this app does not
    // use (it builds responses through `jobJsonResponse`). Nothing under src/ or
    // server/ reads a `.json` property for any other reason, so the ban has no
    // standing exemption.
    files: ["src/**/*.{ts,tsx}", "server/**/*.ts"],
    // Fail CI on a stray or rule-silencing disable so an untrusted parse cannot
    // be quietly exempted (a bare `eslint .` only warns). The sibling block above
    // already sets this for the same files; restated so the ban keeps it if that
    // block's file list ever narrows.
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "JSON",
          property: "parse",
          message:
            "Parse JSON this app did not produce -- a request body, a relayed CLI line, a persisted record -- through @psilink/core's parseBoundedJson (a secret-bearing document through parseSensitiveJson); a raw JSON.parse is unbounded and can echo a leading span of the source. A value this process serialized itself: eslint-disable-next-line with a one-line justification.",
        },
        {
          property: "json",
          message:
            "Read a fetched body through the bounded read in src/psi/jobApiBody.ts (readBoundedJson / readJsonOrNull, under the cap the endpoint's answer needs); Response.json() buffers whatever the server sends and hands it to a raw JSON.parse. A read that genuinely needs neither: eslint-disable-next-line with a one-line justification.",
        },
      ],
    },
  },
  {
    // The linkage-compare chokepoint ban, everywhere under src/ but the chokepoint
    // itself. A block of its own rather than an `ignores` on the block above,
    // because that block carries rules linkageComparison.ts must keep (the
    // sensitive-parse ban, the warning-sink ban, the contrast-scope rule); this one
    // re-carries only the two import groups, so the chokepoint file falls back to
    // the block above for those.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/psi/linkageComparison.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [rawYamlParserImportBan, linkageComparisonChokepointBan],
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
