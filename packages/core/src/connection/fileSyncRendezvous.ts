// Pure rendezvous helpers for the file-sync wire protocol: the hello payload
// builder, the bilateral-mode-mismatch comparison, the peer control-file name
// recognizers, and the partial-sync-gated control-file read. Each is a pure
// function of its arguments -- it reads the two bilateral mode flags, an id, or
// a transport client passed in explicitly, holds no instance state, and does no
// I/O beyond the transport client it is handed. Keeping them here lets a unit
// test drive the rendezvous contracts directly rather than only through
// FileSyncConnection.synchronize(). This module also defines RendezvousScope,
// the per-call path/display scope the connection threads through its still-
// resident rendezvous phases.
//
// This module is deliberately NOT re-exported by the package barrel (main.ts
// barrels fileSyncConnection.ts via `export *`, not this file), so an
// `@internal` export here stays out of the package's public runtime surface
// while a unit test can deep-import it -- the same pattern as fileSyncNames.ts
// and fileSyncFraming.ts. FileSyncConnection keeps thin private wrappers that
// forward to these functions, so the call sites in its rendezvous methods are
// unchanged.

import * as z from "zod";

import { sanitizeForDisplay } from "../utils/sanitizeForDisplay";
import {
  parseBoundedJson,
  JsonStructureBoundError,
} from "../utils/boundedJson";
import { UsageError, BilateralModeMismatchError } from "../errors";
import { cancellableDelay } from "./fileSyncConstants";
import { MAX_FRAME_SIZE_BYTES } from "./frameSize";
import {
  HELLO_SUFFIX,
  JOINING_SUFFIX,
  peerIdFromControlName,
} from "./fileSyncNames";
import type { HelloEnvelope } from "./controlEnvelope";
import type { FileTransportClient } from "./fileSyncConnection";

// The path/display locals a single synchronize() call computes once at entry
// (from this.path/this.outbound, narrowed by the connected guard) and threads
// through its phase methods. Not instance state: each field is derived per
// call, so passing this scope by value keeps the phases from re-deriving it and
// from depending on the order in which the guards ran. `inboundPath` is where
// this party reads the peer's files; `outboundPath` is where it writes its own
// (they coincide in shared mode); `split` is true only with a separate outbound
// directory; `dirsDisplay` is the operator-facing scope naming both halves in
// split mode.
/** @internal */
export interface RendezvousScope {
  inboundPath: string;
  outboundPath: string;
  split: boolean;
  dirsDisplay: string;
}

// Reads the hello control file through the I5 partial-sync gate. Retries on a
// transient get() failure or a JSON parse failure (indicating the sync tool has
// not finished writing the file) until timeToLive expires, then throws a
// transport Error. Any typed UsageError from get() is terminal -- today that is
// an over-cap body (FrameSizeExceededError) or a stalled read
// (TransportOperationStalledError), but the catch below is deliberately broad
// rather than enumerated: a UsageError is a non-retryable usage fault by
// definition, so re-reading cannot fix it and retrying would let a hostile
// server hold the gate open until the deadline. A fully-synced body that parses
// but fails the envelope schema (protocol mismatch, not a transient sync gap) is
// terminal for the same reason. Peer-id recovery is always filename-based; this
// function validates the body only.
//
// The hello is the only control file with a body, so the gate now reads only it
// (the schema is HelloEnvelopeSchema at every call site). The acknowledgment
// marker is a zero-length file matched by name existence, so it needs no gate:
// a zero-byte file has no partial-sync window to guard.
/** @internal */
export async function readControlFileWithGate(
  client: FileTransportClient,
  filePath: string,
  timeToLive: Date,
  pollingFrequency: number,
  schema: z.ZodType<HelloEnvelope>,
  signal: AbortSignal,
): Promise<HelloEnvelope> {
  // do-while guarantees at least one read attempt even when timeToLive has
  // already expired by the time the gate is entered (e.g. a slow polling loop
  // that exhausts the budget before reaching this call). Without this a fully-
  // present file would produce a spurious "timed out" error.
  do {
    let raw: Buffer<ArrayBufferLike>;
    try {
      raw = await client.get(filePath, {
        encoding: "utf-8",
        maxBytes: MAX_FRAME_SIZE_BYTES,
      });
    } catch (err) {
      // A typed UsageError from get() is terminal, not a partial-sync retry: a
      // hostile server could otherwise hold the gate open every cycle until the
      // deadline -- by serving an oversized hello (FrameSizeExceededError) or by
      // withholding the transfer so each read stalls
      // (TransportOperationStalledError). Both re-incur their cost on every pass,
      // so rethrow any UsageError to propagate out of synchronize() as the typed,
      // exit-64 failure rather than being swallowed and retried. (The
      // malformed-payload UsageError thrown below is terminal for the same
      // reason.)
      if (err instanceof UsageError) throw err;
      // File may not be readable yet (TOCTOU or partial sync); retry.
      await cancellableDelay(pollingFrequency, signal);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parseBoundedJson(raw.toString());
    } catch (err) {
      // A structurally pathological control file is fully formed, not a partial
      // write -- retrying cannot make it valid -- so reject it terminally like
      // the message-body parse, rather than re-reading it every poll cycle to
      // the peer timeout. A genuine partial write fails the parse (never the
      // structural bound) and still retries.
      if (err instanceof JsonStructureBoundError)
        throw new UsageError(
          `control file at ${sanitizeForDisplay(filePath)} has a malformed ` +
            `payload: structure exceeds the permitted bound`,
        );
      // Partial write: body is not valid JSON yet; retry until fully synced.
      await cancellableDelay(pollingFrequency, signal);
      continue;
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      // Only filePath is escaped here; result.error.message is deliberately
      // left raw. The sole schema at every call site is HelloEnvelopeSchema --
      // two `z.boolean()` fields under `.strip()` -- whose zod error reports the
      // expected type and a fixed field path, never a peer-supplied value or key
      // (strip drops extras without naming them), so it carries no partner bytes.
      // This differs from poll()'s message-body parse, which escapes its
      // error text because that body is open peer-controlled JSON.
      throw new UsageError(
        `control file at ${sanitizeForDisplay(filePath)} has a malformed ` +
          `payload: ${result.error.message}`,
      );
    }
    return result.data;
  } while (Date.now() <= timeToLive.getTime());
  throw new Error(
    `timed out waiting for ${sanitizeForDisplay(filePath)} to fully sync`,
  );
}

