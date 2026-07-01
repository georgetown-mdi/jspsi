import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { PSIParticipant } from "../../src/participant";
import { createMessagePipe } from "../../src/connection/messageConnection";
import { UNBOUNDED_PSI_ELEMENTS } from "../utils/psiElementBounds";

// End-to-end stress: a full identifyIntersection round between two in-memory
// participants at large N, not just the setup message. This exercises the whole
// pipeline -- server setup, client request, doubly-encrypted response,
// association-table assembly, and the lockstep send/receive -- and so also
// covers the byte-by-byte protobuf marshalling cost on the large-Raw path.
//
// That marshalling makes the full round ~50x costlier per element than the
// setup-message-only test (~1.5ms/element here), so this carries its own
// smaller default and its own knob (PSI_STRESS_E2E_N) rather than sharing
// PSI_STRESS_N. The createSetupMessage test already guards the ~125k overflow
// cliff; pushing a full round above it end-to-end takes minutes, so a heavier
// run needs both the knob and a raised stress-project timeout. OVERLAP is the
// known intersection.
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

  const [serverConn, clientConn] = createMessagePipe();
  const server = new PSIParticipant(
    "server",
    psi,
    { role: "starter", verbose: 0 },
    UNBOUNDED_PSI_ELEMENTS,
  );
  const client = new PSIParticipant(
    "client",
    psi,
    { role: "joiner", verbose: 0 },
    UNBOUNDED_PSI_ELEMENTS,
  );

  const [serverResult, clientResult] = await Promise.all([
    server.identifyIntersection(serverConn, serverData),
    client.identifyIntersection(clientConn, clientData),
  ]);

  const expected = Array.from({ length: OVERLAP }, (_, i) => i);
  expect([...serverResult[0]].sort((a, b) => a - b)).toStrictEqual(expected);
  expect([...clientResult[0]].sort((a, b) => a - b)).toStrictEqual(expected);
});
