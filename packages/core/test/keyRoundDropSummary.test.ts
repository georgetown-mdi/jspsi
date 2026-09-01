import { afterEach, expect, test, vi } from "vitest";

// The drop reporting a whole RUN produces, over a real message pipe and a real
// PSI library: the per-row lines are bounded and the round's totals reach the
// operator, on terms whose fan-out puts every row over the width bound. The
// round-level behaviour is pinned in standardizedKeyIterable.test.ts; what this
// file adds is that a run closes its rounds at all, which only the exchange
// exercises.

import PSI from "@openmined/psi.js";

import { prepareForExchange, runExchange } from "../src/exchange";
import { createMessagePipe } from "../src/connection/messageConnection";
import {
  MAX_DROP_LINES_PER_KEY_ROUND,
  MAX_KEY_CANDIDATES_PER_ROW,
} from "../src/standardization";
import { getLogger } from "../src/utils/logger";

import type { Output } from "../src/config/linkageTerms";

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

const rowCount = MAX_DROP_LINES_PER_KEY_ROUND * 3;

const overWideRows = (party: string) =>
  Array.from({ length: rowCount }, (_unused, row) => ({
    first_name: Array.from(
      { length: MAX_KEY_CANDIDATES_PER_ROW + 1 },
      (_u, part) => `${party}${row}part${part}`,
    ).join(" "),
  }));

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
