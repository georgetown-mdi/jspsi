/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import { declaredFieldsFor, editorFromCsv } from "@psi/inviterModel";
import { columnSamplesFromRows } from "@psi/columnSamples";

import { AcceptorCleaningStep } from "@bench/AcceptorCleaningStep";
import { CleaningTab } from "@bench/CleaningTab";

import { createAppMount } from "./renderApp";

import type { AcquiredCsv } from "@psi/inviterModel";

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

function renderCleaningTab(coverageUnavailable: boolean) {
  const editor = editorFromCsv("Dana Okafor", csv);
  app.render(
    createElement(CleaningTab, {
      editor,
      columnSamples,
      expertMode: false,
      rates: null,
      pending: false,
      coverageUnavailable,
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
