import { associationTableMessage, type PSIParticipant } from "./participant";
import type { AssociationTable } from "./types";
import {
  receiveParsed,
  parseOrProtocolError,
  type MessageConnection,
} from "./connection/messageConnection";
import {
  singlePassExchangeExceedsCap,
  singlePassReplyByteCap,
} from "./connection/frameSize";
import { singleIssueArray } from "./utils/singleIssueArray";

import { getLoggerForVerbosity } from "./utils/logger";

interface IndexIterationPair {
  theirIndex: number;
  iteration: number;
}

// Parsed as the whole received message (the root array). With no enclosing
// array/record/tuple frame above the root, a pathological count cannot drive the
// ~130k STACK overflow the nested collections face (see participant.ts
// associationTableMessage and config/linkageTerms.ts) -- but a far larger count
// (~millions of invalid elements, within the frame cap) makes Zod throw a
// DIFFERENT RangeError ("Invalid string length", ~3.5M on Zod 4.4.3) building its
// error string from one issue per element. The single-issue validator caps issue
// accumulation at one regardless of count (utils/singleIssueArray.ts), so a
// pathological frame fails as a clean bounded rejection; a count `.max()` is not
// an option because the legitimate count -- the matched intersection -- is in the
// millions, bounded only by MAX_FRAME_SIZE_BYTES. The predicate mirrors
// `z.object({ theirIndex: z.number(), iteration: z.number() })` for acceptance:
// a non-null, non-array object (z.object rejects an array outright, even one
// carrying theirIndex/iteration own-properties) with a finite value at each field
// (Number.isFinite, like z.number()). Unlike that object schema it does not strip
// unknown keys, which is immaterial -- a legitimate partner sends exactly these
// two keys, and only theirIndex/iteration are ever read. This array is read both
// via receiveParsed (sendFirst, below) and via a direct `.parse()` (the
// !sendFirst send-before-parse path, wrapped in parseOrProtocolError) so either
// way a malformed frame surfaces a clean ConnectionError("protocol").
/** @internal exported for the pathological-count wire-message test. */
export const associationAndIterationArray =
  singleIssueArray<IndexIterationPair>(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Number.isFinite((value as Record<string, unknown>).theirIndex) &&
      Number.isFinite((value as Record<string, unknown>).iteration),
    "must be an array of {theirIndex, iteration} finite-number pairs",
  );

type IndexIterationMap = Array<IndexIterationPair | undefined>;
type IterationMap = Array<IndexIterationPair>;

export interface IndexableIterable<T> extends Iterable<T> {
  [index: number]: T | undefined;
}

function getUnidentifiedIndices(
  indexIterationMap: IndexIterationMap,
): Array<number> {
  return indexIterationMap.reduce((acc, x, i) => {
    if (!x) acc.push(i);
    return acc;
  }, [] as Array<number>);
}

// Maps each value occurring exactly once in valueAt(0..count-1) to its index.
// The result's insertion order follows the order values appear in valueAt --
// callers rely on this to build identical outputs. Undefined values are ignored.
//
// Keeps one map of first-seen indices plus a set of the values that recur, rather
// than three maps: in the near-unique case no value recurs, so the set stays empty
// and the first-index map IS the answer, returned without a copy. When some values
// recur, the recurring ones are deleted from the map; Map iteration is insertion
// order and delete preserves the order of the survivors, so the first-appearance
// order callers depend on is unchanged. This trims psilink's own per-key
// reconstruction churn (board item 206377899); it is a minor slice of the
// single-pass receiver's transient peak, which is dominated by the per-element
// JS<->native boundary marshalling that the GC relief in linkViaSinglePassPSI
// collects.
function reduceToSingletons<T>(
  count: number,
  valueAt: (index: number) => T | undefined,
): Map<T, number> {
  const firstIndex = new Map<T, number>();
  const recurring = new Set<T>();
  for (let i = 0; i < count; ++i) {
    const value = valueAt(i);
    if (value === undefined) continue;
    if (firstIndex.has(value)) recurring.add(value);
    else firstIndex.set(value, i);
  }
  for (const value of recurring) firstIndex.delete(value);
  return firstIndex;
}

// Adapts reduceToSingletons for the cascade: undefined means "no value for this
// key" (but "" is a real value, kept). `permutation` maps a survivor's index back
// to its original row when the input is a carried-forward subset of a later round.
// See docs/spec/PROTOCOL.md (Key input data).
function removeDuplicatesAndUndefineds(
  dataWithDuplicatesAndUndefineds: Array<string | undefined>,
  permutation?: Array<number>,
): [Array<string>, Array<number>] {
  const singletons = reduceToSingletons<string>(
    dataWithDuplicatesAndUndefineds.length,
    (i) => dataWithDuplicatesAndUndefineds[i],
  );
  const data: Array<string> = [];
  const originalIndices: Array<number> = [];
  for (const [value, i] of singletons) {
    data.push(value);
    originalIndices.push(permutation ? permutation[i] : i);
  }
  return [data, originalIndices];
}

