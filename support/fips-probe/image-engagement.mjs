#!/usr/bin/env node
// Does an image's OWN shipped configuration engage a FIPS provider?
//
// The legs and the verdict are in `engagement.mjs` beside this file; this is
// the gate that renders them. It ships inside the FIPS variant image, whose
// entrypoint preamble runs it at every container start and reads its exit
// status, and `.github/workflows/image_smoke.yaml` runs that same shipped copy
// against the built image, where the JSON transcript below is what a reviewer
// reads. A non-zero exit is a finding here rather than a harness fault --
// unlike `webcrypto-probe.mjs`, this script is a gate.

import { measureEngagement } from "./engagement.mjs";

const summary = await measureEngagement();

console.log(`IMAGE_ENGAGEMENT_JSON: ${JSON.stringify(summary)}`);
for (const failure of summary.failures) console.log(`- ${failure}`);
console.log(`IMAGE ENGAGEMENT VERDICT: ${summary.verdict}`);
process.exit(summary.failures.length === 0 ? 0 : 1);
