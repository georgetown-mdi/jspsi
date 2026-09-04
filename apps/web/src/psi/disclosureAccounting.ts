/**
 * A managed exchange's accounting of disclosures: the self-attested exchange
 * records its runs produce, accumulated in run order. This is the pure,
 * IndexedDB-free half of {@link ./disclosureAccountingStore.ts}, so the shape
 * and the append rule are unit-testable in Node with no database.
 *
 * An entry IS a run's exchange record, verbatim -- not a derived summary.
 * Every fact the accounting states is a field of that record (see
 * docs/spec/EXCHANGE_RECORD.md), which is exactly what makes the record the
 * accounting's single source.
 *
 * The managed record cannot hold this by design: its `lastRun` keeps only
 * the most recent run (see docs/spec/MANAGED_EXCHANGE_RECORD.md, the
 * `lastRun` row). So the accounting is a SIBLING store keyed by the same
 * record id, which also keeps it out of the export artifact.
 *
 * What it holds at rest is the record's own cleartext content -- names,
 * categories, references, aggregate counts -- never a payload value,
 * linkage-field value, or matched identifier. The `resultSize` an entry
 * holds is the intersection CARDINALITY under the record format's
 * entitlement gate, not the intersection itself.
 */

import { z } from "zod";

import { EXCHANGE_RECORD_VERSION, parseExchangeRecord } from "@psilink/core";

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
 * Parse the ENVELOPE of a value read from the accounting store: the stored
 * entries verbatim and unvalidated. Rejects an unrecognized `version` or an
 * unknown key, but looks inside no entry. This is the recovery read -- the
 * only admitted use is handing stored bytes back to the operator, since a
 * record-format version bump can strand entries the full read below can no
 * longer load. Never render what it returns AS an accounting (see
 * docs/spec/EXCHANGE_RECORD.md on the version literal moving with the field
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

/** The `<family>/v<n>` shape a format version literal takes, split so two literals
 * of the same family can be ordered. A literal that does not take it has no
 * ordinal, and orders against nothing. */
const VERSION_SHAPE = /^(.+)\/v(\d+)$/;

/** A version literal's family and ordinal, or `undefined` for a value that is not
 * a literal of that shape. */
function versionParts(
  version: unknown,
): { family: string; ordinal: number } | undefined {
  if (typeof version !== "string") return undefined;
  const match = VERSION_SHAPE.exec(version);
  if (match === null) return undefined;
  return { family: match[1], ordinal: Number(match[2]) };
}

/**
 * Whether any stored entry names a LATER exchange-record format than this
 * build admits -- the direction that says the READER is behind, not the
 * stored value. An earlier-format entry is the app-upgrade case (stranded
 * until exported and cleared); a later one means a newer deployment already
 * exists and reloading is the fix (the service worker does not swap code
 * under a running page; see {@link ../utils/appShellUpdate.ts}), so clearing
 * it here would destroy readable records. True on any such entry, including a
 * mixed accounting. A version literal this cannot order (another family, or
 * a shape holding no ordinal) is treated as not later.
 */
export function storedEntriesAheadOfThisBuild(
  stored: StoredDisclosureAccounting,
): boolean {
  const build = versionParts(EXCHANGE_RECORD_VERSION);
  if (build === undefined) return false;
  return stored.entries.some((entry) => {
    const version =
      entry !== null && typeof entry === "object"
        ? (entry as Record<string, unknown>)["version"]
        : undefined;
    const entryVersion = versionParts(version);
    return (
      entryVersion !== undefined &&
      entryVersion.family === build.family &&
      entryVersion.ordinal > build.ordinal
    );
  });
}

/**
 * Parse and validate a value read from the accounting store. Rejects an
 * unrecognized `version`, an unknown key, or an entry that is not a valid
 * exchange record, rather than loading it -- so a corrupted or
 * app-upgrade-invalidated accounting shows as a read failure rather than
 * silently rendering a shorter, false account. Composed on
 * {@link parseStoredDisclosureAccounting}, so the envelope read and the
 * per-entry validation can only ever fail together or fail at the entries.
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
 * Append one run's exchange record to the accounting, returning the result;
 * a missing accounting starts one. The record is stored verbatim.
 *
 * Appending the same run twice is a no-op, matched on the record's own
 * `bindingNonce` (CSPRNG-generated locally per exchange, so it distinguishes
 * runs within this holder's own log; see docs/spec/EXCHANGE_RECORD.md,
 * "Record fields"). The append is idempotent, so a retried write cannot
 * inflate the disclosure count.
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
