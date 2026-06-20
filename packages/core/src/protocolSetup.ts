import * as z from "zod";

import type { HandshakeRole, PsiRole } from "./types";
import type { LinkageTerms, Output } from "./config/linkageTerms";
import type { PresentedHostKey } from "./connection/fileSyncConnection";
import {
  parseLinkageTerms,
  validateCompatibility,
} from "./config/linkageTerms";
import { SHARED_SECRET_REGEX } from "./config/connection";
import { randomBytes, toBase64Url } from "./utils/crypto";
import { sanitizeForDisplay } from "./utils/sanitizeForDisplay";
import { describeDecodeError } from "./utils/describeDecodeError";
import {
  receiveParsed,
  type MessageConnection,
} from "./connection/messageConnection";

// --- Message schemas ---------------------------------------------------------

// The optional `hostKey` advertisement rides the terms exchange so each party
// advertises the SFTP host key it observed (fingerprint + key type) to the
// other, for cross-party reconciliation against a one-sided interception
// (201058119; see reconcileHostKeyFingerprints). Like `save`, it rides the
// terms exchange rather than a dedicated round-trip because that is the one
// bidirectional exchange both parties always perform, and -- being inside the
// authenticated, AEAD-wrapped post-handshake channel -- the advertised value
// cannot be forged by an unauthenticated party. It is omitted entirely by a
// party that observed no host key (a file-drop or proxy path, or an
// unauthenticated exchange that never threads the observed key in), so a
// one-sided absence reconciles to no divergence. The field bounds are
// defense-in-depth, far above any real value (a canonical SHA256 fingerprint is
// 50 chars; a key type such as "ecdsa-sha2-nistp521" is under 30): they cap a
// hostile partner's advertised values, mirroring the invitation decoder's
// per-field size bounds, and the receiver sanitizes both before display.
//
// hostKeyField is fail-soft AND self-classifying. A malformed or over-bound
// advertisement is read as absent rather than aborting the linkage, UNLIKE the
// rest of the terms message and unlike `save`. This is deliberate and specific
// to this field's contract: the reconciliation is a non-fatal advisory that only
// warns even on a genuine fingerprint divergence (see reconcileHostKeyFingerprints),
// so a malformed advertisement -- reachable only from a non-conforming or
// future-versioned peer, since the field rides the AEAD and an unauthenticated
// party cannot set it -- must degrade to "no reconciliation" rather than become a
// terms-exchange abort that blames the (valid) linkage terms. It never affects
// agreement, so dropping a bad value is the correct, contract-preserving outcome.
//
// The earlier bare `.optional().catch(undefined)` collapsed two cases into one
// `undefined`: a field genuinely absent (a partner that observed no host key, a
// file-drop or proxy path) and a field present on the wire but rejected. That
// erased the only signal an operator could use to tell a benign no-host-key
// partner from a non-conforming one. Instead, parse the raw field and tag it:
// an absent field and a well-formed value both report `malformed: false` (with
// `value` set only in the latter), while a present-but-invalid or over-bound
// value reports `malformed: true` with no `value`. The fail-soft contract is
// unchanged -- a malformed advertisement still yields no usable host key and
// never aborts -- but the malformed signal now survives for the CLI to log at
// debug (see TermsExchangeResult.partnerHostKeyMalformed).
const hostKeyAdvertisement = z.object({
  fingerprint: z.string().max(100),
  keyType: z.string().max(64),
});

/**
 * Classification of the partner's fail-soft `hostKey` advertisement after
 * parsing: `value` is the validated host key, present only when the field was on
 * the wire and well-formed; `malformed` is `true` only when the field was
 * present but failed validation. An absent field and a well-formed value both
 * report `malformed: false`, and `value` is `undefined` whenever `malformed` is
 * `true`.
 */
interface HostKeyAdvertisementParse {
  value: PresentedHostKey | undefined;
  malformed: boolean;
}

