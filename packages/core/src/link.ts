import * as z from "zod";

import { associationTableMessage, type PSIParticipant } from "./participant";
import type { AssociationTable } from "./types";
import {
  receiveParsed,
  parseOrProtocolError,
  type MessageConnection,
} from "./connection/messageConnection";
import { MAX_FRAME_SIZE_BYTES } from "./connection/frameSize";
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

// The cascade's per-side, within-round reduction, shared by both strategies so
// the "byte-identical table" contract cannot drift. Returns each value occurring
// exactly once (the within-side uniqueness rule) mapped to its sole position, in
// first-occurrence order; `valueAt` returns undefined to skip a position, folding
// the "no key" sentinel and (in the single-pass replay) an already-matched
// survivor into one skip.
function reduceToSingletons<T>(
  count: number,
  valueAt: (index: number) => T | undefined,
): Map<T, number> {
  const occurrences = new Map<T, number>();
  const firstIndex = new Map<T, number>();
  for (let i = 0; i < count; ++i) {
    const value = valueAt(i);
    if (value === undefined) continue;
    const seen = occurrences.get(value);
    if (seen === undefined) {
      occurrences.set(value, 1);
      firstIndex.set(value, i);
    } else {
      occurrences.set(value, seen + 1);
    }
  }
  const singletons = new Map<T, number>();
  for (const [value, n] of occurrences) {
    if (n === 1) singletons.set(value, firstIndex.get(value)!);
  }
  return singletons;
}

// Cascade adapter over reduceToSingletons: drops the undefined "no key" sentinel
// ("" is a real value, kept) and returns each within-input-unique value with its
// original index, remapped through `permutation` when the input is a carried-
// forward subset of a later round. See docs/spec/PROTOCOL.md (Key input data).
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

/**
 * Single-pass linkage strategy: same signature, inputs, and
 * {@link AssociationTable} result as {@link linkViaPSI}, and byte-identical
 * output, but one batched PSI exchange in place of {@link linkViaPSI}'s dependent
 * round per key (selected by the exchange.ts dispatch on `linkageStrategy`).
 *
 * The sender encrypts its full per-key value structure once and ships it; the
 * receiver recovers the cross-party value equality and replays the cascade
 * locally. The full structure is needed -- not a union of per-key unique matches
 * -- because uniqueness is survivor-relative: a value ambiguous over the whole
 * dataset can become unique once an earlier key claims its twin. Only the
 * cascade-equivalent table is returned; the weaker-key matches the receiver
 * necessarily sees are never surfaced. The wire shape and its disclosure tradeoff
 * are specified in docs/spec/PROTOCOL.md; the PSI primitives it composes are on
 * {@link PSIParticipant}.
 */
