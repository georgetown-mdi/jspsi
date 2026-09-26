// The send-side half of the file-sync inbound frame bound
// (docs/spec/FILE_SYNC.md, "Round set size limits"): the arithmetic a sender
// uses to refuse a PSI set whose message file the partner's read gate would
// refuse, before the file is written. The first-round count check and the
// per-round check on the built frame both size a set against
// `MAX_FRAME_SIZE_BYTES`, the bound every file-sync receiver applies.

import { AEAD_ENVELOPE_OVERHEAD_BYTES } from "./encryptedMessageConnection";
import { MESSAGE_HEADER_BYTES } from "./fileSyncFraming";
import { MAX_FRAME_SIZE_BYTES } from "./frameSize";
import {
  PSI_ENCODED_ELEMENT_BYTES,
  PSI_SET_MAX_FRAMING_BYTES,
} from "./webrtcOutboundBound";

/**
 * The most values one PSI set in an SFTP or synced-folder message file can
 * hold under a frame bound of `maxFrameBytes`, whichever round's message
 * holds the set.
 */
export function fileSyncMaxRoundSetValues(
  maxFrameBytes: number = MAX_FRAME_SIZE_BYTES,
): number {
  // File header 10 + AEAD envelope 30 + setup framing 6, then 35 per value.
  const perFileBytes =
    MESSAGE_HEADER_BYTES +
    AEAD_ENVELOPE_OVERHEAD_BYTES +
    PSI_SET_MAX_FRAMING_BYTES;
  return Math.floor((maxFrameBytes - perFileBytes) / PSI_ENCODED_ELEMENT_BYTES);
}

/**
 * The size of the message file that holds a frame of `frameBytes`, sent inside
 * an envelope of `envelopeBytes`: the size the receiver's read gate compares
 * against its bound.
 */
export function fileSyncMessageFileBytes(
  frameBytes: number,
  envelopeBytes: number,
): number {
  return MESSAGE_HEADER_BYTES + envelopeBytes + frameBytes;
}

/**
 * The remedy every file-sync set-size refusal of this party's own set names.
 */
export const SPLIT_INPUT_REMEDY =
  "Split the input into smaller files and run one exchange for each.";

/**
 * The reason a round's refusal puts on the abort frame it sends the partner.
 * A fixed literal, like every abort reason (see `sendAbort`).
 */
export const FILE_SYNC_SET_LIMIT_ABORT_REASON =
  "a PSI set is too large for one message file";

/**
 * The refusal a round raises on a set frame it built whose message file the
 * partner's read gate would refuse. `setOwner` is whose set the frame holds:
 * this party's own, or the partner's, which the reply returns re-encrypted.
 * `elementCount` is the values the set holds, `maxValues` what one message
 * file holds ({@link fileSyncMaxRoundSetValues}).
 */
export function fileSyncBuiltSetTooLargeMessage(
  setOwner: "local" | "partner",
  elementCount: number,
  maxValues: number = fileSyncMaxRoundSetValues(),
): string {
  return setOwner === "local"
    ? "Too large for SFTP or a synced folder: the set this party sends for " +
        `this linkage key holds ${elementCount} values, over the ` +
        `${maxValues} one message file holds, so the exchange stopped ` +
        `before sending it and told your partner. ${SPLIT_INPUT_REMEDY}`
    : "Too large for SFTP or a synced folder: the reply to your partner's " +
        `set for this linkage key holds ${elementCount} values, over the ` +
        `${maxValues} one message file holds, so the exchange stopped ` +
        "before sending it and told your partner. Ask your partner to split " +
        "their input into smaller files and run one exchange for each.";
}
