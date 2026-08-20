import { describe, expect, test } from "vitest";

// The count-only run driven end to end over a real message pipe and a real PSI
// library, against the shipped build rather than a forced setting. Every property
// asserted here is a normative row of docs/spec/PROTOCOL.md (PSI-C) or of
// docs/spec/EXCHANGE_RECORD.md (Count-only records), and the `psi` runs beside them
// hold the comparison the count-only claim is stated against.

import PSI from "@openmined/psi.js";

import {
  AlgorithmDivergenceError,
  prepareForExchange,
  resolveCountOnlyRun,
  runExchange,
} from "../src/exchange";
import { receiveCountReport } from "../src/protocolSetup";
import {
  ConnectionError,
  createMessagePipe,
} from "../src/connection/messageConnection";

import type { MessageConnection } from "../src/connection/messageConnection";
import type { ExchangeResult, PreparedExchange } from "../src/exchange";
import type { Algorithm } from "../src/types";
import type { LinkageTerms, Output } from "../src/config/linkageTerms";

const psiLibrary = await PSI();

const both: Output = { expectsOutput: true, shareWithPartner: true };
const receives: Output = { expectsOutput: true, shareWithPartner: false };
const helps: Output = { expectsOutput: false, shareWithPartner: true };

// firstName-only terms, as the record end-to-end suite uses: the default key
// templates all need SSN/DOB, so an explicit key is what gives both parties valid,
// matching terms over a first-name column.
const firstNameTerms = {
  version: "1.0.0",
  date: "2026-01-01",
  linkageStrategy: "cascade" as const,
  deduplicate: false,
  linkageFields: [{ name: "firstName", type: "first_name" as const }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
};

// Elizabeth is duplicated within the responder's own dataset, so both parties drop
// it from the round entirely and Carol is the only match. That is the vector the
// uniqueness filter has to survive: an unfiltered round reports the MULTISET
// intersection, which counts min(2, 1) for Elizabeth on top of Carol and yields 2.
const responderRows = [
  { first_name: "Alice" },
  { first_name: "Bob" },
  { first_name: "Carol" },
  { first_name: "Elizabeth" },
  { first_name: "Elizabeth" },
];
const initiatorRows = [
  { first_name: "Carol" },
  { first_name: "Elizabeth" },
  { first_name: "Henry" },
];
const expectedCount = 1;

function prepared(
  identity: string,
  output: Output,
  rows: Array<Record<string, string>>,
  algorithm: Algorithm,
): PreparedExchange {
  return prepareForExchange(
    { linkageTerms: { ...firstNameTerms, algorithm, identity, output } },
    identity,
    rows,
    ["first_name"],
  );
}

// Records every frame this party puts on the wire, leaving the receive path and the
// message order untouched -- what the count-report suppression is asserted against.
function recording(
  conn: MessageConnection,
  sent: Array<unknown>,
): MessageConnection {
  return {
    send: (data) => {
      sent.push(data);
      return conn.send(data);
    },
    receive: (timeoutMs?: number) => conn.receive(timeoutMs),
    close: () => conn.close(),
  };
}

// Swaps this party's own outbound no-data payload frame ({hasData: false} --
// the only frame a genuine count-only run ever builds, since associationTable
// stays undefined under countOnly regardless of entitlement) for a hostile
// non-empty one, leaving every other frame (terms exchange, PSI round, count
// report) untouched. What a partner that does not honor the send-gate at all --
// reaching the wire directly rather than through this codebase's own
// prepareForExchange/runExchange path -- can put on it.
function withHostilePayload(
  conn: MessageConnection,
  hostilePayload: unknown,
): MessageConnection {
  return {
    send: (data) => {
      const outgoing =
        typeof data === "object" && data !== null && "hasData" in data
          ? hostilePayload
          : data;
      return conn.send(outgoing);
    },
    receive: (timeoutMs?: number) => conn.receive(timeoutMs),
    close: () => conn.close(),
  };
}

const countReports = (frames: Array<unknown>): Array<unknown> =>
  frames.filter(
    (frame) =>
      typeof frame === "object" &&
      frame !== null &&
      "intersectionCount" in frame,
  );

interface RunOutcome {
  initiator: ExchangeResult;
  responder: ExchangeResult;
  initiatorSent: Array<unknown>;
  responderSent: Array<unknown>;
}

// Which party holds which dataset. The default puts the smaller set on the
// initiator, which makes it the receiver in a both-entitled round; swapping the two
// moves the receiver -- and with it the count-report leg's direction -- to the
// responder. The same pair of sets is exchanged either way, so the round still
// matches the one value (Carol) and still drops the duplicate (Elizabeth), and the
// expected count is unchanged.
interface Datasets {
  initiator: Array<Record<string, string>>;
  responder: Array<Record<string, string>>;
}

const initiatorHoldsSmallerDataset: Datasets = {
  initiator: initiatorRows,
  responder: responderRows,
};
const responderHoldsSmallerDataset: Datasets = {
  initiator: responderRows,
  responder: initiatorRows,
};

async function runBoth(
  initiatorOutput: Output,
  responderOutput: Output,
  algorithm: Algorithm = "psi-c",
  mutate: (prepared: PreparedExchange) => void = () => {},
  datasets: Datasets = initiatorHoldsSmallerDataset,
): Promise<RunOutcome> {
  const [connInitiator, connResponder] = createMessagePipe();
  const initiatorSent: Array<unknown> = [];
  const responderSent: Array<unknown> = [];
  const initiatorPrepared = prepared(
    "Initiator Co",
    initiatorOutput,
    datasets.initiator,
    algorithm,
  );
  const responderPrepared = prepared(
    "Responder Co",
    responderOutput,
    datasets.responder,
    algorithm,
  );
  mutate(initiatorPrepared);
  mutate(responderPrepared);
  const [initiator, responder] = await Promise.all([
    runExchange(
      recording(connInitiator, initiatorSent),
      "initiator",
      initiatorPrepared,
      { psiLibrary },
    ),
    runExchange(
      recording(connResponder, responderSent),
      "responder",
      responderPrepared,
      { psiLibrary },
    ),
  ]);
  return { initiator, responder, initiatorSent, responderSent };
}

test("both entitled: the count reaches both parties and no pairing reaches either", async () => {
  const { initiator, responder, initiatorSent, responderSent } = await runBoth(
    both,
    both,
  );

  // The run's whole result, held by both: the receiver computed it, the sender was
  // told it over the count-report leg.
  expect(initiator.intersectionCount).toBe(expectedCount);
  expect(responder.intersectionCount).toBe(expectedCount);

  // No association table on either side -- not withheld, not produced. A count-only
  // round has no pairing for either party's software to hand back, which is what
  // keeps this outcome distinguishable from the withheld-helper shape below.
  expect(initiator.associationTable).toBeUndefined();
  expect(responder.associationTable).toBeUndefined();

  // Both expect output, so the smaller dataset is the receiver: the initiator, which
  // is therefore the party that reports. Exactly one count-report frame exists, it
  // travels receiver -> sender, and it carries the tally.
  expect(initiator.resolvedRole).toBe("receiver");
  expect(responder.resolvedRole).toBe("sender");
  expect(countReports(initiatorSent)).toEqual([
    { intersectionCount: expectedCount },
  ]);
  expect(countReports(responderSent)).toEqual([]);
});

test("both entitled: the report leg runs the same way with the responder receiving", async () => {
  // The mirror of the round above, and the orientation the delivery leg is otherwise
  // never driven in: the responder holds the smaller dataset, so IT is the receiver
  // and the count travels responder -> initiator. The leg is driven by the resolved
  // PSI role rather than by which party opened the exchange, and this is what holds
  // that claim to a run rather than to a reading of the role rule.
  const { initiator, responder, initiatorSent, responderSent } = await runBoth(
    both,
    both,
    "psi-c",
    () => {},
    responderHoldsSmallerDataset,
  );

  expect(responder.resolvedRole).toBe("receiver");
  expect(initiator.resolvedRole).toBe("sender");

  // The sender's count arrived over the leg; the receiver computed its own.
  expect(initiator.intersectionCount).toBe(expectedCount);
  expect(responder.intersectionCount).toBe(expectedCount);
  expect(initiator.associationTable).toBeUndefined();
  expect(responder.associationTable).toBeUndefined();

  // Exactly one count-report frame, sent by the receiver alone -- the direction
  // followed the role, not the handshake.
  expect(countReports(responderSent)).toEqual([
    { intersectionCount: expectedCount },
  ]);
  expect(countReports(initiatorSent)).toEqual([]);
});

test("one-sided: no count-report frame either, with the initiator receiving", async () => {
  // The suppression case in the other orientation: the entitled party is the
  // INITIATOR here, so the role rule makes it the receiver and it holds the count
  // already. The absence is on the wire in this orientation too -- a frame suppressed
  // in one direction only would still mark that a count existed to report.
  const { initiator, responder, initiatorSent, responderSent } = await runBoth(
    receives,
    helps,
  );

  expect(initiator.resolvedRole).toBe("receiver");
  expect(initiator.intersectionCount).toBe(expectedCount);
  expect(responder.intersectionCount).toBeUndefined();
  expect(countReports(initiatorSent)).toEqual([]);
  expect(countReports(responderSent)).toEqual([]);
});

test("the count equals what a single-key psi run over the same key and data matches", async () => {
  // The comparability rule: with each party contributing the values it holds exactly
  // once, the count IS the size of the table the identifier-revealing run produces
  // over the same key and data. Run both algorithms over the same rows and compare
  // the two figures rather than either against a hand-written constant.
  const counted = await runBoth(both, both);
  const matched = await runBoth(both, both, "psi");

  expect(matched.initiator.associationTable?.[0]).toHaveLength(expectedCount);
  expect(counted.initiator.intersectionCount).toBe(
    matched.initiator.associationTable?.[0].length,
  );
  expect(counted.responder.intersectionCount).toBe(
    matched.responder.associationTable?.[0].length,
  );
});

test("a psi run over the same terms and data still reveals identifiers", async () => {
  // The other side of the coordinated change: admitting psi-c leaves the
  // identifier-revealing run exactly as it was, so an operator who did not ask for a
  // count still gets the pairing and a record attesting that it was disclosed.
  const { initiator, responder, initiatorSent, responderSent } = await runBoth(
    both,
    both,
    "psi",
  );

  expect(initiator.associationTable?.[0]).toHaveLength(expectedCount);
  expect(responder.associationTable?.[0]).toHaveLength(expectedCount);
  expect(initiator.intersectionCount).toBeUndefined();
  expect(responder.intersectionCount).toBeUndefined();

  // The record attests the identifier-revealing algorithm, and carries the
  // association-table commitment that marks this party as having received the
  // pairing -- the row a count-only record is required not to carry.
  expect(initiator.audit!.record.governance.algorithm).toBe("psi");
  expect(responder.audit!.record.governance.algorithm).toBe("psi");
  expect(initiator.audit!.record.commitments.associationTable).toBeDefined();
  expect(responder.audit!.record.commitments.associationTable).toBeDefined();

  // The count-report leg is psi-c's alone: a psi run carries none in either
  // direction, so admitting psi-c added no frame to the revealing exchange.
  expect(countReports(initiatorSent)).toEqual([]);
  expect(countReports(responderSent)).toEqual([]);
});

test("one-sided: the non-entitled party is sent no count-report frame at all", async () => {
  // The larger dataset is the entitled party here, so the role rule overrides the
  // row counts and the RESPONDER is the receiver -- the mirror of the both-entitled
  // round above, which the count leg has to run identically since it is driven by the
  // resolved PSI role rather than by which party opened the exchange.
  const { initiator, responder, initiatorSent, responderSent } = await runBoth(
    helps,
    receives,
  );

  // The entitled party is the receiver, so it already holds the count and there is
  // nothing to report.
  expect(responder.resolvedRole).toBe("receiver");
  expect(responder.intersectionCount).toBe(expectedCount);
  expect(initiator.intersectionCount).toBeUndefined();
  expect(initiator.associationTable).toBeUndefined();
  expect(responder.associationTable).toBeUndefined();

  // The absence is on the wire, not merely in the result: no frame is sent at all,
  // rather than an empty one whose presence would still mark that a count existed
  // to report.
  expect(countReports(initiatorSent)).toEqual([]);
  expect(countReports(responderSent)).toEqual([]);
});

test("the record attests the count-only run truthfully", async () => {
  const { initiator, responder } = await runBoth(both, both);
  const init = initiator.audit!.record;
  const resp = responder.audit!.record;

  // What was disclosed: a count, by both parties' agreed algorithm.
  expect(init.governance.algorithm).toBe("psi-c");
  expect(resp.governance.algorithm).toBe("psi-c");

  // The count is the run's whole result, recorded in the result-size field under the
  // unchanged both-entitled gate.
  expect(init.resultSize).toBe(expectedCount);
  expect(resp.resultSize).toBe(expectedCount);

  // No association-table commitment on either side, whatever the entitlement: its
  // presence is the record's marker that this party received the matched pairing, so
  // a count-only record carrying one would assert a disclosure the run did not make.
  expect(init.commitments.associationTable).toBeUndefined();
  expect(resp.commitments.associationTable).toBeUndefined();

  // Payload commitments are present and empty, never omitted -- the no-payload case
  // recorded explicitly, as under psi.
  expect(init.commitments.localPayloadSent).toBeDefined();
  expect(init.commitments.partnerPayloadReceived).toBeDefined();
  expect(init.governance.payloadSent).toEqual([]);
  expect(init.governance.payloadReceived).toEqual([]);
  expect(resp.governance.payloadSent).toEqual([]);
  expect(resp.governance.payloadReceived).toEqual([]);

  // Each party still records its own outbound exposure, which is its input size.
  expect(init.recordsExposed).toBe(initiatorRows.length);
  expect(resp.recordsExposed).toBe(responderRows.length);
});

test("one-sided: the receiver holds a count its own record does not carry", async () => {
  // The result-size gate is the terms agreement, not what a party happens to learn:
  // the conservative rule psi applies is carried over unchanged rather than relaxed
  // because psi-c's whole result happens to be one integer.
  const { initiator, responder } = await runBoth(receives, helps);

  expect(initiator.intersectionCount).toBe(expectedCount);
  expect(initiator.audit!.record.resultSize).toBeUndefined();
  expect(responder.audit!.record.resultSize).toBeUndefined();
  expect(initiator.audit!.record.governance.algorithm).toBe("psi-c");
  expect(responder.audit!.record.governance.algorithm).toBe("psi-c");
});

test("an over-broad count-only run is refused at the agreed-terms boundary, never narrowed", async () => {
  // Both parties carry the same out-of-shape terms, so neither is stopped by the
  // partner's parse alone: the run boundary refuses on each side rather than running
  // the round over the first of the two keys.
  const secondKey = {
    name: "firstNameAgain",
    elements: [{ field: "firstName" }],
  };
  await expect(
    runBoth(both, both, "psi-c", (p) => {
      p.linkageTerms = {
        ...p.linkageTerms,
        linkageKeys: [...p.linkageTerms.linkageKeys, secondKey],
      };
    }),
  ).rejects.toThrow(/exactly one linkage key/);
});

// The PSI round's frames are the only binary ones a run puts on the wire: the terms
// exchange, the count-report leg, and the payload exchange all send plain objects.
const psiFrames = (frames: Array<unknown>): Array<unknown> =>
  frames.filter((frame) => frame instanceof Uint8Array);

test.each([
  { initiator: "psi-c" as Algorithm, responder: "psi" as Algorithm },
  { initiator: "psi" as Algorithm, responder: "psi-c" as Algorithm },
])(
  "a divergent pair aborts both parties before any round (initiator $initiator, responder $responder)",
  async ({ initiator: initiatorAlgorithm, responder: responderAlgorithm }) => {
    // The two algorithms' dispatches never meet: `algorithm` is a
    // mandatory-consistency agreed term, so a psi-c party facing a psi partner aborts
    // at the terms exchange rather than starting a round the other side would run
    // differently. Either orientation, since either party can be the one holding the
    // count-only terms.
    const [connInitiator, connResponder] = createMessagePipe();
    const initiatorSent: Array<unknown> = [];
    const responderSent: Array<unknown> = [];
    const outcomes = await Promise.allSettled([
      runExchange(
        recording(connInitiator, initiatorSent),
        "initiator",
        prepared("Initiator Co", both, initiatorRows, initiatorAlgorithm),
        { psiLibrary },
      ),
      runExchange(
        recording(connResponder, responderSent),
        "responder",
        prepared("Responder Co", both, responderRows, responderAlgorithm),
        { psiLibrary },
      ),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "rejected",
      "rejected",
    ]);

    // The abort lands before any engine work reaches the wire: neither party's setup
    // nor request frame was sent, so no masked value of either dataset crossed under
    // an algorithm the two had not agreed.
    expect(psiFrames(initiatorSent)).toEqual([]);
    expect(psiFrames(responderSent)).toEqual([]);
  },
);

test("an algorithm divergence is refused at the agreed-terms run boundary", () => {
  // The invariant behind the terms-exchange abort above, encoded at the boundary the
  // run turns on: a pair that diverged anyway must refuse rather than resolve to "not
  // count-only", which would run the identifier-revealing engine while the psi-c
  // party's own record attested the count-only algorithm its terms named.
  const countOnlyTerms = prepared(
    "Initiator Co",
    both,
    initiatorRows,
    "psi-c",
  ).linkageTerms;
  const revealingTerms = prepared(
    "Responder Co",
    both,
    responderRows,
    "psi",
  ).linkageTerms;

  // Symmetric over the agreed pair: each party calls it with its own terms first, so
  // both refuse at this same point rather than one starting a round the other refuses.
  const orientations: Array<[LinkageTerms, LinkageTerms]> = [
    [countOnlyTerms, revealingTerms],
    [revealingTerms, countOnlyTerms],
  ];
  for (const [localTerms, partnerTerms] of orientations) {
    let refusal: unknown;
    try {
      resolveCountOnlyRun(localTerms, partnerTerms);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(AlgorithmDivergenceError);
    // A peer that proceeded past the compatibility abort, not a local
    // misconfiguration: the kind is what a consumer branches on.
    expect((refusal as ConnectionError).kind).toBe("protocol");
    expect((refusal as Error).message).toContain(
      `this party runs "${localTerms.algorithm}" and the partner runs ` +
        `"${partnerTerms.algorithm}"`,
    );
  }

  // The agreed pair still resolves to its own algorithm's run.
  expect(resolveCountOnlyRun(countOnlyTerms, countOnlyTerms)).toBe(true);
  expect(resolveCountOnlyRun(revealingTerms, revealingTerms)).toBe(false);
});

test("a count-only exchange whose input metadata would transmit a column is refused at prepare", async () => {
  // The fifth shape rule, over the metadata RESOLVED from this run's own input
  // columns: an unnamed extra column is inferred as a disclosed payload column, and a
  // count-only exchange carries none in either direction. Refused before any
  // credential, terms, or data are sent, rather than dropping the marked column to
  // bring the run into shape.
  expect(() =>
    prepareForExchange(
      {
        linkageTerms: {
          ...firstNameTerms,
          algorithm: "psi-c",
          identity: "Initiator Co",
          output: both,
        },
      },
      "Initiator Co",
      [{ first_name: "Carol", note: "c-c" }],
      ["first_name", "note"],
    ),
  ).toThrow(/transmits no data columns/);
});

test("a count-only run refuses an inbound payload column from a non-conforming partner", async () => {
  // docs/spec/PROTOCOL.md (PSI-C, Refusals) refuses payload in EITHER direction,
  // and the record's payload commitments are fixed present-and-empty
  // (docs/spec/EXCHANGE_RECORD.md, Count-only records) -- normative regardless of
  // what a partner actually transmits. The outbound leg is closed structurally
  // (associationTable stays undefined under countOnly, so this codebase's own
  // send-gate never builds a non-empty payload); this pins the INBOUND leg,
  // which a partner not honoring that gate could otherwise cross, refusing
  // through the run's expectedReceive lock-in rather than accepting whatever
  // columns arrive.
  const [connInitiator, connResponder] = createMessagePipe();
  const hostilePayload = {
    hasData: true,
    columns: ["note"],
    rowIndices: [0],
    rows: [["c-c"]],
  };
  const [initiatorOutcome, responderOutcome] = await Promise.allSettled([
    runExchange(
      connInitiator,
      "initiator",
      prepared("Initiator Co", both, initiatorRows, "psi-c"),
      { psiLibrary },
    ),
    runExchange(
      withHostilePayload(connResponder, hostilePayload),
      "responder",
      prepared("Responder Co", both, responderRows, "psi-c"),
      { psiLibrary },
    ),
  ]);

  // The initiator is the party that receives the hostile frame, so it is the one
  // that aborts through reconcileReceivedPayload's existing refusal.
  expect(initiatorOutcome.status).toBe("rejected");
  const refusal =
    initiatorOutcome.status === "rejected"
      ? initiatorOutcome.reason
      : undefined;
  expect(refusal).toBeInstanceOf(ConnectionError);
  expect((refusal as ConnectionError).kind).toBe("protocol");
  expect((refusal as Error).message).toContain("no payload at all");

  // The responder is the one forging the frame, not receiving one: its own
  // received payload (the initiator's genuine empty message) still matches its
  // own empty expectation, so only the victim's leg trips.
  expect(responderOutcome.status).toBe("fulfilled");
});

// --- The count-report frame on receipt ---------------------------------------
// The one figure a partner supplies on a count-only run: the receiver's tally,
// which the sender takes on trust as a NUMBER but not as an arbitrary value
// (docs/spec/PROTOCOL.md, PSI-C). The bound is the smaller of the two exchanged
// record counts, authenticated session state on both sides. These drive the parse
// itself with the shapes a non-conforming or hostile receiver can put on the frame:
// each is refused as a protocol violation on receipt, and none resolves a count the
// sender would go on to report as the run's result.
describe("a hostile count-report frame", () => {
  const maxCount = Math.min(initiatorRows.length, responderRows.length);

  const hostileFrames: Array<[string, unknown]> = [
    ["a count over the exchange's bound", { intersectionCount: maxCount + 1 }],
    ["a negative count", { intersectionCount: -1 }],
    ["a fractional count", { intersectionCount: 1.5 }],
    ["a count as a string", { intersectionCount: "2" }],
    ["a frame with no count at all", {}],
  ];

  test.each(hostileFrames)(
    "%s is refused on receipt",
    async (_label, frame) => {
      const [receiverEnd, senderEnd] = createMessagePipe();
      await receiverEnd.send(frame);

      const [outcome] = await Promise.allSettled([
        receiveCountReport(senderEnd, maxCount),
      ]);
      // Rejected rather than resolved: no count reaches the sender at all, so there is
      // none for it to record or report.
      expect(outcome.status).toBe("rejected");
      const refusal =
        outcome.status === "rejected" ? outcome.reason : undefined;
      expect(refusal).toBeInstanceOf(ConnectionError);
      expect((refusal as ConnectionError).kind).toBe("protocol");
    },
  );

  test("a count at the bound is still delivered", async () => {
    // The refusals above are the frame's shape, not a parse that rejects everything:
    // the largest count this exchange could legitimately produce still arrives.
    const [receiverEnd, senderEnd] = createMessagePipe();
    await receiverEnd.send({ intersectionCount: maxCount });
    await expect(receiveCountReport(senderEnd, maxCount)).resolves.toBe(
      maxCount,
    );
  });
});
