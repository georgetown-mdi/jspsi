/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import {
  SIGNED_RECEIPT_VERSION,
  buildExchangeRecord,
  computeCertificateFingerprint,
  generateSigningIdentity,
  serializeCertificate,
  serializeDualSignedRecord,
  serializeExchangeRecord,
  serializeSigningIdentity,
  serializeVerificationKeys,
  signReceiptContent,
} from "@psilink/core";

import { VerifyReceiptBench } from "@bench/VerifyReceiptBench";

import { createAppMount } from "./renderApp";

import type {
  AssociationTable,
  CommittedPayload,
  DualSignedRecord,
  ExchangeRecord,
  LinkageTerms,
  ReceiptContent,
  SigningCertificate,
  SigningIdentity,
  VerificationKeys,
} from "@psilink/core";

/** Each fixture party's own name, held apart from the terms: `identity` is
 * optional there, so reading it back would type as possibly absent where these
 * bind a certificate to a party this suite knows is named. */
const LOCAL_IDENTITY = "Party A";
const PARTNER_IDENTITY = "Party B";

const LOCAL_TERMS: LinkageTerms = {
  version: "1.0.0",
  identity: LOCAL_IDENTITY,
  date: "2025-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};
const PARTNER_TERMS: LinkageTerms = {
  ...LOCAL_TERMS,
  identity: PARTNER_IDENTITY,
};

const localPayloadSent: CommittedPayload = {
  columns: ["dose"],
  rows: [["10mg"], ["20mg"]],
};
const partnerPayloadReceived: CommittedPayload = {
  columns: ["clinic"],
  rows: [["north"], ["south"]],
};
const associationTable: AssociationTable = [
  [0, 1],
  [1, 0],
];

const INPUT_CSV = "pid,dose\nP0,10mg\nP1,20mg\n";
const RESULT_CSV = "pid,their_row_id,clinic\nP0,1,south\nP1,0,north\n";

// The run binder this fixture's record and the dual-signed record below both carry,
// so the two artifacts pair as one run. A caller passes another value to stand in
// for a different run of the same exchange.
const RECEIPT_BINDER = "YmluZGVy";

async function buildFixture(receiptBinder = RECEIPT_BINDER): Promise<{
  record: ExchangeRecord;
  keys: VerificationKeys;
}> {
  return buildExchangeRecord({
    localTerms: LOCAL_TERMS,
    partnerTerms: PARTNER_TERMS,
    outcome: "completed",
    recordsExposed: 2,
    localPayloadSent,
    partnerPayloadReceived,
    associationTable,
    createdAt: "2026-01-02T03:04:05.000Z",
    receiptBinder,
  });
}

// A dual-signed record over the same exchange the fixture above describes: this
// party holds the initiator's slot, the partner the responder's, and the receipt
// content carries that record's agreed-terms hash.
async function buildSignedFixture(record: ExchangeRecord): Promise<{
  signed: DualSignedRecord;
  ourIdentity: SigningIdentity;
  ourCertificate: SigningCertificate;
  partnerFingerprint: string;
}> {
  const us = await generateSigningIdentity(LOCAL_IDENTITY);
  const partner = await generateSigningIdentity(PARTNER_IDENTITY);
  const content: ReceiptContent = {
    termsHash: record.termsHash,
    initiatorToResponderPayload: "aTJyUGF5bG9hZA",
    responderToInitiatorPayload: "cjJpUGF5bG9hZA",
    binder: RECEIPT_BINDER,
  };
  return {
    signed: {
      version: SIGNED_RECEIPT_VERSION,
      content,
      initiator: {
        certificate: us.certificate,
        signature: await signReceiptContent(us, content, "initiator"),
      },
      responder: {
        certificate: partner.certificate,
        signature: await signReceiptContent(partner, content, "responder"),
      },
    },
    ourIdentity: us,
    ourCertificate: us.certificate,
    partnerFingerprint: await computeCertificateFingerprint(
      partner.certificate,
    ),
  };
}

function jsonFile(name: string, content: string): File {
  return new File([content], name, { type: "application/json" });
}
function csvFile(name: string, content: string): File {
  return new File([content], name, { type: "text/csv" });
}

const app = createAppMount();

// A chosen-file card renders beside the dropzone that took the file, under the
// parent the two share, so a settle signal is read from that region alone: a
// card some other dropzone holds says nothing about this upload.
function fileCardRegion(input: Element): Element {
  const region = input.parentElement?.closest("[aria-label]")?.parentElement;
  if (region === null || region === undefined)
    throw new Error("no labelled dropzone encloses this file input");
  return region;
}

// userEvent.upload resolves once the change event is dispatched, but the page
// parses a dropped JSON document across an await and only then writes its state
// and bumps the run token a verify reads to decide whether its own inputs still
// stand. A Verify clicked inside that window captures a token the parse then
// supersedes, so the run discards the verdicts it computed and the page renders
// none at all; a record or keys parse landing that late also clears the
// re-supply and signed-leg inputs loaded after it. The chosen-file card commits
// in the same pass as the handler's closing bump, so waiting for that card
// settles the upload -- as long as the card the wait sees is one this upload
// produced, which the check below is what holds.
//
// The input is polled for rather than read once because a disclosure panel's
// inputs enter the DOM on a commit Mantine's Collapse defers, which the toggle
// click that opened the panel does not wait for.
async function uploadFile(
  findInput: () => Element | null,
  file: File,
): Promise<void> {
  await expect
    .poll(() => findInput() !== null, {
      message: `no file input to take '${file.name}' appeared`,
    })
    .toBe(true);
  const input = findInput();
  if (input === null)
    throw new Error(`the file input for '${file.name}' left the DOM`);
  // Resolved per call: a parse alert appearing or clearing re-indexes the
  // dropzone among its siblings, so a region locator built once goes stale.
  const cardsNamingFile = () =>
    page.elementLocator(fileCardRegion(input)).getByText(file.name).elements()
      .length;
  if (cardsNamingFile() > 0)
    throw new Error(
      `re-uploading '${file.name}' would make the settle-wait vacuous; use a distinct filename`,
    );
  await userEvent.upload(page.elementLocator(input), file);
  await expect
    .poll(cardsNamingFile, {
      message: `no chosen-file card named '${file.name}' after the upload`,
    })
    .toBeGreaterThan(0);
}

// The Mantine Dropzone renders a hidden file input; the page's dropzones appear
// in DOM order (record, keys, then the two re-supply CSVs once the section is
// open).
async function uploadAt(index: number, file: File): Promise<void> {
  await uploadFile(() => {
    const inputs = document.querySelectorAll('input[type="file"]');
    return index < inputs.length ? inputs[index] : null;
  }, file);
}

// The signed leg's dropzones are addressed by their label rather than by index:
// how many inputs precede them depends on which disclosure panels are mounted,
// and Mantine's Collapse decides that from motion preference and environment
// (see DisclosureSection).
async function uploadTo(label: string, file: File): Promise<void> {
  await uploadFile(
    () => document.querySelector(`[aria-label="${label}"] input[type="file"]`),
    file,
  );
}

// The page mounts its dropzones after the first render; wait for the heading so
// the file inputs exist before the first upload.
async function mountVerifyBench() {
  app.render(createElement(VerifyReceiptBench));
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toHaveTextContent("Verify a receipt");
}

afterEach(app.unmount);

// A joint run: the record's own verdict, whose standing note points the reader
// at the signed panel, and that signed panel beside it. Returns what a test
// needs to then edit one of the signed-leg inputs.
async function verifyRecordAndSignedRecord(): Promise<{
  record: ExchangeRecord;
  signed: DualSignedRecord;
}> {
  const { record, keys } = await buildFixture();
  const { signed, ourCertificate, partnerFingerprint } =
    await buildSignedFixture(record);
  await mountVerifyBench();

  await uploadAt(0, jsonFile("rec.json", serializeExchangeRecord(record)));
  await uploadAt(1, jsonFile("rec.keys.json", serializeVerificationKeys(keys)));
  await userEvent.click(
    page.getByRole("button", {
      name: "Check the partner's signatures with the dual-signed record",
    }),
  );
  await uploadTo(
    "Dual-signed record",
    jsonFile("psilink-receipt-x.json", serializeDualSignedRecord(signed)),
  );
  await userEvent.fill(
    page.getByLabelText("Your partner's certificate fingerprint"),
    partnerFingerprint,
  );
  await uploadTo(
    "Your exported certificate",
    jsonFile("certificate.json", serializeCertificate(ourCertificate)),
  );
  await userEvent.click(
    page.getByRole("button", { name: "Verify with the signed record" }),
  );

  await expect
    .element(page.getByText("Signed receipt verified"))
    .toBeInTheDocument();
  await expect
    .element(
      page.getByText("checked separately below", { exact: false }).first(),
    )
    .toBeInTheDocument();
  return { record, signed };
}

// Neither verdict survives an edit to a signed-leg input: the signed panel the
// edit invalidates, and the record verdict whose note points at that panel.
async function expectBothVerdictsGone() {
  await expect
    .element(page.getByText("Signed receipt verified"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByText("What was checked"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByText("checked separately below", { exact: false }))
    .not.toBeInTheDocument();
}

describe("verify receipt bench", () => {
  test("full happy path: record + keys + re-supplied files reach a verified verdict", async () => {
    const { record, keys } = await buildFixture();
    await mountVerifyBench();

    // Load the record and its keys.
    await uploadAt(
      0,
      jsonFile("psilink-record-x.json", serializeExchangeRecord(record)),
    );
    await uploadAt(
      1,
      jsonFile("psilink-record-x.keys.json", serializeVerificationKeys(keys)),
    );

    // A structure-only verify is honestly incomplete (nothing re-supplied).
    await userEvent.click(page.getByRole("button", { name: "Verify" }));
    await expect.element(page.getByText("Incomplete")).toBeInTheDocument();
    await expect
      .element(
        page.getByText("Supply your retained files", { exact: false }).first(),
      )
      .toBeInTheDocument();

    // Open the re-supply section and load the input and result CSVs.
    await userEvent.click(
      page.getByRole("button", {
        name: "Re-supply your files to open the commitments",
      }),
    );
    await uploadAt(2, csvFile("input.csv", INPUT_CSV));
    await uploadAt(3, csvFile("result.csv", RESULT_CSV));

    // Paste both parties' linkage terms so the agreed-terms hash is checked too.
    await userEvent.fill(
      page.getByLabelText("Your linkage terms"),
      JSON.stringify(LOCAL_TERMS),
    );
    await userEvent.click(
      page.getByRole("button", { name: "Load these terms" }).first(),
    );
    await userEvent.fill(
      page.getByLabelText("Your partner's linkage terms"),
      JSON.stringify(PARTNER_TERMS),
    );
    await userEvent.click(
      page.getByRole("button", { name: "Load these terms" }).nth(1),
    );

    // Re-run with the re-supply: the verdict updates to verified.
    await userEvent.click(
      page.getByRole("button", { name: "Verify with these files" }),
    );
    await expect.element(page.getByText("Verified")).toBeInTheDocument();
    await expect
      .element(page.getByText("Opened and matches").first())
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Re-derives and matches"))
      .toBeInTheDocument();
  });

  test("a tampered record renders the honest altered-or-wrong-file failed state", async () => {
    const { record, keys } = await buildFixture();
    const original = record.commitments.localPayloadSent;
    const altered = (original[0] === "A" ? "B" : "A") + original.slice(1);
    const tampered: ExchangeRecord = {
      ...record,
      commitments: {
        ...record.commitments,
        localPayloadSent: altered,
      },
    };
    await mountVerifyBench();

    await uploadAt(0, jsonFile("rec.json", serializeExchangeRecord(tampered)));
    await uploadAt(
      1,
      jsonFile("rec.keys.json", serializeVerificationKeys(keys)),
    );
    // Open re-supply, load the input and result so the commitment is opened and
    // the mismatch is reached.
    await userEvent.click(
      page.getByRole("button", {
        name: "Re-supply your files to open the commitments",
      }),
    );
    await uploadAt(2, csvFile("input.csv", INPUT_CSV));
    await uploadAt(3, csvFile("result.csv", RESULT_CSV));
    await userEvent.click(
      page.getByRole("button", { name: "Verify with these files" }),
    );

    await expect
      .element(page.getByText("Verification failed"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("the record was altered", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText("does not belong to this exchange", { exact: false }),
      )
      .toBeInTheDocument();
  });

  test("a received null the result wrote as an empty cell is named beside the mismatch", async () => {
    // The partner's second value was null when it was committed; the result file
    // writes a null and an empty string the same way, so the re-supply reproduces
    // an empty string and the received-payload commitment cannot open. The reader
    // gets the reason rather than a bare mismatch that reads as tampering.
    const { record, keys } = await buildExchangeRecord({
      localTerms: LOCAL_TERMS,
      partnerTerms: PARTNER_TERMS,
      outcome: "completed",
      recordsExposed: 2,
      localPayloadSent,
      partnerPayloadReceived: {
        columns: ["clinic"],
        rows: [["north"], [null]],
      },
      associationTable,
      createdAt: "2026-01-02T03:04:05.000Z",
      receiptBinder: RECEIPT_BINDER,
    });
    await mountVerifyBench();

    await uploadAt(0, jsonFile("rec.json", serializeExchangeRecord(record)));
    await uploadAt(
      1,
      jsonFile("rec.keys.json", serializeVerificationKeys(keys)),
    );
    await userEvent.click(
      page.getByRole("button", {
        name: "Re-supply your files to open the commitments",
      }),
    );
    await uploadAt(2, csvFile("input.csv", INPUT_CSV));
    await uploadAt(
      3,
      // Our row 0 pairs the partner's row 1 -- the null cell -- so the result
      // carries it as an empty cell.
      csvFile("result.csv", "pid,their_row_id,clinic\nP0,1,\nP1,0,north\n"),
    );
    await userEvent.click(
      page.getByRole("button", { name: "Verify with these files" }),
    );

    await expect
      .element(page.getByText("Verification failed"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("has empty cells", { exact: false }).first())
      .toBeInTheDocument();
    await expect
      .element(
        page
          .getByText("a committed empty string from a committed null", {
            exact: false,
          })
          .first(),
      )
      .toBeInTheDocument();
  });

  test("a mismatch with no empty cells earns no note", async () => {
    // The tampered-record test above reaches a mismatch through an altered
    // commitment; this one reaches the same partnerPayloadReceived mismatch
    // through an honest re-supply that simply differs from what was committed
    // -- no cell involved is ever empty, so the null explanation is impossible
    // and must not appear beside it.
    const { record, keys } = await buildFixture();
    await mountVerifyBench();

    await uploadAt(0, jsonFile("rec.json", serializeExchangeRecord(record)));
    await uploadAt(
      1,
      jsonFile("rec.keys.json", serializeVerificationKeys(keys)),
    );
    await userEvent.click(
      page.getByRole("button", {
        name: "Re-supply your files to open the commitments",
      }),
    );
    await uploadAt(2, csvFile("input.csv", INPUT_CSV));
    await uploadAt(
      3,
      // Our row 0 pairs the partner's row 1, whose committed value was "south";
      // re-supplying a different non-empty value mismatches without an empty
      // cell anywhere in the re-supplied payload.
      csvFile("result.csv", "pid,their_row_id,clinic\nP0,1,east\nP1,0,north\n"),
    );
    await userEvent.click(
      page.getByRole("button", { name: "Verify with these files" }),
    );

    await expect
      .element(page.getByText("Verification failed"))
      .toBeInTheDocument();
    // The absence below means nothing unless the mismatch the note would sit
    // beside is the one it explains: a run failing somewhere else entirely would
    // carry no note either.
    await expect
      .element(page.getByText("The payload you received: Does not match"))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText("a committed empty string from a committed null", {
          exact: false,
        }),
      )
      .not.toBeInTheDocument();
  });

  test("a missing-salt keys file renders the distinct wrong-or-drifted state", async () => {
    const { record, keys } = await buildFixture();
    // The optional association-table salt is schema-valid to omit, so the keys
    // file parses (the mandatory salts stay), reaching the unopenable path.
    const wrongKeys: VerificationKeys = {
      ...keys,
      salts: { ...keys.salts, associationTable: undefined },
    };
    await mountVerifyBench();

    await uploadAt(0, jsonFile("rec.json", serializeExchangeRecord(record)));
    await uploadAt(
      1,
      jsonFile("rec.keys.json", serializeVerificationKeys(wrongKeys)),
    );
    await userEvent.click(page.getByRole("button", { name: "Verify" }));

    await expect.element(page.getByText("Incomplete")).toBeInTheDocument();
    await expect
      .element(page.getByText("Cannot be opened").first())
      .toBeInTheDocument();
    await expect
      .element(page.getByText("wrong or drifted keys file", { exact: false }))
      .toBeInTheDocument();
  });

  test("a malformed record lands on a designed alert without clearing the input", async () => {
    const { record, keys } = await buildFixture();
    await mountVerifyBench();

    // Load valid keys first, then a malformed record.
    await uploadAt(
      1,
      jsonFile("rec.keys.json", serializeVerificationKeys(keys)),
    );
    await uploadAt(0, jsonFile("rec.json", "{ not json"));

    await expect
      .element(page.getByText("This record could not be used"))
      .toBeInTheDocument();
    // The chosen file card stays: the input was not cleared.
    await expect.element(page.getByText("rec.json")).toBeInTheDocument();
    // Verify is gated: no valid record, so no verdict.
    await expect
      .element(page.getByRole("button", { name: "Verify" }))
      .toBeDisabled();
    // A good record clears the alert and re-enables Verify. Its name differs
    // from the malformed file's so that the card this upload commits is a
    // signal of its own (see uploadFile).
    await uploadAt(
      0,
      jsonFile("rec-fixed.json", serializeExchangeRecord(record)),
    );
    await expect
      .element(page.getByRole("button", { name: "Verify" }))
      .toBeEnabled();
  });

  test("re-supplying only one of the input/result CSVs disables the top Verify button and warns", async () => {
    const { record, keys } = await buildFixture();
    await mountVerifyBench();

    await uploadAt(0, jsonFile("rec.json", serializeExchangeRecord(record)));
    await uploadAt(
      1,
      jsonFile("rec.keys.json", serializeVerificationKeys(keys)),
    );
    await expect
      .element(page.getByRole("button", { name: "Verify" }))
      .toBeEnabled();

    await userEvent.click(
      page.getByRole("button", {
        name: "Re-supply your files to open the commitments",
      }),
    );
    await uploadAt(2, csvFile("input.csv", INPUT_CSV));

    // One of the two re-supply files is present: the top-level Verify button
    // must not silently ignore it, and the warning must be visible outside the
    // (still-open) re-supply section too. Both Verify buttons are on screen
    // now, so disambiguate from "Verify with these files" by exact name.
    await expect
      .element(page.getByRole("button", { name: "Verify", exact: true }))
      .toBeDisabled();
    await expect
      .element(
        page
          .getByText(
            "Supply both the input and the result to open the commitments",
            { exact: false },
          )
          .first(),
      )
      .toBeInTheDocument();

    // Supplying the second CSV clears the warning and re-enables the button.
    await uploadAt(3, csvFile("result.csv", RESULT_CSV));
    await expect
      .element(page.getByRole("button", { name: "Verify", exact: true }))
      .toBeEnabled();
    await expect
      .element(
        page.getByText(
          "Supply both the input and the result to open the commitments",
          { exact: false },
        ),
      )
      .not.toBeInTheDocument();
  });

  test("loading different partner terms after a verdict clears the stale verdict", async () => {
    const { record, keys } = await buildFixture();
    await mountVerifyBench();

    await uploadAt(0, jsonFile("rec.json", serializeExchangeRecord(record)));
    await uploadAt(
      1,
      jsonFile("rec.keys.json", serializeVerificationKeys(keys)),
    );
    await userEvent.click(
      page.getByRole("button", {
        name: "Re-supply your files to open the commitments",
      }),
    );
    await uploadAt(2, csvFile("input.csv", INPUT_CSV));
    await uploadAt(3, csvFile("result.csv", RESULT_CSV));
    await userEvent.fill(
      page.getByLabelText("Your linkage terms"),
      JSON.stringify(LOCAL_TERMS),
    );
    await userEvent.click(
      page.getByRole("button", { name: "Load these terms" }).first(),
    );
    await userEvent.fill(
      page.getByLabelText("Your partner's linkage terms"),
      JSON.stringify(PARTNER_TERMS),
    );
    await userEvent.click(
      page.getByRole("button", { name: "Load these terms" }).nth(1),
    );
    await userEvent.click(
      page.getByRole("button", { name: "Verify with these files" }),
    );
    await expect.element(page.getByText("Verified")).toBeInTheDocument();
    await expect
      .element(page.getByText("Re-derives and matches"))
      .toBeInTheDocument();

    // Loading different partner terms changes what a re-run would consume, so
    // the stale verdict (still claiming "Re-derives and matches") must not be
    // left on screen -- it must disappear until Verify runs again.
    const otherPartnerTerms: LinkageTerms = {
      ...PARTNER_TERMS,
      identity: "Party C",
    };
    await userEvent.fill(
      page.getByLabelText("Your partner's linkage terms"),
      JSON.stringify(otherPartnerTerms),
    );
    await userEvent.click(
      page.getByRole("button", { name: "Load these terms" }).nth(1),
    );
    await expect.element(page.getByText("Verified")).not.toBeInTheDocument();
    await expect
      .element(page.getByText("Re-derives and matches"))
      .not.toBeInTheDocument();
  });

  test("loading a new record file clears previously re-supplied files and terms", async () => {
    const { record, keys } = await buildFixture();
    await mountVerifyBench();

    await uploadAt(0, jsonFile("rec.json", serializeExchangeRecord(record)));
    await uploadAt(
      1,
      jsonFile("rec.keys.json", serializeVerificationKeys(keys)),
    );
    await userEvent.click(
      page.getByRole("button", {
        name: "Re-supply your files to open the commitments",
      }),
    );
    await uploadAt(2, csvFile("input.csv", INPUT_CSV));
    await uploadAt(3, csvFile("result.csv", RESULT_CSV));

    // Swap in a different (still valid) record: the stale re-supply state from
    // the previous exchange must not silently feed the next verify.
    await uploadAt(0, jsonFile("rec2.json", serializeExchangeRecord(record)));
    await expect.element(page.getByText("input.csv")).not.toBeInTheDocument();
    await expect.element(page.getByText("result.csv")).not.toBeInTheDocument();
  });

  test("loading a new record file empties the terms paste buffers", async () => {
    const { record, keys } = await buildFixture();
    await mountVerifyBench();

    await uploadAt(0, jsonFile("rec.json", serializeExchangeRecord(record)));
    await uploadAt(
      1,
      jsonFile("rec.keys.json", serializeVerificationKeys(keys)),
    );
    await userEvent.click(
      page.getByRole("button", {
        name: "Re-supply your files to open the commitments",
      }),
    );
    await userEvent.fill(
      page.getByLabelText("Your partner's linkage terms"),
      JSON.stringify(PARTNER_TERMS),
    );
    await userEvent.click(
      page.getByRole("button", { name: "Load these terms" }).nth(1),
    );
    await expect
      .element(page.getByText("Loaded.", { exact: true }))
      .toBeInTheDocument();

    // The parsed terms are dropped with the rest of the previous exchange's
    // re-supply, so the text they were parsed from must go with them: left
    // behind, it invites re-importing the previous partnership's terms against
    // this record.
    await uploadAt(0, jsonFile("rec2.json", serializeExchangeRecord(record)));
    await expect
      .element(page.getByLabelText("Your partner's linkage terms"))
      .toHaveValue("");
    await expect
      .element(page.getByText("Loaded.", { exact: true }))
      .not.toBeInTheDocument();
  });

  test("editing a terms buffer after a verdict withdraws that parse and the verdict", async () => {
    const { record, keys } = await buildFixture();
    await mountVerifyBench();

    await uploadAt(0, jsonFile("rec.json", serializeExchangeRecord(record)));
    await uploadAt(
      1,
      jsonFile("rec.keys.json", serializeVerificationKeys(keys)),
    );
    await userEvent.click(
      page.getByRole("button", {
        name: "Re-supply your files to open the commitments",
      }),
    );
    await uploadAt(2, csvFile("input.csv", INPUT_CSV));
    await uploadAt(3, csvFile("result.csv", RESULT_CSV));
    await userEvent.fill(
      page.getByLabelText("Your linkage terms"),
      JSON.stringify(LOCAL_TERMS),
    );
    await userEvent.click(
      page.getByRole("button", { name: "Load these terms" }).first(),
    );
    await userEvent.fill(
      page.getByLabelText("Your partner's linkage terms"),
      JSON.stringify(PARTNER_TERMS),
    );
    await userEvent.click(
      page.getByRole("button", { name: "Load these terms" }).nth(1),
    );
    await userEvent.click(
      page.getByRole("button", { name: "Verify with these files" }),
    );
    await expect.element(page.getByText("Verified")).toBeInTheDocument();
    const loadedBadges = page.getByText("Loaded.", { exact: true });
    await expect.element(loadedBadges.nth(1)).toBeInTheDocument();

    // Typing over the imported document leaves a value on screen that was never
    // imported: the badge and the verdict computed from the previous parse must
    // not describe it.
    await userEvent.fill(
      page.getByLabelText("Your partner's linkage terms"),
      JSON.stringify({ ...PARTNER_TERMS, identity: "Party C" }),
    );
    await expect.element(loadedBadges.nth(1)).not.toBeInTheDocument();
    await expect.element(loadedBadges.first()).toBeInTheDocument();
    await expect.element(page.getByText("Verified")).not.toBeInTheDocument();
    await expect
      .element(page.getByText("What was checked"))
      .not.toBeInTheDocument();
  });

  test("a dual-signed record with both certificates anchored reaches the signed verified verdict", async () => {
    const { record, keys } = await buildFixture();
    const { signed, ourCertificate, partnerFingerprint } =
      await buildSignedFixture(record);
    await mountVerifyBench();

    // The exchange record states who this exchange was between and what terms
    // it agreed, which the signature checks are held against.
    await uploadAt(0, jsonFile("rec.json", serializeExchangeRecord(record)));
    await uploadAt(
      1,
      jsonFile("rec.keys.json", serializeVerificationKeys(keys)),
    );
    await userEvent.click(
      page.getByRole("button", {
        name: "Check the partner's signatures with the dual-signed record",
      }),
    );
    await uploadTo(
      "Dual-signed record",
      jsonFile("psilink-receipt-x.json", serializeDualSignedRecord(signed)),
    );
    await userEvent.fill(
      page.getByLabelText("Your partner's certificate fingerprint"),
      partnerFingerprint,
    );
    await uploadTo(
      "Your exported certificate",
      jsonFile("certificate.json", serializeCertificate(ourCertificate)),
    );
    await userEvent.click(
      page.getByRole("button", { name: "Verify with the signed record" }),
    );

    await expect
      .element(page.getByText("Signed receipt verified"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Matches the fingerprint you pinned out-of-band"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Is the certificate you supplied as your own"))
      .toBeInTheDocument();
    // The record's own section stops claiming signatures went unchecked when a
    // dual-signed verdict is on screen beside it.
    await expect
      .element(
        page.getByText("checked separately below", { exact: false }).first(),
      )
      .toBeInTheDocument();
  });

  test("an unanchored partner leaves the signed verdict incomplete, naming the slot", async () => {
    const { record, keys } = await buildFixture();
    const { signed, ourCertificate } = await buildSignedFixture(record);
    await mountVerifyBench();

    await uploadAt(0, jsonFile("rec.json", serializeExchangeRecord(record)));
    await uploadAt(
      1,
      jsonFile("rec.keys.json", serializeVerificationKeys(keys)),
    );
    await userEvent.click(
      page.getByRole("button", {
        name: "Check the partner's signatures with the dual-signed record",
      }),
    );
    await uploadTo(
      "Dual-signed record",
      jsonFile("receipt.json", serializeDualSignedRecord(signed)),
    );
    await uploadTo(
      "Your exported certificate",
      jsonFile("certificate.json", serializeCertificate(ourCertificate)),
    );
    await userEvent.click(
      page.getByRole("button", { name: "Verify with the signed record" }),
    );

    await expect
      .element(page.getByText("Signed receipt incomplete"))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Nothing outside the record anchors the responder's certificate",
          { exact: false },
        ),
      )
      .toBeInTheDocument();
  });

  test("the signing identity file is refused where the exported certificate belongs", async () => {
    const { record } = await buildFixture();
    const { ourIdentity } = await buildSignedFixture(record);
    await mountVerifyBench();

    await userEvent.click(
      page.getByRole("button", {
        name: "Check the partner's signatures with the dual-signed record",
      }),
    );
    await uploadTo(
      "Your exported certificate",
      jsonFile("signing-identity.json", serializeSigningIdentity(ourIdentity)),
    );

    await expect
      .element(page.getByText("This certificate could not be used"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("private signing key", { exact: false }))
      .toBeInTheDocument();
    // The file card stays: the input was not cleared, so the user can swap it.
    await expect
      .element(page.getByText("signing-identity.json"))
      .toBeInTheDocument();
  });

  test("a fingerprint that is not a fingerprint gates the run rather than reaching it", async () => {
    const { record, keys } = await buildFixture();
    await mountVerifyBench();

    await uploadAt(0, jsonFile("rec.json", serializeExchangeRecord(record)));
    await uploadAt(
      1,
      jsonFile("rec.keys.json", serializeVerificationKeys(keys)),
    );
    await expect
      .element(page.getByRole("button", { name: "Verify", exact: true }))
      .toBeEnabled();

    await userEvent.click(
      page.getByRole("button", {
        name: "Check the partner's signatures with the dual-signed record",
      }),
    );
    await userEvent.fill(
      page.getByLabelText("Your partner's certificate fingerprint"),
      "not-a-fingerprint",
    );
    // A malformed pin is reported as its own fault, and no run can turn it into
    // "the partner's certificate does not match".
    await expect
      .element(page.getByText("43 characters", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Verify", exact: true }))
      .toBeDisabled();
  });

  test("re-pinning the partner's fingerprint after a joint verify clears both verdicts", async () => {
    const { signed } = await verifyRecordAndSignedRecord();

    // A fingerprint that anchors nothing in the partner's slot: the signed
    // panel goes, and the record verdict's note must not be left behind
    // pointing at signatures checked below.
    await userEvent.fill(
      page.getByLabelText("Your partner's certificate fingerprint"),
      await computeCertificateFingerprint(signed.initiator.certificate),
    );

    await expectBothVerdictsGone();
  });

  test("swapping the certificate after a joint verify clears both verdicts", async () => {
    const { signed } = await verifyRecordAndSignedRecord();

    await uploadTo(
      "Your exported certificate",
      jsonFile(
        "other-certificate.json",
        serializeCertificate(signed.responder.certificate),
      ),
    );

    await expectBothVerdictsGone();
  });

  test("swapping the dual-signed record after a joint verify clears both verdicts", async () => {
    const { record } = await verifyRecordAndSignedRecord();
    const { signed: otherSigned } = await buildSignedFixture(record);

    await uploadTo(
      "Dual-signed record",
      jsonFile("other-receipt.json", serializeDualSignedRecord(otherSigned)),
    );

    await expectBothVerdictsGone();
  });

  // The recurring case: the same two parties run the same exchange again. Both
  // identities and the agreed-terms hash are byte-identical across those runs, so
  // what separates them is the run binder the two artifacts carry -- which the
  // verdict does compare. This is the UI half of that defense: the previous run's
  // receipt is dropped when this run's record is loaded, rather than left to be
  // verified beside it and reported as a mismatch.
  test("a record from the next run of the same exchange drops the previous receipt", async () => {
    await verifyRecordAndSignedRecord();
    const { record: nextRecord, keys: nextKeys } =
      await buildFixture("bmV4dFJ1bkJpbmRlcg");

    await uploadAt(
      0,
      jsonFile("rec2.json", serializeExchangeRecord(nextRecord)),
    );
    await uploadAt(
      1,
      jsonFile("rec2.keys.json", serializeVerificationKeys(nextKeys)),
    );
    await expect
      .element(page.getByText("psilink-receipt-x.json"))
      .not.toBeInTheDocument();

    await userEvent.click(
      page.getByRole("button", { name: "Verify", exact: true }),
    );

    await expect
      .element(page.getByText("What was checked"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Signed receipt verified"))
      .not.toBeInTheDocument();
    await expect
      .element(
        page.getByText("Partner receipt signatures are not checked", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
  });

  test("one re-supplied CSV does not gate a run that only checks the signed record", async () => {
    const { record } = await buildFixture();
    const { signed, ourCertificate, partnerFingerprint } =
      await buildSignedFixture(record);
    await mountVerifyBench();

    // Neither the record nor its keys is loaded, so nothing this run does
    // reads the re-supplied CSVs -- one of them dropped must not block it.
    await userEvent.click(
      page.getByRole("button", {
        name: "Re-supply your files to open the commitments",
      }),
    );
    await uploadAt(2, csvFile("input.csv", INPUT_CSV));
    await userEvent.click(
      page.getByRole("button", {
        name: "Check the partner's signatures with the dual-signed record",
      }),
    );
    await uploadTo(
      "Dual-signed record",
      jsonFile("receipt.json", serializeDualSignedRecord(signed)),
    );
    await userEvent.fill(
      page.getByLabelText("Your partner's certificate fingerprint"),
      partnerFingerprint,
    );
    await uploadTo(
      "Your exported certificate",
      jsonFile("certificate.json", serializeCertificate(ourCertificate)),
    );

    await expect
      .element(
        page.getByRole("button", { name: "Verify with the signed record" }),
      )
      .toBeEnabled();
    await userEvent.click(
      page.getByRole("button", { name: "Verify with the signed record" }),
    );

    // The signed leg ran: both certificates are anchored, and what holds the
    // verdict short of verified is the absent record, not the CSV pair.
    await expect
      .element(page.getByText("Signed receipt incomplete"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Matches the fingerprint you pinned out-of-band"))
      .toBeInTheDocument();
  });

  test("one re-supplied CSV gates the signed section's run once the record is loaded", async () => {
    const { record, keys } = await buildFixture();
    const { signed, partnerFingerprint } = await buildSignedFixture(record);
    await mountVerifyBench();

    await uploadAt(0, jsonFile("rec.json", serializeExchangeRecord(record)));
    await uploadAt(
      1,
      jsonFile("rec.keys.json", serializeVerificationKeys(keys)),
    );
    await userEvent.click(
      page.getByRole("button", {
        name: "Re-supply your files to open the commitments",
      }),
    );
    await uploadAt(2, csvFile("input.csv", INPUT_CSV));
    await userEvent.click(
      page.getByRole("button", {
        name: "Check the partner's signatures with the dual-signed record",
      }),
    );
    await uploadTo(
      "Dual-signed record",
      jsonFile("receipt.json", serializeDualSignedRecord(signed)),
    );
    await userEvent.fill(
      page.getByLabelText("Your partner's certificate fingerprint"),
      partnerFingerprint,
    );

    // Every button starts the same run, and this one reconstructs from the
    // re-supplied files: starting it from the signed section would open the
    // commitments no more than starting it from the top would.
    await expect
      .element(
        page.getByRole("button", { name: "Verify with the signed record" }),
      )
      .toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: "Verify", exact: true }))
      .toBeDisabled();
  });
});
