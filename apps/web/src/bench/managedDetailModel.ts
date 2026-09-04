/**
 * The pure derivation behind the managed exchange detail view (the per-partnership
 * home at `/saved/$id`): the read-only configuration a compliance user inspects
 * (the agreed terms, the channel and partner endpoint), this party's side label,
 * the agreed schedule's due-ness where one exists, the most-recent-run history
 * entry, and the accurate framing of the self-attested record view. No React, no
 * IndexedDB -- the derivations and copy are unit-testable in Node, and the
 * components stay thin over this model.
 *
 * The agreed terms (the persisted exchange-file document) are READ-ONLY here: a
 * change to them is a re-invite, not an in-place edit (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, the `exchangeFile` row). Only the local
 * fields -- the label, the schedule, and the max-token-age policy -- edit in place,
 * through {@link ../psi/managedExchangeStore.ts}'s local-fields path. This model
 * renders the terms; it never offers an edit control over them.
 */

import {
  UNNAMED_PARTY_LABEL,
  disclosedColumnNames,
  displayText,
  sanitizeForDisplay,
} from "@psilink/core";

import {
  SCHEDULE_INPUT_RESELECTION_NOTE,
  repeatedMissCoordination,
  scheduleAttendanceNote,
  scheduleCadenceLine,
  scheduleDueLine,
  scheduleDueness,
} from "./scheduleSurfacingModel";
import { dateTimeLabel } from "./inviterModel";

import type { Displayable, ExchangeSpec } from "@psilink/core";
import type {
  ManagedExchangeLastRun,
  ManagedExchangeRecord,
  ManagedExchangeSide,
} from "@psi/managedExchangeRecord";
import type { RepeatedMissCoordination } from "./scheduleSurfacingModel";

/** The operator-facing name for each side of the partnership. */
export const SIDE_LABELS: Record<ManagedExchangeSide, string> = {
  inviter: "You set up this exchange (inviter)",
  acceptor: "Your partner set up this exchange (acceptor)",
};

/**
 * One read-only row in the configuration view: a term and its display value. A
 * `values` list renders as a list; a `muted` value renders in the empty-state
 * voice ("None").
 *
 * The value fields are {@link Displayable}, not `string`: a row built from a
 * partner-authored value (a linkage-key name, a legal-agreement reference, a
 * rendezvous locator) must pass the display boundary first, since JSX escaping
 * alone does not stop a bidi override, zero-width joiner, or homoglyph. `label`,
 * `muted`, and `note` stay plain `string` -- this app's own fixed copy.
 */
export interface ConfigRow {
  label: string;
  value?: Displayable;
  values?: ReadonlyArray<Displayable>;
  muted?: string;
  /** A caveat qualifying what the row's value asserts, rendered below it. */
  note?: string;
}

/**
 * The read-only linkage-terms rows for the configuration view, derived from this
 * party's persisted exchange-file document: the matched-on keys, what this party
 * sends, whether it receives the result, and the legal agreement. Renders names
 * and categories only, never a row value, exactly as the document carries (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, the `exchangeFile` row).
 */
