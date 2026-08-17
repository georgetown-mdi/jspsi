// Shared by the eslint meta-tests that lint through the real repo config: the
// type-aware layer (a TypeScript program plus the rules that need one) is
// stripped off before the config is used, so what a meta-test reports rests on
// the text it hands in and nothing else. See each caller's own header comment
// for what its ban is and why a type-aware rule is a hazard there.

// The parser options that put a TypeScript program behind the lint.
export const PROJECT_PARSER_OPTIONS = [
  "project",
  "projectService",
  "EXPERIMENTAL_useProjectService",
];

/** The first plugin registered under each prefix across a flat config array. */
export function pluginsByPrefix(configs) {
  const plugins = new Map();
  for (const entry of configs) {
    for (const [prefix, plugin] of Object.entries(entry.plugins ?? {})) {
      if (!plugins.has(prefix)) plugins.set(prefix, plugin);
    }
  }
  return plugins;
}

/**
 * The names in `rules` whose rule declares `requiresTypeChecking`, resolved
 * through `pluginFor(prefix)`. Asking the plugin keeps this off a hand-kept list
 * that a config or dependency change would silently outdate.
 */
export function typeAwareRuleNames(rules, pluginFor) {
  return Object.keys(rules).filter((name) => {
    const separator = name.lastIndexOf("/");
    if (separator === -1) return false;
    const rule = pluginFor(name.slice(0, separator))?.rules?.[
      name.slice(separator + 1)
    ];
    return rule?.meta?.docs?.requiresTypeChecking === true;
  });
}

/**
 * The repo's flat config with type-aware linting removed: no parser option that
 * builds a TypeScript program, and no rule that needs one.
 *
 * A caller's ban is never a type-aware rule -- nothing a type checker knows --
 * so every type-aware rule the web config enables is dead weight for it, and
 * dead weight with a failure mode: a rule reading types can crash inside
 * TypeScript's module-specifier computation on a real source, which is
 * sensitive to the absolute path the tree sits at and so fails under CI's
 * layout while passing here, over ground the caller does not test. Deriving
 * from the real config rather than hand-authoring a minimal one keeps the
 * caller's own blocks exact; dropping the type-aware layer leaves what a
 * caller reports resting on the text it hands in and nothing else. A
 * type-aware rule that survived the strip cannot lint silently: with no
 * project configured ESLint refuses to load it and the lint throws.
 */
export function withoutTypeAwareLayer(configs) {
  const plugins = pluginsByPrefix(configs);
  return configs.map((entry) => {
    const transformed = { ...entry };
    if (entry.languageOptions?.parserOptions) {
      transformed.languageOptions = {
        ...entry.languageOptions,
        parserOptions: Object.fromEntries(
          Object.entries(entry.languageOptions.parserOptions).filter(
            ([option]) => !PROJECT_PARSER_OPTIONS.includes(option),
          ),
        ),
      };
    }
    if (entry.rules) {
      const typeAware = new Set(
        typeAwareRuleNames(entry.rules, (prefix) => plugins.get(prefix)),
      );
      transformed.rules = Object.fromEntries(
        Object.entries(entry.rules).filter(([name]) => !typeAware.has(name)),
      );
    }
    return transformed;
  });
}
