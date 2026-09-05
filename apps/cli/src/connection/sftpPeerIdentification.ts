// Diagnoses a dial that failed before the peer identified itself as an SSH
// server. ssh2 discards whatever the peer sent and rejects every cause with
// one message (measured against the pinned stack; see
// docs/spec/DEPENDENCY_PINS.md, "Upgrading the SFTP Stack"), so this module
// reads those bytes itself on a second, bounded, credential-free connection.
// A healthy SSH server keeps its original rejection; the excerpt is
// untrusted bytes, redacted in classifyPeerAnswer before it is rendered.

import net from "node:net";

import {
  causeChainSome,
  chainDetailCauses,
  redactPrivateKeyMaterial,
} from "@psilink/core";

/**
 * The port ssh2 dials when connect options hold none. Core omits `port` from
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
 * Bytes {@link observePeerAnswer} retains before it stops reading. Above
 * {@link PEER_EXCERPT_MAX_BYTES} so a real SSH server can still be recognized
 * by its identification string past a preamble line; a preamble longer than
 * this bound, or an identification string arriving after
 * {@link PEER_ANSWER_READ_BUDGET_MS}, is classified as non-SSH. A retention
 * bound, not a hard ceiling: the socket is never paused, so one delivery, up
 * to the stream's high-water mark, can still arrive after it is reached.
 */
export const PEER_ANSWER_READ_MAX_BYTES = 512;

/**
 * Bytes of the peer's answer included in the diagnostic, bounded HERE at
 * composition rather than at the display boundary: this is what is held and
 * passed around, distinct from what is rendered. Sized so printable bytes
 * render whole within one display link, and bytes that each escape to four
 * characters still fit one link. The private-key strip runs over the whole
 * retained read before this clip (see {@link classifyPeerAnswer}), never the
 * other way round, so it is applied to text already redacted.
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
   * is what its first bytes held, redacted and then clipped by
   * {@link classifyPeerAnswer}, so every consumer holds the same treated bytes.
   */
  | { kind: "non-ssh"; shape: PeerAnswerShape; excerpt: string }
  /** The peer accepted the connection and then closed or reset it having sent
   * nothing at all. */
  | { kind: "closed-unanswered" }
  /** Nothing was established: the connection could not be made, or it was made
   * and stood open with no bytes on it until the budget ran out. A peer that
   * accepts and then stalls is grouped here, by design, rather than with
   * `closed-unanswered` -- a merely slow server looks the same from this side,
   * and the rejection the dial already has says so without guessing. */
  | { kind: "unobserved" };

/**
 * The rejection fragments the pinned stack raises for a dial that ended
 * before the peer's identification string was read, measured against `ssh2`
 * 1.17.0 through `ssh2-sftp-client` 12.1.1 (see docs/spec/DEPENDENCY_PINS.md,
 * "Upgrading the SFTP Stack"). A version that rewords them stops the
 * diagnosis firing without changing behavior: an unmatched rejection is
 * handed back as it stands, since the fragment only gates whether to look
 * (sftpPeerIdentification.test.ts, "leaves an unreachable host to the
 * rejection it already has").
 */
const PRE_IDENTIFICATION_FAILURE_FRAGMENTS = [
  "Connection lost before handshake",
  "ECONNRESET",
] as const;

