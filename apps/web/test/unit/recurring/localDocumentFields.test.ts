import { describe, expect, test } from "vitest";

import {
  disclosedColumnNames,
  generateSharedSecret,
  getDefaultLinkageTerms,
  inferMetadata,
  parseExchangeSpec,
  parseSensitiveYaml,
  snakeizeKeys,
} from "@alcove/core";

import { stringify as stringifyYaml } from "yaml";

import {
  applyManagedExchangeLocalEdits,
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  parseManagedExchangeRecord,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  composeManagedCronExport,
  composeManagedCronExportConfig,
} from "@psi/managed/managedCronExport";
import { CSV_DELIMITER_OTHER } from "@components/csvDelimiterChoice";
import { prepareManagedRerunExchange } from "@psi/managed/managedPreparedExchange";
import { readManagedCommandLineConfiguration } from "@psi/managed/managedCommandLineImport";

import {
  csvDelimiterChoiceFrom,
  delimiterRecheckFrom,
  delimiterRecheckNote,
  localDocumentFieldEdits,
  localDocumentFieldValuesFrom,
  ownColumnsOffered,
} from "@recurring/localDocumentFieldsModel";

import type { CSVRow, ExchangeSpec } from "@alcove/core";
import type { LocalDocumentFieldValues } from "@recurring/localDocumentFieldsModel";
import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";

// The stored exchange's editor for its document's three per-party settings:
// what each control starts on for an imported document, what a save writes,
// and that each edit reaches both the configuration the export hands back and
// the document the next run is prepared from.

const columns = ["client_id", "first_name", "last_name", "dob", "program_code"];
const metadata = inferMetadata(columns, []);
const linkageTerms = getDefaultLinkageTerms("County Health Dept", metadata);

const rows: Array<CSVRow> = [
  {
    client_id: "17",
    first_name: "Ada",
    last_name: "Lovelace",
    dob: "12/10/1815",
    program_code: "A7",
  },
];

const note = "Filed with the program office for seven years.";

function storedDocument(overrides: Partial<ExchangeSpec> = {}): ExchangeSpec {
  return {
    ...composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms,
      metadata,
      disclosedPayloadColumns: disclosedColumnNames(metadata),
    }),
    ...overrides,
  };
}

/** A record a browser runs: it holds a secret. */
function runnableRecord(
  overrides: Partial<ExchangeSpec> = {},
): ManagedExchangeRecord {
  return buildManagedExchangeRecord({
    label: "Riverbend quarterly",
    exchangeFile: storedDocument(overrides),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
  });
}

/** Save the controls as the editor would, through the store's own transform. */
function save(
  record: ManagedExchangeRecord,
  edit: Partial<LocalDocumentFieldValues>,
): ManagedExchangeRecord {
  const values = {
    ...localDocumentFieldValuesFrom(record.exchangeFile),
    ...edit,
  };
  return applyManagedExchangeLocalEdits(
    record,
    localDocumentFieldEdits(record.exchangeFile, values),
  );
}

/** The document the command-line export writes for a record, read back. */
function exported(record: ManagedExchangeRecord): ExchangeSpec {
  return parseExchangeSpec(
    parseSensitiveYaml(
      composeManagedCronExport(runnableManagedExchangeOrRefuse(record)).config
        .text,
      "export",
    ),
  );
}

/** The record the store reads back, as a plain object through the schema. */
function readBack(record: ManagedExchangeRecord): ManagedExchangeRecord {
  return parseManagedExchangeRecord(
    JSON.parse(JSON.stringify(record)) as unknown,
  );
}

describe("an imported value pre-fills each control", () => {
  test("each control starts on the value the imported file states", () => {
    const imported = readManagedCommandLineConfiguration(
      stringifyYaml(
        snakeizeKeys({
          ...storedDocument({
            includeOwnColumns: "disclosed",
            csvDelimiter: ";",
            retentionDisposition: note,
          }),
          connection: {
            ...storedDocument().connection,
            role: "acceptor",
          },
        }),
      ),
    );

    expect(localDocumentFieldValuesFrom(imported.exchangeFile)).toEqual({
      ownColumns: "disclosed",
      delimiter: { option: ";", other: "" },
      retentionNote: note,
    });
  });

  test("a document stating none starts each control on what it reads as", () => {
    expect(localDocumentFieldValuesFrom(storedDocument())).toEqual({
      ownColumns: "none",
      delimiter: { option: ",", other: "" },
      retentionNote: "",
    });
  });

  test.each([
    ["a named separator", "|", { option: "|", other: "" }],
    ["a tab", "\t", { option: "\t", other: "" }],
    ["detection", "detect", { option: "detect", other: "" }],
    ["any other character", ":", { option: CSV_DELIMITER_OTHER, other: ":" }],
  ] as const)("%s selects its own option", (_case, stored, choice) => {
    expect(csvDelimiterChoiceFrom(stored)).toEqual(choice);
  });

  test("a document read back with `tab` spelled out selects the tab option", () => {
    const record = readBack(runnableRecord({ csvDelimiter: "tab" }));

    expect(localDocumentFieldValuesFrom(record.exchangeFile).delimiter).toEqual(
      { option: "\t", other: "" },
    );
  });
});