// Builds a party's hello payload: the two bilateral mode flags it advertises so
// the peer can detect a mismatch and fail fast. Written into the hello body in
// both rendezvous branches. The hello is the only control file with a body; the
// lockless ack is a zero-length marker that carries no flags.
/** @internal */
export function helloEnvelope(flags: {
  locklessRendezvous: boolean;
  retainFiles: boolean;
}): HelloEnvelope {
  return {
    locklessRendezvous: flags.locklessRendezvous,
    retainFiles: flags.retainFiles,
  };
}

// Compares a peer's advertised hello flags against a party's own configuration.
// Returns a BilateralModeMismatchError naming both sides' settings for the
// offending flag, or undefined when both flags match. Called at every site that
// reads a peer hello.
//
// retain_files is compared first because it is the implying flag: the only
// way both flags differ is retain=true/lockless=true vs
// retain=false/lockless=false (retain_files implies lockless_rendezvous), and
// naming the retain_files mismatch lets the operator realign both with a
// single rerun rather than risk the invalid retain=true/lockless=false state.
// A lockless-only divergence (retain matches) still reports lockless.
/** @internal */
export function bilateralMismatch(
  peer: HelloEnvelope,
  own: { locklessRendezvous: boolean; retainFiles: boolean },
): BilateralModeMismatchError | undefined {
  if (peer.retainFiles !== own.retainFiles)
    return new BilateralModeMismatchError(
      `retain_files mismatch: this party has retain_files=` +
        `${own.retainFiles} but the peer has retain_files=` +
        `${peer.retainFiles}; both parties must use the same setting`,
    );
  if (peer.locklessRendezvous !== own.locklessRendezvous)
    return new BilateralModeMismatchError(
      `lockless_rendezvous mismatch: this party has lockless_rendezvous=` +
        `${own.locklessRendezvous} but the peer has ` +
        `lockless_rendezvous=${peer.locklessRendezvous}; both parties must ` +
        `use the same setting`,
    );
  return undefined;
}

// True when `name` is a peer's hello (`<peerId>-hello.json`): it ends with
// HELLO_SUFFIX, recovers a non-empty id (peerIdFromControlName), and that id
// is not the querying party's own. The single definition of "a peer hello"
// shared by the synchronize() entry guard and the in-flight lock/lockless
// rendezvous scans, so "a valid peer hello" means the same thing at every site
// -- in particular a bare `-hello.json` (empty id) is never a peer hello,
// whether it is present at entry or injected mid-rendezvous.
/** @internal */
export function isPeerHelloName(name: string, selfId: string): boolean {
  const id = peerIdFromControlName(name, HELLO_SUFFIX);
  return id !== undefined && id !== selfId;
}

// True when `name` is a peer's joining sentinel (`<peerId>-joining.json`): the
// joining counterpart of isPeerHelloName. A bare `-joining.json` (empty id) is
// rejected, so it is never treated as a real joiner arrival and never starts
// the lock-path joiner-recovery (joinerRecoveryMs) window.
/** @internal */
export function isPeerJoiningName(name: string, selfId: string): boolean {
  const id = peerIdFromControlName(name, JOINING_SUFFIX);
  return id !== undefined && id !== selfId;
}