/**
 * Whether `error` is a dial rejection raised before the peer identified
 * itself -- the case this module reads the peer's first bytes for. Walks
 * the cause chain rather than reading one message, so the gate does not rest
 * on the stack's own rejection being the link it is handed: a re-raise that
 * replaces the message and keeps that rejection as its cause -- the shape
 * the dial paths' own diagnostics compose -- stays matched.
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
 * Classify what the peer sent. Decoded latin1, not utf8, so every byte maps
 * to one code point and the display boundary can escape each one back
 * losslessly, where utf8 would collapse an invalid sequence and lose the
 * bytes that identify what answered.
 *
 * The excerpt is redacted of private-key material over the whole retained
 * read and clipped afterward, never the reverse -- clipping first could cut
 * a `BEGIN ... PRIVATE KEY` marker in half and leave nothing for a consumer
 * to strip (see docs/spec/CHANNEL_SECURITY.md). Classification itself reads
 * the raw, unredacted text, so a planted marker cannot swallow a real
 * identification string.
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
 * `budgetMs`, and report what it establishes. Writes nothing -- no
 * credential, no identification string, no SSH traffic -- since the host-key
 * probe this backs rests on presenting nothing to an unverified server.
 *
 * Best-effort, not relied on: it runs after the dial has already failed,
 * against a peer that may answer a second connection differently (a load
 * balancer, a round-robin address), so anything it cannot establish reports
 * `unobserved` and the caller falls back to the rejection it already had.
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
      // A reset the peer sent AFTER accepting is the same "sent nothing" case
      // as a clean close: which of the two a network sends is a property of
      // the gear in front of the server rather than of the server, so both
      // take one message, and the rejection one link down has the wording
      // that distinguishes them. Any other errno means the connection was
      // never made -- a refusal, an unresolvable name, an unreachable route
      // -- which the rejection already reports without help.
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
 * Held on the raised error so a caller classifies on structure rather than on
 * the composed sentence. `excerpt` is the producer's, private-key material
 * already stripped from it, so a consumer emits it as it stands.
 */
export type PeerIdentificationDiagnosis =
  | { kind: "non-ssh"; shape: PeerAnswerShape; excerpt: string }
  | { kind: "closed-unanswered" };

/** The diagnostic this module raises. A distinct subtype holding the
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
 * The diagnosis a failure has, or undefined when no link in its cause chain
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
 * What the peer's first bytes held, said as the evidence it is rather than as
 * a verdict on what the peer is. The read is bounded twice -- by
 * {@link PEER_ANSWER_READ_MAX_BYTES} and {@link PEER_ANSWER_READ_BUDGET_MS} --
 * and an SSH server may legally send lines ahead of its identification string,
 * so a real one whose preamble outruns either bound lands here as well. Hence
 * the likelihood wording, and the caveat the recovery step has.
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
 * Compose the operator-facing diagnostic for a dial that died before the
 * peer identified itself, or return `error` untouched when the read
 * established nothing to say.
 *
 * The diagnostic replaces the rejection's message and keeps the rejection as
 * the last link of its cause chain, so the stack's own wording -- which
 * distinguishes a clean close from a reset -- is still there behind it.
 *
 * Every fragment somebody else chose rides a link of its own: the peer's
 * excerpt and the configured endpoint are both unbounded and untrusted or
 * partner-supplied, so sharing a link with first-party text would let either
 * delete the step the operator has to act on (see CONTRIBUTING.md,
 * Operator-facing escaping).
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
 * The endpoint the diagnosis reads: it has to be the endpoint the dial it
 * diagnoses used, since a read of a different port reports on a peer the
 * dial never spoke to. Derived from ssh2's connect options -- what the
 * transport adapter's dial sequence actually holds, including on a re-dial
 * -- rather than the psilink config they were built from. Reads `host` and
 * `port` because those are the fields core assigns after its default-deny
 * `providerOptions` filter, so no operator-supplied key can move the
 * endpoint out from under this. A portless config takes ssh2's own default
 * port, held equal to the pinned stack's by
 * `apps/cli/test/integration/sftpStackPremises.test.ts`.
 *
 * Returns `undefined` when the options hold no host, or a port of a type
 * ssh2 would coerce rather than use as given: the endpoint the dial reached
 * cannot then be reproduced, and a dial this cannot follow keeps the
 * rejection it already had.
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
 * rejection the caller has already put to
 * {@link isPreIdentificationDialFailure}. Called from the transport
 * adapter's dial sequence and nowhere else -- the single point every dial
 * psilink makes passes through, the host-key probe's included -- so no
 * entry point can grow a second read of the same peer.
 *
 * The gate is the caller's, not this function's: the caller spends a
 * per-connection budget on the read (see the adapter's once-per-connection
 * latch) and has to know whether the read will run before spending it.
 *
 * `connectBudgetMs` is the per-attempt connect budget the failed dial ran
 * under; the read is clamped to it, so a shortened connect does not get a
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
