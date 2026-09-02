// Diagnoses a dial that died before the peer identified itself as an SSH server.
//
// The defect this closes: an SSH server writes its identification string
// ("SSH-2.0-...") unconditionally, before any per-connection policy runs, so a
// dial that reaches host-key verification never sees anything else.
// When something OTHER than an SSH server answers the port -- a proxy replying
// with an HTML error page, a TLS service, a firewall closing the connection in
// front of the server -- the pinned stack reports every one of those as the same
// `Connection lost before handshake`, which reads exactly like an unreachable
// host. `ssh -v` names the cause immediately by printing what the peer sent,
// and ssh2 keeps those same bytes to itself.
//
// That it keeps them is measured, not assumed: ssh2's `debug` callback reports
// `Socket connected` then `Socket ended` for a peer answering with an HTTP page,
// with a TLS alert, and for one closing having sent nothing, and its `greeting`
// event fires only for pre-identification lines FOLLOWED by a valid
// identification string. The premise and what a version bump re-measures are
// recorded in docs/spec/DEPENDENCY_PINS.md ("Upgrading the SFTP Stack"). So the
// bytes are read here instead, on one bounded, credential-free TCP connection
// opened after the dial has already failed.
//
// What the operator is told rests on THAT read rather than on the rejection's
// text: the message fragment only decides whether to look, and a peer that turns
// out to be a healthy SSH server is left with the rejection it already had. The
// excerpt is bytes an untrusted party chose, so it is redacted of private-key
// material where it is produced (see classifyPeerAnswer) and rides a display
// link of its own (see explainPeerIdentificationFailure).

import net from "node:net";

import {
  causeChainSome,
  chainDetailCauses,
  redactPrivateKeyMaterial,
} from "@psilink/core";

/**
 * The port ssh2 dials when connect options carry none. Core omits `port` from
 * the connect options when the config sets none, so the diagnosis has to
 * reproduce that default to reach the same endpoint the failed dial did -- see
 * {@link peerProbeTargetFromConnectOptions}, whose agreement with the pinned
 * stack is a check rather than prose.
 */
const SSH2_DEFAULT_PORT = 22;

/**
 * Ceiling on how long {@link observePeerAnswer} spends on the whole read --
 * connect and bytes together -- before settling on what it has. Small and
 * additionally clamped by {@link diagnosePeerAnswer} to the connect budget the
 * failed dial ran under (`serverConnectTimeoutMs`, which core enforces as ssh2's
 * `readyTimeout`), so the diagnosis stays inside the budget the operator already
 * granted the connect rather than adding an unbounded wait to a run that has
 * just failed.
 */
export const PEER_ANSWER_READ_BUDGET_MS = 2_000;

/**
 * Bytes {@link observePeerAnswer} RETAINS before it stops reading. Above
 * {@link PEER_EXCERPT_MAX_BYTES} on purpose: an SSH server may legally send
 * lines ahead of its identification string, and reading past the excerpt lets
 * such a server be recognized by that string rather than by its preamble -- as
 * far as this bound reaches. One whose preamble runs past it, or whose
 * identification string arrives after {@link PEER_ANSWER_READ_BUDGET_MS}, is
 * classified as non-SSH, which is why the copy states what the peer's first
 * bytes carried rather than what the peer is.
 *
 * A retention bound rather than a ceiling on what transits: the socket is never
 * paused, so one delivery -- up to the stream's high-water mark -- can arrive
 * before the stop rule fires, and this is what survives it.
 */
export const PEER_ANSWER_READ_MAX_BYTES = 512;

/**
 * Bytes of the peer's answer carried into the diagnostic. The excerpt is bounded
 * HERE, at composition, rather than left to the display cap: the display
 * boundary caps what is rendered, while this is what is held and passed around.
 * Sized so an excerpt of printable bytes renders whole within one display link,
 * and so an excerpt of bytes that each escape to four characters spends only its
 * own link when it does not.
 *
 * The private-key strip runs over the whole retained read before this clip
 * (see {@link classifyPeerAnswer}), so the bound is applied to text already
 * redacted and never the other way round.
 */
export const PEER_EXCERPT_MAX_BYTES = 128;

/** The shapes {@link observePeerAnswer} names in the operator's copy. */
export type PeerAnswerShape = "http" | "tls-alert" | "unrecognized";

