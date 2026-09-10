import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import {
  PayloadDisclosureDivergenceError,
  prepareForExchange,
  resolveBothDirectionsDisclosePayload,
  resolveDirectionDisclosesPayload,
  runExchange,
} from "../src/exchange";
import {
  createMessagePipe,
  type MessageConnection,
} from "../src/connection/messageConnection";

import type { BuiltExchangeRecord } from "../src/records/exchangeRecord";
import type {
  LinkageStrategy,
  LinkageTerms,
  Output,
  Payload,
} from "../src/config/linkageTermsSchema";
import type {
  ExchangeResult,
  PayloadDisclosureDirections,
} from "../src/exchange";

// Integration coverage of the linkageStrategy dispatch in runExchange: a
// single-pass exchange must flow through the full path -- role resolution, the
// payload exchange, the one-sided-output gate, and the audit record -- to the same
// result the cascade produces. linkViaSinglePassPSI's byte-identical parity with the
// cascade is pinned at the unit level (psiLink.test.ts); these tests pin that the
// exchange.ts dispatch and every downstream consumer treat a single-pass result
// identically, which the unit path never exercises.

const psiLibrary = await PSI();

// firstName-only terms: the default key templates need SSN/DOB, so an explicit key
// gives both parties valid matching terms for a firstName-only dataset (same shape
// as exchangeRecordEndToEnd.test.ts), parameterized by strategy.
const baseTerms = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi" as const,
  deduplicate: false,
  linkageFields: [{ name: "firstName", type: "first_name" as const }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
};

const serverRows = [
  { first_name: "Alice", note: "s-a" },
  { first_name: "Bob", note: "s-b" },
  { first_name: "Carol", note: "s-c" },
  { first_name: "Elizabeth", note: "s-e" },
];
const clientRows = [
  { first_name: "Carol", note: "c-c" },
  { first_name: "Elizabeth", note: "c-e" },
  { first_name: "Henry", note: "c-h" },
];

function prepared(
  strategy: LinkageStrategy,
  identity: string,
  output: Output,
  rows: typeof serverRows,
) {
  return prepareForExchange(
    {
      linkageTerms: {
        ...baseTerms,
        linkageStrategy: strategy,
        identity,
        output,
      },
    },
    identity,
    rows,
    ["first_name", "note"],
  );
}

async function runBoth(
  strategy: LinkageStrategy,
  outInitiator: Output,
  outResponder: Output,
): Promise<[ExchangeResult, ExchangeResult]> {
  const [connInitiator, connResponder] = createMessagePipe();
  return Promise.all([
    runExchange(
      connInitiator,
      "initiator",
      prepared(strategy, "Initiator Co", outInitiator, clientRows),
      { psiLibrary },
    ),
    runExchange(
      connResponder,
      "responder",
      prepared(strategy, "Responder Co", outResponder, serverRows),
      { psiLibrary },
    ),
  ]);
}

function built(result: ExchangeResult): BuiltExchangeRecord {
  expect(result.audit).toBeDefined();
  return result.audit!;
}

const sortByIndex = (p: ExchangeResult["partnerPayload"]) =>
  p.rowIndices
    .map((idx, i) => ({ idx, row: p.rows[i] }))
    .sort((a, b) => a.idx - b.idx);

const both: Output = { expectsOutput: true, shareWithPartner: true };

test("single-pass dispatch: a full runExchange yields the correct matched table and partner payload", async () => {
  const [initiator, responder] = await runBoth("single-pass", both, both);

  // Carol and Elizabeth overlap. The dispatch must route single-pass and
  // yield the same table cascade would, from each party's local
  // perspective: client rows 0,1 <-> server rows 2,3.
  expect(initiator.associationTable).toEqual([
    [0, 1],
    [2, 3],
  ]);
  expect(responder.associationTable).toEqual([
    [2, 3],
    [0, 1],
  ]);
  expect(built(initiator).record.resultSize).toBe(2);
  expect(built(responder).record.resultSize).toBe(2);

  // `note` is an inferred payload column; under single-pass it must flow for exactly
  // the matched rows, keyed by the partner's row indices. This drives preparePayload
  // over a single-pass association table -- the path the unit tests never reach.
  expect(initiator.partnerPayload.columns).toEqual(["note"]);
  expect(sortByIndex(initiator.partnerPayload)).toEqual([
    { idx: 2, row: ["s-c"] }, // server Carol
    { idx: 3, row: ["s-e"] }, // server Elizabeth
  ]);

  expect(responder.partnerPayload.columns).toEqual(["note"]);
  expect(sortByIndex(responder.partnerPayload)).toEqual([
    { idx: 0, row: ["c-c"] }, // client Carol
    { idx: 1, row: ["c-e"] }, // client Elizabeth
  ]);
});

