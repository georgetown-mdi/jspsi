import * as z from "zod";

import type { AssociationTable, Config } from "../types";
import {
  receiveParsed,
  parseOrProtocolError,
  type MessageConnection,
} from "../connection/messageConnection";
import {
  MAX_PSI_DECODE_ELEMENTS,
  type PsiElementBounds,
} from "../connection/frameSize";
import {
  countDeclaredPsiElements,
  type PsiMessageKind,
} from "../connection/psiElementScan";
import { singleIssueArray } from "../utils/singleIssueArray";
import {
  assertPartnerIndexCount,
  assertPartnerIndices,
  assertPartnerIndexTable,
} from "../utils/partnerIndices";
import {
  binaryPackByteStringLength,
  builtSetTooLargeMessage,
  webrtcFrameExceedsBound,
  WEBRTC_FRAME_LIMIT_ABORT_REASON,
} from "../connection/webrtcOutboundBound";
import {
  FILE_SYNC_SET_LIMIT_ABORT_REASON,
  fileSyncBuiltSetTooLargeMessage,
  fileSyncMaxRoundSetValues,
  fileSyncMessageFileBytes,
} from "../connection/fileSyncOutboundBound";
import { RoundSetLimitError, WebRtcFrameLimitError } from "../errors";
import { sendAbort } from "../protocolSetup";
import { decodePsiBinaryFrame, receivePsiBinaryFrame } from "./psiBinaryFrame";
import { InProcessPsiEngine, type PsiEngine } from "./psiEngine";
import type { RoundGroupingField } from "./roundGrouping";

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { getLoggerForVerbosity } from "../utils/logger";

const statusCompletedMessage = z.object({
  status: z.literal("completed"),
});

// A flat array of indices: the whole received message (the root) where a
// round's original-index list arrives ungrouped, and the index element of
// both grouped round frames below. At the root, with no enclosing
// array/record/tuple frame, it cannot drive the ~130k STACK overflow
// {@link associationTableMessage} faces -- but a far larger count (~millions
// of invalid elements, within MAX_FRAME_SIZE_BYTES) makes Zod throw a
// DIFFERENT RangeError ("Invalid string length", ~3.3M on Zod 4.5.4)
// building its error string from one issue per element; nested it faces the
// stack overflow as well. The single-issue validator caps issue accumulation
// at one regardless of count and of framing (see utils/singleIssueArray.ts),
// so a pathological-count frame fails as a clean bounded rejection either
// way. A count `.max()` is not an option: the legitimate count is the
// partner's original-index list, in the millions, bounded only by
// MAX_FRAME_SIZE_BYTES. Number.isFinite mirrors `z.number()` exactly
// (accepts every finite number, rejects NaN/Infinity and non-numbers). This
// frame is read by a direct `.parse()` (send-before-parse, below), wrapped
// via parseOrProtocolError so even a validator throw produces a clean
// ConnectionError("protocol") rather than escaping bare.
/** @internal */
export const numberArrayMessage = singleIssueArray<number>(
  Number.isFinite,
  "must be an array of finite numbers",
);

// CONFIRMED-EXPOSED to Zod's issue-accumulation stack overflow: a partner can
// send a tuple whose inner index array holds hundreds of thousands of invalid
// (non-number) elements, and Zod overflows its call stack spreading one issue
// per element up through the inner-array and tuple frames (RangeError reproduced
// at ~130k on Zod 4.5.4). receiveParsed already caught that harmlessly; the
// single-issue validators below turn it into a clean, bounded rejection instead.
// A count `.max()` is not an option: the association table is the PSI
// intersection, legitimately in the millions (MAX_FRAME_SIZE_BYTES bounds it),
// so any overflow-forestalling count bound would reject a real result. Each
// validator mirrors `z.number()` exactly via Number.isFinite (which, like
// z.number(), accepts every finite number and rejects NaN/Infinity and
// non-numbers). See utils/singleIssueArray.ts.
/** @internal */
export const associationTableMessage = z.tuple([
  singleIssueArray<number>(
    Number.isFinite,
    "must be an array of finite numbers",
  ),
  singleIssueArray<number>(
    Number.isFinite,
    "must be an array of finite numbers",
  ),
]);

