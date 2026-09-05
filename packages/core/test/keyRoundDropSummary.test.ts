import { afterEach, expect, test, vi } from "vitest";

// The drop reporting a whole RUN produces, over a real message pipe and a real
// PSI library: the per-row lines are bounded and the round's totals reach the
// operator, on terms whose fan-out puts every row over the width bound. The
// round-level behaviour is pinned in standardizedKeyIterable.test.ts; what this
// file adds is what only the exchange exercises -- that a run closes its rounds
// at all, that a run whose PSI phase throws closes them too, and that a sink
// refusing one close costs neither the failure nor the rounds behind it.

import PSI from "@openmined/psi.js";

import { prepareForExchange, runExchange } from "../src/exchange";
import { createMessagePipe } from "../src/connection/messageConnection";
import {
  MAX_DROP_LINES_PER_KEY_ROUND,
  FAN_OUT_CANDIDATES_PER_ELEMENT,
} from "../src/standardization";
import { getLogger } from "../src/utils/logger";

import type { PsiEngine } from "../src/psi/psiEngine";
import type { Output } from "../src/config/linkageTermsSchema";

const psiLibrary = await PSI();

const logger = getLogger("cleaning");
const both: Output = { expectsOutput: true, shareWithPartner: true };

// One key whose element splits its value into tokens, so a row realizing more
// candidates than the width bound admits is dropped rather than refusing the
// run. A declared fan-out runs under single-pass alone (docs/spec/PROTOCOL.md,
// Fan-out runs under single-pass only). The delimiter is the space the name
// cleaning leaves between tokens: it runs ahead of the element transform, and
// it is what turns every other separator into one.
const terms = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi" as const,
  linkageStrategy: "single-pass" as const,
  deduplicate: false,
  linkageFields: [{ name: "firstName", type: "first_name" as const }],
  linkageKeys: [
    {
      name: "firstName",
      elements: [
        {
          field: "firstName",
          transform: [{ function: "split_on", params: { delimiter: " " } }],
        },
      ],
    },
  ],
};

// The same fan-out over a second key, so a run holds one round behind another
// and the second one is closed after the first one's close has thrown.
const twoKeyTerms = {
  ...terms,
  linkageFields: [
    { name: "firstName", type: "first_name" as const },
    { name: "lastName", type: "last_name" as const },
  ],
  linkageKeys: [
    ...terms.linkageKeys,
    {
      name: "lastName",
      elements: [
        {
          field: "lastName",
          transform: [{ function: "split_on", params: { delimiter: " " } }],
        },
      ],
    },
  ],
};

const rowCount = MAX_DROP_LINES_PER_KEY_ROUND * 3;

const overWideRows = (party: string) =>
  Array.from({ length: rowCount }, (_unused, row) => ({
    first_name: Array.from(
      { length: FAN_OUT_CANDIDATES_PER_ELEMENT + 1 },
      (_u, part) => `${party}${row}part${part}`,
    ).join(" "),
  }));

const overWideRowsForBothKeys = (party: string) =>
  overWideRows(party).map((row) => ({ ...row, last_name: row.first_name }));

// The failure thrown to a run's caller, by an engine that refuses the
// first crypto step of either role. The link phase reaches that step only
// once both parties have built every round and taken every drop, so a run
// refused here is a failing run whose rounds the teardown still has to
// close.
const engineFailure = new Error("the psi engine refused this run");

const refusingPsiEngine = (): PsiEngine => ({
  createServerSetup: () => Promise.reject(engineFailure),
  processClientRequest: () => Promise.reject(engineFailure),
  createClientRequest: () => Promise.reject(engineFailure),
  receiveServerSetup: () => Promise.reject(engineFailure),
  computeAssociationTable: () => Promise.reject(engineFailure),
  computeIntersectionCardinality: () => Promise.reject(engineFailure),
  dispose: () => {},
});

afterEach(() => vi.restoreAllMocks());