const hostKeyField = z
  .unknown()
  .optional()
  .transform((raw): HostKeyAdvertisementParse => {
    // No advertisement to classify: an omitted field arrives as `undefined`, and
    // an explicit `null` (JSON's representation of "no value") is treated the
    // same. Both are the benign no-host-key case, not a malformed attempt to
    // advertise one -- a conforming party that observed no host key omits the
    // field entirely (see the send-side spread in exchangeTerms), so neither
    // shape carries a host key an operator should be warned about.
    if (raw === undefined || raw === null)
      return { value: undefined, malformed: false };
    // Present and non-null but failing validation (wrong shape or over-bound) is
    // a genuine malformed advertisement, reachable only from a non-conforming or
    // future-versioned peer.
    const parsed = hostKeyAdvertisement.safeParse(raw);
    return parsed.success
      ? { value: parsed.data, malformed: false }
      : { value: undefined, malformed: true };
  });

// The optional `save` flag rides the terms exchange so each party advertises
// its zero-setup `--save` intent to the other on the one round-trip both sides
// always perform (see exchangeTerms). It is omitted entirely outside the
// zero-setup save flow -- recurring/authenticated exchanges leave it unset, so
// their on-wire terms messages are unchanged -- and a peer that omits it is read
// as `save: false`. It is advisory metadata, not part of terms agreement, so a
// mismatch never aborts: one party may save while the other does not.
const termsMessage = z.object({
  linkageTerms: z.unknown(),
  save: z.boolean().optional(),
  hostKey: hostKeyField,
});

const termsWithDecisionMessage = z.object({
  linkageTerms: z.unknown(),
  decision: z.enum(["proceed", "abort"]),
  abortReasons: z.array(z.string()).optional(),
  save: z.boolean().optional(),
  hostKey: hostKeyField,
});

const decisionMessage = z.object({
  decision: z.enum(["proceed", "abort"]),
  abortReasons: z.array(z.string()).optional(),
});

const recordCountMessage = z.object({
  recordCount: z.number().int().nonnegative(),
});

// The dedicated frame that carries a freshly generated shared secret from the
// initiator to the responder during a both-parties `--save` bootstrap (see
// exchangeBootstrapSecret). The token format is pinned to SHARED_SECRET_REGEX -- a
// base64url-encoded 32-byte value -- so it is byte-for-byte the persistent
// secret that authenticateConnection rotates to and saveKeyFile persists; a
// malformed value is a `protocol` ConnectionError on the responder.
const sharedSecretMessage = z.object({
  sharedSecret: z.string().regex(SHARED_SECRET_REGEX),
});

// --- Terms exchange ----------------------------------------------------------

export interface TermsExchangeResult {
  partnerTerms: LinkageTerms;
  warnings: string[];
  /**
   * Whether the partner advertised zero-setup `--save` intent on this terms
   * exchange. `false` outside the save flow (the partner omitted the field).
   * The caller uses it to decide whether to establish a shared secret and which
   * post-exchange notice to emit; it never affects whether the terms are agreed.
   */
  partnerSaveIntent: boolean;
  /**
   * The SFTP host key the partner advertised observing on its side of the
   * rendezvous (fingerprint + key type), or `undefined` when the partner
   * observed none (a file-drop or proxy path, or an exchange that did not thread
   * an observed key in) or advertised a malformed/over-bound value (read as
   * absent; see the fail-soft `hostKeyField` schema). The caller reconciles it
   * against its own observed key (see {@link reconcileHostKeyFingerprints}); it
   * never affects agreement. When the value was dropped as malformed,
   * {@link partnerHostKeyMalformed} is `true`, distinguishing that case from a
   * genuine absence.
   */
  partnerHostKey: PresentedHostKey | undefined;
  /**
   * Whether the partner's host-key advertisement was present on the wire but
   * failed the fail-soft validation (present-but-malformed), as distinct from
   * being genuinely absent. `true` only for a present-but-rejected value; `false`
   * both when the partner advertised a well-formed key and when it advertised
   * none at all. {@link partnerHostKey} is `undefined` whenever this is `true`
   * (the fail-soft drop). It is a diagnostic signal only -- a malformed
   * advertisement is reachable only from a non-conforming or future-versioned
   * peer, never affects agreement, and never aborts the exchange -- so a caller
   * logs it at a low level (the CLI logs it at debug; see apps/cli/src/protocol.ts).
   */
  partnerHostKeyMalformed: boolean;
}

