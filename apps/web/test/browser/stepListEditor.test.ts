/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import { StepListEditor } from "@components/StepListEditor";

import type { EditableStep } from "@components/StepListEditor";
import type { Root } from "react-dom/client";

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
});

function render(node: ReturnType<typeof createElement>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(createElement(MantineProvider, null, node));
}

// The cross-party trust boundary: the token-embedded key-element transform editor
// (ExpertKeyEditor) drives StepListEditor with NO `allowRawPatterns`, so a
// partner-authored regex must render read-only and the regex family must not be
// offered to add. This pins that OFF state -- the security-relevant default. The
// per-party ON state (raw patterns authorable) is covered by
// standardizationStepEditor.test.ts.
describe("StepListEditor: a token-embedded regex stays read-only without allowRawPatterns", () => {
  const regexStep: EditableStep = {
    function: "filter_regex",
    params: { pattern: "ZZTOPMARK" },
  };

  test("an existing regex step is read-only (no editable pattern), marked advanced", async () => {
    render(
      createElement(StepListEditor, {
        steps: [regexStep],
        onStepsChange: () => {},
        addStepLabel: "Add a transform",
      }),
    );

    // The step renders, marked "advanced", with its pattern shown as a read-only
    // monospace note -- never an editable field.
    await expect.element(page.getByText("advanced")).toBeInTheDocument();
    await expect
      .element(page.getByText(/pattern: ZZTOPMARK/))
      .toBeInTheDocument();
    // No textbox exists on this surface: the partner-authored pattern cannot be
    // changed. (With allowRawPatterns the pattern would be an editable TextInput.)
    expect(page.getByRole("textbox").elements()).toHaveLength(0);
  });

  test("the raw-pattern family is not offered in the add menu", async () => {
    render(
      createElement(StepListEditor, {
        steps: [],
        onStepsChange: () => {},
        addStepLabel: "Add a transform",
      }),
    );

    await page.getByRole("button", { name: "Add a transform" }).click();
    // The standard menu opened...
    await expect.element(page.getByText("Letter case")).toBeInTheDocument();
    // ...but the raw-pattern (regex) group is absent: regex cannot be added here.
    expect(page.getByText("Raw patterns (advanced)").elements()).toHaveLength(
      0,
    );
  });
});