/**
 * Runs the PSI linkage protocol over one or more linkage keys and returns the
 * matched row indices.
 *
 * Keys are tried in order. Records matched on key `j` are excluded from all
 * subsequent key rounds, so each record appears in the result at most once.
 * Within a given key round, records whose key value is duplicated across the
 * local dataset are excluded from that round entirely (ambiguous matches cannot
 * be attributed to a single record). They may still match on a later key.
 *
 * Only `"one-to-one"` and `"many-to-one"` cardinalities are currently
 * supported; other values throw.
 *
 * @param protocol - Exchange protocol settings; only `cardinality` is used
 *   here.
 * @param participant - Must have a resolved role (`"starter"` or `"joiner"`);
 *   throws if `role` is still `"either"`.
 * @param conn - Open connection to the exchange partner.
 * @param data - One entry per linkage key. Each entry is an iterable over all
 *   local records (indexed by row position) yielding the record's value for
 *   that key, or `undefined` if the record has no value for it.
 * @param verbosity - Log verbosity level (default 0).
 * @param setStage - Optional callback invoked with a progress label at each
 *   key round.
 * @returns An {@link AssociationTable} whose first element (`[0]`) contains
 *   the local matched row indices in strictly ascending order, and whose second
 *   element (`[1]`) contains the corresponding partner row indices in the same
 *   pairing order.
 */
export async function linkViaPSI(
  protocol: {
    cardinality: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";
  },
  participant: PSIParticipant,
  conn: MessageConnection,
  data: Array<IndexableIterable<string | undefined>>,
  verbosity: number = 0,
  setStage?: (id: string) => void,
) {
  if (participant.config.role === "either")
    throw new Error("participants role is unresolved");
  const sendFirst = participant.config.role === "starter";

  const log = getLoggerForVerbosity("psiLink", verbosity);
  setStage = setStage ?? (() => {});

  log.debug(`${participant.id}: linking using ${data.length} key(s) via PSI`);

  if (["one-to-one", "many-to-one"].includes(protocol.cardinality)) {
    let indexIterationMap: IndexIterationMap = [];
    const unmappedIndicesByIter: Array<Array<number>> = [];

    for (let j = 0; j < data.length; ++j) {
      setStage(`stage ${j + 1} / ${data.length}`);
      let dataWithDuplicatesAndUndefineds: Array<string | undefined>;
      let unidentifiedIndices: Array<number> | undefined;
      if (j === 0) {
        dataWithDuplicatesAndUndefineds = Array.from(data[j]);
        indexIterationMap = Array(dataWithDuplicatesAndUndefineds.length).fill(
          undefined,
        );
        log.debug(
          `${participant.id}: ${indexIterationMap.length} total records`,
        );
      } else {
        unidentifiedIndices = getUnidentifiedIndices(indexIterationMap);
        dataWithDuplicatesAndUndefineds = unidentifiedIndices.map((i) => {
          return data[j][i];
        });
      }
      const [data_j, unmappedIndices] = removeDuplicatesAndUndefineds(
        dataWithDuplicatesAndUndefineds,
        unidentifiedIndices,
      );
      unmappedIndicesByIter.push(unmappedIndices);

      log.debug(
        `${participant.id}: key ${j + 1}/${data.length}: ${data_j.length} ` +
          "unique value(s) " +
          `${j > 0 ? ` (${unidentifiedIndices!.length} unmatched)` : ""}`,
      );

      // Run a PSI round for every agreed key, even when data_j is empty. The
      // key set is fixed by the linkage terms so both parties loop the same
      // keys, but data_j is derived from local data and can be empty on only
      // one side; skipping that round drops a send/receive the partner still
      // performs and desyncs the lockstep exchange. The PSI library returns an
      // empty intersection for empty input, so the round is a correct no-op.
      log.debug(
        `${participant.id}: running psi on key ${j + 1} / ${data.length}:`,
      );
      const [myIndices, theirIndices] = await participant.identifyIntersection(
        conn,
        data_j,
      );

      log.debug(
        `${participant.id}: key ${j + 1}/${data.length}: ${myIndices.length} ` +
          "match(es) found",
      );

      for (let ii = 0; ii < myIndices.length; ++ii) {
        const i = unmappedIndices[myIndices[ii]];

        indexIterationMap[i] = {
          theirIndex: theirIndices[ii],
          iteration: j,
        };
      }
    }

    const [identifiedIndexIterationMap, originalIndices] =
      indexIterationMap.reduce(
        (acc, x, i) => {
          if (x) {
            acc[0].push(x);
            acc[1].push(i);
          }
          return acc;
        },
        [[], []] as [IterationMap, Array<number>],
      );

    const numMappedElements = identifiedIndexIterationMap.length;
    log.debug(
      `${participant.id}: ${numMappedElements}/${indexIterationMap.length} ` +
        "record(s) matched",
    );

    log.debug(
      `${participant.id}: sending match map indexed by round, receiving ` +
        "partner's",
    );
    const theirIdentifiedIndexIterationMap = await exchangeMappedElements(
      participant.id,
      conn,
      log,
      sendFirst,
      identifiedIndexIterationMap,
    );

    for (const e of theirIdentifiedIndexIterationMap) {
      const i = unmappedIndicesByIter[e.iteration][e.theirIndex];
      e.theirIndex = i;
    }

    log.debug(
      `${participant.id}: returning partner's map with original indices, ` +
        "receiving ours",
    );
    const identifiedIndexMap = await exchangeMappedElements(
      participant.id,
      conn,
      log,
      sendFirst,
      theirIdentifiedIndexIterationMap,
    );

    if (numMappedElements != identifiedIndexMap.length) {
      throw new Error(
        `${participant.id} protocol error: returned, unmapped association ` +
          "table of incorrect length",
      );
    }

    return identifiedIndexMap.reduce(
      (acc, x, i) => {
        acc[0].push(originalIndices[i]);
        acc[1].push(x.theirIndex);
        return acc;
      },
      [[], []] as [Array<number>, Array<number>],
    );
  } else {
    throw new Error(
      `psi for cardinality '${protocol.cardinality}' not yet implemented`,
    );
  }
}

