/**
 * The pure derivation behind a managed exchange's accounting of disclosures: one
 * entry per completed run, each read off that run's self-attested exchange record,
 * plus the CSV a compliance reader is handed. No React, no IndexedDB -- the
 * derivations and the exported bytes are unit-testable in Node.
 *
 * Every fact here comes from the run's exchange record and nothing else (see
 * docs/spec/EXCHANGE_RECORD.md): the accounting presents that record, it does not
 * summarize or re-derive it. One consequence is worth stating, because it is what
 * an auditor reads: a fact the record does not carry is shown as not recorded,
 * never inferred. The result size is the standing example -- the record omits it
 * unless both parties' agreed terms had them both receive output, so an entry that
 * does not carry one says so rather than substituting a number from elsewhere.
 *
 * A record stores partner-authored free text byte-exactly (the partner identity,
 * the agreement reference and purpose, the payload column names and their
 * dictionary descriptions), which is what the byte-exact cross-party validation
 * needs and what makes this module the display sink the record format's rendering
 * note requires: every such value crosses {@link sanitizeForDisplay} here, once, on
 * its way to a screen or an exported file, and the stored record is never mutated.
 * The {@link Displayable} type is what enforces it -- a raw `string` does not
 * typecheck into a fact.
 */

import { displayText, sanitizeForDisplay } from "@psilink/core";

import { dateTimeLabel } from "./inviterModel";
import { recordFileStamp } from "./runOutputs";

import type { Algorithm, Displayable, ExchangeRecord } from "@psilink/core";
import type { DisclosureAccounting } from "@psi/disclosureAccounting";

/**
 * One fact of one disclosure: its first-party label, the display values it carries
 * (several, for a category list), and the named empty state shown when it carries
 * none. `muted` is always populated, so a fact never renders -- or exports -- as a
 * blank cell whose meaning the reader has to guess.
 */
export interface DisclosureFact {
  label: string;
  values: ReadonlyArray<Displayable>;
  muted: string;
}

/** One completed run's disclosure, as the accounting presents it. */
export interface DisclosureEntryView {
  /** The run's own instant, from the record's `createdAt`: the stable key for the
   * entry, and the value the export's first column carries. */
  at: string;
  /** The run instant phrased for display. This app's own formatting of the
   * record's timestamp, so it is first-party text rather than a partner value. */
  when: string;
  /** The partner this run disclosed to, at the display boundary. */
  partner: Displayable;
  /** The run's facts, in the fixed order the export's columns follow. */
  facts: ReadonlyArray<DisclosureFact>;
}

/** The MIME type of the exported accounting. */
export const DISCLOSURE_EXPORT_MIME = "text/csv";

/** The export's first column: the run instant, which is the entry's identity
 * rather than one of its facts. */
export const DISCLOSED_AT_LABEL = "Disclosed at";

/**
 * The labels of a disclosure's facts, in the order {@link disclosureFacts} builds
 * them and the exported CSV columns follow. Stated once so the export's header row
 * exists for an accounting with no entries to read it off; a unit test pins it
 * against the facts a real record produces, so the two cannot drift.
 */
export const DISCLOSURE_FACT_LABELS: ReadonlyArray<string> = [
  "Partner",
  "Agreement",
  "Purpose of the disclosure",
  "What was disclosed",
  "Columns you sent",
  "Columns you received",
  "Matched on",
  "Records you exposed",
  "Result size",
  "Where the result was filed",
];

/** The named empty state for a field the record does not carry. */
const NOT_RECORDED = "Not recorded";

/** The named empty state for a direction that disclosed no payload columns -- none
 * were designated, or no records matched. The record states that case explicitly
 * rather than by omission, and so does this. */
const NO_COLUMNS = "No columns";

/** The named empty state for a result size the record does not carry: it is
 * recorded only when both parties' agreed terms had them both receive output (see
 * docs/spec/EXCHANGE_RECORD.md), so its absence is a statement about entitlement,
 * not a missing number. */
const RESULT_SIZE_ABSENT = "Not recorded - only one party received the result";

/** What each `algorithm` disclosed, in plain language: the record's own reading of
 * the field (`psi` revealed matched identifiers, `psi-c` only a count). */
const ALGORITHM_DISCLOSURE: Record<Algorithm, Displayable> = {
  psi: displayText`Which records you both hold`,
  "psi-c": displayText`How many records you both hold - a count only, no identifiers`,
};

/** A fact carrying exactly one value the record always has. */
function fact(label: string, value: Displayable): DisclosureFact {
  return { label, values: [value], muted: NOT_RECORDED };
}

/** A fact carrying a list of values, with its own named empty state. */
function listFact(
  label: string,
  values: ReadonlyArray<Displayable>,
  muted: string,
): DisclosureFact {
  return { label, values, muted };
}

/** A fact carrying a value the record may omit, with its own named empty state. */
function optionalFact(
  label: string,
  value: Displayable | undefined,
  muted: string,
): DisclosureFact {
  return { label, values: value === undefined ? [] : [value], muted };
}

/** One disclosed category at the display boundary: the column name the disclosure
 * gate actually transmitted, with the data-dictionary description where the
 * dictionary supplies one. The two cross the boundary separately and then compose,
 * so a padded name cannot spend the description's display budget as well. */
function categoryLabel(column: {
  name: string;
  description?: string;
}): Displayable {
  const name = sanitizeForDisplay(column.name);
  if (column.description === undefined) return name;
  return displayText`${name} - ${sanitizeForDisplay(column.description)}`;
}