/**
 * A bound on the two-party PSI round below sized as a safety check for an
 * exchange that never completes, not as an assertion about how fast a
 * loaded machine runs 600 rows a side: the round costs about a second on an
 * idle container and crosses vitest's 5 s default when the rest of the
 * suite is competing for the same cores. Nothing here waits for it to
 * elapse on a healthy run.
 */
const LARGE_DATASET_HANG_BACKSTOP_MS = 60_000;

test(
  "single-pass completes a larger dataset under the derived cap",
  { timeout: LARGE_DATASET_HANG_BACKSTOP_MS },
  async () => {
    // A dataset far above the toy examples above, well within the
    // single-pass ceiling, must flow through the full runExchange path to
    // completion without the derived frame cap rejecting it -- the
    // regression the row-count-derived cap is meant to AVOID (single-pass
    // now handles datasets larger than the old fixed ceiling). 600 rows per
    // side over one key is 600 (key, record) cells per party, orders of
    // magnitude below MAX_SINGLE_PASS_CELLS, yet large enough that the
    // derived byte cap is far tighter than the static frame cap.
    const n = 600;
    const overlap = 200;
    const bigServer = Array.from({ length: n }, (_, i) => ({
      first_name: `srv-${i}`,
      note: `s-${i}`,
    }));
    // The first `overlap` client rows share a value with the server; the rest are
    // disjoint, so the intersection size is exactly `overlap`.
    const bigClient = Array.from({ length: n }, (_, i) => ({
      first_name: i < overlap ? `srv-${i}` : `cli-${i}`,
      note: `c-${i}`,
    }));

    const [connInitiator, connResponder] = createMessagePipe();
    const [initiator, responder] = await Promise.all([
      runExchange(
        connInitiator,
        "initiator",
        prepared("single-pass", "Initiator Co", both, bigClient),
        { psiLibrary },
      ),
      runExchange(
        connResponder,
        "responder",
        prepared("single-pass", "Responder Co", both, bigServer),
        { psiLibrary },
      ),
    ]);

    expect(initiator.associationTable?.[0]).toHaveLength(overlap);
    expect(responder.associationTable?.[0]).toHaveLength(overlap);
    expect(built(initiator).record.resultSize).toBe(overlap);
    expect(built(responder).record.resultSize).toBe(overlap);
  },
);

test("single-pass one-sided output: only the receiver gets the table and payload", async () => {
  const receiverOut: Output = { expectsOutput: true, shareWithPartner: false };
  const senderOut: Output = { expectsOutput: false, shareWithPartner: true };
  const [initiator, responder] = await runBoth(
    "single-pass",
    receiverOut,
    senderOut,
  );

  expect(initiator.resolvedRole).toBe("receiver");
  expect(responder.resolvedRole).toBe("sender");

  // The receiver gets the table and binds it; the no-output helper gets neither --
  // the same gate cascade uses, holding for a single-pass result too.
  expect(initiator.associationTable).toBeDefined();
  expect(responder.associationTable).toBeUndefined();
  expect(built(initiator).record.commitments.associationTable).toBeDefined();
  expect(built(responder).record.commitments.associationTable).toBeUndefined();

  // Send-gate: the receiver gets the helper's payload; the helper gets none. That
  // the helper's `note` payload arrives ALSO proves the payload-disclosing helper
  // still received its association-table half (preparePayload reads it to build the
  // enrichment) -- the table is withheld only from a helper disclosing no payload,
  // exercised by the blind-helper test below.
  expect(initiator.partnerPayload.columns).toEqual(["note"]);
  expect(responder.partnerPayload.columns).toEqual([]);
});

// A terms-exchange frame, the only frame kind that holds `linkageTerms`.
const isTermsFrame = (m: unknown): m is Record<string, unknown> =>
  typeof m === "object" && m !== null && "linkageTerms" in m;

// The abort the payload-disclosure refusal sends before it throws, whole: the
// reason is a fixed literal, so a test reads the frame by equality.
const PAYLOAD_DISCLOSURE_ABORT_FRAME = {
  decision: "abort",
  abortReasons: [
    "a party asserts a payload disclosure the agreed linkage terms " +
      "declare no column for",
  ],
};

interface OneSidedSinglePassOptions {
  helperDiscloses: boolean;
  helperIsInitiator: boolean;
  helperPayload?: Payload;
  receiverPayload?: Payload;
  advertiseHelperDisclosure?: boolean;
  // The receiver's own metadata transmitting a column, which the send gate
  // never lets reach a helper entitled to no output. Set where the shape
  // under test turns on the direction that moves nothing.
  receiverDiscloses?: boolean;
  // The strategy both parties agree, for the shapes that must behave the same
  // whether or not there is an association-table frame to withhold.
  strategy?: LinkageStrategy;
}