// Actionable guidance for a dataset that exceeds the single-pass ceiling,
// identical on both parties and across transports. Deliberately does NOT
// recommend cascade: linkage_strategy is a mandatory-consistency agreed term that
// cannot change unilaterally mid-exchange (re-agreeing on cascade is an
// out-of-band step), so pointing at it here would be misleading. The cap is on
// each party's (key, record) cell count keyCount * recordCount; reducing either
// factor, or splitting the dataset, is the actionable remedy. See
// docs/spec/PROTOCOL.md (the single-pass dataset ceiling).
function singlePassOverCapMessage(
  id: string,
  numLinkageKeys: number,
  senderRecordCount: number,
  receiverRecordCount: number,
): string {
  return (
    `${id}: single-pass cannot carry this dataset: ${numLinkageKeys} linkage ` +
    `key(s) with ${senderRecordCount} sender and ${receiverRecordCount} ` +
    "receiver record(s) exceed the single-pass ceiling. Reduce the number of " +
    "linkage keys or the record count, or split the dataset into smaller batches."
  );
}

// Force a major collection to release a phase's transient allocations before the
// next phase allocates, lowering the lifetime peak RSS that bounds the single-pass
// dataset ceiling. The single-pass receiver's peak is dominated by GC-collectable
// V8 garbage from the per-element JS<->native boundary marshalling -- the library
// binding layer reached through createClientRequest/computeValueMatches/
// createServerSetup -- not by the WebAssembly linear heap (a flat ~16 MB at
// D = 14,000) or by retained JS (a ~20 MB live floor); collecting at the phase
// boundaries recovers it (board item 206377899; the measured sizes, methodology,
// and breakdown are in docs/spec/PROTOCOL.md). A no-op
// unless the runtime exposes a global gc: the CLI launches Node with --expose-gc
// (the Dockerfile entrypoint and the apps/cli dev script), so it gets the relief;
// a browser never exposes gc, so the web receiver does not, and its ceiling rests
// on the same conservative cap.
// Called only at the handful of coarse phase boundaries, never per element or per
// key, so its pause is negligible beside the curve operations it follows.
function relieveTransientMemory(): void {
  (globalThis as typeof globalThis & { gc?: () => void }).gc?.();
}

