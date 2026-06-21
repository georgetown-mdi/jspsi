/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import { StandardizationPreview } from "@components/StandardizationPreview";
import { StandardizationStepEditor } from "@components/StandardizationStepEditor";

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
  root.render(createElement(MantineProvider, null, node));
}

const FIRST_NAME: LinkageField = { name: "fn", type: "first_name" };

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
    createElement(StandardizationPreview, {
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
      createElement(StandardizationPreview, {
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
      createElement(StandardizationPreview, {
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
      createElement(StandardizationPreview, {
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
      createElement(StandardizationPreview, {
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
      createElement(StandardizationPreview, {
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

  test("a value that violates a field constraint is badged (warn, not blocked)", async () => {
    render(
      createElement(StandardizationPreview, {
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
