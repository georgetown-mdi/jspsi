// Confirms the vendored native PSI addon selected for THIS runtime loads and
// reproduces the committed byte-for-byte known-answer vectors (which are the WASM
// engine's output, so a match proves native/WASM interop). Native-only, so a
// minimal install of just the tarball is enough. The vitest native suites run on
// the glibc CI host and select the glibc build, so they cannot exercise the musl
// build; the native_alpine.yaml workflow runs this under node:26-alpine (the
// shipped CLI base image) to close that gap.
//
// Local (dev machine, uses the workspace install), from the repo root:
//
//   node packages/core/test/vectors/verify-native-wire-vectors.mjs
//
// The fixture path may be passed as argv[2] so the script can run from a scratch
// install directory -- see native_alpine.yaml, which installs the tarball fresh
// inside Alpine and copies this script next to it.
//
// Exits non-zero on any mismatch. Mirrors generate-psi-engine-wire-vectors.mjs.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import loadNative from "@openmined/psi.js/psi_native_node.js";

const fixturePath =
  process.argv[2] ??
  join(
    process.cwd(),
    "packages/core/test/vectors/psi-engine-wire-vectors.json",
  );
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

const toHex = (bytes) => Buffer.from(bytes).toString("hex");
const keyBytes = (hex) => Uint8Array.from(Buffer.from(hex, "hex"));

const glibc = process.report?.getReport?.().header?.glibcVersionRuntime;
console.log(
  `runtime libc: ${glibc ? `glibc ${glibc}` : "musl (no glibc runtime)"}`,
);

const psi = await loadNative();
const server = psi.server.createFromKey(
  keyBytes(fixture.serverKeyHex),
  fixture.revealIntersection,
);
const client = psi.client.createFromKey(
  keyBytes(fixture.clientKeyHex),
  fixture.revealIntersection,
);
const sortingPermutation = [];
const setup = server.createSetupMessage(
  fixture.createSetupMessage.fpr,
  fixture.createSetupMessage.numClientInputs,
  fixture.serverInputs,
  psi.dataStructure.Raw,
  sortingPermutation,
);
const request = client.createRequest(fixture.clientInputs);
const response = server.processRequest(request);
const associationTable = client.getAssociationTable(setup, response);
const got = {
  setupMessageHex: toHex(setup.serializeBinary()),
  sortingPermutation: [...sortingPermutation],
  requestHex: toHex(request.serializeBinary()),
  responseHex: toHex(response.serializeBinary()),
  associationTable: associationTable.map((row) => [...row]),
};
server.delete();
client.delete();

const fields = [
  "setupMessageHex",
  "sortingPermutation",
  "requestHex",
  "responseHex",
  "associationTable",
];
let ok = true;
for (const field of fields) {
  const expected = JSON.stringify(fixture[field]);
  const actual = JSON.stringify(got[field]);
  const pass = actual === expected;
  ok &&= pass;
  console.log(`${pass ? "PASS" : "FAIL"}  ${field}`);
  if (!pass) {
    console.log(`   expected: ${expected}`);
    console.log(`   native:   ${actual}`);
  }
}

console.log(
  ok
    ? "\nOK: native backend reproduces the committed known-answer vectors byte-for-byte"
    : "\nFAIL: native output diverged from the committed vectors",
);
process.exit(ok ? 0 : 1);
