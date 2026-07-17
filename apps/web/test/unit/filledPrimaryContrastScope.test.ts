import { describe, expect, it, test } from "vitest";

import { DEFAULT_THEME, mergeMantineTheme } from "@mantine/core";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";

import { mantineTheme } from "@theme";

import {
  AUDITED_SECONDARY,
  isAudited,
  isFilledPrimary,
  rule,
} from "../../eslint-rules/filled-primary-contrast-scope.mjs";

// The rule guards the theme's filled-primary contrast scope at authoring time.
// Its predicate must not drift from the theme's own `isFilledPrimary` scoping,
// which the ESLint runtime cannot import (theme.ts pulls in @mantine/core). These
// tests lock the two together against the theme's real vars resolvers -- the
// authoritative runtime scoping -- and exercise the rule over the JSX shapes it
// must accept and reject.

// Report each RuleTester case as its own vitest test.
RuleTester.describe = describe;
RuleTester.it = it;

const theme = mergeMantineTheme(DEFAULT_THEME, mantineTheme);

// The CSS variable each surface's vars override emits for a filled-primary
// instance (mirrors the wiring pinned in themeContrast.test.ts). A resolver
// emits it iff the theme scopes that (variant, color) as filled-primary.
const FILLED_PRIMARY_WIRING: Array<[string, string]> = [
  ["Button", "--button-color"],
  ["ActionIcon", "--ai-color"],
  ["Checkbox", "--checkbox-icon-color"],
];

const VARIANTS = [undefined, "filled", "default", "subtle", "light", "outline"];
const COLORS = [undefined, "red", "gray", "blue"];

describe("filled-primary contrast lint rule", () => {
  test("classifier matches the theme's own filled-primary scoping", () => {
    // Drive each component's real vars resolver over the variant x color matrix
    // and assert the rule's isFilledPrimary agrees with whether the resolver
    // routes text through the per-scheme contrast variable. Ties the rule to the
    // theme's runtime scoping instead of a duplicated literal, without importing
    // (or modifying) theme.ts's module-local predicate.
    for (const [name, cssVar] of FILLED_PRIMARY_WIRING) {
      const resolve = theme.components[name].vars;
      expect(resolve, `${name} vars override`).toBeDefined();
      for (const variant of VARIANTS) {
        for (const color of COLORS) {
          const props: Record<string, unknown> = {};
          if (variant !== undefined) props.variant = variant;
          if (color !== undefined) props.color = color;
          const routed = resolve!(theme, props, {}).root[cssVar] !== undefined;
          expect(
            isFilledPrimary(variant, color),
            `${name} variant=${variant} color=${color}`,
          ).toBe(routed);
        }
      }
    }
  });

  test("audited secondary shapes are never filled-primary", () => {
    // The allowlist only ever widens the guard past the filled-primary core; a
    // filled-primary shape must reach the theme's contrast route, not the
    // allowlist, so a shape landing in both would mean the allowlist had begun
    // shadowing the guarded scope.
    for (const shape of AUDITED_SECONDARY) {
      expect(
        isFilledPrimary(shape.variant, shape.color),
        `${shape.variant} / ${shape.color}`,
      ).toBe(false);
      expect(isAudited(shape.variant, shape.color)).toBe(true);
    }
  });

  const ruleTester = new RuleTester({
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
  });

  ruleTester.run("filled-primary-contrast-scope", rule, {
    valid: [
      // Filled-primary: default variant, no color (the guarded core).
      { code: `import { Button } from "@mantine/core"; <Button>Go</Button>;` },
      {
        code: `import { Button } from "@mantine/core"; <Button variant="filled">Go</Button>;`,
      },
      {
        code: `import { Checkbox } from "@mantine/core"; <Checkbox label="ok" />;`,
      },
      // Audited secondary / status shapes.
      {
        code: `import { Button } from "@mantine/core"; <Button variant="default">Reset</Button>;`,
      },
      {
        code: `import { Button } from "@mantine/core"; <Button variant="subtle" color="red">Remove</Button>;`,
      },
      {
        code: `import { Button } from "@mantine/core"; <Button variant="light" color="red">Try again</Button>;`,
      },
      {
        code: `import { ActionIcon } from "@mantine/core"; <ActionIcon variant="subtle">x</ActionIcon>;`,
      },
      // A conditional variant whose every branch is audited.
      {
        code: `import { Button } from "@mantine/core"; <Button variant={spent ? "default" : "subtle"}>Open</Button>;`,
      },
      // A same-named surface not imported from @mantine/core is out of scope.
      {
        code: `import { Button } from "./local"; <Button color="red" variant="filled">x</Button>;`,
      },
    ],
    invalid: [
      // Explicit color on a filled surface leaves the scope.
      {
        code: `import { Button } from "@mantine/core"; <Button color="red">Delete</Button>;`,
        errors: [{ messageId: "unscoped" }],
      },
      {
        code: `import { Button } from "@mantine/core"; <Button variant="filled" color="red">Delete</Button>;`,
        errors: [{ messageId: "unscoped" }],
      },
      // A variant/color pair outside the audited set.
      {
        code: `import { ActionIcon } from "@mantine/core"; <ActionIcon variant="filled" color="blue">i</ActionIcon>;`,
        errors: [{ messageId: "unscoped" }],
      },
      {
        code: `import { Checkbox } from "@mantine/core"; <Checkbox color="grape" />;`,
        errors: [{ messageId: "unscoped" }],
      },
      // A conditional variant with an unaudited branch.
      {
        code: `import { Button } from "@mantine/core"; <Button variant={x ? "filled" : "subtle"} color="red">x</Button>;`,
        errors: [{ messageId: "unscoped" }],
      },
      // A dynamic, unresolvable variant is not silently passed.
      {
        code: `import { Button } from "@mantine/core"; <Button variant={someVariant}>x</Button>;`,
        errors: [{ messageId: "unscoped" }],
      },
    ],
  });
});
