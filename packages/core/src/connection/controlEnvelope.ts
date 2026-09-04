import * as z from "zod";

/**
 * Hello payload envelope: the two bilateral mode flags each party advertises
 * at rendezvous. The peer compares them at every site it reads a peer hello
 * and fails fast on a mismatch, so a divergent pairing never stalls silently
 * until the peer timeout.
 *
 * The hello is the only payload-bearing control file; the acknowledgment
 * marker is a zero-length file matched by name, with no body to envelope.
 *
 * Both flags are required, with no `protocol_version` and no defaulting: a
 * hello missing either, or holding an out-of-type value, fails
 * {@link HelloEnvelopeSchema} as a terminal `UsageError`.
 *
 * Field names are camelCase on disk, since a control file is a protocol
 * message rather than user-facing schema, so there is no `camelizeKeys`
 * conversion; a later field added here must also stay camelCase.
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
 * Zod schema for {@link HelloEnvelope}. Both flags are required -- a missing
 * or out-of-type flag is a terminal validation failure -- while unknown
 * fields are stripped for forward tolerance: a newer peer may add a field
 * without breaking an older build. `.strip()` is explicit, though it is
 * `z.object`'s default, so the contract is visible at the call site.
 *
 * This is forward tolerance only, not a compatibility guarantee: a body
 * missing a required field still fails, the intended result when builds
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