// The grouping element the two position-naming frames of a cascade round
// gained. It holds either run lengths or an owner list per matched position,
// and which of the two a party is required to have sent follows the resolved
// cardinality both parties hold, so the schema bounds the structure alone and
// roundGrouping.ts decides the form. Validated in one `every` pass for the
// reason every other linkage-frame array is (utils/singleIssueArray.ts): a
// partner-controlled element count in the millions accumulates one issue
// rather than one per entry. A nested entry is checked by the same predicate
// and never recurses, so a deeply nested frame is one rejection too.
const roundGroupingElement = singleIssueArray<number | Array<number>>(
  (value) =>
    Number.isFinite(value) ||
    (Array.isArray(value) && value.every(Number.isFinite)),
  "must be an array of finite numbers or of arrays of finite numbers",
);

// The cascade round's frame 4, the receiver's association table for the round.
// Distinct from {@link associationTableMessage}, which is also single-pass's
// resolved-table frame and stays at two elements: widening that one in place
// would admit a grouping on a frame the spec keeps at two. A round whose
// sender omits its grouping puts the two-element form on the wire, so a round
// no producer widened states what the single-valued cascade states, pair for
// pair once the table's pair order is canonicalized -- the library returns an
// intersection in no fixed order (docs/spec/PROTOCOL.md, An absent grouping is
// all ones).
/** @internal exported for the round-frame schema tests. */
export const roundAssociationTableMessage = z.tuple([
  numberArrayMessage,
  numberArrayMessage,
  roundGroupingElement.optional(),
]);

// The cascade round's frame 5, the sender's original-index list, with its own
// grouping beside it. The bare-array branch is the whole of what an ungrouped
// round sends, so that round states what the single-valued cascade states,
// entry for entry once the list's order is canonicalized; the two branches are
// told apart by their first element's type, which no legitimate frame leaves
// ambiguous.
/** @internal exported for the round-frame schema tests. */
export const roundOriginalIndexListMessage = z.union([
  numberArrayMessage,
  z.tuple([numberArrayMessage, roundGroupingElement]),
]);

/**
 * The per-round grouping exchange {@link PSIParticipant.identifyIntersection}
 * drives across the round's two position-naming frames: it asks this party
 * for its own grouping once the round's matched positions are known, and
 * hands the partner's over to be checked before the round returns
 * (docs/spec/PROTOCOL.md, The per-round grouping the two frames hold).
 */
export interface RoundGroupingExchange {
  /**
   * This party's own grouping over the positions it matched in the round, or
   * `undefined` to omit the field.
   */
  describe(
    matchedPositions: ReadonlyArray<number>,
  ): RoundGroupingField | undefined;
  /**
   * Check the partner's grouping against local state and hold it. Raises a
   * classified `protocol` error at the round on any deviation.
   *
   * @param field - The grouping as it arrived, `undefined` where the frame
   *   omitted it.
   * @param matchedPositions - The positions the frame names for the partner.
   */
  accept(
    field: RoundGroupingField | undefined,
    matchedPositions: ReadonlyArray<number>,
  ): void;
}

const DEFAULT_VERBOSITY = 1;

/**
 * How far along one step of an exchange is, for a progress display. The list of
 * steps belongs to the surface showing it -- each labels its own stages with one
 * of these states -- so this enum is the shared vocabulary, not a stage model.
 */
export enum ProcessState {
  BeforeStart,
  Waiting,
  Working,
  Done,
}

/**
 * Which crypto operation a {@link PsiProgress} report describes, named by the
 * {@link PSIParticipant} method that runs it. These are the operations that mask
 * or match every element of a set, so they are the ones a long round spends its
 * minutes inside.
 */
export type PsiOperation =
  | "createServerSetup"
  | "processClientRequest"
  | "createClientRequest"
  | "computeAssociationTable"
  | "computeIntersectionCardinality";

