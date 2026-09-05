import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  DEFAULT_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  DirectoryListingBoundsError,
  MAX_ERROR_CAUSE_DEPTH,
  joinErrorCauseChain,
  sanitizeErrorForDisplay,
} from "@psilink/core";
import { CAUSE_DEPTH_ELISION_MARKER } from "@psilink/core/testing";

import {
  EMPTY_CHAIN_LINK,
  createFetchJobApiClient,
  createServerJobReattachDriver,
} from "@psi/jobClient/serverJobExchangeDriver";
import { spawnExchangeJob, validateAndSanitizeEvent } from "@jobs/cliDriver";
import { ERROR_MESSAGE_CHAIN_FIELD } from "@psi/relayErrorChain";
import { failureFor } from "@exchange/useInviterExchange";
import { renderSseFrame } from "@jobs/sse";

import {
  STUB_CLI_PATH,
  awaitJobTerminalState,
  tempDataRoot,
} from "../utils/jobFixtures";

import type { ExchangeErrorCategory } from "@psi/exchangeLifecycle";
import type { RelayEvent } from "@jobs/cliDriver";

// A terminal error is a whole cause chain, not one value: the failure sits on
// the first link, the operator's next step on a later one. The relay holds the
// links apart, each capped at the per-link budget and the count capped at the
// renderer's own depth bound, so a partner-chosen fragment on one link cannot
// truncate away the recovery step on another. Three legs below drive a real
// over-budget refusal, a chain exactly at the per-link budget, and a flooded link count.

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
      runControls: { sweepExchangeFiles: false, logFilePath: undefined },
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
 * The failure a console seat renders for a relayed event sequence, routed through
 * the real SSE frame encoder, the real browser-side job API client, and the
 * seat's own display pass. A `config` terminal is the category whose alert
 * exposes the CLI's own text -- the exchange category shows fixed copy instead --
 * so it is what a test of delivered text can observe.
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
  // The recovery step must sit past the cap the per-value pass would apply,
  // or a chain that fits proves nothing.
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
  // holds the step: this is the delivery the relay would otherwise have made.
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
  // What the widened-cap route would have to answer for: structuring the chain
  // as separate links must not let a subverted source flood more than the
  // renderer does. It hands the relay three times the walk's depth bound, every
  // link past the per-link budget; the relay admits the bound's worth of links
  // at that budget each, and no more.
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
        // The last link holds the elision marker on top of its own cap.
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
  // Here the relay is what cuts the chain: more links arrive than the renderer's
  // depth bound admits, and the marker the relay appends is the one the seat has
  // to preserve.
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

test("a chain the CLI already cut reaches the seat still saying so", async () => {
  // The other cut: the CLI's own renderer already spent the depth bound and
  // marked the last link, so the chain arrives already holding the marker, past
  // that link's own cap. A boundary that re-caps the link whole would spend the
  // budget on the marker and drop it -- and the marker's absence is exactly what
  // tells the operator the chain is the whole failure. Links at twice the
  // per-link budget put every link on the cap, the case such a boundary loses.
  const deep = Array.from({ length: MAX_ERROR_CAUSE_DEPTH * 2 }, (_, index) =>
    `link ${index} `.padEnd(COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH * 2, "w"),
  ).reduceRight<Error | undefined>(
    (cause, message) => new Error(message, { cause }),
    undefined,
  ) as Error;
  const message = sanitizeErrorForDisplay(deep);
  expect(message.endsWith(CAUSE_DEPTH_ELISION_MARKER)).toBe(true);

  const relayed = await relayErrorFromChild(message);
  const chain = relayed.filter((event) => event.type === "error")[0][
    ERROR_MESSAGE_CHAIN_FIELD
  ] as Array<string>;
  expect(chain).toHaveLength(MAX_ERROR_CAUSE_DEPTH);
  expect(chain[chain.length - 1].endsWith(CAUSE_DEPTH_ELISION_MARKER)).toBe(
    true,
  );

  const failure = await failureAtSeat(relayed);
  expect(failure.message.endsWith(CAUSE_DEPTH_ELISION_MARKER)).toBe(true);
  // The chain was cut, and its last rendered link spent its whole budget, so
  // the marker sits past a truncation of its own.
  expect(failure.message).toContain(`link ${MAX_ERROR_CAUSE_DEPTH - 1}`);
  expect(failure.message).not.toContain(`link ${MAX_ERROR_CAUSE_DEPTH}`);
  expect(failure.message).toContain(DISPLAY_TRUNCATION_MARKER);
});

test("a link the CLI rendered with no text of its own reaches the seat", async () => {
  // A cause thrown as an empty string renders as a link with no text: real,
  // first-party, and framed by the renderer like any other link. Dropping it at
  // the seat would shorten the chain, which re-points every link after it at the
  // wrong cause -- the operator reads the second failure as the direct cause of
  // the first.
  const message = sanitizeErrorForDisplay(
    new Error("the appliance refused the run", {
      cause: new Error("", { cause: "" }),
    }),
  );
  expect(message).toBe(
    joinErrorCauseChain(["the appliance refused the run", "Error", ""]),
  );

  const relayed = await relayErrorFromChild(message);
  const chain = relayed.filter((event) => event.type === "error")[0][
    ERROR_MESSAGE_CHAIN_FIELD
  ] as Array<string>;
  expect(chain).toEqual(["the appliance refused the run", "Error", ""]);

  const failure = await failureAtSeat(relayed);
  expect(failure.message).toBe(
    joinErrorCauseChain([
      "the appliance refused the run",
      "Error",
      EMPTY_CHAIN_LINK,
    ]),
  );
});

