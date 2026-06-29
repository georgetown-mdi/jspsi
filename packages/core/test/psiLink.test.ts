import { expect, test } from "vitest";

import log from "loglevel";

import PSI from "@openmined/psi.js";

import { PSIParticipant } from "../src/participant";
import {
  linkViaPSI,
  linkViaSinglePassPSI,
  associationAndIterationArray,
  encodeInt32LE,
  decodeInt32LE,
  encodeSinglePassReply,
  decodeSinglePassReply,
  SINGLE_PASS_MAX_REPLY_BYTES,
  singlePassReplyWouldExceedCap,
} from "../src/link";
import { MAX_FRAME_SIZE_BYTES } from "../src/connection/frameSize";

import {
  createMessagePipe,
  receiveParsed,
  parseOrProtocolError,
  ConnectionError,
} from "../src/connection/messageConnection";
import { sortAssociationTable } from "./utils/associationTable";

const psiLibrary = await PSI();

const [serverConn, clientConn] = createMessagePipe();

const server = new PSIParticipant("server", psiLibrary, {
  role: "starter",
  verbose: -1,
});

const client = new PSIParticipant("client", psiLibrary, {
  role: "joiner",
  verbose: -1,
});

const serverData = [
  ["Alice", "Bob", "Carol", "David", "Elizabeth", "Frank", "Greta"],
  ["1", "2", "1", "1", "1", "1", "1"],
];

const clientData = [
  ["Carol", "Elizabeth", "Henry"],
  ["3", "3", "2"],
];

log.setLevel("DEBUG");

let [serverResult, clientResult] = await (async () => {
  return await Promise.all([
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
})();

serverResult = sortAssociationTable(serverResult);
clientResult = sortAssociationTable(clientResult, true);

test("server and client yield identical results", () => {
  expect(serverResult[0]).toStrictEqual(clientResult[1]);
  expect(serverResult[1]).toStrictEqual(clientResult[0]);
});

test("results are correct", () => {
  expect(serverResult[0]).toStrictEqual([1, 2, 4]);
  expect(serverResult[1]).toStrictEqual([2, 0, 1]);
});

// ─── linkViaSinglePassPSI: parity with the cascade ────────────────────────────
// Single-pass batches every key into one exchange and has the receiver
// reconstruct the cascade locally; it must produce the byte-identical association
// table linkViaPSI would for the same inputs. Run both roles over a fresh pipe and
// compare against the cascade results computed above.
test("single-pass yields the byte-identical association table as the cascade", async () => {
  const [spServerConn, spClientConn] = createMessagePipe();
  const spServer = new PSIParticipant("server", psiLibrary, {
    role: "starter",
    verbose: -1,
  });
  const spClient = new PSIParticipant("client", psiLibrary, {
    role: "joiner",
    verbose: -1,
  });

  let [spServerResult, spClientResult] = await Promise.all([
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      spServer,
      spServerConn,
      serverData,
      -1,
    ),
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      spClient,
      spClientConn,
      clientData,
      -1,
    ),
  ]);

  spServerResult = sortAssociationTable(spServerResult);
  spClientResult = sortAssociationTable(spClientResult, true);

  // Identical to the cascade, on both sides.
  expect(spServerResult).toStrictEqual(serverResult);
  expect(spClientResult).toStrictEqual(clientResult);

  // Internally consistent: each party's locals are the other's partners.
  expect(spServerResult[0]).toStrictEqual(spClientResult[1]);
  expect(spServerResult[1]).toStrictEqual(spClientResult[0]);
});