/**
 * The facts of one disclosure, in the fixed order {@link DISCLOSURE_FACT_LABELS}
 * names: to whom, under what authority and for what purpose, what kind of
 * disclosure it was, the categories each way, the basis the match keyed on, the
 * records this party exposed, the result size where it was recorded, and where the
 * result was filed. Each is a field of the run's exchange record.
 */
export function disclosureFacts(
  record: ExchangeRecord,
): ReadonlyArray<DisclosureFact> {
  const { governance } = record;
  return [
    fact("Partner", sanitizeForDisplay(record.partnerIdentity)),
    optionalFact(
      "Agreement",
      governance.legalAgreement === undefined
        ? undefined
        : sanitizeForDisplay(governance.legalAgreement.reference),
      NOT_RECORDED,
    ),
    optionalFact(
      "Purpose of the disclosure",
      governance.legalAgreement === undefined
        ? undefined
        : sanitizeForDisplay(governance.legalAgreement.purpose),
      NOT_RECORDED,
    ),
    fact("What was disclosed", ALGORITHM_DISCLOSURE[governance.algorithm]),
    listFact(
      "Columns you sent",
      governance.payloadSent.map((column) => categoryLabel(column)),
      NO_COLUMNS,
    ),
    listFact(
      "Columns you received",
      governance.payloadReceived.map((column) => categoryLabel(column)),
      NO_COLUMNS,
    ),
    listFact(
      "Matched on",
      governance.matchingBasis.map(
        (field) =>
          displayText`${sanitizeForDisplay(field.name)} (${sanitizeForDisplay(field.type)})`,
      ),
      "No fields",
    ),
    fact("Records you exposed", displayText`${record.recordsExposed}`),
    optionalFact(
      "Result size",
      record.resultSize === undefined
        ? undefined
        : displayText`${record.resultSize}`,
      RESULT_SIZE_ABSENT,
    ),
    optionalFact(
      "Where the result was filed",
      record.retentionDisposition === undefined
        ? undefined
        : sanitizeForDisplay(record.retentionDisposition),
      NOT_RECORDED,
    ),
  ];
}

/**
 * The accounting's entries for display, newest first -- the order an operator
 * opens the surface for ("what did this exchange disclose most recently"). The
 * stored accounting keeps run order, and so does the export
 * ({@link disclosureAccountingCsv}), which a compliance reader reads
 * chronologically.
 */
export function disclosureEntries(
  accounting: DisclosureAccounting,
): Array<DisclosureEntryView> {
  return accounting.entries
    .map((record) => ({
      at: record.createdAt,
      when: dateTimeLabel(new Date(record.createdAt)),
      partner: sanitizeForDisplay(record.partnerIdentity),
      facts: disclosureFacts(record),
    }))
    .reverse();
}

/** The characters a spreadsheet reads as the start of a formula rather than as
 * text. A cell beginning with one is prefixed with an apostrophe below, so an
 * exported accounting cannot execute in the reader's spreadsheet on values the
 * partner chose (the agreement purpose and the column names are theirs). The tab
 * and carriage-return leads of this class are unreachable here -- the display
 * boundary has already escaped every non-printable-ASCII code point -- so only the
 * printable leads remain. */
const FORMULA_LEAD = /^[=+\-@]/;

/**
 * One CSV cell, per RFC 4180: always quoted, with an embedded quote doubled.
 * Quoting unconditionally is also what lets a multi-value cell separate its values
 * with a newline: a display value can never contain one itself, because the
 * display boundary escapes every non-printable-ASCII code point, so a newline
 * inside a quoted cell is unambiguously the separator rather than a value's own
 * byte. A separator character that a value CAN carry -- a semicolon, a pipe --
 * would not have that property.
 */
function csvCell(value: string): string {
  const guarded = FORMULA_LEAD.test(value) ? `'${value}` : value;
  return `"${guarded.replaceAll('"', '""')}"`;
}

/** One fact as a cell: its values one per line, or its named empty state. */
function factCell(entry: DisclosureFact): string {
  return csvCell(
    entry.values.length === 0 ? entry.muted : entry.values.join("\n"),
  );
}

/**
 * The accounting as CSV -- the form a compliance reader is handed: a header row,
 * then one row per completed run in run order (oldest first, as a disclosure log
 * reads), each row the run instant followed by that run's facts. The values are
 * the display forms, so what the file carries is what the screen showed.
 *
 * An accounting with no entries still exports its header row: "this exchange
 * disclosed nothing" is a meaningful answer, and a zero-byte file is not.
 */
export function disclosureAccountingCsv(
  accounting: DisclosureAccounting,
): string {
  const header = [DISCLOSED_AT_LABEL, ...DISCLOSURE_FACT_LABELS]
    .map((label) => csvCell(label))
    .join(",");
  const rows = accounting.entries.map((record) =>
    [
      csvCell(dateTimeLabel(new Date(record.createdAt))),
      ...disclosureFacts(record).map(factCell),
    ].join(","),
  );
  return [header, ...rows].map((row) => `${row}\r\n`).join("");
}

/**
 * The download name for an exported accounting, stamped with the export instant in
 * the filesystem-safe form the record downloads use ({@link recordFileStamp}), so
 * repeated exports accumulate rather than collide.
 */
export function disclosureAccountingFileName(exportedAt: Date): string {
  return `psilink-disclosures-${recordFileStamp(exportedAt.toISOString())}.csv`;
}