/**
 * Where one crypto operation stands: `started` when the participant dispatched
 * it to the engine, `progress` each time the engine has finished part of the
 * set, and `finished` or `failed` when the engine settled. An operation that
 * failed did not produce a result, so a display shows no completion figure for
 * it.
 */
export type PsiProgressState = "started" | "progress" | "finished" | "failed";

/**
 * One report about a PSI crypto operation, for a progress display. Every figure
 * is a count or a duration -- how many elements the operation covers and how
 * long it ran -- never a value from either party's data, and none of it goes on
 * the wire.
 */
export interface PsiProgress {
  operation: PsiOperation;
  /**
   * How many encrypted elements the operation covers: the values it was handed,
   * for one that masks this party's own set, and the element count the frame
   * declares, for one that reads the partner's. A count-only round masks only
   * the values occurring exactly once, so for it the first figure is an upper
   * bound.
   */
  elements: number;
  state: PsiProgressState;
  /**
   * How many of `elements` the operation has finished masking or matching.
   * Present on `progress` alone, and always short of `elements`: the engine
   * reports between the chunks it splits a large set into, never after the
   * last one, whose figure the `finished` report states.
   *
   * The `computeIntersectionCardinality` operation reports `started` and
   * `finished` and nothing between them at any size: a count-only round's
   * match is one library call that cannot be split (see
   * {@link ./psiEngine.PsiEngine.computeIntersectionCardinality}).
   */
  processed?: number;
  /**
   * Wall-clock milliseconds the operation ran, measured on the monotonic clock
   * so a clock adjustment cannot make it negative. Present on `finished` and
   * `failed`, absent on `started` and `progress`.
   */
  durationMs?: number;
}

/**
 * Takes each {@link PsiProgress} report from a {@link PSIParticipant}. Called
 * synchronously from the participant's own call path, so an implementation
 * returns quickly and does not throw: a raise on a `started`, `finished`, or
 * `failed` report reaches the exchange. A raise on a `progress` report is
 * dropped instead -- that operation is already part-run and its result is
 * still to come, so a fault in a display must not abort the round.
 */
export type PsiProgressReporter = (progress: PsiProgress) => void;

export class PSIParticipant {
  id: string;
  config: Config;
  private log: ReturnType<typeof getLoggerForVerbosity>;
  private elementBounds: PsiElementBounds;
  private engine: PsiEngine;
  private onProgress?: PsiProgressReporter;
  // The operation now dispatched to the engine, for the mid-operation reports
  // the engine raises against it. Undefined between operations.
  private runningOperation:
    { operation: PsiOperation; elements: number } | undefined;

  constructor(
    id: string,
    library: PSILibrary,
    config: Config,
    // Per-message caps on the encrypted-element count each inbound PSI
    // frame may declare, derived from authenticated session state (the
    // agreed key count and the two exchanged record counts; see
    // psiElementBounds in frameSize.ts) and enforced at every
    // deserializeBinary call site below. Required, not defaulted: a
    // fail-open default would silently drop the amplification guard on a
    // caller that forgot it.
    elementBounds: PsiElementBounds,
    // The crypto engine backing this participant. Defaults to an
    // in-process engine built from `library`, with the masking running on
    // the calling thread. The CLI injects a worker-backed engine so the
    // masking runs off the event-loop-owning thread; that engine holds the
    // key objects in its worker, so `library` is used only to build the
    // default.
    engine?: PsiEngine,
    // Takes a report as each crypto operation below starts and settles, for a
    // caller rendering a progress display. Omitted, no report is composed at
    // all, so a caller that shows nothing pays nothing.
    onProgress?: PsiProgressReporter,
  ) {
    this.id = id;
    this.config = config;
    this.elementBounds = elementBounds;
    this.onProgress = onProgress;

    if (this.config.verbose === undefined) {
      this.config.verbose = DEFAULT_VERBOSITY;
    }

    this.log = getLoggerForVerbosity("participant", this.config.verbose);

    this.engine =
      engine ??
      new InProcessPsiEngine(
        library,
        this.config.role,
        this.id,
        "identifier-revealing",
      );
    // Take the engine's processed counts only where a caller is rendering
    // them, so a participant that shows nothing composes no report at all.
    if (onProgress !== undefined)
      this.engine.observeProcessedElements?.((processed) =>
        this.reportProcessed(processed),
      );
  }