// Run a one-sided single-pass exchange (receiver expects output, helper
// does not) end to end, capturing every frame the HELPER's process
// receives so a test can assert -- at the wire -- whether the
// association-table frame (the only Array-shaped frame) reaches it.
// `helperDiscloses` gives the helper a payload column (so it is NOT
// blinded); `helperIsInitiator` swaps the handshake-role assignment so
// BOTH payload-exchange orderings are exercised (resolveRole always makes
// the output party the PSI receiver, so this only reorders the payload
// phase, where an untested permutation could hide a frame-desync hang).
//
// Both outcomes are settled rather than joined, so a test of a refusal reads
// each party's own verdict -- a refusal binding both parties has to be
// observed on both -- and neither rejection is left unhandled.
async function settleOneSidedSinglePass(
  opts: OneSidedSinglePassOptions,
): Promise<{
  receiver: PromiseSettledResult<ExchangeResult>;
  helper: PromiseSettledResult<ExchangeResult>;
  helperInbound: Array<unknown>;
  receiverInbound: Array<unknown>;
}> {
  const receiverOut: Output = { expectsOutput: true, shareWithPartner: false };
  const helperOut: Output = { expectsOutput: false, shareWithPartner: true };

  // Carol and Elizabeth overlap. Each party's rows gain a `note` payload column
  // only where that party discloses.
  const receiverRows: Array<Record<string, string>> = opts.receiverDiscloses
    ? [
        { first_name: "Carol", note: "r-c" },
        { first_name: "Elizabeth", note: "r-e" },
        { first_name: "Henry", note: "r-h" },
      ]
    : [
        { first_name: "Carol" },
        { first_name: "Elizabeth" },
        { first_name: "Henry" },
      ];
  const helperRows: Array<Record<string, string>> = opts.helperDiscloses
    ? [
        { first_name: "Alice", note: "h-a" },
        { first_name: "Bob", note: "h-b" },
        { first_name: "Carol", note: "h-c" },
        { first_name: "Elizabeth", note: "h-e" },
      ]
    : [
        { first_name: "Alice" },
        { first_name: "Bob" },
        { first_name: "Carol" },
        { first_name: "Elizabeth" },
      ];

  const prepare = (
    identity: string,
    output: Output,
    rows: Array<Record<string, string>>,
    columnNames: Array<string>,
    payload?: Payload,
  ) =>
    prepareForExchange(
      {
        linkageTerms: {
          ...baseTerms,
          linkageStrategy: opts.strategy ?? "single-pass",
          identity,
          output,
          ...(payload !== undefined ? { payload } : {}),
        },
      },
      identity,
      rows,
      columnNames,
    );

  const [connReceiver, connHelper] = createMessagePipe();
  const helperInbound: Array<unknown> = [];
  const receiverInbound: Array<unknown> = [];
  // A modified helper build advertises `disclosesPayload` on its terms frame
  // whatever its own data holds. Rewriting the frame on the way out models that
  // party while leaving this honest helper's own withhold decision (taken from
  // its metadata) alone, so the receiver's cross-check is what the test reads.
  // Either value can be stamped: true over metadata that discloses nothing, and
  // false over metadata that discloses a column.
  const capturingHelper: MessageConnection = {
    send: (m: unknown) =>
      connHelper.send(
        opts.advertiseHelperDisclosure !== undefined && isTermsFrame(m)
          ? { ...m, disclosesPayload: opts.advertiseHelperDisclosure }
          : m,
      ),
    receive: async (timeoutMs?: number) => {
      const frame = await connHelper.receive(timeoutMs);
      helperInbound.push(frame);
      return frame;
    },
    close: () => connHelper.close(),
    setInboundFrameCap: connHelper.setInboundFrameCap?.bind(connHelper),
  };
  const capturingReceiver: MessageConnection = {
    send: (m: unknown) => connReceiver.send(m),
    receive: async (timeoutMs?: number) => {
      const frame = await connReceiver.receive(timeoutMs);
      receiverInbound.push(frame);
      return frame;
    },
    close: () => connReceiver.close(),
    setInboundFrameCap: connReceiver.setInboundFrameCap?.bind(connReceiver),
  };

  // The pipe is symmetric, so the two parties can sit on either end; the handshake
  // role (which orders the payload phase) is set independently per opts.
  const [helper, receiver] = await Promise.allSettled([
    runExchange(
      capturingHelper,
      opts.helperIsInitiator ? "initiator" : "responder",
      prepare(
        "Helper Co",
        helperOut,
        helperRows,
        opts.helperDiscloses ? ["first_name", "note"] : ["first_name"],
        opts.helperPayload,
      ),
      { psiLibrary },
    ),
    runExchange(
      capturingReceiver,
      opts.helperIsInitiator ? "responder" : "initiator",
      prepare(
        "Receiver Co",
        receiverOut,
        receiverRows,
        opts.receiverDiscloses ? ["first_name", "note"] : ["first_name"],
        opts.receiverPayload,
      ),
      { psiLibrary },
    ),
  ]);
  return { receiver, helper, helperInbound, receiverInbound };
}

