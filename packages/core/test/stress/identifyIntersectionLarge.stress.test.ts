import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { PSIParticipant } from "../../src/participant";
import { createMessagePipe } from "../../src/connection/messageConnection";
import { psiElementBounds } from "../../src/connection/frameSize";

// End-to-end stress: a full identifyIntersection round at large N,
// exercising the whole pipeline including protobuf marshalling cost --
// about 50x costlier per element than the setup-message-only test, hence a
// smaller default and its own env setting (PSI_STRESS_E2E_N) rather than
// PSI_STRESS_N. createSetupMessage covers the ~125k overflow cliff; a
// heavier run here takes minutes, needing the setting and a raised timeout.
const N = Number(process.env.PSI_STRESS_E2E_N ?? 25_000);
const OVERLAP = Math.min(1_000, N);

const psi = await PSI();

test(`identifyIntersection over ${N} elements yields the ${OVERLAP} shared ids`, async () => {
  // Disjoint sets that share OVERLAP common ids at the leading positions, so the
  // expected local match indices on each side are exactly [0, OVERLAP).
  const serverData = Array.from({ length: N }, (_, i) => `s-${i}`);
  const clientData = Array.from({ length: N }, (_, i) => `c-${i}`);
  for (let i = 0; i < OVERLAP; ++i) {
    serverData[i] = clientData[i] = `shared-${i}`;
  }

  // Exercise the element-count guard at scale with the real derived bound
  // rather than disabling it: one PSI round (keyCount 1) over N distinct
  // values per side, so each masked set holds exactly N elements and the
  // tight bound N admits it -- proving the guard never rejects a large
  // legitimate frame.
  const [serverConn, clientConn] = createMessagePipe();
  const bounds = psiElementBounds(
    { effectiveKeyCount: 1, recordCount: N },
    { effectiveKeyCount: 1, recordCount: N },
  );
  const server = new PSIParticipant(
    "server",
    psi,
    { role: "starter", verbose: 0 },
    bounds,
  );
  const client = new PSIParticipant(
    "client",
    psi,
    { role: "joiner", verbose: 0 },
    bounds,
  );

  const [serverResult, clientResult] = await Promise.all([
    server.identifyIntersection(serverConn, serverData),
    client.identifyIntersection(clientConn, clientData),
  ]);

  const expected = Array.from({ length: OVERLAP }, (_, i) => i);
  expect([...serverResult[0]].sort((a, b) => a - b)).toStrictEqual(expected);
  expect([...clientResult[0]].sort((a, b) => a - b)).toStrictEqual(expected);
});
