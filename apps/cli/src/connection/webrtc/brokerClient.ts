import { randomBytes } from "node:crypto";

import {
  chainDetailCauses,
  ConnectionError,
  parseBoundedJson,
  UsageError,
} from "@psilink/core";

import { fittedCauseLink } from "../causeLink";
import {
  askSignalingCertificate,
  probeSignalingCertificate,
} from "./signalingTls";

import type {
  SignalingCertificateAnswer,
  SignalingCertificateProbe,
} from "./signalingTls";

/**
 * The PeerJS broker signaling client, written against the broker's WebSocket
 * wire rather than by running PeerJS in Node (docs/notes/cli-webrtc-stack.md).
 * It handles the OFFER/ANSWER/CANDIDATE exchange that gets two peers to a data
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
 *   contains only `type`, `payload` and `dst`; an inbound one adds `src`.
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
 * of PeerJS's own output after the fact; this client instead never puts one
 * into a message, an error or a log line in the first place -- including the
 * socket URL, which holds the id in its query string.
 * test/unit/connection/webrtcBrokerClient.test.ts holds that as a check rather
 * than leaving it to prose.
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
  /**
   * Cancels a registration in flight. Released once the registration is
   * confirmed; see {@link connectToBroker} for what the caller owns past that.
   */
  signal?: AbortSignal;
  /**
   * Constructs the socket; injected so the unit tests drive the client's whole
   * state machine without a broker. Defaults to the global `WebSocket`, which
   * Node has supplied since v22.
   */
  socketFactory?: (url: string) => WebSocket;
  /**
   * Asks what the certificate check said once a socket has failed, before it
   * registered; injected so a unit test can drive both answers without a
   * server. Defaults to {@link probeSignalingCertificate}, is asked only where
   * {@link askSignalingCertificate} decides a check applies, and is handed
   * `signal` so an interrupt releases the handshake it holds open.
   */
  certificateProbe?: SignalingCertificateProbe;
}

/**
 * The message a symmetric role misconfiguration produces. The broker cannot see
 * the mistake -- from its side a second socket simply claimed a live id -- so
 * naming the likely cause is this client's job. Without it the operator sees
 * only a dropped socket and, on the other side, a dial that never completes.
 *
 * Short enough to survive the display boundary whole: the remedy is its last
 * clause, so a message over the render cap loses exactly the part the operator
 * acts on, and only at the terminal.
 */
export const ID_TAKEN_MESSAGE =
  "the signaling server reports this peer id is already registered. The " +
  "usual cause is both parties running the same connection role: check the " +
  "`role` field on each party's webrtc connection, one inviter and one " +
  "acceptor.";

function idTakenError(): ConnectionError {
  return new ConnectionError(ID_TAKEN_MESSAGE, "usage");
}

/** What a failed signaling socket reports when the certificate verified. */
export const SIGNALING_SOCKET_FAILED_MESSAGE =
  "the connection to the signaling server failed";

/**
 * What a failed signaling socket reports when the certificate did not verify.
 * Names the remedy an operator on a managed network needs: the failure is
 * usually a proxy presenting its own certificate, and trusting that proxy's
 * certificate authority is what fixes it.
 */
export const SIGNALING_CERTIFICATE_FAILED_MESSAGE =
  "the connection to the signaling server failed because its TLS certificate " +
  "did not verify on this machine. If this network intercepts TLS, add its " +
  "certificate authority to this machine's trust store, or name a file " +
  "holding it in NODE_EXTRA_CA_CERTS; otherwise check that the signaling " +
  "server's own certificate is current and issued for the configured `host`.";

/**
 * What a failed `wss://` signaling socket reports on a run that turns Node's
 * environment proxying on, where no check is made at all: the check dials the
 * signaling server directly and never through a proxy, so it cannot tell
 * which path the failed connection took -- `NO_PROXY` decides that per dial --
 * and any verdict it reached might be about a connection the run never made.
 * It names the same remedy as its sibling above, an intercepting proxy being
 * at least as likely the cause here.
 */