/**
 * Whether the single-pass receiver withholds the sender's association-table half
 * ({@link linkViaSinglePassPSI}'s message 3) entirely, so a genuinely blind
 * helper's process never receives -- and so never learns -- its own membership
 * (which of its records matched).
 *
 * Withhold exactly when the SENDER is a non-receiving helper (`expectsOutput:
 * false`, so it gets no result table of its own) that ALSO discloses no payload
 * (its metadata transmits no column, so it has no matched rows to enrich). That is
 * the one closeable case in a one-sided single-pass exchange: the helper needs its
 * association-table half only to build its own result (it has none) or to enrich
 * the payload it discloses (it discloses none), so withholding leaves it needing
 * nothing back. A helper that discloses payload still receives the full table (it
 * reads `associationTable[0]` to build enrichment for the overlap -- an intrinsic,
 * threat-model-accepted membership disclosure), and a party entitled to output
 * always receives it.
 *
 * Both parties compute this from the SAME authenticated session state -- the
 * resolved sender's output entitlement and its advertised `disclosesPayload` flag,
 * carried on the terms exchange -- so the receiver's decision to suppress the frame
 * and the sender's decision to skip awaiting it are always the same, keeping the
 * two in lockstep. The frame is suppressed ENTIRELY, never sent empty: an
 * empty-versus-populated association table would leak the match count by the
 * frame's presence and size, so only omitting it closes the channel. See
 * docs/notes/one-sided-disclosure.md and docs/spec/PROTOCOL.md.
 */
export function withholdsSenderAssociationTable(
  senderExpectsOutput: boolean,
  senderDisclosesPayload: boolean,
): boolean {
  return !senderExpectsOutput && !senderDisclosesPayload;
}

/**
 * The single-pass linkage strategy: an alternative to {@link linkViaPSI} that
 * produces the same matched row pairs but uses one network round-trip instead of
 * one per linkage key. exchange.ts chooses between the two on `linkageStrategy`.
 *
 * Keys are applied in order, most precise first; a record matched on an earlier
 * key is set aside before later keys are tried (this is the "cascade"). Here the
 * sender sends, in one shot, which of its records share a value under each key --
 * all records and all keys -- and the receiver replays that whole cascade itself.
 * It needs the full picture because whether a value is unique depends on which
 * records earlier keys already set aside: a value shared by two records becomes
 * usable on a later key once an earlier key has matched one of them. Along the
 * way the receiver sees some matches a less precise key would make that the
 * step-by-step cascade would have discarded, but only the cascade-equivalent
 * result is returned. Wire format and the extra disclosure this costs:
 * docs/spec/PROTOCOL.md; the PSI building blocks it calls are on
 * {@link PSIParticipant}.
 *
 * @param partnerRecordCount - The partner's raw row count, exchanged over the
 *   encrypted channel during role resolution. Together with this party's own row
 *   count and the agreed key count it derives the per-exchange frame cap and the
 *   abort-if-over-ceiling gate -- identically on both parties, so they reach the
 *   same verdict from authenticated session state alone (see frameSize.ts).
 * @param withholdSenderTable - When `true`, the receiver suppresses message 3
 *   (the sender's association-table half) ENTIRELY and the sender skips awaiting
 *   it, so a non-receiving, no-payload helper's process never receives -- and so
 *   never learns -- its own membership. Both parties pass the same value, derived
 *   from symmetric authenticated session state (see
 *   {@link withholdsSenderAssociationTable} and its caller in exchange.ts), so the
 *   suppress and the skip stay in lockstep and neither side blocks on a frame the
 *   other will not send. Defaults to `false` (the frame is exchanged as before).
 *   When it withholds, the sender returns an empty table `[[], []]` -- it genuinely
 *   does not learn its matches, which is the blindness this realizes.
 */
