import { describe, expect, test } from "vitest";

import PSI from "@openmined/psi.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { PSIParticipant } from "../src/participant";
import { createMessagePipe } from "../src/connection/messageConnection";
import { sortAssociationTable } from "./utils/associationTable";
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

let native: PSILibrary | undefined;
try {
  const { default: loadNativeLibrary } =
    await import("@openmined/psi.js/psi_native_node.js");
  native = await loadNativeLibrary();
} catch {
  native = undefined;
}

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
