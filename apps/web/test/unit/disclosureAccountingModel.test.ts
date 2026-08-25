import { describe, expect, test } from "vitest";

import {
  DISCLOSED_AT_LABEL,
  DISCLOSURE_FACT_LABELS,
  disclosureAccountingCsv,
  disclosureAccountingFileName,
  disclosureEntries,
  disclosureFacts,
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

/** The values of one labelled fact, or its named empty state when it carries
 * none. */
function factValues(
  facts: ReadonlyArray<DisclosureFact>,
  label: string,
): Array<string> {
  const found = factNamed(facts, label);
  return found.values.length === 0 ? [found.muted] : [...found.values];
}

/** The caveat the accounting attaches to a present rule-set citation: the record
 * carries the authoring party's own declaration, which nothing on the exchange
 * path resolved to a set or checked against the keys and fields the same terms
 * declared. */
const RULE_SET_CAVEAT =
  "psilink has not checked this citation: nothing resolves these names to a rule set, or checks them against the fields matched on. What the exchange held both parties to is the matching basis recorded beside it.";

/** The exported CSV split into physical rows, the trailing terminator dropped. */
function csvRows(csv: string): Array<string> {
  return csv.split("\r\n").slice(0, -1);
}

describe("a disclosure's facts", () => {
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

  test("state the rule set the terms cited, keys before fields, under the caveat that nothing checked it", async () => {
    const record = await disclosureRecord({ linkageRuleSet: true });

    const facts = disclosureFacts(record);

    expect(factValues(facts, "Rule set cited")).toEqual([
      'Keys: "hmis-keys" 2.1.0',
      'Fields: "baseline-pii" 1.0.0',
    ]);
    expect(factNamed(facts, "Rule set cited").note).toBe(RULE_SET_CAVEAT);
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
    // The citation is carried through unvetted, so its names and versions are free
    // text of somebody's choosing exactly as the partner identity is; this module
    // is their display sink too.
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
      'Keys: "hmis-keys" 2.1.0\\x1b[31m',
      'Fields: "baseline\\u202epii" 1.0.0',
    ]);
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

  test("carry the labels the export's columns are named for", async () => {
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

  test("carry the partner at the display boundary for the collapsed summary", async () => {
    const accounting = accountingOf(
      await disclosureRecord({ partnerIdentity: "Riverbend‮Schools" }),
    );

    expect(disclosureEntries(accounting)[0].partner).toBe(
      "Riverbend\\u202eSchools",
    );
  });

  test("carry the record's own bindingNonce as the entry's identity, distinct even when two runs share a createdAt", async () => {
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

  test("carries every fact of a run in its row", async () => {
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

  test("carries the rule-set citation and its caveat in the same row as the run's other governance fields", async () => {
    const accounting = accountingOf(
      await disclosureRecord({ linkageRuleSet: true }),
    );

    const [header, row] = csvRows(disclosureAccountingCsv(accounting));

    // One cell of the one run's row, beside the agreement and the matching basis:
    // both cited halves and the caveat, which the export carries because it is
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

  test("quotes a value carrying the delimiter, so a comma cannot shift the columns", async () => {
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

  test("separates a multi-value cell with a newline no value can itself carry", async () => {
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
    // guard deliberately does not list them: a value reaches a cell only through
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
