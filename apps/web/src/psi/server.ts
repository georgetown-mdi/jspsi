import Peer from "peerjs";

import { getLogger } from "@psilink/core";

import { ConfigManager } from "@utils/clientConfig";

import { DEFAULT_PEER_WAIT_TIMEOUT_MS } from "./waitForConnection";

import type { DataConnection, PeerOptions } from "peerjs";

const log = getLogger("server");

const configManager = new ConfigManager();
const config = await configManager.load();

/** WHATWG `EventSource.CLOSED`, inlined so this module does not depend on the
 * `EventSource` global (absent under the node unit environment, which injects a
 * fake via the factory). */
const EVENT_SOURCE_CLOSED = 2;

/** Constructs a PeerJS `EventSource`; injectable so the timeout/abort path is
 * unit-testable under `environment: "node"`, where there is no reliable global. */
export type EventSourceFactory = (
  url: string,
  init?: EventSourceInit,
) => EventSource;

/** Constructs a PeerJS {@link Peer}; injectable so the destroy-on-failure path
 * is unit-testable without a real broker connection. */
export type PeerFactory = (options: PeerOptions) => Peer;

const defaultEventSourceFactory: EventSourceFactory = (url, init) =>
  new EventSource(url, init);

const defaultPeerFactory: PeerFactory = (options) => new Peer(options);

/**
 * Waits, via the server-sent-events `/wait` stream, for the invited peer to
 * publish its peer id, resolving with that id.
 *
 * The wait is bounded so an operator who never shows up surfaces an error
 * rather than hanging the page. A settle-once guard makes the first of
 * {peer id, `{error}` frame, `CLOSED` stream, timeout, abort} win: it closes
 * the `EventSource`, clears the timer, and detaches the abort listener exactly
 * once, then settles. This is the helper's own guarantee, independent of any
 * caller's teardown latch, so cleanup still runs exactly once even when the
 * timer and an abort fire in the same tick.
 *
 * A transient network `error` is tolerated: `EventSource` auto-reconnects
 * (`readyState === CONNECTING`) and the `/wait` handler re-polls the persisted
 * session on the fresh request, so only a `CLOSED` stream (or the bound
 * timeout) is fatal. The application-level `{error}` frame the handler pushes on
 * session-TTL expiry is recognized explicitly and rejected as "session
 * expired", distinct from the generic unexpected-message path.
 *
 * @param uuid     The rendezvous session id.
 * @param options  `timeoutMs` overrides the {@link DEFAULT_PEER_WAIT_TIMEOUT_MS}
 *                 bound; `signal` lets the owner cancel the wait and close the
 *                 stream promptly on unmount; `eventSourceFactory` injects the
 *                 `EventSource` constructor for testing.
 */
export function waitForPeerId(
  uuid: string,
  options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
    eventSourceFactory?: EventSourceFactory;
  },
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_PEER_WAIT_TIMEOUT_MS;
  const signal = options?.signal;
  const makeEventSource =
    options?.eventSourceFactory ?? defaultEventSourceFactory;

  return new Promise<string>((resolve, reject) => {
    log.info(`opening event source at: /api/psi/${uuid}/wait`);
    const eventSource = makeEventSource(`/api/psi/${uuid}/wait`, {
      withCredentials: true,
    });

    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      eventSource.close();
      action();
    };

    const onAbort = () =>
      settle(() => reject(new Error("waiting for the peer id was aborted")));

    const timer = setTimeout(
      () =>
        settle(() =>
          reject(new Error("timed out waiting for the other party to connect")),
        ),
      timeoutMs,
    );

    eventSource.addEventListener("message", (event) => {
      let messageData: unknown;
      try {
        messageData = event.data ? JSON.parse(event.data) : undefined;
      } catch (err) {
        log.error("error parsing message:", err);
        settle(() =>
          reject(err instanceof Error ? err : new Error(String(err))),
        );
        return;
      }

      const record =
        typeof messageData === "object" && messageData !== null
          ? (messageData as Record<string, unknown>)
          : undefined;

      if (record && "invitedPeerId" in record) {
        const invitedPeerId = String(record["invitedPeerId"]);
        log.info(`received peer id ${invitedPeerId}`);
        settle(() => resolve(invitedPeerId));
      } else if (record && "error" in record) {
        // Application-level TTL-expiry frame: the session record is gone, so
        // continuing to wait is pointless. Fatal, but recognized explicitly so
        // the operator sees a clear cause rather than the generic path.
        log.error("session expired while waiting for peer:", record["error"]);
        settle(() =>
          reject(new Error("session expired: " + String(record["error"]))),
        );
      } else {
        log.error("received unexpected message from server:", messageData);
        settle(() =>
          reject(new Error("unexpected message from server: " + event.data)),
        );
      }
    });

    eventSource.addEventListener("error", () => {
      // EventSource auto-reconnects on a transient drop (readyState CONNECTING),
      // and the /wait handler re-polls the session on the reissued request; only
      // a CLOSED stream is fatal. Collapsing the reconnect into a reject would
      // kill a multi-minute human-timescale wait on a brief network blip.
      if (eventSource.readyState === EVENT_SOURCE_CLOSED) {
        log.error("EventSource closed while waiting for peer");
        settle(() => reject(new Error("event source connection closed")));
      }
    });

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort);
  });
}

/**
 * Connects to the peer server, obtains a local peer id, and dials `peerId`,
 * resolving `[peer, conn]` once this side is registered with the broker. The
 * returned `DataConnection` is not necessarily open yet; the caller bounds the
 * channel-open handshake separately.
 *
 * The constructed {@link Peer} only surfaces on success: a pre-resolve `error`
 * destroys it (freeing the broker id) before rejecting, rather than leaking a
 * registered peer the caller never receives. A `destroy()` is right here - no
 * data channel has carried a frame yet, so there is nothing to flush.
 *
 * @param peerId   The invited peer's id to dial.
 * @param options  `peerFactory` injects the {@link Peer} constructor for testing
 *                 the destroy-on-failure path without a real broker.
 */
export function openPeerConnection(
  peerId: string,
  options?: { peerFactory?: PeerFactory },
): Promise<[Peer, DataConnection]> {
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
          },
          */
        ],
        sdpSemantics: "unified-plan",
        iceTransportPolicy: "all",
      },
    });

    let settled = false;

    peer.once("open", (id) => {
      if (settled) return;
      settled = true;
      log.info(
        `got peer id ${id} from peer server; connecting to peer ${peerId}`,
      );
      const conn = peer.connect(peerId, { reliable: true });
      resolve([peer, conn]);
    });

    peer.on("error", (err) => {
      if (settled) return;
      settled = true;
      log.error("error getting peer connection:", err);
      // Pre-resolve failure: this Peer never reached the caller, so destroy it
      // (freeing the broker id) before rejecting rather than leaking it.
      peer.destroy();
      reject(err);
    });
  });
}