export async function linkViaSinglePassPSI(
  protocol: {
    cardinality: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";
  },
  participant: PSIParticipant,
  conn: MessageConnection,
  data: Array<IndexableIterable<string | undefined>>,
  partnerRecordCount: number,
  withholdSenderTable: boolean = false,
  verbosity: number = 0,
  setStage?: (id: string) => void,
): Promise<AssociationTable> {
  if (participant.config.role === "either")
    throw new Error("participants role is unresolved");
  if (!["one-to-one", "many-to-one"].includes(protocol.cardinality)) {
    throw new Error(
      `psi for cardinality '${protocol.cardinality}' not yet implemented`,
    );
  }

  const log = getLoggerForVerbosity("psiLink", verbosity);
  const stage = setStage ?? (() => {});
  const numLinkageKeys = data.length;
  // Guaranteed by the schema (linkageKeys is .min(1)); checked so a direct caller
  // with empty data cannot make the receiver's frame-length guard below vacuous.
  if (numLinkageKeys < 1)
    throw new Error(
      `${participant.id}: single-pass requires at least one linkage key`,
    );

  log.debug(
    `${participant.id}: linking using ${numLinkageKeys} key(s) via ` +
      `single-pass PSI`,
  );

  // distinctValueIndexTable[j][i] is record i's index into distinctValues for
  // key j, or -1 where that record has no value for the key.
  const { distinctValues, distinctValueIndexTable, numRecords } =
    getDistinctValuesAndIndices(data);

  // Map (own count, partner count, role) -> (senderRecordCount,
  // receiverRecordCount). Both parties derive the SAME pair: the starter is the
  // PSI sender, the joiner the receiver. This is the authenticated session state
  // the frame cap and the over-ceiling gate read -- never the inbound frame.
  const isSender = participant.config.role === "starter";
  const senderRecordCount = isSender ? numRecords : partnerRecordCount;
  const receiverRecordCount = isSender ? partnerRecordCount : numRecords;

  // Authoritative, symmetric over-ceiling gate. Both parties compute it
  // identically from the exchanged counts and the agreed key count, BEFORE
  // exchanging any single-pass frame, so an over-cap exchange aborts on both
  // sides in lockstep -- neither sends nor waits, so neither hangs to the
  // inactivity timeout. The guidance is identical across parties and transports
  // and does not recommend cascade. The prepareForExchange pre-flight is the
  // coarse one-party shadow of this; this is the precise two-party check.
  if (
    singlePassExchangeExceedsCap(
      numLinkageKeys,
      senderRecordCount,
      receiverRecordCount,
    )
  ) {
    throw new Error(
      singlePassOverCapMessage(
        participant.id,
        numLinkageKeys,
        senderRecordCount,
        receiverRecordCount,
      ),
    );
  }

  if (participant.config.role === "starter") {
    // Need to send:
    // - this party's values, encrypted with own key ("setup" message)
    // - partner's data re-encrypted ("response")
    // - distinctValueIndexTable so partner knows how to reconstruct data
    stage("encrypting my data");
    const { setup, permutation } =
      await participant.createServerSetup(distinctValues);

    const request = (await conn.receive()) as Uint8Array;
    // Collect the setup-masking transients before the re-encryption masking.
    relieveTransientMemory();
    stage("doubly-encrypting partner's data");
    const response = await participant.processClientRequest(request);
    // createServerSetup sorted distinctValues; remap the index table into that
    // sorted order so its indices match the sorted setup message.
    const sortedDistinctValueIndices = getSortedDistinctValueIndices(
      distinctValueIndexTable,
      permutation,
    );

    // Layout: docs/spec/PROTOCOL.md.
    const reply = encodeSinglePassReply(
      setup,
      response,
      numRecords,
      sortedDistinctValueIndices,
    );
    // Send-time check against the SAME derived cap the receiver's read gate
    // enforces (singlePassReplyByteCap), so the two are one computation. The
    // over-ceiling gate above already aborted the common case from the counts
    // alone; this is the defensive backstop, since the derived cap upper-bounds
    // any legitimate reply, it fires only on a pathological build (an
    // unexpectedly large serialized element). Same actionable guidance, no
    // cascade.
    const replyCap = singlePassReplyByteCap(
      numLinkageKeys,
      senderRecordCount,
      receiverRecordCount,
    );
    if (reply.byteLength > replyCap) {
      throw new Error(
        singlePassOverCapMessage(
          participant.id,
          numLinkageKeys,
          senderRecordCount,
          receiverRecordCount,
        ),
      );
    }

    log.debug(`${participant.id}: sending combined single-pass reply`);
    await conn.send(reply);
    // Collect the response-masking and reply-build transients before idling on
    // the partner's table.
    relieveTransientMemory();

    if (withholdSenderTable) {
      // We are a non-receiving helper disclosing no payload: the receiver
      // suppresses message 3, so do NOT await a frame it will not send (that would
      // hang to the inactivity timeout). Return an empty table -- we genuinely do
      // not learn which of our records matched, which is the blindness this path
      // realizes. Both sides derived this from the same authenticated state, so the
      // skip and the receiver's suppression agree.
      log.debug(
        `${participant.id}: association table withheld; staying blind to my ` +
          `own matches`,
      );
      stage("done");
      return [[], []];
    }

    const table = await receiveParsed(conn, associationTableMessage);
    stage("done");
    return [table[0], table[1]];
  }

  stage("encrypting my data");
  await conn.send(await participant.createClientRequest(distinctValues));

  // Tighten the read gate to the per-exchange derived cap before reading the
  // reply, then clear it so the later payload read uses the default. Set after
  // our request and before the reply (one peer round trip away), so the file-sync
  // poll loop reads no frame between the set and the read it governs. A transport
  // that bounds its inbound path another way (the WebRTC data channel, fixed at
  // MAX_WEBRTC_FRAME_BYTES) no-ops setInboundFrameCap and relies on that envelope
  // plus the coherence checks below.
  const replyCap = singlePassReplyByteCap(
    numLinkageKeys,
    senderRecordCount,
    receiverRecordCount,
  );
  conn.setInboundFrameCap?.(replyCap);
  let replyFrame: Uint8Array;
  try {
    replyFrame = (await conn.receive()) as Uint8Array;
  } finally {
    conn.setInboundFrameCap?.(undefined);
  }

  const {
    setup: setupBytes,
    response: responseBytes,
    numRecords: numSenderRecords,
    distinctValueIndices: stackedDistinctValueIndices,
  } = decodeSinglePassReply(replyFrame);

  // Validate every count the reply declares against authenticated state, before
  // it drives any allocation. The sender packs its own record count into the
  // reply (part (c) of the wire format); it must equal the count the sender
  // exchanged over the encrypted channel during role resolution
  // (partnerRecordCount), which the over-ceiling gate above already bounded. This
  // ties the decoded count to authenticated state rather than trusting the frame,
  // and the index-table consistency check then confirms the frame actually
  // carries numLinkageKeys * numSenderRecords entries -- both before the
  // allocations below, preserving the pre-allocation ordering.
  if (numSenderRecords !== partnerRecordCount) {
    throw new Error(
      `${participant.id} protocol error: single-pass reply declares ` +
        `${numSenderRecords} sender record(s), but the sender exchanged ` +
        `${partnerRecordCount}`,
    );
  }
  if (
    stackedDistinctValueIndices.length !==
    numLinkageKeys * numSenderRecords
  ) {
    throw new Error(
      `${participant.id} protocol error: single-pass distinct-value index table ` +
        "length does not match the agreed key count",
    );
  }

  // Collect the request-masking transients before the match masking.
  relieveTransientMemory();
  stage("identifying shared elements");
  const [receiverDistinctValueIds, senderDistinctValueIds] =
    await participant.computeValueMatches(setupBytes, responseBytes);
  const distinctValueReceiverToSenderMap = new Map<number, number>();
  for (let k = 0; k < receiverDistinctValueIds.length; ++k) {
    distinctValueReceiverToSenderMap.set(
      receiverDistinctValueIds[k],
      senderDistinctValueIds[k],
    );
  }

  // Split the stacked distinct value indices into one row per key (it is laid
  // out key by key). subarray returns a view over the same memory rather than a
  // copy.
  const senderDistinctValueIndexTable: Array<Int32Array> = [];
  for (let j = 0; j < numLinkageKeys; ++j) {
    senderDistinctValueIndexTable.push(
      stackedDistinctValueIndices.subarray(
        j * numSenderRecords,
        (j + 1) * numSenderRecords,
      ),
    );
  }

  // Collect the match-masking transients (the library's boundary marshalling and
  // the consumed id arrays) before replaying the cascade.
  relieveTransientMemory();

  // Replay the cascade. This is purely local, in-memory work with no on-wire
  // round trip per key -- the whole single-pass exchange already happened in the
  // one setup/response above -- so it completes near-instantly and emits NO
  // per-key stage. A "linking key N / M" line here would flash by uselessly while
  // the operator's real wait was the up-front encryption stages; describeExchange-
  // Stages omits the per-key stages for single-pass to match (cascade keeps them,
  // where each key is a genuine round trip).
  const matched: IndexIterationMap = new Array(numRecords).fill(undefined);
  const senderMatched: Array<boolean> = new Array(numSenderRecords).fill(false);
  for (let j = 0; j < numLinkageKeys; ++j) {
    const receiverDistinctValueToRowMap = getUnmatchedDistinctValueToRowMap(
      distinctValueIndexTable[j],
      (row) => matched[row] !== undefined,
    );
    const senderDistinctValueToRowMap = getUnmatchedDistinctValueToRowMap(
      senderDistinctValueIndexTable[j],
      (row) => senderMatched[row],
    );
    for (const [
      receiverDistinctValue,
      receiverRow,
    ] of receiverDistinctValueToRowMap) {
      const senderDistinctValue = distinctValueReceiverToSenderMap.get(
        receiverDistinctValue,
      );
      if (senderDistinctValue === undefined) continue;
      const senderRow = senderDistinctValueToRowMap.get(senderDistinctValue);
      if (senderRow === undefined) continue;
      matched[receiverRow] = { theirIndex: senderRow, iteration: j };
      senderMatched[senderRow] = true;
    }
  }

  const result: AssociationTable = [[], []];
  for (let i = 0; i < numRecords; ++i) {
    const m = matched[i];
    if (m) {
      result[0].push(i);
      result[1].push(m.theirIndex);
    }
  }

  // Collect the cascade's per-key reconstruction maps before returning.
  relieveTransientMemory();

  if (withholdSenderTable) {
    // The sender is a non-receiving helper disclosing no payload: suppress its
    // association-table half ENTIRELY -- not sent empty. An empty-versus-populated
    // table would leak the match count by the frame's presence and size, so only
    // omitting the frame closes the channel and keeps the helper blind. The sender
    // derived the same decision and skips awaiting this frame, so the two stay in
    // lockstep. We still return our own resolved table below.
    log.debug(
      `${participant.id}: ${result[0].length} match(es); withholding the ` +
        `sender's association-table half`,
    );
    stage("done");
    return result;
  }

  const pairs = result[0].map((i, k): [number, number] => [result[1][k], i]);
  pairs.sort((a, b) => a[0] - b[0]);
  const theirResult: AssociationTable = [
    pairs.map((p) => p[0]),
    pairs.map((p) => p[1]),
  ];

  log.debug(
    `${participant.id}: ${result[0].length} match(es); returning sender's ` +
      `view`,
  );
  await conn.send(theirResult);
  stage("done");
  return result;
}