/**
 * What a credential-free read of the peer's first bytes established.
 *
 * @internal
 */
export type PeerAnswer =
  /** The peer sent an SSH identification string: it is an SSH server, and the
   * dial failed for some other reason. */
  | { kind: "identified" }
  /** The peer sent bytes that are not an SSH identification string. `excerpt`
   * is what its first bytes carried, redacted and then clipped by
   * {@link classifyPeerAnswer}, so every consumer holds the same treated bytes.
   */
  | { kind: "non-ssh"; shape: PeerAnswerShape; excerpt: string }
  /** The peer accepted the connection and then closed or reset it having sent
   * nothing at all. */
  | { kind: "closed-unanswered" }
  /** Nothing was established: the connection could not be made, or it was made
   * and stood open with no bytes on it until the budget ran out. A peer that
   * accepts and then stalls is deliberately here rather than with
   * `closed-unanswered` -- a merely slow server looks the same from this side,
   * and the rejection the dial already carries says so without guessing. */
  | { kind: "unobserved" };

/**
 * The rejection fragments the pinned stack raises for a dial that ended before
 * the peer's identification string was read, measured against `ssh2` 1.17.0
 * through `ssh2-sftp-client` 12.1.1: a peer sending non-SSH bytes, and one
 * closing cleanly having sent none, both reject with the first (ssh2's
 * `level: "protocol"` does not survive the `getConnection:` wrapper, so the
 * message is what there is to match on -- the same shape as the `Host denied`
 * and key-exchange matches beside it); a peer resetting at accept rejects with
 * the second, which arrives with `code: "ECONNRESET"` as well.
 *
 * A version that reworded them stops the diagnosis firing and leaves the dial
 * failing exactly as it does today: an unmatched rejection is handed back as it
 * stands, and the fragment decides only whether to look -- what the operator is
 * told comes from the bytes the read observes, and a peer that turns out to be an
 * SSH server is reported as nothing at all (sftpPeerIdentification.test.ts,
 * "leaves an unreachable host to the rejection it already has" and "leaves the
 * rejection alone when the peer identified itself").
 */
const PRE_IDENTIFICATION_FAILURE_FRAGMENTS = [
  "Connection lost before handshake",
  "ECONNRESET",
] as const;

/**
 * Whether `error` is a dial rejection raised before the peer identified itself,
 * and so worth reading the peer's first bytes over. Walks the cause chain rather
 * than reading one message, so the gate does not rest on the stack's own
 * rejection being the link it is handed: a re-raise that replaces the message
 * and keeps that rejection as its cause -- the shape the dial paths' own
 * diagnostics compose -- stays matched.
 *
 * @internal
 */
export function isPreIdentificationDialFailure(error: unknown): boolean {
  return causeChainSome(
    error,
    (link) =>
      link instanceof Error &&
      PRE_IDENTIFICATION_FAILURE_FRAGMENTS.some((fragment) =>
        link.message.includes(fragment),
      ),
  );
}

/**
 * An SSH identification string at the start of a line, the one thing a peer can
 * send that makes it an SSH server (RFC 4253 section 4.2: the server sends it
 * first, and may send other lines ahead of it). Anchored to a line start so the
 * three characters appearing inside an HTML page do not read as one.
 */
const SSH_IDENTIFICATION_LINE = /(?:^|\r|\n)SSH-/;

/** A TLS record whose content type is `alert` (21) followed by a 3.x version. */
const isTlsAlertRecord = (bytes: Uint8Array): boolean =>
  bytes.length >= 5 && bytes[0] === 0x15 && bytes[1] === 0x03;

/**
 * Classify what the peer sent. The bytes are decoded latin1 rather than utf8:
 * every byte then maps to exactly one code point, so the display boundary
 * escapes each one to a `\xHH` an operator can read back, where a utf8 decode
 * would collapse every invalid sequence to one replacement character and lose
 * the bytes that identify what answered.
 *
 * The excerpt is redacted of private-key material over the WHOLE retained read
 * and clipped afterwards, which is the order {@link redactPrivateKeyMaterial}
 * is written for: a clip taken first can cut a `BEGIN ... PRIVATE KEY` marker in
 * half, leaving a fragment neither the block rule nor the dangling rule matches,
 * so a consumer redacting the clipped excerpt would strip nothing. Redacting
 * here rather than at each consumer is also what makes the two routes carry the
 * same bytes -- the composed cause chain and the `--json` diagnosis line -- and
 * gives a later consumer the treatment without having to know to ask for it.
 *
 * Classification reads the RAW text: a peer that planted a marker ahead of a
 * real identification string would otherwise have the fail-closed dangling rule
 * swallow that string and turn an SSH server into a non-SSH answer.
 */