describe("a save writes only what the operator changed", () => {
  test("an untouched editor writes nothing to the document", () => {
    const document = storedDocument({
      includeOwnColumns: "all",
      csvDelimiter: "|",
      retentionDisposition: note,
    });

    expect(
      localDocumentFieldEdits(document, localDocumentFieldValuesFrom(document)),
    ).toEqual({});
  });

  test("a document with none of the three is left without them", () => {
    const record = runnableRecord();

    expect(save(record, {}).exchangeFile).toEqual(record.exchangeFile);
  });

  test("the own-columns choice is left alone where the terms write no result file", () => {
    const document = storedDocument({
      linkageTerms: {
        ...linkageTerms,
        output: { expectsOutput: false, shareWithPartner: true },
      },
    });

    expect(ownColumnsOffered(document)).toBe(false);
    expect(
      localDocumentFieldEdits(document, {
        ...localDocumentFieldValuesFrom(document),
        ownColumns: "all",
      }),
    ).toEqual({});
  });

  test("a refused separator writes nothing", () => {
    const document = storedDocument();

    expect(
      localDocumentFieldEdits(document, {
        ...localDocumentFieldValuesFrom(document),
        delimiter: { option: CSV_DELIMITER_OTHER, other: '"' },
      }),
    ).toEqual({});
  });
});

describe("each edit reaches the export and the next run", () => {
  test("the own-columns choice", () => {
    const edited = readBack(save(runnableRecord(), { ownColumns: "all" }));

    expect(exported(edited).includeOwnColumns).toBe("all");
    expect(
      prepareManagedRerunExchange(edited.exchangeFile, rows, columns)
        .includeOwnColumns,
    ).toBe("all");
  });

  test("clearing the own-columns choice drops it from both", () => {
    const edited = readBack(
      save(runnableRecord({ includeOwnColumns: "all" }), {
        ownColumns: "none",
      }),
    );

    expect(exported(edited)).not.toHaveProperty("includeOwnColumns");
    expect(
      prepareManagedRerunExchange(edited.exchangeFile, rows, columns)
        .includeOwnColumns,
    ).toBeUndefined();
  });

  test("the separator", () => {
    const edited = readBack(
      save(runnableRecord(), { delimiter: { option: ";", other: "" } }),
    );

    // The run reads its input by the stored document's `csvDelimiter`
    // (`acquireValidatedManagedInput`), and writes its result with it.
    expect(edited.exchangeFile.csvDelimiter).toBe(";");
    expect(exported(edited).csvDelimiter).toBe(";");
  });

  test("a separator typed under Other", () => {
    const edited = readBack(
      save(runnableRecord({ csvDelimiter: "|" }), {
        delimiter: { option: CSV_DELIMITER_OTHER, other: "tab" },
      }),
    );

    expect(edited.exchangeFile.csvDelimiter).toBe("\t");
    expect(exported(edited).csvDelimiter).toBe("\t");
  });

  test("the retention note, trimmed", () => {
    const edited = readBack(
      save(runnableRecord(), { retentionNote: `  ${note}\n` }),
    );

    expect(exported(edited).retentionDisposition).toBe(note);
    expect(
      prepareManagedRerunExchange(edited.exchangeFile, rows, columns)
        .retentionDisposition,
    ).toBe(note);
  });

  test("an emptied retention note drops it from both", () => {
    const edited = readBack(
      save(runnableRecord({ retentionDisposition: note }), {
        retentionNote: "  ",
      }),
    );

    expect(exported(edited)).not.toHaveProperty("retentionDisposition");
    expect(
      prepareManagedRerunExchange(edited.exchangeFile, rows, columns)
        .retentionDisposition,
    ).toBeUndefined();
  });

  test("an imported configuration exports back with all three edits and nothing else changed", () => {
    const source = stringifyYaml(
      snakeizeKeys({
        ...storedDocument({ csvDelimiter: "|" }),
        connection: { ...storedDocument().connection, role: "acceptor" },
      }),
    );
    const imported = readManagedCommandLineConfiguration(source);

    const edited = save(imported, {
      ownColumns: "disclosed",
      delimiter: { option: ";", other: "" },
      retentionNote: note,
    });

    expect(
      parseExchangeSpec(
        parseSensitiveYaml(
          composeManagedCronExportConfig(edited).config.text,
          "re-export",
        ),
      ),
    ).toEqual({
      ...parseExchangeSpec(parseSensitiveYaml(source, "import")),
      includeOwnColumns: "disclosed",
      csvDelimiter: ";",
      retentionDisposition: note,
    });
  });
});

describe("re-reading the input file under a changed separator", () => {
  test("a file whose columns cover every agreed key fits", () => {
    const recheck = delimiterRecheckFrom(storedDocument(), columns);

    expect(recheck).toEqual({ kind: "fits", columnCount: columns.length });
    expect(delimiterRecheckNote(recheck)?.tone).toBe("ok");
  });

  test("a file read as one column states the separator remedy", () => {
    const recheck = delimiterRecheckFrom(storedDocument(), [columns.join(";")]);

    expect(recheck).toEqual({ kind: "short", singleColumn: true });
    expect(delimiterRecheckNote(recheck)?.message).toContain("single column");
  });

  test("a file short of an agreed key is named as such", () => {
    const recheck = delimiterRecheckFrom(storedDocument(), [
      "client_id",
      "program_code",
    ]);

    expect(recheck).toEqual({ kind: "short", singleColumn: false });
    expect(delimiterRecheckNote(recheck)?.message).toContain(
      "every agreed key",
    );
  });
});