export function linkageTermsRows(exchangeFile: ExchangeSpec): Array<ConfigRow> {
  const terms = exchangeFile.linkageTerms;
  const sent =
    exchangeFile.metadata !== undefined
      ? disclosedColumnNames(exchangeFile.metadata)
      : [];
  const keys = terms.linkageKeys.map((key) => sanitizeForDisplay(key.name));
  return [
    terms.identity === undefined
      ? { label: "Your identity", muted: UNNAMED_PARTY_LABEL }
      : { label: "Your identity", value: sanitizeForDisplay(terms.identity) },
    keys.length > 0
      ? { label: "Matched on", values: keys }
      : { label: "Matched on", muted: "No keys" },
    sent.length > 0
      ? {
          label: "You send",
          values: sent.map((name) => sanitizeForDisplay(name)),
        }
      : { label: "You send", muted: "Nothing - matching only" },
    {
      label: "You receive the result",
      value: terms.output.expectsOutput ? displayText`Yes` : displayText`No`,
    },
    terms.legalAgreement?.reference !== undefined &&
    terms.legalAgreement.reference !== ""
      ? {
          label: "Legal agreement",
          value: sanitizeForDisplay(terms.legalAgreement.reference),
        }
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
    { label: "Channel", value: displayText`Live (browser)` },
  ];
  if (connection.channel === "webrtc") {
    const { server } = connection;
    // Host and path cross the display boundary one at a time, then compose: each
    // is separately partner-authored and separately capped, so a padded host
    // cannot spend the whole row's budget and leave the path unread.
    const host = sanitizeForDisplay(server.host);
    const path = sanitizeForDisplay(server.path ?? "");
    rows.push({
      label: "Rendezvous server",
      value:
        server.port !== undefined
          ? displayText`${host}:${server.port}${path}`
          : displayText`${host}${path}`,
    });
  }
  return rows;
}

/**
 * The read-only run-schedule section: the agreed cadence, where the recurrence
 * stands right now, and the states this browser must represent accurately.
 * Derived at render time from the record's schedule and the instant read (see
 * {@link ./scheduleSurfacingModel.ts}); nothing is persisted, advanced, or
 * promised.
 *
 * The section READS the schedule; the operator sets and clears it in the
 * local-fields editor beside it (see {@link ./ManagedExchangeDetail.tsx}).
 */
export interface ScheduleView {
  /** The agreed cadence in words. */
  cadence: string;
  /** Where the recurrence stands at the instant read: a window open now, or the
   * next one. */
  dueLine: string;
  /** What THIS runtime does with a schedule, and what the operator does about it:
   * an installed app meets the windows itself, an ordinary tab never does.
   * Standing copy: it holds whether or not a window is open. */
  attendanceNote: string;
  /** The escalated coordination state, once the record's consecutive-miss count
   * has reached the threshold; absent below it. */
  coordination?: RepeatedMissCoordination;
  /** Present when this browser holds no usable pointer to the input file, which
   * is a standing bar to any run happening with nobody present. */
  inputReselectionNote?: string;
}

/**
 * The run-schedule section for a record, or `undefined` for one with no agreed
 * schedule (an attended-only exchange), so the section renders nothing rather
 * than an empty state.
 *
 * Both platform readings are the caller's, kept out of this model so the
 * derivation stays pure: `hasInputHandle` is a stored handle AND the File System
 * Access API to use it with; `installedRuntime` is whether this page is the
 * installed app the unattended runner starts in.
 *
 * @throws {RangeError} if the schedule's lattice is unusable (see
 *   {@link scheduleDueness}).
 */
export function scheduleView(
  record: Pick<ManagedExchangeRecord, "schedule">,
  hasInputHandle: boolean,
  installedRuntime: boolean,
  now: number,
): ScheduleView | undefined {
  const { schedule } = record;
  if (schedule === undefined) return undefined;
  const coordination = repeatedMissCoordination(schedule);
  return {
    cadence: scheduleCadenceLine(schedule),
    dueLine: scheduleDueLine(scheduleDueness(schedule, now)),
    attendanceNote: scheduleAttendanceNote(installedRuntime),
    ...(coordination !== undefined ? { coordination } : {}),
    ...(hasInputHandle
      ? {}
      : { inputReselectionNote: SCHEDULE_INPUT_RESELECTION_NOTE }),
  };
}

/**
 * One run-history entry: what a single run did and what it disclosed. The record's
 * own bookkeeping (`lastRun`) keeps only the most recent run, so exactly one entry
 * is derivable here. A completed run's disclosure is not read from this bookkeeping
 * at all -- it is the run's own exchange record, filed in the exchange's accounting
 * of disclosures (see {@link ./disclosureAccountingModel.ts}); this entry covers
 * the runs that accounting cannot, the ones that did not complete.
 */