export async function linkViaSinglePassPSI(
  protocol: {
    cardinality: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";
  },
  participant: PSIParticipant,
  conn: MessageConnection,
  data: Array<IndexableIterable<string | undefined>>,
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
  const keyCount = data.length;
  // Guaranteed by the schema (linkageKeys is .min(1)); checked so a direct caller
  // with empty data cannot make the receiver's frame-length guard below vacuous.
  if (keyCount < 1)
    throw new Error(
      `${participant.id}: single-pass requires at least one linkage key`,
    );

  log.debug(
    `${participant.id}: linking using ${keyCount} key(s) via single-pass PSI`,
  );

  // Each party's distinct values, deduplicated across all keys, with every cell
  // tokenized to its value's index. The replay only ever compares within a key,
  // so a value reused across keys shares one token and one ciphertext.
  const { distinct, tokens, recordCount } = buildDistinctAndTokens(data);

  if (participant.config.role === "starter") {
    // Sender: ship the once-encrypted set, the doubly-encrypted request, and the
    // shape table. The shape table is remapped into the setup's sorted order
    // (tokensInSortedOrder) so the sorting permutation never leaves this side and
    // the receiver's match indices address it directly.
    stage("encrypting my data");
    const { setup, permutation } = participant.createServerSetup(distinct);

    const request = (await conn.receive()) as Uint8Array;
    stage("doubly-encrypting partner's data");
    const response = participant.processClientRequest(request);
    const sortedTokens = tokensInSortedOrder(tokens, permutation);

    // Single-pass cannot stream: the whole shape table is one frame, so it has a
    // tighter row ceiling than the cascade (see docs/spec/PROTOCOL.md). Refuse a
    // frame over the cap here -- with an actionable error pointing at cascade --
    // rather than letting the receiver reject it or the transport's serialization
    // throw an opaque length error on the way out (no transport bounds an OUTBOUND
    // frame; the cap is enforced inbound).
    const shapeFrameBytes = sortedTokens.length * 4;
    if (shapeFrameBytes > MAX_FRAME_SIZE_BYTES) {
      throw new Error(
        `${participant.id}: single-pass shape frame is ${shapeFrameBytes} bytes, ` +
          `over the ${MAX_FRAME_SIZE_BYTES}-byte frame cap; this dataset is too ` +
          "large for single-pass -- use the cascade linkage strategy",
      );
    }

    // Four same-direction frames (the transport carries one binary blob or one
    // JSON object per frame, never mixed): setup, response, a record-count header,
    // and the shape table packed as little-endian Int32 -- 4 bytes/token, far
    // cheaper than JSON for its keyCount x recordCount bulk.
    log.debug(
      `${participant.id}: sending setup, response, header, shape table`,
    );
    await conn.send(setup);
    await conn.send(response);
    await conn.send({ recordCount });
    await conn.send(encodeInt32LE(sortedTokens));

    const table = await receiveParsed(conn, associationTableMessage);
    stage("done");
    return [table[0], table[1]];
  }

  // Receiver (joiner): reconstruct the cascade locally, then return the sender
  // its view.
  stage("encrypting my data");
  await conn.send(participant.createClientRequest(distinct));

  const setupBytes = (await conn.receive()) as Uint8Array;
  const responseBytes = (await conn.receive()) as Uint8Array;
  const header = await receiveParsed(conn, singlePassHeaderMessage);
  const tokenBytes = (await conn.receive()) as Uint8Array;

  const senderRecordCount = header.recordCount;
  if (
    !Number.isInteger(senderRecordCount) ||
    senderRecordCount < 0 ||
    tokenBytes.byteLength !== keyCount * senderRecordCount * 4
  ) {
    throw new Error(
      `${participant.id} protocol error: single-pass shape frame length does ` +
        "not match the agreed key count",
    );
  }
  const flatTokens = decodeInt32LE(tokenBytes);

  // computeMatchTable returns the sender side in setup-message sorted order -- the
  // order the sender remapped its shape table into -- so the ids align with no
  // wire permutation. crossMatch is the value equality: receiver index -> sender
  // index for shared values.
  stage("identifying shared elements");
  const [receiverIds, senderSortedIds] = participant.computeMatchTable(
    setupBytes,
    responseBytes,
  );
  const crossMatch = new Map<number, number>();
  for (let k = 0; k < receiverIds.length; ++k) {
    crossMatch.set(receiverIds[k], senderSortedIds[k]);
  }

  // The key-major shape table as per-key rows; subarray is a zero-copy view.
  const senderTokens: Array<Int32Array> = [];
  for (let j = 0; j < keyCount; ++j) {
    senderTokens.push(
      flatTokens.subarray(j * senderRecordCount, (j + 1) * senderRecordCount),
    );
  }

  // Replay the cascade. uniqueSurvivors (here) and the cascade's
  // removeDuplicatesAndUndefineds both reduce through reduceToSingletons, so the
  // per-round survivor-relative uniqueness -- and thus the table -- is identical
  // to linkViaPSI's by construction. The receiver alone resolves matches, so the
  // two sides cannot disagree the way lockstep rounds can.
  const matched: IndexIterationMap = new Array(recordCount).fill(undefined);
  const senderMatched: Array<boolean> = new Array(senderRecordCount).fill(
    false,
  );
  for (let j = 0; j < keyCount; ++j) {
    stage(`stage ${j + 1} / ${keyCount}`);
    const receiverUnique = uniqueSurvivors(
      tokens[j],
      (row) => matched[row] !== undefined,
    );
    const senderUnique = uniqueSurvivors(
      senderTokens[j],
      (row) => senderMatched[row],
    );
    for (const [receiverId, receiverRow] of receiverUnique) {
      const senderId = crossMatch.get(receiverId);
      if (senderId === undefined) continue;
      const senderRow = senderUnique.get(senderId);
      if (senderRow === undefined) continue;
      matched[receiverRow] = { theirIndex: senderRow, iteration: j };
      senderMatched[senderRow] = true;
    }
  }

  // The receiver returns its own table (ascending receiver index); the sender's
  // view (ascending sender index) rides the final frame. Both are the
  // [localAscending, partner] shape linkViaPSI returns.
  const mine: AssociationTable = [[], []];
  for (let i = 0; i < recordCount; ++i) {
    const m = matched[i];
    if (m) {
      mine[0].push(i);
      mine[1].push(m.theirIndex);
    }
  }
  const pairs = mine[0].map((i, k): [number, number] => [mine[1][k], i]);
  pairs.sort((a, b) => a[0] - b[0]);
  const theirs: AssociationTable = [
    pairs.map((p) => p[0]),
    pairs.map((p) => p[1]),
  ];

  log.debug(
    `${participant.id}: ${mine[0].length} match(es); returning sender's view`,
  );
  await conn.send(theirs);
  stage("done");
  return mine;
}

