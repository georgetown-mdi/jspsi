import fs from "node:fs";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import {
  CAUSE_DEPTH_ELISION_MARKER,
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  DEFAULT_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  DirectoryListingBoundsError,
  MAX_ERROR_CAUSE_DEPTH,
  joinErrorCauseChain,
  sanitizeErrorForDisplay,
} from "@psilink/core";

import {
  createFetchJobApiClient,
  createServerJobReattachDriver,
} from "@psi/serverJobExchangeDriver";
import { ERROR_MESSAGE_CHAIN_FIELD } from "@psi/relayErrorChain";
import { failureFor } from "@bench/useInviterExchange";
import { renderSseFrame } from "@jobs/sse";
import { spawnExchangeJob } from "@jobs/cliDriver";

import {
  STUB_CLI_PATH,
  awaitJobTerminalState,
  tempDataRoot,
} from "../utils/jobFixtures";

import type { ExchangeErrorCategory } from "@psi/exchangeLifecycle";
import type { RelayEvent } from "@jobs/cliDriver";

// A terminal error the CLI renders is a whole cause chain, not one value: the
// failure on the first link and, when the composition partitions by chooser, the
// operator's next step on a later one. Charged to the per-value cap at the relay,
// that chain is cut wherever 256 characters fall -- and on a refusal whose first
// link carries a partner-chosen fragment, that is inside the fragment, so the
// operator is told a run failed and never told what to do about it. The relay
// carries the links apart instead, each at the budget the renderer gave it and
// the count held to the renderer's own depth bound, and the seat rebuilds the
// chain.
//
// One leg drives a REAL over-budget refusal from the child process's fd 3 to the
// string a console seat renders, and fails unless the recovery step is still
// there. A second drives a chain composed at the per-link budget, which is what
// catches a boundary re-capping anywhere below the constant. A third floods the
// link COUNT from the child, since the volume the relay admits must be the
// renderer's own bound and not a wider one.

const dirs: Array<string> = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

/** A scratch working directory for one spawned child, removed after the test. */
function scratchDir(label: string): string {
  const dir = tempDataRoot(label);
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

/**
 * A real psilink refusal rendered exactly as the CLI puts it on fd 3, with the
 * partner-chosen fragment on its first link flooded: the rendezvous listing
 * bound, whose composition partitions by chooser -- the entry the partner named
 * on one link, this party's recovery step on the next. The flood is what pushes
 * that recovery step past the per-value cap; nothing about the message is
 * synthetic.
 */
function refusalChain(): string {
  const flooded = `partner-chosen-${"n".repeat(400)}.json`;
  return sanitizeErrorForDisplay(new DirectoryListingBoundsError(flooded));
}

/** The last link of a rendered chain: the step the operator has to act on. */
function recoveryStepOf(rendered: string): string {
  const links = rendered.split("\ncaused by: ");
  return links[links.length - 1];
}

/**
 * The refusal class's uniform recovery step, read off a minimal construction of
 * the class rather than restated here, so an edit to that sentence cannot leave
 * a stale copy passing.
 */
const RECOVERY_STEP = recoveryStepOf(
  sanitizeErrorForDisplay(new DirectoryListingBoundsError("an entry")),
);

/**
 * The events the relay delivered for a child that wrote `message` as its
 * terminal `error` line on fd 3 -- the real child process, line reader, and
 * schema validation.
 */
async function relayErrorFromChild(
  message: string,
): Promise<Array<RelayEvent>> {
  const workdir = scratchDir("relay-error");
  const relayed: Array<RelayEvent> = [];
  await awaitJobTerminalState((onTerminal) =>
    spawnExchangeJob({
      binaryPath: STUB_CLI_PATH,
      configPath: path.join(workdir, "psilink.yaml"),
      keyPath: path.join(workdir, ".psilink.key"),
      inputPath: path.join(workdir, "input.csv"),
      outputPath: path.join(workdir, "output.csv"),
      recordPath: path.join(workdir, "record.json"),
      workdir,
      eventStream: true,
      extraEnv: {
        STUB_FD3_EVENTS: JSON.stringify([
          { v: 1, type: "error", category: "config", message },
        ]),
        STUB_EXIT_CODE: "64",
      },
      handlers: {
        onEvent: (event) => relayed.push(event),
        onDegraded: () => undefined,
        onTerminal,
      },
    }),
  );
  return relayed;
}

/**
 * The failure a console seat renders for a relayed event sequence, carried over
 * the real SSE frame encoder, the real browser-side job API client, and the
 * seat's own display pass. A `config` terminal is the category whose alert
 * surfaces the CLI's own text -- the exchange category deliberately shows fixed
 * copy instead -- so it is what a test of delivered text can observe.
 */
async function failureAtSeat(
  events: Array<RelayEvent>,
): Promise<{ category: ExchangeErrorCategory; message: string }> {
  const body = events
    .map((event, index) => renderSseFrame(index + 1, event))
    .join("");
  const fetchImpl: typeof fetch = (input) =>
    Promise.resolve(
      String(input).endsWith("/events")
        ? new Response(body, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          })
        : new Response(null, { status: 404 }),
    );

  const raised: Array<{ category: ExchangeErrorCategory; error: unknown }> = [];
  const driver = createServerJobReattachDriver(
    "job-1",
    createFetchJobApiClient(fetchImpl),
  );
  await driver.run({
    signal: new AbortController().signal,
    onStages: () => undefined,
    onStage: () => undefined,
    onResult: () => undefined,
    onError: (failure) => raised.push(failure),
  });
  expect(raised).toHaveLength(1);
  const failure = failureFor(raised[0].category, raised[0].error);
  return { category: failure.category, message: failure.message };
}

