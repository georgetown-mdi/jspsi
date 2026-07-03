// Regenerates psi-engine-wire-vectors.json: byte-for-byte known-answer vectors
// for the four PSI engine operations (createSetupMessage, createRequest,
// processRequest, getAssociationTable). Run from the repo root:
//
//   node packages/core/test/vectors/generate-psi-engine-wire-vectors.mjs
//   npm run format            # this script emits one array element per line;
//                             # format applies the repo's compact JSON layout
//
// Purpose: these are the INTEROP anchor for the native N-API addon (board item
// 199653275). Its acceptance criterion is that each native operation is
// byte-for-byte interoperable with the WASM build; this fixture pins the exact
// bytes the vendored @openmined/psi.js WASM engine emits for fixed keys and
// inputs, so the addon has a concrete target and a fork re-roll that changes the
// bytes trips a deterministic gate (psiEngineWireVectors.test.ts).
//
// The commutative-cipher output is deterministic for a fixed private key and
// fixed inputs (EC point H(x)^k, no per-message nonce), which is why fixed-key
// vectors are byte-stable -- verified by regenerating twice. The keys are pinned
// via createFromKey with a leading zero byte so each 32-byte scalar stays below
// the P-256 group order.
//
// This is distinct from the resolved-projection KAT tracked by item 207302520
// (which pins the intersection/association mapping, not raw wire bytes); the two
// anchor different claims and may later share this directory.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import PSI from "@openmined/psi.js";

const SERVER_KEY = new Uint8Array(32).fill(0x11);
SERVER_KEY[0] = 0x00;
const CLIENT_KEY = new Uint8Array(32).fill(0x22);
CLIENT_KEY[0] = 0x00;

const REVEAL_INTERSECTION = true;
// createSetupMessage arguments the protocol always uses (see participant.ts):
// false-positive rate 0.0 and numClientInputs -1 with the Raw data structure.
const FPR = 0.0;
const NUM_CLIENT_INPUTS = -1;

const SERVER_INPUTS = [
  "Alice",
  "Bob",
  "Carol",
  "David",
  "Elizabeth",
  "Frank",
  "Greta",
];
const CLIENT_INPUTS = ["Carol", "Elizabeth", "Henry"];

const toHex = (bytes) => Buffer.from(bytes).toString("hex");

const psi = await PSI();

function generate() {
  const server = psi.server.createFromKey(SERVER_KEY, REVEAL_INTERSECTION);
  const client = psi.client.createFromKey(CLIENT_KEY, REVEAL_INTERSECTION);

  const sortingPermutation = [];
  const setup = server.createSetupMessage(
    FPR,
    NUM_CLIENT_INPUTS,
    SERVER_INPUTS,
    psi.dataStructure.Raw,
    sortingPermutation,
  );
  const request = client.createRequest(CLIENT_INPUTS);
  const response = server.processRequest(request);
  const associationTable = client.getAssociationTable(setup, response);

  const result = {
    setupMessageHex: toHex(setup.serializeBinary()),
    sortingPermutation: [...sortingPermutation],
    requestHex: toHex(request.serializeBinary()),
    responseHex: toHex(response.serializeBinary()),
    associationTable: associationTable.map((row) => [...row]),
  };

  server.delete();
  client.delete();
  return result;
}

// Regenerate twice and assert byte-stability, so a future engine that is NOT
// deterministic for a fixed key cannot silently produce a fixture the consumer
// test can never reproduce.
const first = generate();
const second = generate();
if (JSON.stringify(first) !== JSON.stringify(second)) {
  throw new Error(
    "PSI engine output is not deterministic for a fixed key; byte-level " +
      "known-answer vectors are not valid for this engine.",
  );
}

const doc = {
  description:
    "Byte-for-byte known-answer vectors for the four @openmined/psi.js engine " +
    "operations (createSetupMessage, createRequest, processRequest, " +
    "getAssociationTable) over NIST P-256 with reveal-intersection and the Raw " +
    "data structure. Each output is the exact serialized wire bytes the vendored " +
    "WASM engine emits for the fixed server/client keys and inputs below. This is " +
    "the interop anchor for the native N-API addon (board item 199653275): a " +
    "native operation must reproduce these bytes to be byte-for-byte " +
    "interoperable with the WASM build. Distinct from the resolved-projection KAT " +
    "of item 207302520. Regenerate with generate-psi-engine-wire-vectors.mjs in " +
    "this directory.",
  curve: "NIST P-256",
  revealIntersection: REVEAL_INTERSECTION,
  dataStructure: "Raw",
  createSetupMessage: { fpr: FPR, numClientInputs: NUM_CLIENT_INPUTS },
  serverKeyHex: toHex(SERVER_KEY),
  clientKeyHex: toHex(CLIENT_KEY),
  serverInputs: SERVER_INPUTS,
  clientInputs: CLIENT_INPUTS,
  ...first,
};

const outPath = fileURLToPath(
  new URL("./psi-engine-wire-vectors.json", import.meta.url),
);
writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote psi engine wire vectors to ${outPath}`);
