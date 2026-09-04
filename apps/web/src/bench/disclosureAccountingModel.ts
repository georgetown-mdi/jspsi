/**
 * The pure derivation behind a managed exchange's accounting of disclosures: one
 * entry per run it filed, each read off that run's self-attested exchange record,
 * plus the CSV a compliance reader is handed. No React, no IndexedDB -- the
 * derivations and the exported bytes are unit-testable in Node.
 *
 * Every fact here comes from the run's exchange record and nothing else (see
 * docs/spec/EXCHANGE_RECORD.md): the accounting presents that record, it does not
 * summarize or re-derive it. A fact the record does not have is shown as not
 * recorded, never inferred. The result size is the standing example -- the record
 * omits it unless both parties' agreed terms had them both receive output, so an
 * entry with none says so rather than substituting a number from elsewhere.
 *
 * A record stores partner-authored free text byte-exactly (the partner identity,
 * the agreement reference and purpose, the payload column names and their
 * dictionary descriptions, and the cited rule set's names and content versions),
 * which is what the byte-exact cross-party validation needs and what makes this
 * module the display sink the record format's rendering note requires: every such
 * value crosses {@link sanitizeForDisplay} here, once, on its way to a screen or
 * an exported file, and the stored record is never mutated.
 * The {@link Displayable} type is what enforces it -- a raw `string` does not
 * typecheck into a fact.
 */

import {
  RECORDED_LINKAGE_RULE_SET_CAVEAT,
  displayPartyIdentity,
  displayText,
  ruleSetCitation,
  sanitizeForDisplay,
} from "@psilink/core";

import { dateTimeLabel } from "./inviterModel";
import { recordFileStamp } from "./runOutputs";

import type {
  Algorithm,
  Displayable,
  ExchangeRecord,
  ExchangeRecordOutcome,
  RecordLinkageRuleSet,
} from "@psilink/core";
import type {
  DisclosureAccounting,
  StoredDisclosureAccounting,
} from "@psi/disclosureAccounting";

/**
 * One fact of one disclosure: its label, the display values it holds (several,
 * for a category list), and the named empty state shown when it has none. `muted`
 * is always populated, so a fact never renders -- or exports -- as a blank cell.
 *
 * `note` is fixed first-party copy qualifying what the values assert. It travels
 * with the fact rather than living in the renderer so the screen and the export
 * state one qualification, and it is attached only where values stand: a fact
 * showing its named empty state has no assertion to qualify.
 */
export interface DisclosureFact {
  label: string;
  values: ReadonlyArray<Displayable>;
  muted: string;
  note?: string;
}

/** One run's disclosure, as the accounting presents it. */
export interface DisclosureEntryView {
  /** The run's own instant, verbatim from the record's `createdAt`: the ISO-8601
   * value, not the minute-resolution {@link when} the screen shows and the export's
   * first column carries. Not the entry's identity either -- {@link bindingNonce}
   * is, since two runs can share a millisecond instant. */
  at: string;
  /** The record's own per-run identity (see `appendDisclosureRecord` in
   * disclosureAccounting.ts): CSPRNG-generated and unique within this holder's
   * log, unlike `at`. The stable key for the entry and its open/close toggle
   * identity. */
  bindingNonce: string;
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

/** The export's first column: the run instant, which names the row rather than
 * being one of its facts. */
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
  "How the exchange ended",
  "Columns you sent",
  "Columns you received",
  "Matched on",
  "Rule set cited",
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

/** The label of the rule-set citation, named because both branches of the fact
 * below carry it. It is held to {@link DISCLOSURE_FACT_LABELS} by the same unit
 * test that pins every other fact's label against the export's columns. */
const RULE_SET_LABEL = "Rule set cited";

/** The named empty state for a record whose agreed terms cited no named set. The
 * record omits the field exactly then (see docs/spec/EXCHANGE_RECORD.md, "The
 * rule-set citation"), so the absence is a statement about how the terms were
 * authored, not a field the writer left out. */
const RULE_SET_ABSENT =
  "Not cited - the agreed terms' rules were authored rather than drawn from a named set";

/** How each recorded `outcome` reads to an operator. A record is written once the
 * exchange has disclosed, so both values describe a disclosure that happened; what
 * separates them is whether the run finished. The terminated wording leads with the
 * disclosure for that reason -- an entry a reader might otherwise take for a run
 * that did nothing. */
const OUTCOME_DISCLOSURE: Record<ExchangeRecordOutcome, Displayable> = {
  completed: displayText`Completed`,
  "receipt-swap-terminated": displayText`Disclosed, then stopped before a signed receipt was exchanged`,
};

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
 * One cited half of a rule set -- the set name beside that half's content
 * version -- composed through core's terms-value seam ({@link ruleSetCitation}).
 *
 * The seam brands delimiting and control-character treatment, not escaping, so
 * its result is not a {@link Displayable} on its own; the cast below holds only
 * because this function escapes both values itself and takes the raw pair to do
 * it, so no value reaches a fact unescaped.
 */
function citedSetIdentity(setIdentity: {
  name: string;
  version: string;
}): Displayable {
  return ruleSetCitation(
    sanitizeForDisplay(setIdentity.name),
    sanitizeForDisplay(setIdentity.version),
  ) as string as Displayable;
}

/**
 * The rule-set citation as its two cited halves, keys before fields -- the order
 * core's own mismatch message and the acceptance surfaces use -- each rendered
 * through core's terms-value seam ({@link ruleSetCitation}).
 *
 * The record stores both values raw, so unlike the consent surfaces (escaped
 * from `summarizeInvitation`), this is where they cross the display boundary:
 * each value is escaped ahead of the delimiters, so a value's own truncation
 * cannot take the closing delimiter off the composed run.
 *
 * The caveat below is core's ({@link RECORDED_LINKAGE_RULE_SET_CAVEAT}), matching
 * the per-verdict copy the consent surfaces render, so what the accounting says a
 * citation is worth cannot drift from what they say -- it points at the writing
 * party's verdict rather than restating it (see docs/spec/EXCHANGE_RECORD.md,
 * "The writing party's verdict").
 */
function ruleSetFact(
  ruleSet: RecordLinkageRuleSet | undefined,
): DisclosureFact {
  if (ruleSet === undefined)
    return { label: RULE_SET_LABEL, values: [], muted: RULE_SET_ABSENT };
  return {
    label: RULE_SET_LABEL,
    values: [
      displayText`Keys: ${citedSetIdentity(ruleSet.keySet)}`,
      displayText`Fields: ${citedSetIdentity(ruleSet.fieldSet)}`,
    ],
    muted: RULE_SET_ABSENT,
    note: RECORDED_LINKAGE_RULE_SET_CAVEAT,
  };
}

/**
 * The facts of one disclosure, in the fixed order {@link DISCLOSURE_FACT_LABELS}
 * names: to whom, under what authority and for what purpose, what kind of
 * disclosure it was, how the run that made it ended, the categories each way, the
 * basis the match keyed on and the rule set the terms cited it to, the records
 * this party exposed, the result size where it was recorded, and where the result
 * was filed. Each is a field of the run's exchange record.
 */
export function disclosureFacts(
  record: ExchangeRecord,
): ReadonlyArray<DisclosureFact> {
  const { governance } = record;
  return [
    fact("Partner", displayPartyIdentity(record.partnerIdentity)),
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
    fact("How the exchange ended", OUTCOME_DISCLOSURE[record.outcome]),
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
    ruleSetFact(governance.linkageRuleSet),
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
      bindingNonce: record.bindingNonce,
      when: dateTimeLabel(new Date(record.createdAt)),
      partner: displayPartyIdentity(record.partnerIdentity),
      facts: disclosureFacts(record),
    }))
    .reverse();
}

