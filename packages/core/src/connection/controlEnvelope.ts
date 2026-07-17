import * as z from "zod";

/**
 * Hello payload envelope: the two bilateral mode flags each party advertises at
 * rendezvous. The peer compares them against its own configuration
 * at every site where it reads a peer hello and fails fast on a mismatch, so a
 * divergent pairing does not stall silently until the peer timeout.
 *
 * The hello is the sole payload-bearing control file. The acknowledgment marker
 * (the lockless rendezvous ack and the retain-mode message ack) is a
 * zero-length file matched by name existence and carries no body, so there is
 * no base envelope below this one and no serialized empty `{}` body anywhere on
 * the transport.
 *
 * Both flags are REQUIRED: there is no `protocol_version` and no defaulting.
 * Both parties run matching builds (see FILE_SYNC.md "Matching builds"), so a
 * conforming peer always sends both. A fully-synced hello missing either flag,
 * or carrying an out-of-type value, fails {@link HelloEnvelopeSchema} as a
 * terminal `UsageError` on the reading party -- there is no "treat an absent
 * flag as `false`" path.
 *
 * Field names are camelCase on disk: a control file is a protocol message, not
 * user-facing schema, so the snake_case-in-YAML config convention does not
 * apply and there is no `camelizeKeys` conversion on the serialize or parse
 * path. A later envelope-field addition must stay camelCase to match.
 */
export interface HelloEnvelope {
  /**
   * This party's `lockless_rendezvous` setting. Bilateral: the peer must
   * advertise the same value or rendezvous fails fast.
   */
  locklessRendezvous: boolean;
  /**
   * This party's `retain_files` setting. Bilateral: the peer must advertise
   * the same value or rendezvous fails fast.
   */
  retainFiles: boolean;
}

/**
 * Zod schema for {@link HelloEnvelope}. Both flags are required (a missing or
 * out-of-type flag is a terminal validation failure), while unknown fields are
 * stripped for forward-tolerance: a newer peer may add an extra field without
 * breaking an older build. The `.strip()` is explicit even though it is
 * `z.object`'s default, so the forward-tolerance contract is visible at the
 * call site, not only in the JSDoc.
 *
 * Stripping unknown fields is *forward*-tolerance only. It is not a blanket
 * forward-compat guarantee -- requiring a field still rejects a body in which
 * that field is absent, which is the intended flag-day failure when builds
 * diverge on a required field (see FILE_SYNC.md "Matching builds").
 */
export const HelloEnvelopeSchema: z.ZodType<HelloEnvelope> = z
  .object({
    locklessRendezvous: z.boolean(),
    retainFiles: z.boolean(),
  })
  .strip();

/**
 * Serializes a {@link HelloEnvelope} to a `Buffer` for writing via
 * `FileTransportClient.put`. The body is written verbatim with no key-case
 * conversion: control-file fields are already camelCase on disk. The hello is
 * the only control file with a body -- the ack marker is zero-length and is
 * never serialized through here.
 */
export const serializeEnvelope = (envelope: HelloEnvelope): Buffer =>
  Buffer.from(JSON.stringify(envelope));