test("a run that drops every row reports a few of them and one summary", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  const [connInitiator, connResponder] = createMessagePipe();
  const [initiator, responder] = await Promise.all([
    runExchange(
      connInitiator,
      "initiator",
      prepareForExchange(
        { linkageTerms: { ...terms, identity: "Initiator Co", output: both } },
        "Initiator Co",
        overWideRows("i"),
        ["first_name"],
      ),
      { psiLibrary },
    ),
    runExchange(
      connResponder,
      "responder",
      prepareForExchange(
        { linkageTerms: { ...terms, identity: "Responder Co", output: both } },
        "Responder Co",
        overWideRows("r"),
        ["first_name"],
      ),
      { psiLibrary },
    ),
  ]);

  // Every row of both parties sat the round out, so nothing matched.
  expect(initiator.associationTable).toEqual([[], []]);
  expect(responder.associationTable).toEqual([[], []]);

  const drops = warn.mock.calls
    .map((call) => call[0] as string)
    .filter((message) => message.includes('key "firstName"'));
  const perRow = drops.filter((message) => message.startsWith("row "));
  const summaries = drops.filter((message) => message.includes("rows dropped"));

  // Two parties, each reporting its own round's allowance and one summary --
  // 30 dropped rows behind 10 lines and 2 summaries.
  expect(perRow).toHaveLength(MAX_DROP_LINES_PER_KEY_ROUND * 2);
  expect(summaries).toHaveLength(2);
  for (const summary of summaries) {
    expect(summary).toContain(`${rowCount} rows dropped`);
    expect(summary).not.toMatch(/part/i);
  }
});

test("a run that throws still summarizes each round it opened, once", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  const [connInitiator, connResponder] = createMessagePipe();
  const outcomes = await Promise.allSettled([
    runExchange(
      connInitiator,
      "initiator",
      prepareForExchange(
        { linkageTerms: { ...terms, identity: "Initiator Co", output: both } },
        "Initiator Co",
        overWideRows("i"),
        ["first_name"],
      ),
      { psiLibrary, psiEngineFactory: refusingPsiEngine },
    ),
    runExchange(
      connResponder,
      "responder",
      prepareForExchange(
        { linkageTerms: { ...terms, identity: "Responder Co", output: both } },
        "Responder Co",
        overWideRows("r"),
        ["first_name"],
      ),
      { psiLibrary, psiEngineFactory: refusingPsiEngine },
    ),
  ]);

  // What the operator is given is the failure, not something the teardown's own
  // reporting raised on the way out.
  for (const outcome of outcomes) {
    expect(outcome.status).toBe("rejected");
    expect((outcome as PromiseRejectedResult).reason).toBe(engineFailure);
  }

  const drops = warn.mock.calls
    .map((call) => call[0] as string)
    .filter((message) => message.includes('key "firstName"'));
  expect(drops.filter((message) => message.startsWith("row "))).toHaveLength(
    MAX_DROP_LINES_PER_KEY_ROUND * 2,
  );
  const summaries = drops.filter((message) => message.includes("rows dropped"));
  expect(summaries).toHaveLength(2);
  for (const summary of summaries)
    expect(summary).toContain(`${rowCount} rows dropped`);
});

test("a summary line the sink refuses costs no other round its close", async () => {
  // A sink that throws where the run's rounds are closed sits on the exception
  // path out of a failing PSI phase: it must neither become the failure the
  // caller sees nor stop the rounds behind it from stating their totals.
  const warn = vi
    .spyOn(logger, "warn")
    .mockImplementation((...args: unknown[]) => {
      if ((args[0] as string).startsWith('key "firstName"'))
        throw new Error("the diagnostic sink refused this line");
    });
  const [connInitiator, connResponder] = createMessagePipe();
  const outcomes = await Promise.allSettled([
    runExchange(
      connInitiator,
      "initiator",
      prepareForExchange(
        {
          linkageTerms: {
            ...twoKeyTerms,
            identity: "Initiator Co",
            output: both,
          },
        },
        "Initiator Co",
        overWideRowsForBothKeys("i"),
        ["first_name", "last_name"],
      ),
      { psiLibrary, psiEngineFactory: refusingPsiEngine },
    ),
    runExchange(
      connResponder,
      "responder",
      prepareForExchange(
        {
          linkageTerms: {
            ...twoKeyTerms,
            identity: "Responder Co",
            output: both,
          },
        },
        "Responder Co",
        overWideRowsForBothKeys("r"),
        ["first_name", "last_name"],
      ),
      { psiLibrary, psiEngineFactory: refusingPsiEngine },
    ),
  ]);

  for (const outcome of outcomes) {
    expect(outcome.status).toBe("rejected");
    expect((outcome as PromiseRejectedResult).reason).toBe(engineFailure);
  }

  const summaries = warn.mock.calls
    .map((call) => call[0] as string)
    .filter((message) => message.includes("rows dropped"));
  // Both parties reached the refused first-key summary and stated the second
  // key's totals behind it.
  expect(
    summaries.filter((message) => message.startsWith('key "firstName"')),
  ).toHaveLength(2);
  const closed = summaries.filter((message) =>
    message.startsWith('key "lastName"'),
  );
  expect(closed).toHaveLength(2);
  for (const summary of closed)
    expect(summary).toContain(`${rowCount} rows dropped`);
});
