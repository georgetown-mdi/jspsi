import { describe, expect, test } from "vitest";

import PSI from "@openmined/psi.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { PSIParticipant } from "../src/participant";
import { createMessagePipe } from "../src/connection/messageConnection";
import { sortAssociationTable } from "./utils/associationTable";
import { loadNativeAddonOrSkip } from "./utils/nativeAddon";
import { UNBOUNDED_PSI_ELEMENTS } from "./utils/psiElementBounds";

// Cross-backend parity (board item 199653275): a party running the native N-API
// addon and a party running the WASM engine must complete a full identify-
// intersection round and agree, in BOTH role assignments. This is the end-to-end
// consequence of the byte-for-byte interop the wire-vector tests pin: since the
// native addon emits the same setup/request/response bytes as WASM, a mixed
// exchange resolves to the same association table as a same-backend one.
//
// The native addon is a per-platform prebuilt binary, so this SKIPS when no
// prebuild exists for the running platform; CI runs it on the platforms it
// builds.

const wasm = await PSI();

// undefined when no prebuild ships for this platform (the tests below skip); a
// broken addon throws through and fails rather than skipping silently.
const native: PSILibrary | undefined = await loadNativeAddonOrSkip();

const serverData = [
  "Alice",
  "Bob",
  "Carol",
  "David",
  "Elizabeth",
  "Frank",
  "Greta",
];
const clientData = ["Carol", "Elizabeth", "Henry"];

async function runExchange(serverLib: PSILibrary, clientLib: PSILibrary) {
  const [serverConn, clientConn] = createMessagePipe();
  const server = new PSIParticipant(
    "server",
    serverLib,
    { role: "starter", verbose: 0 },
    UNBOUNDED_PSI_ELEMENTS,
  );
  const client = new PSIParticipant(
    "client",
    clientLib,
    { role: "joiner", verbose: 0 },
    UNBOUNDED_PSI_ELEMENTS,
  );
  const [serverResult, clientResult] = await Promise.all([
    server.identifyIntersection(serverConn, serverData),
    client.identifyIntersection(clientConn, clientData),
  ]);
  return [
    sortAssociationTable(serverResult),
    sortAssociationTable(clientResult, true),
  ] as const;
}

// Carol (server 2 / client 0) and Elizabeth (server 4 / client 1) intersect --
// the same expected result as the same-backend round in psiParticipant.test.ts.
function expectExpectedIntersection(
  serverResult: readonly number[][],
  clientResult: readonly number[][],
) {
  expect(serverResult[0]).toStrictEqual(clientResult[1]);
  expect(serverResult[1]).toStrictEqual(clientResult[0]);
  expect(serverResult[0]).toStrictEqual([2, 4]);
  expect(serverResult[1]).toStrictEqual([0, 1]);
}

describe("native <-> WASM cross-backend parity", () => {
  test("native starter and WASM joiner agree", async (ctx) => {
    if (!native) {
      ctx.skip();
      return;
    }
    const [serverResult, clientResult] = await runExchange(native, wasm);
    expectExpectedIntersection(serverResult, clientResult);
  });

  test("WASM starter and native joiner agree", async (ctx) => {
    if (!native) {
      ctx.skip();
      return;
    }
    const [serverResult, clientResult] = await runExchange(wasm, native);
    expectExpectedIntersection(serverResult, clientResult);
  });
});

// The exchanges above use small inputs, so the native addon runs its EC loops
// single-threaded: parallel_ec.cpp only shards at >= kMinInputsForThreads (1024)
// inputs. Nothing else pins the threaded path against WASM. Run a > 1024-element
// flow through each backend from the same keys and assert byte- and association-
// identical output, exercising the threaded encrypt (setup / request), re-encrypt
// (response), and decrypt (association) loops and their shard-clone / index-range
// bookkeeping. Unique inputs make every sort a total order, so both backends
// order identically and the messages compare exactly.
describe("native <-> WASM parity above the threading threshold", () => {
  const toHex = (bytes: Uint8Array): string =>
    Buffer.from(bytes).toString("hex");
  const keyBytes = (hex: string): Uint8Array =>
    Uint8Array.from(Buffer.from(hex, "hex"));

  const serverKeyHex = "42".repeat(32);
  const clientKeyHex = "17".repeat(32);

  // > 1024 and not a multiple of the shard count, so the remainder split in
  // TransformElements is exercised too.
  const bigCount = 1101;
  const bigServerData = Array.from(
    { length: bigCount },
    (_, i) => `element-${i}`,
  );
  // Even indices overlap the server set, odd indices do not: a non-empty match
  // set on top of the threaded decrypt so the association merge is exercised.
  const bigClientData = Array.from({ length: bigCount }, (_, i) =>
    i % 2 === 0 ? `element-${i}` : `client-only-${i}`,
  );

  function runFlow(lib: PSILibrary) {
    const server = lib.server!.createFromKey(keyBytes(serverKeyHex), true);
    const client = lib.client!.createFromKey(keyBytes(clientKeyHex), true);
    try {
      const setup = server.createSetupMessage(
        0.001,
        bigClientData.length,
        bigServerData,
        lib.dataStructure.Raw,
        [],
      );
      const request = client.createRequest(bigClientData);
      const response = server.processRequest(request);
      const association = client
        .getAssociationTable(setup, response)
        .map((row) => [...row]);
      return {
        setup: toHex(setup.serializeBinary()),
        request: toHex(request.serializeBinary()),
        response: toHex(response.serializeBinary()),
        association,
      };
    } finally {
      server.delete();
      client.delete();
    }
  }

  test("threaded native EC loops reproduce the WASM output", (ctx) => {
    if (!native) {
      ctx.skip();
      return;
    }
    expect(runFlow(native)).toStrictEqual(runFlow(wasm));
  });
});
