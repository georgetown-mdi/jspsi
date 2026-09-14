// The PSI rounds are the only place a party reads a raw byte frame off the
// wire and hands it to the PSI library, which rejects anything that is not a
// byte string with its own decode message and no psilink framing. Two kinds of
// frame arrive here that the round did not ask for, so both are classified
// before any byte reaches the library:
//
//   - The partner's abort decision, which a refusal firing past the terms
//     exchange best-effort sends (see sendAbort). Those refusals are one-sided,
//     so the party reading the frame is parked on its next round and would
//     otherwise end on a decode message naming nothing it can act on.
//   - Any other frame, which keeps the cause it failed with behind a psilink
//     protocol error naming the boundary.
import { ConnectionError } from "../connection/messageConnection";
import { PeerAbortError } from "../errors";
import { isPartnerAbortFrame } from "../protocolSetup";

import type { MessageConnection } from "../connection/messageConnection";

/**
 * Reads the next frame where the protocol expects PSI binary, classifying
 * whatever arrives before it can reach the library's decoder.
 *
 * A partner's abort decision raises {@link PeerAbortError}: the partner ended
 * the exchange and holds the reason locally, which is the whole of what this
 * side can state. The abort's own reasons are partner-written text and are not
 * read here, so the error holds no partner byte.
 *
 * Anything else that is not a byte frame is a `protocol`
 * {@link ConnectionError} naming the frame this round awaited. It is not
 * reported as a refusal: a non-conforming peer that sends the wrong frame has
 * not refused anything.
 *
 * @param conn - The connection to read from.
 * @param participantId - This party's participant id, prefixed on the message.
 * @param what - The frame this round awaited, named in the message.
 */
export async function receivePsiBinaryFrame(
  conn: MessageConnection,
  participantId: string,
  what: string,
): Promise<Uint8Array> {
  return asPsiBinaryFrame(await conn.receive(), participantId, what);
}

function asPsiBinaryFrame(
  frame: unknown,
  participantId: string,
  what: string,
): Uint8Array {
  if (frame instanceof Uint8Array) return frame;
  if (isPartnerAbortFrame(frame)) throw new PeerAbortError();
  throw new ConnectionError(
    `${participantId} protocol error: inbound PSI ${what} is not a binary ` +
      "frame",
    "protocol",
  );
}

/**
 * Runs a PSI library decode, framing whatever it throws as a `protocol`
 * {@link ConnectionError} that names the frame and holds what failed as its
 * `cause` -- the library's own decode message, or the engine's check of the
 * structure it decoded to. A failure that is already a
 * {@link ConnectionError} is classified and passes through unchanged.
 *
 * @param participantId - This party's participant id, prefixed on the message.
 * @param what - The frame being decoded, named in the message.
 * @param decode - The decode to run.
 */
export async function decodePsiBinaryFrame<T>(
  participantId: string,
  what: string,
  decode: () => Promise<T>,
): Promise<T> {
  try {
    return await decode();
  } catch (err) {
    if (err instanceof ConnectionError) throw err;
    throw new ConnectionError(
      `${participantId} protocol error: inbound PSI ${what} failed to decode`,
      "protocol",
      { cause: err },
    );
  }
}
