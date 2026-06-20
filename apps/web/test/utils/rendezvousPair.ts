import Peer from "peerjs";

import { deriveRendezvousPeerId } from "@psilink/core";

import type { DataConnection } from "peerjs";

/** The two connected peers and their open data channels from a backend-free
 * rendezvous: the inviter is the PSI responder (it listens), the acceptor the
 * PSI initiator (it dials). Each side holds its own `Peer` and its own view of
 * the `DataConnection`. */
export interface RendezvousPair {
  inviterPeer: Peer;
  acceptorPeer: Peer;
  /** The responder's (inviter's) view of the open connection. */
  inviterConn: DataConnection;
  /** The initiator's (acceptor's) view of the open connection. */
  acceptorConn: DataConnection;
}

/** Where the PeerJS coordination server lives. */
export interface BrokerAddress {
  address: string;
  port: number;
}

/** Resolve once `peer` has registered with the broker (its `open` event).
 * Settles exactly once and detaches both listeners, so an `open` and an `error`
 * firing in the same tick cannot both resolve and reject the promise. */
function peerOpened(peer: Peer): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      peer.off("open", onOpen);
      peer.off("error", onError);
      action();
    };
    const onOpen = () => settle(resolve);
    const onError = (err: unknown) =>
      settle(() => reject(err instanceof Error ? err : new Error(String(err))));
    peer.once("open", onOpen);
    peer.once("error", onError);
  });
}

/**
 * Stand up the backend-free rendezvous both `invitedPSI` and production use: a
 * fresh shared secret stands in for the invitation, and both peer ids are
 * derived from it -- no `/api/psi/*` session. The inviter (PSI responder) listens
 * on its derived id; the acceptor (PSI initiator) dials it. Resolves once both
 * `DataConnection`s are open.
 *
 * Hermetic ICE: both peers run in one browser on one machine, so a loopback host
 * candidate is all they need. Configure no STUN/TURN, so the exchange contacts no
 * external server (PeerJS's default config would otherwise reach public Google
 * STUN). This makes the loopback host candidate the only one available, which is
 * exactly why the browser project disables Chromium's mDNS host-candidate
 * obfuscation (see vite.config.ts); without that the candidate is an unresolvable
 * `.local` name and the connection cannot open. Production configures real STUN
 * for cross-network peers (src/psi/rendezvous.ts).
 */
export async function connectRendezvousPair(
  sharedSecret: string,
  broker: BrokerAddress,
): Promise<RendezvousPair> {
  const inviterId = await deriveRendezvousPeerId(sharedSecret, "inviter");
  const acceptorId = await deriveRendezvousPeerId(sharedSecret, "acceptor");

  const peerOptions = {
    host: broker.address,
    path: "/api/",
    port: broker.port,
    config: { iceServers: [] },
  };

  const inviterPeer = new Peer(inviterId, peerOptions);
  await peerOpened(inviterPeer);

  // Listen for the acceptor's inbound connection before it dials. Settles once
  // and detaches both listeners, so a late post-open peer error cannot reject
  // after the promise has resolved (which would leak into the runner).
  const inviterConnPromise: Promise<DataConnection> = new Promise(
    (resolve, reject) => {
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        inviterPeer.off("connection", onConnection);
        inviterPeer.off("error", onError);
        action();
      };
      const onConnection = (conn: DataConnection) =>
        conn.once("open", () => settle(() => resolve(conn)));
      const onError = (err: unknown) =>
        settle(() =>
          reject(err instanceof Error ? err : new Error(String(err))),
        );
      inviterPeer.on("connection", onConnection);
      inviterPeer.on("error", onError);
    },
  );

  // Acceptor dials the inviter's derived id directly (the inviter is already
  // listening, so there is no peer-unavailable retry to exercise here).
  const acceptorPeer = new Peer(acceptorId, peerOptions);
  const acceptorConn: DataConnection = await new Promise<DataConnection>(
    (resolve, reject) => {
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        acceptorPeer.off("open", onOpen);
        acceptorPeer.off("error", onError);
        action();
      };
      const onOpen = () => {
        const conn = acceptorPeer.connect(inviterId, { reliable: true });
        conn.once("open", () => settle(() => resolve(conn)));
      };
      const onError = (err: unknown) =>
        settle(() =>
          reject(err instanceof Error ? err : new Error(String(err))),
        );
      acceptorPeer.on("open", onOpen);
      acceptorPeer.on("error", onError);
    },
  );

  const inviterConn = await inviterConnPromise;

  return { inviterPeer, acceptorPeer, inviterConn, acceptorConn };
}
