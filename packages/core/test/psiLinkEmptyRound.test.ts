import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { runLink } from "./utils/runLink";

// Regression coverage for the empty-linkage-round desync: a later key round can
// be empty on one party only (that party's records are all matched in an earlier
// round while the partner still holds unmatched records). The matching loop must
// run identifyIntersection for every agreed key regardless of local emptiness;
// skipping a locally-empty round drops a send/receive the partner still performs
// and deadlocks the lockstep exchange. Without the fix these tests hang and fail
// on the vitest timeout rather than asserting.

const psiLibrary = await PSI();

test("asymmetric empty round: joiner fully matched early, starter still has unmatched records", async () => {
  // Server keeps Frank unmatched after key 0, so its key-1 set is non-empty;
  // the client matches fully on key 0, so its key-1 set is empty.
  const { server, client } = await runLink(
    psiLibrary,
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
    psiLibrary,
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
    psiLibrary,
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