export interface RunHistoryEntry {
  /** ISO 8601 UTC instant of the run. */
  at: string;
  /** The run instant phrased for display. */
  when: string;
  /** The outcome phrased for display, e.g. "Succeeded", "Partner did not arrive". */
  outcome: string;
  /** The plain, accurate disclosure line for this entry. The run bookkeeping carries
   * no match result, count, or row value (it is closed enums and a timestamp), so
   * this states what the record can accurately say, not a fabricated disclosure. */
  disclosure: string;
}

/** The display outcome for each run outcome the bookkeeping records. The no-show
 * label names the partner rather than a window: the outcome is reached at an agreed
 * window and by an attended run whose own wait for the partner expired. */
const OUTCOME_LABELS: Record<ManagedExchangeLastRun["outcome"], string> = {
  succeeded: "Succeeded",
  failed: "Failed",
  desynced: "Out of sync",
  missed: "Partner did not arrive",
};

/** The disclosure line for a succeeded run. */
const SUCCEEDED_DISCLOSURE =
  "Disclosed the agreed terms (shown above). The run's own record states exactly what it disclosed; it is filed in the accounting of disclosures below, and was offered to download when the run completed.";

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
 * began. The run lifecycle is: input guard, authenticated handshake, durable
 * rotation persist, then the data exchange (first peer-visible payload; see
 * {@link ../psi/managedExchangeRun.ts}). A `failureKind` that fires at or before
 * the persist precedes any data leaving this party: `"handed-off"` and
 * `"custody-unreadable"` (the run+rotate lock's first act, before any
 * connection), `"input"`, `"terms-shortfall"`, and `"consent"` (all
 * pre-connection), `"auth"` (a `security`-kind failure the classifier stamps
 * only before the data exchange begins; see {@link ../psi/managedRun.ts},
 * `rerunFailureLastRun`), and `"storage"` (persist-before-success). The
 * remaining kinds -- `"transport"` (the catch-all a mid-exchange failure also
 * lands in), `"cancelled"`, and a missing kind -- cannot prove it.
 */
function disclosurePrecedesExchange(
  failureKind: ManagedExchangeLastRun["failureKind"],
): boolean {
  return (
    failureKind === "handed-off" ||
    failureKind === "custody-unreadable" ||
    failureKind === "input" ||
    failureKind === "terms-shortfall" ||
    failureKind === "consent" ||
    failureKind === "auth" ||
    failureKind === "storage"
  );
}

/**
 * The disclosure line for a non-succeeded run, from the outcome and
 * `failureKind`: no handshake (`"missed"`, `"desynced"`) or a failure at or
 * before the persist ({@link disclosurePrecedesExchange}) means nothing was
 * disclosed; otherwise the line asserts neither way and points at the record
 * file offered at run completion.
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
 * The run-history entries for the detail view, derived from the record's
 * `lastRun` bookkeeping: an empty list when no run has been recorded, otherwise
 * a single entry for the most recent run (see {@link nonSucceededDisclosure} for
 * the disclosure line). Every completed run's own disclosure is in the
 * accounting of disclosures, not here.
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

/**
 * Whether the record's own bookkeeping records a run that COMPLETED -- the only
 * kind that files an entry in the accounting of disclosures (see
 * {@link runHistoryEntries}).
 *
 * The accounting view reads this to keep its empty state accurate: an empty
 * accounting is not evidence nothing was disclosed, since a reset clears stored
 * entries without touching the record, and export/import carries the exchange
 * without its accounting.
 *
 * ONE-WAY: the record keeps only the most recent run (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, the `lastRun` row), so `false` means only
 * that the retained run is not a completed one.
 */
export function completedRunRecorded(
  record: Pick<ManagedExchangeRecord, "lastRun">,
): boolean {
  return record.lastRun?.outcome === "succeeded";
}
