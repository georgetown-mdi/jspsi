/**
 * The pure derivation behind the managed exchange detail view (the per-partnership
 * home at `/saved/$id`): the read-only configuration a compliance user inspects
 * (the agreed terms, the channel and partner endpoint), this party's side label,
 * the most-recent-run history entry, and the honest framing of the self-attested
 * record view. No React, no IndexedDB -- the derivations and copy are unit-testable
 * in Node, and the components stay thin over this model.
 *
 * The agreed terms (the persisted exchange-file document) are READ-ONLY here: a
 * change to them is a re-invite, not an in-place edit (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, the `exchangeFile` row). Only the local
 * fields -- the label, the schedule, and the max-token-age policy -- edit in place,
 * through {@link ../psi/managedExchangeStore.ts}'s local-fields path. This model
 * renders the terms; it never offers an edit control over them.
 */

import { disclosedColumnNames } from "@psilink/core";

import { dateTimeLabel } from "./inviterModel";

import type {
  ManagedExchangeLastRun,
  ManagedExchangeRecord,
  ManagedExchangeSide,
} from "@psi/managedExchangeRecord";
import type { ExchangeSpec } from "@psilink/core";

/** The operator-facing name for each side of the partnership. */
export const SIDE_LABELS: Record<ManagedExchangeSide, string> = {
  inviter: "You set up this exchange (inviter)",
  acceptor: "Your partner set up this exchange (acceptor)",
};

/** One read-only row in the configuration view: a term and its display value. A
 * `values` list renders as a list; a `muted` value renders in the empty-state
 * voice ("None"). */
export interface ConfigRow {
  label: string;
  value?: string;
  values?: ReadonlyArray<string>;
  muted?: string;
}

/**
 * The read-only linkage-terms rows for the configuration view, derived from this
 * party's persisted exchange-file document. It surfaces the agreed terms a
 * compliance user reads -- the matched-on keys, what this party sends, whether it
 * receives the result, and the legal agreement -- from the party's own document
 * perspective. It renders names and categories only, never a row value, exactly as
 * the document itself carries (see docs/spec/MANAGED_EXCHANGE_RECORD.md, the
 * `exchangeFile` row).
 */
export function linkageTermsRows(exchangeFile: ExchangeSpec): Array<ConfigRow> {
  const terms = exchangeFile.linkageTerms;
  const sent =
    exchangeFile.metadata !== undefined
      ? disclosedColumnNames(exchangeFile.metadata)
      : [];
  const keys = terms.linkageKeys.map((key) => key.name);
  return [
    { label: "Your identity", value: terms.identity },
    keys.length > 0
      ? { label: "Matched on", values: keys }
      : { label: "Matched on", muted: "No keys" },
    sent.length > 0
      ? { label: "You send", values: sent }
      : { label: "You send", muted: "Nothing - matching only" },
    {
      label: "You receive the result",
      value: terms.output.expectsOutput ? "Yes" : "No",
    },
    terms.legalAgreement?.reference !== undefined &&
    terms.legalAgreement.reference !== ""
      ? { label: "Legal agreement", value: terms.legalAgreement.reference }
      : { label: "Legal agreement", muted: "None" },
  ];
}

/**
 * The read-only connection rows for the configuration view: the channel and the
 * partner endpoint. A managed record's document is a credential-free webrtc
 * locator (host/port/path only; see docs/spec/MANAGED_EXCHANGE_RECORD.md, "The
 * connection block"), so the endpoint shown is the signaling locator, never a
 * credential -- no `server.key`, no `server.username` is representable in the
 * stored document.
 */
export function connectionRows(exchangeFile: ExchangeSpec): Array<ConfigRow> {
  const { connection } = exchangeFile;
  const rows: Array<ConfigRow> = [
    { label: "Channel", value: "Live (browser)" },
  ];
  if (connection.channel === "webrtc") {
    const { server } = connection;
    const endpoint =
      server.port !== undefined
        ? `${server.host}:${String(server.port)}${server.path ?? ""}`
        : `${server.host}${server.path ?? ""}`;
    rows.push({ label: "Rendezvous server", value: endpoint });
  }
  return rows;
}

/**
 * One run-history entry: what a single run did and what it disclosed. Today the
 * record persists only the most-recent run's bookkeeping (`lastRun`), never a per-
 * run disclosure ledger (a separate future item), so exactly one entry is derivable
 * -- the most recent run. This shape is deliberately per-entry so a fuller ledger
 * can slot in later without reshaping the view.
 */
export interface RunHistoryEntry {
  /** ISO 8601 UTC instant of the run. */
  at: string;
  /** The run instant phrased for display. */
  when: string;
  /** The outcome phrased for display, e.g. "Succeeded", "Missed window". */
  outcome: string;
  /** The plain, honest disclosure line for this entry. The run bookkeeping carries
   * no match result, count, or row value (it is closed enums and a timestamp), so
   * this states what the record can honestly say, not a fabricated disclosure. */
  disclosure: string;
}

