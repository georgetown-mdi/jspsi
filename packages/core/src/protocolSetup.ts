import * as z from "zod";

import type { HandshakeRole, PsiRole } from "./types";
import type { LinkageTerms, Output } from "./config/linkageTerms";
import {
  parseLinkageTerms,
  validateCompatibility,
} from "./config/linkageTerms";
import {
  receiveParsed,
  type MessageConnection,
} from "./connection/messageConnection";

// --- Message schemas ---------------------------------------------------------

const termsMessage = z.object({
  linkageTerms: z.unknown(),
});

const termsWithDecisionMessage = z.object({
  linkageTerms: z.unknown(),
  decision: z.enum(["proceed", "abort"]),
  abortReasons: z.array(z.string()).optional(),
});

const decisionMessage = z.object({
  decision: z.enum(["proceed", "abort"]),
  abortReasons: z.array(z.string()).optional(),
});

const recordCountMessage = z.object({
  recordCount: z.number().int().nonnegative(),
});

// --- Terms exchange ----------------------------------------------------------

export interface TermsExchangeResult {
  partnerTerms: LinkageTerms;
  warnings: string[];
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
 */
export async function exchangeTerms(
  conn: MessageConnection,
  handshakeRole: HandshakeRole,
  localTerms: LinkageTerms,
): Promise<TermsExchangeResult> {
  if (handshakeRole === "initiator") {
    // Message 1: send our terms.
    await conn.send({ linkageTerms: localTerms });

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
      await conn.send({
        decision: "abort",
        abortReasons: ["partner linkage terms failed to parse"],
      });
      throw new Error(
        "partner linkage terms failed to parse: " +
          (parseErr instanceof Error ? parseErr.message : String(parseErr)),
      );
    }

    const { errors, warnings } = validateCompatibility(localTerms, partnerTerms);

    if (errors.length > 0) {
      await conn.send({ decision: "abort", abortReasons: errors });
      throw new Error(`linkage terms are incompatible: ${errors.join("; ")}`);
    }

    // Message 3: send our proceed decision.
    await conn.send({ decision: "proceed" });

    return { partnerTerms, warnings };
  } else {
    // Message 1: receive partner's terms. Raw receive + inline parse (rather
    // than receiveParsed) so a malformed frame can be answered with an
    // abort-with-reasons message before we throw, rather than stranding the
    // initiator until its receive timeout.
    const rawData = await conn.receive();

    let partnerTerms: LinkageTerms;
    let parseError: string | undefined;
    try {
      partnerTerms = parseLinkageTerms(termsMessage.parse(rawData).linkageTerms);
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
      // Abort delivery is best-effort: if the send fails (transport error
      // coinciding with terms incompatibility), the partner hits the receive
      // timeout. Swallow that failure so the local throw below — which carries
      // the actual diagnostic — is always observed.
      try {
        await conn.send({
          linkageTerms: localTerms,
          decision: "abort",
          abortReasons: errors,
        });
      } catch {
        /* see comment above */
      }
      throw new Error(`linkage terms are incompatible: ${errors.join("; ")}`);
    }

    // Message 2: send our terms + proceed decision.
    await conn.send({ linkageTerms: localTerms, decision: "proceed" });

    // Message 3: receive initiator's final decision.
    const msg = await receiveParsed(conn, decisionMessage);
    if (msg.decision === "abort") {
      throw new Error(
        "partner aborted linkage terms exchange" +
          (msg.abortReasons?.length ? `: ${msg.abortReasons.join("; ")}` : ""),
      );
    }

    return { partnerTerms: partnerTerms!, warnings };
  }
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
