import { z } from "zod";

/**
 * Paired arrays of matched row indices produced by PSI linkage.
 *
 * `[0]` contains our (local) row indices; `[1]` contains the corresponding
 * partner row indices. Both arrays are the same length. The entries in `[0]`
 * are in strictly ascending order — this is a guaranteed invariant of
 * {@link linkViaPSI} and is relied upon by payload reconstruction.
 */
export type AssociationTable = [Array<number>, Array<number>];

/**
 * Maps a Connection event name to its listener signature.
 * `data` carries an arbitrary parsed message; `error` carries an asynchronous
 * transport failure surfaced from the poller. Synchronous failures (send and
 * synchronize) throw instead.
 */
type ConnectionEventHandler<E extends "data" | "error"> = E extends "data"
  ? (data: unknown) => void
  : (err: unknown) => void;

export type Connection = {
  on: <E extends "data" | "error">(
    event: E,
    fn: ConnectionEventHandler<E>,
    context?: undefined,
  ) => Connection;
  once: <E extends "data" | "error">(
    event: E,
    fn: ConnectionEventHandler<E>,
    context?: undefined,
  ) => Connection;
  removeListener: <E extends "data" | "error">(
    event: E,
    fn?: ConnectionEventHandler<E>,
    context?: undefined,
    once?: boolean,
  ) => Connection;
  // Hands a message to the transport. Resolution (or return, for a synchronous
  // transport) means only that the message has been accepted locally for
  // delivery: buffered into the channel (WebRTC) or durably written to the
  // shared directory (file-sync). It does NOT mean the peer has received it -
  // there is no end-to-end delivery or acknowledgement at this layer. So never
  // infer "the peer has my message" from `send` resolving. The guarantee that
  // the final frame survives teardown comes from the `close` contract below,
  // which each transport meets one of two ways: a durable send with a draining
  // close (file-sync) or a flushing close (WebRTC). See docs/COMMUNICATION.md
  // ("Message delivery and teardown").
  send: (data: unknown, chunked?: boolean) => void | Promise<void>;
  // `close` may be synchronous (e.g. a test passthrough) or asynchronous (e.g.
  // FileSyncConnection, which calls its transport client's `end()`). Callers
  // that need to wait for transport teardown MUST `await` the result.
  //
  // Delivery contract (paired with `send`): the exchange's final frame must
  // survive a clean close. Because `send` resolving does not imply the peer
  // received the message, every transport guarantees this one of two ways:
  // (a) durable send + draining close - file-sync writes durably to the shared
  // directory but the sender's cleanup can delete a file before the peer polls
  // it, so a clean close drains (waits for the peer to consume the last sent
  // file) before sweeping; or (b) flushing close - delivers frames `send`
  // accepted but has not yet put on the wire before teardown completes (WebRTC).
  // A transport that does neither silently drops final frames. An error close
  // never flushes: an errored link is already unusable.
  close: () => void | Promise<void>;
  // An `error` emitted while no listener is registered is retained here so
  // the next protocol-layer receive can detect failures that arrived in the
  // gap between listener-registration cycles. Reading clears the value; only
  // the most recent unhandled error is retained.
  //
  // Asymmetric with `data`: there is no `takeBufferedData`. A `data` event
  // emitted while no listener is registered is silently dropped. Protocol
  // callers must therefore register `data` listeners synchronously before
  // any await that could yield to the transport's poll cycle, AND before
  // the peer has cause to send the next message. The established pattern
  // (see kex.ts / protocolSetup.ts / payloadExchange.ts) is that each
  // receive helper installs its `once("data", ...)` listener inside the
  // Promise executor — synchronously after any prior receive resolves —
  // so no transport macrotask can interleave between consumption of one
  // message and registration for the next.
  takeBufferedError: () => unknown;
};

export type Role = "starter" | "joiner" | "either";
export type HandshakeRole = "initiator" | "responder";

export interface Config {
  role: Role;
  verbose?: number;
}

export const AlgorithmSchema = z.enum(["psi", "psi-c"]);
export type Algorithm = z.infer<typeof AlgorithmSchema>;

export const PsiRoleSchema = z.enum(["sender", "receiver"]);
export type PsiRole = z.infer<typeof PsiRoleSchema>;

export const SEMANTIC_TYPES = [
  "ssn",
  "ssn4",
  "firstName",
  "lastName",
  "dateOfBirth",
  "identifier",
  "phoneNumber",
  "emailAddress",
  "other",
] as const;

export type SemanticType = (typeof SEMANTIC_TYPES)[number];

export type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};
