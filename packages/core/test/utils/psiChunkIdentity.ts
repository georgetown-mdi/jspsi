import { expect } from "vitest";

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { InProcessPsiEngine } from "../../src/psi/psiEngine";
import { fixedKeyPsiLibrary, psiTestKey } from "./fixedKeyPsiLibrary";

// The wire claim the chunked engine rests on: splitting one operation and
// reassembling the chunk results yields the BYTES a single call over the whole
// set produces, for the server setup, the client request and the server
// response, and the element-identical association table and intersection size.
// Driven against the library under the same key on both sides rather than
// argued, and run over every backend the running platform has.

const SERVER_KEY = psiTestKey(0x11);
const CLIENT_KEY = psiTestKey(0x22);
const FALSE_POSITIVE_RATE = 0.0;
const CLIENT_INPUT_COUNT = -1;

/** A set and the partner set overlapping it on every other value. */
export function chunkIdentityValues(total: number): {
  serverValues: Array<string>;
  clientValues: Array<string>;
} {
  return {
    serverValues: Array.from({ length: total }, (_, index) => `v-${index}`),
    clientValues: Array.from({ length: total }, (_, index) =>
      index % 2 === 0 ? `v-${index}` : `joiner-only-${index}`,
    ),
  };
}

function engine(
  library: PSILibrary,
  role: "starter" | "joiner",
  revealsIdentifiers: boolean,
  chunkElements: number | undefined,
): InProcessPsiEngine {
  return new InProcessPsiEngine(
    fixedKeyPsiLibrary(library, SERVER_KEY, CLIENT_KEY),
    role,
    role,
    revealsIdentifiers ? "identifier-revealing" : "count-only",
    chunkElements === undefined ? {} : { chunkElements },
  );
}

/**
 * Asserts that a chunked engine reproduces the single call's output for every
 * operation of an identifier-revealing round, and returns the processed counts
 * each operation reported so a caller can assert the cadence.
 *
 * `chunkElements` sets the chunk size; left out, the shipped sizing policy
 * decides, which is what a run at production scale exercises.
 */
export async function expectChunkedRoundMatchesSingleCall(params: {
  library: PSILibrary;
  serverValues: ReadonlyArray<string>;
  clientValues: ReadonlyArray<string>;
  chunkElements?: number;
}): Promise<Record<string, Array<number>>> {
  const { library, serverValues, clientValues, chunkElements } = params;
  const server = library.server!.createFromKey(SERVER_KEY, true);
  const client = library.client!.createFromKey(CLIENT_KEY, true);
  const starter = engine(library, "starter", true, chunkElements);
  const joiner = engine(library, "joiner", true, chunkElements);
  const processed: Record<string, Array<number>> = {};
  let operation = "";
  const observe = (target: InProcessPsiEngine): void =>
    target.observeProcessedElements((count) =>
      (processed[operation] ??= []).push(count),
    );
  observe(starter);
  observe(joiner);
  try {
    const sortingPermutation: Array<number> = [];
    const wholeSetup = server.createSetupMessage(
      FALSE_POSITIVE_RATE,
      CLIENT_INPUT_COUNT,
      serverValues,
      library.dataStructure.Raw,
      sortingPermutation,
    );
    const wholeRequest = client.createRequest(clientValues);
    const wholeResponse = server.processRequest(wholeRequest);
    const wholeTable = client.getAssociationTable(wholeSetup, wholeResponse);

    operation = "createServerSetup";
    const chunkedSetup = await starter.createServerSetup(serverValues);
    expect(chunkedSetup.setup).toEqual(wholeSetup.serializeBinary());
    expect(chunkedSetup.permutation).toStrictEqual(sortingPermutation);

    operation = "createClientRequest";
    const chunkedRequest = await joiner.createClientRequest(clientValues);
    expect(chunkedRequest).toEqual(wholeRequest.serializeBinary());

    operation = "processClientRequest";
    const chunkedResponse = await starter.processClientRequest(chunkedRequest);
    expect(chunkedResponse).toEqual(wholeResponse.serializeBinary());

    operation = "computeAssociationTable";
    await joiner.receiveServerSetup(chunkedSetup.setup);
    expect(await joiner.computeAssociationTable(chunkedResponse)).toStrictEqual(
      [wholeTable[0], wholeTable[1]],
    );
  } finally {
    starter.dispose();
    joiner.dispose();
    server.delete();
    client.delete();
  }
  return processed;
}

/**
 * Asserts that a chunked count-only round reports the cardinality the single
 * call reports, and returns the processed counts the match reported.
 */
export async function expectChunkedCountMatchesSingleCall(params: {
  library: PSILibrary;
  serverValues: ReadonlyArray<string>;
  clientValues: ReadonlyArray<string>;
  chunkElements?: number;
}): Promise<Array<number>> {
  const { library, serverValues, clientValues, chunkElements } = params;
  const server = library.server!.createFromKey(SERVER_KEY, false);
  const client = library.client!.createFromKey(CLIENT_KEY, false);
  const starter = engine(library, "starter", false, chunkElements);
  const joiner = engine(library, "joiner", false, chunkElements);
  const processed: Array<number> = [];
  try {
    const wholeSetup = server.createSetupMessage(
      FALSE_POSITIVE_RATE,
      CLIENT_INPUT_COUNT,
      serverValues,
      library.dataStructure.Raw,
      [],
    );
    const wholeResponse = server.processRequest(
      client.createRequest(clientValues),
    );
    const wholeSize = client.getIntersectionSize(wholeSetup, wholeResponse);

    const setup = await starter.createServerSetup(serverValues);
    expect(setup.setup).toEqual(wholeSetup.serializeBinary());
    expect(setup.permutation).toStrictEqual([]);
    const request = await joiner.createClientRequest(clientValues);
    const response = await starter.processClientRequest(request);
    // The count-only response is sorted rather than answered position by
    // position, so this is where a merge that concatenated the chunks would
    // put different bytes on the wire.
    expect(response).toEqual(wholeResponse.serializeBinary());
    await joiner.receiveServerSetup(setup.setup);
    joiner.observeProcessedElements((count) => processed.push(count));
    expect(await joiner.computeIntersectionCardinality(response)).toBe(
      wholeSize,
    );
    expect(wholeSize).toBeGreaterThan(0);
  } finally {
    starter.dispose();
    joiner.dispose();
    server.delete();
    client.delete();
  }
  return processed;
}