// The settled harness above for the exchanges that complete: each party's
// result, with a rejection rethrown so the test reports the failure itself.
async function runOneSidedSinglePass(opts: OneSidedSinglePassOptions): Promise<{
  receiver: ExchangeResult;
  helper: ExchangeResult;
  helperInbound: Array<unknown>;
}> {
  const { receiver, helper, helperInbound } =
    await settleOneSidedSinglePass(opts);
  if (helper.status === "rejected") throw helper.reason;
  if (receiver.status === "rejected") throw receiver.reason;
  return { receiver: receiver.value, helper: helper.value, helperInbound };
}

test("single-pass one-sided, no-payload helper is blinded: table withheld, no hang", async () => {
  // The closeable case: a non-receiving helper whose data discloses no payload needs
  // nothing back, so the receiver withholds its association-table half at the source
  // -- the helper's process never receives, and so never learns, which of its own
  // records matched. The exchange still completes and the receiver gets its table.
  const { receiver, helper, helperInbound } = await runOneSidedSinglePass({
    helperDiscloses: false,
    helperIsInitiator: false,
  });

  expect(receiver.resolvedRole).toBe("receiver");
  expect(helper.resolvedRole).toBe("sender");

  // The receiver still resolves and receives its table; the helper gets none (gated
  // as before). Carol and Elizabeth overlap -> two matches for the receiver.
  expect(receiver.associationTable).toBeDefined();
  expect(receiver.associationTable?.[0]).toHaveLength(2);
  expect(helper.associationTable).toBeUndefined();

  // Neither side discloses payload, so both payload halves are empty.
  expect(receiver.partnerPayload.columns).toEqual([]);
  expect(helper.partnerPayload.columns).toEqual([]);

  // The blindness: no association-table frame ever reached the helper's process, and
  // the exchange completed without hanging (Promise.all resolved).
  expect(helperInbound.some((f) => Array.isArray(f))).toBe(false);
});

test("single-pass blind helper stays blind and hang-free with the helper as initiator", async () => {
  // The reverse handshake-role assignment: the blind helper is the INITIATOR, so it
  // sends first in the post-linkage payload phase (the other frame ordering the
  // primary test does not cover). The withholding and the no-hang guarantee must
  // hold in this permutation too.
  const { receiver, helper, helperInbound } = await runOneSidedSinglePass({
    helperDiscloses: false,
    helperIsInitiator: true,
  });

  expect(receiver.resolvedRole).toBe("receiver");
  expect(helper.resolvedRole).toBe("sender");
  expect(receiver.associationTable?.[0]).toHaveLength(2);
  expect(helper.associationTable).toBeUndefined();
  expect(helperInbound.some((f) => Array.isArray(f))).toBe(false);
});

test("single-pass one-sided, payload-disclosing helper still receives its table at the wire", async () => {
  // The other side of the gate: a non-receiving helper that DOES disclose payload
  // needs its matched rows to build the enrichment it sends, so the table is NOT
  // withheld -- its process receives the association-table frame. Asserted at the
  // wire (the frame arrives), not merely inferred from the receiver's payload.
  const { receiver, helper, helperInbound } = await runOneSidedSinglePass({
    helperDiscloses: true,
    helperIsInitiator: false,
  });

  expect(helper.resolvedRole).toBe("sender");
  // Still gated from the emitted result -- the helper is not entitled to output.
  expect(helper.associationTable).toBeUndefined();
  // The receiver gets the helper's disclosed payload for the matched rows...
  expect(receiver.partnerPayload.columns).toEqual(["note"]);
  // ...which is only possible because the helper received its association-table half:
  // the table frame (the only Array-shaped frame) DID reach the helper's process.
  expect(helperInbound.some((f) => Array.isArray(f))).toBe(true);
});

test("withheld-shaped agreed terms outrank an advertised disclosure", async () => {
  // The receiver's suppression binds to the agreed terms, not to what the sender
  // asserts about itself: a helper whose terms declare `payload.send: []`, mirrored
  // by the receiver's `payload.receive: []`, is bound to disclosing no column, so a
  // build advertising `disclosesPayload` true against those terms is still sent no
  // association-table half.
  const { receiver, helper, helperInbound } = await runOneSidedSinglePass({
    helperDiscloses: false,
    helperIsInitiator: false,
    helperPayload: { send: [] },
    receiverPayload: { receive: [] },
    advertiseHelperDisclosure: true,
  });

  expect(receiver.resolvedRole).toBe("receiver");
  expect(helper.resolvedRole).toBe("sender");
  expect(receiver.associationTable?.[0]).toHaveLength(2);
  expect(helperInbound.some((f) => Array.isArray(f))).toBe(false);
});