// For this party, the distinct values (pooled across all keys) plus, for every
// record and key, the index of the value in that cell: distinctValueIndexTable[j][i]
// is the index -- into distinctValues -- of record i's value for key j, or -1 if
// that record has no value for the key. Equal indices mean equal values, so the
// receiver can recover which records share a value without seeing the values
// themselves. "" is a real value with its own index, distinct from -1
// (docs/spec/PROTOCOL.md, Key input data).
function getDistinctValuesAndIndices(
  data: Array<IndexableIterable<string | undefined>>,
): {
  distinctValues: Array<string>;
  distinctValueIndexTable: Array<Array<number>>;
  numRecords: number;
} {
  const valueId = new Map<string, number>();
  const distinctValues: Array<string> = [];
  const distinctValueIndexTable: Array<Array<number>> = [];
  let numRecords = 0;
  for (let j = 0; j < data.length; ++j) {
    const column = Array.from(data[j]);
    if (j === 0) {
      numRecords = column.length;
    } else if (column.length !== numRecords) {
      throw new Error(
        `single-pass: linkage key ${j} has ${column.length} records, ` +
          `expected ${numRecords}; all columns must have the same length`,
      );
    }
    const row: Array<number> = new Array(column.length);
    for (let i = 0; i < column.length; ++i) {
      const value = column[i];
      if (value === undefined) {
        row[i] = -1;
        continue;
      }
      let id = valueId.get(value);
      if (id === undefined) {
        id = distinctValues.length;
        valueId.set(value, id);
        distinctValues.push(value);
      }
      row[i] = id;
    }
    distinctValueIndexTable.push(row);
  }
  return { distinctValues, distinctValueIndexTable, numRecords };
}