export const SIGNALING_PROXIED_FAILED_MESSAGE =
  "the connection to the signaling server failed, and its TLS certificate " +
  "was not checked: this run has Node's environment proxying turned on " +
  "(NODE_USE_ENV_PROXY or --use-env-proxy, with a proxy address in the " +
  "environment), and the check dials the signaling server directly, so it " +
  "cannot tell whether this connection went through a proxy. If a proxy " +
  "intercepts TLS, add its certificate authority to this machine's trust " +
  "store, or name a file holding it in NODE_EXTRA_CA_CERTS; otherwise check " +
  "that the configured `host` and `port` are reachable.";

/** Label the verification failure's code takes a cause link of its own under. */
const CERTIFICATE_PROBLEM_LINK_LABEL = "certificate check reported: ";

/**
 * The error a failed signaling socket reports, given what it was told about
 * the same endpoint's certificate.
 *
 * The code is a fixed OpenSSL or Node token, but it is reached through a
 * certificate the far end chose, so it takes a labelled cause link of its own
 * rather than the summary, and is escaped where the chain is rendered.
 */
function signalingSocketError(
  certificate: SignalingCertificateAnswer,
): ConnectionError {
  if (certificate === undefined)
    return new ConnectionError(SIGNALING_SOCKET_FAILED_MESSAGE, "transport");
  if (certificate.kind === "not-checked-proxied")
    return new ConnectionError(SIGNALING_PROXIED_FAILED_MESSAGE, "transport");
  return new ConnectionError(
    SIGNALING_CERTIFICATE_FAILED_MESSAGE,
    "transport",
    {
      cause: chainDetailCauses([
        fittedCauseLink(CERTIFICATE_PROBLEM_LINK_LABEL, certificate.code),
      ]),
    },
  );
}

/**
 * The refusal a broker location that does not form a dialable address gets. It
 * names the operator's own fields and never the value: the address holds the
 * derived peer id, and a `path` reaching this module can be kilobytes long.
 */
export const BROKER_ADDRESS_REFUSED =
  "the signaling server address is not a valid WebSocket URL; check the " +
  "webrtc connection's `host`, `port`, and `path`";

/**
 * The same refusal for a location the partner's invitation supplied, where the
 * operator authored no connection block and has none to check: it names the
 * source the locator came from and the one remedy that is theirs, a further
 * invitation. Value-free for the same reason as its sibling above.
 */
export const INVITATION_BROKER_ADDRESS_REFUSED =
  "the coordination server this invitation names is not a valid WebSocket " +
  "address, so this acceptance cannot dial it; ask the party that sent the " +
  "invitation for one naming a server it can reach";

/** The refusal a registration URL naming some other authority gets. */
export const BROKER_AUTHORITY_REFUSED =
  "the signaling server address does not name the configured host, so nothing " +
  "was dialed; check the webrtc connection's `host` and `path`";

/**
 * The scheme, host and port a location dials, derived by the same URL parser the
 * WebSocket constructor will run on the finished address rather than by a
 * hostname pattern of this module's own.
 *
 * `host` must be a bare authority: one contributing no userinfo, no port, and no
 * path, query or fragment. Each of those moves or reshapes the authority --
 * `evil@attacker.example` makes the configured name the userinfo of an
 * attacker's host, and `broker.example/x` silently drops the configured port --
 * so a host holding one is refused rather than dialed. The port comes from
 * `port` alone.
 *
 * The refusal is a {@link UsageError} rather than a transport failure, and so
 * exits 64 wherever it is raised, because it is decided by the location alone:
 * every retry of the same locator reaches it again, and a 69 would set an
 * unattended supervisor re-running a run that cannot succeed. `refusal` selects
 * which wording the caller's own source of the locator warrants.
 *
 * @throws {UsageError} if `host` is not a bare authority.
 */
