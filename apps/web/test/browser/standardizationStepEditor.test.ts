/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";

import { StandardizationPreview } from "@components/StandardizationPreview";
import { StandardizationStepEditor } from "@components/StandardizationStepEditor";
import { columnSamplesFromRows } from "@psi/columnSamples";

import { renderApp } from "./renderApp";

import type { Root } from "react-dom/client";

import type { LinkageField, StandardizationStep } from "@psilink/core";

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
  root.render(renderApp(node));
}

const FIRST_NAME: LinkageField = { name: "fn", type: "first_name" };

// The preview takes the per-column sample map the console profiles server-side; each
// case builds that map from its rows with columnSamplesFromRows, so it exercises the
// component with a fixed, resolved sample.
function previewElement(props: {
  field: LinkageField;
  inputColumn: string;
  steps: Array<StandardizationStep>;
  rawRows: Array<Record<string, string>>;
}) {
  const { rawRows, inputColumn, ...rest } = props;
  return createElement(StandardizationPreview, {
    ...rest,
    inputColumn,
    columnSamples: columnSamplesFromRows(rawRows, [inputColumn]),
  });
}

// A stateful harness that wires the editor to the preview through one steps state,
// mirroring how the "Prepare your data" screen docks them: an edit in the editor
// re-runs the preview's pipeline. The cleaned value lives in the preview's
// outcome cell (scoped by test id below) so it never collides with the raw value
// echoed in the "Original" column.
function EditorWithPreview({
  field,
  inputColumn,
  initialSteps,
  rawRows,
}: {
  field: LinkageField;
  inputColumn: string;
  initialSteps: Array<StandardizationStep>;
  rawRows: Array<Record<string, string>>;
}) {
  const [steps, setSteps] = useState(initialSteps);
  return createElement(
    "div",
    null,
    createElement(StandardizationStepEditor, {
      fieldLabel: "First name",
      inputColumn,
      steps,
      onStepsChange: setSteps,
    }),
    previewElement({
      field,
      inputColumn,
      steps,
      rawRows,
    }),
  );
}

describe("StandardizationPreview renders each pipeline outcome distinctly", () => {
  test("a cleaned value", async () => {
    render(
      previewElement({
        field: FIRST_NAME,
        inputColumn: "n",
        steps: [{ function: "to_upper_case" }],
        rawRows: [{ n: "mary" }],
      }),
    );
    await expect
      .element(page.getByTestId("outcome-value"))
      .toHaveTextContent("MARY");
  });

  test("a dropped (null) value", async () => {
    render(
      previewElement({
        field: FIRST_NAME,
        inputColumn: "n",
        steps: [{ function: "null_if", params: { values: ["mary"] } }],
        rawRows: [{ n: "mary" }],
      }),
    );
    await expect
      .element(page.getByTestId("outcome-dropped"))
      .toHaveTextContent("dropped");
  });

  test("a fan-out (Set) into several candidates", async () => {
    render(
      previewElement({
        field: FIRST_NAME,
        inputColumn: "n",
        steps: [{ function: "split_on", params: { delimiter: " " } }],
        rawRows: [{ n: "A B C" }],
      }),
    );
    const fanout = page.getByTestId("outcome-fanout");
    await expect.element(fanout).toHaveTextContent("splits into 3 values");
    for (const value of ["A", "B", "C"])
      await expect
        .element(fanout.getByText(value, { exact: true }))
        .toBeInTheDocument();
  });

  test("an empty cleaned value is shown distinctly from a dropped value", async () => {
    // remove_dashes turns "---" into "" -- a value (an empty PSI key), not a drop.
    render(
      previewElement({
        field: FIRST_NAME,
        inputColumn: "n",
        steps: [{ function: "remove_dashes" }],
        rawRows: [{ n: "---" }],
      }),
    );
    // Rendered as a value outcome carrying the distinct "empty value" chip, never
    // the grey "dropped" chip.
    await expect
      .element(page.getByTestId("outcome-value"))
      .toHaveTextContent("empty value");
    expect(page.getByTestId("outcome-dropped").elements()).toHaveLength(0);
  });

  test("an incomplete step shows guidance instead of crashing the preview", async () => {
    // pad_left with no length yet throws when compiled; the preview must catch it.
    render(
      previewElement({
        field: FIRST_NAME,
        inputColumn: "n",
        steps: [{ function: "pad_left" }],
        rawRows: [{ n: "42" }],
      }),
    );
    await expect
      .element(
        page.getByText(
          "Finish configuring the steps above to see the preview.",
        ),
      )
      .toBeInTheDocument();
  });

  test("an over-length regex source shows guidance and is never compiled", async () => {
    // The length cap rejects an in-dialect pattern longer than
    // MAX_TRANSFORM_PATTERN_LENGTH (here a 1001-char literal): it is valid RE2
    // syntax so it would NOT throw, but compiling it pays the super-linear RE2
    // compile cost the cap exists to bound. The preview gates on isStepValid, so
    // the oversized source never reaches compile and the operator sees the same
    // guidance the inline length error already explains.
    render(
      previewElement({
        field: FIRST_NAME,
        inputColumn: "n",
        steps: [
          { function: "filter_regex", params: { pattern: "a".repeat(1001) } },
        ],
        rawRows: [{ n: "mary" }],
      }),
    );
    await expect
      .element(
        page.getByText(
          "Finish configuring the steps above to see the preview.",
        ),
      )
      .toBeInTheDocument();
    expect(page.getByTestId("outcome-value").elements()).toHaveLength(0);
    expect(page.getByTestId("outcome-dropped").elements()).toHaveLength(0);
  });

  test("a value that violates a field constraint is badged (warn, not blocked)", async () => {
    render(
      previewElement({
        // allowedCharacters "A-Z " -> a lowercase residue is flagged.
        field: {
          name: "fn",
          type: "first_name",
          constraints: { allowedCharacters: "A-Z " },
        } satisfies LinkageField,
        inputColumn: "n",
        steps: [],
        rawRows: [{ n: "mary" }],
      }),
    );
    await expect
      .element(page.getByText("disallowed characters"))
      .toBeInTheDocument();
  });
});

