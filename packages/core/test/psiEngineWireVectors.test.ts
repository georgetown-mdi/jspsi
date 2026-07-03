import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, test } from "vitest";

import PSI from "@openmined/psi.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

// Byte-for-byte interop anchor for the native N-API addon (board item 199653275):
// the vendored WASM engine must reproduce the exact serialized bytes committed in
// psi-engine-wire-vectors.json for the four operations, so the addon -- which
// wraps the same private-join-and-compute P-256 curve and wire format -- has a
// concrete target and a fork re-roll that changes the bytes fails here. See
// generate-psi-engine-wire-vectors.mjs to regenerate. This pins raw wire bytes;
// the resolved intersection/association KATs (item 207302520) live elsewhere.

interface WireVectors {
  revealIntersection: boolean;
  createSetupMessage: { fpr: number; numClientInputs: number };
  serverKeyHex: string;
  clientKeyHex: string;
  serverInputs: string[];
  clientInputs: string[];
  setupMessageHex: string;
  sortingPermutation: number[];
  requestHex: string;
  responseHex: string;
  associationTable: number[][];
}

const vectors: WireVectors = JSON.parse(
  readFileSync(
    new URL("./vectors/psi-engine-wire-vectors.json", import.meta.url),
    "utf-8",
  ),
);

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const keyBytes = (hex: string): Uint8Array =>
  Uint8Array.from(Buffer.from(hex, "hex"));

describe("PSI engine wire vectors", () => {
  let psi: PSILibrary;

  beforeAll(async () => {
    psi = await PSI();
  });

  test("the WASM engine reproduces the committed known-answer bytes", () => {
    const server = psi.server!.createFromKey(
      keyBytes(vectors.serverKeyHex),
      vectors.revealIntersection,
    );
    const client = psi.client!.createFromKey(
      keyBytes(vectors.clientKeyHex),
      vectors.revealIntersection,
    );

    try {
      const sortingPermutation: number[] = [];
      const setup = server.createSetupMessage(
        vectors.createSetupMessage.fpr,
        vectors.createSetupMessage.numClientInputs,
        vectors.serverInputs,
        psi.dataStructure.Raw,
        sortingPermutation,
      );
      expect(toHex(setup.serializeBinary())).toBe(vectors.setupMessageHex);
      expect(sortingPermutation).toEqual(vectors.sortingPermutation);

      const request = client.createRequest(vectors.clientInputs);
      expect(toHex(request.serializeBinary())).toBe(vectors.requestHex);

      const response = server.processRequest(request);
      expect(toHex(response.serializeBinary())).toBe(vectors.responseHex);

      const associationTable = client.getAssociationTable(setup, response);
      expect(associationTable.map((row) => [...row])).toEqual(
        vectors.associationTable,
      );
    } finally {
      server.delete();
      client.delete();
    }
  });
});
