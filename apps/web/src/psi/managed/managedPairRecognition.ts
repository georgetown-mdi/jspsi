/**
 * What a command-line `alcove.yaml` and `.alcove.key` do to the stored record
 * they belong to, decided without the store: the pair import's choice of the
 * record it lands in, and the re-take's check of the pair it is given against
 * the handed-off record (docs/spec/MANAGED_EXCHANGE_RECORD.md, "Importing the
 * key file beside a configuration" and "Taking a command-line hand-off back").
 * The store makes each decision here inside its own transaction, on the
 * records it read there.
 *
 * A pair holds no record id, so after the secret the one thing naming its
 * stored record is the agreed terms and `side` ({@link findRecordsByTermsAndSide}).
 * Two exchanges can share both, so a record found that way is offered to the
 * operator and the pair lands in it only on their word.
 */

import {
  agreedTermsAndSideMismatch,
  findRecordsByTermsAndSide,
} from "./managedLiveCopyMatch";
import {
  applyManagedExchangeRotation,
  clearHandedOffLastRun,
  runnableManagedExchange,
  runnableManagedExchangeOrRefuse,
} from "./managedExchangeRecord";

import type {
  ManagedExchangeRecord,
  RunnableManagedExchangeRecord,
} from "./managedExchangeRecord";
import type { ManagedSpentState } from "./managedLocalStateShape";

/** Why a stored record can take a pair its secret does not match: it was
 * handed off to the command line, spent by the device migration, or holds a
 * configuration only. A live record runs here already and is none of these. */
export type ManagedStoredCopyState =
  "handed-off" | "migration-spent" | "configuration-only";

/** A stored record a pair import names for the operator to take the pair
 * into, with its label (empty when the operator named nothing). */
export interface ManagedStoredCopy {
  id: string;
  label: string;
  state: ManagedStoredCopyState;
}

/** What a pair import asks of the reconciliation beyond the pair itself: the
 * operator's answer to a {@link ManagedStoredCopy} named to them. */
export interface ManagedPairImportOptions {
  /** The stored record the operator chose to take the pair into. */
  into?: string;
  /** The stored records the operator chose to install the pair beside. */
  besideIds?: ReadonlyArray<string>;
}

/** A stored record as the reconciliation read it: the record, and its spent
 * state where it has one. */
export interface ManagedStoredEntry {
  record: ManagedExchangeRecord;
  spent: ManagedSpentState | undefined;
}

/**
 * Where a pair lands, once no stored record refuses it by its secret:
 *
 * - `"revive"` -- lay the pair over a migration-spent record, the one holding
 *   its secret or the one the operator chose.
 * - `"complete"` -- lay the pair over the configuration-only record the
 *   operator chose.
 * - `"retake"` -- take the pair into the command-line hand-off the operator
 *   chose, through the re-take.
 * - `"side-mismatch"` -- the migration-spent record holding the pair's secret
 *   is the other side of it: the partner's files hold the same secret.
 * - `"stored-copy"` -- no record holds the pair's secret, and `copies` may be
 *   its exchange; nothing lands until the operator answers.
 * - `"chosen-copy-changed"` -- the record the operator chose can no longer
 *   take the pair: it was deleted, taken back, or changed since they chose.
 * - `"no-match"` -- the pair installs as a new record.
 */
export type ManagedPairTarget =
  | { kind: "revive"; into: ManagedExchangeRecord }
  | { kind: "complete"; into: ManagedExchangeRecord }
  | { kind: "retake"; id: string }
  | { kind: "side-mismatch"; label: string }
  | { kind: "stored-copy"; copies: ReadonlyArray<ManagedStoredCopy> }
  | { kind: "chosen-copy-changed" }
  | { kind: "no-match" };

/** Which {@link ManagedStoredCopyState} a stored entry is in; `undefined` for
 * a live record, which a pair its secret does not match never lands in. */