// Remap the distinct value index table from build order into the setup
// message's sorted order, so it accurately points to the distinct values for
// each row. createServerSetup yields permutation[sortedPos] = buildId, so we
// have to invert the permutation. -1s are preserved so the empty slots stick
// around. Also flattens the output (stacks column-wise) for sending over the
// wire. Uses a fresh copy, leaving the caller's `distinctValueIndexTable`
// untouched.
function getSortedDistinctValueIndices(
  distinctValueIndexTable: Array<Array<number>>,
  permutation: Array<number>,
): Array<number> {
  const sortedPosOf = new Array<number>(permutation.length);
  for (let sortedPos = 0; sortedPos < permutation.length; ++sortedPos) {
    sortedPosOf[permutation[sortedPos]] = sortedPos;
  }
  const result = distinctValueIndexTable.flat();
  for (let i = 0; i < result.length; ++i) {
    if (result[i] >= 0) result[i] = sortedPosOf[result[i]];
  }
  return result;
}

// Adapts reduceToSingletons for the replay: skips already-matched rows and the -1
// marker for an absent value (0 is a valid value index, so it is kept). ArrayLike
// so it serves both the receiver's number[] and the sender's decoded Int32Array.
function getUnmatchedDistinctValueToRowMap(
  distinctValueIndices: ArrayLike<number>,
  isMatched: (row: number) => boolean,
): Map<number, number> {
  return reduceToSingletons<number>(distinctValueIndices.length, (row) =>
    isMatched(row) || distinctValueIndices[row] < 0
      ? undefined
      : distinctValueIndices[row],
  );
}

// Pack a flat array of value indices as a little-endian Int32 frame (the
// distinct-value index table). Endianness is fixed explicitly so the frame is
// byte-for-byte identical across machines; Int32 covers the -1 marker and every
// value index.
/** @internal exported for the wire-message test. */
export function encodeInt32LE(values: ReadonlyArray<number>): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; ++i) view.setInt32(i * 4, values[i], true);
  return bytes;
}

