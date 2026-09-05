import { describe, expect, test } from "vitest";

import {
  LINKAGE_RULE_SET_VERDICT_COPY,
  RECORDED_LINKAGE_RULE_SET_CAVEAT,
  UNNAMED_PARTY_LABEL,
  sanitizeForDisplay,
} from "@psilink/core";

import {
  DISCLOSED_AT_LABEL,
  DISCLOSURE_FACT_LABELS,
  disclosureAccountingCsv,
  disclosureAccountingFileName,
  disclosureEntries,
  disclosureFacts,
  storedDisclosureAccountingDocument,
  storedDisclosureAccountingFileName,
} from "../../src/bench/disclosureAccountingModel.js";
import {
  DISCLOSURE_ACCOUNTING_VERSION,
  appendDisclosureRecord,
} from "../../src/psi/disclosureAccounting.js";

import { disclosureRecord } from "../utils/disclosureFixtures.js";

import type { DisclosureAccounting } from "../../src/psi/disclosureAccounting.js";
import type { DisclosureFact } from "../../src/bench/disclosureAccountingModel.js";
import type { ExchangeRecord } from "@psilink/core";

/**
 * The accounting of disclosures as a reader meets it: the per-run facts on screen
 * and the CSV a compliance reader is handed. Every assertion here is against facts
 * read off a record core built, so a field the accounting stopped sourcing from the
 * record would fail rather than pass against a fixture literal.
 */

/** The accounting these runs' records form, filed in order. */
function accountingOf(...records: Array<ExchangeRecord>): DisclosureAccounting {
  return records.reduce<DisclosureAccounting>(
    (current, record) => appendDisclosureRecord(current, record),
    { version: DISCLOSURE_ACCOUNTING_VERSION, entries: [] },
  );
}

/** One labelled fact. */
function factNamed(
  facts: ReadonlyArray<DisclosureFact>,
  label: string,
): DisclosureFact {
  const found = facts.find((fact) => fact.label === label);
  if (found === undefined) throw new Error(`no fact labelled ${label}`);
  return found;
}

/** The values of one labelled fact, or its named empty state when it holds
 * none. */
function factValues(
  facts: ReadonlyArray<DisclosureFact>,
  label: string,
): Array<string> {
  const found = factNamed(facts, label);
  return found.values.length === 0 ? [found.muted] : [...found.values];
}

/** The caveat the accounting attaches to a present rule-set citation. Read from
 * core rather than restated here: it is the sentence the consent surfaces'
 * per-verdict copy sits beside, and a literal transcribed into this suite would
 * let the accounting drift from it while every assertion stayed green. */
const RULE_SET_CAVEAT = RECORDED_LINKAGE_RULE_SET_CAVEAT;

/** The exported CSV split into physical rows, the trailing terminator dropped. */
function csvRows(csv: string): Array<string> {
  return csv.split("\r\n").slice(0, -1);
}