export function storedCopyState(
  entry: ManagedStoredEntry,
): ManagedStoredCopyState | undefined {
  if (entry.spent !== undefined)
    return entry.spent.handoff === undefined ? "migration-spent" : "handed-off";
  return runnableManagedExchange(entry.record)
    ? undefined
    : "configuration-only";
}

/**
 * Decide where `imported` lands. `secretMatch` is the migration-spent record
 * holding its secret, which the caller finds after every refusal a secret
 * match raises; `entries` are the stored records whose sibling state was
 * read, in store order. A secret match is the pair's exchange, so it decides
 * ahead of the terms-and-side rule and refuses only on a differing side.
 * Otherwise `options.into` lands the pair in the record the operator chose,
 * provided it still qualifies, and without it every qualifying record not in
 * `options.besideIds` is named.
 */
export function decideCommandLinePairTarget(
  entries: Iterable<ManagedStoredEntry>,
  imported: RunnableManagedExchangeRecord,
  secretMatch: ManagedExchangeRecord | undefined,
  options: ManagedPairImportOptions = {},
): ManagedPairTarget {
  if (secretMatch !== undefined)
    return secretMatch.side === imported.side
      ? { kind: "revive", into: secretMatch }
      : { kind: "side-mismatch", label: secretMatch.label };
  const states = new Map<string, ManagedStoredCopyState>();
  const candidates: Array<ManagedExchangeRecord> = [];
  for (const entry of entries) {
    const state = storedCopyState(entry);
    if (state === undefined) continue;
    states.set(entry.record.id, state);
    candidates.push(entry.record);
  }
  if (options.into !== undefined) {
    const chosen = findRecordsByTermsAndSide(candidates, imported).find(
      ({ id }) => id === options.into,
    );
    if (chosen === undefined) return { kind: "chosen-copy-changed" };
    const state = states.get(chosen.id);
    if (state === "handed-off") return { kind: "retake", id: chosen.id };
    return state === "migration-spent"
      ? { kind: "revive", into: chosen }
      : { kind: "complete", into: chosen };
  }
  const copies = findRecordsByTermsAndSide(
    candidates,
    imported,
    options.besideIds,
  );
  if (copies.length === 0) return { kind: "no-match" };
  return {
    kind: "stored-copy",
    copies: copies.map(({ id, label }) => ({
      id,
      label,
      state: states.get(id) ?? "configuration-only",
    })),
  };
}

/**
 * What a re-take does to the handed-off record `stored`, given the pair the
 * command-line run holds (`taken`) or none:
 *
 * - `"mismatch"` -- `taken` is on other agreed terms or the other side, so
 *   it is not this exchange's pair, and nothing is written.
 * - `"retake"` -- `record` is what the store writes back: `taken`'s secret
 *   and `expires` applied as a rotation where its secret differs from the
 *   stored one (`advanced`), and a `lastRun` recording the hand-off's refusal
 *   dropped. Nothing else about the record moves.
 *
 * @throws {Error} if `stored` holds a configuration only and `taken` would
 *   install a secret on it.
 * @throws {ZodError} if the record written back would be invalid.
 */
export function decideRetake(
  stored: ManagedExchangeRecord,
  taken: RunnableManagedExchangeRecord | undefined,
):
  | { kind: "mismatch"; on: "terms" | "side" }
  | { kind: "retake"; record: ManagedExchangeRecord; advanced: boolean } {
  if (taken !== undefined) {
    const on = agreedTermsAndSideMismatch(stored, taken);
    if (on !== undefined) return { kind: "mismatch", on };
  }
  const advanced =
    taken !== undefined && taken.sharedSecret !== stored.sharedSecret;
  const rotated = advanced
    ? applyManagedExchangeRotation(runnableManagedExchangeOrRefuse(stored), {
        sharedSecret: taken.sharedSecret,
        expires: taken.expires ?? null,
      })
    : stored;
  return { kind: "retake", record: clearHandedOffLastRun(rotated), advanced };
}
