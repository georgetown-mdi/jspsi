/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import { editorFromCsv, editorWithAuthoredDraft } from "@psi/inviterEditor";

import {
  buildAdvancedTerms,
  draftFromTerms,
} from "@psi/authoring/advancedInvite";

import {
  EDITED_TERMS_TITLE,
  START_OPENED_EXCHANGE_LABEL,
} from "@console/mountedConfiguration";
import { CONNECTION_TUNING_DEFAULT } from "@console/connectionTuningModel";
import { EXCHANGE_FILES_DEFAULT } from "@console/exchangeFilesModel";
import { RECEIPTS_DEFAULT } from "@psi/receiptsModel";
import { RUN_DIAGNOSTICS_DEFAULT } from "@psi/runDiagnosticsModel";
import { ReviewCreateSection } from "@exchange/ReviewCreateSection";

import { createAppMount } from "./renderApp";

import type { AcquiredCsv, InviterEditor } from "@psi/inviterEditor";
import type { AdvancedInviteDraft } from "@psi/authoring/advancedInvite";

const CITATION_DROP_NOTICE_NAME =
  "The imported rule-set citation will not be included";
const INERT_COALESCE_NOTICE_NAME = "A default value will not be substituted";

// The review step's own notice: an imported document's rule-set citation the terms
// this step is about to seal will not hold. It is the Matching keys tab's notice
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

function render(
  editor: InviterEditor,
  opened: {
    continuesOpenedExchange?: boolean;
    editedTermsWarning?: string;
  } = {},
) {
  app.render(
    createElement(ReviewCreateSection, {
      ...opened,
      editor,
      csv,
      problems: [],
      minting: false,
      sftpConnection: null,
      sftpSaveFilePreferred: false,
      rendezvous: undefined,
      exchangeFiles: EXCHANGE_FILES_DEFAULT,
      onExchangeFiles: () => undefined,
      connectionTuning: CONNECTION_TUNING_DEFAULT,
      onConnectionTuning: () => undefined,
      runDiagnostics: RUN_DIAGNOSTICS_DEFAULT,
      onRunDiagnostics: () => undefined,
      receipts: RECEIPTS_DEFAULT,
      onReceipts: () => undefined,
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

/** An editor whose first field's cleaning declares a coalesce with nothing ahead
 * of it in the pipeline that can empty the value, so the run substitutes it
 * nowhere it sits -- the same construction the unit suite drives
 * `inertCoalesceNotice` with. */
function withFirstPositionCoalesce(): InviterEditor {
  const editor = editorFromCsv("Dana Okafor", csv);
  const declared: AdvancedInviteDraft = {
    ...editor.draft,
    standardization: editor.draft.standardization.map(
      (transformation, index) =>
        index === 0
          ? {
              ...transformation,
              steps: [{ function: "coalesce", params: { default: "UNKNOWN" } }],
            }
          : transformation,
    ),
  };
  return editorWithAuthoredDraft(editor, declared);
}

afterEach(app.unmount);

describe("ReviewCreateSection: the dropped-citation notice", () => {
  test("restates it where the terms are confirmed, blocking nothing", async () => {
    render(importedWithDroppedCitation());

    await expect
      .element(page.getByRole("heading", { name: "Review & create" }))
      .toBeInTheDocument();
    const citationNotice = page.getByRole("note", {
      name: CITATION_DROP_NOTICE_NAME,
    });
    await expect
      .element(citationNotice)
      .toMatchTextContent(CITATION_DROP_NOTICE_NAME);
    await expect
      .element(citationNotice)
      .toMatchTextContent("the citation cannot be verified");
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
    expect(app.container.textContent).not.toContain(CITATION_DROP_NOTICE_NAME);
    expect(
      page.getByRole("note", { name: CITATION_DROP_NOTICE_NAME }).query(),
    ).toBeNull();
  });
});

describe("ReviewCreateSection: the inert-coalesce notice", () => {
  test("restates it where the terms are sealed, blocking nothing", async () => {
    render(withFirstPositionCoalesce());

    await expect
      .element(page.getByRole("heading", { name: "Review & create" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("note", { name: INERT_COALESCE_NOTICE_NAME }))
      .toMatchTextContent("is never substituted where it sits");
    // Advisory, not a refusal: terms with this shape are valid and run, so
    // the create action stays available.
    await expect
      .element(page.getByRole("button", { name: "Create the invitation" }))
      .toBeEnabled();
  });
});

describe("ReviewCreateSection: a run of an opened configuration", () => {
  const WARNING = "The terms changed here are not the ones your partner holds.";

  test("a new invitation offers its duration", async () => {
    render(editorFromCsv("Dana Okafor", csv));

    await expect
      .element(page.getByLabelText("Invitation duration"))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("rowheader", { name: "Invitation duration" }))
      .toBeInTheDocument();
  });

  test("a run that makes no invitation offers no duration", async () => {
    render(editorFromCsv("Dana Okafor", csv), {
      continuesOpenedExchange: true,
    });

    await expect
      .element(page.getByRole("button", { name: START_OPENED_EXCHANGE_LABEL }))
      .toBeInTheDocument();
    expect(page.getByLabelText("Invitation duration").query()).toBeNull();
    expect(
      page.getByRole("rowheader", { name: "Invitation duration" }).query(),
    ).toBeNull();
    expect(app.container.textContent).not.toContain("Shared now, it expires");
  });

  test("changed terms are warned of, and the run can still start", async () => {
    render(editorFromCsv("Dana Okafor", csv), {
      continuesOpenedExchange: true,
      editedTermsWarning: WARNING,
    });

    await expect.element(page.getByText(WARNING)).toBeInTheDocument();
    await expect
      .element(page.getByText(EDITED_TERMS_TITLE).first())
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: START_OPENED_EXCHANGE_LABEL }))
      .toBeEnabled();
  });

  test("unchanged terms draw no warning", async () => {
    render(editorFromCsv("Dana Okafor", csv), {
      continuesOpenedExchange: true,
    });

    await expect
      .element(page.getByRole("button", { name: START_OPENED_EXCHANGE_LABEL }))
      .toBeInTheDocument();
    expect(app.container.textContent).not.toContain(EDITED_TERMS_TITLE);
  });
});
