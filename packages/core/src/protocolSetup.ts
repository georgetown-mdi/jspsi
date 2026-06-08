import * as z from "zod";

import type { HandshakeRole, PsiRole } from "./types";
import type { LinkageTerms, Output } from "./config/linkageTerms";
import {
  parseLinkageTerms,
  validateCompatibility,
} from "./config/linkageTerms";
import { PAKE_TOKEN_REGEX } from "./config/connection";
import { randomBytes, toBase64Url } from "./utils/crypto";
import {
  receiveParsed,
  type MessageConnection,
} from "./connection/messageConnection";

// --- Message schemas ---------------------------------------------------------

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
});

const termsWithDecisionMessage = z.object({
  linkageTerms: z.unknown(),
  decision: z.enum(["proceed", "abort"]),
  abortReasons: z.array(z.string()).optional(),
  save: z.boolean().optional(),
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
// exchangeBootstrapSecret). The token format is pinned to PAKE_TOKEN_REGEX -- a
// base64url-encoded 32-byte value -- so it is byte-for-byte the persistent
// secret that authenticateConnection rotates to and saveKeyFile persists; a
// malformed value is a `protocol` ConnectionError on the responder.
const sharedSecretMessage = z.object({
  sharedSecret: z.string().regex(PAKE_TOKEN_REGEX),
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
 */
export async function exchangeTerms(
  conn: MessageConnection,
  handshakeRole: HandshakeRole,
  localTerms: LinkageTerms,
  localSaveIntent?: boolean,
): Promise<TermsExchangeResult> {
  // Spread into the outgoing terms frame only when this party is saving, so a
  // non-save exchange sends no `save` field at all.
  const saveField = localSaveIntent === true ? { save: true } : {};

  if (handshakeRole === "initiator") {
    // Message 1: send our terms (carrying our save intent when set).
    await conn.send({ linkageTerms: localTerms, ...saveField });

    // Message 2: receive partner's terms + decision.
    const msg = await receiveParsed(conn, termsWithDecisionMessage);

    if (msg.decision === "abort") {
      throw new Error(
        "partner aborted linkage terms exchange" +
          (msg.abortReasons?.length ? `: ${msg.abortReasons.join("; ")}` : ""),
      );
    }

    let partnerTerms: LinkageTerms;
    try {
      partnerTerms = parseLinkageTerms(msg.linkageTerms);
    } catch (parseErr) {
      await sendAbort(conn, ["partner linkage terms failed to parse"]);
      throw new Error(
        "partner linkage terms failed to parse: " +
          (parseErr instanceof Error ? parseErr.message : String(parseErr)),
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

    return { partnerTerms, warnings, partnerSaveIntent: msg.save === true };
  } else {
    // Message 1: receive partner's terms. Raw receive + inline parse (rather
    // than receiveParsed) so a malformed frame can be answered with an
    // abort-with-reasons message before we throw, rather than stranding the
    // initiator until its receive timeout.
    const rawData = await conn.receive();

    let partnerTerms: LinkageTerms;
    let partnerSaveIntent = false;
    let parseError: string | undefined;
    try {
      const parsed = termsMessage.parse(rawData);
      partnerSaveIntent = parsed.save === true;
      partnerTerms = parseLinkageTerms(parsed.linkageTerms);
    } catch (parseErr) {
      parseError =
        parseErr instanceof Error ? parseErr.message : String(parseErr);
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

    // Message 2: send our terms + proceed decision (carrying our save intent).
    await conn.send({
      linkageTerms: localTerms,
      decision: "proceed",
      ...saveField,
    });

    // Message 3: receive initiator's final decision.
    const msg = await receiveParsed(conn, decisionMessage);
    if (msg.decision === "abort") {
      throw new Error(
        "partner aborted linkage terms exchange" +
          (msg.abortReasons?.length ? `: ${msg.abortReasons.join("; ")}` : ""),
      );
    }

    return { partnerTerms: partnerTerms!, warnings, partnerSaveIntent };
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
 * rotation token (see auth.ts) and {@link PAKE_TOKEN_REGEX} -- so it drops
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
