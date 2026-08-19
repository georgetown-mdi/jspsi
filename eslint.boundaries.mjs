// The monorepo's dependency direction as a lint rule rather than a convention:
// apps consume packages, packages never consume apps, and the two apps never
// reach into each other (CLAUDE.md). Kept in its own module because the ban has
// to be folded into several eslint blocks -- flat config replaces, rather than
// merges, a rule's options across blocks, so every block that sets
// no-restricted-imports for a guarded tree must re-carry these groups -- and
// those blocks are split across two config files: ESLint resolves the nearest
// config file for a subtree, so apps/web/eslint.config.js is what governs
// apps/web and the repo-root eslint.config.mjs governs the rest.
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
