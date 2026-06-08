/**
 * Maximum size, in bytes, of a single inbound frame the transport will read
 * into memory. Enforced at the transport read layer -- the `get()` calls in
 * {@link FileSyncConnection}'s poll loop and rendezvous gate, backed by a hard
 * per-read byte cap in each {@link FileTransportClient} adapter -- so an
 * oversized file is refused before it is ingested. This closes the
 * memory-exhaustion denial of service a hostile SFTP/filedrop server admin
 * (an adversary under the threat model in docs/SECURITY_DESIGN.md) could
 * otherwise mount by writing an arbitrarily large ciphertext file: without the
 * bound the read allocates a string and byte array proportional to the
 * attacker-chosen file size. See docs/SECURITY_DESIGN.md, "Channel security".
 *
 * Value: 536,870,888 bytes (~512 MiB), the exact value of Node's maximum string
 * length (`buffer.constants.MAX_STRING_LENGTH` on 64-bit). That length is the
 * hard ceiling above which the existing JSON-text read path cannot process a
 * frame at all: both read sites do `JSON.parse(buffer.toString())`, and
 * `Buffer.prototype.toString()` throws above MAX_STRING_LENGTH. Anchoring the
 * cap there means it (a) never rejects a frame the transport could otherwise
 * decode -- anything larger already fails at `.toString()` regardless of memory
 * -- and (b) converts that late, opaque failure (raised only after the full,
 * attacker-sized buffer is already resident) into an early, clean refusal
 * before the allocation. The value is a deliberately derived platform ceiling,
 * not a round constant, and is fixed rather than configurable: a configurable
 * bound risks an operator raising it high enough to reintroduce the DoS.
 *
 * The literal is hard-coded rather than read from `buffer.constants` so this
 * module stays platform-neutral (it is imported by the transport-agnostic AEAD
 * decorator, which must not pull in Node's `buffer` module). MAX_STRING_LENGTH
 * has been this value on 64-bit Node for the project's supported range; a 32-bit
 * runtime would have a smaller string limit, in which case `.toString()` -- not
 * this cap -- would be the binding ceiling, which is still safe (a frame that
 * passes this cap but exceeds the smaller string limit is rejected at the parse
 * rather than read unbounded).
 *
 * Headroom against the realistic worst-case legitimate frame: the largest PSI
 * frame is one party's full encrypted set sent as raw elliptic-curve points
 * (~64 bytes/element; see docs/PROTOCOL.md), base64url-expanded by 4/3 on the
 * wire. 512 MiB of wire text decodes to ~384 MiB raw -- on the order of 6
 * million elements -- which is already more than this single-frame JSON-text
 * transport can carry, since a larger set would itself exceed MAX_STRING_LENGTH
 * and require chunking before this cap could ever bind it.
 */
export const MAX_FRAME_SIZE_BYTES = 536_870_888;
