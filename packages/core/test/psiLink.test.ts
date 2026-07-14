import { expect, test } from "vitest";

import log from "loglevel";

import PSI from "@openmined/psi.js";

import { PSIParticipant } from "../src/participant";
import {
  linkViaPSI,
  linkViaSinglePassPSI,
  withholdsSenderAssociationTable,
  associationAndIterationArray,
  encodeInt32LE,
  decodeInt32LE,
  encodeSinglePassReply,
  decodeSinglePassReply,
} from "../src/link";
import {
  MAX_FRAME_SIZE_BYTES,
  MAX_SINGLE_PASS_CELLS,
  singlePassDatasetExceedsCap,
  singlePassExchangeExceedsCap,
  singlePassReplyByteCap,
} from "../src/connection/frameSize";

import {
  createMessagePipe,
  receiveParsed,
  parseOrProtocolError,
  ConnectionError,
  type MessageConnection,
} from "../src/connection/messageConnection";
import type { AssociationTable } from "../src/types";
import { sortAssociationTable } from "../src/testing";
import { UNBOUNDED_PSI_ELEMENTS } from "./utils/psiElementBounds";

const psiLibrary = await PSI();

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

// "many-to-one" stays on linkViaPSI's accepted-value surface as an alias that
// runs the identical one-to-one matching; no production caller passes it
// (exchange.ts resolves the cardinality from the agreed deduplicate settings and
// refuses any that would need a genuine many-cardinality match). Pinned so the
// accepted surface neither narrows silently nor grows behavior without a test.
test("many-to-one is accepted and runs the identical one-to-one matching", async () => {
  const [mServerConn, mClientConn] = createMessagePipe();
  const mServer = new PSIParticipant(
    "server",
    psiLibrary,
    { role: "starter", verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
  );
  const mClient = new PSIParticipant(
    "client",
    psiLibrary,
    { role: "joiner", verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
  );

  let [mServerResult, mClientResult] = await Promise.all([
    linkViaPSI(
      { cardinality: "many-to-one" },
      mServer,
      mServerConn,
      serverData,
      -1,
    ),
    linkViaPSI(
      { cardinality: "many-to-one" },
      mClient,
      mClientConn,
      clientData,
      -1,
    ),
  ]);

  mServerResult = sortAssociationTable(mServerResult);
  mClientResult = sortAssociationTable(mClientResult, true);

  expect(mServerResult).toStrictEqual(serverResult);
  expect(mClientResult).toStrictEqual(clientResult);
});

// --- linkViaSinglePassPSI: parity with the cascade ----------------------------
// Single-pass batches every key into one exchange and has the receiver
// reconstruct the cascade locally; it must produce the byte-identical association
// table linkViaPSI would for the same inputs. Run both roles over a fresh pipe and
// compare against the cascade results computed above.
test("single-pass yields the byte-identical association table as the cascade", async () => {
  const [spServerConn, spClientConn] = createMessagePipe();
  const spServer = new PSIParticipant(
    "server",
    psiLibrary,
    { role: "starter", verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
  );
  const spClient = new PSIParticipant(
    "client",
    psiLibrary,
    { role: "joiner", verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
  );

  let [spServerResult, spClientResult] = await Promise.all([
    // partnerRecordCount: the server's partner is the client (3 rows) and vice
    // versa (the server has 7 rows).
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      spServer,
      spServerConn,
      serverData,
      clientData[0].length,
      false,
      -1,
    ),
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      spClient,
      spClientConn,
      clientData,
      serverData[0].length,
      false,
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

// --- linkViaSinglePassPSI: survivor-relative (contention) uniqueness ----------
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

  // Both parties have two rows, so each side's partner count is 2; the link
  // adapter folds that in for single-pass and is a no-op for the cascade, which
  // takes no partner count.
  const run = async (
    link: (
      protocol: { cardinality: "one-to-one" },
      participant: PSIParticipant,
      conn: MessageConnection,
      data: Array<Array<string | undefined>>,
    ) => Promise<AssociationTable>,
  ) => {
    const [senderConn, receiverConn] = createMessagePipe();
    const sender = new PSIParticipant(
      "server",
      psiLibrary,
      { role: "starter", verbose: -1 },
      UNBOUNDED_PSI_ELEMENTS,
    );
    const receiver = new PSIParticipant(
      "client",
      psiLibrary,
      { role: "joiner", verbose: -1 },
      UNBOUNDED_PSI_ELEMENTS,
    );
    const [senderResult, receiverResult] = await Promise.all([
      link({ cardinality: "one-to-one" }, sender, senderConn, senderData),
      link({ cardinality: "one-to-one" }, receiver, receiverConn, receiverData),
    ]);
    return [
      sortAssociationTable(senderResult),
      sortAssociationTable(receiverResult, true),
    ];
  };

  const [cascadeSender, cascadeReceiver] = await run((protocol, p, c, d) =>
    linkViaPSI(protocol, p, c, d, -1),
  );
  // Both sender rows match -- reachable only under survivor-relative uniqueness.
  expect(cascadeSender).toStrictEqual([
    [0, 1],
    [0, 1],
  ]);

  const [singlePassSender, singlePassReceiver] = await run(
    (protocol, p, c, d) =>
      linkViaSinglePassPSI(protocol, p, c, d, 2, false, -1),
  );
  expect(singlePassSender).toStrictEqual(cascadeSender);
  expect(singlePassReceiver).toStrictEqual(cascadeReceiver);
});

// --- linkViaSinglePassPSI: withholding the sender's table from a blind helper --
// A non-receiving helper (expectsOutput false) disclosing no payload needs nothing
// back, so the receiver suppresses message 3 (the sender's association-table half)
// ENTIRELY and the sender skips awaiting it. Both parties derive the same decision
// from authenticated session state (withholdsSenderAssociationTable), so the
// suppress and the skip stay in lockstep and neither hangs.

test("withholdsSenderAssociationTable withholds only for a non-receiving, no-payload sender", () => {
  // The gating predicate both parties evaluate, exercised directly on all three
  // cases. Because it is a pure function of the resolved sender's output
  // entitlement and its payload-intent flag -- state both parties hold identically
  // -- the receiver (deciding to suppress) and the sender (deciding to skip) always
  // reach the same verdict, whichever side calls it.
  // Entitled to output: always deliver, regardless of payload intent.
  expect(withholdsSenderAssociationTable(true, false)).toBe(false);
  expect(withholdsSenderAssociationTable(true, true)).toBe(false);
  // No output but discloses payload: still delivered -- it needs its matched rows.
  expect(withholdsSenderAssociationTable(false, true)).toBe(false);
  // No output AND no payload: the one closeable case -- withhold.
  expect(withholdsSenderAssociationTable(false, false)).toBe(true);
});

// Run a single-pass exchange over a fresh pipe, capturing every frame the SENDER
// (starter) receives AND every frame the RECEIVER (joiner) sends, so a test can
// assert -- from both ends -- whether message 3 (the association table, the only
// [number[], number[]] frame in the protocol) ever crosses the wire. Capturing the
// receiver's OUTBOUND is what catches a regression that sends an empty [[], []]
// table instead of suppressing the frame: the sender's inbound alone would miss it,
// since a withholding sender never awaits that frame.
async function runSinglePassCapturingFrames(
  senderSet: Array<string>,
  receiverSet: Array<string>,
  withhold: boolean,
): Promise<{
  senderResult: AssociationTable;
  receiverResult: AssociationTable;
  senderInbound: Array<unknown>;
  receiverOutbound: Array<unknown>;
}> {
  const [sConn, cConn] = createMessagePipe();
  const senderInbound: Array<unknown> = [];
  const receiverOutbound: Array<unknown> = [];
  const capturingSenderConn: MessageConnection = {
    send: (m: unknown) => sConn.send(m),
    receive: async (timeoutMs?: number) => {
      const frame = await sConn.receive(timeoutMs);
      senderInbound.push(frame);
      return frame;
    },
    close: () => sConn.close(),
  };
  const capturingReceiverConn: MessageConnection = {
    send: (m: unknown) => {
      receiverOutbound.push(m);
      return cConn.send(m);
    },
    receive: (timeoutMs?: number) => cConn.receive(timeoutMs),
    close: () => cConn.close(),
    setInboundFrameCap: cConn.setInboundFrameCap?.bind(cConn),
  };
  const sp = new PSIParticipant(
    "server",
    psiLibrary,
    { role: "starter", verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
  );
  const cp = new PSIParticipant(
    "client",
    psiLibrary,
    { role: "joiner", verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
  );
  const [senderResult, receiverResult] = await Promise.all([
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      sp,
      capturingSenderConn,
      [senderSet],
      receiverSet.length,
      withhold,
      -1,
    ),
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      cp,
      capturingReceiverConn,
      [receiverSet],
      senderSet.length,
      withhold,
      -1,
    ),
  ]);
  return { senderResult, receiverResult, senderInbound, receiverOutbound };
}

test("single-pass withholding keeps a blind helper's table off the wire; the receiver is unaffected", async () => {
  const senderSet = ["A", "B", "C"];
  const receiverSet = ["B", "C", "D"];
  const base = await runSinglePassCapturingFrames(
    senderSet,
    receiverSet,
    false,
  );
  const held = await runSinglePassCapturingFrames(senderSet, receiverSet, true);

  // Withholding changes only the helper's blindness, never the receiver's own
  // resolved table: the receiver computes the identical result either way.
  expect(held.receiverResult).toStrictEqual(base.receiverResult);
  expect(base.receiverResult[0]).toHaveLength(2); // B, C overlap

  // Baseline (deliver): the helper receives its table -- two inbound frames, the
  // request then the [number[], number[]] table -- and learns its two matches. The
  // receiver sent that table frame (an Array).
  expect(base.senderResult[0]).toHaveLength(2);
  expect(base.senderInbound).toHaveLength(2);
  expect(base.senderInbound.some((f) => Array.isArray(f))).toBe(true);
  expect(base.receiverOutbound.some((f) => Array.isArray(f))).toBe(true);

  // Withheld: the helper is genuinely blind -- it returns an empty table and its
  // process never receives message 3. Its only inbound frame is the receiver's
  // request (a Uint8Array); no association-table frame ever reaches it. The run
  // completed (Promise.all resolved), proving neither side hung on the skipped frame.
  expect(held.senderResult).toStrictEqual([[], []]);
  expect(held.senderInbound).toHaveLength(1);
  expect(held.senderInbound[0]).toBeInstanceOf(Uint8Array);
  expect(held.senderInbound.some((f) => Array.isArray(f))).toBe(false);

  // Enforced from the RECEIVER's side too: it never SENT any association-table
  // frame -- not even an empty [[], []]. An "optimization" that emitted an empty
  // table instead of suppressing the frame (the count-leaking regression the design
  // forbids) would send an Array here and fail this assertion, which the sender's
  // inbound alone -- a withholding sender never awaits the frame -- would not catch.
  expect(held.receiverOutbound.some((f) => Array.isArray(f))).toBe(false);
});

test("single-pass withholding does not leak the match count by frame presence or size", async () => {
  // Empty-versus-populated indistinguishability: whether the intersection is
  // populated or empty, the blind helper observes the SAME inbound traffic -- one
  // request frame, no table frame -- so the match count cannot be read off the wire
  // it sees. Suppressing the frame entirely (rather than sending an empty table) is
  // what closes that channel: an empty-versus-populated table would leak the count
  // by its presence and size.
  // Both receivers hold the same number of distinct values (3), so the only thing
  // that differs between the two runs is the intersection size (2 vs 0).
  const populated = await runSinglePassCapturingFrames(
    ["A", "B", "C"],
    ["B", "C", "D"], // 2 matches
    true,
  );
  const empty = await runSinglePassCapturingFrames(
    ["A", "B", "C"],
    ["X", "Y", "Z"], // 0 matches
    true,
  );
  expect(populated.senderInbound).toHaveLength(1);
  expect(empty.senderInbound).toHaveLength(1);
  expect(populated.senderInbound.every((f) => f instanceof Uint8Array)).toBe(
    true,
  );
  expect(empty.senderInbound.every((f) => f instanceof Uint8Array)).toBe(true);
  // Not just presence: the sole inbound frame (the receiver's request) is
  // byte-identical in LENGTH across the two runs -- its size tracks the receiver's
  // distinct-value count, held constant here, never the match count. So neither the
  // presence nor the size of what the helper receives encodes the intersection size.
  expect((populated.senderInbound[0] as Uint8Array).byteLength).toBe(
    (empty.senderInbound[0] as Uint8Array).byteLength,
  );
  // The differing match counts (2 vs 0) are computed only by the receiver; the
  // helper stays blind to both.
  expect(populated.receiverResult[0]).toHaveLength(2);
  expect(empty.receiverResult[0]).toHaveLength(0);
  expect(populated.senderResult).toStrictEqual([[], []]);
  expect(empty.senderResult).toStrictEqual([[], []]);
});

// --- associationAndIterationArray: pathological-count bound -------------------
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

// --- single-pass reply codec and the receiver's frame-length tie --------------
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

// --- single-pass dataset ceiling: derived from exchanged counts ---------------
// The cap is a per-party budget on keyCount * recordCount (the distinct-value
// upper bound), with the read-gate/send-time byte cap derived from the same
// quantity. These pin the deterministic arithmetic both parties compute.
test("singlePassDatasetExceedsCap fires exactly at keyCount * rows = the budget", () => {
  const fits = Math.floor(MAX_SINGLE_PASS_CELLS / 1); // one key
  expect(singlePassDatasetExceedsCap(1, fits)).toBe(false);
  expect(singlePassDatasetExceedsCap(1, fits + 1)).toBe(true);
  // The budget is on keyCount * rows, so more keys fit proportionally fewer rows.
  const perKey = Math.floor(MAX_SINGLE_PASS_CELLS / 4);
  expect(singlePassDatasetExceedsCap(4, perKey)).toBe(false);
  expect(singlePassDatasetExceedsCap(4, perKey + 1)).toBe(true);
});

test("singlePassExchangeExceedsCap fires when EITHER party is over the budget", () => {
  const fits = MAX_SINGLE_PASS_CELLS; // one key, exactly at the budget
  expect(singlePassExchangeExceedsCap(1, fits, fits)).toBe(false);
  // Sender over, receiver under -> over (and vice versa).
  expect(singlePassExchangeExceedsCap(1, fits + 1, 1)).toBe(true);
  expect(singlePassExchangeExceedsCap(1, 1, fits + 1)).toBe(true);
});

test("singlePassReplyByteCap weights the sender heavier and stays below both transport envelopes at the ceiling", () => {
  // The sender contributes a masked value + an index cell per (key, record); the
  // receiver a masked value per (key, record); plus a fixed overhead. Pinning the
  // exact formula is what makes the cap reproducible across implementations.
  expect(singlePassReplyByteCap(2, 10, 5)).toBe(
    (40 + 4) * (2 * 10) + 40 * (2 * 5) + 256,
  );
  // The two arguments are NOT interchangeable: the sender carries the index table
  // (+4/cell), so swapping the sender and receiver counts changes the value. This
  // is why both parties must agree on which count is the sender's -- the role
  // mapping in linkViaSinglePassPSI feeds (senderRows, receiverRows) in the same
  // order on both sides, so they compute the identical cap from swapped local
  // inputs (own vs partner count).
  expect(singlePassReplyByteCap(3, 100, 200)).not.toBe(
    singlePassReplyByteCap(3, 200, 100),
  );
  // At the ceiling (both parties' keyCount*rows at the budget) the derived cap must
  // stay below both transports' fixed frame envelopes, so the per-transport clamp
  // does not bind and a legitimate single-pass reply the count budget admits is
  // never rejected mid-exchange. This guards a future raise of MAX_SINGLE_PASS_CELLS
  // (or of the per-cell byte weights): prose in frameSize.ts asserts the invariant,
  // but only a check can keep it true.
  const atCeiling = singlePassReplyByteCap(
    1,
    MAX_SINGLE_PASS_CELLS,
    MAX_SINGLE_PASS_CELLS,
  );
  // The file-sync backstop, a core constant.
  expect(atCeiling).toBeLessThan(MAX_FRAME_SIZE_BYTES);
  // The nearer constraint after board item 206377899 raised the cap: the WebRTC
  // data channel's fixed browser-tab envelope. It is a web constant
  // (MAX_WEBRTC_FRAME_BYTES in apps/web/src/psi/boundedReassembly.ts), not
  // importable into core, so it is mirrored here as a literal -- a core-only cap or
  // byte-weight change must not silently outgrow it. The coupling is bidirectional:
  // lowering the web constant below this ceiling cap would pass here yet reject
  // legitimate WebRTC replies, so the two must move together.
  const MAX_WEBRTC_FRAME_BYTES = 256 * 1024 * 1024;
  expect(atCeiling).toBeLessThan(MAX_WEBRTC_FRAME_BYTES);
});

test("the single-pass receiver read gate is bounded to the derived reply cap", async () => {
  // The receiver tightens its transport read gate to singlePassReplyByteCap
  // before reading the reply (setInboundFrameCap), then clears it. A fake
  // MessageConnection records the cap set/cleared around the reply receive.
  const setCalls: Array<number | undefined> = [];
  let resolveReceive: ((v: unknown) => void) | undefined;
  const receiver = new PSIParticipant(
    "client",
    psiLibrary,
    { role: "joiner", verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
  );
  // One key, three local rows; partner (sender) has two rows.
  const keyCount = 1;
  const localRows = 3;
  const partnerRows = 2;
  const fake: MessageConnection = {
    send: async () => {},
    receive: () =>
      new Promise((resolve) => {
        resolveReceive = resolve;
      }),
    close: async () => {},
    setInboundFrameCap: (maxBytes) => setCalls.push(maxBytes),
  };
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    receiver,
    fake,
    [["a", "b", "c"]],
    partnerRows,
    false,
    -1,
  );
  // Let the receiver send its request and park on receive(); then deliver a reply
  // declaring partnerRows sender records but a mismatched index table, so decode
  // fails fast after the gate is exercised.
  await new Promise((r) => setTimeout(r, 0));
  expect(setCalls[0]).toBe(
    singlePassReplyByteCap(keyCount, partnerRows, localRows),
  );
  resolveReceive?.(
    encodeSinglePassReply(new Uint8Array(), new Uint8Array(), partnerRows, [0]),
  );
  await expect(run).rejects.toThrow();
  // The cap was cleared (undefined) after the read, so a later frame uses the
  // default gate.
  expect(setCalls[setCalls.length - 1]).toBeUndefined();
});

test("single-pass receiver rejects a reply whose index table contradicts its record count", async () => {
  // The receiver ties the distinct-value index table to the reply's declared
  // record count: its length must equal numLinkageKeys * numSenderRecords. A reply
  // that declares a record count its index table does not match is a clean protocol
  // abort, not a wrong reconstruction. Drive the receiver (joiner) against a hostile
  // sender:
  // setup/response are dummies (read but not used before the check).
  const [conn, peer] = createMessagePipe();
  const receiver = new PSIParticipant(
    "client",
    psiLibrary,
    { role: "joiner", verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
  );
  // partnerRecordCount 5 matches the reply's declared sender count, so the
  // count-coherence check passes and the index-table-length check is what fires.
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    receiver,
    conn,
    [["a", "b"]], // one key
    5,
    false,
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

test("single-pass receiver rejects a reply whose sender count contradicts the exchanged count", async () => {
  // The reply packs the sender's own record count; the receiver ties it to the
  // count the sender exchanged over the authenticated channel (partnerRecordCount).
  // A reply that declares a different count is a clean protocol abort -- before any
  // allocation -- rather than a trusted-frame read.
  const [conn, peer] = createMessagePipe();
  const receiver = new PSIParticipant(
    "client",
    psiLibrary,
    { role: "joiner", verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
  );
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    receiver,
    conn,
    [["a", "b"]], // one key, two local rows
    3, // the sender exchanged 3 records
    false,
    -1,
  );
  await peer.receive(); // consume the receiver's encrypted request
  // Declares 4 sender records (with a matching 4-entry index table), not the 3
  // the sender exchanged.
  await peer.send(
    encodeSinglePassReply(
      new Uint8Array([1, 2, 3, 4]),
      new Uint8Array([5, 6, 7, 8]),
      4,
      [0, 1, 2, 3],
    ),
  );
  await expect(run).rejects.toThrow(/declares 4 sender record/);
});

test("single-pass aborts symmetrically when the exchange exceeds the ceiling", async () => {
  // Both parties compute the over-ceiling verdict from the exchanged counts alone,
  // before any single-pass frame moves, and both abort with the same guidance --
  // which does not recommend cascade. Drive a tiny local dataset whose keyCount *
  // partnerRecordCount exceeds the budget.
  const [conn, peer] = createMessagePipe();
  const receiver = new PSIParticipant(
    "client",
    psiLibrary,
    { role: "joiner", verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
  );
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    receiver,
    conn,
    [["a", "b"]],
    MAX_SINGLE_PASS_CELLS + 1, // partner alone is over the budget
    false,
    -1,
  );
  await expect(run).rejects.toThrow(/single-pass cannot carry this dataset/);
  await expect(run).rejects.not.toThrow(/cascade/);
  // The abort happened before any frame was exchanged: the peer saw nothing.
  void peer;
});

test("single-pass aborts symmetrically from the starter side too", async () => {
  // Mirror of the joiner case, proving the verdict is role-symmetric. The
  // over-ceiling gate runs before the role branch, so the starter (PSI sender)
  // reaches it from the same exchanged counts. The same large partnerRecordCount
  // lands in receiverRecordCount for a starter (vs senderRecordCount for a
  // joiner), yet both compute the identical over-cap verdict and abort before any
  // frame moves -- the starter throws before it ever reads the request.
  const [conn, peer] = createMessagePipe();
  const sender = new PSIParticipant(
    "server",
    psiLibrary,
    { role: "starter", verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
  );
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    sender,
    conn,
    [["a", "b"]],
    MAX_SINGLE_PASS_CELLS + 1, // partner alone is over the budget
    false,
    -1,
  );
  await expect(run).rejects.toThrow(/single-pass cannot carry this dataset/);
  await expect(run).rejects.not.toThrow(/cascade/);
  // The starter aborted before receiving the request: the peer saw nothing.
  void peer;
});
