import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { PSIParticipant } from "../src/participant";
import { linkViaPSI } from "../src/link";

import { createMessagePipe } from "../src/connection/messageConnection";
import { sortAssociationTable } from "./utils/associationTable";
import { UNBOUNDED_PSI_ELEMENTS } from "./utils/psiElementBounds";

// Regression coverage for the empty-linkage-round desync: a later key round can
// be empty on one party only (that party's records are all matched in an earlier
// round while the partner still holds unmatched records). The matching loop must
// run identifyIntersection for every agreed key regardless of local emptiness;
// skipping a locally-empty round drops a send/receive the partner still performs
// and deadlocks the lockstep exchange. Without the fix these tests hang and fail
// on the vitest timeout rather than asserting.

const psiLibrary = await PSI();

async function runLink(
  serverData: Array<Array<string | undefined>>,
  clientData: Array<Array<string | undefined>>,
) {
  const [serverConn, clientConn] = createMessagePipe();
  const server = new PSIParticipant(
    "server",
    psiLibrary,
    { role: "starter", verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
  );
  const client = new PSIParticipant(
    "client",
    psiLibrary,
    { role: "joiner", verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
  );

  const [serverResult, clientResult] = await Promise.all([
    linkViaPSI(
      { cardinality: "one-to-one" },
      server,
      serverConn,
      serverData,
      -1,
    ),
    linkViaPSI(
      { cardinality: "one-to-one" },
      client,
      clientConn,
      clientData,
      -1,
    ),
  ]);

  return {
    server: sortAssociationTable(serverResult),
    client: sortAssociationTable(clientResult, true),
  };
}

test("asymmetric empty round: joiner fully matched early, starter still has unmatched records", async () => {
  // Server keeps Frank unmatched after key 0, so its key-1 set is non-empty;
  // the client matches fully on key 0, so its key-1 set is empty.
  const { server, client } = await runLink(
    [
      ["Carol", "David", "Frank"],
      ["a", "b", "c"],
    ],
    [
      ["Carol", "David"],
      ["x", "y"],
    ],
  );

  expect(server[0]).toStrictEqual(client[1]);
  expect(server[1]).toStrictEqual(client[0]);
  expect(server[0]).toStrictEqual([0, 1]);
  expect(server[1]).toStrictEqual([0, 1]);
});

test("asymmetric empty round: starter fully matched early, joiner still has unmatched records", async () => {
  // Mirror of the above: the starter's key-1 set is empty while the joiner's is
  // not, exercising the desync in the opposite role direction.
  const { server, client } = await runLink(
    [
      ["Carol", "David"],
      ["a", "b"],
    ],
    [
      ["Carol", "David", "Henry"],
      ["x", "y", "z"],
    ],
  );

  expect(server[0]).toStrictEqual(client[1]);
  expect(server[1]).toStrictEqual(client[0]);
  expect(server[0]).toStrictEqual([0, 1]);
  expect(server[1]).toStrictEqual([0, 1]);
});

test("both-empty round: both parties fully matched on key 0, key 1 a no-op", async () => {
  const { server, client } = await runLink(
    [
      ["Carol", "David"],
      ["a", "b"],
    ],
    [
      ["Carol", "David"],
      ["x", "y"],
    ],
  );

  expect(server[0]).toStrictEqual(client[1]);
  expect(server[1]).toStrictEqual(client[0]);
  expect(server[0]).toStrictEqual([0, 1]);
  expect(server[1]).toStrictEqual([0, 1]);
});
