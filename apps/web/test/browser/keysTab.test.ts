/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { editorFromCsv, editorWithAuthoredDraft } from "@bench/inviterModel";

import { KeysTab } from "@bench/KeysTab";

import { renderApp } from "./renderApp";

import type { AcquiredCsv } from "@bench/inviterModel";
import type { Root } from "react-dom/client";

// A minimal file carrying a date_of_birth column, so the seeded default keys
// include one built from it (the element the dead-key transform below targets).
const csv: AcquiredCsv = {
  fileName: "clients.csv",
  sizeBytes: 1024,
  rawRows: [
    {
      client_id: "1",
      first_name: "Ann",
      last_name: "Lee",
      dob: "01/02/1990",
      ssn4: "1234",
    },
  ],
  columns: ["client_id", "first_name", "last_name", "dob", "ssn4"],
};

// Author a self-defeating parse_date onto the date_of_birth element of the
// first key: input_format "MM/DD" has no year, so every record's element
// resolves empty and the whole key runs to a silent empty result -- the same
// dead-key construction the model-level tests in benchInviterModel.test.ts use.
function withDeadDobKey(editor: ReturnType<typeof editorFromCsv>) {
  const keys = editor.draft.keys.map((entry, index) => {
    if (index !== 0) return entry;
    const elements = entry.key.elements.map((element) =>
      element.field === "date_of_birth"
        ? {
            ...element,
            transform: [
              { function: "parse_date", params: { inputFormat: "MM/DD" } },
            ],
          }
        : element,
    );
    return { ...entry, key: { ...entry.key, elements } };
  });
  return editorWithAuthoredDraft(editor, { ...editor.draft, keys });
}

let container: HTMLElement | undefined;
let root: Root | undefined;

function render() {
  const editor = withDeadDobKey(editorFromCsv("Dana Okafor", csv));
  root!.render(
    renderApp(
      createElement(KeysTab, {
        editor,
        csv,
        expertMode: false,
        onExpertMode: () => undefined,
        onKeyEnabled: () => undefined,
        onKeyMoved: () => undefined,
        onAuthoredDraft: () => undefined,
        onStrategy: () => undefined,
        onAlgorithm: () => undefined,
        onDeduplicate: () => undefined,
        onImport: () => undefined,
        keysError: undefined,
        announce: () => undefined,
        onBack: () => undefined,
      }),
    ),
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("KeysTab: the guided-list dead-key badge", () => {
  test('reads "won\'t match" and carries an explanatory aria-label', async () => {
    render();

    await expect
      .element(page.getByRole("heading", { name: "Matching keys" }))
      .toBeInTheDocument();

    const badge = page.getByRole("img", {
      name: "This key's cleaning can never produce a value; review the transform",
    });
    await expect.element(badge).toBeInTheDocument();
    await expect.element(badge).toHaveTextContent("won't match");
  });
});
