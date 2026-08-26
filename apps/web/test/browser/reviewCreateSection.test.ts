/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import { editorFromCsv, editorWithAuthoredDraft } from "@bench/inviterModel";

import { buildAdvancedTerms, draftFromTerms } from "@psi/advancedInvite";

import { CONNECTION_TUNING_DEFAULT } from "@bench/connectionTuningModel";
import { EXCHANGE_FILES_DEFAULT } from "@bench/exchangeFilesModel";
import { RECEIPTS_DEFAULT } from "@bench/receiptsModel";
import { RUN_DIAGNOSTICS_DEFAULT } from "@bench/runDiagnosticsModel";
import { ReviewCreateSection } from "@bench/ReviewCreateSection";

import { createAppMount } from "./renderApp";

import type { AcquiredCsv, InviterEditor } from "@bench/inviterModel";

// The review step's own notice: an imported document's rule-set citation the terms
// this step is about to seal will not carry. It is the Matching keys tab's notice
// restated here, not a second wording -- an operator can import in that tab and
// come straight to this step to create.

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

const app = createAppMount();

function render(editor: InviterEditor) {
  app.render(
    createElement(ReviewCreateSection, {
      editor,
      csv,
      problems: [],
      minting: false,
      sftpConnection: null,
      sftpSaveFilePreferred: false,
      rendezvous: undefined,
      exchangeFiles: EXCHANGE_FILES_DEFAULT,
      exchangeFilesOpen: false,
      onExchangeFiles: () => undefined,
      onExchangeFilesOpen: () => undefined,
      connectionTuning: CONNECTION_TUNING_DEFAULT,
      connectionTuningOpen: false,
      onConnectionTuning: () => undefined,
      onConnectionTuningOpen: () => undefined,
      runDiagnostics: RUN_DIAGNOSTICS_DEFAULT,
      runDiagnosticsOpen: false,
      onRunDiagnostics: () => undefined,
      onRunDiagnosticsOpen: () => undefined,
      receipts: RECEIPTS_DEFAULT,
      receiptsOpen: false,
      onReceipts: () => undefined,
      onReceiptsOpen: () => undefined,
      onLifetime: () => undefined,
      onDirection: () => undefined,
      onTransport: () => undefined,
      onAuthorConnection: () => undefined,
      onClearConnection: () => undefined,
      onUseCliForSftp: () => undefined,
      onRunHereForSftp: () => undefined,
      onReset: () => undefined,
      onCreate: () => undefined,
      onNavigate: () => undefined,
    }),
  );
}

/** An editor whose imported document cited the set this build ships over rules
 * that are not it: the rebuild drops the citation, the same construction the
 * Matching keys tab's notice is driven with. */
function importedWithDroppedCitation(): InviterEditor {
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
  return imported;
}

afterEach(app.unmount);

describe("ReviewCreateSection: the dropped-citation notice", () => {
  test("restates it where the terms are confirmed, blocking nothing", async () => {
    render(importedWithDroppedCitation());

    await expect
      .element(page.getByRole("heading", { name: "Review & create" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("note"))
      .toHaveTextContent("The imported rule-set citation will not be carried");
    await expect
      .element(page.getByRole("note"))
      .toHaveTextContent("the citation cannot be verified");
    // Told, not stopped: dropping the citation is the correct outcome, so the
    // create action stays available.
    await expect
      .element(page.getByRole("button", { name: "Create the invitation" }))
      .toBeEnabled();
  });

  test("shows nothing where the draft's citation stands", async () => {
    render(editorFromCsv("Dana Okafor", csv));

    await expect
      .element(page.getByRole("heading", { name: "Review & create" }))
      .toBeInTheDocument();
    expect(app.container.textContent).not.toContain(
      "The imported rule-set citation will not be carried",
    );
    expect(page.getByRole("note").query()).toBeNull();
  });
});