function classifyPeerAnswer(bytes: Uint8Array): PeerAnswer {
  if (bytes.length === 0) return { kind: "closed-unanswered" };
  const text = Buffer.from(bytes).toString("latin1");
  if (SSH_IDENTIFICATION_LINE.test(text)) return { kind: "identified" };
  const shape: PeerAnswerShape = isTlsAlertRecord(bytes)
    ? "tls-alert"
    : text.startsWith("HTTP/")
      ? "http"
      : "unrecognized";
  return {
    kind: "non-ssh",
    shape,
    excerpt: redactPrivateKeyMaterial(text).slice(0, PEER_EXCERPT_MAX_BYTES),
  };
}

/**
 * Open one TCP connection to `host:port`, read whatever the peer sends within
 * `budgetMs`, and report what it establishes. Writes NOTHING: no credential, no
 * identification string, no SSH traffic at all -- the host-key probe this backs
 * rests on nothing being presented to an unverified server, and the dial paths
 * reach here having just failed against a peer that answered the port wrongly;
 * a socket that only reads presents nothing at all to either.
 *
 * Best-effort, and stated as such rather than relied on: it runs after the dial
 * has already failed and against a peer that may answer a second connection
 * differently (a load balancer, a round-robin address), so it reports
 * `unobserved` for anything it cannot establish and the caller falls back to the
 * rejection it already had (sftpPeerIdentification.test.ts drives the refused
 * connection and the peer that accepts and then holds the connection open).
 *
 * @internal
 */
export function observePeerAnswer(
  target: { host: string; port: number },
  budgetMs: number,
): Promise<PeerAnswer> {
  return new Promise<PeerAnswer>((resolve) => {
    let observed = Buffer.alloc(0);
    let settled = false;
    const socket = net.connect({ host: target.host, port: target.port });
    const settle = (answer: PeerAnswer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(answer);
    };
    // One deadline over connect and read together, so the whole diagnosis costs
    // at most this much wall clock however the peer behaves. Bytes already read
    // when it expires are classified; a connection standing open with none is
    // not (see the `unobserved` case).
    const deadline = setTimeout(() => {
      settle(
        observed.length > 0
          ? classifyPeerAnswer(observed)
          : { kind: "unobserved" },
      );
    }, budgetMs);
    socket.on("data", (chunk: Buffer) => {
      // Truncated to the read bound BEFORE it is retained, so a peer answering
      // with megabytes cannot make this hold them.
      observed = Buffer.concat([
        observed,
        chunk.subarray(0, PEER_ANSWER_READ_MAX_BYTES - observed.length),
      ]);
      if (observed.length >= PEER_ANSWER_READ_MAX_BYTES)
        settle(classifyPeerAnswer(observed));
    });
    socket.on("end", () => settle(classifyPeerAnswer(observed)));
    socket.on("close", () => settle(classifyPeerAnswer(observed)));
    socket.on("error", (err: NodeJS.ErrnoException) => {
      // A reset the peer sent AFTER accepting is the same "sent nothing" case as
      // a clean close: which of the two a network sends is a property of the
      // gear in front of the server rather than of the server, so both take one
      // message and the rejection one link down carries the wording that
      // distinguishes them. Any other errno means the connection was never made
      // -- a refusal, an unresolvable name, an unreachable route -- which the
      // rejection already reports without help.
      if (observed.length > 0) settle(classifyPeerAnswer(observed));
      else
        settle(
          err.code === "ECONNRESET"
            ? { kind: "closed-unanswered" }
            : { kind: "unobserved" },
        );
    });
  });
}

/**
 * What the read established, in the form a machine consumer reads it: the two
 * {@link PeerAnswer} arms that say something about the peer, without the two
 * that say nothing (`identified` and `unobserved` compose no diagnostic at all).
 * Carried on the raised error so a caller classifies on structure rather than on
 * the composed sentence. `excerpt` is the producer's, private-key material
 * already stripped from it, so a consumer emits it as it stands.
 */