// ─── linkViaSinglePassPSI: survivor-relative (contention) uniqueness ──────────
// Uniqueness is evaluated over the records still unmatched at each round, not the
// full dataset, so a value duplicated across the whole data becomes matchable once
// an earlier key claims its twin. Here the sender's "Z" is duplicated (rows 0, 1),
// but row 0 matches on key 1, leaving "Z" unique among key 2's survivors so row 1
// matches too. A reconstruction that used full-dataset uniqueness would drop "Z"
// and miss row 1; the expected table pins the survivor-relative behavior.
test("single-pass reproduces the cascade's survivor-relative uniqueness", async () => {
  const senderData = [
    ["A", "B"],
    ["Z", "Z"],
  ];
  const receiverData = [
    ["A", undefined],
    [undefined, "Z"],
  ];

  const run = async (link: typeof linkViaPSI) => {
    const [senderConn, receiverConn] = createMessagePipe();
    const sender = new PSIParticipant("server", psiLibrary, {
      role: "starter",
      verbose: -1,
    });
    const receiver = new PSIParticipant("client", psiLibrary, {
      role: "joiner",
      verbose: -1,
    });
    const [senderResult, receiverResult] = await Promise.all([
      link({ cardinality: "one-to-one" }, sender, senderConn, senderData, -1),
      link(
        { cardinality: "one-to-one" },
        receiver,
        receiverConn,
        receiverData,
        -1,
      ),
    ]);
    return [
      sortAssociationTable(senderResult),
      sortAssociationTable(receiverResult, true),
    ];
  };

  const [cascadeSender, cascadeReceiver] = await run(linkViaPSI);
  // Both sender rows match -- reachable only under survivor-relative uniqueness.
  expect(cascadeSender).toStrictEqual([
    [0, 1],
    [0, 1],
  ]);

  const [singlePassSender, singlePassReceiver] =
    await run(linkViaSinglePassPSI);
  expect(singlePassSender).toStrictEqual(cascadeSender);
  expect(singlePassReceiver).toStrictEqual(cascadeReceiver);
});

// ─── associationAndIterationArray: pathological-count bound ───────────────────
// The mapped-elements frame exchanged in exchangeMappedElements is partner-
// controlled and rides the ~512 MiB exchange frame; its matched-record count is
// legitimately in the millions. A flat array of ~4M invalid elements made Zod
// throw `RangeError: Invalid string length` building its error string from one
// issue per element (a ~4.5s CPU burn). The single-issue validator caps that at
// one clean issue. The frame is read two ways -- via receiveParsed (sendFirst)
// and via a direct `parseOrProtocolError` (the !sendFirst send-before-parse
// path) -- and both must surface a clean ConnectionError("protocol").
const pathologicalPairs = () => Array.from({ length: 4_000_000 }, () => 1);

test("receiveParsed: a pathological-count mapped-elements frame fails cleanly", async () => {
  const [connA, connB] = createMessagePipe();
  const parsed = receiveParsed(connA, associationAndIterationArray);
  await connB.send(pathologicalPairs());
  const err = await parsed.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
  expect((err as ConnectionError).cause).not.toBeInstanceOf(RangeError);
});