  // One mid-operation report, naming the operation the participant dispatched
  // and the count the engine has reached. Best effort: the operation is already
  // part-run and its result is still to come, so a reporter that raises here is
  // dropped rather than failing the round, unlike the started and settled
  // reports below.
  private reportProcessed(processed: number): void {
    const running = this.runningOperation;
    const report = this.onProgress;
    if (running === undefined || report === undefined) return;
    try {
      report({
        operation: running.operation,
        elements: running.elements,
        state: "progress",
        processed,
      });
    } catch {
      // Dropped; the operation continues and its settle report follows.
    }
  }

  /**
   * Release the crypto engine's resources (see {@link PsiEngine.dispose}). Call at
   * exchange teardown: a no-op for the default in-process engine, but the
   * worker-backed engine terminates its worker here so the process can exit.
   */
  dispose(): void {
    this.engine.dispose();
  }

  // Reject a partner-supplied PSI frame that DECLARES more encrypted
  // elements than allowed, by scanning the protobuf wire format before
  // handing the bytes to deserializeBinary -- which allocates one heap
  // object (~211 bytes, measured) per declared repeated entry. Without a
  // pre-scan, a malicious partner could pack many minimal (~2-byte)
  // repeated entries within the frame byte cap -- declaring up to
  // ~frameBytes/2 elements -- and exhaust memory (tens of GiB) inside
  // deserializeBinary itself, before any post-deserialize count could read
  // it. The ceiling is the tighter of the authenticated
  // `keyCount * recordCount` bound (both parties compute it identically
  // from authenticated session state) and the absolute
  // {@link MAX_PSI_DECODE_ELEMENTS}, which binds a cascade frame whose
  // partner over-declares its record count. The scan stops as soon as the
  // count exceeds the ceiling, so an over-declared frame costs O(ceiling),
  // not O(frame); a malformed frame is a clean protocol abort too. See
  // connection/psiElementScan.ts.
  // Returns the count the frame declares, for the progress report on the
  // operation that follows: the scan stops early only above the ceiling, and
  // such a frame is rejected here, so the figure returned is the scan's own
  // count -- exact for a conforming frame, an upper bound otherwise.
  private assertInboundElementBound(
    kind: PsiMessageKind,
    bytes: Uint8Array,
    authenticatedBound: number,
  ): number {
    const ceiling = Math.min(authenticatedBound, MAX_PSI_DECODE_ELEMENTS);
    let declared: number;
    try {
      declared = countDeclaredPsiElements(bytes, kind, ceiling);
    } catch {
      throw new Error(
        `${this.id} protocol error: malformed inbound PSI ${kind} frame`,
      );
    }
    if (declared > ceiling)
      throw new Error(
        `${this.id} protocol error: inbound PSI ${kind} declares more than ` +
          `${ceiling} encrypted element(s)`,
      );
    return declared;
  }