test("disclosing agreed terms still deliver the helper its half", async () => {
  // The other side of the same cross-check: agreed terms declaring the helper's
  // `payload.send`, mirrored by the receiver's `payload.receive`, bind it to
  // disclosing that column, so it needs its matched rows and the half arrives.
  const note = [{ name: "note" }];
  const { receiver, helper, helperInbound } = await runOneSidedSinglePass({
    helperDiscloses: true,
    helperIsInitiator: false,
    helperPayload: { send: note },
    receiverPayload: { receive: note },
  });

  expect(helper.resolvedRole).toBe("sender");
  expect(receiver.partnerPayload.columns).toEqual(["note"]);
  expect(helperInbound.some((f) => Array.isArray(f))).toBe(true);
});

test("a withheld-shaped payload.send outranks the flag on a lazy receiver", async () => {
  // The suppressed half of the same cross-check, on the pair the compatibility
  // check leaves lazy: the helper's terms declare `payload.send: []` while the
  // receiver declares no `payload.receive` at all, so the helper is bound to
  // disclosing no column by its own document, and a build advertising
  // `disclosesPayload` true against it is still sent no association-table half.
  const { receiver, helper, helperInbound } = await runOneSidedSinglePass({
    helperDiscloses: false,
    helperIsInitiator: false,
    helperPayload: { send: [] },
    advertiseHelperDisclosure: true,
  });

  expect(receiver.resolvedRole).toBe("receiver");
  expect(helper.resolvedRole).toBe("sender");
  expect(receiver.associationTable?.[0]).toHaveLength(2);
  expect(helperInbound.some((f) => Array.isArray(f))).toBe(false);
});

test("an asserted disclosure the agreed terms contradict refuses both parties", async () => {
  // The honest misconfiguration the binding must not silence: the helper's
  // metadata transmits `note` while its terms declare no `payload.send` (the
  // guided and default paths author none), and the receiver declares an empty
  // `payload.receive`. The compatibility check passes that pair -- it holds the
  // receive against the DECLARED send -- so the contradiction is between the
  // agreed terms and what the helper's process discloses. Both parties refuse it,
  // and no association-table frame reaches the helper.
  const { receiver, helper, helperInbound } = await settleOneSidedSinglePass({
    helperDiscloses: true,
    helperIsInitiator: false,
    receiverPayload: { receive: [] },
  });

  expect(helper.status).toBe("rejected");
  expect(receiver.status).toBe("rejected");
  for (const outcome of [helper, receiver]) {
    const reason = (outcome as PromiseRejectedResult).reason as Error;
    expect(reason).toBeInstanceOf(PayloadDisclosureDivergenceError);
    expect(reason.message).toContain("empty payload.receive");
    expect(reason.message).toContain("asserts it discloses one");
  }
  expect(helperInbound.some((f) => Array.isArray(f))).toBe(false);
});

test("a helper owed no result may declare an empty payload.receive", async () => {
  // The direction that can move nothing must not refuse. The helper is
  // entitled to no output, so the send gate transmits it no column whatever
  // the receiver's own metadata holds -- and here that metadata does transmit
  // `note`, while the helper declares the empty `payload.receive` the schema
  // requires of a party expecting none. There is nothing for that declaration
  // to contradict, so the run completes and the helper's own `note` reaches
  // the receiver, on either strategy.
  for (const strategy of ["single-pass", "cascade"] as const) {
    const { receiver, helper, helperInbound } = await runOneSidedSinglePass({
      strategy,
      helperDiscloses: true,
      receiverDiscloses: true,
      helperIsInitiator: false,
      helperPayload: { receive: [] },
    });

    expect(helper.resolvedRole).toBe("sender");
    expect(receiver.partnerPayload.columns).toEqual(["note"]);
    // And nothing came back the other way: the helper is owed no result, so
    // the receiver's own disclosed column is never transmitted to it.
    expect(helper.partnerPayload.columns).toEqual([]);
    // Under single-pass the helper still receives its association-table half,
    // which is what building the payload above takes.
    if (strategy === "single-pass")
      expect(helperInbound.some((f) => Array.isArray(f))).toBe(true);
  }
});

