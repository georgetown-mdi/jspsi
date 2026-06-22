/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import { authoredLinkageFields } from "@psilink/core";

import { StandardizationWorkbench } from "@components/StandardizationWorkbench";

import type { Root } from "react-dom/client";

import type { Metadata, Standardization } from "@psilink/core";

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
});

// Two first_name columns (a maiden and a current name) plus a date, so a same-typed
// field has a second column free to bind -- the multi-field scenario this surface
// exists for.
const metadata: Metadata = [
  { name: "maiden_col", type: "first_name", role: "linkage", isPayload: false },
  {
    name: "current_col",
    type: "first_name",
    role: "linkage",
    isPayload: false,
  },
  { name: "dob_col", type: "date_of_birth", role: "linkage", isPayload: false },
];
const rawRows = [{ maiden_col: "Smith", current_col: "Jones", dob_col: "X" }];

function render(standardization: Standardization, onChange = vi.fn()) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    createElement(
      MantineProvider,
      null,
      createElement(StandardizationWorkbench, {
        standardization,
        declaredFields: authoredLinkageFields(metadata, standardization),
        metadata,
        rawRows,
        onChange,
      }),
    ),
  );
  return onChange;
}

describe("StandardizationWorkbench: per-field binding and multi-field controls", () => {
  // One first_name field plus a date: the first_name type has a second column free,
  // so the "add another" affordance is offered.
  const oneNameField: Standardization = [
    { output: "first_name", input: "maiden_col", steps: [] },
    { output: "date_of_birth", input: "dob_col", steps: [] },
  ];

  test("the input-column binding is a labelled combobox when the type has more than one column", async () => {
    render(oneNameField);
    // StandardizationStepEditor renders the binding as a Mantine Select named by its
    // label; reachable by role + accessible name (a11y parity with the acceptor).
    await expect
      .element(page.getByRole("combobox", { name: "Column to clean" }))
      .toBeInTheDocument();
  });

  test("the add-another-field control is reachable by name and appends a transformation bound to the free column", async () => {
    const onChange = render(oneNameField);
    const addButton = page.getByRole("button", {
      name: "Add another first name field",
    });
    await expect.element(addButton).toBeInTheDocument();
    await userEvent.click(addButton);
    // The appended transformation binds the type's still-free column (current_col)
    // to a new, distinctly-named field.
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as Standardization;
    const firstNameTransforms = next.filter((t) =>
      ["maiden_col", "current_col"].includes(t.input),
    );
    expect(firstNameTransforms.map((t) => t.input)).toEqual([
      "maiden_col",
      "current_col",
    ]);
    expect(new Set(next.map((t) => t.output)).size).toBe(next.length);
  });

  test("a second same-typed field offers a reachable remove control; the lone default field does not", async () => {
    // Two first_name fields bound to distinct columns: each is removable. With both
    // columns bound there is no free one, so no add control is offered.
    const twoNameFields: Standardization = [
      { output: "first_name", input: "maiden_col", steps: [] },
      { output: "first_name_2", input: "current_col", steps: [] },
      { output: "date_of_birth", input: "dob_col", steps: [] },
    ];
    render(twoNameFields);
    // One remove control per same-typed field (two), and none for the lone date.
    // Poll so the count is read after React commits, not before.
    await expect
      .poll(
        () =>
          page.getByRole("button", { name: "Remove this field" }).elements()
            .length,
      )
      .toBe(2);
    expect(
      page
        .getByRole("button", { name: "Add another first name field" })
        .elements(),
    ).toHaveLength(0);
  });
});