/**
 * Best-effort delivery of an abort decision to the partner. The send is wrapped
 * so a transport failure coinciding with the abort condition is swallowed: the
 * partner falls back to its own receive timeout, and the caller's subsequent
 * throw - which carries the real diagnostic - is always what surfaces. Pass
 * `localTerms` when aborting from the responder's message-2 slot, which must
 * still carry `linkageTerms`; omit it for the initiator's decision-only frame.
 *
 * The optional `save` intent field is intentionally not spread onto an abort
 * frame. An abort ends the exchange before the bootstrap step, so the partner
 * never reads intent carried here (it throws on the abort first), and advertising
 * a desire to save while refusing the terms would be self-contradictory. Omitting
 * it is the correct signal, not an oversight.
 */
async function sendAbort(
  conn: MessageConnection,
  abortReasons: string[],
  localTerms?: LinkageTerms,
): Promise<void> {
  try {
    await conn.send(
      localTerms !== undefined
        ? { linkageTerms: localTerms, decision: "abort", abortReasons }
        : { decision: "abort", abortReasons },
    );
  } catch {
    /* swallow: see doc comment */
  }
}

/**
 * Exchange {@link LinkageTerms} with a partner over an established
 * connection, validate compatibility, and obtain agreement from both parties to
 * proceed.
 *
 * The three-message protocol mirrors the sequencing of the handshake:
 *   1. Initiator  -> Responder : `{ linkageTerms }`
 *   2. Responder  -> Initiator : `{ linkageTerms, decision }`
 *   3. Initiator  -> Responder : `{ decision }`
 *
 * If either party finds the terms incompatible, it sends `decision: "abort"`
 * with its reasons and this function throws. On success, returns the partner's
 * validated terms and any non-fatal warnings (e.g. a `date` mismatch). Call
 * {@link resolveRole} afterwards to determine each party's PSI role.
 *
 * When `localSaveIntent` is set, this party's zero-setup `--save` intent is
 * advertised on its terms message (message 1 for the initiator, message 2 for
 * the responder), and the partner's intent is read back from the message it
 * sends. The flag rides this exchange rather than a dedicated round-trip
 * precisely because the terms exchange is the one bidirectional round-trip both
 * parties always perform, so a party learns the other's intent even when it
 * passed nothing itself. `localSaveIntent` left `undefined` omits the field
 * entirely, leaving the non-save (recurring/authenticated) wire format
 * unchanged. The returned {@link TermsExchangeResult.partnerSaveIntent} is the
 * partner's advertised value (absent -> `false`); it never affects agreement.
 *
 * When `localHostKey` is set, this party's observed SFTP host key (fingerprint +
 * key type) is advertised on its terms message and the partner's is read back,
 * returned as {@link TermsExchangeResult.partnerHostKey} for cross-party
 * reconciliation (201058119). Left `undefined` (a party that observed no host
 * key) it omits the field, so the partner reconciles against nothing and a
 * one-sided absence is not a divergence. Like `save`, it never affects whether
 * the terms are agreed.
 *
 * The partner's advertisement is fail-soft: a present-but-malformed value is
 * dropped (read as no host key) rather than aborting. That drop is reported via
 * {@link TermsExchangeResult.partnerHostKeyMalformed} so a caller can tell a
 * non-conforming peer from one that simply observed no host key; a genuine
 * absence leaves the flag `false`.
 */
