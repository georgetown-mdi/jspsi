import { withTimeout } from "@psilink/core";

import { fittedCauseLink } from "../causeLink";

import type { RTCPeerConnection } from "werift";

/**
 * What ICE gathered, received and tried, read from a peer connection's
 * `getStats()` report and rendered for an operator.
 *
 * The report is the only first-party account of why a WebRTC exchange did or
 * did not find a network path: a candidate pair that worked names the two
 * candidate types it joined, and a run that never opened a channel is told
 * apart by whether a relay candidate was gathered at all -- a party behind a
 * network that blocks the TURN server gathers none, which no amount of
 * waiting on the other party will fix.
 *
 * Every candidate type on the remote side is a token the exchange partner
 * chose. Driven against werift 0.24.4, a candidate line whose `typ` token is
 * not one werift names is accepted without throwing and then reaches no
 * `getStats` entry at all, so what a report holds is werift's own vocabulary
 * rather than the partner's text (pinned by
 * test/integration/webrtc/transport.test.ts). The value is bounded and escaped
 * where it reaches the operator all the same -- a labelled cause link on the
 * failure path, `redactAndSanitizeForDisplay` at the log call site on the
 * success path -- so a version that does pass the token through cannot reach a
 * terminal with it, and it is never composed into a first-party summary.
 */

/** Candidate type an entry with no readable one is counted under. */
export const UNREPORTED_CANDIDATE_TYPE = "unreported";

/** The candidate type that means a relay was reachable and gave an address. */
const RELAY_CANDIDATE_TYPE = "relay";

/**
 * How many distinct candidate types one side's tally names before the rest
 * are summarized as a count. ICE defines four, so a report naming more than
 * this is a peer sending types no gatherer produces rather than a wide
 * legitimate set.
 */
export const MAX_REPORTED_CANDIDATE_TYPES = 6;

/** Labels the failure detail links carry, in the order they are chained. */
const LOCAL_CANDIDATES_LABEL = "local candidates gathered: ";
const REMOTE_CANDIDATES_LABEL = "remote candidates received: ";
const CANDIDATE_PAIRS_LABEL = "candidate pairs: ";

/**
 * The stats report shape these diagnostics read: the map `getStats()` resolves
 * to. Declared structurally rather than as werift's `RTCStatsReport` so a test
 * can pass a plain `Map`, and read entry by entry as `unknown` because a stats
 * entry's fields are whatever the library put there.
 */
export type IceStatsReport = ReadonlyMap<string, unknown>;

/** One side's candidate tally: how many arrived, and of which types. */
export interface CandidateTally {
  /** Candidates the report holds for this side. */
  count: number;
  /** Distinct types, sorted, capped at {@link MAX_REPORTED_CANDIDATE_TYPES}. */
  types: ReadonlyArray<string>;
  /** Distinct types beyond the ones listed. */
  unlistedTypes: number;
}

/** What one peer connection's ICE stats say about the path it looked for. */
export interface IceCandidateReport {
  local: CandidateTally;
  remote: CandidateTally;
  /**
   * Whether a relay candidate is among this side's. Only this side's is
   * answered: it is the one an operator can act on, and it is read off every
   * gathered type rather than the capped list in the tally. What the partner
   * sent is already in {@link remote}'s types.
   */
  localRelayGathered: boolean;
  /** Candidate pairs the report holds. */
  pairCount: number;
  /** How many of them reached the succeeded state. */
  succeededPairCount: number;
  /** The nominated pair's two candidate types, when the report names one. */
  selected?: { localType: string; remoteType: string };
}