describe("a disclosure's facts", () => {
  test("name an unnamed partner as unnamed, on screen and in the export", () => {
    // `linkage_terms.identity` is optional, so a record can name no partner. The
    // accounting is a compliance reader's artifact: a blank Partner cell would
    // be treated as a rendering fault, and a stand-in would assert a party nobody
    // named. Both the on-screen fact and the exported row say what happened.
    return disclosureRecord({ partnerIdentity: null }).then((record) => {
      expect("partnerIdentity" in record).toBe(false);
      expect(factValues(disclosureFacts(record), "Partner")).toEqual([
        UNNAMED_PARTY_LABEL,
      ]);
      expect(disclosureEntries(accountingOf(record))[0].partner).toBe(
        UNNAMED_PARTY_LABEL,
      );
      expect(disclosureAccountingCsv(accountingOf(record))).toContain(
        UNNAMED_PARTY_LABEL,
      );
    });
  });

  test("state the accounting's fields from the run's own record", async () => {
    const record = await disclosureRecord({
      partnerIdentity: "Riverbend Schools",
      recordsExposed: 2,
      resultSize: 1,
      retentionDisposition: "Filed in the 2026 evaluation share, 3-year hold",
    });

    const facts = disclosureFacts(record);

    expect(factValues(facts, "Partner")).toEqual([record.partnerIdentity]);
    expect(factValues(facts, "Agreement")).toEqual(["MOU-2025-0042"]);
    expect(factValues(facts, "Purpose of the disclosure")).toEqual([
      "Evaluate shared program enrollment",
    ]);
    expect(factValues(facts, "What was disclosed")).toEqual([
      "Which records you both hold",
    ]);
    // The categories are the columns the record committed, with the data-dictionary
    // description where one was declared.
    expect(factValues(facts, "Columns you sent")).toEqual([
      "dose - Administered dose",
    ]);
    expect(factValues(facts, "Columns you received")).toEqual(["clinic"]);
    expect(factValues(facts, "Matched on")).toEqual([
      "date_of_birth (date_of_birth)",
      "last_name (last_name)",
    ]);
    expect(factValues(facts, "Records you exposed")).toEqual(["2"]);
    expect(factValues(facts, "Result size")).toEqual(["1"]);
    expect(factValues(facts, "Where the result was filed")).toEqual([
      "Filed in the 2026 evaluation share, 3-year hold",
    ]);
  });

  test("say a result size was not recorded rather than inferring one", async () => {
    // The record omits the result size unless both parties' terms had them both
    // receive output, so the accounting reports the omission as what it is.
    const record = await disclosureRecord({ resultSize: null });
    expect(record.resultSize).toBeUndefined();

    expect(factValues(disclosureFacts(record), "Result size")).toEqual([
      "Not recorded - only one party received the result",
    ]);
  });

  test("name the missing agreement rather than leaving the cell blank", async () => {
    const record = await disclosureRecord({ legalAgreement: null });

    const facts = disclosureFacts(record);

    expect(factValues(facts, "Agreement")).toEqual(["Not recorded"]);
    expect(factValues(facts, "Purpose of the disclosure")).toEqual([
      "Not recorded",
    ]);
  });

  test("state the rule set the terms cited, keys before fields, under core's caveat for a recorded citation", async () => {
    const record = await disclosureRecord({ linkageRuleSet: true });

    const facts = disclosureFacts(record);

    expect(factValues(facts, "Rule set cited")).toEqual([
      'Keys: "hmis-keys" 2.1.0',
      'Fields: "baseline-pii" 1.0.0',
    ]);
    expect(factNamed(facts, "Rule set cited").note).toBe(RULE_SET_CAVEAT);
  });

  test("point the reader at the record's own verdict rather than denying one was reached", async () => {
    // A record's citation is always paired with the writing party's verdict on
    // it, so a caveat asserting that nothing checked the citation would be false
    // of every record the accounting can render -- including one whose citation
    // this build resolved and disproved.
    const record = await disclosureRecord({ linkageRuleSet: true });
    expect(record.governance.linkageRuleSetVerdict).toBeDefined();

    const { note } = factNamed(disclosureFacts(record), "Rule set cited");

    expect(note).toContain("exchange record");
    expect(note).not.toContain("has not checked");
    // The verdict is pointed at, never restated: its own vocabulary -- the
    // markers the consent surfaces put on each half -- stays off this surface.
    for (const verdict of ["consistent", "contradicted", "unchecked"] as const)
      expect(note).not.toContain(LINKAGE_RULE_SET_VERDICT_COPY[verdict].marker);
  });

  test("say the terms cited no rule set rather than leaving the cell blank, and caveat nothing", async () => {
    // The record omits the citation exactly when the terms drew their rules from
    // no named set, so the accounting reports that rather than a gap -- and a
    // citation that is not there has nothing for the caveat to qualify.
    const record = await disclosureRecord();
    expect(record.governance.linkageRuleSet).toBeUndefined();

    const fact = factNamed(disclosureFacts(record), "Rule set cited");

    expect(factValues([fact], "Rule set cited")).toEqual([
      "Not cited - the agreed terms' rules were authored rather than drawn from a named set",
    ]);
    expect(fact.note).toBeUndefined();
  });

  test("escape a cited set's name and version, which the authoring party chose", async () => {
    // The citation passes through unvetted, so its names and versions are free
    // text of somebody's choosing exactly as the partner identity is; this module
    // is their display sink too. A version renders undelimited on the strength of
    // a shape the boundary re-checks on the value in hand, so the escaped one below
    // takes the delimited run rather than standing in the line unattributed.
    const record = await disclosureRecord({
      linkageRuleSet: {
        fieldSet: { name: "baseline‮pii", version: "1.0.0" },
        keySet: { name: "hmis-keys", version: "2.1.0[31m" },
      },
    });
    expect(record.governance.linkageRuleSet?.fieldSet.name).toBe(
      "baseline‮pii",
    );

    expect(factValues(disclosureFacts(record), "Rule set cited")).toEqual([
      'Keys: "hmis-keys" "2.1.0\\x1b[31m"',
      'Fields: "baseline\\u202epii" 1.0.0',
    ]);
  });

  test("a crafted set name cannot be treated as a shorter name at another version", async () => {
    // A set name is free text the authoring party chose, so one holding the
    // delimiter and a version-shaped token beside it can spell the citation of
    // another set at another version, on the row a compliance reader consults.
    // The boundary's run is what answers that: the delimiter is doubled inside the
    // name, so what the name spells stays content of one value rather than
    // structure this line asserted.
    //
    // The imitated pair is what a reader would take the crafted names for -- the
    // two set names the standing fixture cites, at a version neither half is
    // recorded at -- so absence of both is what the assertion measures.
    const imitated = {
      keys: 'Keys: "hmis-keys" 9.9.9',
      fields: 'Fields: "baseline-pii" 9.9.9',
    };
    const record = await disclosureRecord({
      linkageRuleSet: {
        fieldSet: { name: 'baseline-pii" 9.9.9', version: "1.0.0" },
        keySet: { name: 'hmis-keys" 9.9.9', version: "1.0.0" },
      },
    });

    const values = factValues(disclosureFacts(record), "Rule set cited");

    expect(values).toEqual([
      'Keys: "hmis-keys"" 9.9.9" 1.0.0',
      'Fields: "baseline-pii"" 9.9.9" 1.0.0',
    ]);
    for (const citation of [imitated.keys, imitated.fields])
      expect(values.join("\n")).not.toContain(citation);
  });

  test("a cited half crosses the display boundary once, delimiters and all", async () => {
    // The boundary states delimiting, not escaping, so its result reaches a fact by
    // an assertion rather than by the escape's own return type, and what that
    // assertion claims is measured here: over names and versions built from the
    // classes the escape exists to remove, every byte of the rendered line is
    // printable ASCII, so nothing the escape rewrites survives into a run.
    //
    // The escape's own mark is what says it ran at all: each of these values
    // escapes to a form holding a backslash, so re-escaping the line changes
    // it. That much is a floor, not a count -- a twice-escaped line would read
    // the same way here -- and the exact forms below are what pin the count,
    // since a second pass would double every backslash in them.
    const record = await disclosureRecord({
      linkageRuleSet: {
        fieldSet: { name: "base‮line\u{1f600}", version: "1.0.0" },
        keySet: { name: 'hmis\u0000"keys', version: "2.1\u001b.0" },
      },
    });

    const values = factValues(disclosureFacts(record), "Rule set cited");

    expect(values).toEqual([
      'Keys: "hmis\\x00""keys" "2.1\\x1b.0"',
      'Fields: "base\\u202eline\\u{1f600}" 1.0.0',
    ]);
    for (const value of values) {
      expect(value).toMatch(/^[\x20-\x7e]+$/);
      expect(sanitizeForDisplay(value)).not.toBe(value);
    }
  });

  test("read a count-only run as the count-only disclosure it was", async () => {
    const record = await disclosureRecord({ algorithm: "psi-c" });

    expect(factValues(disclosureFacts(record), "What was disclosed")).toEqual([
      "How many records you both hold - a count only, no identifiers",
    ]);
  });

  test("escape partner-controlled text at this display boundary, leaving the record byte-exact", async () => {
    // A record stores the partner's identity byte-for-byte, as the cross-party
    // validation needs; this module is the sink that renders it, so the bidi
    // override and the escape byte reach the reader as visible escapes.
    const deceptive = "Riverbend‮Schools[31m";
    const record = await disclosureRecord({ partnerIdentity: deceptive });
    expect(record.partnerIdentity).toBe(deceptive);

    const [partner] = factValues(disclosureFacts(record), "Partner");

    expect(partner).toBe("Riverbend\\u202eSchools\\x1b[31m");
  });

  test("state how the exchange ended, so a terminated run does not display as a completed one", async () => {
    // The record is written once the exchange has disclosed, whether or not the
    // signed-receipt swap after it completed (docs/spec/EXCHANGE_RECORD.md, When
    // a record is owed). Both entries are real disclosures, and this row is what
    // keeps a reader of the accounting from taking them for the same thing.
    const completed = disclosureFacts(await disclosureRecord());
    expect(factValues(completed, "How the exchange ended")).toEqual([
      "Completed",
    ]);

    const terminated = disclosureFacts(
      await disclosureRecord({ outcome: "receipt-swap-terminated" }),
    );
    expect(factValues(terminated, "How the exchange ended")).toEqual([
      "Disclosed, then stopped before a signed receipt was exchanged",
    ]);
  });

  test("state the labels the export's columns are named for", async () => {
    // The exported header is stated once so an empty accounting still has one; this
    // pins it against the facts a real record produces, so the two cannot drift.
    const facts = disclosureFacts(await disclosureRecord());

    expect(facts.map((fact) => fact.label)).toEqual([
      ...DISCLOSURE_FACT_LABELS,
    ]);
  });
});