  // Send one of the round's PSI set frames, refusing it first where the
  // transport states a receive-side frame bound the frame would cross: the
  // partner is parked on this frame, so it is sent the abort in its place and
  // ends the round as a peer termination rather than on a frame it refuses.
  // `setOwner` is whose set the frame holds -- the response returns the
  // partner's own set re-encrypted -- which is whose input the remedy names.
  private async sendPsiSetFrame(
    conn: MessageConnection,
    frame: Uint8Array,
    setOwner: "local" | "partner",
  ): Promise<void> {
    const envelopeBytes = conn.outboundFrameOverheadBytes?.() ?? 0;
    const bound = conn.outboundWebRtcFrameBound?.();
    if (bound !== undefined) {
      const packedFrameBytes = binaryPackByteStringLength(
        frame.byteLength + envelopeBytes,
      );
      if (webrtcFrameExceedsBound(packedFrameBytes, bound)) {
        await sendAbort(conn, [WEBRTC_FRAME_LIMIT_ABORT_REASON]);
        throw new WebRtcFrameLimitError(
          builtSetTooLargeMessage(setOwner, packedFrameBytes, bound),
          setOwner,
        );
      }
    }
    const fileBound = conn.outboundFileSyncFrameBound?.();
    if (
      fileBound !== undefined &&
      fileSyncMessageFileBytes(frame.byteLength, envelopeBytes) > fileBound
    ) {
      const kind: PsiMessageKind =
        setOwner === "partner"
          ? "response"
          : this.config.role === "starter"
            ? "serverSetup"
            : "request";
      const elementCount = countDeclaredPsiElements(
        frame,
        kind,
        Number.MAX_SAFE_INTEGER,
      );
      await sendAbort(conn, [FILE_SYNC_SET_LIMIT_ABORT_REASON]);
      throw new RoundSetLimitError(
        fileSyncBuiltSetTooLargeMessage(
          setOwner,
          elementCount,
          fileSyncMaxRoundSetValues(fileBound),
        ),
        { setOwner },
      );
    }
    await conn.send(frame);
  }

  // Report one crypto operation's element count and duration around the engine
  // call that runs it, for a caller rendering a progress display. The timing is
  // taken here, on the participant's own thread, rather than inside the engine:
  // a worker-backed engine runs each chunk of the masking inside a blocking
  // library call, so the elapsed figure a display ticks against has to come
  // from the thread that is free. The engine's own mid-operation counts are
  // reported against the operation named here (see reportProcessed).
  private async reportProgress<T>(
    operation: PsiOperation,
    elements: number,
    run: () => Promise<T>,
  ): Promise<T> {
    const report = this.onProgress;
    if (report === undefined) return run();
    report({ operation, elements, state: "started" });
    const startedAt = performance.now();
    const durationMs = (): number =>
      Math.max(0, Math.round(performance.now() - startedAt));
    let result: T;
    this.runningOperation = { operation, elements };
    try {
      result = await run();
    } catch (error) {
      this.runningOperation = undefined;
      report({
        operation,
        elements,
        state: "failed",
        durationMs: durationMs(),
      });
      throw error;
    }
    this.runningOperation = undefined;
    // Outside the try: a reporter that raises on this report must not also
    // relabel the operation that already completed as failed.
    report({
      operation,
      elements,
      state: "finished",
      durationMs: durationMs(),
    });
    return result;
  }

  // Building-block PSI steps used by the single-pass strategy
  // (linkViaSinglePassPSI in link.ts). Unlike identifyIntersection below, which
  // runs the whole back-and-forth itself, single-pass calls these one at a time
  // and sequences the exchange on its own. Each wraps the underlying PSI library,
  // keeping the secret key and the library's server/client objects private to this
  // class; callers see only raw bytes and lists of indices.

  /**
   * Encrypts this party's values once under the server key, returning the
   * serialized setup message and a "permutation" -- a lookup that undoes the
   * reordering the library does internally. The library sorts the values before
   * encrypting; entry i of the lookup gives the original input position of the
   * value now in sorted slot i, so a match reported in sorted terms can be traced
   * back to the row it came from. Requires the `"starter"` role.
   */
  public async createServerSetup(values: ReadonlyArray<string>): Promise<{
    setup: Uint8Array;
    permutation: Array<number>;
  }> {
    return this.reportProgress("createServerSetup", values.length, () =>
      this.engine.createServerSetup(values),
    );
  }

