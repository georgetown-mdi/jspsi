import * as z from "zod";

/**
 * Base payload envelope: the empty body written into a control file that
 * carries no application fields, currently the lockless hello-ack. The hello
 * tightens this into {@link HelloEnvelope} (the two bilateral mode flags); a
 * later item (194304738) may add an ack-to-peer binding on top of this base.
 *
 * Field names are camelCase on disk: a control file is a protocol message, not
 * user-facing schema, so the snake_case-in-YAML config convention does not
 * apply and there is no `camelizeKeys` conversion on the serialize or parse
 * path.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- intentionally empty; the ack carries no fields, and the hello extends this in HelloEnvelope
export interface ControlFileEnvelope {}

/**
 * Zod schema for {@link ControlFileEnvelope}. Accepts any JSON object,
 * stripping unknown fields. Used by the read gate to distinguish a
 * fully-synced body that fails validation (terminal `UsageError`) from a
 * partially-synced body (retried until the peer timeout).
 *
 * Stripping unknown fields is *forward*-tolerance only: it lets a newer peer
 * add an extra field without breaking an older build. It is not a blanket
 * forward-compat guarantee -- a schema that requires a field (as
 * {@link HelloEnvelopeSchema} does) still rejects a body in which that field is
 * absent, which is the intended flag-day failure when builds diverge on a
 * required field (see FILE_SYNC.md "Matching builds").
 */
export const ControlFileEnvelopeSchema: z.ZodType<ControlFileEnvelope> = z
  .object({})
  .strip();

/**
 * Hello payload envelope: the base envelope tightened with the two bilateral
 * mode flags each party advertises at rendezvous (193901017). The peer compares
 * them against its own configuration at every site where it reads a peer hello
 * and fails fast on a mismatch, so a divergent pairing does not stall silently
 * until the peer timeout.
 *
 * Both flags are REQUIRED: there is no `protocol_version` and no defaulting.
 * Both parties run matching builds (see FILE_SYNC.md "Matching builds"), so a
 * conforming peer always sends both. A fully-synced hello missing either flag,
 * or carrying an out-of-type value, fails {@link HelloEnvelopeSchema} as a
 * terminal `UsageError` on the reading party -- there is no "treat an absent
 * flag as `false`" path.
 *
 * The fields are camelCase on disk, matching their TypeScript names, for the
 * same protocol-message reason given on {@link ControlFileEnvelope}.
 */
export interface HelloEnvelope extends ControlFileEnvelope {
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
 * still stripped for the same forward-tolerance reason as the base schema. The
 * `.strip()` is explicit even though it is `z.object`'s default, so the
 * forward-tolerance contract is visible at the call site, not only in the
 * JSDoc.
 */
export const HelloEnvelopeSchema: z.ZodType<HelloEnvelope> = z
  .object({
    locklessRendezvous: z.boolean(),
    retainFiles: z.boolean(),
  })
  .strip();

/**
 * Serializes a {@link ControlFileEnvelope} (or a subtype such as
 * {@link HelloEnvelope}) to a `Buffer` for writing via
 * `FileTransportClient.put`. The body is written verbatim with no key-case
 * conversion: control-file fields are already camelCase on disk.
 */
export const serializeEnvelope = (envelope: ControlFileEnvelope): Buffer =>
  Buffer.from(JSON.stringify(envelope));
