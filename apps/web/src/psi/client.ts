import Peer from "peerjs";

import { getLogger } from "@psilink/core";

import { ConfigManager } from "@utils/clientConfig";

import type { LinkSession } from "@utils/sessions";
import type { PeerOptions } from "peerjs";

const log = getLogger("client");

const configManager = new ConfigManager();
const config = await configManager.load();

/** Constructs a PeerJS {@link Peer}; injectable so the destroy-on-failure path
 * is unit-testable without a real broker connection. */
export type PeerFactory = (options: PeerOptions) => Peer;

const defaultPeerFactory: PeerFactory = (options) => new Peer(options);

/**
 * Connects to the peer server, obtains a peer id, posts it to the rendezvous
 * API, and resolves the {@link Peer} once the id is published.
 *
 * The constructed {@link Peer} only surfaces on success: any pre-resolve
 * failure - a pre-open `error`, or the post-open id-POST failing (a non-OK
 * response or a rejected fetch) - destroys it (freeing the broker id) before
 * rejecting, rather than leaving an open, broker-registered peer the caller
 * never receives. A `destroy()` is right here - no data channel has carried a
 * frame yet, so there is nothing to flush.
 *
 * @param session  The rendezvous session whose `uuid` the peer id is posted to.
 * @param options  `peerFactory` injects the {@link Peer} constructor for testing
 *                 the destroy-on-failure path without a real broker.
 */
export function createAndSharePeerId(
  session: LinkSession,
  options?: { peerFactory?: PeerFactory },
): Promise<Peer> {
  const makePeer = options?.peerFactory ?? defaultPeerFactory;

  return new Promise((resolve, reject) => {
    let host = window.location.hostname;
    if (host === "localhost") host = "127.0.0.1";
    log.info(`connecting to peer server at ${host} and getting peer id`);

    const port =
      parseInt(window.location.port) ||
      (window.location.protocol == "http" ? 80 : 443);

    const peer = makePeer({
      host: host,
      path: "/api/",
      port: port,
      debug: config.PEERJS_DEBUG_LEVEL,
      config: {
        iceServers: [
          {
            urls: ["stun:stun.l.google.com:19302", "stun:44.247.30.68:443"],
          },
          /* Explicitly disable TURN survers, since they relay data. This is
             mostly semantics since all data is relayed across servers on the
             Internet, but we should look into establishing our own TURN
             servers at some point.
           */
          /* {
            urls: [
              "turn:eu-0.turn.peerjs.com:3478",
              "turn:us-0.turn.peerjs.com:3478",
            ],
            username: "peerjs",
            credential: "peerjsp",
          },*/
        ],
        sdpSemantics: "unified-plan",
        iceTransportPolicy: "all",
      },
    });

    let settled = false;

    // Pre-resolve failure: this Peer never reached the caller, so destroy it
    // (freeing the broker id) before rejecting rather than leaking it.
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      peer.destroy();
      reject(err);
    };

    peer.once("open", (id: string) => {
      log.info(`got peer id ${id} from peer server; posting to server`);

      fetch(`/api/psi/${session.uuid}`, {
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
        body: JSON.stringify({
          invitedPeerId: id,
        }),
      })
        .then((response) => {
          if (!response.ok) {
            log.error(
              `error posting peer id: ${response.status}, text: ${response.statusText}`,
            );
            fail(
              new Error(
                `error posting peer id: ${response.status}, text: ${response.statusText}`,
              ),
            );
          } else if (!settled) {
            settled = true;
            resolve(peer);
          }
        })
        .catch((err: unknown) => {
          log.error("error posting peer id:", err);
          fail(err instanceof Error ? err : new Error(String(err)));
        });
    });

    peer.on("error", (err: Error) => {
      log.error("error getting peer connection:", err);
      fail(err);
    });
  });
}
