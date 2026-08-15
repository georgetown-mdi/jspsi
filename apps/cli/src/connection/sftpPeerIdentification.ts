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
// excerpt is bytes an untrusted party chose, so it rides a display link of its
// own (see explainPeerIdentificationFailure).

import net from "node:net";

import { chainDetailCauses, redactPrivateKeyMaterial } from "@psilink/core";
import type { SFTPConnectionConfig } from "@psilink/core";

/**
 * The port ssh2 dials when connect options carry none. Core omits `port` from
 * the connect options when the config sets none, so the diagnosis has to
 * reproduce that default to reach the same endpoint the failed dial did -- see
 * {@link peerProbeTarget}, whose agreement with the pinned stack is a check
 * rather than prose.
 */
const SSH2_DEFAULT_PORT = 22;

/**
 * Ceiling on how long {@link observePeerAnswer} spends on the whole read --
 * connect and bytes together -- before settling on what it has. Small and
 * additionally clamped to the dial's own `serverConnectTimeoutMs` by
 * {@link withPeerIdentificationDiagnosis}, so the diagnosis stays inside the
 * budget the operator already granted the connect rather than adding an
 * unbounded wait to a run that has just failed.
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
  /** The peer sent bytes that are not an SSH identification string. */
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
 * failing exactly as it does today -- the behaviour of a match that never fires.
 * It cannot produce a wrong diagnosis, because the fragment decides only whether
 * to look: what the operator is told comes from the bytes the read observes, and
 * a peer that turns out to be an SSH server is reported as nothing at all.
 */
const PRE_IDENTIFICATION_FAILURE_FRAGMENTS = [
  "Connection lost before handshake",
  "ECONNRESET",
] as const;

/**
 * Whether `error` is a dial rejection raised before the peer identified itself,
 * and so worth reading the peer's first bytes over. Walks the cause chain,
 * because the rejection reaches a probe caller wrapped in core's own
 * host-key-probe message.
 *
 * @internal
 */
export function isPreIdentificationDialFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const message = current.message;
    if (
      PRE_IDENTIFICATION_FAILURE_FRAGMENTS.some((fragment) =>
        message.includes(fragment),
      )
    )
      return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
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
    excerpt: text.slice(0, PEER_EXCERPT_MAX_BYTES),
  };
}

/**
 * Open one TCP connection to `host:port`, read whatever the peer sends within
 * `budgetMs`, and report what it establishes. Writes NOTHING: no credential, no
 * identification string, no SSH traffic at all -- the whole point of the
 * host-key probe this backs is that nothing is presented to an unverified
 * server, and a socket that only reads presents nothing at all.
 *
 * Best-effort by construction. It runs after the dial has already failed and
 * against a peer that may answer a second connection differently (a load
 * balancer, a round-robin address), so it reports `unobserved` for anything it
 * cannot establish and the caller falls back to the rejection it already had.
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

/** The diagnostic this module raises, carried as a type rather than recognized
 * by its text, so a caller classifying downstream of it has something no party
 * on the wire can write. */
class PeerIdentificationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PeerIdentificationError";
  }
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
 * to act on. Fragments are composed RAW and redacted where they are
 * interpolated; the display sink escapes the rendered chain exactly once (see
 * CONTRIBUTING.md, Operator-facing escaping).
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
      {
        cause: chainDetailCauses(
          [
            `The usual cause is a firewall or gateway enforcing a source-IP ` +
              `allowlist this host is not on: ask whoever administers the ` +
              `server whether this host's address may reach the SFTP port.`,
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
    {
      cause: chainDetailCauses(
        [
          `Check that the configured host and port name the SFTP service, and ` +
            `that no proxy or middlebox stands in front of them. An SSH ` +
            `server that sends over ${PEER_ANSWER_READ_MAX_BYTES} bytes of ` +
            `banner first, or identifies itself late, reads this way too.`,
          READ_PROVENANCE,
          endpointDetail,
          `first bytes the peer sent: ` +
            redactPrivateKeyMaterial(answer.excerpt),
        ],
        error,
      ),
    },
  );
}

/**
 * The endpoint the diagnosis reads, which has to be the endpoint the dial it
 * diagnoses used -- a read of a different port would report about a peer the
 * dial never spoke to. Config-supplied where the config sets a port, and ssh2's
 * own default where it does not; that the two agree is a check rather than
 * prose (`apps/cli/test/integration/sftpStackPremises.test.ts` reads the port
 * the pinned stack dials portlessly off its own rejection and holds this to it).
 *
 * @internal
 */
export function peerProbeTarget(config: SFTPConnectionConfig): {
  host: string;
  port: number;
} {
  return {
    host: config.server.host,
    port: config.server.port ?? SSH2_DEFAULT_PORT,
  };
}

/**
 * Run `probe` and, when it fails before the peer identified itself as an SSH
 * server, re-raise the rejection with what a bounded credential-free read of the
 * peer's first bytes says about it. Every other failure -- and every success --
 * passes through untouched.
 *
 * This is the one place the classification lives; the host-key probe's two
 * entry points (`probe-host-key` and the first-use trust flow) both run their
 * probe through it, and the dial paths can consume the same three parts rather
 * than growing a second matcher that could disagree with this one.
 *
 * @internal
 */
export async function withPeerIdentificationDiagnosis<T>(
  config: SFTPConnectionConfig,
  probe: () => Promise<T>,
): Promise<T> {
  try {
    return await probe();
  } catch (err) {
    if (!isPreIdentificationDialFailure(err)) throw err;
    const endpoint = peerProbeTarget(config);
    // Clamped to the connect budget the operator configured, so a run that
    // shortened it does not get a longer diagnosis than the dial it diagnoses.
    const budgetMs = Math.min(
      PEER_ANSWER_READ_BUDGET_MS,
      config.options?.serverConnectTimeoutMs ?? PEER_ANSWER_READ_BUDGET_MS,
    );
    throw explainPeerIdentificationFailure(
      err,
      await observePeerAnswer(endpoint, budgetMs),
      endpoint,
    );
  }
}
