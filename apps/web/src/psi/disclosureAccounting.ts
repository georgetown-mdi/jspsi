/**
 * A managed exchange's accounting of disclosures: the self-attested exchange
 * records its runs produce, accumulated in run order. This is the pure,
 * IndexedDB-free half of {@link ./disclosureAccountingStore.ts}, so the shape and
 * the append rule are unit-testable in Node with no database.
 *
 * An entry IS a run's exchange record, verbatim -- not a summary derived from one
 * and not a second format beside it. Every fact the accounting states (the
 * partner, the governing agreement and the purpose of the disclosure under it,
 * what kind of disclosure the algorithm made, the categories of data disclosed
 * each way, the matching basis the linkage keyed on and the rule set the terms
 * cited it to, the records this party exposed, the result size where both parties
 * were entitled to it, where this party filed its copy of the result, and the
 * instant) is a field of that record, which is exactly what makes the record the
 * accounting's single source (see docs/spec/EXCHANGE_RECORD.md). A reader that
 * wants more than the accounting renders opens the entry itself.
 *
 * The managed record deliberately cannot hold this: its `lastRun` is a timestamp
 * and closed enums by design, and it keeps only the most recent run (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, the `lastRun` row). So the accounting is a
 * SIBLING store keyed by the same record id, exactly as the local sibling state is
 * -- which is also what keeps it out of the export artifact, since the exporter
 * reads only the records store.
 *
 * What it holds at rest is the record's own cleartext content: names, categories,
 * references, and aggregate counts, never a payload value, a linkage-field value,
 * or a matched identifier. The `resultSize` an entry carries is the intersection
 * CARDINALITY under the record format's entitlement gate, not the intersection --
 * the no-match-result rule the managed record states is untouched.
 */

import { z } from "zod";

import { parseExchangeRecord } from "@psilink/core";

import type { ExchangeRecord } from "@psilink/core";
import type { ZodType } from "zod";

/** The single recognized format version for a stored accounting. A reader rejects
 * any other value rather than migrating it, the reader-rejects-unknown rule the
 * record and verification-keys files follow (see docs/spec/EXCHANGE_RECORD.md). */
export const DISCLOSURE_ACCOUNTING_VERSION = "psilink-disclosure-accounting/v1";

/** One managed exchange's accounting of disclosures: its runs' exchange records,
 * oldest first. */
export interface DisclosureAccounting {
  version: typeof DISCLOSURE_ACCOUNTING_VERSION;
  /** The runs' self-attested exchange records, verbatim and in run order. */
  entries: ReadonlyArray<ExchangeRecord>;
}

/**
 * A stored accounting as its ENVELOPE alone admits it: the format version, and
 * the entries exactly as they sit at rest, held to nothing. The entries are
 * `unknown` because that is the whole point -- this shape exists for a stored
 * accounting whose entries the current exchange-record format no longer admits,
 * where the typed {@link DisclosureAccounting} is unobtainable.
 */
export interface StoredDisclosureAccounting {
  version: typeof DISCLOSURE_ACCOUNTING_VERSION;
  /** The stored entries, unvalidated and in stored order. */
  entries: ReadonlyArray<unknown>;
}

/** The envelope validator. The entries are validated one by one through core's own
 * {@link parseExchangeRecord} rather than a schema restated here, so a stored entry
 * is held to the exchange-record format itself and this module cannot drift from
 * it. */
const accountingEnvelopeSchema: ZodType<{
  version: typeof DISCLOSURE_ACCOUNTING_VERSION;
  entries: Array<unknown>;
}> = z
  .object({
    version: z.literal(DISCLOSURE_ACCOUNTING_VERSION),
    entries: z.array(z.unknown()),
  })
  .strict();

/**
 * Parse the ENVELOPE of a value read from the accounting store, returning the
 * stored entries verbatim and unvalidated. Rejects an unrecognized accounting
 * `version` or an unknown key, but looks inside no entry.
 *
 * This is the recovery read, and the ONLY admitted use of what it returns is
 * handing the stored bytes back to the operator. A record-format version bump
 * invalidates the entries while leaving the envelope intact, which strands an
 * accounting the full read below can no longer load; this is the read that gets
 * it out. What it returns must never be rendered AS an accounting: the entries
 * are exactly what the full read refused to vouch for, and reading an older
 * entry's absent fields through the current format's meaning of their absence is
 * the quietly false account {@link parseDisclosureAccounting} exists to prevent
 * (see docs/spec/EXCHANGE_RECORD.md on the version literal moving with the field
 * set).
 *
 * @throws {ZodError} if the envelope is not a valid accounting envelope.
 */
export function parseStoredDisclosureAccounting(
  raw: unknown,
): StoredDisclosureAccounting {
  const envelope = accountingEnvelopeSchema.parse(raw);
  return {
    version: DISCLOSURE_ACCOUNTING_VERSION,
    entries: envelope.entries,
  };
}

/**
 * Parse and validate a value read from the accounting store. Rejects an
 * unrecognized `version`, an unknown key, or an entry that is not a valid exchange
 * record, rather than loading it -- so a corrupted or app-upgrade-invalidated
 * accounting surfaces as a read failure. Surfacing it matters more here than
 * elsewhere: an accounting that silently dropped its unreadable entries would
 * still render, as a shorter and quietly false account of what was disclosed.
 *
 * Composed on {@link parseStoredDisclosureAccounting} so the split the recovery
 * path rests on is structural rather than asserted: this read IS the envelope
 * read plus the per-entry validation, so the two can only ever fail together or
 * fail at the entries.
 *
 * @throws {ZodError} if the value is not a valid accounting.
 */
export function parseDisclosureAccounting(raw: unknown): DisclosureAccounting {
  const stored = parseStoredDisclosureAccounting(raw);
  return {
    version: DISCLOSURE_ACCOUNTING_VERSION,
    entries: stored.entries.map((entry) => parseExchangeRecord(entry)),
  };
}

/**
 * Append one run's exchange record to the accounting, returning the result; a
 * missing accounting starts one. The record is stored verbatim.
 *
 * Appending the same run twice is a no-op, matched on the record's own
 * `bindingNonce`: it is CSPRNG-generated per exchange and generated locally, so it
 * distinguishes runs within this holder's own log (see
 * docs/spec/EXCHANGE_RECORD.md, "Record fields") -- which is precisely the
 * question a re-appended entry poses. That makes the append idempotent, so a
 * retried write cannot inflate the count of disclosures the accounting reports.
 */
export function appendDisclosureRecord(
  current: DisclosureAccounting | undefined,
  record: ExchangeRecord,
): DisclosureAccounting {
  if (current === undefined)
    return { version: DISCLOSURE_ACCOUNTING_VERSION, entries: [record] };
  if (
    current.entries.some((entry) => entry.bindingNonce === record.bindingNonce)
  )
    return current;
  return {
    version: DISCLOSURE_ACCOUNTING_VERSION,
    entries: [...current.entries, record],
  };
}