  /**
   * Doubly-encrypts the partner's request under the server key, returning the
   * serialized response. Requires the `"starter"` role.
   */
  public async processClientRequest(
    requestBytes: Uint8Array,
  ): Promise<Uint8Array> {
    const elements = this.assertInboundElementBound(
      "request",
      requestBytes,
      this.elementBounds.request,
    );
    return this.reportProgress("processClientRequest", elements, () =>
      decodePsiBinaryFrame(this.id, "request", () =>
        this.engine.processClientRequest(requestBytes),
      ),
    );
  }

  /**
   * Encrypts this party's set once under the client key, returning the serialized
   * request. Requires the `"joiner"` role.
   */
  public async createClientRequest(
    values: ReadonlyArray<string>,
  ): Promise<Uint8Array> {
    return this.reportProgress("createClientRequest", values.length, () =>
      this.engine.createClientRequest(values),
    );
  }

  /**
   * Finishes the match for this party: removes its own encryption layer from the
   * partner's doubly-encrypted response and compares it against the partner's
   * setup, returning the list of value matches. Each pair is `[index among this
   * party's distinct values, index among the partner's values]`. WARNING: these
   * index de-duplicated VALUES, not data rows -- the cascade replay (link.ts) is
   * what turns them into record pairs. The partner's index is in the library's
   * internal sorted order; map it back to input order with the permutation from
   * {@link createServerSetup}. Requires the `"joiner"` role.
   */
  public async computeValueMatches(
    setupBytes: Uint8Array,
    responseBytes: Uint8Array,
  ): Promise<[Array<number>, Array<number>]> {
    await this.receiveServerSetup(setupBytes);
    return this.computeAssociationTable(responseBytes);
  }

  // Host-side element-count guard, then hand the setup to the engine to
  // deserialize, Raw-check, and hold. Split from the match (below) so the
  // cascade joiner can validate the setup the instant it arrives -- a
  // fail-fast before it sends its own request -- while the response it
  // matches against arrives a round trip later. The guard runs here, above
  // the engine boundary, so the engine only ever deserializes an
  // already-bounded frame.
  private receiveServerSetup(setupBytes: Uint8Array): Promise<void> {
    this.assertInboundElementBound(
      "serverSetup",
      setupBytes,
      this.elementBounds.setup,
    );
    return decodePsiBinaryFrame(this.id, "serverSetup", () =>
      this.engine.receiveServerSetup(setupBytes),
    );
  }

  private computeAssociationTable(
    responseBytes: Uint8Array,
  ): Promise<[Array<number>, Array<number>]> {
    const elements = this.assertInboundElementBound(
      "response",
      responseBytes,
      this.elementBounds.response,
    );
    return this.reportProgress("computeAssociationTable", elements, () =>
      decodePsiBinaryFrame(this.id, "response", () =>
        this.engine.computeAssociationTable(responseBytes),
      ),
    );
  }

  // The count-only leg's counterpart to the guard above: the response is
  // partner-supplied bytes the engine deserializes, so it gets the same
  // pre-deserialize element-count bound the association-table leg gets. Which of the
  // two matches runs is fixed by the engine's mode, but the amplification defense is
  // a property of the frame, not of the disclosure it resolves to.
  private computeIntersectionCardinality(
    responseBytes: Uint8Array,
  ): Promise<number> {
    const elements = this.assertInboundElementBound(
      "response",
      responseBytes,
      this.elementBounds.response,
    );
    return this.reportProgress("computeIntersectionCardinality", elements, () =>
      decodePsiBinaryFrame(this.id, "response", () =>
        this.engine.computeIntersectionCardinality(responseBytes),
      ),
    );
  }

