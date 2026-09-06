import { describe, expect, test } from "vitest";

import { parse as parseYaml } from "yaml";

import {
  disclosedColumnNames,
  generateSharedSecret,
  getDefaultLinkageTerms,
  inferMetadata,
} from "@psilink/core";

import {
  EMPTY_SAVE_FIELDS,
  exchangeFileInputFor,
} from "@exchange/saveExchangeModel";
import {
  buildManagedDeposit,
  composeManagedDocument,
  webrtcLocatorFromEndpoint,
} from "@exchange/manageOfferModel";
import {
  buildManagedExchangeRecord,
  parseManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import {
  composeConfigDocument,
  composeSftpConfigDocument,
} from "@jobs/intentConfig";
import { jobExchangeIntentSchema } from "@jobs/intentSchemas";
import { prepareManagedRerunExchange } from "@psi/managed/managedPreparedExchange";

import {
  testSftpServerEntry,
  validIntent,
  validSftpIntent,
} from "../../utils/jobFixtures";

import type { CSVRow, WebRTCEndpoint } from "@psilink/core";
import type { GeneratedInvitation } from "@psi/invitation";

// Where the authoring control's choice lands once it leaves the editor: the four
// artifacts an authored exchange produces, and the read-back a recurring run
// depends on.

const columns = ["client_id", "first_name", "last_name", "dob", "program_code"];
const metadata = inferMetadata(columns);
const terms = getDefaultLinkageTerms("County Health Dept", metadata);

const rows: Array<CSVRow> = [
  {
    client_id: "17",
    first_name: "Ada",
    last_name: "Lovelace",
    dob: "12/10/1815",
    program_code: "A7",
  },
];

const endpoint: WebRTCEndpoint = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
};

function depositRecord(includeOwnColumns?: "disclosed" | "all") {
  return buildManagedExchangeRecord(
    buildManagedDeposit(
      {
        documentParts: {
          side: "inviter",
          linkageTerms: terms,
          metadata,
          disclosedPayloadColumns: disclosedColumnNames(metadata),
          ...(includeOwnColumns !== undefined ? { includeOwnColumns } : {}),
        },
        connection: webrtcLocatorFromEndpoint(endpoint),
        sharedSecret: generateSharedSecret(),
        choices: { label: "Riverbend quarterly" },
      },
      Date.parse("2026-03-01T00:00:00.000Z"),
    ),
  );
}

describe("a managed exchange keeps the authored selection", () => {
  test.each(["disclosed", "all"] as const)(
    "%s round-trips through the stored record into a re-run",
    (choice) => {
      const stored = depositRecord(choice);
      expect(stored.exchangeFile.includeOwnColumns).toBe(choice);

      // The store hands back a plain object, so the read path is the schema's,
      // not the composer's in-memory value.
      const readBack = parseManagedExchangeRecord(
        JSON.parse(JSON.stringify(stored)) as unknown,
      );
      expect(readBack.exchangeFile.includeOwnColumns).toBe(choice);

      const prepared = prepareManagedRerunExchange(
        readBack.exchangeFile,
        rows,
        columns,
      );
      expect(prepared.includeOwnColumns).toBe(choice);
    },
  );

  test("a record written without the key reads back with it absent", () => {
    const stored = depositRecord();
    expect(stored.exchangeFile).not.toHaveProperty("includeOwnColumns");

    const readBack = parseManagedExchangeRecord(
      JSON.parse(JSON.stringify(stored)) as unknown,
    );
    expect(readBack.exchangeFile.includeOwnColumns).toBeUndefined();
    expect(
      prepareManagedRerunExchange(readBack.exchangeFile, rows, columns)
        .includeOwnColumns,
    ).toBeUndefined();
  });

  test("a document composed without the choice holds no key at all", () => {
    const document = composeManagedDocument(
      { side: "inviter", linkageTerms: terms, metadata },
      webrtcLocatorFromEndpoint(endpoint),
    );
    expect(document).not.toHaveProperty("includeOwnColumns");
  });
});

describe("the saved exchange file states the selection", () => {
  const minted = {
    linkageTerms: terms,
    metadata,
    disclosedPayloadColumns: disclosedColumnNames(metadata),
  } as unknown as GeneratedInvitation;

  test("the mint's decided selection reaches the file's input", () => {
    const input = exchangeFileInputFor(
      "filedrop",
      { ...EMPTY_SAVE_FIELDS, sharedDirectory: "/rendezvous" },
      { ...minted, includeOwnColumns: "all" },
    );
    expect(input.includeOwnColumns).toBe("all");
  });

  test("a mint that decided none composes no key", () => {
    const input = exchangeFileInputFor(
      "filedrop",
      { ...EMPTY_SAVE_FIELDS, sharedDirectory: "/rendezvous" },
      minted,
    );
    expect(input).not.toHaveProperty("includeOwnColumns");
  });
});

describe("the console's composed config states the selection", () => {
  test("the boundary schema admits both values and refuses anything else", () => {
    for (const value of ["disclosed", "all"])
      expect(
        jobExchangeIntentSchema.safeParse({
          mode: "exchange",
          ...validIntent({ includeOwnColumns: value as "all" }),
        }).success,
      ).toBe(true);
    expect(
      jobExchangeIntentSchema.safeParse({
        mode: "exchange",
        ...validIntent({ includeOwnColumns: "everything" as "all" }),
      }).success,
    ).toBe(false);
  });

  test("the filedrop composer writes include_own_columns", () => {
    const composed = parseYaml(
      composeConfigDocument(
        validIntent({ includeOwnColumns: "all" }),
        "/rendezvous",
      ),
    ) as Record<string, unknown>;
    expect(composed["include_own_columns"]).toBe("all");
  });

  test("the sftp composer writes include_own_columns", () => {
    const composed = parseYaml(
      composeSftpConfigDocument(
        validSftpIntent({ includeOwnColumns: "disclosed" }),
        testSftpServerEntry(),
      ),
    ) as Record<string, unknown>;
    expect(composed["include_own_columns"]).toBe("disclosed");
  });

  test("an intent without the field composes no key", () => {
    const composed = parseYaml(
      composeConfigDocument(validIntent(), "/rendezvous"),
    ) as Record<string, unknown>;
    expect(composed["include_own_columns"]).toBeUndefined();
  });

  test("the key is refused beside a count-only algorithm, before any run", () => {
    // The schema's own cross-field rule: a count-only exchange writes no result
    // file, so the composition fails here rather than at the console's run.
    expect(() =>
      composeConfigDocument(
        validIntent({
          includeOwnColumns: "all",
          linkageTerms: { ...validIntent().linkageTerms, algorithm: "psi-c" },
        }),
        "/rendezvous",
      ),
    ).toThrow();
  });
});
