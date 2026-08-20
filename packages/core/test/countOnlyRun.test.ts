import { expect, test, vi } from "vitest";

// The count-only run path is gated on APPLIED_SETTINGS.psiC, which is false in the
// shipped build: `psi-c` terms are refused at every boundary, and that refusal is
// pinned against the REAL flag elsewhere (countOnlyShape.test.ts, and the run-boundary
// case in exchangeRecordEndToEnd.test.ts). This file forces the flag true so the path
// itself is verified rather than only reachable in review. Every property asserted
// here is a normative row of docs/spec/PROTOCOL.md (PSI-C) or of
// docs/spec/EXCHANGE_RECORD.md (Count-only records).
vi.mock("../src/appliedSettings", () => ({
  APPLIED_SETTINGS: { psiC: true, deduplicate: false, fuzzyComparisons: false },
}));

import PSI from "@openmined/psi.js";

import { prepareForExchange, runExchange } from "../src/exchange";
import { createMessagePipe } from "../src/connection/messageConnection";

import type { MessageConnection } from "../src/connection/messageConnection";
import type { ExchangeResult, PreparedExchange } from "../src/exchange";
import type { Algorithm } from "../src/types";
import type { Output } from "../src/config/linkageTerms";

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

test("a partner running the other algorithm aborts both parties before any round", async () => {
  // The two algorithms' dispatches never meet: `algorithm` is a mandatory-consistency
  // agreed term, so a psi-c party facing a psi partner aborts at the terms exchange
  // rather than starting a round the other side would run differently.
  const [connInitiator, connResponder] = createMessagePipe();
  const outcomes = await Promise.allSettled([
    runExchange(
      connInitiator,
      "initiator",
      prepared("Initiator Co", both, initiatorRows, "psi-c"),
      { psiLibrary },
    ),
    runExchange(
      connResponder,
      "responder",
      prepared("Responder Co", both, responderRows, "psi"),
      { psiLibrary },
    ),
  ]);
  expect(outcomes.map((outcome) => outcome.status)).toEqual([
    "rejected",
    "rejected",
  ]);
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