export type PeerIdentificationDiagnosis =
  | { kind: "non-ssh"; shape: PeerAnswerShape; excerpt: string }
  | { kind: "closed-unanswered" };

/** The diagnostic this module raises. A distinct subtype carrying the
 * {@link PeerIdentificationDiagnosis} the composed message was written from, so
 * a caller emitting a machine-readable form reads the classification and the
 * peer's bytes off the error rather than parsing them back out of prose. */
class PeerIdentificationError extends Error {
  constructor(
    message: string,
    readonly diagnosis: PeerIdentificationDiagnosis,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PeerIdentificationError";
  }
}

/**
 * The diagnosis a failure carries, or undefined when no link in its cause chain
 * is one of this module's. Walks the chain rather than reading the value handed
 * over, for the same reason {@link isPreIdentificationDialFailure} does: the
 * dial paths re-raise, keeping the diagnostic as a cause.
 *
 * @internal
 */
export function peerIdentificationDiagnosisOf(
  error: unknown,
): PeerIdentificationDiagnosis | undefined {
  let found: PeerIdentificationDiagnosis | undefined;
  causeChainSome(error, (link) => {
    if (!(link instanceof PeerIdentificationError)) return false;
    found = link.diagnosis;
    return true;
  });
  return found;
}

/**
 * What the peer's first bytes carried, said as the evidence it is rather than as
 * a verdict on what the peer is. The read is bounded twice -- by
 * {@link PEER_ANSWER_READ_MAX_BYTES} and {@link PEER_ANSWER_READ_BUDGET_MS} --
 * and an SSH server may legally send lines ahead of its identification string,
 * so a real one whose preamble outruns either bound lands here as well. Hence
 * the likelihood wording, and the caveat the recovery step carries.
 */
const NON_SSH_SHAPE_DESCRIPTION: Record<PeerAnswerShape, string> = {
  http:
    `an HTTP response, not an SSH identification string -- most likely a web ` +
    `server, or a proxy or gateway intercepting this port`,
  "tls-alert":
    `a TLS alert record, not an SSH identification string -- most likely a ` +
    `service speaking TLS, or a TLS-terminating proxy`,
  unrecognized:
    `not an SSH identification string -- most likely something other than an ` +
    `SSH server answering this port`,
};

/**
 * How the second connection was made, said once so no message implies psilink
 * learned this from the failed dial or presented anything to get it. A link of
 * its own beside the recovery step rather than a sentence appended to it:
 * first-party copy is capped by the display boundary exactly as anyone else's
 * is, and a step and this together outgrow one link's budget.
 */
const READ_PROVENANCE =
  `psilink read this on a second connection to the same endpoint, opened ` +
  `after the dial failed and carrying no credential.`;

/**
 * Compose the operator-facing diagnostic for a dial that died before the peer
 * identified itself, or return `error` untouched when the read established
 * nothing to say.
 *
 * The diagnostic REPLACES the rejection's message and keeps the rejection as the
 * last link of its cause chain, so the operator reads the cause first and the
 * stack's own wording -- which is what distinguishes a clean close from a reset
 * -- is still there behind it.
 *
 * Every fragment somebody else chose rides a link of its own, because the
 * display boundary caps each link independently: the peer's excerpt is bytes an
 * untrusted party CHOSE, and the configured endpoint is copied out of an
 * operator config or a partner's invitation under no length bound, so a link
 * shared with first-party text would let either delete the step the operator has
 * to act on. Fragments are composed RAW and redacted before they are bounded:
 * the endpoint here, where it is interpolated, and the peer's excerpt at its
 * producer, which is why this interpolates it as it stands. The display sink
 * escapes the rendered chain exactly once (see CONTRIBUTING.md, Operator-facing
 * escaping).
 *
 * @internal
 */