export async function exchangeTerms(
  conn: MessageConnection,
  handshakeRole: HandshakeRole,
  localTerms: LinkageTerms,
  localSaveIntent?: boolean,
  localHostKey?: PresentedHostKey,
): Promise<TermsExchangeResult> {
  // Spread into the outgoing terms frame only when this party is saving, so a
  // non-save exchange sends no `save` field at all.
  const saveField = localSaveIntent === true ? { save: true } : {};
  // Likewise the observed host key: spread only when this party observed one, so
  // a party with nothing to advertise sends no `hostKey` field at all.
  const hostKeyField =
    localHostKey !== undefined ? { hostKey: localHostKey } : {};

  if (handshakeRole === "initiator") {
    // Message 1: send our terms (carrying our save intent and observed host key
    // when set).
    await conn.send({
      linkageTerms: localTerms,
      ...saveField,
      ...hostKeyField,
    });

    // Message 2: receive partner's terms + decision.
    const msg = await receiveParsed(conn, termsWithDecisionMessage);

    if (msg.decision === "abort") {
      throw new Error(
        "partner aborted linkage terms exchange" +
          (msg.abortReasons?.length
            ? `: ${msg.abortReasons.map((r) => sanitizeForDisplay(r)).join("; ")}`
            : ""),
      );
    }

    let partnerTerms: LinkageTerms;
    try {
      partnerTerms = parseLinkageTerms(msg.linkageTerms);
    } catch (parseErr) {
      await sendAbort(conn, ["partner linkage terms failed to parse"]);
      // These terms are genuinely partner-controlled, so the parse error is
      // rendered through describeDecodeError, which escapes each Zod issue-path
      // segment via sanitizeForDisplay and relays the schema-fixed message text
      // (the shared chokepoint contract; see utils/describeDecodeError). The
      // path escaping is load-bearing, not cosmetic: Zod's `invalid_key` code on
      // the bounded `z.record` key in `transform.params`
      // (z.string().max(MAX_NAME_LENGTH)) places the offending raw key VERBATIM
      // into the issue PATH, which a raw `ZodError.message` JSON-dumps -- so a
      // partner key carrying bidi-override / zero-width / homoglyph bytes would
      // otherwise reach the operator unescaped. Escaping at the source makes the
      // invariant real here rather than leaning on the display-sink backstop.
      // The message text needs no escaping: unknown keys are stripped by the
      // non-strict `z.object` schemas rather than echoed via `unrecognized_keys`
      // (pinned by the "strips an unknown partner key" test), and the other
      // reachable codes (type mismatch, enum, semver/date format, too_small)
      // report the expected type/options, not the received value -- only the
      // path carries partner bytes.
      throw new Error(
        "partner linkage terms failed to parse: " +
          describeDecodeError(parseErr),
      );
    }

    const { errors, warnings } = validateCompatibility(
      localTerms,
      partnerTerms,
    );

    if (errors.length > 0) {
      await sendAbort(conn, errors);
      throw new Error(`linkage terms are incompatible: ${errors.join("; ")}`);
    }

    // Message 3: send our proceed decision.
    await conn.send({ decision: "proceed" });

    return {
      partnerTerms,
      warnings,
      partnerSaveIntent: msg.save === true,
      partnerHostKey: msg.hostKey.value,
      partnerHostKeyMalformed: msg.hostKey.malformed,
    };
  } else {
    // Message 1: receive partner's terms. Raw receive + inline parse (rather
    // than receiveParsed) so a malformed frame can be answered with an
    // abort-with-reasons message before we throw, rather than stranding the
    // initiator until its receive timeout.
    const rawData = await conn.receive();

    let partnerTerms: LinkageTerms;
    let partnerSaveIntent = false;
    let partnerHostKey: PresentedHostKey | undefined;
    let partnerHostKeyMalformed = false;
    let parseError: string | undefined;
    try {
      const parsed = termsMessage.parse(rawData);
      partnerSaveIntent = parsed.save === true;
      partnerHostKey = parsed.hostKey.value;
      partnerHostKeyMalformed = parsed.hostKey.malformed;
      partnerTerms = parseLinkageTerms(parsed.linkageTerms);
    } catch (parseErr) {
      // describeDecodeError escapes the partner-controlled Zod issue path at the
      // source (the `invalid_key`/bounded-`z.record`-key path included) and
      // relays the schema-fixed message text -- see the parse-error note in the
      // initiator branch above.
      parseError = describeDecodeError(parseErr);
    }

    const { errors, warnings } =
      parseError !== undefined
        ? {
            errors: [`partner linkage terms failed to parse: ${parseError}`],
            warnings: [],
          }
        : validateCompatibility(localTerms, partnerTerms!);

    if (errors.length > 0) {
      await sendAbort(conn, errors, localTerms);
      throw new Error(`linkage terms are incompatible: ${errors.join("; ")}`);
    }

    // Message 2: send our terms + proceed decision (carrying our save intent
    // and observed host key).
    await conn.send({
      linkageTerms: localTerms,
      decision: "proceed",
      ...saveField,
      ...hostKeyField,
    });

    // Message 3: receive initiator's final decision.
    const msg = await receiveParsed(conn, decisionMessage);
    if (msg.decision === "abort") {
      throw new Error(
        "partner aborted linkage terms exchange" +
          (msg.abortReasons?.length
            ? `: ${msg.abortReasons.map((r) => sanitizeForDisplay(r)).join("; ")}`
            : ""),
      );
    }

    return {
      partnerTerms: partnerTerms!,
      warnings,
      partnerSaveIntent,
      partnerHostKey,
      partnerHostKeyMalformed,
    };
  }
}

