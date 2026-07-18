/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { authoredLinkageFields } from "@psilink/core";

import { StandardizationCards } from "@components/StandardizationCards";
import { columnSamplesFromRows } from "@psi/columnSamples";

import { expandFieldCards } from "./fieldCards";
import { renderApp } from "./renderApp";

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
// field has a second column free to bind -- the multi-field scenario the add/remove
// affordances exist for.
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
const columnSamples = columnSamplesFromRows(
  rawRows,
  metadata.map((column) => column.name),
);

type CardsProps = Parameters<typeof StandardizationCards>[0];

function render(
  standardization: Standardization,
  overrides: Partial<CardsProps> = {},
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    renderApp(
      createElement(StandardizationCards, {
        standardization,
        declaredFields: authoredLinkageFields(metadata, standardization),
        metadata,
        columnSamples,
        onStepsChange: () => {},
        onInputColumnChange: () => {},
        onMissingField: "skip",
        ...overrides,
      }),
    ),
  );
}

describe("StandardizationCards: per-field binding and multi-field affordances", () => {
  // One first_name field plus a date: the first_name type has a second column free,
  // so the "add another" affordance is offered when the host supplies onAddField.
  const oneNameField: Standardization = [
    { output: "first_name", input: "maiden_col", steps: [] },
    { output: "date_of_birth", input: "dob_col", steps: [] },
  ];

  test("the input-column binding is a labelled combobox when the type has more than one column", async () => {
    render(oneNameField);
    // Cards start collapsed to their label; expand to reach the binding control.
    await expandFieldCards();
    // The shared StandardizationStepEditor renders the binding as a Mantine Select
    // named by its label; reachable by role + accessible name on both pages.
    await expect
      .element(page.getByRole("combobox", { name: "Column to clean" }))
      .toBeInTheDocument();
  });

  test("the add-another-field affordance fires onAddField with the type when a free column exists", async () => {
    const onAddField = vi.fn<(type: string) => void>();
    render(oneNameField, { onAddField });
    const addButton = page.getByRole("button", {
      name: "Add another first name field",
    });
    await expect.element(addButton).toBeInTheDocument();
    await userEvent.click(addButton);
    // The component gates the affordance (a free column of the type exists) and emits
    // only the type; the host owns the append behavior.
    expect(onAddField).toHaveBeenCalledWith("first_name");
  });

  test("no add affordance when onAddField is omitted (the acceptor case)", async () => {
    render(oneNameField);
    await expandFieldCards();
    // Wait for the cards to commit before asserting the affordance's absence.
    await expect
      .element(page.getByRole("combobox", { name: "Column to clean" }))
      .toBeInTheDocument();
    expect(
      page
        .getByRole("button", { name: "Add another first name field" })
        .elements(),
    ).toHaveLength(0);
  });

  test("a same-typed pair offers one remove control per field and fires onRemoveField", async () => {
    // Two first_name fields bound to distinct columns: each is removable. With both
    // columns bound there is no free one, so no add control is offered.
    const twoNameFields: Standardization = [
      { output: "first_name", input: "maiden_col", steps: [] },
      { output: "first_name_2", input: "current_col", steps: [] },
      { output: "date_of_birth", input: "dob_col", steps: [] },
    ];
    const onRemoveField = vi.fn<(output: string) => void>();
    render(twoNameFields, { onAddField: () => {}, onRemoveField });
    // Cards start collapsed; expand them to reach the per-field remove controls.
    await expandFieldCards();
    // One remove control per same-typed field (two), none for the lone date.
    await expect
      .poll(
        () =>
          page.getByRole("button", { name: "Remove this field" }).elements()
            .length,
      )
      .toBe(2);
    // Both columns are bound, so no free one and no add control.
    expect(
      page
        .getByRole("button", { name: "Add another first name field" })
        .elements(),
    ).toHaveLength(0);
    await userEvent.click(
      page.getByRole("button", { name: "Remove this field" }).first(),
    );
    expect(onRemoveField).toHaveBeenCalledWith("first_name");
  });

  test("no remove control on a lone field, nor when onRemoveField is omitted", async () => {
    const twoNameFields: Standardization = [
      { output: "first_name", input: "maiden_col", steps: [] },
      { output: "first_name_2", input: "current_col", steps: [] },
    ];
    // A same-typed pair, but no onRemoveField supplied: the affordance never renders.
    render(twoNameFields);
    await expandFieldCards();
    // Wait for the cards to commit before asserting the affordance's absence.
    await expect
      .element(page.getByRole("combobox", { name: "Column to clean" }).first())
      .toBeInTheDocument();
    expect(
      page.getByRole("button", { name: "Remove this field" }).elements(),
    ).toHaveLength(0);
  });
});
