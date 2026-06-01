import * as z from "zod";

/**
 * Payload envelope written as a JSON body into every control file that
 * requires partial-sync protection: the hello file (both rendezvous branches)
 * and the lockless hello-ack. The initial envelope carries no application
 * fields; downstream items add their fields here (193901017 adds bilateral
 * mode flags; 194304738 adds the ack-to-peer binding).
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- intentionally empty; 193901017 and 194304738 add fields
export interface ControlFileEnvelope {}

/**
 * Zod schema for {@link ControlFileEnvelope}. Accepts any JSON object,
 * stripping unknown fields. Used by the read gate to distinguish a
 * fully-synced body that fails validation (terminal
 * `UsageError`) from a partially-synced body (retried until the peer
 * timeout). Unknown fields are stripped rather than rejected so that a peer
 * running a newer build does not cause a schema failure in an older build;
 * required fields added by downstream items will tighten this as needed.
 */
export const ControlFileEnvelopeSchema: z.ZodType<ControlFileEnvelope> =
  z.object({});

/**
 * Serializes a {@link ControlFileEnvelope} to a `Buffer` for writing via
 * {@link FileTransportClient.put}.
 */
export const serializeEnvelope = (envelope: ControlFileEnvelope): Buffer =>
  Buffer.from(JSON.stringify(envelope));
