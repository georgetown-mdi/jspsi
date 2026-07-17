import type { Rule } from "eslint";

/** The theme's filled-primary predicate, held equal to `isFilledPrimary` in
 * apps/web/src/theme.ts by the rule's unit test. */
export function isFilledPrimary(
  variant: string | undefined,
  color: string | undefined,
): boolean;

/** Audited secondary / status (variant, color) shapes the rule allows past the
 * filled-primary core. */
export const AUDITED_SECONDARY: ReadonlyArray<{
  variant: string;
  color: string | undefined;
}>;

/** True when a resolved (variant, color) pair is filled-primary or audited. */
export function isAudited(
  variant: string | undefined,
  color: string | undefined,
): boolean;

export const rule: Rule.RuleModule;

declare const plugin: { rules: Record<string, Rule.RuleModule> };
export default plugin;