test("the mirrored declaration on the party owed the result still refuses", async () => {
  // The same two parties with the empty declaration on the other document.
  // The RECEIVER is entitled to output, so the helper's disclosure has
  // somewhere to move and `payload.receive: []` on the party that would
  // receive it contradicts the helper's metadata. Both parties refuse, and
  // neither an association table nor a payload frame reaches either of them.
  const { receiver, helper, helperInbound, receiverInbound } =
    await settleOneSidedSinglePass({
      helperDiscloses: true,
      receiverDiscloses: true,
      helperIsInitiator: false,
      receiverPayload: { receive: [] },
    });

  for (const outcome of [helper, receiver]) {
    expect(outcome.status).toBe("rejected");
    expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(
      PayloadDisclosureDivergenceError,
    );
  }
  for (const inbound of [helperInbound, receiverInbound]) {
    expect(inbound.some((f) => Array.isArray(f))).toBe(false);
    expect(
      inbound.some(
        (f) => typeof f === "object" && f !== null && "hasData" in f,
      ),
    ).toBe(false);
  }
});

test("a one-sided divergence refusal aborts the party still waiting", async () => {
  // A modified helper whose advertisement diverges from its own metadata: the
  // metadata transmits `note` while the terms frame stamps `disclosesPayload`
  // false, against a receiver declaring an empty `payload.receive`. The two
  // roles read different assertions -- the helper its metadata, the receiver
  // the flag -- so only the helper refuses, and the receiver would otherwise
  // sit on the pipe awaiting a linkage frame the helper never sends. The abort
  // the refusal sends first is what ends that wait.
  const { receiver, helper, helperInbound, receiverInbound } =
    await settleOneSidedSinglePass({
      helperDiscloses: true,
      helperIsInitiator: false,
      receiverPayload: { receive: [] },
      advertiseHelperDisclosure: false,
    });

  expect(helper.status).toBe("rejected");
  expect((helper as PromiseRejectedResult).reason).toBeInstanceOf(
    PayloadDisclosureDivergenceError,
  );
  // Settled at all, rather than parked until the suite's own timeout: the pipe
  // arms no inactivity deadline, so without the abort frame this receiver never
  // returns and the test fails by timing out.
  expect(receiver.status).toBe("rejected");
  expect(receiverInbound).toContainEqual(PAYLOAD_DISCLOSURE_ABORT_FRAME);
  // Neither the association table (the only Array-shaped frame) nor a payload
  // frame moved in either direction before the refusal.
  for (const inbound of [helperInbound, receiverInbound]) {
    expect(inbound.some((f) => Array.isArray(f))).toBe(false);
    expect(
      inbound.some(
        (f) => typeof f === "object" && f !== null && "hasData" in f,
      ),
    ).toBe(false);
  }
});

test("the divergence refusal takes no message argument", () => {
  // Structural rather than asserted: with no parameter to pass, no call site
  // can interpolate a value read off either agreed document into the message
  // the operator is shown.
  expect(PayloadDisclosureDivergenceError.length).toBe(0);
});

interface TwoSidedOptions {
  strategy: LinkageStrategy;
  initiatorRows: typeof serverRows;
  responderRows: typeof serverRows;
  initiatorPayload?: Payload;
}

// Each party's outcome, every frame it put on the wire, and whatever was left
// unread in its inbound queue when both runs settled.
interface SettledTwoSided {
  initiator: PromiseSettledResult<ExchangeResult>;
  responder: PromiseSettledResult<ExchangeResult>;
  initiatorSent: Array<unknown>;
  responderSent: Array<unknown>;
  initiatorUnread: Array<unknown>;
  responderUnread: Array<unknown>;
}

// Everything left in a party's inbound queue once both runs have settled:
// what the peer put on the wire and this party never read. A frame the pipe
// already delivered resolves synchronously, so the bound below only decides
// how long the drain waits before concluding the queue is empty -- no
// assertion turns on its size.
const DRAINED_QUEUE_TIMEOUT_MS = 100;

async function drainInbound(conn: MessageConnection): Promise<Array<unknown>> {
  const frames: Array<unknown> = [];
  for (;;) {
    try {
      frames.push(await conn.receive(DRAINED_QUEUE_TIMEOUT_MS));
    } catch {
      return frames;
    }
  }
}

