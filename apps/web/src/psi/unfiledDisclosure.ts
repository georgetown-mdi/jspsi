/**
 * The note a run leaves when its disclosure record never reached the exchange's
 * accounting of disclosures: the pure, IndexedDB-free half of
 * {@link ./unfiledDisclosureStore.ts}, so the shape, the key, and the merge rule
 * are unit-testable in Node with no database.
 *
 * The append is best-effort by design -- the exchange has already happened, so a
 * failed append can neither undo it nor make the run a failure -- and the notice
 * it raises reaches whoever is present. A scheduled run has nobody, so this note
 * is what the next visit reads instead: the accounting is short an entry, and
 * this says which run it owes.
 *
 * It sits in the disclosure store beside the accounting it stands against, under
 * a key of its own ({@link unfiledDisclosureKey}), so a run that was never filed
 * is never a row of a log whose rows are self-attested records.
 *
 * What it holds at rest is one retained exchange record per unfiled run, where
 * that run produced one -- the same cleartext content the accounting's own
 * entries hold. Retaining it is what lets the next visit file the entry; a run
 * whose record could not be built leaves its instant alone, and no retry can
 * recover it (see docs/spec/MANAGED_EXCHANGE_RECORD.md, "A run whose record was
 * not filed").
 */

import { z } from "zod";

import { parseExchangeRecord } from "@psilink/core";

import type { ExchangeRecord } from "@psilink/core";
import type { ZodType } from "zod";

/** The single recognized format version for a stored note. A reader rejects any
 * other value rather than migrating it, the reader-rejects-unknown rule the
 * record and the accounting of disclosures follow (see
 * docs/spec/EXCHANGE_RECORD.md). */
export const UNFILED_DISCLOSURE_VERSION = "psilink-unfiled-disclosure/v1";

/** The second element of the note's key, which is what separates it from the
 * accounting stored under the exchange id alone. */
const UNFILED_DISCLOSURE_KEY_PART = "unfiled";

/**
 * Where one exchange's note sits in the disclosure store: an array key of the
 * record id and a fixed part, beside the accounting that same id keys on its
 * own.
 *
 * An array key equals no string key whatever the id holds, so a note collides
 * with no exchange's accounting -- including an imported record's id, which the
 * record schema admits as any non-empty string rather than as this app's own
 * generated one.
 */
export function unfiledDisclosureKey(id: string): [string, string] {
  return [id, UNFILED_DISCLOSURE_KEY_PART];
}

/**
 * One run whose disclosure record never reached the accounting, as it sits at
 * rest. The retained record is held to nothing here: a record this build's
 * exchange-record format no longer admits keeps its stored bytes rather than
 * refusing the whole note, whose fact outlives any record format
 * ({@link unfiledDisclosuresOf}).
 */
export interface StoredUnfiledDisclosure {
  /** ISO-8601 instant the shortfall was noted, which falls inside the run it
   * stands for. The run's own instant is the retained record's `createdAt`
   * wherever there is one. */
  at: string;
  /** The run's own self-attested exchange record, retained so the append can be
   * retried. Absent where the run built none, the state no retry recovers. */
  record?: unknown;
}

/** One exchange's unfiled runs, oldest first. */
export interface StoredUnfiledDisclosures {
  version: typeof UNFILED_DISCLOSURE_VERSION;
  entries: ReadonlyArray<StoredUnfiledDisclosure>;
}

const storedSchema: ZodType<StoredUnfiledDisclosures> = z
  .object({
    version: z.literal(UNFILED_DISCLOSURE_VERSION),
    entries: z.array(
      z
        .object({ at: z.iso.datetime(), record: z.unknown().optional() })
        .strict(),
    ),
  })
  .strict();

/**
 * Parse a value read from the note's key. Rejects an unrecognized `version`, an
 * unknown key, or an entry with no instant, and looks inside no retained record
 * -- the fact that a run went unfiled is what this value exists to keep, and it
 * must survive a record format the entries were written under and this build no
 * longer reads.
 *
 * @throws {ZodError} if the value is not a stored note this build recognizes.
 */
export function parseStoredUnfiledDisclosures(
  raw: unknown,
): StoredUnfiledDisclosures {
  return storedSchema.parse(raw);
}

