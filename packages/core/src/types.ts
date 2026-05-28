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
  send: (data: unknown, chunked?: boolean) => void | Promise<void>;
  // `close` may be synchronous (e.g. a test passthrough) or asynchronous (e.g.
  // FileSyncConnection, which calls its transport client's `end()`). Callers
  // that need to wait for transport teardown MUST `await` the result.
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
  // (see pake.ts / protocolSetup.ts / payloadExchange.ts) is that each
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
