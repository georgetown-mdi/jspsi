import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, test } from "vitest";

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

// Native-addon counterpart to psiEngineWireVectors.test.ts (board item
// 199653275): the native N-API backend must reproduce the exact serialized bytes
// committed in psi-engine-wire-vectors.json for the four operations, byte-for-byte
// with the WASM build (same private-join-and-compute P-256 curve and wire
// format). The addon is a prebuilt binary shipped only for some platforms, so
// this suite SKIPS when no prebuild exists for the running platform (e.g. a dev
// laptop whose arch has no prebuild in the vendored package) -- there the WASM
// test covers the contract, and CI runs this on the platforms it builds.

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

describe("PSI native addon wire vectors", () => {
  let psi: PSILibrary | undefined;
  let available = false;

  beforeAll(async () => {
    try {
      const { default: loadNativeLibrary } =
        await import("@openmined/psi.js/psi_native_node.js");
      psi = await loadNativeLibrary();
      available = true;
    } catch {
      // No prebuild for this platform: the addon is absent and the WASM engine
      // (which the sibling test pins) is used instead. Nothing to assert here.
      available = false;
    }
  });

  test("the native addon reproduces the committed known-answer bytes", (ctx) => {
    if (!available || !psi) {
      ctx.skip();
      return;
    }

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