/** The binding nonce a retained record holds, or `undefined` for a value that
 * holds none: the entry identity the merge below matches on, read off the stored
 * value without holding it to the record format. */
function bindingNonceOf(record: unknown): string | undefined {
  if (record === null || typeof record !== "object") return undefined;
  const nonce = (record as Record<string, unknown>)["bindingNonce"];
  return typeof nonce === "string" ? nonce : undefined;
}

/** Whether `entry` is already noted: a retained record matches on its own
 * binding nonce, and an entry that retained none matches on its instant, which
 * is all that identifies it. */
function alreadyNoted(
  entries: ReadonlyArray<StoredUnfiledDisclosure>,
  entry: StoredUnfiledDisclosure,
): boolean {
  const nonce = bindingNonceOf(entry.record);
  if (nonce === undefined)
    return entries.some(
      (noted) => noted.at === entry.at && noted.record === undefined,
    );
  return entries.some((noted) => bindingNonceOf(noted.record) === nonce);
}

/**
 * Note one unfiled run, returning the result; a missing note starts one. Entries
 * stay in run order.
 *
 * Noting the same run twice is a no-op, matched on the retained record's own
 * binding nonce (see docs/spec/EXCHANGE_RECORD.md, "Record fields") or, for a
 * run that retained no record, on its instant. So a repeated write cannot leave
 * two entries for one disclosure, and the number of entries is the number of
 * runs the accounting is short.
 */
export function noteUnfiledDisclosure(
  current: StoredUnfiledDisclosures | undefined,
  entry: StoredUnfiledDisclosure,
): StoredUnfiledDisclosures {
  if (current === undefined)
    return { version: UNFILED_DISCLOSURE_VERSION, entries: [entry] };
  if (alreadyNoted(current.entries, entry)) return current;
  return {
    version: UNFILED_DISCLOSURE_VERSION,
    entries: [...current.entries, entry],
  };
}

/** One unfiled run as the next visit reads it. */
export interface UnfiledDisclosure {
  /** The instant the run is named by: its record's own `createdAt` where a
   * record was retained and admitted, otherwise the instant the shortfall was
   * noted. */
  at: string;
  /** The retained record, where the run built one and this build admits it. Its
   * absence is what makes the entry unrecoverable: there is nothing left to
   * append. */
  record?: ExchangeRecord;
}

/**
 * The stored note's entries as the next visit reads them, oldest first: each
 * entry's retained record validated through core's own
 * {@link parseExchangeRecord}, and left out of the reading where that refuses.
 *
 * A record this build does not admit leaves the entry standing with no record,
 * which is what the surface states as unrecoverable: the append holds an entry
 * to the same validation, so a record it refuses could not be filed either. The
 * stored bytes are untouched by this reading -- only a write prunes an entry --
 * so a build that admits them again finds them.
 */
export function unfiledDisclosuresOf(
  stored: StoredUnfiledDisclosures,
): Array<UnfiledDisclosure> {
  return stored.entries.map((entry) => {
    if (entry.record === undefined) return { at: entry.at };
    try {
      const record = parseExchangeRecord(entry.record);
      return { at: record.createdAt, record };
    } catch {
      return { at: entry.at };
    }
  });
}

/**
 * The note left after the runs whose binding nonces `filed` holds were appended
 * to the accounting, or `undefined` when nothing is left to keep -- which is
 * what tells the store to remove the key rather than leave an empty note at
 * rest.
 *
 * An entry that was not filed stays exactly as it sits, retained record
 * included: a run whose record could not be built is not resolved by another
 * run's filing, and neither is one whose record this build cannot read.
 */
export function unfiledDisclosuresAfterFiling(
  stored: StoredUnfiledDisclosures,
  filed: ReadonlySet<string>,
): StoredUnfiledDisclosures | undefined {
  const entries = stored.entries.filter((entry) => {
    const nonce = bindingNonceOf(entry.record);
    return nonce === undefined || !filed.has(nonce);
  });
  if (entries.length === 0) return undefined;
  return { version: UNFILED_DISCLOSURE_VERSION, entries };
}