// --- Shared-secret bootstrap -------------------------------------------------

/**
 * Establish a fresh persistent shared secret in-band, for a zero-setup exchange
 * in which BOTH parties passed `--save`. The initiator generates the token and
 * transmits it on a dedicated frame; the responder receives it. Both ends return
 * the same value, which the caller persists to its key file as the basis for
 * future recurring exchanges.
 *
 * Call this only when both parties advertised save intent (see
 * {@link exchangeTerms}). Both sides learn that fact from the terms exchange, so
 * they agree on whether this single frame is sent without further negotiation;
 * sending it directly after terms means the initiator emits message 3 of the
 * terms exchange and then this frame back-to-back, the same speaker-stutter the
 * record-count step already performs.
 *
 * The secret is a base64url-encoded 32 random bytes -- the same format as a
 * rotation token (see auth.ts) and {@link SHARED_SECRET_REGEX} -- so it drops
 * straight into the key file. On a zero-setup exchange there is no application-
 * layer AEAD, so this frame is protected only by the transport (SSH for SFTP,
 * DTLS for WebRTC, operator access controls for a file-drop). That is the
 * documented, accepted trust model for `--save`: the bootstrap relies on the
 * same transport trust as the zero-setup exchange carrying it (see
 * docs/SECURITY_DESIGN.md "Bootstrapping a shared secret"). A party that wants
 * the secret never to traverse the server uses `psilink invite` instead.
 *
 * @returns the established shared secret, identical on both sides.
 */
export async function exchangeBootstrapSecret(
  conn: MessageConnection,
  handshakeRole: HandshakeRole,
): Promise<string> {
  if (handshakeRole === "initiator") {
    const sharedSecret = toBase64Url(randomBytes(32));
    await conn.send({ sharedSecret });
    return sharedSecret;
  }
  const msg = await receiveParsed(conn, sharedSecretMessage);
  return msg.sharedSecret;
}

// --- Role resolution ---------------------------------------------------------

function pickRole(
  localCount: number,
  partnerCount: number,
  handshakeRole: HandshakeRole,
): PsiRole {
  if (localCount < partnerCount) return "receiver";
  if (localCount > partnerCount) return "sender";
  // Tie: initiator -> receiver.
  return handshakeRole === "initiator" ? "receiver" : "sender";
}

/**
 * Determine this party's PSI role after terms have been agreed. When exactly
 * one party has `expectsOutput: true` the role follows directly from the terms.
 * When both parties expect output, record counts are exchanged over the
 * connection so that the smaller dataset becomes the receiver (minimising data
 * transmitted); a tie is broken in favour of the initiator becoming the
 * receiver.
 *
 * Call this immediately after a successful {@link exchangeTerms}.
 */
export async function resolveRole(
  conn: MessageConnection,
  handshakeRole: HandshakeRole,
  localOutput: Output,
  partnerOutput: Output,
  localRecordCount: number,
): Promise<PsiRole> {
  if (localOutput.expectsOutput && !partnerOutput.expectsOutput)
    return "receiver";
  if (!localOutput.expectsOutput && partnerOutput.expectsOutput)
    return "sender";

  // Both expect output: exchange record counts. Initiator sends first;
  // responder receives first then sends.
  if (handshakeRole === "initiator") {
    await conn.send({ recordCount: localRecordCount });
    const msg = await receiveParsed(conn, recordCountMessage);
    return pickRole(localRecordCount, msg.recordCount, handshakeRole);
  } else {
    const msg = await receiveParsed(conn, recordCountMessage);
    await conn.send({ recordCount: localRecordCount });
    return pickRole(localRecordCount, msg.recordCount, handshakeRole);
  }
}