// Decode a little-endian Int32 frame (see encodeInt32LE). A length that is not a
// whole number of int32s is a protocol error, not a silent truncation; reads
// through a DataView so a non-aligned buffer cannot fault.
/** @internal exported for the wire-message test. */
export function decodeInt32LE(bytes: Uint8Array): Int32Array {
  if (bytes.byteLength % 4 !== 0)
    throw new Error(
      "protocol error: single-pass distinct-value index table is not a whole " +
        "number of int32s",
    );
  const count = bytes.byteLength / 4;
  const values = new Int32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; ++i) values[i] = view.getInt32(i * 4, true);
  return values;
}

// Pack the sender's whole single-pass reply -- setup, response, the record count,
// and the distinct-value index table -- as one binary frame, so a high-latency
// channel pays a single round-trip rather than one per piece. Layout (all
// little-endian):
//   uint32 setupLen | setup bytes
//   uint32 responseLen | response bytes
//   uint32 numRecords
//   the rest: the distinct-value index table, as Int32 (encodeInt32LE)
// setup and response carry explicit lengths; the index table is the remainder, so
// its length is implied by the frame size. See docs/spec/PROTOCOL.md.
/** @internal exported for the wire-message test. */
export function encodeSinglePassReply(
  setup: Uint8Array,
  response: Uint8Array,
  numRecords: number,
  distinctValueIndices: ReadonlyArray<number>,
): Uint8Array {
  const indexBytes = encodeInt32LE(distinctValueIndices);
  const out = new Uint8Array(
    4 + setup.byteLength + 4 + response.byteLength + 4 + indexBytes.byteLength,
  );
  const view = new DataView(out.buffer);
  let offset = 0;
  view.setUint32(offset, setup.byteLength, true);
  offset += 4;
  out.set(setup, offset);
  offset += setup.byteLength;
  view.setUint32(offset, response.byteLength, true);
  offset += 4;
  out.set(response, offset);
  offset += response.byteLength;
  view.setUint32(offset, numRecords, true);
  offset += 4;
  out.set(indexBytes, offset);
  return out;
}

// Split a combined single-pass reply frame (see encodeSinglePassReply) back into
// its parts. A frame too short for a length it declares is a protocol error, not a
// silent under-read; reads through a DataView so a non-aligned buffer cannot fault.
/** @internal exported for the wire-message test. */
export function decodeSinglePassReply(bytes: Uint8Array): {
  setup: Uint8Array;
  response: Uint8Array;
  numRecords: number;
  distinctValueIndices: Int32Array;
} {
  if (!(bytes instanceof Uint8Array))
    throw new Error("protocol error: single-pass reply is not a binary frame");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const readSlice = (what: string): Uint8Array => {
    if (offset + 4 > bytes.byteLength)
      throw new Error(
        `protocol error: single-pass reply truncated reading ${what} length`,
      );
    const len = view.getUint32(offset, true);
    offset += 4;
    if (offset + len > bytes.byteLength)
      throw new Error(
        `protocol error: single-pass reply truncated reading ${what}`,
      );
    const slice = bytes.subarray(offset, offset + len);
    offset += len;
    return slice;
  };
  const setup = readSlice("setup");
  const response = readSlice("response");
  if (offset + 4 > bytes.byteLength)
    throw new Error(
      "protocol error: single-pass reply truncated reading record count",
    );
  const numRecords = view.getUint32(offset, true);
  offset += 4;
  // The distinct-value index table is the remainder; decodeInt32LE rejects a
  // non-int32 length.
  const distinctValueIndices = decodeInt32LE(bytes.subarray(offset));
  return { setup, response, numRecords, distinctValueIndices };
}

async function exchangeMappedElements(
  id: string,
  conn: MessageConnection,
  log: {
    info: (...msg: Array<unknown>) => void;
    debug: (...msg: Array<unknown>) => void;
  },
  sendFirst: boolean,
  values: IterationMap,
): Promise<IterationMap> {
  if (sendFirst) {
    log.debug(`${id}: sending own mapped elements`);
    await conn.send(values);
    log.debug(`${id}: waiting for response`);
    const result = await receiveParsed(conn, associationAndIterationArray);
    log.debug(`${id}: received other mapped elements`);
    return result;
  } else {
    // Send-before-parse: receive the partner's elements, send ours, then
    // validate. Sending before parsing ensures a malformed final frame does
    // not strand the partner waiting for our response.
    const rawData = await conn.receive();
    log.debug(`${id}: received other mapped elements`);
    log.debug(`${id}: sending own mapped elements`);
    await conn.send(values);
    return parseOrProtocolError(associationAndIterationArray, rawData);
  }
}
