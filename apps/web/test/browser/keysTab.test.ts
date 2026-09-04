/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import { editorFromCsv, editorWithAuthoredDraft } from "@bench/inviterModel";

import { buildAdvancedTerms, draftFromTerms } from "@psi/advancedInvite";

import { KeysTab } from "@bench/KeysTab";
import { consoleAcquiredCsv } from "@bench/consoleAcquiredCsv";

import { createAppMount } from "./renderApp";

import type { AcquiredCsv } from "@bench/inviterModel";

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
  rowCount: 1,
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

const app = createAppMount();

function render() {
  const editor = withDeadDobKey(editorFromCsv("Dana Okafor", csv));
  app.render(
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
  );
}

afterEach(app.unmount);

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

describe("KeysTab: the dropped-citation notice", () => {
  test("names the cause on the guided tab, with expert authoring off", async () => {
    // An imported document citing the set this build ships over rules that are not
    // it: the citation is not re-emitted, so the operator is told here -- in the
    // guided tab, since the import that carried the citation is not the only way to
    // reach the drop and the key list is what costs and restores it.
    const editor = editorFromCsv("Dana Okafor", csv);
    const misdescribed = buildAdvancedTerms(editor.draft);
    expect(misdescribed.linkageRuleSet).toBeDefined();
    misdescribed.linkageKeys[0] = {
      ...misdescribed.linkageKeys[0],
      name: `${misdescribed.linkageKeys[0].name} (house rules)`,
    };
    const imported = editorWithAuthoredDraft(
      editor,
      draftFromTerms(misdescribed, editor.seed, 3600, csv.rawRows),
    );
    expect(buildAdvancedTerms(imported.draft).linkageRuleSet).toBeUndefined();

    app.render(
      createElement(KeysTab, {
        editor: imported,
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
    );

    // The visible notice carries the title and the full cause; the persistent live
    // region announces only the short headline (that title), so a screen-reader
    // user is not read the whole body twice -- once live, once in reading order.
    await expect
      .element(page.getByRole("note"))
      .toHaveTextContent("The imported rule-set citation will not be included");
    await expect
      .element(page.getByRole("note"))
      .toHaveTextContent("the citation cannot be verified");
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("The imported rule-set citation will not be included");
    await expect
      .element(page.getByRole("status"))
      .not.toHaveTextContent("the citation cannot be verified");
  });

  test("is absent -- and its live region silent, not unmounted -- while the citation stands", async () => {
    render();

    await expect
      .element(page.getByRole("heading", { name: "Matching keys" }))
      .toBeInTheDocument();
    expect(document.body.textContent).not.toContain(
      "The imported rule-set citation will not be included",
    );
    // The live region stays mounted and empty: a region added only when the notice
    // appears is missed by screen readers that watch only what is already there.
    expect(page.getByRole("status").element().textContent).toBe("");
  });
});

describe("KeysTab: the keys offered outside the default set", () => {
  // The same minimal file with a ZIP column, so the guided list carries the one
  // offered key that column supplies alongside the built-in keys.
  const withZip: AcquiredCsv = {
    ...csv,
    rawRows: [{ ...csv.rawRows[0], zip: "60614" }],
    columns: [...csv.columns, "zip"],
  };

  function renderFor(source: AcquiredCsv) {
    app.render(
      createElement(KeysTab, {
        editor: editorFromCsv("Dana Okafor", source),
        csv: source,
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
    );
  }

  test("renders the offer as an unchecked compound key, marked, with the guidance beside it", async () => {
    renderFor(withZip);

    // Offered through the list's own control, so adding a key is done the way a
    // default key is turned off -- and it arrives off, carrying its type inside a
    // compound key rather than standing alone.
    const offered = page.getByRole("checkbox", {
      name: /LN \+ FN \+ DOB \+ ZIP/,
    });
    await expect.element(offered).toBeInTheDocument();
    await expect.element(offered).not.toBeChecked();

    const marked = page.getByText("outside the default set", { exact: false });
    await expect.element(marked.first()).toBeInTheDocument();

    // The copy points: the departure from the validated set, why the offer is
    // compound, and the shared-contact hazard behind that.
    const body = document.body.textContent;
    expect(body).toContain("no longer matches on the default set alone");
    expect(body).toContain("offered only inside a compound key");
    expect(body).toContain("over-matches");
    expect(body).toContain("whether its holder is in the other file");
    expect(body).toContain("often shared");
    // All three named, so none is offered on quieter terms than the others.
    expect(body).toContain("Phone number, email address and ZIP code");
    // And that the cleaning goes with the key: an operator who edited an offered
    // type's steps loses them to a column edit that drops its key, and gets the
    // recommended steps back rather than their own.
    expect(body).toContain("Cleaning follows the key");
    expect(body).toContain("restores the recommended steps");
  });

  test("says nothing when the file supplies no column for one", async () => {
    renderFor(csv);

    await expect
      .element(page.getByRole("heading", { name: "Matching keys" }))
      .toBeInTheDocument();
    const body = document.body.textContent;
    expect(body).not.toContain("outside the default set");
    expect(body).not.toContain("Phone number, email address and ZIP code");
  });
});

describe("KeysTab: expert import/export over a rows-withheld console shape", () => {
  test("renders the terms import without reading the throwing rawRows getter", async () => {
    // The console acquires a server-side profile, not the rows, so its `rawRows` is
    // a getter that throws in dev/test. KeysTab must feed the import/export the
    // rows-withheld seed ([]), not the getter -- so expert mode renders rather than
    // crashing the bench.
    const consoleCsv = consoleAcquiredCsv({
      fileName: "clients.csv",
      sizeBytes: 4096,
      columns: ["client_id", "first_name", "last_name", "dob", "ssn4"],
      rowCount: 12408,
      dateInputFormat: "%m/%d/%Y",
    });
    const editor = editorFromCsv("Dana Okafor", consoleCsv);
    app.render(
      createElement(KeysTab, {
        editor,
        csv: consoleCsv,
        expertMode: true,
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
    );

    await expect
      .element(page.getByRole("heading", { name: "Matching keys" }))
      .toBeInTheDocument();
    // The import/export surface rendered -- proof the throwing getter was never read.
    await expect
      .element(
        page.getByLabelText(
          "Paste a JSON or YAML linkage-terms document to import",
        ),
      )
      .toBeInTheDocument();
  });
});
