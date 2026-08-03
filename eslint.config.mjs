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

// The operator-facing display sinks this repo emits diagnostics through: the
// `console` methods, and a loglevel logger reached through the receivers used in
// core/src and cli/src -- a `log`/`logger` local, a `.log`/`.logger` field, a
// `deps.log()` accessor, or a getLogger(...) call emitted on directly.
const OPERATOR_DISPLAY_SINK =
  "CallExpression:matches(" +
  [
    "[callee.object.name='console']",
    "[callee.object.name=/^(log|logger)$/][callee.property.name=/^(trace|debug|info|warn|error)$/]",
    "[callee.object.property.name=/^(log|logger)$/][callee.property.name=/^(trace|debug|info|warn|error)$/]",
    "[callee.object.callee.property.name=/^(log|logger)$/][callee.property.name=/^(trace|debug|info|warn|error)$/]",
    "[callee.object.callee.name=/^getLogger(ForVerbosity)?$/][callee.property.name=/^(trace|debug|info|warn|error)$/]",
  ].join(", ") +
  ")";

// The three ways a raw error reaches display text: reading `.message` off it,
// coercing it (String(err), `${err}`, or handing the value straight to the
// sink), and the two message accessors -- core's exported `errorMessage` and the
// `errMessage` local the file-sync modules define.
const RAW_ERROR_RENDER =
  "MemberExpression[property.name='message'], " +
  "CallExpression[callee.name=/^(String|errorMessage|errMessage)$/], " +
  "Identifier[name=/^(e|err|error|cause)$|(Err|Error)$/]";

// Positions a value can occupy on its way into a sink call. Each is a DIRECT
// child of its enclosing node, which is what makes the ban precise: escaping
// wraps the value in sanitizeErrorForDisplay / sanitizeForDisplay, so a
// correctly escaped value puts that CallExpression in the position instead and
// the raw shape sits one level deeper, where this does not look.
const SINK_VALUE_POSITIONS = [
  "> .arguments",
  "TemplateLiteral > .expressions",
  "BinaryExpression[operator='+'] > .left",
  "BinaryExpression[operator='+'] > .right",
  "ConditionalExpression > .consequent",
  "ConditionalExpression > .alternate",
  "ArrowFunctionExpression > .body",
];

// Ban rendering a raw error at an operator-facing sink. Escaping happens at ONE
// altitude -- the sink -- so a fragment interpolated into an Error message is
// composed raw and sanitizeErrorForDisplay escapes the whole rendered chain
// once. That leaves the sink as the only place the escape can be omitted, and an
// omission there is silent: a partner-controlled error message carries the
// server's or the peer's bytes, so `log.warn(err.message)` puts ANSI, CR/LF,
// bidi overrides and confusables straight on the operator's terminal or into a
// --log-file.
//
// The selectors match the raw error where it sits directly in a sink argument:
// a `.message` read, a `String`/`errorMessage`/`errMessage` call, or a bare
// error-named identifier, each also inside a template literal, a ternary branch,
// or an arrow-function body. They do NOT follow a value through an intermediate
// local (`const m = errorMessage(err); log.warn(m)`), a method call on the
// message, or a container the sink unpacks -- a check that did would need the
// taint analysis TypeScript has no way to run. This bans the shapes a
// contributor writes by habit; it is not a proof that no raw error can reach a
// sink.
//
// Coverage is first-party source only. A dependency that writes the file
// descriptor itself -- ssh2-sftp-client's "Global ... listener" console lines --
// reaches the terminal without passing through any call this can see; the CLI
// integration console sentinel is the backstop for that half, and it is
// best-effort (see its module header).
const noRawErrorAtDisplaySink = SINK_VALUE_POSITIONS.map((position) => ({
  selector: `${OPERATOR_DISPLAY_SINK} ${position}:matches(${RAW_ERROR_RENDER})`,
  message:
    "Do not render a raw error at an operator-facing sink: pass it through sanitizeErrorForDisplay(err) (an error instance, cause chain included) or sanitizeForDisplay(text) (a single string fragment). A partner- or server-controlled error message reaches the terminal and any --log-file verbatim otherwise, carrying ANSI, CR/LF, bidi and confusable bytes. A value that is provably not error text: eslint-disable-next-line with a one-line justification.",
}));

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "apps/web/eslint.config.js",
      "scratch/**",
      ".claude/worktrees/**",
      "**/.rollup.cache/**",
      // A checked-in Workflow script is a script BODY the harness runs with
      // `args`, `agent`, and `parallel` injected, ending in a top-level return
      // that no ES module parser accepts. Prettier formats these files; their
      // agent() model pins are checked by `npm run check:workflow-agent-models`
      // and both are executed as function bodies by their colocated tests.
      "scripts/*-workflow.mjs",
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
        ...noRawErrorAtDisplaySink,
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
        ...noRawErrorAtDisplaySink,
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
