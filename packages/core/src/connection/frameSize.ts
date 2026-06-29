/**
 * Maximum size, in bytes, of a single inbound frame the transport will read
 * into memory. Enforced at the transport read layer -- the `get()` calls in
 * {@link FileSyncConnection}'s poll loop and rendezvous gate, backed by a hard
 * per-read byte cap in each {@link FileTransportClient} adapter -- so an
 * oversized file is refused before it is ingested. This closes the
 * memory-exhaustion denial of service a hostile SFTP/filedrop server admin
 * (an adversary under the threat model in docs/SECURITY_DESIGN.md) could
 * otherwise mount by writing an arbitrarily large frame file: without the bound
 * the read allocates a byte array proportional to the attacker-chosen file
 * size. See docs/spec/CHANNEL_SECURITY.md.
 *
 * Value: 536,870,888 bytes (~512 MiB). This is a chosen memory bound, NOT a
 * derived platform ceiling. It once equalled Node's maximum string length
 * (`buffer.constants.MAX_STRING_LENGTH` on 64-bit) because the read path
 * `.toString()`d each frame before parsing it (through `parseBoundedJson`) and
 * `Buffer.prototype.toString()` throws above that length, so the string limit
 * was the true hard ceiling and anchoring the cap there avoided rejecting any
 * frame the transport could otherwise decode. That anchor is now void: the
 * transport carries a binary frame as raw bytes and never stringifies it (the
 * AEAD envelope and the file-sync message body are both binary; see
 * encryptedMessageConnection.ts and fileSyncConnection.ts), so a frame larger
 * than the former string limit can be read. The numeric value is retained
 * unchanged -- still a reasonable ~512 MiB single-frame memory cap -- pending a
 * separate rework that derives the single-pass frame cap from the exchanged
 * record counts up to a fixed maximum dataset size (board item 206154573); the
 * value is set there, not here.
 *
 * It is fixed rather than configurable: a configurable bound risks an operator
 * raising it high enough to reintroduce the DoS. The literal is hard-coded
 * rather than read from `buffer.constants` so this module stays platform-neutral
 * (it is imported by the transport-agnostic AEAD decorator, which must not pull
 * in Node's `buffer` module).
 *
 * Headroom against the realistic worst-case legitimate frame: the largest PSI
 * frame is one party's full encrypted set sent as raw elliptic-curve points
 * (~35 bytes/element serialized on the wire; see docs/spec/PROTOCOL.md). With no
 * base64 expansion the on-wire frame is its raw size plus a small fixed envelope,
 * so 512 MiB carries on the order of 15 million elements -- already more than the
 * single-frame single-pass transport practically ships before the separate
 * single-pass dataset ceiling binds.
 */
export const MAX_FRAME_SIZE_BYTES = 536_870_888;