describe("the accounting's entries", () => {
  test("are one per completed run, newest first, keyed by the run's own instant", async () => {
    const accounting = accountingOf(
      await disclosureRecord({ createdAt: "2026-07-01T09:00:00.000Z" }),
      await disclosureRecord({ createdAt: "2026-08-01T09:00:00.000Z" }),
    );

    const entries = disclosureEntries(accounting);

    expect(entries.map((entry) => entry.at)).toEqual([
      "2026-08-01T09:00:00.000Z",
      "2026-07-01T09:00:00.000Z",
    ]);
    expect(entries[0].when).toContain("2026");
  });

  test("hold the partner at the display boundary for the collapsed summary", async () => {
    const accounting = accountingOf(
      await disclosureRecord({ partnerIdentity: "Riverbend‮Schools" }),
    );

    expect(disclosureEntries(accounting)[0].partner).toBe(
      "Riverbend\\u202eSchools",
    );
  });

  test("hold the record's own bindingNonce as the entry's identity, distinct even when two runs share a createdAt", async () => {
    // createdAt is millisecond-resolution and not guaranteed unique (rapid
    // re-runs, a browser that coarsens Date resolution); bindingNonce is the
    // record's own CSPRNG-generated per-run identity (see appendDisclosureRecord
    // in disclosureAccounting.ts), so it is what the view keys and toggles on.
    const sharedCreatedAt = "2026-07-01T09:00:00.000Z";
    const accounting = accountingOf(
      await disclosureRecord({ createdAt: sharedCreatedAt }),
      await disclosureRecord({ createdAt: sharedCreatedAt }),
    );

    const [first, second] = disclosureEntries(accounting);

    expect(first.at).toBe(sharedCreatedAt);
    expect(second.at).toBe(sharedCreatedAt);
    expect(first.bindingNonce).not.toBe(second.bindingNonce);
    expect(first.bindingNonce).toBe(accounting.entries[1].bindingNonce);
    expect(second.bindingNonce).toBe(accounting.entries[0].bindingNonce);
  });
});