// Run a TWO-SIDED exchange (both parties expect output and share it, both
// datasets transmitting `note`) end to end, capturing every frame each party
// puts on the wire and draining what neither read. Row counts are set per
// party because role resolution follows the declared counts here -- the
// smaller dataset takes the PSI receiver seat -- which is how a test flips
// which seat a party's own declaration is held on.
async function settleTwoSided(opts: TwoSidedOptions): Promise<SettledTwoSided> {
  const [connInitiator, connResponder] = createMessagePipe();
  const initiatorSent: Array<unknown> = [];
  const responderSent: Array<unknown> = [];
  const capturing = (
    conn: MessageConnection,
    sent: Array<unknown>,
  ): MessageConnection => ({
    send: (m: unknown) => {
      sent.push(m);
      return conn.send(m);
    },
    receive: (timeoutMs?: number) => conn.receive(timeoutMs),
    close: () => conn.close(),
    setInboundFrameCap: conn.setInboundFrameCap?.bind(conn),
  });
  const prepare = (
    identity: string,
    rows: typeof serverRows,
    payload?: Payload,
  ) =>
    prepareForExchange(
      {
        linkageTerms: {
          ...baseTerms,
          linkageStrategy: opts.strategy,
          identity,
          output: both,
          ...(payload !== undefined ? { payload } : {}),
        },
      },
      identity,
      rows,
      ["first_name", "note"],
    );

  const [initiator, responder] = await Promise.allSettled([
    runExchange(
      capturing(connInitiator, initiatorSent),
      "initiator",
      prepare("Initiator Co", opts.initiatorRows, opts.initiatorPayload),
      { psiLibrary },
    ),
    runExchange(
      capturing(connResponder, responderSent),
      "responder",
      prepare("Responder Co", opts.responderRows),
      { psiLibrary },
    ),
  ]);
  return {
    initiator,
    responder,
    initiatorSent,
    responderSent,
    initiatorUnread: await drainInbound(connInitiator),
    responderUnread: await drainInbound(connResponder),
  };
}

// Whether a frame belongs to the terms exchange -- the terms themselves, or a
// bare decision frame. Every other frame kind the run sends (the PSI rounds,
// the association table, the payload) fails this, so asserting it over
// everything a party sent is the wire-level reading of "refused before any
// linkage round, association table or payload moved".
const isTermsOrDecisionFrame = (m: unknown): boolean =>
  typeof m === "object" && m !== null && (isTermsFrame(m) || "decision" in m);

function expectRefusedOnBothSides(settled: SettledTwoSided): void {
  for (const outcome of [settled.initiator, settled.responder]) {
    expect(outcome.status).toBe("rejected");
    expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(
      PayloadDisclosureDivergenceError,
    );
  }
  // Each party's abort reached the other: it is sitting unread in the peer's
  // inbound queue, since the peer refused on its own rather than waiting.
  for (const unread of [settled.initiatorUnread, settled.responderUnread])
    expect(unread).toContainEqual(PAYLOAD_DISCLOSURE_ABORT_FRAME);
  for (const sent of [settled.initiatorSent, settled.responderSent])
    expect(sent.every(isTermsOrDecisionFrame)).toBe(true);
}

test("the divergence refusal binds either seat the record counts give", async () => {
  // The seat a party is given follows the declared record counts, which no
  // operator chooses. Two-sided single-pass, both parties' metadata
  // transmitting `note` and neither declaring a `payload.send`: the initiator
  // declares an empty `payload.receive`, so the responder's disclosure
  // contradicts it. The same pair runs on both seatings -- the declaring party
  // on the smaller dataset (PSI receiver) and on the larger one (PSI sender) --
  // and each is paired with the control that declares no `payload.receive`,
  // which completes and hands that party the very column the declaration
  // refuses. Both seatings must refuse identically.
  for (const [initiatorRows, responderRows, seat] of [
    [clientRows, serverRows, "receiver"],
    [serverRows, clientRows, "sender"],
  ] as const) {
    const control = await settleTwoSided({
      strategy: "single-pass",
      initiatorRows,
      responderRows,
    });
    expect(control.initiator.status).toBe("fulfilled");
    const completed = (
      control.initiator as PromiseFulfilledResult<ExchangeResult>
    ).value;
    expect(completed.resolvedRole).toBe(seat);
    expect(completed.partnerPayload.columns).toEqual(["note"]);

    expectRefusedOnBothSides(
      await settleTwoSided({
        strategy: "single-pass",
        initiatorRows,
        responderRows,
        initiatorPayload: { receive: [] },
      }),
    );
  }
});

test("the divergence refusal fires under cascade too, before the first round", async () => {
  // The refusal reads what the agreed terms admit, not what a frame holds,
  // so it binds a strategy with no association-table frame to withhold. The
  // same pair as above under `cascade`: both parties refuse, and neither sends
  // a PSI round frame.
  expectRefusedOnBothSides(
    await settleTwoSided({
      strategy: "cascade",
      initiatorRows: clientRows,
      responderRows: serverRows,
      initiatorPayload: { receive: [] },
    }),
  );
});