/** Read one entry's `type` discriminant, or `undefined` if it has none. */
function entryType(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const type = (entry as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

/** Read a string field off a stats entry, or `undefined`. */
function stringField(entry: unknown, field: string): string | undefined {
  const value = (entry as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function tallyOf(types: ReadonlyArray<string>): CandidateTally {
  const distinct = [...new Set(types)].sort();
  return {
    count: types.length,
    types: distinct.slice(0, MAX_REPORTED_CANDIDATE_TYPES),
    unlistedTypes: Math.max(0, distinct.length - MAX_REPORTED_CANDIDATE_TYPES),
  };
}

/**
 * Summarize a peer connection's ICE stats.
 *
 * The selected pair is the nominated one, falling back to a succeeded one:
 * a report taken the instant a channel opens can hold a pair that has
 * succeeded before nomination is recorded, and naming it is more use to an
 * operator than naming none.
 */
export function readIceCandidateReport(
  stats: IceStatsReport,
): IceCandidateReport {
  const candidateTypes = new Map<string, string>();
  const localTypes: Array<string> = [];
  const remoteTypes: Array<string> = [];
  const pairs: Array<unknown> = [];

  for (const entry of stats.values()) {
    const type = entryType(entry);
    if (type === "candidate-pair") {
      pairs.push(entry);
      continue;
    }
    if (type !== "local-candidate" && type !== "remote-candidate") continue;
    const candidateType =
      stringField(entry, "candidateType") ?? UNREPORTED_CANDIDATE_TYPE;
    const id = stringField(entry, "id");
    if (id !== undefined) candidateTypes.set(id, candidateType);
    (type === "local-candidate" ? localTypes : remoteTypes).push(candidateType);
  }

  const nominated = pairs.find(
    (pair) => (pair as { nominated?: unknown }).nominated === true,
  );
  const selectedPair =
    nominated ??
    pairs.find((pair) => stringField(pair, "state") === "succeeded");
  const localType =
    selectedPair === undefined
      ? undefined
      : candidateTypes.get(stringField(selectedPair, "localCandidateId") ?? "");
  const remoteType =
    selectedPair === undefined
      ? undefined
      : candidateTypes.get(
          stringField(selectedPair, "remoteCandidateId") ?? "",
        );

  return {
    local: tallyOf(localTypes),
    remote: tallyOf(remoteTypes),
    localRelayGathered: localTypes.includes(RELAY_CANDIDATE_TYPE),
    pairCount: pairs.length,
    succeededPairCount: pairs.filter(
      (pair) => stringField(pair, "state") === "succeeded",
    ).length,
    selected:
      localType === undefined || remoteType === undefined
        ? undefined
        : { localType, remoteType },
  };
}

/** Render one side's tally as `3 (host, srflx)`, or `none`. */
function describeTally(tally: CandidateTally): string {
  if (tally.count === 0) return "none";
  const listed = tally.types.join(", ");
  const rest =
    tally.unlistedTypes === 0 ? "" : ` and ${tally.unlistedTypes} more`;
  return `${tally.count} (${listed}${rest})`;
}

/**
 * The candidate pair a completed exchange runs over, as raw text for an
 * operator: `local host, remote relay`. Returns `undefined` when the report
 * names no pair, which is itself worth reporting at the call site.
 *
 * Raw because the remote type is the partner's token: the caller escapes it
 * once, where it is shown (CONTRIBUTING.md, Operator-facing escaping).
 */
export function describeSelectedCandidatePair(
  report: IceCandidateReport,
): string | undefined {
  if (report.selected === undefined) return undefined;
  return `local ${report.selected.localType}, remote ${report.selected.remoteType}`;
}

/**
 * The ordered, labelled cause links a failed rendezvous reports: what this
 * side gathered, what the partner sent, and what the two were tried as.
 *
 * Whether a relay candidate was gathered is stated on the local link either
 * way, because it is what separates a network that blocked the TURN server
 * from one where a relayed path was available and still no pair worked -- the
 * two failures have different remedies and look identical without it. It leads
 * the link rather than following the tally, so a long list of gathered types
 * cannot be what the fitting below clips it away for.
 *
 * Each link is fitted at this composition site
 * ({@link ../causeLink.fittedCauseLink}), so the partner's candidate types can
 * only ever spend the budget of the link they sit alone on.
 */
export function iceFailureDetails(
  report: IceCandidateReport,
): [string, ...string[]] {
  const relay = report.localRelayGathered
    ? "relay candidate gathered"
    : "no relay candidate gathered";
  const pairs =
    report.pairCount === 0
      ? "none formed"
      : `${report.pairCount} tried, ` +
        (report.succeededPairCount === 0
          ? "none succeeded"
          : `${report.succeededPairCount} succeeded`);
  return [
    fittedCauseLink(
      LOCAL_CANDIDATES_LABEL,
      `${relay}; ${describeTally(report.local)}`,
    ),
    fittedCauseLink(REMOTE_CANDIDATES_LABEL, describeTally(report.remote)),
    fittedCauseLink(CANDIDATE_PAIRS_LABEL, pairs),
  ];
}

/**
 * Ceiling on collecting the stats. The rendezvous failure this diagnostic
 * explains is itself bounded, so the diagnostic must be too: without a ceiling
 * a `getStats()` that never settles would hold the failure open indefinitely
 * and turn a reported failure into a hang.
 */
export const ICE_STATS_TIMEOUT_MS = 2_000;

/**
 * Read a peer connection's ICE stats, or `undefined` when they cannot be read.
 *
 * Absorbing the failure is the point: this runs on the path where a rendezvous
 * has already failed, or the instant one has succeeded, and neither outcome may
 * turn on a diagnostic. A peer connection already torn down, a stand-in that
 * implements no `getStats`, and a collection that overruns
 * {@link ICE_STATS_TIMEOUT_MS} all land here.
 */
export async function readIceStats(
  peer: RTCPeerConnection,
): Promise<IceCandidateReport | undefined> {
  try {
    const stats = (await withTimeout(
      Promise.resolve(peer.getStats()),
      ICE_STATS_TIMEOUT_MS,
      "collecting WebRTC ICE statistics timed out",
    )) as IceStatsReport | undefined;
    if (stats === undefined || typeof stats.values !== "function")
      return undefined;
    return readIceCandidateReport(stats);
  } catch {
    return undefined;
  }
}
