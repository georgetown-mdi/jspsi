import * as z from "zod";

import type { Connection, HandshakeRole, PsiRole } from "./types";
import type { LinkageTerms, Output } from "./config/linkageTerms";
import {
  parseLinkageTerms,
  validateCompatibility,
} from "./config/linkageTerms";

// ─── Message schemas ──────────────────────────────────────────────────────

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

// ─── Terms exchange ───────────────────────────────────────────────────────

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
  conn: Connection,
  handshakeRole: HandshakeRole,
  localTerms: LinkageTerms,
): Promise<TermsExchangeResult> {
  if (handshakeRole === "initiator") {
    await conn.send({ linkageTerms: localTerms });

    return new Promise((resolve, reject) => {
      const handleData = async (rawData: unknown) => {
        try {
          const msg = termsWithDecisionMessage.parse(rawData);

          if (msg.decision === "abort") {
            throw new Error(
              "partner aborted linkage terms exchange" +
                (msg.abortReasons?.length
                  ? `: ${msg.abortReasons.join("; ")}`
                  : ""),
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

          const { errors, warnings } = validateCompatibility(
            localTerms,
            partnerTerms,
          );

          if (errors.length > 0) {
            await conn.send({ decision: "abort", abortReasons: errors });
            throw new Error(
              `linkage terms are incompatible: ${errors.join("; ")}`,
            );
          }

          await conn.send({ decision: "proceed" });

          resolve({ partnerTerms, warnings });
        } catch (err) {
          reject(err);
        }
      };

      conn.once("data", handleData);
    });
  } else {
    return new Promise((resolve, reject) => {
      conn.once("data", async (rawData: unknown) => {
        // Message 1: parse partner's terms, validate, send message 2.
        let partnerTerms: LinkageTerms;

        let parseError: string | undefined;
        try {
          partnerTerms = parseLinkageTerms(
            termsMessage.parse(rawData).linkageTerms,
          );
        } catch (parseErr) {
          parseError =
            parseErr instanceof Error ? parseErr.message : String(parseErr);
        }

        const { errors, warnings } =
          parseError !== undefined
            ? {
                errors: [
                  `partner linkage terms failed to parse: ${parseError}`,
                ],
                warnings: [],
              }
            : validateCompatibility(localTerms, partnerTerms!);

        if (errors.length > 0) {
          await conn.send({
            linkageTerms: localTerms,
            decision: "abort",
            abortReasons: errors,
          });
          reject(
            new Error(`linkage terms are incompatible: ${errors.join("; ")}`),
          );
          return;
        }

        try {
          await conn.send({ linkageTerms: localTerms, decision: "proceed" });
        } catch (err) {
          reject(err);
          return;
        }

        // Message 3: initiator's final decision.
        conn.once("data", (rawData: unknown) => {
          // catch parse errors and throw logic ones
          try {
            const msg = decisionMessage.parse(rawData);

            if (msg.decision === "abort") {
              throw new Error(
                "partner aborted linkage terms exchange" +
                  (msg.abortReasons?.length
                    ? `: ${msg.abortReasons.join("; ")}`
                    : ""),
              );
            }

            resolve({ partnerTerms: partnerTerms!, warnings: warnings });
          } catch (err) {
            reject(err);
          }
        });
      });
    });
  }
}

// ─── Role resolution ─────────────────────────────────────────────────────────

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
  conn: Connection,
  handshakeRole: HandshakeRole,
  localOutput: Output,
  partnerOutput: Output,
  localRecordCount: number,
): Promise<PsiRole> {
  if (localOutput.expectsOutput && !partnerOutput.expectsOutput)
    return "receiver";
  if (!localOutput.expectsOutput && partnerOutput.expectsOutput)
    return "sender";

  // Both expect output: exchange record counts.
  if (handshakeRole === "initiator") {
    await conn.send({ recordCount: localRecordCount });

    return new Promise((resolve, reject) => {
      const handleData = (rawData: unknown) => {
        try {
          const msg = recordCountMessage.parse(rawData);
          resolve(pickRole(localRecordCount, msg.recordCount, handshakeRole));
        } catch (err) {
          reject(err);
        }
      };
      conn.once("data", handleData);
    });
  } else {
    return new Promise((resolve, reject) => {
      const handleData = async (rawData: unknown) => {
        try {
          const msg = recordCountMessage.parse(rawData);
          await conn.send({ recordCount: localRecordCount });
          resolve(pickRole(localRecordCount, msg.recordCount, handshakeRole));
        } catch (err) {
          reject(err);
        }
      };
      conn.once("data", handleData);
    });
  }
}
