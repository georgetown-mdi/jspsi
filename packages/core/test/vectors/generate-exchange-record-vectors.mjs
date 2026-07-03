// Regenerates exchange-record-vectors.json: the cross-implementation known-answer
// vectors for buildExchangeRecord. Run from the repo root AFTER building core:
//
//   npm run build -w packages/core
//   node packages/core/test/vectors/generate-exchange-record-vectors.mjs
//   npm run format            # this script emits one array element per line;
//                             # format applies the repo's compact JSON layout
//
// Unlike an independent-oracle KAT (e.g. generate-aead-envelope-vectors.mjs),
// these vectors ARE the deterministic output of buildExchangeRecord; the
// cross-implementation guarantee comes from the browser suite
// (apps/web/test/browser/exchangeRecord.test.ts) reproducing the same vectors
// against the web build, not from an independent oracle here. This regenerator
// preserves each vector's hand-authored name/description/inputs/randomness and
// recomputes only the derived `record` and `keys`, so a deliberate format change
// (such as the committed-payload shape) is re-pinned by re-running it and
// reviewing the diff.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildExchangeRecord } from "../../dist/core.esm.js";

// Node's Buffer decodes unpadded base64url directly, so the regenerator does not
// depend on any core base64 export.
const fromBase64Url = (s) => new Uint8Array(Buffer.from(s, "base64url"));

const path = fileURLToPath(
  new URL("./exchange-record-vectors.json", import.meta.url),
);
const data = JSON.parse(readFileSync(path, "utf8"));

for (const vector of data.vectors) {
  const randomness = {
    bindingNonce: fromBase64Url(vector.randomness.bindingNonce),
    salts: Object.fromEntries(
      Object.entries(vector.randomness.salts).map(([name, value]) => [
        name,
        fromBase64Url(value),
      ]),
    ),
  };
  const { record, keys } = await buildExchangeRecord(vector.inputs, randomness);
  vector.record = record;
  vector.keys = keys;
}

writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
console.log(`regenerated ${data.vectors.length} exchange-record vectors`);
