import * as z from "zod";

import type { Connection, HandshakeRole, PsiRole } from "./types";
import type { LinkageTerms, Output } from "./config/linkageTerms";
import {
  parseLinkageTerms,
  validateCompatibility,
} from "./config/linkageTerms";

// Wraps an `error` emitted while no listener was attached (i.e. between this
// helper's registration calls and a prior receive cycle). Returns the error
// as an Error instance, or undefined if no buffered error is pending.
function takeBufferedConnectionError(conn: Connection): Error | undefined {
  const buffered = conn.takeBufferedError();
  if (buffered === undefined) return undefined;
  return buffered instanceof Error ? buffered : new Error(String(buffered));
}

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
  conn: Connection,
  handshakeRole: HandshakeRole,
  localTerms: LinkageTerms,
): Promise<TermsExchangeResult> {
  if (handshakeRole === "initiator") {
    return new Promise((resolve, reject) => {
      const buffered = takeBufferedConnectionError(conn);
      if (buffered) {
        reject(buffered);
        return;
      }
      const cleanupListeners = () => {
        conn.removeListener("data", handleData, undefined, true);
        conn.removeListener("error", onError, undefined, true);
      };
      const onError = (err: unknown) => {
        conn.removeListener("data", handleData, undefined, true);
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const handleData = async (rawData: unknown) => {
        conn.removeListener("error", onError, undefined, true);
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
                (parseErr instanceof Error
                  ? parseErr.message
                  : String(parseErr)),
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

      // Register the response listener BEFORE sending so that a fast partner
      // cannot deliver msg2 in the window before our listener attaches. The
      // `data` event has no listener-gap buffering (see Connection in
      // types.ts); listener-first is the only safe ordering.
      conn.once("error", onError);
      conn.once("data", handleData);

      // `conn.send` is typed `void | Promise<void>`; a synchronous throw would
      // not be caught by `.catch` if it happened before Promise wrapping.
      // Capture the result explicitly so all failure paths converge on the
      // same cleanup-and-reject branch.
      let sendResult: void | Promise<void>;
      try {
        sendResult = conn.send({ linkageTerms: localTerms });
      } catch (err) {
        cleanupListeners();
        reject(err);
        return;
      }
      Promise.resolve(sendResult).catch((err) => {
        cleanupListeners();
        reject(err);
      });
    });
  } else {
    return new Promise((resolve, reject) => {
      const buffered = takeBufferedConnectionError(conn);
      if (buffered) {
        reject(buffered);
        return;
      }
      const onError1 = (err: unknown) => {
        conn.removeListener("data", handleData1, undefined, true);
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const handleData1 = async (rawData: unknown) => {
        conn.removeListener("error", onError1, undefined, true);
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
          // Abort delivery is best-effort: if the send fails (transport
          // error coinciding with terms incompatibility), the partner
          // hits the receive timeout. Swallow that failure so the
          // local rejection below — which carries the actual
          // diagnostic — is always observed. Without this guard, a
          // throw from `await conn.send` would leave the outer Promise
          // pending forever because the responder's `handleData1`
          // never reaches `reject(...)`.
          try {
            await conn.send({
              linkageTerms: localTerms,
              decision: "abort",
              abortReasons: errors,
            });
          } catch {
            /* see comment above */
          }
          reject(
            new Error(`linkage terms are incompatible: ${errors.join("; ")}`),
          );
          return;
        }

        // Register the msg3 listener BEFORE sending msg2 so that a fast
        // initiator cannot deliver msg3 in the window before our listener
        // attaches. `data` events with no listener attached are silently
        // dropped (see Connection in types.ts).
        const buffered3 = takeBufferedConnectionError(conn);
        if (buffered3) {
          reject(buffered3);
          return;
        }
        const cleanupListeners3 = () => {
          conn.removeListener("data", handleData3, undefined, true);
          conn.removeListener("error", onError3, undefined, true);
        };
        const onError3 = (err: unknown) => {
          conn.removeListener("data", handleData3, undefined, true);
          reject(err instanceof Error ? err : new Error(String(err)));
        };
        const handleData3 = (rawData: unknown) => {
          conn.removeListener("error", onError3, undefined, true);
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
        };
        conn.once("error", onError3);
        conn.once("data", handleData3);

        let sendResult: void | Promise<void>;
        try {
          sendResult = conn.send({
            linkageTerms: localTerms,
            decision: "proceed",
          });
        } catch (err) {
          cleanupListeners3();
          reject(err);
          return;
        }
        Promise.resolve(sendResult).catch((err) => {
          cleanupListeners3();
          reject(err);
        });
      };

      conn.once("error", onError1);
      conn.once("data", handleData1);
    });
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
    return new Promise((resolve, reject) => {
      const buffered = takeBufferedConnectionError(conn);
      if (buffered) {
        reject(buffered);
        return;
      }
      const cleanupListeners = () => {
        conn.removeListener("data", handleData, undefined, true);
        conn.removeListener("error", onError, undefined, true);
      };
      const onError = (err: unknown) => {
        conn.removeListener("data", handleData, undefined, true);
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const handleData = (rawData: unknown) => {
        conn.removeListener("error", onError, undefined, true);
        try {
          const msg = recordCountMessage.parse(rawData);
          resolve(pickRole(localRecordCount, msg.recordCount, handshakeRole));
        } catch (err) {
          reject(err);
        }
      };
      // Register the response listener BEFORE sending so that a fast partner
      // cannot deliver their recordCount in the window before our listener
      // attaches (see notes on the data-event listener gap in types.ts).
      conn.once("error", onError);
      conn.once("data", handleData);

      let sendResult: void | Promise<void>;
      try {
        sendResult = conn.send({ recordCount: localRecordCount });
      } catch (err) {
        cleanupListeners();
        reject(err);
        return;
      }
      Promise.resolve(sendResult).catch((err) => {
        cleanupListeners();
        reject(err);
      });
    });
  } else {
    return new Promise((resolve, reject) => {
      const buffered = takeBufferedConnectionError(conn);
      if (buffered) {
        reject(buffered);
        return;
      }
      const onError = (err: unknown) => {
        conn.removeListener("data", handleData, undefined, true);
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const handleData = async (rawData: unknown) => {
        conn.removeListener("error", onError, undefined, true);
        try {
          const msg = recordCountMessage.parse(rawData);
          await conn.send({ recordCount: localRecordCount });
          resolve(pickRole(localRecordCount, msg.recordCount, handshakeRole));
        } catch (err) {
          reject(err);
        }
      };
      conn.once("error", onError);
      conn.once("data", handleData);
    });
  }
}
