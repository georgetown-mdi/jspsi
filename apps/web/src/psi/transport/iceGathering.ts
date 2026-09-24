import { ConnectionError } from "@alcove/core";

import type { DataConnection } from "peerjs";

/**
 * What the browser reported while gathering ICE candidates for a data
 * connection, so a channel that never opens can name the relay that failed.
 * The browser reports a failed ICE server once, as an `icecandidateerror`
 * event, so the watch must attach before gathering starts: in the tick PeerJS
 * hands the connection out, since it gathers only after an asynchronous offer
 * or answer. test/browser/iceServerFailure.test.ts fails if that stops holding.
 */

/** One `icecandidateerror` the browser raised. */
export interface IceServerError {
  /** The ICE server url as the browser names it. */
  url: string;
  /** The STUN error code, or 701 where the server could not be reached. */
  errorCode: number;
  /** The browser's own description of the error. */
  errorText: string;
}

/** The candidates and errors one peer connection has reported so far. */
export interface IceGatheringRecord {
  /** `turn:` / `turns:` urls the peer connection was configured with. */
  turnUrls: ReadonlyArray<string>;
  /** Whether any local relay candidate was gathered. */
  relayGathered: boolean;
  /** Whether gathering finished. */
  gatheringComplete: boolean;
  /** Errors against a configured relay url, at most {@link MAX_RECORDED_ICE_ERRORS}. */
  turnErrors: Array<IceServerError>;
}

/** How many relay errors one record keeps; a relay entry holds a few urls. */
export const MAX_RECORDED_ICE_ERRORS = 8;

/** How many relay servers one failure message names. */
const MAX_NAMED_SERVERS = 3;

/** Bound on the browser's error text as quoted in a failure message. */
const MAX_ERROR_TEXT_LENGTH = 200;

const records = new WeakMap<DataConnection, IceGatheringRecord>();

function isTurnUrl(url: string): boolean {
  return /^turns?:/i.test(url);
}

/** The `turn:` / `turns:` urls a peer connection's configuration names. */
function configuredTurnUrls(pc: RTCPeerConnection): Array<string> {
  if (typeof pc.getConfiguration !== "function") return [];
  const servers = pc.getConfiguration().iceServers ?? [];
  return servers
    .flatMap((server) =>
      typeof server.urls === "string" ? [server.urls] : server.urls,
    )
    .filter(isTurnUrl);
}

/**
 * Whether `url` names one of `turnUrls`: as configured, or with the
 * `?transport=` suffix Chromium appends when it reports an error. Anything
 * else is not recorded, so a failure message names only configured relays.
 */
function isConfiguredTurnUrl(
  url: string,
  turnUrls: ReadonlyArray<string>,
): boolean {
  return turnUrls.some(
    (turnUrl) =>
      url === turnUrl ||
      url === `${turnUrl}?transport=udp` ||
      url === `${turnUrl}?transport=tcp`,
  );
}

/**
 * Start recording what `conn`'s peer connection gathers. Idempotent, and a
 * no-op for a connection with no peer connection.
 */
export function watchIceGathering(conn: DataConnection): void {
  if (records.has(conn)) return;
  // PeerJS types the field as always present, but its cleanup nulls it.
  const pc = conn.peerConnection as RTCPeerConnection | null | undefined;
  if (pc === null || pc === undefined) return;
  const record: IceGatheringRecord = {
    turnUrls: configuredTurnUrls(pc),
    relayGathered: false,
    gatheringComplete: pc.iceGatheringState === "complete",
    turnErrors: [],
  };
  records.set(conn, record);
  pc.addEventListener("icecandidate", (event) => {
    const { candidate } = event;
    if (candidate === null) record.gatheringComplete = true;
    else if (candidate.type === "relay") record.relayGathered = true;
  });
  pc.addEventListener("icegatheringstatechange", () => {
    if (pc.iceGatheringState === "complete") record.gatheringComplete = true;
  });
  pc.addEventListener("icecandidateerror", (event) => {
    const { url, errorCode, errorText } = event;
    if (typeof url !== "string" || !isConfiguredTurnUrl(url, record.turnUrls))
      return;
    if (record.turnErrors.length >= MAX_RECORDED_ICE_ERRORS) return;
    record.turnErrors.push({
      url,
      errorCode: typeof errorCode === "number" ? errorCode : 0,
      errorText: typeof errorText === "string" ? errorText : "",
    });
  });
}

/** @internal */
export function iceGatheringRecordFor(
  conn: DataConnection,
): IceGatheringRecord | undefined {
  return records.get(conn);
}

function describeError(error: IceServerError): string {
  const text = error.errorText.trim().slice(0, MAX_ERROR_TEXT_LENGTH);
  return text === ""
    ? `${error.url} (error ${error.errorCode})`
    : `${error.url} (error ${error.errorCode}: ${text})`;
}

function listNamed(items: ReadonlyArray<string>): string {
  const named = items.slice(0, MAX_NAMED_SERVERS).join("; ");
  const rest = items.length - MAX_NAMED_SERVERS;
  return rest > 0 ? `${named}; and ${rest} more` : named;
}

const RELAY_REMEDY =
  "Check that the relay address is correct and that this network allows " +
  "connections to it, then try again.";

/**
 * The message for a channel that did not open because no configured relay
 * gave a relay candidate, or `undefined` where the record does not show that:
 * no relay is configured, or a relay candidate was gathered.
 *
 * A relay the browser reported no error for is named only when `timedOut`, or
 * when gathering finished: an open that failed early for another reason can
 * end before a working relay has answered. Chromium was measured taking about
 * 40 seconds to report an unanswered UDP relay, past the open timeout.
 *
 * The url and error text are raw here and escaped where the failure is shown.
 *
 * @internal
 */
export function relayFailureMessage(
  record: IceGatheringRecord,
  timedOut: boolean,
): string | undefined {
  if (record.turnUrls.length === 0 || record.relayGathered) return undefined;
  const lead = "The connection did not open: no relay candidate was gathered.";
  if (record.turnErrors.length > 0) {
    const failures = [
      ...new Map(
        record.turnErrors.map((error) => [error.url, describeError(error)]),
      ).values(),
    ];
    const subject =
      failures.length === 1
        ? `The browser reported an error for relay server ${failures[0]}.`
        : `The browser reported errors for relay servers ${listNamed(failures)}.`;
    return `${lead} ${subject} ${RELAY_REMEDY}`;
  }
  if (!timedOut && !record.gatheringComplete) return undefined;
  const servers = [...new Set(record.turnUrls)];
  const subject =
    servers.length === 1
      ? `Relay server ${servers[0]} did not give a relay address.`
      : `Relay servers ${listNamed(servers)} did not give a relay address.`;
  return `${lead} ${subject} ${RELAY_REMEDY}`;
}

/**
 * `failure` as the error an unopened `conn` rejects with: a `transport`
 * {@link ConnectionError} naming the failed relay where
 * {@link relayFailureMessage} finds one, and `failure` unchanged otherwise.
 * `timedOut` says the open ran out its time rather than failing early.
 * `failure` is not kept as a cause: a PeerJS negotiation error names the
 * remote rendezvous id, and the callers redact only the error they throw.
 */
export function withIceServerFailure(
  conn: DataConnection,
  failure: Error,
  timedOut: boolean,
): Error {
  const record = records.get(conn);
  const message =
    record === undefined ? undefined : relayFailureMessage(record, timedOut);
  if (message === undefined) return failure;
  return new ConnectionError(message, "transport");
}
