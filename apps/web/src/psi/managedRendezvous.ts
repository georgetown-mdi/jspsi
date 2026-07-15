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
 * `connection.role`: the document is persisted verbatim for fidelity and nothing
 * reads its role (see docs/spec/MANAGED_EXCHANGE_RECORD.md, "Role: a local `side`
 * field"). The acceptor's dial target is the document's persisted webrtc
 * connection block -- the endpoint the invitation carried at accept time, kept in
 * the document -- reshaped back to a {@link WebRTCEndpoint}; the inviter needs no
 * endpoint (it derives its signaling location from `window.location` inside
 * `listenAsInviter`).
 *
 * The two rendezvous functions are injected (defaulting to the real
 * {@link listenAsInviter} / {@link dialAsAcceptor}) so the dispatch and the
 * per-run peer-id derivation are unit-testable without a real broker.
 */

import { dialAsAcceptor, listenAsInviter } from "./rendezvous";

import type { ExchangeSpec, WebRTCEndpoint } from "@psilink/core";
import type { DataConnection } from "peerjs";
import type Peer from "peerjs";

import type { ManagedExchangeSide } from "./managedExchangeRecord";

/** The live rendezvous resources a re-run acquires: the registered peer and the
 * open data channel, the same pair the one-shot flows hand to the exchange
 * lifecycle. */
export interface ManagedRendezvous {
  peer: Peer;
  conn: DataConnection;
}

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
 * Reshape the record's persisted webrtc connection block back into the
 * {@link WebRTCEndpoint} the acceptor dials. The persisted block is credential-
 * free by composition (`server.host`/`port`/`path` only; see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, "The connection block"), so this only
 * re-shapes it, dropping an absent optional rather than carrying an explicit
 * `undefined`. Throws when the connection is not the webrtc channel: only a
 * webrtc exchange is coordinated live, so a stored record whose channel is
 * anything else cannot re-run in the browser and fails before any connection.
 */
export function acceptorEndpointFromRecord(
  exchangeFile: ExchangeSpec,
): WebRTCEndpoint {
  const connection = exchangeFile.connection;
  if (connection.channel !== "webrtc")
    throw new Error(
      "managed re-run requires a webrtc exchange; stored connection channel is " +
        connection.channel,
    );
  const { server } = connection;
  return {
    channel: "webrtc",
    host: server.host,
    ...(server.port !== undefined ? { port: server.port } : {}),
    ...(server.path !== undefined ? { path: server.path } : {}),
  };
}

/**
 * Acquire the rendezvous for a re-run, dispatched on the record's local `side`:
 * the inviter listens on its derived id ({@link listenAsInviter}); the acceptor
 * dials the inviter's derived id at the persisted endpoint
 * ({@link dialAsAcceptor}). The current `sharedSecret` is passed to whichever
 * flow runs, so its peer id derives fresh from that secret under the side's label
 * -- no derived value is read from storage.
 *
 * The inviter returns its registered peer with no channel yet (the caller then
 * awaits the acceptor's inbound connection); the acceptor returns both the peer
 * and the opened channel. So both cases resolve to `{ peer, conn }` only after
 * the caller has the inbound side, this returns the peer for the inviter and the
 * pair for the acceptor through the discriminated result below.
 */
export type ManagedRendezvousAcquisition =
  | { side: "inviter"; peer: Peer }
  | { side: "acceptor"; peer: Peer; conn: DataConnection };

/**
 * Begin the side-dispatched rendezvous. Returns the inviter's registered peer
 * (the caller awaits the inbound channel) or the acceptor's opened `[peer, conn]`
 * pair. The `sharedSecret` is the record's CURRENT secret, so the derived
 * rendezvous id is fresh for this run; `exchangeFile` supplies the acceptor's
 * dial endpoint. `signal` cancels the listen/dial; `flows` injects the rendezvous
 * functions for tests.
 */
export async function beginManagedRendezvous(
  side: ManagedExchangeSide,
  sharedSecret: string,
  exchangeFile: ExchangeSpec,
  options: { signal?: AbortSignal; flows?: ManagedRendezvousFlows } = {},
): Promise<ManagedRendezvousAcquisition> {
  const flows = options.flows ?? defaultFlows;
  const signal = options.signal;
  if (side === "inviter") {
    const peer = await flows.listenAsInviter(sharedSecret, { signal });
    return { side: "inviter", peer };
  }
  const endpoint = acceptorEndpointFromRecord(exchangeFile);
  const [peer, conn] = await flows.dialAsAcceptor(sharedSecret, endpoint, {
    signal,
  });
  return { side: "acceptor", peer, conn };
}
