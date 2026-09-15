/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import {
  editorFromCsv,
  editorWithIdentity,
  editorWithTransport,
} from "@psi/inviterEditor";

import {
  RECEIPTS_DEFAULT,
  receiptsWithField,
  receiptsWithResolvedIdentity,
} from "@psi/receiptsModel";
import { CONNECTION_TUNING_DEFAULT } from "@console/connectionTuningModel";
import { EXCHANGE_FILES_DEFAULT } from "@console/exchangeFilesModel";
import { RUN_DIAGNOSTICS_DEFAULT } from "@psi/runDiagnosticsModel";
import { ReviewCreateSection } from "@exchange/ReviewCreateSection";

import { createAppMount } from "./renderApp";

import type { AcquiredCsv } from "@psi/inviterEditor";
import type { JobRendezvousConfig } from "@psi/jobClient/workInputClient";
import type { ReceiptsDraft } from "@psi/receiptsModel";

// The review step's signing-identity gate on a console build, which is where the
// console conducts the run and so where a run the CLI would refuse at identity
// load is held instead. The refusal's wording is pinned by the receipts model's
// own suite; what this one covers is the value the step compares -- the name the
// terms state, which is the typed name NFC-normalized and trimmed, and the name
// the certificate is bound to.

vi.mock("@utils/clientConfig", () => ({
  deploymentProfile: () => "console" as const,
  isConsoleBuild: () => true,
  psilinkVersion: () => undefined,
}));

/** A canonical 43-character fingerprint: the last character comes from the
 * aligned set core's regex requires. */
const FINGERPRINT = "B".repeat(42) + "A";

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

/** One shared folder the console conducts the exchange in, so the shared-directory
 * transport is offered and its run happens here. */
const RENDEZVOUS: JobRendezvousConfig = {
  configured: true,
  locator: "psilink",
  folderName: "psilink",
  sharesDataRoot: false,
  sharesDataRootUncertain: false,
};

const app = createAppMount();

/** A signed draft whose identity was read and is bound to `boundIdentity`, the
 * state the gate compares. */
function signedWith(boundIdentity: string): ReceiptsDraft {
  return receiptsWithResolvedIdentity(
    receiptsWithField(RECEIPTS_DEFAULT, "mode", "certificate"),
    FINGERPRINT,
    boundIdentity,
  );
}

function render(typedName: string, receipts: ReceiptsDraft): void {
  const editor = editorWithTransport(
    editorWithIdentity(editorFromCsv("Agency A", csv), typedName),
    "filedrop",
  );
  app.render(
    createElement(ReviewCreateSection, {
      editor,
      csv,
      problems: [],
      minting: false,
      sftpConnection: null,
      sftpSaveFilePreferred: false,
      rendezvous: RENDEZVOUS,
      exchangeFiles: EXCHANGE_FILES_DEFAULT,
      onExchangeFiles: () => undefined,
      connectionTuning: CONNECTION_TUNING_DEFAULT,
      onConnectionTuning: () => undefined,
      runDiagnostics: RUN_DIAGNOSTICS_DEFAULT,
      onRunDiagnostics: () => undefined,
      receipts,
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

const createButton = () =>
  page.getByRole("button", { name: "Create the invitation" });

afterEach(app.unmount);

describe("ReviewCreateSection: the name this console signs under", () => {
  test("a typed name the terms trim away holds nothing", async () => {
    // Typed with a trailing space against an identity bound to the trimmed name:
    // the terms state the trimmed name, so the two agree and the run the console
    // would launch is the ordinary signed one.
    render("Agency A ", signedWith("Agency A"));

    await expect.element(createButton()).toBeEnabled();
    expect(app.container.textContent).toContain("Ready to create.");
  });

  test("a bound name the terms cannot restate holds the create", async () => {
    // An identity minted outside the console can hold the untrimmed name. The
    // terms state "Agency A", which that identity is not, so the launch is held
    // and the statement names the value the run states. The remedy is the
    // re-key alone: the terms trim what is typed, so no entry in the name field
    // reaches the bound one.
    render("Agency A ", signedWith("Agency A "));

    await expect.element(createButton()).toBeDisabled();
    expect(app.container.textContent).toContain(
      'the "Agency A" this exchange names you by',
    );
    expect(app.container.textContent).not.toContain(
      "set 'Your name' for this exchange to",
    );
  });

  test("two Unicode forms of one name hold nothing", async () => {
    // A decomposed accented name typed against an identity bound to the
    // precomposed one: the terms state the precomposed form, which is what the
    // certificate the partner checks is bound to.
    render("Age\u0301ncia A", signedWith("Ag\u00e9ncia A"));

    await expect.element(createButton()).toBeEnabled();
    expect(app.container.textContent).toContain("Ready to create.");
  });
});
