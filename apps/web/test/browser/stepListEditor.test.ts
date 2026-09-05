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
  const unfilledStart: EditableStep = {
    function: "substring",
    params: { length: 4 },
  };

  test("an unfilled substring start renders an inline alert tied to that input", async () => {
    app.render(
      createElement(StepListEditor, {
        steps: [unfilledStart],
        onStepsChange: () => {},
        addStepLabel: "Add a transform",
      }),
    );

    const start = page.getByRole("textbox", { name: "Start position" });
    await expect.element(start).toBeInTheDocument();
    // Exactly one inline error, with a message rather than an empty node.
    const alerts = page.getByRole("alert").elements();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].textContent.length).toBeGreaterThan(0);
    // And it is the START bound's: the offending input points at it through
    // aria-describedby, so the operator (and a screen reader) reaches the error
    // from the field that has to change, not from a message loose in the row.
    const describedBy = start.element().getAttribute("aria-describedby") ?? "";
    expect(describedBy.split(/\s+/)).toContain(alerts[0].id);
    // The bound that IS filled is not marked -- the mark attributes the fault.
    const filled = page
      .getByRole("textbox", { name: "Length" })
      .element()
      .getAttribute("aria-describedby");
    expect(filled === null ? [] : filled.split(/\s+/)).not.toContain(
      alerts[0].id,
    );
  });

  test("a window that reads something has no inline error", async () => {
    // Not vacuous: the mark above is the unfilled bound's, not every substring's.
    app.render(
      createElement(StepListEditor, {
        steps: [{ function: "substring", params: { start: 2, length: 4 } }],
        onStepsChange: () => {},
        addStepLabel: "Add a transform",
      }),
    );

    await expect
      .element(page.getByRole("textbox", { name: "Start position" }))
      .toBeInTheDocument();
    expect(page.getByRole("alert").elements()).toHaveLength(0);
  });
});
