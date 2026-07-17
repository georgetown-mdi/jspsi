/**
 * Local ESLint rule guarding the filled-primary WCAG-AA contrast scope that
 * apps/web/src/theme.ts establishes.
 *
 * The theme routes a filled-primary Button / ActionIcon / Checkbox's text and
 * icon color through `--mantine-primary-color-contrast` (FILLED_PRIMARY_CONTRAST)
 * so it clears AA in both color schemes. That override is scoped by the theme's
 * `isFilledPrimary(variant, color)` predicate: it reaches only the default
 * (`filled`, no explicit `color`) surface. A surface authored with an explicit
 * `color` or a non-`filled` `variant` leaves that scope and paints on its own
 * color's shade with Mantine's color-scheme-blind text pick, which can fall below
 * the contrast floor without failing either the arithmetic theme test or the
 * render harness (neither samples call sites).
 *
 * This rule fails such a surface at authoring time. A surface passes when it is
 * filled-primary, or when its (variant, color) pair is one of the audited
 * secondary / status shapes below -- each a shape the app already uses whose text
 * does not ride the primary fill (a `default` / `outline` / `subtle` control
 * carries body text; a `light` / `subtle` status control carries its status
 * color's own AA-tuned text). Any other pair -- a filled surface with an explicit
 * color, or a variant/color combination not audited here -- is reported.
 */

const SURFACES = new Set(["Button", "ActionIcon", "Checkbox"]);
const MANTINE_MODULE = "@mantine/core";

/**
 * The theme's filled-primary predicate, kept byte-identical to
 * `isFilledPrimary` in apps/web/src/theme.ts (the ESLint runtime cannot import
 * theme.ts, which pulls in @mantine/core, so the two are locked equal by the
 * rule's unit test rather than by a shared import).
 */
export const isFilledPrimary = (variant, color) =>
  (variant === undefined || variant === "filled") && color === undefined;

/**
 * Audited secondary / status (variant, color) shapes whose text does not ride
 * the primary fill, so they need no filled-primary contrast route. A `color` of
 * `undefined` means "no explicit color". Extend only with a shape whose text
 * clears WCAG AA on its own; never add a filled surface with a color (its text
 * would ride that color's fill, the exact scope this rule guards).
 */
export const AUDITED_SECONDARY = [
  { variant: "default", color: undefined },
  { variant: "outline", color: undefined },
  { variant: "subtle", color: undefined },
  { variant: "subtle", color: "red" },
  { variant: "light", color: undefined },
  { variant: "light", color: "red" },
];

/**
 * Classify one resolved (variant, color) pair: `true` if it is filled-primary or
 * an audited secondary shape (allowed), `false` if it leaves the guarded scope.
 */
export const isAudited = (variant, color) =>
  isFilledPrimary(variant, color) ||
  AUDITED_SECONDARY.some(
    (shape) => shape.variant === variant && shape.color === color,
  );

/**
 * The set of string values an attribute's JSX value can take, or `undefined`
 * when it cannot be resolved to string literals (a non-literal expression the
 * rule must not silently pass). An absent attribute is caller-supplied as the
 * single value `undefined`.
 */
function resolvableValues(node) {
  if (node === null) return undefined;
  if (node.type === "Literal" && typeof node.value === "string") {
    return [node.value];
  }
  if (node.type === "JSXExpressionContainer") {
    return resolvableValues(node.expression);
  }
  if (node.type === "ConditionalExpression") {
    const consequent = resolvableValues(node.consequent);
    const alternate = resolvableValues(node.alternate);
    if (consequent === undefined || alternate === undefined) return undefined;
    return [...consequent, ...alternate];
  }
  return undefined;
}

const MESSAGE =
  "This {{name}} leaves the filled-primary contrast scope (isFilledPrimary in " +
  "apps/web/src/theme.ts): its text no longer routes through " +
  "FILLED_PRIMARY_CONTRAST and can fall below WCAG AA. Keep it filled-primary " +
  "(drop the explicit color / non-filled variant), or use one of the audited " +
  "secondary shapes. A new secondary/status shape whose text clears AA on its " +
  "own goes in AUDITED_SECONDARY in " +
  "apps/web/eslint-rules/filled-primary-contrast-scope.mjs.";

/** @type {import("eslint").Rule.RuleModule} */
export const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep a primary-action Button / ActionIcon / Checkbox inside the theme's filled-primary WCAG-AA contrast scope.",
    },
    schema: [],
    messages: { unscoped: MESSAGE },
  },
  create(context) {
    const mantineSurfaces = new Set();
    return {
      ImportDeclaration(node) {
        if (node.source.value !== MANTINE_MODULE) return;
        for (const spec of node.specifiers) {
          if (
            spec.type === "ImportSpecifier" &&
            SURFACES.has(spec.imported.name)
          ) {
            mantineSurfaces.add(spec.local.name);
          }
        }
      },
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier") return;
        const name = node.name.name;
        if (!mantineSurfaces.has(name)) return;

        let variantAttr;
        let colorAttr;
        for (const attr of node.attributes) {
          if (attr.type !== "JSXAttribute") continue;
          if (attr.name.name === "variant") variantAttr = attr;
          if (attr.name.name === "color") colorAttr = attr;
        }
        if (variantAttr === undefined && colorAttr === undefined) return;

        const variants =
          variantAttr === undefined
            ? [undefined]
            : resolvableValues(variantAttr.value);
        const colors =
          colorAttr === undefined
            ? [undefined]
            : resolvableValues(colorAttr.value);

        const unresolved = variants === undefined || colors === undefined;
        const escapes =
          unresolved ||
          variants.some((variant) =>
            colors.some((color) => !isAudited(variant, color)),
          );
        if (escapes) {
          context.report({
            node,
            messageId: "unscoped",
            data: { name },
          });
        }
      },
    };
  },
};

export default {
  rules: { "filled-primary-contrast-scope": rule },
};