// The chain field the seat renders must always be the relay's own derivation
// from the message, never a source-supplied `messageChain` passed through
// verbatim: a chain handed over whole was never split by the renderer, so no
// depth bound or per-link budget was ever applied to it, and its content could
// be a subverted child's rather than the failure's. These tests drive that
// across every event shape the relay sees, with and without a chain to derive.
describe("the relayed chain is the relay's own derivation, never the source's", () => {
  /** The chain field of a relayed event, whatever the relay put on it. */
  function relayedChain(event: RelayEvent | null): unknown {
    expect(event).not.toBeNull();
    return (event as RelayEvent)[ERROR_MESSAGE_CHAIN_FIELD];
  }

  test("an error event holding no message holds no forged chain", async () => {
    const forged = ["a failure that did not happen", "and its forged recovery"];
    const event = validateAndSanitizeEvent({
      v: 1,
      type: "error",
      category: "config",
      messageChain: forged,
    });
    expect(relayedChain(event)).toEqual([]);

    // An empty derivation is what leaves the seat on its flat-field fallback,
    // so the operator reads the relay's own copy rather than the source's.
    const failure = await failureAtSeat([event as RelayEvent]);
    for (const link of forged) expect(failure.message).not.toContain(link);
  });

  test("an error event whose message is not a string holds no forged chain", async () => {
    const forged = ["attacker link A", "attacker link B"];
    const event = validateAndSanitizeEvent({
      v: 1,
      type: "error",
      category: "config",
      message: 12345,
      messageChain: forged,
    });
    expect(relayedChain(event)).toEqual([]);
    // The flat field keeps the generic pass's treatment of a non-string; it is
    // the chain that is derived, and a non-string message derives none.
    expect((event as RelayEvent).message).toBe(12345);

    const failure = await failureAtSeat([event as RelayEvent]);
    for (const link of forged) expect(failure.message).not.toContain(link);
  });

  test("a forged chain of 50,000 links does not survive at any size", () => {
    const flood = Array.from(
      { length: 50_000 },
      (_, index) => `link-${index}-${"z".repeat(200)}`,
    );
    const event = validateAndSanitizeEvent({
      v: 1,
      type: "error",
      category: "config",
      messageChain: flood,
    });
    expect(relayedChain(event)).toEqual([]);
    // Dropped rather than relocated: the forged chain reaches no field of the
    // outgoing event, not even under a name of the source's own choosing. This
    // says nothing about a sibling ARRAY field the source sent under its own
    // name -- those take the per-value escape with no entry-count bound (see
    // docs/spec/SERVER_JOB_API.md).
    expect(JSON.stringify(event)).not.toContain(flood[0]);
  });

  test("a chain derived from a real message wins over a forged field", async () => {
    const message = refusalChain();
    const forged = ["a failure that did not happen", "and its forged recovery"];
    const event = validateAndSanitizeEvent({
      v: 1,
      type: "error",
      category: "config",
      message,
      messageChain: forged,
    });
    const chain = relayedChain(event) as Array<string>;
    expect(chain).toHaveLength(2);
    expect(chain[1]).toBe(RECOVERY_STEP);
    for (const link of forged) expect(chain).not.toContain(link);

    const failure = await failureAtSeat([event as RelayEvent]);
    expect(failure.message.endsWith(RECOVERY_STEP)).toBe(true);
    for (const link of forged) expect(failure.message).not.toContain(link);
  });

  test("a non-error event holding the key does not relay it", () => {
    const event = validateAndSanitizeEvent({
      v: 1,
      type: "warning",
      message: "a warning the operator reads",
      messageChain: ["a link on an event that has no chain"],
    });
    expect(event).not.toBeNull();
    expect(ERROR_MESSAGE_CHAIN_FIELD in (event as RelayEvent)).toBe(false);
  });
});

// Splitting a chain on the renderer's own framing is exact only on text the
// renderer produced: an escaped link holds no raw newline, so the framing is
// the only one such text can hold. An error raised IN THIS BROWSER never
// crossed the renderer, so a literal `\ncaused by: ` in its own message is
// just text, and splitting on it would misread that text as a cause of its
// own. These tests check the seat's display pass does not perform that split.
describe("the seat splits a chain only where a renderer framed one", () => {
  const FORGED = "FORGED go to attacker.example and enter your secret";

  test("a raw message that spells the framing forges no link", () => {
    const failure = failureFor(
      "config",
      new Error(`the exchange could not be prepared\ncaused by: ${FORGED}`),
    );

    // The framing byte the seat renders is the one the renderer emits; a raw one
    // in the message is escaped where it stands.
    expect(failure.message).not.toContain("\n");
    expect(failure.message).toContain("\\x0a");
    // The text is still delivered -- on the link that actually held it.
    expect(failure.message).toContain(FORGED);
    expect(failure.message.split("\ncaused by: ")).toHaveLength(1);
  });

  test("a real cause chain on a raw error renders as the renderer frames it", () => {
    const failure = failureFor(
      "config",
      new Error("the exchange could not be prepared", {
        cause: new Error("the mounted config names no linkage terms"),
      }),
    );

    const links = failure.message.split("\ncaused by: ");
    expect(links).toHaveLength(2);
    expect(links[1]).toBe("the mounted config names no linkage terms");
  });
});
