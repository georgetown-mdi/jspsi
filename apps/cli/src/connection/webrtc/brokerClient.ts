import { randomBytes } from "node:crypto";

import { ConnectionError, parseBoundedJson } from "@psilink/core";

/**
 * The PeerJS broker signaling client, written against the broker's WebSocket
 * wire rather than by running PeerJS in Node (docs/notes/cli-webrtc-stack.md).
 * It carries the OFFER/ANSWER/CANDIDATE exchange that gets two peers to a data
 * channel and nothing else; the negotiation that consumes those messages lives
 * in `weriftPeer.ts`.
 *
 * Every wire fact below was measured against the vendored PeerServer this repo
 * ships, driven as a real process (test/signaling/), not modelled from its
 * source. What the run established, and what the client is therefore built to:
 *
 * - The socket is `<ws|wss>://<host>:<port><path>/peerjs?key=&id=&token=&version=`,
 *   and registration is confirmed by an unsolicited `{"type":"OPEN"}`.
 * - The server stamps `src` from the connecting socket's id, so an outbound frame
 *   carries only `type`, `payload` and `dst`; an inbound one adds `src`.
 * - A second socket claiming a registered id is answered `ID-TAKEN` and closed.
 *   That is the signal a symmetric role misconfiguration produces, and it is
 *   mapped to an error naming that cause rather than left to become a timeout.
 * - A wrong `key` is answered `ERROR` with an "Invalid key provided" payload and
 *   closed.
 * - A message addressed to an id that is not registered is NOT delivered when
 *   that peer registers later, and no `EXPIRE` comes back. So an offer to a peer
 *   that has not arrived yet is simply lost, which is why the dialer in
 *   `weriftPeer.ts` re-sends rather than waiting on a signal.
 * - A registered socket that sends nothing is closed by the broker's reaper
 *   about twenty seconds in; any traffic, heartbeat or not, resets that. Hence
 *   {@link BROKER_HEARTBEAT_INTERVAL_MS}, which is also the cadence the web
 *   app's PeerJS client is pinned to.
 *
 * Peer-id hygiene: the ids this client registers and dials are derived from the
 * invitation secret, so they correlate exchanges. The web app redacts them out
 * of PeerJS's own output after the fact; this client instead never puts one into
 * a message, an error or a log line in the first place -- including the socket
 * URL, which carries the id in its query string. test/unit/webrtcBrokerClient.test.ts
 * holds that as a check rather than leaving it to prose.
 */

/** The `version` the client reports, matching the pinned browser `peerjs`. */
export const PEERJS_CLIENT_VERSION = "1.5.5";

/**
 * Heartbeat cadence, matching `PEER_PING_INTERVAL_MS` in the web app's
 * rendezvous. The broker's "unconfirmed" reap window is justified as a multiple
 * of this cadence, so a client that beats slower than the web's PeerJS client
 * would be cut by a broker tuned for it.
 */
export const BROKER_HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * Longest a registration may take before it is abandoned. Generous for a
 * cross-Internet TLS handshake to a signaling server, short enough that an
 * unattended run does not sit on an unreachable host for the whole exchange
 * budget.
 */
export const BROKER_OPEN_TIMEOUT_MS = 30_000;

/**
 * Largest inbound signaling frame accepted, before it is parsed. A signaling
 * frame is an SDP or a single ICE candidate -- kilobytes, even with every
 * interface's candidates inlined -- so this is orders of magnitude of headroom
 * and cannot reject a real one.
 *
 * Its limit, stated rather than glossed: Node's built-in `WebSocket` exposes no
 * per-socket maximum payload, so the frame has already been read into memory by
 * the time this refuses it. The cap bounds what is PARSED (where a pathological
 * body would cost far more than its wire size), not what a hostile signaling
 * server can make the socket allocate once.
 */
export const MAX_SIGNALING_FRAME_BYTES = 256 * 1024;

/** Where a broker lives, in the pieces the connection URL is built from. */
export interface BrokerLocation {
  host: string;
  port: number;
  /** URL path the broker is mounted at; `/` when the deployment uses the root. */
  path: string;
  /** PeerJS API key. The vendored broker's default is `peerjs`. */
  key: string;
  /** `wss:` when set, `ws:` otherwise. */
  secure: boolean;
}