  /**
   * Runs the count-only (psi-c) round and resolves to the intersection SIZE on the
   * receiver and to `undefined` on the sender, which computes nothing and learns
   * nothing about the count from the round (docs/spec/PROTOCOL.md, PSI-C).
   *
   * Three frames, against {@link identifyIntersection}'s five: the sender's setup,
   * the receiver's request, the sender's response. There is no association-table
   * round-trip and no completion acknowledgement, because there is no pairing for
   * the two parties to translate into each other's row space -- the round produces
   * no position either party could name.
   *
   * Requires a participant whose engine was built count-only: the identifier-
   * revealing engine refuses the cardinality operation rather than returning one, so
   * a round mis-built for the disclosure its terms agreed aborts instead of
   * resolving to the other mode's answer.
   */
  public async countIntersection(
    conn: MessageConnection,
    set: Array<string>,
  ): Promise<number | undefined> {
    if (this.config.role === "starter") {
      const { setup } = await this.createServerSetup(set);
      this.log.debug(
        `${this.id}: starting count-only protocol; sending server data ` +
          "encrypted by server",
      );
      await this.sendPsiSetFrame(conn, setup, "local");

      this.log.debug(`${this.id}: waiting for client request`);
      const clientRequest = await receivePsiBinaryFrame(
        conn,
        this.id,
        "request",
      );

      const serverResponse = await this.processClientRequest(clientRequest);
      this.log.debug(
        `${this.id}: sending client data encrypted by both server and client`,
      );
      await this.sendPsiSetFrame(conn, serverResponse, "partner");

      // The sender's round ends here: it holds no count, and whether one reaches it
      // at all is the entitlement question the caller answers (see protocolSetup's
      // count-report leg), not something this round produces.
      return undefined;
    }

    this.log.debug(`${this.id}: starting count-only protocol`);
    const serverSetup = await receivePsiBinaryFrame(
      conn,
      this.id,
      "serverSetup",
    );
    this.log.debug(`${this.id}: receiving server data encrypted by server`);
    await this.receiveServerSetup(serverSetup);

    const clientRequest = await this.createClientRequest(set);
    this.log.debug(`${this.id}: sending client data encrypted by client`);
    await this.sendPsiSetFrame(conn, clientRequest, "local");

    const serverResponse = await receivePsiBinaryFrame(
      conn,
      this.id,
      "response",
    );
    this.log.debug(
      `${this.id}: receiving server data encrypted by both server and client`,
    );
    return this.computeIntersectionCardinality(serverResponse);
  }

