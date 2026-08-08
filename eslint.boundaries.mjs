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
// (`../../web/src/x`). ESLint matches these groups gitignore-style, so a `..`
// is an ordinary path segment and a bare name matches the subtree beneath it.
//
// Scope: static import and export specifiers, which is every cross-workspace
// reference this repo writes. A specifier assembled at runtime and handed to a
// dynamic `import()` is invisible to any rule that matches on the specifier
// text, so this is a ban on the shapes a contributor writes, not a proof that
// the workspace graph is acyclic.

const CORE_MESSAGE =
  "packages/core must not import from an app: apps consume @psilink/core, never the reverse. Move the shared code into packages/core/src and import it from the app.";

const CLI_MESSAGE =
  "apps/cli must not import from apps/web: the two apps share code only through @psilink/core. Move the shared code into packages/core/src.";

const WEB_MESSAGE =
  "apps/web must not import from apps/cli: the two apps share code only through @psilink/core. Move the shared code into packages/core/src.";

/**
 * Cross-workspace import bans, keyed by the workspace each one guards. Every
 * value is a `no-restricted-imports` `patterns` array.
 */
export const crossWorkspaceImportBans = {
  core: [{ group: ["**/apps/**", "psilink", "jspsi"], message: CORE_MESSAGE }],
  cli: [
    {
      group: ["**/apps/web/**", "**/../web/**", "jspsi"],
      message: CLI_MESSAGE,
    },
  ],
  web: [
    {
      group: ["**/apps/cli/**", "**/../cli/**", "psilink"],
      message: WEB_MESSAGE,
    },
  ],
};