test("a real over-budget refusal reaches a console seat with its recovery step", async () => {
  const message = refusalChain();
  const recovery = recoveryStepOf(message);
  // The case is only worth driving if the recovery step sits past the cap the
  // per-value pass would apply: a chain that fits proves nothing.
  expect(message.length).toBeGreaterThan(DEFAULT_MAX_DISPLAY_LENGTH);
  expect(message.indexOf(recovery)).toBeGreaterThan(DEFAULT_MAX_DISPLAY_LENGTH);
  // What is asserted below is the refusal class's own step, not a copy of it.
  expect(recovery).toBe(RECOVERY_STEP);

  const relayed = await relayErrorFromChild(message);
  const errors = relayed.filter((event) => event.type === "error");
  expect(errors).toHaveLength(1);
  const chain = errors[0][ERROR_MESSAGE_CHAIN_FIELD] as Array<string>;
  expect(chain).toHaveLength(2);
  expect(chain[1]).toBe(recovery);
  // The flat field is still capped as one value, so the chain field is what
  // carries the step: this is the delivery the relay would otherwise have made.
  expect(errors[0].message as string).not.toContain(recovery);
  expect(errors[0].message as string).toContain(DISPLAY_TRUNCATION_MARKER);

  const failure = await failureAtSeat(relayed);
  expect(failure.category).toBe("config");
  expect(failure.message.endsWith(recovery)).toBe(true);
  expect(failure.message.endsWith(DISPLAY_TRUNCATION_MARKER)).toBe(false);
  // The flooded fragment still truncates at its own link's cap -- that bound is
  // untouched, and its marker sits inside the chain rather than at its end.
  expect(failure.message.length).toBeGreaterThan(
    DEFAULT_MAX_DISPLAY_LENGTH + DISPLAY_TRUNCATION_MARKER.length,
  );
});

test("a chain composed at the per-link budget reaches a seat uncut", async () => {
  // The real refusal measures well under two links at the budget, so driving it
  // holds only that both boundaries clear THAT chain. This message is what ties
  // them to the constant: it survives only while the relay and the seat both
  // charge each link at or above COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH.
  const tail = " the clause no boundary below the budget can keep.";
  const linkAtBudget = (head: string): string =>
    head +
    "x".repeat(
      COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH - head.length - tail.length,
    ) +
    tail;
  const message = joinErrorCauseChain([
    linkAtBudget("a first-party failure composed to the whole link budget: "),
    linkAtBudget("and the recovery step, composed to the same budget: "),
  ]);

  const relayed = await relayErrorFromChild(message);
  const errors = relayed.filter((event) => event.type === "error");
  expect(errors).toHaveLength(1);
  const chain = errors[0][ERROR_MESSAGE_CHAIN_FIELD] as Array<string>;
  expect(chain).toHaveLength(2);
  for (const link of chain)
    expect(link.length).toBe(COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH);

  const failure = await failureAtSeat(relayed);
  expect(failure.message).toBe(message);
  expect(failure.message).not.toContain(DISPLAY_TRUNCATION_MARKER);
});

test("a flooded chain is held to the volume the renderer itself emits", async () => {
  // What the widened-cap route would have to answer for: carrying the chain
  // structurally must not let a subverted source flood more than the renderer
  // does. It hands the relay three times the walk's depth bound, every link past
  // the per-link budget; the relay admits the bound's worth of links at that
  // budget each, and no more.
  const flood = Array.from(
    { length: MAX_ERROR_CAUSE_DEPTH * 3 },
    (_, index) => `link ${index} ${"y".repeat(2000)}`,
  );

  const relayed = await relayErrorFromChild(joinErrorCauseChain(flood));
  const errors = relayed.filter((event) => event.type === "error");
  expect(errors).toHaveLength(1);
  const chain = errors[0][ERROR_MESSAGE_CHAIN_FIELD] as Array<string>;

  expect(chain).toHaveLength(MAX_ERROR_CAUSE_DEPTH);
  for (const link of chain)
    expect(link.length).toBeLessThanOrEqual(
      COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH +
        DISPLAY_TRUNCATION_MARKER.length +
        // The last link carries the elision marker on top of its own cap.
        CAUSE_DEPTH_ELISION_MARKER.length +
        1,
    );
  expect(chain[chain.length - 1].endsWith(CAUSE_DEPTH_ELISION_MARKER)).toBe(
    true,
  );
  expect(joinErrorCauseChain(chain)).not.toContain(
    `link ${MAX_ERROR_CAUSE_DEPTH}`,
  );
});

test("a cut chain reaches the seat saying it was cut", async () => {
  // The elision marker is what lets an operator tell a whole failure from a cut
  // one, so it has to survive the seat's own pass rather than only the relay's.
  // Links well under the per-link budget, since a link AT the budget spends the
  // room the marker would occupy and every boundary re-escaping it cuts the tail
  // -- the same property that makes a message composed at a budget the one the
  // next boundary truncates.
  const flood = Array.from(
    { length: MAX_ERROR_CAUSE_DEPTH * 2 },
    (_, index) => `link ${index}`,
  );

  const relayed = await relayErrorFromChild(joinErrorCauseChain(flood));
  const chain = relayed.filter((event) => event.type === "error")[0][
    ERROR_MESSAGE_CHAIN_FIELD
  ] as Array<string>;
  expect(chain).toHaveLength(MAX_ERROR_CAUSE_DEPTH);

  const failure = await failureAtSeat(relayed);
  expect(failure.message).toContain(CAUSE_DEPTH_ELISION_MARKER);
  expect(failure.message).toContain(`link ${MAX_ERROR_CAUSE_DEPTH - 1}`);
  expect(failure.message).not.toContain(`link ${MAX_ERROR_CAUSE_DEPTH}`);
});
