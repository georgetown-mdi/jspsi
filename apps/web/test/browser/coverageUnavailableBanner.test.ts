/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import { declaredFieldsFor, editorFromCsv } from "@psi/inviterEditor";
import { columnSamplesFromRows } from "@psi/columnSamples";

import { AcceptorCleaningStep } from "@exchange/AcceptorCleaningStep";
import { CleaningTab } from "@exchange/CleaningTab";

import { createAppMount } from "./renderApp";

import type { AcquiredCsv } from "@psi/inviterEditor";
import type { RefusedColumnName } from "@psi/columnNames";

// A minimal file whose seeded terms hold a few cleaning fields, so both surfaces
// mount their standardization workbench alongside the banner under test.
const csv: AcquiredCsv = {
  fileName: "clients.csv",
  sizeBytes: 1024,
  rawRows: [{ first_name: "Ann", last_name: "Lee", dob: "01/02/1990" }],
  columns: ["first_name", "last_name", "dob"],
  rowCount: 1,
};

const columnSamples = columnSamplesFromRows(csv.rawRows, csv.columns);

const app = createAppMount();

afterEach(app.unmount);

function renderCleaningTab(
  coverageUnavailable: boolean,
  coverageRefusedColumns: ReadonlyArray<RefusedColumnName> = [],
) {
  const editor = editorFromCsv("Dana Okafor", csv);
  app.render(
    createElement(CleaningTab, {
      editor,
      columnSamples,
      expertMode: false,
      rates: null,
      pending: false,
      coverageUnavailable,
      coverageRefusedColumns,
      onFieldSteps: () => undefined,
      onFieldInput: () => undefined,
      onFieldAdded: () => undefined,
      onFieldRemoved: () => undefined,
      onResetCleaning: () => undefined,
      cleaningError: undefined,
      onBack: () => undefined,
    }),
  );
}

describe("the Cleaning surfaces' coverage-unavailable banner", () => {
  test("CleaningTab shows the banner when coverage is unavailable", async () => {
    renderCleaningTab(true);

    await expect
      .element(page.getByRole("heading", { name: "Cleaning" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Could not check coverage"))
      .toBeInTheDocument();
  });

  test("CleaningTab hides the banner when coverage is available", async () => {
    renderCleaningTab(false);

    await expect
      .element(page.getByRole("heading", { name: "Cleaning" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Could not check coverage"))
      .not.toBeInTheDocument();
  });

  test("CleaningTab names the column the console's sweep refused", async () => {
    // The console bounds a cleaning step's input-column name, so a sweep it
    // settles without a result has a cause the operator can act on: the banner
    // names the column and the bound instead of only stating the check did not
    // run.
    renderCleaningTab(true, [
      { position: 2, name: "last_name", refusal: "too-long" },
    ]);

    await expect
      .element(page.getByText("Could not check coverage"))
      .toBeInTheDocument();
    // The banner itself, not the live region beside it, which announces the
    // same sentence.
    const banner = page.getByRole("note");
    await expect.element(banner).toHaveTextContent("Column 2");
    await expect
      .element(banner)
      .not.toHaveTextContent("this check just did not run");
  });

  test("AcceptorCleaningStep shows the banner when coverage is unavailable", async () => {
    // Derive the metadata, standardization, and declared fields from one seeded
    // editor so the standardization workbench's fields resolve (its
    // onMissingField="throw" contract) while the banner renders above it.
    const editor = editorFromCsv("Dana Okafor", csv);
    app.render(
      createElement(AcceptorCleaningStep, {
        declaredFields: declaredFieldsFor(editor.draft),
        metadata: editor.draft.metadata,
        standardization: editor.draft.standardization,
        columnSamples,
        rates: null,
        ratesPending: false,
        coverageUnavailable: true,
        coverageRefusedColumns: [],
        deadKeyCount: 0,
        cleaningResetKey: "",
        onFieldSteps: () => undefined,
        onFieldInput: () => undefined,
        onReset: () => undefined,
        onBack: () => undefined,
      }),
    );

    await expect
      .element(page.getByRole("heading", { name: "Cleaning" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Could not check coverage"))
      .toBeInTheDocument();
  });
});
