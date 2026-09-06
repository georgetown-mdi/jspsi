/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import { StepListEditor } from "@components/StepListEditor";

import { createAppMount } from "./renderApp";

import type { EditableStep } from "@components/StepListEditor";

const app = createAppMount();

afterEach(app.unmount);

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
    app.render(
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
    app.render(
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

// Core's window validation rejects a dead end with a refusal naming the key;
// getting from that refusal to a marked element, step, and bound is this
// render's job. ParamInput keeps its own copy of the empty/optional rule
// `isStepValid` composes, so the invariant checked in
// advancedInviteValidation.test.ts (every dead window is one the descriptors
// reject) reaches the operator only while this copy still marks the input.
describe("StepListEditor: a bound left unfilled is marked on its own input", () => {
  const START = "Start position";
  const LENGTH = "Length";

  // Every window shape core grades dead, each paired with the bound (or bounds)
  // whose input has to change. Held as a set rather than one representative
  // because the mark attributes the fault, and which bound it lands on is what
  // the operator acts on.
  const deadWindows: Array<{
    shape: string;
    params: Record<string, number>;
    marked: Array<string>;
  }> = [
    { shape: "no bounds at all", params: {}, marked: [START, LENGTH] },
    { shape: "a cleared start", params: { length: 4 }, marked: [START] },
    { shape: "a cleared length", params: { start: 2 }, marked: [LENGTH] },
    { shape: "a start of 0", params: { start: 0, length: 4 }, marked: [START] },
    {
      shape: "a length of 0",
      params: { start: 2, length: 0 },
      marked: [LENGTH],
    },
  ];

  test.each(deadWindows)(
    "$shape marks $marked and nothing else",
    async ({ params, marked }) => {
      app.render(
        createElement(StepListEditor, {
          steps: [{ function: "substring", params }],
          onStepsChange: () => {},
          addStepLabel: "Add a transform",
        }),
      );

      await expect
        .element(page.getByRole("textbox", { name: START }))
        .toBeInTheDocument();
      // One inline error per marked bound, each with a message rather than an
      // empty node.
      const alerts = page.getByRole("alert").elements();
      expect(alerts).toHaveLength(marked.length);
      for (const alert of alerts)
        expect(alert.textContent.length).toBeGreaterThan(0);

      // Each marked bound points at one of them through aria-describedby, so the
      // operator (and a screen reader) reaches the error from the field that has
      // to change rather than from a message loose in the row -- and a bound that
      // is fine points at none, which is what makes the mark attribute the fault.
      const alertIds = new Set(alerts.map((alert) => alert.id));
      for (const label of [START, LENGTH]) {
        const describedBy =
          page
            .getByRole("textbox", { name: label })
            .element()
            .getAttribute("aria-describedby") ?? "";
        const described = describedBy
          .split(/\s+/)
          .filter((id) => alertIds.has(id));
        expect(described.length > 0).toBe(marked.includes(label));
      }
    },
  );

  test("a window that reads something has no inline error", async () => {
    // Not vacuous: the mark above is the dead window's, not every substring's.
    app.render(
      createElement(StepListEditor, {
        steps: [{ function: "substring", params: { start: 2, length: 4 } }],
        onStepsChange: () => {},
        addStepLabel: "Add a transform",
      }),
    );

    await expect
      .element(page.getByRole("textbox", { name: START }))
      .toBeInTheDocument();
    expect(page.getByRole("alert").elements()).toHaveLength(0);
  });
});
