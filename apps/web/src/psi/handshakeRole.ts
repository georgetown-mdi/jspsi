import type { HandshakeRole, RendezvousRole } from "@psilink/core";

/**
 * The key-exchange handshake role each rendezvous side takes: the acceptor dials
 * the data channel and sends the first handshake message, so it is the
 * initiator; the inviter listens and answers, so it is the responder.
 *
 * One table for every web exchange flow -- the one-shot inviter, the one-shot
 * acceptor, and the managed re-run -- because the pairing is a cross-application
 * contract, not a per-flow choice. A CLI peer maps its own configured role the
 * same way (`webRtcDialFrom` in apps/cli/src/protocol.ts), and two peers that
 * resolve the same side to different roles never complete a handshake: both
 * initiators reject each other's second message, both responders deadlock on
 * receive. The interop conformance vectors
 * (packages/core/test/vectors/webrtc-interop-vectors.json) pin these values.
 *
 * Keyed by core's {@link RendezvousRole} -- the same vocabulary the derived
 * rendezvous peer ids use -- so the side that names an id and the side that
 * names a handshake role cannot be spelled differently.
 */
export const HANDSHAKE_ROLE_FOR_SIDE: Readonly<
  Record<RendezvousRole, HandshakeRole>
> = Object.freeze({
  inviter: "responder",
  acceptor: "initiator",
});