// The single-pass header frame: just the sender's record count (the shape table
// rides its own binary frame, and the sorting permutation never travels). A
// scalar object, so it carries none of the single-issue-array count surface the
// other frames do.
/** @internal exported for the wire-message test. */
export const singlePassHeaderMessage = z.object({
  recordCount: z.number().int().nonnegative(),
});

// This party's distinct values (deduplicated across all keys) and the per-key
// token rows indexing them: tokens[j][i] is record i's value index for key j, or
// -1 for an absent cell. Equal tokens mean equal values, so the receiver recovers
// both parties' per-round duplicate structure from integers alone. "" is a real
// value with its own index, distinct from -1 (see docs/spec/PROTOCOL.md, Key
// input data).
function buildDistinctAndTokens(
  data: Array<IndexableIterable<string | undefined>>,
): {
  distinct: Array<string>;
  tokens: Array<Array<number>>;
  recordCount: number;
} {
  const valueId = new Map<string, number>();
  const distinct: Array<string> = [];
  const tokens: Array<Array<number>> = [];
  let recordCount = 0;
  for (let j = 0; j < data.length; ++j) {
    const column = Array.from(data[j]);
    if (j === 0) recordCount = column.length;
    const row: Array<number> = new Array(column.length);
    for (let i = 0; i < column.length; ++i) {
      const value = column[i];
      if (value === undefined) {
        row[i] = -1;
        continue;
      }
      let id = valueId.get(value);
      if (id === undefined) {
        id = distinct.length;
        valueId.set(value, id);
        distinct.push(value);
      }
      row[i] = id;
    }
    tokens.push(row);
  }
  return { distinct, tokens, recordCount };
}

// Remap the flat shape table from build order into the setup's sorted order, so
// it shares computeMatchTable's index space and the sorting permutation stays off
// the wire. createServerSetup yields permutation[sortedPos] = buildId; invert it.
// The -1 sentinel is preserved; runs over a fresh copy, leaving the caller's
// `tokens` untouched.
function tokensInSortedOrder(
  tokens: Array<Array<number>>,
  permutation: Array<number>,
): Array<number> {
  const sortedPosOf = new Array<number>(permutation.length);
  for (let sortedPos = 0; sortedPos < permutation.length; ++sortedPos) {
    sortedPosOf[permutation[sortedPos]] = sortedPos;
  }
  const flat = tokens.flat();
  for (let i = 0; i < flat.length; ++i) {
    if (flat[i] >= 0) flat[i] = sortedPosOf[flat[i]];
  }
  return flat;
}

// Single-pass replay adapter over reduceToSingletons, in token space: skips
// already-matched rows and the -1 sentinel (a token of 0 is a real value index,
// kept). ArrayLike so it serves both the receiver's number[] and the sender's
// decoded Int32Array.
function uniqueSurvivors(
  tokens: ArrayLike<number>,
  isMatched: (row: number) => boolean,
): Map<number, number> {
  return reduceToSingletons<number>(tokens.length, (row) =>
    isMatched(row) || tokens[row] < 0 ? undefined : tokens[row],
  );
}

// Pack a flat token array as a little-endian Int32 frame (the shape table).
// Endianness is fixed explicitly so the frame is byte-identical across
// architectures; Int32 covers the -1 sentinel and every value index.
function encodeInt32LE(values: ReadonlyArray<number>): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; ++i) view.setInt32(i * 4, values[i], true);
  return bytes;
}

// Decode a little-endian Int32 frame (see encodeInt32LE). A length that is not a
// whole number of int32s is a protocol error, not a silent truncation; reads
// through a DataView so a non-aligned buffer cannot fault.
function decodeInt32LE(bytes: Uint8Array): Int32Array {
  if (bytes.byteLength % 4 !== 0)
    throw new Error(
      "protocol error: single-pass shape frame is not a whole number of int32s",
    );
  const count = bytes.byteLength / 4;
  const values = new Int32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; ++i) values[i] = view.getInt32(i * 4, true);
  return values;
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
