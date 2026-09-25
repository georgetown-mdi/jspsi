/**
 * The side-dispatched rendezvous for a managed (recurring) exchange re-run: the
 * record's local `side` field selects which flow runs -- `listenAsInviter` (the
 * inviter listens on its derived id) or `dialAsAcceptor` (the acceptor dials the
 * inviter's derived id) -- and the record's CURRENT `sharedSecret` is passed in,
 * so each flow derives its rendezvous peer id fresh from that secret under the
 * side-selected label (`deriveRendezvousPeerId` inside each). Nothing derived is
 * read from storage: passing the current secret is what makes "derived fresh,
 * never stored" hold by construction (see docs/spec/MANAGED_EXCHANGE_RECORD.md,
 * "Derived, never stored").
 *
 * The dispatch is on the local `side` field, never the document's
 * `connection.role`, and the document's `server` locator is likewise INERT on
 * the re-run path: the connection block is persisted for document fidelity, not
 * read (see docs/spec/MANAGED_EXCHANGE_RECORD.md, "Role: a local `side` field").
 * Both sides derive their signaling location from the app's own location -- the
 * inviter inside `listenAsInviter` (from `window.location`), the acceptor's dial
 * endpoint here from the same {@link webrtcEndpointFromLocation} the inviter-side
 * mint uses. Origin isolation makes this airtight: a record exists only at the
 * origin it was deposited at, so the app's own location is always the correct
 * signaling source -- it cannot go stale against a redeployment and cannot be
 * poisoned at rest. The stored connection block is read for two things: its
 * `channel` discriminant, to reject a non-webrtc record as not re-runnable in
 * the browser before any connection, and the `invitationRelay` an acceptor's
 * record keeps from the invitation it accepted.
 *
 * The two rendezvous functions are injected (defaulting to the real
 * {@link listenAsInviter} / {@link dialAsAcceptor}) so the dispatch and the
 * per-run peer-id derivation are unit-testable without a real broker.
 */

import {
  BROKER_REGISTRATION_TIMEOUT_MS,
  dialAsAcceptor,
  listenAsInviter,
} from "../transport/rendezvous";
import { invitationLocation } from "../invitationLocation";
import { relayForRun } from "../transport/ownRelaySetting";
import { webrtcEndpointFromLocation } from "../invitation";

import type { DataConnection } from "peerjs";
import type { ExchangeSpec } from "@alcove/core";
import type Peer from "peerjs";

import type { ManagedExchangeSide } from "./managedExchangeRecord";

/** The two rendezvous flows the re-run dispatches between, injectable so the
 * side dispatch and the per-run peer-id derivation are testable without a broker.
 * The defaults are the real {@link listenAsInviter} / {@link dialAsAcceptor}. */
export interface ManagedRendezvousFlows {
  listenAsInviter: typeof listenAsInviter;
  dialAsAcceptor: typeof dialAsAcceptor;
}

const defaultFlows: ManagedRendezvousFlows = {
  listenAsInviter,
  dialAsAcceptor,
};

/**
 * Reject a stored record whose exchange is not the webrtc channel: only a webrtc
 * exchange is coordinated live from the browser, so any other channel cannot
 * re-run here and fails before any connection. This dispatchability check reads
 * only the connection's `channel` discriminant -- the `server` locator fields
 * stay inert per the spec (persisted for document fidelity, not read).
 */
export function assertManagedRerunDispatchable(
  exchangeFile: ExchangeSpec,
): void {
  const channel = exchangeFile.connection.channel;
  if (channel !== "webrtc")
    throw new Error(
      "managed re-run requires a webrtc exchange; stored connection channel is " +
        channel,
    );
}

/**
 * Acquired rendezvous, discriminated by side: the inviter returns its registered
 * peer with no channel yet (the caller awaits the acceptor's inbound connection);
 * the acceptor returns both the peer and the opened channel.
 */
type ManagedRendezvousAcquisition =
  | { side: "inviter"; peer: Peer }
  | { side: "acceptor"; peer: Peer; conn: DataConnection };

/**
 * Begin the side-dispatched rendezvous. Returns the inviter's registered peer
 * (the caller awaits the inbound channel) or the acceptor's opened `[peer, conn]`
 * pair. The `sharedSecret` is the record's CURRENT secret, so the derived
 * rendezvous id is fresh for this run. `exchangeFile` is read only for the
 * webrtc-channel dispatchability check ({@link assertManagedRerunDispatchable});
 * the acceptor's dial endpoint comes from the app's own location, never the
 * stored locator. `signal` cancels the listen/dial; `flows` injects the
 * rendezvous functions for tests.
 *
 * `peerWaitTimeoutMs` overrides the ACCEPTOR's no-show budget: how long its dial
 * keeps retrying an inviter that has not registered. The inviter half of the
 * same budget is not this function's -- it returns its registered peer before
 * the inbound wait begins, and the caller bounds that wait itself (see
 * {@link ./managedRunDriver.ts}). It also caps both sides' broker registration
 * at the smaller of itself and {@link BROKER_REGISTRATION_TIMEOUT_MS}, so a
 * scheduled attempt near its window's close cannot sit on a silent signaling
 * server past that close. Absent, both flows keep their shared defaults.
 *
 * Both flows gather against the relay {@link relayForRun} selects from the
 * stored connection's `invitationRelay` and this browser's own setting, read at
 * the start of each run.
 */
export async function beginManagedRendezvous(
  side: ManagedExchangeSide,
  sharedSecret: string,
  exchangeFile: ExchangeSpec,
  options: {
    signal?: AbortSignal;
    flows?: ManagedRendezvousFlows;
    peerWaitTimeoutMs?: number;
  } = {},
): Promise<ManagedRendezvousAcquisition> {
  const flows = options.flows ?? defaultFlows;
  const signal = options.signal;
  assertManagedRerunDispatchable(exchangeFile);
  const connection = exchangeFile.connection;
  const relay = relayForRun(
    connection.channel === "webrtc" ? connection.invitationRelay : undefined,
  );
  const peerWaitTimeoutMs = options.peerWaitTimeoutMs;
  const registrationBound =
    peerWaitTimeoutMs !== undefined
      ? {
          registrationTimeoutMs: Math.min(
            BROKER_REGISTRATION_TIMEOUT_MS,
            peerWaitTimeoutMs,
          ),
        }
      : {};
  if (side === "inviter") {
    const peer = await flows.listenAsInviter(sharedSecret, {
      signal,
      relay,
      ...registrationBound,
    });
    return { side: "inviter", peer };
  }
  const endpoint = webrtcEndpointFromLocation(invitationLocation());
  const [peer, conn] = await flows.dialAsAcceptor(sharedSecret, endpoint, {
    signal,
    relay,
    ...registrationBound,
    ...(peerWaitTimeoutMs !== undefined
      ? { totalTimeoutMs: peerWaitTimeoutMs }
      : {}),
  });
  return { side: "acceptor", peer, conn };
}
