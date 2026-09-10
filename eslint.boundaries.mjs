// The lint rules both eslint config files apply. ESLint resolves the nearest
// config file for a subtree, so apps/web/eslint.config.js is what governs
// apps/web and the repo-root eslint.config.mjs governs the rest; a rule that
// has to hold in both places is written once here and imported by each. Flat
// config also replaces, rather than merges, a rule's options across blocks, so
// every block that sets one of these rules for a guarded tree must re-carry the
// whole option value -- another reason each lives in a named export rather than
// inline in one block.
//
// The cross-workspace import ban is the monorepo's dependency direction as a
// lint rule rather than a convention: apps consume packages, packages never
// consume apps, and the two apps never reach into each other (CLAUDE.md).
//
// npm workspaces symlinks each workspace into the root node_modules, so the app
// package names `psilink` (apps/cli) and `jspsi` (apps/web) resolve as bare
// specifiers from anywhere in the tree: the ban covers those names, not only
// relative paths.
//
// Two relative shapes reach another workspace, and each needs its own group.
// A path that climbs past `apps/` names it (`../../../apps/web/src/x`); the
// climb between the two sibling apps never names `apps` at all
// (`../../web/src/x`). ESLint matches these groups gitignore-style: a `..` is
// an ordinary path segment, and `dir/**` matches only strictly beneath
// `dir`, so each shape carries the bare directory as its own pattern. The bare
// form is more than a text shape: apps/web declares a `main`, so `../../web`
// from apps/cli resolves to the app.
//
// The ban reads specifier text, never a resolved path: a climb into a directory
// literally named `web` under apps/cli (or `cli` under apps/web) is refused even
// though it stays inside its own app. Neither app has such a directory. If one
// appears, rename it or scope an eslint override to it -- the local climb and
// the cross-app climb are the same text, so a pattern that admits one admits
// the other.
//
// Scope: static import and export specifiers, which is every cross-workspace
// reference this repo writes. A specifier assembled at runtime and handed to a
// dynamic `import()` is invisible to any rule that matches on the specifier
// text, so this is a ban on the shapes a contributor writes, not a proof that
// the workspace graph is acyclic.

const PACKAGE_MESSAGE =
  "a package must not import from an app: apps consume packages, never the reverse. Move the shared code into a packages/ workspace and import it from the app.";

const CLI_MESSAGE =
  "apps/cli must not import from apps/web: the two apps share code only through @psilink/core. Move the shared code into packages/core/src.";

const WEB_MESSAGE =
  "apps/web must not import from apps/cli: the two apps share code only through @psilink/core. Move the shared code into packages/core/src.";

/**
 * Cross-workspace import bans, keyed by the tree each one guards -- `packages`
 * covers every workspace under `packages/`, since the direction it enforces is
 * the same for all of them. Every value is a `no-restricted-imports` `patterns`
 * array.
 */
export const crossWorkspaceImportBans = {
  packages: [
    { group: ["**/apps/**", "psilink", "jspsi"], message: PACKAGE_MESSAGE },
  ],
  cli: [
    {
      group: [
        "**/apps/web",
        "**/apps/web/**",
        "**/../web",
        "**/../web/**",
        "jspsi",
      ],
      message: CLI_MESSAGE,
    },
  ],
  web: [
    {
      group: [
        "**/apps/cli",
        "**/apps/cli/**",
        "**/../cli",
        "**/../cli/**",
        "psilink",
      ],
      message: WEB_MESSAGE,
    },
  ],
};

// Ban emitting through loglevel's bare root logger (the `logLibrary` default
// import). Two things hold only for a NAMED logger built through core's
// getLogger / getLoggerForVerbosity. Its prefixed method is where private-key
// material is stripped out of string arguments and the `[timestamp] [LEVEL]
// [context]` prefix is added (packages/core/src/utils/logger.ts). And in source
// that runs inside the CLI integration workers, the suite's two leak-detection
// safety checks -- the console sentinel and the withCapturedLogs capture --
// observe named loggers only: a named logger binds the sentinel-wrapped console
// (and the capture interceptor) at getLogger time, whereas the eager capture
// install rebinds the root logger against the raw, pre-sentinel console
// (capturedLogs.setup.ts runs before the sentinel wraps console). A bare
// `logLibrary.<level>(...)` escapes both, so this rule is the executable form of
// the prose the eager-install ordering rests on -- "nothing emits through the
// bare root logger".
//
// Keying on the `logLibrary` identifier is exact in core/src and cli/src, where
// the loglevel default is uniformly imported under that name and is never a
// named-logger variable. apps/web binds its named loggers to `log`, and closes
// the alias route -- the loglevel default imported under any other name -- with
// the import ban in apps/web/eslint.config.js.
/** A `no-restricted-syntax` entry banning `logLibrary.<level>(...)`. */
export const noBareRootLoglevelEmit = {
  selector:
    "CallExpression[callee.object.name='logLibrary'][callee.property.name=/^(trace|debug|info|warn|error)$/]",
  message:
    "Do not emit through the bare root logger (logLibrary.<level>()): a root emit skips the context prefix and the private-key redaction core's prefixed logger applies, and the CLI integration console sentinel and withCapturedLogs capture see named loggers only, so it escapes both leak-detection checks. Use getLogger / getLoggerForVerbosity; logLibrary is for setLevel / levels / getLogger only.",
};