test("direct parse: a pathological-count mapped-elements frame fails cleanly, not with a bare RangeError", () => {
  let err: unknown;
  try {
    parseOrProtocolError(associationAndIterationArray, pathologicalPairs());
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
  expect((err as ConnectionError).cause).not.toBeInstanceOf(RangeError);
});

test("a legitimately large mapped-elements frame parses", async () => {
  // One pair per matched record, legitimately in the millions; 200k clears the
  // overflow threshold, so a VALID large frame never trips the single-issue
  // bound. The accepted shape is unchanged from the `z.object` schema it
  // replaced (finite theirIndex/iteration per pair).
  const n = 200_000;
  const [connA, connB] = createMessagePipe();
  const parsed = receiveParsed(connA, associationAndIterationArray);
  await connB.send(
    Array.from({ length: n }, (_, i) => ({ theirIndex: i, iteration: 0 })),
  );
  expect(await parsed).toHaveLength(n);
});

test("a mapped-elements element that is an array (not a plain object) is rejected", () => {
  // z.object rejects an array outright, even one carrying theirIndex/iteration
  // own-properties; the single-issue predicate must too, so the set of accepted
  // messages is exactly the one the replaced `z.object` schema accepted. This is
  // unreachable over the JSON transport (an array cannot carry named own-
  // properties through serialization), but the exact-mirror contract holds
  // regardless -- it guards against the `!Array.isArray` check being dropped.
  const arrayElement = [] as unknown as Record<string, unknown>;
  arrayElement.theirIndex = 0;
  arrayElement.iteration = 0;
  let err: unknown;
  try {
    parseOrProtocolError(associationAndIterationArray, [arrayElement]);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
});

// ─── single-pass reply codec and the receiver's frame-length tie ──────────────
// Message 2 -- setup, response, record count, and the distinct-value index table
// -- is one binary frame; these pin the codec round-trip and the fail-closed
// gates that guard it (the channel-hardening controls).
test("encodeInt32LE / decodeInt32LE round-trip, and a non-aligned frame is rejected", () => {
  const values = [-1, 0, 1, 7, 2_000_000_000];
  expect(Array.from(decodeInt32LE(encodeInt32LE(values)))).toEqual(values);
  // A length that is not a whole number of int32s is a clean error, not a silent
  // truncation -- the decode guard for the partner-supplied index table.
  expect(() => decodeInt32LE(new Uint8Array(3))).toThrow(/int32/);
});

test("encodeSinglePassReply / decodeSinglePassReply round-trip, and a truncated frame is rejected", () => {
  const setup = new Uint8Array([10, 20, 30]);
  const response = new Uint8Array([40, 50]);
  const indices = [-1, 0, 7, 2_000_000_000];
  const out = decodeSinglePassReply(
    encodeSinglePassReply(setup, response, 4, indices),
  );
  expect(Array.from(out.setup)).toEqual([10, 20, 30]);
  expect(Array.from(out.response)).toEqual([40, 50]);
  expect(out.numRecords).toBe(4);
  expect(Array.from(out.distinctValueIndices)).toEqual(indices);
  // A frame cut short of a length it declares is a clean protocol error, not a
  // silent under-read.
  const full = encodeSinglePassReply(setup, response, 4, indices);
  expect(() => decodeSinglePassReply(full.subarray(0, 5))).toThrow(/truncated/);
});

// ─── single-pass size ceiling (base64-adjusted) and the pre-flight predicate ──
// The reply is base64url-wrapped (~4/3) in an AES-GCM envelope before the inbound
// cap measures it, so the raw-byte ceiling sits at ~3/4 of MAX_FRAME_SIZE_BYTES --
// strictly below it, so an oversized dataset gets the actionable "use cascade"
// error here instead of a generic frame-too-large rejection downstream.
test("the single-pass reply ceiling leaves room for the channel's base64 envelope", () => {
  expect(SINGLE_PASS_MAX_REPLY_BYTES).toBeLessThan(MAX_FRAME_SIZE_BYTES);
  expect(SINGLE_PASS_MAX_REPLY_BYTES).toBeGreaterThan(
    MAX_FRAME_SIZE_BYTES * 0.7,
  );
  expect(SINGLE_PASS_MAX_REPLY_BYTES).toBeLessThan(MAX_FRAME_SIZE_BYTES * 0.76);
});

test("singlePassReplyWouldExceedCap fires exactly at the index-table ceiling", () => {
  const fits = Math.floor(SINGLE_PASS_MAX_REPLY_BYTES / 4); // one key, all table
  expect(singlePassReplyWouldExceedCap(1, fits)).toBe(false);
  expect(singlePassReplyWouldExceedCap(1, fits + 1)).toBe(true);
  // The ceiling is per (key, record): more keys, fewer rows fit.
  expect(singlePassReplyWouldExceedCap(4, Math.floor(fits / 4))).toBe(false);
  expect(singlePassReplyWouldExceedCap(4, Math.floor(fits / 4) + 1)).toBe(true);
});

test("single-pass receiver rejects a reply whose index table contradicts its record count", async () => {
  // The receiver ties the distinct-value index table to the reply's declared
  // record count: its length must equal numLinkageKeys * numSenderRecords. A reply
  // that declares a record count its index table does not match is a clean protocol
  // abort, not a wrong reconstruction. Drive the receiver (joiner) against a hostile
  // sender:
  // setup/response are dummies (read but not used before the check).
  const [conn, peer] = createMessagePipe();
  const receiver = new PSIParticipant("client", psiLibrary, {
    role: "joiner",
    verbose: -1,
  });
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    receiver,
    conn,
    [["a", "b"]], // one key
    -1,
  );
  await peer.receive(); // consume the receiver's encrypted request
  // Declares recordCount 5 (expects 1 * 5 = 5 value indices) but ships only 2.
  await peer.send(
    encodeSinglePassReply(
      new Uint8Array([1, 2, 3, 4]),
      new Uint8Array([5, 6, 7, 8]),
      5,
      [0, 1],
    ),
  );
  await expect(run).rejects.toThrow(/index table\s+length does not match/);
});
