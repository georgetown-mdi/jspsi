import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { PSIParticipant } from "../src/participant";
import { linkViaPSI } from "../src/link";

import { createMessagePipe } from "../src/connection/messageConnection";
import { sortAssociationTable } from "./utils/associationTable";
import { UNBOUNDED_PSI_ELEMENTS } from "./utils/psiElementBounds";

// Coverage for the empty-string key value: "" is a present, matchable key
// distinct from undefined (the "no key" sentinel). The conflation site was
// removeDuplicatesAndUndefineds dropping every falsy value; it now drops only
// undefined, so a singleton "" participates in matching while undefined records
// stay excluded. The within-dataset uniqueness rule is unchanged, so a "" that
// is duplicated within a dataset is still dropped from that round. See
// docs/spec/PROTOCOL.md (Key input data).

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

test('a singleton "" key matches on each side; undefined/missing keys do not', async () => {
  // Server row 1 and client row 2 are both "" (the only "" on each side, so each
  // is unique within its dataset and matchable). The undefined rows carry no key
  // and the named rows do not match, so the lone "" pair is the only match.
  const { server, client } = await runLink(
    [[undefined, "", "Alice"]],
    [["Bob", undefined, ""]],
  );

  expect(server[0]).toStrictEqual(client[1]);
  expect(server[1]).toStrictEqual(client[0]);
  expect(server[0]).toStrictEqual([1]);
  expect(server[1]).toStrictEqual([2]);
});

test('a "" duplicated within a dataset is dropped by the uniqueness rule', async () => {
  // The server has two "" values, so every "" is a within-dataset duplicate and
  // is excluded from the round; the client's singleton "" therefore matches
  // nothing, even though a singleton-vs-singleton "" would match.
  const { server, client } = await runLink([["", "", "Alice"]], [["", "Bob"]]);

  expect(server[0]).toStrictEqual([]);
  expect(server[1]).toStrictEqual([]);
  expect(client[0]).toStrictEqual([]);
  expect(client[1]).toStrictEqual([]);
});

test('an all-"" column matches nothing (every "" is a duplicate)', async () => {
  // Every "" on both sides is a within-dataset duplicate, so the round drops
  // them all and produces no match.
  const { server, client } = await runLink([["", ""]], [["", "", ""]]);

  expect(server[0]).toStrictEqual([]);
  expect(server[1]).toStrictEqual([]);
  expect(client[0]).toStrictEqual([]);
  expect(client[1]).toStrictEqual([]);
});

test('a "" key matches in a later round after a non-match carries the row forward', async () => {
  // Two key rounds. Row 0 on each side matches on key 0 ("A") and is removed
  // from the candidate set. Row 1 does not match on key 0 ("B" vs "Z") and
  // carries forward to key 1, where both sides' value is "" -- so the carried-
  // forward "" matches in the later round, confirming an unmatched "" record
  // carries forward like any other rather than being treated as matched or
  // dropped. (Row 0's key-1 values "x"/"y" never participate; it matched first.)
  const { server, client } = await runLink(
    [
      ["A", "B"],
      ["x", ""],
    ],
    [
      ["A", "Z"],
      ["y", ""],
    ],
  );

  expect(server[0]).toStrictEqual(client[1]);
  expect(server[1]).toStrictEqual(client[0]);
  expect(server[0]).toStrictEqual([0, 1]);
  expect(server[1]).toStrictEqual([0, 1]);
});

test('a duplicated "" is dropped while a unique value in the same round still matches', async () => {
  // Server rows 0 and 1 are both "" (within-dataset duplicate -> dropped); row 2
  // is "Alice" (unique). The client carries a single "" and an "Alice". The ""
  // matches nothing (duplicated on the server), but "Alice" still matches -- the
  // uniqueness rule treats "" exactly like any other value and dropping it does
  // not poison the rest of the round.
  const { server, client } = await runLink(
    [["", "", "Alice"]],
    [["", "Alice"]],
  );

  expect(server[0]).toStrictEqual(client[1]);
  expect(server[1]).toStrictEqual(client[0]);
  expect(server[0]).toStrictEqual([2]);
  expect(server[1]).toStrictEqual([1]);
});
