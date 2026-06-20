import type { PSIParticipant } from "./participant";
import {
  receiveParsed,
  parseOrProtocolError,
  type MessageConnection,
} from "./connection/messageConnection";
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
// `z.object({ theirIndex: z.number(), iteration: z.number() })` for acceptance
// (Number.isFinite per field, like z.number()); unlike that object schema it
// does not strip unknown keys, which is immaterial -- a legitimate partner sends
// exactly these two keys, and only theirIndex/iteration are ever read. This array
// is read both via receiveParsed (sendFirst, below) and via a direct `.parse()`
// (the !sendFirst send-before-parse path, wrapped in parseOrProtocolError) so
// either way a malformed frame surfaces a clean ConnectionError("protocol").
/** @internal exported for the pathological-count wire-message test. */
export const associationAndIterationArray =
  singleIssueArray<IndexIterationPair>(
    (value) =>
      typeof value === "object" &&
      value !== null &&
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

function removeDuplicatesAndUndefineds(
  dataWithDuplicatesAndUndefineds: Array<string | undefined>,
  permutation?: Array<number>,
): [Array<string>, Array<number>] {
  const elementToIndexMap: Map<string, Array<number>> = new Map();
  dataWithDuplicatesAndUndefineds.forEach((value, i) => {
    if (!value) return;
    const arr = elementToIndexMap.get(value);
    if (arr) {
      arr.push(i);
    } else {
      elementToIndexMap.set(value, [i]);
    }
  });
  const originalIndices: Array<number> = [];
  const data: Array<string> = [];
  elementToIndexMap.forEach((arr, value) => {
    if (arr.length === 1) {
      originalIndices.push(arr[0]);
      data.push(value);
    }
  });

  if (permutation) return [data, originalIndices.map((i) => permutation[i])];
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
