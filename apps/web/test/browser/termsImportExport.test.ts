/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import {
  buildAdvancedTerms,
  seedAdvancedInvite,
} from "@psi/authoring/advancedInvite";
import { exportLinkageTerms } from "@psi/linkageTermsIO";

import { TermsImportExport } from "@components/TermsImportExport";

import { createAppMount } from "./renderApp";

const COLUMNS = ["ssn", "ssn4", "first_name", "last_name", "dob"];

const app = createAppMount();

function mountEditor() {
  const { draft, seed } = seedAdvancedInvite("County Health Dept", COLUMNS);
  const currentTerms = buildAdvancedTerms(draft);
  app.render(
    createElement(TermsImportExport, {
      currentTerms,
      seed,
      rawRows: [],
      onImport: () => undefined,
    }),
  );
  return currentTerms;
}

const pasteBox = () =>
  page.getByRole("textbox", {
    name: "Paste a JSON or YAML linkage-terms document to import",
  });
const importButton = () => page.getByRole("button", { name: "Import" });

afterEach(app.unmount);

describe("TermsImportExport", () => {
  test("editing the paste box after a failed import clears the rejection alert", async () => {
    mountEditor();
    await userEvent.fill(pasteBox(), "not json or yaml: [");
    await userEvent.click(importButton());
    await expect
      .element(page.getByText("Could not import these terms"))
      .toBeInTheDocument();

    await userEvent.type(pasteBox(), " ");
    await expect
      .element(page.getByText("Could not import these terms"))
      .not.toBeInTheDocument();
    expect(page.getByRole("status").element().textContent).toBe("");
  });

  test("a valid import after a failed one succeeds without the stale error lingering", async () => {
    const currentTerms = mountEditor();
    await userEvent.fill(pasteBox(), "not json or yaml: [");
    await userEvent.click(importButton());
    await expect
      .element(page.getByText("Could not import these terms"))
      .toBeInTheDocument();

    await userEvent.clear(pasteBox());
    await userEvent.fill(pasteBox(), exportLinkageTerms(currentTerms, "json"));
    await userEvent.click(importButton());
    await expect
      .element(
        page
          .getByText("Imported. Review the loaded terms before generating.")
          .first(),
      )
      .toBeInTheDocument();
    expect(page.getByText("Could not import these terms").query()).toBeNull();
  });
});