describe("StandardizationStepEditor", () => {
  test("reordering steps changes the previewed output in pipeline order", async () => {
    // [coalesce -> null_if] over "X": coalesce passes "X" through, null_if drops
    // it. Swapped to [null_if -> coalesce], null_if drops "X" and coalesce then
    // substitutes "Z" -- a vivid order-dependent flip from dropped to a value.
    render(
      createElement(EditorWithPreview, {
        field: FIRST_NAME,
        inputColumn: "n",
        initialSteps: [
          { function: "coalesce", params: { default: "Z" } },
          { function: "null_if", params: { values: ["X"] } },
        ],
        rawRows: [{ n: "X" }],
      }),
    );
    // Initial order drops the value.
    await expect
      .element(page.getByTestId("outcome-dropped"))
      .toBeInTheDocument();

    // Move null_if ahead of coalesce.
    await userEvent.click(
      page.getByRole("button", { name: "Move Null if earlier" }),
    );

    // The pipeline now yields the substituted value.
    await expect
      .element(page.getByTestId("outcome-value"))
      .toHaveTextContent("Z");
    expect(page.getByTestId("outcome-dropped").elements()).toHaveLength(0);
  });

  test("a typed param input rejects an out-of-type value and accepts a valid one", async () => {
    // substring.start refuses 0 (positions are 1-indexed); seeding 0 shows the
    // descriptor's own message, and a valid value clears it.
    render(
      createElement(EditorWithPreview, {
        field: FIRST_NAME,
        inputColumn: "n",
        initialSteps: [
          { function: "substring", params: { start: 0, length: 2 } },
        ],
        rawRows: [{ n: "mary" }],
      }),
    );
    await expect
      .element(page.getByText("start must not be 0 (positions are 1-indexed)"))
      .toBeInTheDocument();

    await userEvent.fill(
      page.getByRole("textbox", { name: "Start position" }),
      "1",
    );
    expect(
      page
        .getByText("start must not be 0 (positions are 1-indexed)")
        .elements(),
    ).toHaveLength(0);
  });

  test("editing a numeric param across keystrokes keeps the input mounted", async () => {
    // A stable per-step key carries the row's identity across each immutable param
    // update, so the controlled input is not remounted between keystrokes; typing
    // a multi-digit value lands every digit (a per-keystroke remount would drop
    // focus and lose all but the first).
    render(
      createElement(EditorWithPreview, {
        field: FIRST_NAME,
        inputColumn: "n",
        initialSteps: [{ function: "substring", params: { length: 5 } }],
        rawRows: [{ n: "abcdef" }],
      }),
    );
    const start = page.getByRole("textbox", { name: "Start position" });
    await userEvent.type(start, "12");
    await expect.element(start).toHaveValue("12");
  });

  test("clearing a param drops the key rather than writing undefined", async () => {
    const onStepsChange = vi.fn<(steps: Array<StandardizationStep>) => void>();
    render(
      createElement(StandardizationStepEditor, {
        fieldLabel: "First name",
        inputColumn: "n",
        steps: [{ function: "substring", params: { start: 3, length: 2 } }],
        onStepsChange,
      }),
    );
    await userEvent.clear(
      page.getByRole("textbox", { name: "Start position" }),
    );
    // The emitted step omits `start` entirely (no explicit `undefined` own-property),
    // matching core's default-pipeline shape.
    const emitted = onStepsChange.mock.calls.at(-1)?.[0];
    expect(emitted?.[0].params && "start" in emitted[0].params).toBe(false);
    expect(emitted?.[0].params).toEqual({ length: 2 });
  });

  test("the add menu surfaces each function's plain-language consequence", async () => {
    render(
      createElement(EditorWithPreview, {
        field: FIRST_NAME,
        inputColumn: "n",
        initialSteps: [],
        rawRows: [{ n: "mary" }],
      }),
    );
    await userEvent.click(page.getByRole("button", { name: "Add a step" }));
    // coalesce's blurb carries the match-creating consequence, shown at the moment
    // of choice rather than hidden behind the bare label.
    await expect
      .element(
        page.getByText("can create matches that would not otherwise occur", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
  });

  test("adds a step from the grouped menu and removes it again", async () => {
    render(
      createElement(EditorWithPreview, {
        field: FIRST_NAME,
        inputColumn: "n",
        initialSteps: [],
        rawRows: [{ n: "mary" }],
      }),
    );
    // Empty pipeline: the value passes through unchanged.
    await expect
      .element(page.getByTestId("outcome-value"))
      .toHaveTextContent("mary");

    await userEvent.click(page.getByRole("button", { name: "Add a step" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Uppercase" }));

    // The new step is listed and the preview reflects it.
    await expect.element(page.getByText("Uppercase")).toBeInTheDocument();
    await expect
      .element(page.getByTestId("outcome-value"))
      .toHaveTextContent("MARY");

    await userEvent.click(
      page.getByRole("button", { name: "Remove Uppercase" }),
    );
    expect(page.getByText("Uppercase").elements()).toHaveLength(0);
    await expect
      .element(page.getByTestId("outcome-value"))
      .toHaveTextContent("mary");
  });
});

describe("StandardizationStepEditor raw-pattern authoring (per-party, ungated)", () => {
  test("the add menu offers raw-pattern steps", async () => {
    render(
      createElement(EditorWithPreview, {
        field: FIRST_NAME,
        inputColumn: "n",
        initialSteps: [],
        rawRows: [{ n: "mary" }],
      }),
    );
    await userEvent.click(page.getByRole("button", { name: "Add a step" }));
    // The standard menu is present...
    await expect
      .element(page.getByRole("menuitem", { name: "Uppercase" }))
      .toBeInTheDocument();
    // ...and so is the raw-pattern group: per-party cleaning authors regex without a
    // gate (a raw pattern changes only this party's own match rate).
    await expect
      .element(page.getByText("Raw patterns (advanced)"))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("menuitem", { name: "Filter (regex)" }))
      .toBeInTheDocument();
  });

  test("a default pipeline's regex step is editable, with its advanced badge", async () => {
    render(
      createElement(EditorWithPreview, {
        field: FIRST_NAME,
        inputColumn: "n",
        initialSteps: [
          { function: "filter_regex", params: { pattern: "^[A-Z]+$" } },
        ],
        rawRows: [{ n: "MARY" }],
      }),
    );
    // The step renders labeled, with the "advanced" risk badge, and an EDITABLE
    // Pattern input (the per-party gate is gone).
    await expect.element(page.getByText("Filter (regex)")).toBeInTheDocument();
    await expect.element(page.getByText("advanced")).toBeInTheDocument();
    await expect
      .element(page.getByRole("textbox", { name: "Pattern" }))
      .toBeInTheDocument();
  });

  test("adding a regex step exposes an editable pattern the preview reflects", async () => {
    render(
      createElement(EditorWithPreview, {
        field: FIRST_NAME,
        inputColumn: "n",
        initialSteps: [],
        rawRows: [{ n: "mary" }],
      }),
    );
    await userEvent.click(page.getByRole("button", { name: "Add a step" }));
    await expect
      .element(page.getByText("Raw patterns (advanced)"))
      .toBeInTheDocument();
    await userEvent.click(
      page.getByRole("menuitem", { name: "Filter (regex)" }),
    );
    // The new regex step exposes an editable, labeled Pattern input.
    const pattern = page.getByRole("textbox", { name: "Pattern" });
    await expect.element(pattern).toBeInTheDocument();
    // A matching pattern keeps the value; the preview tracks the edit.
    await userEvent.fill(pattern, "^m");
    await expect
      .element(page.getByTestId("outcome-value"))
      .toHaveTextContent("mary");
  });

  test("an out-of-dialect pattern surfaces the dialect error inline", async () => {
    render(
      createElement(EditorWithPreview, {
        field: FIRST_NAME,
        inputColumn: "n",
        initialSteps: [{ function: "filter_regex", params: { pattern: "^A" } }],
        rawRows: [{ n: "MARY" }],
      }),
    );
    // A lookahead is out of the linear-time dialect; the editor rejects it with the
    // descriptor's own message, surfaced inline as an alert, exactly as the exchange
    // would refuse it.
    await userEvent.fill(
      page.getByRole("textbox", { name: "Pattern" }),
      "a(?=b)",
    );
    await expect.element(page.getByText(/RE2 syntax/i)).toBeInTheDocument();
  });

  test("split_on's includeOriginal renders as a labeled switch, its delimiter as a pattern input", async () => {
    render(
      createElement(EditorWithPreview, {
        field: FIRST_NAME,
        inputColumn: "n",
        initialSteps: [{ function: "split_on", params: { delimiter: " " } }],
        rawRows: [{ n: "A B" }],
      }),
    );
    // The boolean param is a switch (never a raw text box), labeled in plain
    // language; the delimiter is an editable pattern input.
    await expect
      .element(
        page.getByRole("switch", { name: "Keep the original value too" }),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("textbox", { name: "Delimiter pattern" }))
      .toBeInTheDocument();
  });
});

describe("StandardizationStepEditor input-column binding", () => {
  test("offers a labeled column selector when more than one column has the field's type, and rebinds on change", async () => {
    const onInputColumnChange = vi.fn<(column: string) => void>();
    render(
      createElement(StandardizationStepEditor, {
        fieldLabel: "First name",
        inputColumn: "maiden_col",
        steps: [],
        inputColumnOptions: ["maiden_col", "current_col"],
        onInputColumnChange,
        onStepsChange: () => {},
      }),
    );
    // The binding is a real choice (two same-typed columns), so it is a labeled,
    // keyboard-operable select rather than the read-only note. Mantine's Select input
    // has role=combobox, named by its label.
    const select = page.getByRole("combobox", { name: "Column to clean" });
    await expect.element(select).toBeInTheDocument();
    expect(page.getByText(/from your column/).elements()).toHaveLength(0);
    // Choosing the other column rebinds the field to it.
    await userEvent.click(select);
    await userEvent.click(page.getByRole("option", { name: "current_col" }));
    expect(onInputColumnChange).toHaveBeenCalledWith("current_col");
  });

  test("shows the bound column read-only when only one column has the field's type", async () => {
    render(
      createElement(StandardizationStepEditor, {
        fieldLabel: "First name",
        inputColumn: "maiden_col",
        steps: [],
        inputColumnOptions: ["maiden_col"],
        onInputColumnChange: () => {},
        onStepsChange: () => {},
      }),
    );
    // One column of the type means no real choice, so it stays the read-only note --
    // no select to mislead the operator into thinking there is an alternative.
    await expect
      .element(page.getByText("from your column maiden_col"))
      .toBeInTheDocument();
    expect(
      page.getByRole("combobox", { name: "Column to clean" }).elements(),
    ).toHaveLength(0);
  });
});

describe("StandardizationStepEditor accessibility", () => {
  test("removing a step keeps focus on a neighbor instead of dropping it to <body>", async () => {
    render(
      createElement(EditorWithPreview, {
        field: FIRST_NAME,
        inputColumn: "n",
        initialSteps: [
          { function: "to_upper_case" },
          { function: "to_lower_case" },
        ],
        rawRows: [{ n: "Mary" }],
      }),
    );
    // Remove the first step; the step that slides into its slot (Lowercase) takes
    // focus, so a keyboard/screen-reader user is not dropped to <body>.
    await userEvent.click(
      page.getByRole("button", { name: "Remove Uppercase" }),
    );
    expect(page.getByText("Uppercase").elements()).toHaveLength(0);
    await expect
      .element(page.getByRole("button", { name: "Remove Lowercase" }))
      .toHaveFocus();
  });

  test("removing the last step moves focus to the Add button", async () => {
    render(
      createElement(EditorWithPreview, {
        field: FIRST_NAME,
        inputColumn: "n",
        initialSteps: [{ function: "to_upper_case" }],
        rawRows: [{ n: "Mary" }],
      }),
    );
    await userEvent.click(
      page.getByRole("button", { name: "Remove Uppercase" }),
    );
    await expect
      .element(page.getByRole("button", { name: "Add a step" }))
      .toHaveFocus();
  });

  test("moving a step to the first slot keeps focus on an enabled control", async () => {
    render(
      createElement(EditorWithPreview, {
        field: FIRST_NAME,
        inputColumn: "n",
        initialSteps: [
          { function: "to_upper_case" },
          { function: "to_lower_case" },
        ],
        rawRows: [{ n: "Mary" }],
      }),
    );
    // Move Lowercase up to slot 0. Its "earlier" control disables at the edge, so
    // focus must fall to the still-enabled "later" control rather than to <body>.
    await userEvent.click(
      page.getByRole("button", { name: "Move Lowercase earlier" }),
    );
    await expect
      .element(page.getByRole("button", { name: "Move Lowercase later" }))
      .toHaveFocus();
  });

  test("the step list announces the debounced summary via one polite live region, not the whole table", async () => {
    render(
      createElement(EditorWithPreview, {
        field: FIRST_NAME,
        inputColumn: "n",
        initialSteps: [
          { function: "to_upper_case" },
          { function: "to_lower_case" },
        ],
        rawRows: [{ n: "Mary" }],
      }),
    );
    // Wait for the editor to commit before reading the DOM.
    await expect
      .element(page.getByRole("button", { name: "Add a step" }))
      .toBeInTheDocument();
    // Exactly one polite live region for the step list (the preview adds none): the
    // summary is announced through it, not by marking the whole list aria-live.
    const regions = container!.querySelectorAll(
      '[role="status"][aria-live="polite"]',
    );
    expect(regions).toHaveLength(1);
    const region = regions[0];
    // The initial pipeline is NOT announced -- only an edit is -- so it starts empty,
    // which is also what keeps a screen reader from hearing every field's seed on
    // mount.
    expect(region.textContent).toBe("");

    // A keyboard reorder (no drag, no menu) flips the summary order; the debounced
    // region then announces the new order -- the visible list is unaffected.
    await userEvent.click(
      page.getByRole("button", { name: "Move Lowercase earlier" }),
    );
    await expect
      .poll(() => region.textContent)
      .toContain("2 cleaning steps: Lowercase, Uppercase");
  });
});

describe("preview outcomes reach assistive tech by text/label, not color alone", () => {
  test("the empty-value chip exposes its meaning as a label, not just an orange color", async () => {
    // remove_dashes turns "---" into "" -- an empty key. The chip is icon-style, so
    // its meaning must reach a screen reader as a label.
    render(
      previewElement({
        field: FIRST_NAME,
        inputColumn: "n",
        steps: [{ function: "remove_dashes" }],
        rawRows: [{ n: "---" }],
      }),
    );
    await expect
      .element(page.getByRole("img", { name: /empty value.*matching/i }))
      .toBeInTheDocument();
  });

  test("a constraint violation is a labelled badge, distinct from the value color", async () => {
    render(
      previewElement({
        field: {
          name: "fn",
          type: "first_name",
          constraints: { allowedCharacters: "A-Z " },
        } satisfies LinkageField,
        inputColumn: "n",
        steps: [],
        rawRows: [{ n: "mary" }],
      }),
    );
    await expect
      .element(page.getByRole("img", { name: /Constraint warning/i }))
      .toBeInTheDocument();
  });

  test("a dropped value carries the word 'dropped', not a color cue alone", async () => {
    render(
      previewElement({
        field: FIRST_NAME,
        inputColumn: "n",
        steps: [{ function: "null_if", params: { values: ["mary"] } }],
        rawRows: [{ n: "mary" }],
      }),
    );
    await expect
      .element(page.getByTestId("outcome-dropped"))
      .toHaveTextContent("dropped");
  });
});