describe("the exported accounting", () => {
  test("is a header row plus one row per run, oldest first", async () => {
    const accounting = accountingOf(
      await disclosureRecord({ createdAt: "2026-07-01T09:00:00.000Z" }),
      await disclosureRecord({ createdAt: "2026-08-01T09:00:00.000Z" }),
    );

    const rows = csvRows(disclosureAccountingCsv(accounting));

    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe(
      [DISCLOSED_AT_LABEL, ...DISCLOSURE_FACT_LABELS]
        .map((label) => `"${label}"`)
        .join(","),
    );
    // The screen reads newest first and the export oldest first, so the exported
    // rows are the entry order reversed.
    const [newest, oldest] = disclosureEntries(accounting);
    expect(rows[1]).toContain(oldest.when);
    expect(rows[2]).toContain(newest.when);
  });

  test("has every fact of a run in its row", async () => {
    const accounting = accountingOf(
      await disclosureRecord({
        recordsExposed: 7,
        resultSize: 3,
        retentionDisposition: "Program share drive, 3-year hold",
      }),
    );

    const [, row] = csvRows(disclosureAccountingCsv(accounting));

    expect(row).toContain('"Riverbend Schools"');
    expect(row).toContain('"MOU-2025-0042"');
    expect(row).toContain('"Evaluate shared program enrollment"');
    expect(row).toContain('"dose - Administered dose"');
    expect(row).toContain('"clinic"');
    expect(row).toContain('"7"');
    expect(row).toContain('"3"');
    expect(row).toContain('"Program share drive, 3-year hold"');
  });

  test("has the rule-set citation and its caveat in the same row as the run's other governance fields", async () => {
    const accounting = accountingOf(
      await disclosureRecord({ linkageRuleSet: true }),
    );

    const [header, row] = csvRows(disclosureAccountingCsv(accounting));

    // One cell of the one run's row, beside the agreement and the matching basis:
    // both cited halves and the caveat, which the export holds because it is
    // read without the screen that showed it.
    expect(
      splitCsvRow(row)[splitCsvRow(header).indexOf("Rule set cited")],
    ).toBe(
      `Keys: "hmis-keys" 2.1.0\nFields: "baseline-pii" 1.0.0\n${RULE_SET_CAVEAT}`,
    );
    expect(row).toContain('"MOU-2025-0042"');
    expect(splitCsvRow(row)).toHaveLength(splitCsvRow(header).length);
  });

  test("exports the uncited case as its named empty state, with no caveat to qualify it", async () => {
    const accounting = accountingOf(await disclosureRecord());

    const [header, row] = csvRows(disclosureAccountingCsv(accounting));

    expect(
      splitCsvRow(row)[splitCsvRow(header).indexOf("Rule set cited")],
    ).toBe(
      "Not cited - the agreed terms' rules were authored rather than drawn from a named set",
    );
  });

  test("leaves a formula-led set name unable to lead its cell, this app's own chrome holding that position", async () => {
    // The cited names are free text of the authoring party's choosing, so a
    // spreadsheet lead can reach this cell -- but each line opens with the half's
    // fixed name, so no partner byte occupies the position a spreadsheet reads a
    // formula from. Pinned as a check rather than argued.
    const accounting = accountingOf(
      await disclosureRecord({
        linkageRuleSet: {
          fieldSet: { name: "=1+1", version: "1.0.0" },
          keySet: { name: "@SUM(A1:A9)", version: "2.1.0" },
        },
      }),
    );

    const [header, row] = csvRows(disclosureAccountingCsv(accounting));
    const cell =
      splitCsvRow(row)[splitCsvRow(header).indexOf("Rule set cited")];

    expect(cell.startsWith("Keys: ")).toBe(true);
    expect(cell).toContain('Keys: "@SUM(A1:A9)" 2.1.0');
    expect(cell).toContain('Fields: "=1+1" 1.0.0');
    // The apostrophe guard is for a cell a partner value leads; it has nothing to
    // neutralize here, so it adds nothing.
    expect(row).not.toContain("\"'Keys:");
  });

  test("quotes a value holding the delimiter, so a comma cannot shift the columns", async () => {
    const accounting = accountingOf(
      await disclosureRecord({
        legalAgreement: {
          reference: "MOU-2025-0042",
          purpose: "Enrollment, attendance, and outcomes",
          expirationDate: "2027-01-01",
        },
      }),
    );

    const [header, row] = csvRows(disclosureAccountingCsv(accounting));

    expect(row).toContain('"Enrollment, attendance, and outcomes"');
    // The row still has exactly one cell per header column: the comma inside the
    // quoted purpose did not become a delimiter.
    expect(splitCsvRow(row)).toHaveLength(splitCsvRow(header).length);
  });

  test("doubles an embedded quote rather than closing the cell early", async () => {
    const accounting = accountingOf(
      await disclosureRecord({ partnerIdentity: 'Riverbend "Schools"' }),
    );

    const [, row] = csvRows(disclosureAccountingCsv(accounting));

    expect(row).toContain('"Riverbend ""Schools"""');
  });

  test("separates a multi-value cell with a newline no value can itself hold", async () => {
    // The display boundary escapes every non-printable-ASCII code point, so a
    // newline inside a quoted cell is unambiguously the separator. A partner
    // planting one in a column name gets the escape, not a second line.
    const record = await disclosureRecord({
      partnerIdentity: "Riverbend\nSchools",
    });
    const accounting = accountingOf(record);

    const [, row] = csvRows(disclosureAccountingCsv(accounting));

    expect(row).toContain('"Riverbend\\x0aSchools"');
    expect(splitCsvRow(row)).toHaveLength(DISCLOSURE_FACT_LABELS.length + 1);
  });

  test("neutralizes every formula lead, in each cell the partner chose the value of", async () => {
    // The partner identity, the agreement reference and purpose, and the payload
    // column names are all values the partner chose, and this file is opened in a
    // spreadsheet by a compliance reader. Each of the four leads the guard names is
    // driven, one per partner-chosen cell, so no lead is covered only by argument.
    const accounting = accountingOf(
      await disclosureRecord({
        partnerIdentity: '=HYPERLINK("http://elsewhere.example","click")',
        legalAgreement: {
          reference: "+MOU-2025-0042",
          purpose: "-1+1",
          expirationDate: "2027-01-01",
        },
        partnerPayloadColumn: "@SUM(A1:A9)",
      }),
    );

    const [, row] = csvRows(disclosureAccountingCsv(accounting));

    expect(row).toContain(
      '"\'=HYPERLINK(""http://elsewhere.example"",""click"")"',
    );
    expect(row).toContain('"\'+MOU-2025-0042"');
    expect(row).toContain('"\'-1+1"');
    expect(row).toContain('"\'@SUM(A1:A9)"');
  });

  test("leaves a tab- or return-led value unprefixed, the display boundary having escaped the lead", async () => {
    // Tab and carriage return are formula leads a spreadsheet honors, and the
    // guard does not list them: a value reaches a cell only through
    // the display boundary, which escapes every non-printable-ASCII code point, so
    // what leads the cell is a backslash rather than the control character. Pinned
    // here so the narrowing is checked rather than argued.
    const accounting = accountingOf(
      await disclosureRecord({
        partnerIdentity: "\tRiverbend Schools",
        legalAgreement: {
          reference: "\rMOU-2025-0042",
          purpose: "Evaluate shared program enrollment",
          expirationDate: "2027-01-01",
        },
      }),
    );

    const [, row] = csvRows(disclosureAccountingCsv(accounting));

    expect(row).toContain('"\\x09Riverbend Schools"');
    expect(row).toContain('"\\x0dMOU-2025-0042"');
    expect(row).not.toContain("\t");
    expect(row).not.toContain("\r");
  });

  test("exports its header even with no entries, so an empty accounting is still an answer", () => {
    const rows = csvRows(disclosureAccountingCsv(accountingOf()));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(`"${DISCLOSED_AT_LABEL}"`);
  });

  test("names the download by the export instant", () => {
    expect(
      disclosureAccountingFileName(new Date("2026-08-20T12:30:00.000Z")),
    ).toBe("psilink-disclosures-2026-08-20T12-30-00-000Z.csv");
  });
});

