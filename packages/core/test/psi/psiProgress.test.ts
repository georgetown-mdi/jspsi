import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { PSIParticipant } from "../../src/psi/participant";
import type { PsiProgress } from "../../src/psi/participant";
import { InProcessPsiEngine, type PsiEngine } from "../../src/psi/psiEngine";
import { createMessagePipe } from "../../src/connection/messageConnection";
import { UNBOUNDED_PSI_ELEMENTS } from "../utils/psiElementBounds";

// What a progress display reads off a round: the element count each crypto
// operation covers, and how long it ran. The counts are the whole point -- a
// display that names the wrong figure tells the operator a dataset size that is
// not the one being masked -- so each is asserted against the set that produced
// it rather than against a cap or a bound.

const psiLibrary = await PSI();

const senderValues = ["Alice", "Bob", "Carol", "David", "Elizabeth"];
const receiverValues = ["Carol", "Elizabeth", "Henry"];

function participant(
  id: string,
  role: "starter" | "joiner",
  reports: Array<PsiProgress>,
  engine?: PsiEngine,
): PSIParticipant {
  return new PSIParticipant(
    id,
    psiLibrary,
    { role, verbose: 0 },
    UNBOUNDED_PSI_ELEMENTS,
    engine,
    (progress) => reports.push(progress),
  );
}

// The reported operations in order, one entry per operation, with the count and
// the two states it reported. Pairing them here is what makes a missing or
// duplicated report a failure rather than something a per-field assertion
// happens to step over.
function operationsFrom(
  reports: ReadonlyArray<PsiProgress>,
): Array<{ operation: string; elements: number; states: Array<string> }> {
  const operations: Array<{
    operation: string;
    elements: number;
    states: Array<string>;
  }> = [];
  for (const report of reports) {
    const last = operations.at(-1);
    if (report.state === "started" || last === undefined) {
      operations.push({
        operation: report.operation,
        elements: report.elements,
        states: [report.state],
      });
      continue;
    }
    last.states.push(report.state);
  }
  return operations;
}

test("an identifier-revealing round reports each operation's element count", async () => {
  const [senderConn, receiverConn] = createMessagePipe();
  const senderReports: Array<PsiProgress> = [];
  const receiverReports: Array<PsiProgress> = [];

  await Promise.all([
    participant("sender", "starter", senderReports).identifyIntersection(
      senderConn,
      senderValues,
    ),
    participant("receiver", "joiner", receiverReports).identifyIntersection(
      receiverConn,
      receiverValues,
    ),
  ]);

  // The sender masks its own set, then the receiver's request -- the inbound
  // count read off the frame itself, which is why it is the receiver's set size
  // and not the sender's or an element bound.
  expect(operationsFrom(senderReports)).toStrictEqual([
    {
      operation: "createServerSetup",
      elements: senderValues.length,
      states: ["started", "finished"],
    },
    {
      operation: "processClientRequest",
      elements: receiverValues.length,
      states: ["started", "finished"],
    },
  ]);
  // The receiver masks its own set, then matches the response, which holds one
  // element per value it asked about.
  expect(operationsFrom(receiverReports)).toStrictEqual([
    {
      operation: "createClientRequest",
      elements: receiverValues.length,
      states: ["started", "finished"],
    },
    {
      operation: "computeAssociationTable",
      elements: receiverValues.length,
      states: ["started", "finished"],
    },
  ]);
});

test("a duration rides the settled report and nothing else", async () => {
  const reports: Array<PsiProgress> = [];
  await participant("sender", "starter", reports).createServerSetup(
    senderValues,
  );

  const [started, finished] = reports;
  expect(started.state).toBe("started");
  expect(started.durationMs).toBeUndefined();
  expect(finished.state).toBe("finished");
  expect(finished.durationMs).toBeGreaterThanOrEqual(0);
  expect(Number.isFinite(finished.durationMs)).toBe(true);
});

test("a count-only round reports the cardinality operation", async () => {
  const [senderConn, receiverConn] = createMessagePipe();
  const receiverReports: Array<PsiProgress> = [];
  const sender = participant(
    "sender",
    "starter",
    [],
    new InProcessPsiEngine(psiLibrary, "starter", "sender", "count-only"),
  );
  const receiver = participant(
    "receiver",
    "joiner",
    receiverReports,
    new InProcessPsiEngine(psiLibrary, "joiner", "receiver", "count-only"),
  );

  await Promise.all([
    sender.countIntersection(senderConn, senderValues),
    receiver.countIntersection(receiverConn, receiverValues),
  ]);

  expect(operationsFrom(receiverReports)).toStrictEqual([
    {
      operation: "createClientRequest",
      elements: receiverValues.length,
      states: ["started", "finished"],
    },
    {
      operation: "computeIntersectionCardinality",
      elements: receiverValues.length,
      states: ["started", "finished"],
    },
  ]);
});

test("an operation that raises reports failed, not finished", async () => {
  const reports: Array<PsiProgress> = [];
  const refusing = {
    createServerSetup: () => Promise.reject(new Error("engine refused")),
  } as unknown as PsiEngine;

  await expect(
    participant("sender", "starter", reports, refusing).createServerSetup(
      senderValues,
    ),
  ).rejects.toThrow("engine refused");

  expect(reports.map((report) => report.state)).toStrictEqual([
    "started",
    "failed",
  ]);
  expect(reports[1].elements).toBe(senderValues.length);
});

test("a raising reporter neither relabels nor repeats a finished operation", async () => {
  const reports: Array<PsiProgress> = [];
  const raising = new PSIParticipant(
    "sender",
    psiLibrary,
    { role: "starter", verbose: 0 },
    UNBOUNDED_PSI_ELEMENTS,
    undefined,
    (progress) => {
      reports.push(progress);
      if (progress.state === "finished") throw new Error("reporter refused");
    },
  );

  await expect(raising.createServerSetup(senderValues)).rejects.toThrow(
    "reporter refused",
  );

  expect(reports.map((report) => report.state)).toStrictEqual([
    "started",
    "finished",
  ]);
});

test("a participant given no reporter runs the operation unchanged", async () => {
  const silent = new PSIParticipant(
    "sender",
    psiLibrary,
    { role: "starter", verbose: 0 },
    UNBOUNDED_PSI_ELEMENTS,
  );

  await expect(silent.createServerSetup(senderValues)).resolves.toHaveProperty(
    "setup",
  );
});