/** A signaling frame, in the shape both directions put on the wire. */
export interface BrokerMessage {
  type: string;
  /** Stamped by the server on an inbound frame; never sent. */
  src?: string;
  dst?: string;
  payload?: unknown;
}

/** The broker message types this client acts on. */
export const BROKER_MESSAGE = {
  open: "OPEN",
  heartbeat: "HEARTBEAT",
  offer: "OFFER",
  answer: "ANSWER",
  candidate: "CANDIDATE",
  leave: "LEAVE",
  expire: "EXPIRE",
  error: "ERROR",
  idTaken: "ID-TAKEN",
  invalidKey: "INVALID-KEY",
} as const;

/** Callbacks the owner installs before {@link connectToBroker} resolves. */
export interface BrokerHandlers {
  /** One inbound signaling frame, already parsed and bounded. */
  onMessage: (message: BrokerMessage) => void;
  /**
   * The socket ended for a reason the caller did not ask for: a broker refusal,
   * a bound breach, or a drop. A local {@link BrokerClient.close} does not reach
   * here -- the caller already knows it closed, and routing it here would make
   * every consumer distinguish its own teardown from a failure.
   */
  onClose: (error: ConnectionError) => void;
}

/** A registered broker socket. */
export interface BrokerClient {
  /** The id this socket is registered under, for the caller's own bookkeeping. */
  readonly localId: string;
  /** Send one signaling frame. A no-op once the socket has ended. */
  send: (message: { type: string; dst?: string; payload?: unknown }) => void;
  /** Deregister and close. Idempotent; never reports through `onClose`. */
  close: () => void;
}

export interface BrokerConnectOptions {
  location: BrokerLocation;
  /** The derived rendezvous id to register under. */
  id: string;
  handlers: BrokerHandlers;
  openTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  /** Cancels a registration in flight. */
  signal?: AbortSignal;
  /**
   * Constructs the socket; injected so the unit tests drive the client's whole
   * state machine without a broker. Defaults to the global `WebSocket`, which
   * Node has supplied since v22.
   */
  socketFactory?: (url: string) => WebSocket;
}

/**
 * The error a symmetric role misconfiguration produces. The broker cannot see
 * the mistake -- from its side a second socket simply claimed a live id -- so
 * naming the likely cause is this client's job. Without it the operator sees
 * only a dropped socket and, on the other side, a dial that never completes.
 */
function idTakenError(): ConnectionError {
  return new ConnectionError(
    "the signaling server reports this peer id is already registered. The " +
      "usual cause is both parties running the same connection role: one side " +
      "must be the inviter and the other the acceptor, and the two derive the " +
      "same pair of rendezvous ids from the shared secret. Check the `role` " +
      "field on each party's webrtc connection.",
    "usage",
  );
}

/** Build the registration URL. Never logged or interpolated: it carries the id. */
function brokerUrl(
  location: BrokerLocation,
  id: string,
  token: string,
): string {
  const scheme = location.secure ? "wss" : "ws";
  // A path of "/" must not produce "//peerjs"; anything else keeps its shape and
  // gains exactly one separator.
  const base = location.path.endsWith("/")
    ? location.path.slice(0, -1)
    : location.path;
  const query = new URLSearchParams({
    key: location.key,
    id,
    token,
    version: PEERJS_CLIENT_VERSION,
  });
  return `${scheme}://${location.host}:${location.port}${base}/peerjs?${query.toString()}`;
}

/**
 * A fresh per-registration token. PeerJS's own token is a short
 * `Math.random()` string; this uses the CSPRNG because the token is what
 * distinguishes a genuine id collision (two parties, two tokens -> `ID-TAKEN`,
 * which is the misconfiguration signal) from a reconnect of the same client
 * (same id, same token -> the broker adopts the socket silently and sends no
 * `OPEN`, which would strand the registration). Guessing another party's token
 * must not be a way to reach that second branch.
 */
function registrationToken(): string {
  return randomBytes(16).toString("hex");
}