/** The display outcome for each run outcome the bookkeeping records. */
const OUTCOME_LABELS: Record<ManagedExchangeLastRun["outcome"], string> = {
  succeeded: "Succeeded",
  failed: "Failed",
  desynced: "Out of sync",
  missed: "Missed window",
};

/** The disclosure line for a succeeded run. */
const SUCCEEDED_DISCLOSURE =
  "Disclosed the agreed terms (shown above). The full record file was offered to download when the run completed.";

/** The disclosure line for a run that provably stopped before any data left this
 * party (a no-show, or a failure that fired before the data exchange began). */
const NOTHING_DISCLOSED =
  "Nothing was disclosed -- the run stopped before any data was exchanged.";

/** The disclosure line for a run that failed after the handshake, where the record
 * cannot prove whether data reached the partner. It asserts neither way and points
 * at the authoritative account -- the record file offered at run completion. */
const OUTCOME_UNCERTAIN =
  "The run did not complete. Whether any data reached your partner is not recorded here; the record file offered when a run completes is the authoritative account.";

/**
 * Whether a failed run's bookkeeping proves it stopped before the data exchange
 * began -- so "nothing was disclosed" is honest. The run lifecycle is: input guard,
 * then the authenticated handshake, then the durable rotation persist, then the data
 * exchange (the first peer-visible payload; see
 * {@link ../psi/managedExchangeRun.ts}). A failure whose recorded `failureKind` fires
 * at or before the persist provably precedes any data leaving this party:
 *
 * - `"input"` -- the pre-connection input guard, before any connection.
 * - `"auth"` -- the authenticated handshake failed closed, before the persist and the
 *   data exchange.
 * - `"storage"` -- the rotation persist failed after the handshake but before the data
 *   exchange (persist-before-success).
 *
 * The remaining kinds cannot prove it: `"transport"` is the catch-all bucket that a
 * data-exchange drop also lands in ({@link ../psi/managedRun.ts}, `rerunFailureLastRun`),
 * and `"cancelled"` covers a teardown that can land mid-data-exchange. A missing kind
 * (a defensive fall-through) is treated the same -- not proven precedent -- so the copy
 * never over-claims.
 */
function disclosurePrecedesExchange(
  failureKind: ManagedExchangeLastRun["failureKind"],
): boolean {
  return (
    failureKind === "input" ||
    failureKind === "auth" ||
    failureKind === "storage"
  );
}

/**
 * The disclosure line for a non-succeeded run, mapped conservatively from the run's
 * outcome and `failureKind`. A run that never completed a handshake (`"missed"`,
 * `"desynced"`) or failed at or before the rotation persist (`"input"`, `"auth"`,
 * `"storage"`) provably disclosed nothing -- no payload had left this party. A run
 * that failed after the handshake (`"transport"`, `"cancelled"`, or an unrecorded
 * kind) may have failed mid-data-exchange, so the line asserts neither way and points
 * at the record file offered at run completion as the authoritative account.
 */
function nonSucceededDisclosure(lastRun: ManagedExchangeLastRun): string {
  // A no-show and a rotation-desync both mean no handshake completed, so no data was
  // exchanged; a `"failed"` outcome defers to the failureKind's lifecycle position.
  if (lastRun.outcome === "missed" || lastRun.outcome === "desynced")
    return NOTHING_DISCLOSED;
  return disclosurePrecedesExchange(lastRun.failureKind)
    ? NOTHING_DISCLOSED
    : OUTCOME_UNCERTAIN;
}

/**
 * The run-history entries for the detail view, derived from the record's `lastRun`
 * bookkeeping. An empty list when no run has been recorded (a saved-but-never-run
 * exchange); otherwise a single entry for the most recent run. The disclosure line
 * is honest to what the bookkeeping holds: a succeeded run disclosed the agreed
 * terms (which the configuration view above names); a run that stopped before the
 * data exchange disclosed nothing; and a run that failed after the handshake, where
 * the record cannot prove whether data reached the partner, asserts neither way (see
 * {@link nonSucceededDisclosure}). A per-run disclosure ledger is a separate future
 * item; this renders the one run the record knows about.
 */
export function runHistoryEntries(
  record: Pick<ManagedExchangeRecord, "lastRun">,
): Array<RunHistoryEntry> {
  const { lastRun } = record;
  if (lastRun === undefined) return [];
  const disclosure =
    lastRun.outcome === "succeeded"
      ? SUCCEEDED_DISCLOSURE
      : nonSucceededDisclosure(lastRun);
  return [
    {
      at: lastRun.at,
      when: dateTimeLabel(new Date(lastRun.at)),
      outcome: OUTCOME_LABELS[lastRun.outcome],
      disclosure,
    },
  ];
}
