import { Worker } from "node:worker_threads";

import { beforeAll, describe, expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import {
  ShardedPsiDriver,
  concatShardElements,
  mergeAssociationShards,
  mergeSetupShards,
  serializeRequest,
  serializeResponse,
  serializeSetup,
  shardRanges,
} from "./shardedPsiWasmBench";

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

// The invariant the worker-sharding evaluation rests on: splitting a value set
// across engines built from the same key and reassembling the shard outputs
// yields the bytes, the sorting permutation and the association-table pair order
// a single engine produces for the whole set. The starter masks distinct values
// (link.ts), which is the condition the setup permutation needs; the joiner-side
// fixture keeps repeated values, because the association merge does have to
// reproduce their pair order. The measurement driver that uses these merges runs
// its own identity check on every configuration; this pins the rules without
// spawning a worker.

const REVEAL_INTERSECTION = true;
const FALSE_POSITIVE_RATE = 0.0;
const CLIENT_INPUT_COUNT = -1;

const keyBytes = (fill: number): Uint8Array => {
  const key = new Uint8Array(32).fill(fill);
  key[0] = 0x00;
  return key;
};

const SERVER_KEY = keyBytes(0x11);
const CLIENT_KEY = keyBytes(0x22);

const SERVER_VALUES = Array.from(
  { length: 27 },
  (_, index) => `starter-${index}`,
);
const CLIENT_VALUES = [
  ...Array.from({ length: 16 }, (_, index) => `starter-${index + 8}`),
  "starter-9",
  "joiner-only",
  "starter-9",
];

const SHARD_COUNTS = [1, 2, 3, 5];

describe("sharded PSI masking reassembly", () => {
  let psi: PSILibrary;

  beforeAll(async () => {
    psi = await PSI();
  });

  const withEngines = <T>(
    use: (
      server: ReturnType<NonNullable<PSILibrary["server"]>["createFromKey"]>,
      client: ReturnType<NonNullable<PSILibrary["client"]>["createFromKey"]>,
    ) => T,
  ): T => {
    const server = psi.server!.createFromKey(SERVER_KEY, REVEAL_INTERSECTION);
    const client = psi.client!.createFromKey(CLIENT_KEY, REVEAL_INTERSECTION);
    try {
      return use(server, client);
    } finally {
      server.delete();
      client.delete();
    }
  };

  test.each(SHARD_COUNTS)(
    "a %i-way split reproduces the whole round byte for byte",
    (shardCount) => {
      withEngines((server, client) => {
        const wholePermutation: number[] = [];
        const wholeSetup = server.createSetupMessage(
          FALSE_POSITIVE_RATE,
          CLIENT_INPUT_COUNT,
          SERVER_VALUES,
          psi.dataStructure.Raw,
          wholePermutation,
        );
        const wholeRequest = client.createRequest(CLIENT_VALUES);
        const wholeResponse = server.processRequest(wholeRequest);
        const wholeTable = client.getAssociationTable(
          wholeSetup,
          wholeResponse,
        );

        const serverRanges = shardRanges(SERVER_VALUES.length, shardCount);
        const mergedSetup = mergeSetupShards(
          serverRanges.map((range) => {
            const permutation: number[] = [];
            const setup = server.createSetupMessage(
              FALSE_POSITIVE_RATE,
              CLIENT_INPUT_COUNT,
              SERVER_VALUES.slice(range.start, range.end),
              psi.dataStructure.Raw,
              permutation,
            );
            return {
              start: range.start,
              elements: setup.getRaw()!.getEncryptedElementsList_asU8(),
              permutation,
            };
          }),
        );
        expect(serializeSetup(psi, mergedSetup.elements)).toEqual(
          wholeSetup.serializeBinary(),
        );
        expect(mergedSetup.permutation).toEqual(wholePermutation);

        const clientRanges = shardRanges(CLIENT_VALUES.length, shardCount);
        const mergedRequest = concatShardElements(
          clientRanges.map((range) =>
            client
              .createRequest(CLIENT_VALUES.slice(range.start, range.end))
              .getEncryptedElementsList_asU8(),
          ),
        );
        expect(serializeRequest(psi, mergedRequest)).toEqual(
          wholeRequest.serializeBinary(),
        );

        const mergedResponse = concatShardElements(
          clientRanges.map((range) =>
            server
              .processRequest(
                psi.request.deserializeBinary(
                  serializeRequest(
                    psi,
                    mergedRequest.slice(range.start, range.end),
                  ),
                ),
              )
              .getEncryptedElementsList_asU8(),
          ),
        );
        expect(serializeResponse(psi, mergedResponse)).toEqual(
          wholeResponse.serializeBinary(),
        );

        const mergedTable = mergeAssociationShards(
          clientRanges.map((range) => {
            const table = client.getAssociationTable(
              wholeSetup,
              psi.response.deserializeBinary(
                serializeResponse(
                  psi,
                  mergedResponse.slice(range.start, range.end),
                ),
              ),
            );
            return {
              start: range.start,
              localIndices: table[0]!,
              partnerIndices: table[1]!,
            };
          }),
        );
        expect(mergedTable).toEqual([wholeTable[0], wholeTable[1]]);
      });
    },
  );

  test("a repeated value keeps the bytes but not the engine's tie order", () => {
    const repeated = ["one", "two", "one", "three", "two", "one"];
    withEngines((server) => {
      const wholePermutation: number[] = [];
      const wholeSetup = server.createSetupMessage(
        FALSE_POSITIVE_RATE,
        CLIENT_INPUT_COUNT,
        repeated,
        psi.dataStructure.Raw,
        wholePermutation,
      );
      const merged = mergeSetupShards(
        shardRanges(repeated.length, 3).map((range) => {
          const permutation: number[] = [];
          const setup = server.createSetupMessage(
            FALSE_POSITIVE_RATE,
            CLIENT_INPUT_COUNT,
            repeated.slice(range.start, range.end),
            psi.dataStructure.Raw,
            permutation,
          );
          return {
            start: range.start,
            elements: setup.getRaw()!.getEncryptedElementsList_asU8(),
            permutation,
          };
        }),
      );
      expect(serializeSetup(psi, merged.elements)).toEqual(
        wholeSetup.serializeBinary(),
      );
      // Each position still names an input holding the value that position
      // masks, which is all a merge can promise where the engine's sort breaks
      // ties by its own internal order.
      expect(merged.permutation.map((input) => repeated[input])).toEqual(
        wholePermutation.map((input) => repeated[input]),
      );
    });
  });

  test("the split covers every input exactly once", () => {
    for (const shardCount of SHARD_COUNTS) {
      const ranges = shardRanges(23, shardCount);
      expect(ranges).toHaveLength(shardCount);
      expect(ranges[0]!.start).toBe(0);
      expect(ranges.at(-1)!.end).toBe(23);
      for (let index = 1; index < ranges.length; index += 1)
        expect(ranges[index]!.start).toBe(ranges[index - 1]!.end);
    }
  });
});

// The driver's failure and concurrency rules, driven over stand-in workers so a
// crash and an overlapping call can be provoked without a WASM engine.
describe("sharded PSI driver", () => {
  const workerOver = (body: string): Worker =>
    new Worker(
      `const { parentPort } = require("node:worker_threads");
       parentPort.postMessage({ id: 0, ready: true });
       ${body}`,
      { eval: true },
    );

  test("a shard worker that throws rejects the operation waiting on it", async () => {
    const driver = await ShardedPsiDriver.over([
      workerOver(`parentPort.on("message", () => {
         throw new Error("the shard worker crashed");
       });`),
    ]);
    try {
      await expect(driver.maskClientValues(["one", "two"])).rejects.toThrow(
        "the shard worker crashed",
      );
    } finally {
      await driver.dispose();
    }
  });

  test("a second operation started before the first settles is refused", async () => {
    const driver = await ShardedPsiDriver.over([
      workerOver(`parentPort.on("message", (request) => {
         setTimeout(
           () =>
             parentPort.postMessage({
               id: request.id,
               ok: true,
               result: { elements: [] },
             }),
           20,
         );
       });`),
    ]);
    try {
      const first = driver.maskClientValues(["one"]);
      await expect(driver.maskClientValues(["two"])).rejects.toThrow(
        "one operation at a time",
      );
      await expect(first).resolves.toEqual([]);
      await expect(driver.maskClientValues(["three"])).resolves.toEqual([]);
    } finally {
      await driver.dispose();
    }
  });
});