// Every `payload` shape the per-direction resolution reads differently:
// absent, an empty dictionary, and each direction declared present-and-empty
// or present-with-a-column, alone and paired.
const PAYLOAD_SHAPES: ReadonlyArray<Payload | undefined> = [
  undefined,
  {},
  { send: [] },
  { receive: [] },
  { send: [], receive: [] },
  { send: [{ name: "note" }] },
  { receive: [{ name: "note" }] },
];

// The output entitlements two agreed documents can hold: each party's
// `expectsOutput` equals the other's `shareWithPartner`, which is what
// validateCompatibility holds them to, and the pair where neither expects
// output is the one it refuses outright.
const COMPATIBLE_OUTPUT_PAIRS: ReadonlyArray<readonly [Output, Output]> = [
  [
    { expectsOutput: true, shareWithPartner: true },
    { expectsOutput: true, shareWithPartner: true },
  ],
  [
    { expectsOutput: true, shareWithPartner: false },
    { expectsOutput: false, shareWithPartner: true },
  ],
  [
    { expectsOutput: false, shareWithPartner: true },
    { expectsOutput: true, shareWithPartner: false },
  ],
];

const matrixTerms = (
  output: Output,
  payload: Payload | undefined,
): LinkageTerms => ({
  ...baseTerms,
  linkageStrategy: "single-pass",
  identity: "Matrix Co",
  output,
  ...(payload !== undefined ? { payload } : {}),
});

// One direction's verdict with a refusal as a value, so a sweep can compare
// the two parties' readings of the same direction rather than one throw.
type DirectionOutcome = boolean | "refused";

const settleDirection = (
  asserts: boolean,
  disclosingTerms: LinkageTerms,
  receivingTerms: LinkageTerms,
): DirectionOutcome => {
  try {
    return resolveDirectionDisclosesPayload(
      asserts,
      disclosingTerms,
      receivingTerms,
    );
  } catch {
    return "refused";
  }
};

const settleBothDirections = (
  localAsserts: boolean,
  localTerms: LinkageTerms,
  partnerAsserts: boolean,
  partnerTerms: LinkageTerms,
): PayloadDisclosureDirections | "refused" => {
  try {
    return resolveBothDirectionsDisclosePayload(
      localAsserts,
      localTerms,
      partnerAsserts,
      partnerTerms,
    );
  } catch {
    return "refused";
  }
};

test("both parties resolve every direction of every conforming pair alike", () => {
  // A conforming party advertises exactly what its own metadata discloses, so
  // the two parties hold the same four inputs up to swapping local and
  // partner. Each party's own outbound direction must then equal the other's
  // reading of that same direction -- a refusal included -- or a receiver's
  // suppression and a sender's skip could disagree over a frame one of them
  // sends and the other never awaits. Swept over every declaration shape,
  // assertion and entitlement rather than sampled: nothing in the shape of
  // the resolution keeps a later refactor symmetric.
  let pairs = 0;
  for (const [localOutput, partnerOutput] of COMPATIBLE_OUTPUT_PAIRS)
    for (const localPayload of PAYLOAD_SHAPES)
      for (const partnerPayload of PAYLOAD_SHAPES)
        for (const localAsserts of [false, true])
          for (const partnerAsserts of [false, true]) {
            ++pairs;
            const localTerms = matrixTerms(localOutput, localPayload);
            const partnerTerms = matrixTerms(partnerOutput, partnerPayload);
            const localToPartner = settleDirection(
              localAsserts,
              localTerms,
              partnerTerms,
            );
            const partnerToLocal = settleDirection(
              partnerAsserts,
              partnerTerms,
              localTerms,
            );
            const pair = JSON.stringify({
              localOutput,
              localPayload,
              localAsserts,
              partnerOutput,
              partnerPayload,
              partnerAsserts,
            });

            // A direction whose receiving party is owed no result moves no
            // payload, so it resolves to no disclosure and never refuses.
            if (!partnerOutput.expectsOutput)
              expect(localToPartner, pair).toBe(false);
            if (!localOutput.expectsOutput)
              expect(partnerToLocal, pair).toBe(false);

            const local = settleBothDirections(
              localAsserts,
              localTerms,
              partnerAsserts,
              partnerTerms,
            );
            const partner = settleBothDirections(
              partnerAsserts,
              partnerTerms,
              localAsserts,
              localTerms,
            );
            if (localToPartner === "refused" || partnerToLocal === "refused") {
              expect(local, pair).toBe("refused");
              expect(partner, pair).toBe("refused");
              continue;
            }
            expect(local, pair).toEqual({ localToPartner, partnerToLocal });
            expect(partner, pair).toEqual({
              localToPartner: partnerToLocal,
              partnerToLocal: localToPartner,
            });
          }
  expect(pairs).toBe(
    COMPATIBLE_OUTPUT_PAIRS.length * PAYLOAD_SHAPES.length ** 2 * 4,
  );
});