/** Read one inbound frame: byte-capped, structurally bounded, shape-checked. */
function parseSignalingFrame(raw: unknown): BrokerMessage | undefined {
  const text = typeof raw === "string" ? raw : undefined;
  if (text === undefined) return undefined;
  // The cap is on UTF-16 units rather than encoded bytes: it is a memory bound,
  // and a unit is the unit the string already occupies.
  if (text.length > MAX_SIGNALING_FRAME_BYTES) {
    throw new ConnectionError(
      `the signaling server sent a frame larger than the ` +
        `${MAX_SIGNALING_FRAME_BYTES}-byte limit`,
      "protocol",
    );
  }
  let parsed: unknown;
  try {
    parsed = parseBoundedJson(text);
  } catch {
    // The parser's own error can echo a span of the body, which is server- and
    // peer-controlled; replace it rather than wrap it.
    throw new ConnectionError(
      "the signaling server sent a frame that is not valid JSON",
      "protocol",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return undefined;
  const message = parsed as Record<string, unknown>;
  if (typeof message.type !== "string") return undefined;
  return {
    type: message.type,
    src: typeof message.src === "string" ? message.src : undefined,
    dst: typeof message.dst === "string" ? message.dst : undefined,
    payload: message.payload,
  };
}

/** The error a rejected API key produces, whichever way the broker signals it. */
function invalidKeyError(): ConnectionError {
  return new ConnectionError(
    "the signaling server rejected the configured API key; check the `key` " +
      "field on the webrtc connection's server block",
    "usage",
  );
}

/**
 * Does a generic `ERROR` payload carry the broker's invalid-key wording?
 *
 * PeerJS defines an `INVALID-KEY` message type, but the vendored broker answers
 * a wrong key with a plain `ERROR` whose payload reads "Invalid key provided"
 * (measured; pinned by test/integration/webrtcBroker.test.ts against the real
 * server). Recognising it is what turns the commonest signaling misconfiguration
 * from an opaque disconnect into a fix. The match is on a lowercased substring
 * so a wording tweak degrades to the generic error rather than breaking, and the
 * server's text is never echoed -- only consulted.
 */
function isInvalidKeyPayload(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const message = (payload as { msg?: unknown }).msg;
  return (
    typeof message === "string" && message.toLowerCase().includes("invalid key")
  );
}

/**
 * Map a terminal broker message to the error the caller fails on. Returns
 * `undefined` for a message the caller handles itself (an OFFER, say).
 */
function terminalErrorFor(message: BrokerMessage): ConnectionError | undefined {
  switch (message.type) {
    case BROKER_MESSAGE.idTaken:
      return idTakenError();
    case BROKER_MESSAGE.invalidKey:
      return invalidKeyError();
    case BROKER_MESSAGE.error:
      // The payload is server-authored free text. Beyond the one shape above it
      // is not interpolated: the broker's wording adds nothing an operator can
      // act on, and echoing it would put unbounded server-controlled bytes into
      // an error message.
      return isInvalidKeyPayload(message.payload)
        ? invalidKeyError()
        : new ConnectionError(
            "the signaling server reported an error and closed the connection",
            "transport",
          );
    default:
      return undefined;
  }
}

/**
 * Register with the broker under `id`, resolving once the server confirms with
 * `OPEN`. A pre-open failure closes the socket before rejecting, so a rejected
 * registration never leaves a socket (or a claimed id) behind.
 *
 * After it resolves, every inbound frame reaches `handlers.onMessage` and the
 * socket ending reaches `handlers.onClose`. A frame that breaches a bound, and a
 * terminal broker message, both close the socket and report through `onClose`;
 * the handlers are the only path, so nothing arrives after a close.
 */
export function connectToBroker(
  options: BrokerConnectOptions,
): Promise<BrokerClient> {
  const {
    location,
    id,
    handlers,
    openTimeoutMs = BROKER_OPEN_TIMEOUT_MS,
    heartbeatIntervalMs = BROKER_HEARTBEAT_INTERVAL_MS,
    signal,
    socketFactory,
  } = options;

  return new Promise<BrokerClient>((resolve, reject) => {
    const socket = (socketFactory ?? ((url) => new WebSocket(url)))(
      brokerUrl(location, id, registrationToken()),
    );
    // Registration and steady state are one socket with two phases; `opened`
    // switches which of the two settlement paths a failure takes, so a failure
    // can never both reject the registration and report through onClose.
    let opened = false;
    let ended = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let openTimer: ReturnType<typeof setTimeout> | undefined;

    const detach = (): void => {
      socket.removeEventListener("open", onSocketOpen);
      socket.removeEventListener("message", onSocketMessage);
      socket.removeEventListener("error", onSocketError);
      socket.removeEventListener("close", onSocketClose);
      signal?.removeEventListener("abort", onAbort);
      if (heartbeat !== undefined) clearInterval(heartbeat);
      if (openTimer !== undefined) clearTimeout(openTimer);
      heartbeat = undefined;
      openTimer = undefined;
    };

    // Every terminal path funnels here so teardown runs exactly once and the
    // outcome lands on exactly one of the three settlement paths: a rejected
    // registration, a reported failure, or a silent local close.
    const end = (error: ConnectionError | undefined): void => {
      if (ended) return;
      ended = true;
      detach();
      try {
        socket.close();
      } catch {
        // A socket already closed by the peer throws on close in some states;
        // the outcome is reported below either way.
      }
      if (!opened) {
        reject(
          error ??
            new ConnectionError(
              "the connection to the signaling server ended before it was " +
                "registered",
              "transport",
            ),
        );
        return;
      }
      if (error !== undefined) handlers.onClose(error);
    };

    const onAbort = (): void =>
      end(
        new ConnectionError(
          "connecting to the signaling server was cancelled",
          "closed",
        ),
      );

    const onSocketOpen = (): void => {
      // Registration is confirmed by the server's OPEN, not by the socket
      // opening: a wrong key or a taken id also opens the socket, then answers
      // with a refusal.
      heartbeat = setInterval(() => {
        if (ended) return;
        sendRaw({ type: BROKER_MESSAGE.heartbeat });
      }, heartbeatIntervalMs);
      // The heartbeat is upkeep, not work: it must not be what keeps the process
      // alive once the exchange is over and every other handle has been released.
      heartbeat.unref();
    };

    const onSocketMessage = (event: MessageEvent): void => {
      if (ended) return;
      let message: BrokerMessage | undefined;
      try {
        message = parseSignalingFrame(event.data);
      } catch (err) {
        end(err as ConnectionError);
        return;
      }
      // A frame that is not a signaling message at all is dropped rather than
      // fatal: the broker is entitled to add message types, and an unknown one
      // is not evidence of an attack.
      if (message === undefined) return;
      const terminal = terminalErrorFor(message);
      if (terminal !== undefined) {
        end(terminal);
        return;
      }
      if (!opened && message.type === BROKER_MESSAGE.open) {
        opened = true;
        if (openTimer !== undefined) clearTimeout(openTimer);
        openTimer = undefined;
        resolve({ localId: id, send: sendRaw, close: () => end(undefined) });
        return;
      }
      // Non-terminal frames reach the handler in both phases. The measured
      // broker sends OPEN before anything else, but a signaling frame that
      // arrives ahead of it is handed on rather than dropped or treated as a
      // refusal -- the handlers are installed before the socket is, so there is
      // no window in which one could be lost.
      handlers.onMessage(message);
    };

    // The socket's `error` event carries no detail worth surfacing (and in Node
    // its message can embed the URL, which carries the peer id), so it is
    // reported as a plain transport failure. `close` follows it, but `end` is
    // idempotent.
    const onSocketError = (): void =>
      end(
        new ConnectionError(
          "the connection to the signaling server failed",
          "transport",
        ),
      );

    const onSocketClose = (): void =>
      end(
        new ConnectionError(
          "the signaling server closed the connection",
          "transport",
        ),
      );

    function sendRaw(message: {
      type: string;
      dst?: string;
      payload?: unknown;
    }): void {
      if (ended || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(message));
    }

    socket.addEventListener("open", onSocketOpen);
    socket.addEventListener("message", onSocketMessage);
    socket.addEventListener("error", onSocketError);
    socket.addEventListener("close", onSocketClose);

    openTimer = setTimeout(
      () =>
        end(
          new ConnectionError(
            `the signaling server did not confirm registration within ` +
              `${openTimeoutMs}ms`,
            "transport",
          ),
        ),
      openTimeoutMs,
    );

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort);
  });
}