export function explainPeerIdentificationFailure(
  error: unknown,
  answer: PeerAnswer,
  endpoint: { host: string; port: number },
): unknown {
  if (answer.kind === "identified" || answer.kind === "unobserved")
    return error;
  const endpointDetail =
    `configured endpoint: ` +
    `${redactPrivateKeyMaterial(endpoint.host)}:${endpoint.port}`;
  if (answer.kind === "closed-unanswered")
    return new PeerIdentificationError(
      `the SFTP server never identified itself: the peer accepted the ` +
        `connection and closed it having sent nothing. An SSH server sends ` +
        `its identification string first, so the connection was most likely ` +
        `stopped in front of the server.`,
      { kind: "closed-unanswered" },
      {
        cause: chainDetailCauses(
          [
            `The usual cause is a firewall or gateway enforcing a source-IP ` +
              `allowlist this host is not on, though a connection throttle ` +
              `reads the same way: ask whoever administers the server ` +
              `whether this host's address may reach the SFTP port.`,
            READ_PROVENANCE,
            endpointDetail,
          ],
          error,
        ),
      },
    );
  return new PeerIdentificationError(
    `the SFTP server did not identify itself: the first bytes the peer ` +
      `answering this endpoint sent were ` +
      `${NON_SSH_SHAPE_DESCRIPTION[answer.shape]}.`,
    { kind: "non-ssh", shape: answer.shape, excerpt: answer.excerpt },
    {
      cause: chainDetailCauses(
        [
          `Check that the configured host and port name the SFTP service, and ` +
            `that no proxy or middlebox stands in front of them. An SSH ` +
            `server whose banner approaches the ` +
            `${PEER_ANSWER_READ_MAX_BYTES}-byte read bound, or that ` +
            `identifies itself late, reads this way too.`,
          READ_PROVENANCE,
          endpointDetail,
          `first bytes the peer sent; PEM private-key blocks replaced: ${answer.excerpt}`,
        ],
        error,
      ),
    },
  );
}

/**
 * The endpoint the diagnosis reads, which has to be the endpoint the dial it
 * diagnoses used -- a read of a different port would report about a peer the
 * dial never spoke to. Derived from ssh2's connect options rather than the
 * psilink config they were built from, because that is what the transport
 * adapter's dial sequence holds: the cycle-start and recovery re-dials enter it
 * with the retained options and never with the config behind them. Reads `host`
 * and `port` because those are the fields core assigns from the config after its
 * default-deny `providerOptions` filter, so no operator-supplied key can move
 * the endpoint out from under this. Options carrying no port take the port ssh2
 * itself defaults to, and that this default and the pinned stack's agree is a
 * check rather than prose (`apps/cli/test/integration/sftpStackPremises.test.ts`
 * reads the port the stack dials portlessly off its own rejection and holds this
 * to it).
 *
 * `undefined` when the options carry no host, or a port of a type ssh2 would
 * coerce rather than use as given: the endpoint the dial reached cannot then be
 * reproduced, and a dial this cannot follow keeps the rejection it already had.
 *
 * @internal
 */
export function peerProbeTargetFromConnectOptions(options: {
  host?: unknown;
  port?: unknown;
}): { host: string; port: number } | undefined {
  const { host, port } = options;
  if (typeof host !== "string" || host === "") return undefined;
  if (port !== undefined && typeof port !== "number") return undefined;
  return { host, port: port ?? SSH2_DEFAULT_PORT };
}

/**
 * Read the peer's first bytes and compose what they say about `error`, for a
 * rejection the caller has already put to {@link isPreIdentificationDialFailure}.
 * One bounded, credential-free connection and one classification of what came
 * back, called from the transport adapter's dial sequence and nowhere else --
 * the single point every dial psilink makes passes through, the host-key probe's
 * included, so no entry point can grow a second read of the same peer or a
 * second matcher that disagrees about the same rejection.
 *
 * The gate is the CALLER's rather than this function's because the caller spends
 * a per-connection budget on the read (see the adapter's once-per-connection
 * latch) and has to know whether the read will run before it spends it.
 *
 * `connectBudgetMs` is the per-attempt connect budget the failed dial ran under;
 * the read is clamped to it, so a run that shortened the connect does not get a
 * longer diagnosis than the dial it diagnoses.
 *
 * @internal
 */
export async function diagnosePeerAnswer(
  error: unknown,
  endpoint: { host: string; port: number },
  connectBudgetMs: number | undefined,
): Promise<unknown> {
  const budgetMs = Math.min(
    PEER_ANSWER_READ_BUDGET_MS,
    connectBudgetMs ?? PEER_ANSWER_READ_BUDGET_MS,
  );
  return explainPeerIdentificationFailure(
    error,
    await observePeerAnswer(endpoint, budgetMs),
    endpoint,
  );
}
