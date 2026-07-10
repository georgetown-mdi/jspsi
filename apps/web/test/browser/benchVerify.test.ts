/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import {
  buildExchangeRecord,
  serializeExchangeRecord,
  serializeVerificationKeys,
} from "@psilink/core";

import { BenchLobby } from "@bench/BenchLobby";
import { VerifyReceiptBench } from "@bench/VerifyReceiptBench";

import type {
  AssociationTable,
  CommittedPayload,
  ExchangeRecord,
  LinkageTerms,
  VerificationKeys,
} from "@psilink/core";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

// Router seam: the lobby's action cards are Links; render them as plain anchors
// so the navigation-target assertion reads the href. (vitest hoists vi.mock.)
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    className,
    children,
  }: {
    to?: string;
    className?: string;
    children?: ReactNode;
  }) =>
    createElement(
      "a",
      { href: typeof to === "string" ? to : "#", className },
      children,
    ),
  useNavigate: () => () => undefined,
}));

const LOCAL_TERMS: LinkageTerms = {
  version: "1.0.0",
  identity: "Party A",
  date: "2025-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};
const PARTNER_TERMS: LinkageTerms = { ...LOCAL_TERMS, identity: "Party B" };

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

async function buildFixture(): Promise<{
  record: ExchangeRecord;
  keys: VerificationKeys;
}> {
  return buildExchangeRecord({
    localTerms: LOCAL_TERMS,
    partnerTerms: PARTNER_TERMS,
    recordsExposed: 2,
    localPayloadSent,
    partnerPayloadReceived,
    associationTable,
    createdAt: "2026-01-02T03:04:05.000Z",
  });
}

function jsonFile(name: string, content: string): File {
  return new File([content], name, { type: "application/json" });
}
function csvFile(name: string, content: string): File {
  return new File([content], name, { type: "text/csv" });
}

let container: HTMLElement | undefined;
let root: Root | undefined;

function mount(content: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(createElement(MantineProvider, null, content));
}

// The Mantine Dropzone renders a hidden file input; the page's dropzones appear
// in DOM order (record, keys, then the two re-supply CSVs once the section is
// open). Upload to the nth file input.
function fileInputAt(index: number): HTMLElement {
  const inputs = document.querySelectorAll('input[type="file"]');
  return inputs[index] as HTMLElement;
}

// The page mounts its dropzones after the first render; wait for the heading so
// the file inputs exist before the first upload.
async function mountVerifyBench() {
  mount(createElement(VerifyReceiptBench));
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toHaveTextContent("Verify a receipt");
}

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("bench lobby: verify a receipt card", () => {
  test("the third action card links to the verify bench", async () => {
    mount(createElement(BenchLobby));
    await expect
      .element(
        page.getByRole("heading", { level: 3, name: "Verify a receipt" }),
      )
      .toBeInTheDocument();
    const verifyLink = Array.from(document.querySelectorAll("a")).find(
      (anchor) => anchor.textContent === "Verify a receipt",
    );
    expect(verifyLink?.getAttribute("href")).toBe("/bench/verify");
  });
});

describe("verify receipt bench", () => {
  test("full happy path: record + keys + re-supplied files reach a verified verdict", async () => {
    const { record, keys } = await buildFixture();
    await mountVerifyBench();

    // Load the record and its keys.
    await userEvent.upload(
      page.elementLocator(fileInputAt(0)),
      jsonFile("psilink-record-x.json", serializeExchangeRecord(record)),
    );
    await expect
      .element(page.getByText("psilink-record-x.json"))
      .toBeInTheDocument();
    await userEvent.upload(
      page.elementLocator(fileInputAt(1)),
      jsonFile("psilink-record-x.keys.json", serializeVerificationKeys(keys)),
    );
    await expect
      .element(page.getByText("psilink-record-x.keys.json"))
      .toBeInTheDocument();

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
    await userEvent.upload(
      page.elementLocator(fileInputAt(2)),
      csvFile("input.csv", INPUT_CSV),
    );
    await expect.element(page.getByText("input.csv")).toBeInTheDocument();
    await userEvent.upload(
      page.elementLocator(fileInputAt(3)),
      csvFile("result.csv", RESULT_CSV),
    );
    await expect.element(page.getByText("result.csv")).toBeInTheDocument();

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
    const tampered: ExchangeRecord = {
      ...record,
      commitments: {
        ...record.commitments,
        localPayloadSent:
          record.commitments.localPayloadSent.slice(0, -2) + "AA",
      },
    };
    await mountVerifyBench();

    await userEvent.upload(
      page.elementLocator(fileInputAt(0)),
      jsonFile("rec.json", serializeExchangeRecord(tampered)),
    );
    await userEvent.upload(
      page.elementLocator(fileInputAt(1)),
      jsonFile("rec.keys.json", serializeVerificationKeys(keys)),
    );
    // Open re-supply, load the input and result so the commitment is opened and
    // the mismatch is reached.
    await userEvent.click(
      page.getByRole("button", {
        name: "Re-supply your files to open the commitments",
      }),
    );
    await userEvent.upload(
      page.elementLocator(fileInputAt(2)),
      csvFile("input.csv", INPUT_CSV),
    );
    await userEvent.upload(
      page.elementLocator(fileInputAt(3)),
      csvFile("result.csv", RESULT_CSV),
    );
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

  test("a missing-salt keys file renders the distinct wrong-or-drifted state", async () => {
    const { record, keys } = await buildFixture();
    // The optional association-table salt is schema-valid to omit, so the keys
    // file parses (the mandatory salts stay), reaching the unopenable path.
    const wrongKeys: VerificationKeys = {
      ...keys,
      salts: { ...keys.salts, associationTable: undefined },
    };
    await mountVerifyBench();

    await userEvent.upload(
      page.elementLocator(fileInputAt(0)),
      jsonFile("rec.json", serializeExchangeRecord(record)),
    );
    await userEvent.upload(
      page.elementLocator(fileInputAt(1)),
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
    await userEvent.upload(
      page.elementLocator(fileInputAt(1)),
      jsonFile("rec.keys.json", serializeVerificationKeys(keys)),
    );
    await userEvent.upload(
      page.elementLocator(fileInputAt(0)),
      jsonFile("rec.json", "{ not json"),
    );

    await expect
      .element(page.getByText("This record could not be used"))
      .toBeInTheDocument();
    // The chosen file card stays: the input was not cleared.
    await expect.element(page.getByText("rec.json")).toBeInTheDocument();
    // Verify is gated: no valid record, so no verdict.
    await expect
      .element(page.getByRole("button", { name: "Verify" }))
      .toBeDisabled();
    // A good record clears the alert and re-enables Verify.
    await userEvent.upload(
      page.elementLocator(fileInputAt(0)),
      jsonFile("rec.json", serializeExchangeRecord(record)),
    );
    await expect
      .element(page.getByRole("button", { name: "Verify" }))
      .toBeEnabled();
  });
});