  /**
   * Returns an association table with elements [localIndices, partnerIndices]
   *
   * @param grouping - The round's per-round grouping exchange, where the
   *   caller resolves a candidate set. Omitted, neither frame sends a grouping
   *   nor admits one, so both keep the shape the single-valued cascade puts on
   *   the wire and accept exactly what it accepts.
   */
  public async identifyIntersection(
    conn: MessageConnection,
    set: Array<string>,
    grouping?: RoundGroupingExchange,
  ): Promise<AssociationTable> {
    if (this.config.role === "starter") {
      const { setup, permutation } = await this.createServerSetup(set);

      this.log.debug(
        `${this.id}: starting identify-intersection protocol; sending server ` +
          " data encrypted by server",
      );
      await this.sendPsiSetFrame(conn, setup, "local");

      this.log.debug(`${this.id}: waiting for client request`);

      const clientRequest = await receivePsiBinaryFrame(
        conn,
        this.id,
        "request",
      );
      this.log.debug(`${this.id}: received client data encrypted by client`);

      const serverResponse = await this.processClientRequest(clientRequest);

      this.log.debug(
        `${this.id}: sending client data encrypted by both server and client`,
      );

      await this.sendPsiSetFrame(conn, serverResponse, "partner");

      // The partner sends [theirIndices, ourIndices]; the swapped names
      // restore our-first order. A third element is the partner's own grouping
      // for the round, admitted only where the caller states one of its own:
      // a round without a grouping neither sends nor accepts one.
      const [partnerIndices, localIndices, partnerGrouping]: [
        Array<number>,
        Array<number>,
        (RoundGroupingField | undefined)?,
      ] = grouping
        ? await receiveParsed(conn, roundAssociationTableMessage)
        : [...(await receiveParsed(conn, associationTableMessage)), undefined];
      this.log.debug(`${this.id}: received association table`);

      // The round's matches, as computed by the partner: our half indexes the
      // set we just encrypted (so `permutation` bounds it exactly), the partner
      // half indexes the set it encrypted (bounded by the element count its
      // masked set may declare -- authenticated session state, since it is
      // derived from the agreed key count and the exchanged record counts). Both
      // are checked before the remap below turns our half into this party's
      // matched set for the round.
      assertPartnerIndexTable(
        this.id,
        {
          what: "the round's association table, local half",
          indices: localIndices,
          exclusiveBound: permutation.length,
        },
        {
          what: "the round's association table, partner half",
          indices: partnerIndices,
          exclusiveBound: this.elementBounds.request,
        },
      );

      // Checked before it drives the sweep, and before this party's own
      // grouping goes out, so a deviating round aborts at the round rather
      // than after the last one.
      grouping?.accept(partnerGrouping, partnerIndices);

      for (let i = 0; i < localIndices.length; ++i) {
        localIndices[i] = permutation[localIndices[i]];
      }

      this.log.debug(`${this.id}: sending my original indices`);
      const localGrouping = grouping?.describe(localIndices);
      await conn.send(
        localGrouping === undefined
          ? localIndices
          : [localIndices, localGrouping],
      );

      this.log.debug(`${this.id}: waiting for status completed`);
      await receiveParsed(conn, statusCompletedMessage);

      return [localIndices, partnerIndices];
    } else {
      this.log.debug(`${this.id}: starting identify-intersection protocol`);

      const serverSetup = await receivePsiBinaryFrame(
        conn,
        this.id,
        "serverSetup",
      );
      this.log.debug(`${this.id}: receiving server data encrypted by server`);

      // Validate and hold the server setup the instant it arrives -- a fail-fast
      // before we send our own request -- while the response we match it against
      // arrives a round trip later.
      await this.receiveServerSetup(serverSetup);

      const clientRequest = await this.createClientRequest(set);

      this.log.debug(`${this.id}: sending client data encrypted by client`);

      await this.sendPsiSetFrame(conn, clientRequest, "local");

      const serverResponse = await receivePsiBinaryFrame(
        conn,
        this.id,
        "response",
      );
      this.log.debug(
        `${this.id}: receiving server data encrypted by both by server and ` +
          "client",
      );

      // Association table: indices into client data mapped to the (likely permuted)
      // indices given by the server, matched against the setup held above.
      const associationTable =
        await this.computeAssociationTable(serverResponse);
      const localIndices = associationTable[0];

      this.log.debug(
        `${this.id}: sending association table with permuted server indices`,
      );

      const localGrouping = grouping?.describe(localIndices);
      await conn.send(
        localGrouping === undefined
          ? associationTable
          : [associationTable[0], associationTable[1], localGrouping],
      );

      // Send-before-parse: receive the partner's original indices, acknowledge
      // with status:completed, then parse. Sending the acknowledgement before
      // validating ensures a malformed final frame does not strand the partner.
      const rawData = await conn.receive();
      this.log.debug(`${this.id}: receiving original server indices`);

      this.log.debug(`${this.id}: sending status completed`);
      await conn.send({ status: "completed" });

      // The partner's own matched records, in its input order: one per pair we
      // reported, each indexing the set it encrypted -- bounded by the element
      // count its masked set may declare, which is authenticated session state.
      // A two-element frame holds the partner's own grouping beside the list,
      // read only where the caller resolves a candidate set.
      const frame = grouping
        ? parseOrProtocolError(roundOriginalIndexListMessage, rawData)
        : parseOrProtocolError(numberArrayMessage, rawData);
      const [partnerIndices, partnerGrouping] = Array.isArray(frame[0])
        ? (frame as [Array<number>, RoundGroupingField])
        : [frame as Array<number>, undefined];
      assertPartnerIndexCount(
        this.id,
        "the partner's original-index list",
        partnerIndices.length,
        localIndices.length,
      );
      assertPartnerIndices(
        this.id,
        "the partner's original-index list",
        partnerIndices,
        this.elementBounds.setup,
      );
      grouping?.accept(partnerGrouping, partnerIndices);

      return [localIndices, partnerIndices];
    }
  }
}
