/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import "@mantine/core/styles.css";
import { Checkbox, MantineProvider, Radio } from "@mantine/core";

import { cssVariablesResolver, mantineTheme } from "@theme";

import type { ComponentType, ReactNode } from "react";
import type { Root } from "react-dom/client";

// Radio / Radio.Group / Checkbox are polymorphic factory components; the browser
// project globs `.ts` (no JSX), and createElement cannot resolve their overloaded
// types directly -- cast each to the plain shape this test renders.
const AppRadio = Radio as unknown as ComponentType<{
  value?: string;
  label?: ReactNode;
  description?: ReactNode;
}>;
const AppRadioGroup = Radio.Group as unknown as ComponentType<{
  label?: ReactNode;
  value?: string;
  children?: ReactNode;
}>;
const AppCheckbox = Checkbox as unknown as ComponentType<{
  label?: ReactNode;
  description?: ReactNode;
  checked?: boolean;
  "aria-label"?: string;
}>;

// Shaped like the app's real call sites: the KeysTab linkage-strategy radios (a
// per-option `description` inside a Radio.Group) and the AgreementTab legal-agreement
// checkbox (a `description` on a bare Checkbox).
const CASCADE_DESCRIPTION =
  "Keys run in order; a record matched by an earlier key is settled.";
const AGREEMENT_DESCRIPTION =
  "Reference, purpose, and expiry your partner must enter identically.";

let container: HTMLElement | undefined;
let root: Root | undefined;

function mount(node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    createElement(
      MantineProvider,
      // The app root (routes/__root.tsx) configures the provider with both the theme
      // and the cssVariablesResolver; render under the same config so a theme override
      // that broke the description association would fail here, not only raw Mantine.
      { theme: mantineTheme, cssVariablesResolver },
      node,
    ),
  );
}

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
});

async function waitForInput(selector: string): Promise<HTMLInputElement> {
  await expect.poll(() => container!.querySelector(selector)).not.toBeNull();
  return container!.querySelector(selector) as HTMLInputElement;
}

// Every id token in aria-describedby must resolve to a present element, and one of
// them must be the description element carrying the expected text. Asserting the
// relationship -- not the generated uuid -- is what survives a Mantine bump.
function expectDescribedBy(input: HTMLInputElement, descriptionText: string) {
  const describedBy = input.getAttribute("aria-describedby");
  expect(describedBy, "input has no aria-describedby").not.toBeNull();
  const ids = describedBy!.split(/\s+/).filter(Boolean);
  expect(ids.length).toBeGreaterThan(0);
  const described = ids.map((id) => document.getElementById(id));
  for (const el of described) expect(el).not.toBeNull();
  const texts = described.map((el) => el!.textContent);
  expect(texts).toContain(descriptionText);
}

describe("Mantine Radio/Checkbox description a11y association", () => {
  test("a Radio.Group option's description is aria-describedby the input", async () => {
    mount(
      createElement(
        AppRadioGroup,
        { label: "Linkage strategy", value: "cascade" },
        createElement(AppRadio, {
          value: "cascade",
          label: "Cascade",
          description: CASCADE_DESCRIPTION,
        }),
      ),
    );

    const input = await waitForInput('input[type="radio"][value="cascade"]');
    expectDescribedBy(input, CASCADE_DESCRIPTION);
  });

  test("a Checkbox's description is aria-describedby the input", async () => {
    mount(
      createElement(AppCheckbox, {
        label: "Attach a legal agreement",
        description: AGREEMENT_DESCRIPTION,
      }),
    );

    const input = await waitForInput('input[type="checkbox"]');
    expectDescribedBy(input, AGREEMENT_DESCRIPTION);
  });

  test("a Checkbox with no description carries no dangling aria-describedby", async () => {
    mount(
      createElement(AppCheckbox, {
        "aria-label": "Allow several records to match one partner record",
      }),
    );

    const input = await waitForInput('input[type="checkbox"]');
    const describedBy = input.getAttribute("aria-describedby");
    if (describedBy !== null)
      for (const id of describedBy.split(/\s+/).filter(Boolean))
        expect(document.getElementById(id)).not.toBeNull();
  });
});
