import * as z from 'zod';

import { getLevel, getLogger, levels as logLevels } from 'loglevel';

import type { Connection } from './types';
import type { PSIParticipant } from "./participant";

const getLoggerForVerbosity = (
  name: string | symbol,
  verbose: number
) => {
  const preferredLogLevel =
    verbose >= 2
    ? logLevels.DEBUG
    : (verbose === 1 ? logLevels.INFO : logLevels.WARN);
  
  const result = getLogger(name);
  result.setLevel(
    preferredLogLevel >= getLevel()
    ? preferredLogLevel
    : getLevel(),
    false
  );

  return result;
}

const associationAndIterationArray = z.array(
  z.object({theirIndex: z.number(), iteration: z.number()})
);

interface IndexIterationPair {
  theirIndex: number
  iteration: number
}

type IndexIterationMap = Array<IndexIterationPair | undefined>
type IterationMap = Array<IndexIterationPair>

interface IndexableIterable<T> extends Iterable<T> {
  [index: number]: T;
}

function getUnidentifiedIndices(
  indexIterationMap: IndexIterationMap
): Array<number> {
  return indexIterationMap.reduce(
    (acc, x, i) => { if (!x) acc.push(i); return acc; },
    [] as Array<number>
  );
}

function removeDuplicates(
  dataWithDuplicates: Array<string>,
  permutation?: Array<number>
): [Array<string>, Array<number>] {
  const elementToIndexMap: Map<string, Array<number>> = new Map();
  dataWithDuplicates.forEach((value, i) => {
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

  if (permutation)
    return [data, originalIndices.map(i => permutation[i])];
  return [data, originalIndices];
}

export async function linkViaPSI(
  protocol: {
    cardinality: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many'
  },
  participant: PSIParticipant,
  conn: Connection,
  data: Array<IndexableIterable<string>>,
  verbose: number = 1
)
{
  if (participant.config.role === 'either')
    throw new Error('participants role is unresolved')
  const sendFirst = participant.config.role === 'starter';

  const log = getLoggerForVerbosity('psiLink', verbose);

  log.info(`${participant.id}: linking ${data.length} data elements via PSI`);

  if (['one-to-one', 'many-to-one'].includes(protocol.cardinality)) {
    let indexIterationMap: IndexIterationMap = [];
    const unmappedIndicesByIter: Array<Array<number>> = [];

    for (let j = 0; j < data.length; ++j) {
      let dataWithDuplicates: Array<string>;
      let unidentifiedIndices: Array<number> | undefined;
      if (j === 0) {
        dataWithDuplicates = Array.from(data[j]);
        indexIterationMap = Array(dataWithDuplicates.length).fill(undefined);
      } else {
        unidentifiedIndices = getUnidentifiedIndices(indexIterationMap);
        dataWithDuplicates = unidentifiedIndices.map(i => { return data[j][i]; });
      }
      const [data_j, unmappedIndices] = removeDuplicates(
        dataWithDuplicates,
        unidentifiedIndices
      );
      unmappedIndicesByIter.push(unmappedIndices);

      if (data_j.length === 0) continue;

      const [myIndices, theirIndices] =
        await participant.identifyIntersection(conn, data_j);

      for (let ii = 0; ii < myIndices.length; ++ii) {
        const i = unmappedIndices[myIndices[ii]];

        indexIterationMap[i] = {
          theirIndex: theirIndices[ii],
          iteration: j
        };
      }
    }

    log.info(`${participant.id}: completed link, getting original element indices`);

    const [identifiedIndexIterationMap, originalIndices] = indexIterationMap.reduce(
      (acc, x, i) => {
        if (x) {
          acc[0].push(x);
          acc[1].push(i);
        }
        return acc;
      },
      [[], []] as [IterationMap, Array<number>]
    );

    const numMappedElements = identifiedIndexIterationMap.length;

    const theirIdentifiedIndexIterationMap =
      await exchangeMappedElements(
        participant.id,
        conn,
        log,
        sendFirst,
        identifiedIndexIterationMap
      );

    for (const e of theirIdentifiedIndexIterationMap) {
      const i = unmappedIndicesByIter[e.iteration][
        e.theirIndex
      ];
      e.theirIndex = i;
    }

    const identifiedIndexMap = await exchangeMappedElements(
        participant.id,
        conn,
        log,
        sendFirst,
        theirIdentifiedIndexIterationMap
      );

    if (numMappedElements != identifiedIndexMap.length) {
      throw new Error(
        `${participant.id} protocol error: returned, unmapped association `
        + 'table of incorrect length');
    }

    return identifiedIndexMap
      .reduce((acc, x, i) => {
        acc[0].push(originalIndices[i]);
        acc[1].push(x.theirIndex);
        return acc;
      },
      [[], []] as [Array<number>, Array<number>]
    );
  } else {
    throw new Error(`psi for cardinality '${protocol.cardinality}' not yet implemented`);
  }
}

async function exchangeMappedElements(
  id: string,
  conn: Connection,
  log: { info: (...msg: Array<any>) => void, debug: (...msg: Array<any>) => void },
  sendFirst: boolean,
  values: IterationMap
): Promise<IterationMap>
{
  if (sendFirst) {
    return new Promise((resolve) => {
      conn.once('data', (rawData: unknown) => {
        log.debug(`${id}: received other mapped elements`);
        resolve(associationAndIterationArray.parse(rawData));
      });
      log.debug(`${id}: sending own mapped elements`);
      conn.send(values);
      log.debug(`${id}: waiting for response`);
    });
  } else {
    return new Promise((resolve) => {
      conn.once('data', (rawData: unknown) => {
        log.debug(`${id}: received other mapped elements`);

        log.debug(`${id}: sending own mapped elements`);
        conn.send(values);

        resolve(associationAndIterationArray.parse(rawData));
      });
    });
  }
}