/** The characters a spreadsheet reads as the start of a formula rather than as
 * text. A cell beginning with one is prefixed with an apostrophe below, so an
 * exported accounting cannot execute in the reader's spreadsheet on values the
 * partner chose. The display boundary escapes every non-printable-ASCII code
 * point first, so only these printable leads ever reach this check. */
const FORMULA_LEAD = /^[=+\-@]/;

/**
 * One CSV cell, per RFC 4180: always quoted, with an embedded quote doubled.
 * Quoting unconditionally also lets a multi-value cell separate its values with a
 * newline: a display value can never contain one itself, since the display
 * boundary escapes every non-printable-ASCII code point, so a newline inside a
 * quoted cell is unambiguously the separator, never a value's own byte.
 */
function csvCell(value: string): string {
  const guarded = FORMULA_LEAD.test(value) ? `'${value}` : value;
  return `"${guarded.replaceAll('"', '""')}"`;
}

/** One fact as a cell: its values one per line and its caveat on a line below
 * them, or its named empty state. The caveat travels into the export because the
 * export is where a compliance reader meets the fact without the screen around it
 * -- a qualification the screen shows and the file drops would leave the file
 * asserting more than the screen did. */
function factCell(entry: DisclosureFact): string {
  if (entry.values.length === 0) return csvCell(entry.muted);
  const lines: Array<string> =
    entry.note === undefined
      ? [...entry.values]
      : [...entry.values, entry.note];
  return csvCell(lines.join("\n"));
}

/**
 * The accounting as CSV -- the form a compliance reader is handed: a header row,
 * then one row per filed run in run order (oldest first, as a disclosure log
 * reads), each row the run instant followed by that run's facts. The values are
 * the display forms, so what the file carries is what the screen showed.
 *
 * An accounting with no entries still exports its header row: "this copy of the
 * accounting holds nothing" is a meaningful answer, and a zero-byte file is not.
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

/** The MIME type of a stored-form export: the stored accounting as JSON. */
export const DISCLOSURE_STORED_EXPORT_MIME = "application/json";

/**
 * The stored accounting as the file an operator recovers it into: the envelope
 * and its entries, serialized as they sit at rest.
 *
 * The ONE export for an accounting this build's exchange-record format can no
 * longer read: an earlier record's silence does not mean what the current
 * format's silence means (see docs/spec/EXCHANGE_RECORD.md), so handing over the
 * stored form asserts nothing about the entries, unlike rendering them.
 *
 * Pretty-printed with a trailing newline, since the file is an archival artifact
 * a person may open.
 */
export function storedDisclosureAccountingDocument(
  stored: StoredDisclosureAccounting,
): string {
  return `${JSON.stringify({ version: stored.version, entries: stored.entries }, undefined, 2)}\n`;
}

/**
 * The download name for a stored-form export, stamped like the CSV's so repeated
 * exports accumulate rather than collide, and distinct from it so the two forms
 * of the same accounting do not sit in a downloads folder telling the same story
 * under one name.
 */
export function storedDisclosureAccountingFileName(exportedAt: Date): string {
  return `psilink-disclosures-stored-${recordFileStamp(exportedAt.toISOString())}.json`;
}