/**
 * The stored-form export: the file an operator recovers an accounting into when
 * this build's exchange-record format can no longer read the entries. Its whole
 * contract is that it asserts nothing about them -- it hands back what is at rest,
 * so the entries must survive it byte-for-byte in content.
 */
describe("the stored accounting as a recovery file", () => {
  /** Entries as they would sit at rest after a record-version move: the format's
   * own fields, under a version this build does not admit. */
  const storedEntries: ReadonlyArray<unknown> = [
    {
      version: "psilink-exchange-record/v-moved",
      createdAt: "2026-07-01T09:00:00.000Z",
      partnerIdentity: "Riverbend Schools",
      recordsExposed: 11,
      fieldTheFormatNoLongerCarries: ["kept anyway"],
    },
    {
      version: "psilink-exchange-record/v-moved",
      createdAt: "2026-08-01T09:00:00.000Z",
      partnerIdentity: "Falls County Clinic",
      recordsExposed: 23,
    },
  ];

  test("retains every entry verbatim, including fields this build has no meaning for", () => {
    const document = storedDisclosureAccountingDocument({
      version: DISCLOSURE_ACCOUNTING_VERSION,
      entries: storedEntries,
    });

    // Deep equality after a round trip, not a spot check on a field: the export's
    // one job is to lose nothing, and a field the current format does not hold is
    // exactly the field a bump would have made unreadable.
    expect(JSON.parse(document)).toEqual({
      version: DISCLOSURE_ACCOUNTING_VERSION,
      entries: storedEntries,
    });
  });

  test("has no reading of the entries, only the stored shape", () => {
    const document = storedDisclosureAccountingDocument({
      version: DISCLOSURE_ACCOUNTING_VERSION,
      entries: storedEntries,
    });

    // The CSV's column labels are this app's reading of a record under the CURRENT
    // format's meaning. An entry from another version licenses none of it, so the
    // recovery file must hold the record's own field names and no label of ours.
    for (const label of DISCLOSURE_FACT_LABELS)
      expect(document).not.toContain(label);
    expect(document).toContain("partnerIdentity");
  });

  test("an accounting with no entries still recovers as a document", () => {
    expect(
      JSON.parse(
        storedDisclosureAccountingDocument({
          version: DISCLOSURE_ACCOUNTING_VERSION,
          entries: [],
        }),
      ),
    ).toEqual({ version: DISCLOSURE_ACCOUNTING_VERSION, entries: [] });
  });

  test("names the download by the export instant, apart from the CSV's name", () => {
    const exportedAt = new Date("2026-08-20T12:30:00.000Z");

    expect(storedDisclosureAccountingFileName(exportedAt)).toBe(
      "psilink-disclosures-stored-2026-08-20T12-30-00-000Z.json",
    );
    // Two forms of one accounting must not land in a downloads folder under one
    // name: only one of them is a reading a compliance reader can rely on.
    expect(storedDisclosureAccountingFileName(exportedAt)).not.toBe(
      disclosureAccountingFileName(exportedAt),
    );
  });
});

/** Split one CSV row into its cells, honoring the quoting the writer emits: a
 * comma or a newline inside a quoted cell is data, and a doubled quote is one
 * quote. Written here rather than reusing the writer's own escaping, so a row the
 * writer mis-quoted is not parsed back by the same mistake. */
function splitCsvRow(row: string): Array<string> {
  const cells: Array<string> = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index];
    if (quoted) {
      if (char !== '"') cell += char;
      else if (row[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else cell += char;
  }
  cells.push(cell);
  return cells;
}
