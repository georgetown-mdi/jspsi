/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { buildAdvancedTerms, seedAdvancedInvite } from "@psi/advancedInvite";
import { exportLinkageTerms } from "@psi/linkageTermsIO";

import { TermsImportExport } from "@components/TermsImportExport";

import { renderApp } from "./renderApp";

import type { Root } from "react-dom/client";

const COLUMNS = ["ssn", "ssn4", "first_name", "last_name", "dob"];

let container: HTMLElement | undefined;
let root: Root | undefined;

function mount() {
  const { draft, seed } = seedAdvancedInvite("County Health Dept", COLUMNS);
  const currentTerms = buildAdvancedTerms(draft);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    renderApp(
      createElement(TermsImportExport, {
        currentTerms,
        seed,
        rawRows: [],
        onImport: () => undefined,
      }),
    ),
  );
  return currentTerms;
}

const pasteBox = () =>
  page.getByRole("textbox", {
    name: "Paste a JSON or YAML linkage-terms document to import",
  });
const importButton = () => page.getByRole("button", { name: "Import" });

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("TermsImportExport", () => {
  test("editing the paste box after a failed import clears the rejection alert", async () => {
    mount();
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
    const currentTerms = mount();
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