function brokerAuthority(
  location: BrokerLocation,
  refusal: string = BROKER_ADDRESS_REFUSED,
): URL {
  const scheme = location.secure ? "wss" : "ws";
  let authority: URL;
  try {
    authority = new URL(`${scheme}://${location.host}`);
  } catch {
    throw new UsageError(refusal);
  }
  if (
    authority.username !== "" ||
    authority.password !== "" ||
    authority.port !== "" ||
    authority.pathname !== "/" ||
    authority.search !== "" ||
    authority.hash !== ""
  ) {
    throw new UsageError(refusal);
  }
  authority.port = String(location.port);
  return authority;
}

/**
 * The authority a location dials, in the form the URL parser produces -- the
 * value {@link assertDialsConfiguredBroker} compares a built address against.
 *
 * This is what an operator-facing line naming the signaling server should contain,
 * because it is not the configured `host` text: the parser IDNA-normalizes a
 * host, lowercasing it, folding the alternative label separators (U+3002 and its
 * siblings) onto ".", and deleting the ignorable code points such as U+200B. A
 * configured `PEERS<U+3002>Example.ORG` dials `peers.example.org`, so echoing
 * the configured text would name a server the run never contacted. It includes
 * the port too, unless that is the scheme's default.
 *
 * @throws {UsageError} if `host` is not a bare authority.
 */
export function dialedBrokerAuthority(location: BrokerLocation): string {
  return brokerAuthority(location).host;
}

/** The coordination server a consent surface names, host and port apart. */
export interface DialedBrokerHostAndPort {
  /** The parser's host, bracketed where it is an IPv6 literal. */
  host: string;
  /** The port the dial uses, resolved even where it is the scheme's default. */
  port: number;
}

/**
 * The same dialed authority as {@link dialedBrokerAuthority}, with the port
 * always resolved.
 *
 * For the consent surface of an acceptance that dials a partner-supplied
 * locator: the operator is being asked to let this run reach a coordination
 * server they never typed, and the authority form omits a port that is the
 * scheme's default -- so the one line naming the server would leave the port to
 * be inferred from a scheme it does not include. The host half is the parser's,
 * for the reason above.
 *
 * The two are returned apart rather than joined so a display sink escapes the
 * host ALONE and appends the port outside that escape. An invitation may
 * include a host as long as the escape's own display cap admits, so a joined
 * value spends that whole budget on the host and truncates away the port this
 * resolves -- driven at the longest admissible host in
 * test/unit/commands/accept.test.ts, which holds it as a check rather than
 * leaving it to prose.
 *
 * @throws {UsageError} if `host` is not a bare authority, naming the invitation
 *   as the locator's source ({@link INVITATION_BROKER_ADDRESS_REFUSED}).
 */
export function dialedBrokerHostAndPort(
  location: BrokerLocation,
): DialedBrokerHostAndPort {
  return {
    host: brokerAuthority(location, INVITATION_BROKER_ADDRESS_REFUSED).hostname,
    port: location.port,
  };
}

/**
 * Refuse an address that does not dial the configured broker.
 *
 * The string is re-parsed rather than read off the builder because this is the
 * parse the WebSocket constructor itself performs on it. A safety check rather
 * than the primary control -- {@link brokerAuthority} and the connection resolver
 * refuse the shapes that can move an authority in the first place -- so what it
 * covers is a host or path shape that slipped past both and still landed
 * userinfo, or a different host, in the address that would be dialed.
 *
 * It raises the class {@link brokerAuthority} raises, and exits 64 for the
 * reason stated there: the address and the configured location decide it
 * between them, so a retry reaches it again. One class across every
 * undialable-endpoint refusal is what leaves the exit code readable as "nothing
 * was dialed" rather than as which of these sites caught it.
 *
 * @throws {UsageError} if the address names another host, or if the configured
 *   location is not a bare authority (via {@link brokerAuthority}, which
 *   resolves what the address is compared to).
 * @internal exported for testing
 */
export function assertDialsConfiguredBroker(
  url: string,
  location: BrokerLocation,
): void {
  const dialed = new URL(url);
  const expected = brokerAuthority(location);
  if (
    dialed.host === expected.host &&
    dialed.username === "" &&
    dialed.password === ""
  ) {
    return;
  }
  throw new UsageError(BROKER_AUTHORITY_REFUSED);
}

/**
 * Build the registration URL. Never logged or interpolated: it holds the id.
 *
 * The path is assigned as a pathname rather than concatenated into the address.
 * A `path` is partner-supplied on an invitation-seeded connection, and under
 * concatenation one beginning with `@` turns the configured host into the
 * userinfo of a host the partner chose; assigning it percent-encodes what would
 * otherwise re-open the authority. The `key` needs no such handling: it goes
 * through `URLSearchParams`, which encodes the delimiters that would let it
 * reach past its own query parameter.
 */
function brokerUrl(
  location: BrokerLocation,
  id: string,
  token: string,
): string {
  const url = brokerAuthority(location);
  // A path of "/" must not produce "//peerjs"; anything else keeps its shape and
  // gains exactly one separator.
  const base = location.path.endsWith("/")
    ? location.path.slice(0, -1)
    : location.path;
  url.pathname = `${base}/peerjs`;
  url.search = new URLSearchParams({
    key: location.key,
    id,
    token,
    version: PEERJS_CLIENT_VERSION,
  }).toString();
  const dialed = url.href;
  assertDialsConfiguredBroker(dialed, location);
  return dialed;
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
 * Does a generic `ERROR` payload contain the broker's invalid-key wording?
 *
 * PeerJS defines an `INVALID-KEY` message type, but the vendored broker answers
 * a wrong key with a plain `ERROR` whose payload reads "Invalid key provided"
 * (measured; pinned by test/integration/webrtc/broker.test.ts against the real
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
 *
 * `signal` cancels the REGISTRATION and nothing beyond it: the listener is
 * released the moment the broker confirms, leaving the caller's own cancellation
 * to report an abort that lands later and to close the socket it now owns.
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
    certificateProbe,
  } = options;

  return new Promise<BrokerClient>((resolve, reject) => {
    // Built before the socket exists, so an address this module refuses opens
    // nothing. A synchronous throw in a promise executor rejects the promise,
    // which is what keeps the refusal's own wording -- about the field at fault
    // -- rather than the generic one the constructor's catch below applies.
    const address = brokerUrl(location, id, registrationToken());
    let socket: WebSocket;
    try {
      socket = (socketFactory ?? ((url) => new WebSocket(url)))(address);
    } catch {
      // A WebSocket constructor may throw synchronously on an address it will
      // not dial. Replaced rather than wrapped: the raw error escapes this
      // module's error taxonomy, and its message can embed the URL (which
      // holds the peer id), so the cause is dropped and the operator is
      // pointed at the fields they control. One refusal wording maps to one exit
      // code, so this raises the class the authority parse above raises.
      reject(new UsageError(BROKER_ADDRESS_REFUSED));
      return;
    }
    // Registration and steady state are one socket with two phases; `opened`
    // switches which of the two settlement paths a failure takes, so a failure
    // can never both reject the registration and report through onClose.
    let opened = false;
    let ended = false;
    let settled = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let openTimer: ReturnType<typeof setTimeout> | undefined;

    const detach = (): void => {
      socket.removeEventListener("open", onSocketOpen);
      socket.removeEventListener("message", onSocketMessage);
      socket.removeEventListener("error", onSocketError);
      socket.removeEventListener("close", onSocketClose);
      if (heartbeat !== undefined) clearInterval(heartbeat);
      if (openTimer !== undefined) clearTimeout(openTimer);
      heartbeat = undefined;
      openTimer = undefined;
    };

    // Claims the terminal path and tears down, so a later event on the same
    // socket -- the `close` that follows an `error` -- reports nothing. Apart
    // from the settlement below, so a path that has to ask a question before
    // it can name the failure still closes the socket first. The abort listener
    // is left installed until the settlement, so an unanswered certificate
    // check is not what an interrupt waits on.
    const claimTerminal = (): boolean => {
      if (ended) return false;
      ended = true;
      detach();
      try {
        socket.close();
      } catch {
        // A socket already closed by the peer throws on close in some states;
        // the outcome is reported below either way.
      }
      return true;
    };

    // The outcome lands on exactly one of the three settlement paths: a
    // rejected registration, a reported failure, or a silent local close --
    // once, so an answer that arrives after an abort has already settled the
    // registration reports nothing.
    const settle = (error: ConnectionError | undefined): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
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

    // Every terminal path that can name its failure at once funnels here, so
    // teardown runs exactly once and the outcome is reported once.
    const end = (error: ConnectionError): void => {
      if (!claimTerminal()) return;
      settle(error);
    };

    // The caller's own close. It claims the settlement rather than routing
    // through `end`, which a path that has already torn down leaves early: a
    // close while an answer about the endpoint is still out has to silence that
    // answer rather than let it report through `onClose`.
    const closeLocally = (): void => {
      claimTerminal();
      settle(undefined);
    };

    // An abort is answered wherever it lands, including after a failing path
    // has claimed the teardown and is still asking the endpoint what its
    // certificate check said: an interrupt waits out none of this transport's
    // budgets (WEBRTC_TRANSPORT.md, Budgets), and the answer that arrives
    // behind it is dropped.
    const onAbort = (): void => {
      claimTerminal();
      settle(
        new ConnectionError(
          "connecting to the signaling server was cancelled",
          "closed",
        ),
      );
    };

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
        // The signal cancels the registration, which is now over. Past this
        // point the socket is the caller's, and the caller's own cancellation is
        // what should report an abort and tear down what it built; this listener
        // is registered before any of the caller's, so leaving it installed
        // would latch a registration's wording onto every later abort and make
        // the caller's own unreachable.
        signal?.removeEventListener("abort", onAbort);
        resolve({ localId: id, send: sendRaw, close: closeLocally });
        return;
      }
      // Non-terminal frames reach the handler in both phases. The measured
      // broker sends OPEN before anything else, but a signaling frame that
      // arrives ahead of it is handed on rather than dropped or treated as a
      // refusal -- the handlers are installed before the socket is, so there is
      // no window in which one could be lost.
      handlers.onMessage(message);
    };

    // The socket's `error` event has no detail worth exposing (and in Node its
    // message can embed the URL, which holds the peer id), so what failed is
    // asked of the endpoint instead, and only where the failure precedes
    // registration. A socket that registered completed that handshake, so an
    // answer about it would name a check that had passed, and waiting for one
    // would hold the report for the probe's ceiling. Which dials a check is
    // made for at all, and what a dial it is not made for is told, is
    // `askSignalingCertificate`'s decision.
    // The probe may be the caller's own, so its failing is one more thing the
    // answer can be: a rejection reports the socket failure it was asked about
    // rather than leaving the registration unsettled and the rejection
    // unhandled.
    async function askAboutCertificate(): Promise<SignalingCertificateAnswer> {
      try {
        return await askSignalingCertificate(
          location,
          certificateProbe ?? probeSignalingCertificate,
          signal,
        );
      } catch {
        return undefined;
      }
    }

    const onSocketError = (): void => {
      if (opened) {
        end(signalingSocketError(undefined));
        return;
      }
      if (!claimTerminal()) return;
      void askAboutCertificate().then((certificate) =>
        settle(signalingSocketError(certificate)),
      );
    };

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
