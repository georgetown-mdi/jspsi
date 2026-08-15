import fs from "node:fs";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import {
  DEFAULT_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
  reconcileHostKeyFingerprints,
  redactAndSanitizeForDisplay,
} from "@psilink/core";

import {
  createFetchJobApiClient,
  createServerJobReattachDriver,
} from "@psi/serverJobExchangeDriver";
import { appendSanitizedRunWarning } from "@bench/runWarnings";
import { renderSseFrame } from "@jobs/sse";
import { spawnExchangeJob } from "@jobs/cliDriver";

import {
  STUB_CLI_PATH,
  awaitJobTerminalState,
  tempDataRoot,
} from "../utils/jobFixtures";

import type { PresentedHostKey } from "@psilink/core";
import type { RelayEvent } from "@jobs/cliDriver";

// A warning the CLI composes is a whole composition, not one value, and every
// boundary between fd 3 and a console seat re-escapes it: the relay's
// trust-boundary pass, and the seat's own display pass. Either one taken at the
// per-value default cuts the cross-party host-key divergence notice off before
// its re-pin instruction and its out-of-band confirmation step -- at exactly the
// moment the operator is being told the two parties observed different host
// keys. One leg drives the real notice, with every fragment flooded, from the
// child process's fd 3 to the string a seat renders, and fails unless the
// delivered text still ends on the composition's own closing clause. The real
// notice measures well under the shared budget, so a second leg drives a message
// composed at the budget over the same chain: that one is what catches two
// budgets silently diverging, at either boundary, anywhere below the constant.

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

/** The composition's last words: what the operator must still be reading after
 * every boundary has had its pass. */
const CLOSING_CLAUSE = "re-pin it on both sides.";

/** The out-of-band step that precedes it, and the explanation ahead of that. */
const CONFIRM_STEP = "Confirm the server's current host key out-of-band";
const EXPLANATION = /interception/;

/**
 * The divergence notice exactly as the CLI puts it on fd 3: composed by core
 * with all four interpolated fragments flooded -- both parties' key types and
 * both fingerprints -- then redacted and escaped under the shared warning
 * budget, which is what `buildWarningEvent` does to it. The two sides differ, so
 * the reconciliation still finds a divergence to warn about.
 */
function cliWarningMessage(): string {
  const local: PresentedHostKey = {
    fingerprint: "‭".repeat(100),
    keyType: "‭".repeat(64),
  };
  const partner: PresentedHostKey = {
    fingerprint: "‮".repeat(100),
    keyType: "‮".repeat(64),
  };
  const composed = reconcileHostKeyFingerprints(local, partner);
  expect(composed).toBeDefined();
  return redactAndSanitizeForDisplay(composed!, {
    maxLength: WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
  });
}

/** The clause the synthetic warning below ends on, sitting at the far end of the
 * shared budget where any boundary that re-caps under it cuts the clause away. */
const SYNTHETIC_TAIL = " the clause no boundary below the budget can keep.";

/**
 * A first-party warning composed to exactly the shared budget, in printable
 * ASCII so every pass escapes it to itself and its delivered length is its
 * composed length.
 *
 * The real divergence notice measures well under the budget, so driving it holds
 * only that both boundaries clear THAT notice: either one re-capped anywhere
 * between the notice's length and the budget still delivers it whole. This
 * message is what ties the two boundaries to the constant itself -- it survives
 * only while the relay and the seat both cap at or above
 * {@link WARNING_MESSAGE_MAX_DISPLAY_LENGTH}.
 */
function warningComposedAtBudget(): string {
  const head =
    "a first-party warning composed to the whole warning budget, then padded: ";
  const padding = "x".repeat(
    WARNING_MESSAGE_MAX_DISPLAY_LENGTH - head.length - SYNTHETIC_TAIL.length,
  );
  return `${head}${padding}${SYNTHETIC_TAIL}`;
}

/**
 * The events the relay delivered for a child that wrote `message` as a warning
 * line on fd 3 -- the real child process, line reader, and schema validation.
 */
async function relayWarningFromChild(
  message: string,
): Promise<Array<RelayEvent>> {
  const workdir = scratchDir("relay-warning");
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
          { v: 1, type: "warning", message },
          { v: 1, type: "result", resultWritten: true },
        ]),
        STUB_EXIT_CODE: "0",
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
 * The messages a seat's `onWarning` slot receives for a relayed event sequence,
 * carried over the real SSE frame encoder and the real browser-side job API
 * client. The status request a terminal `result` triggers answers 404, so the
 * run resolves without a record pair rather than hanging on a metadata fetch.
 */
async function warningsAtSeat(
  events: Array<RelayEvent>,
): Promise<Array<string>> {
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

  const delivered: Array<string> = [];
  const driver = createServerJobReattachDriver(
    "job-1",
    createFetchJobApiClient(fetchImpl),
  );
  await driver.run({
    signal: new AbortController().signal,
    onStages: () => undefined,
    onStage: () => undefined,
    onResult: () => undefined,
    onError: () => undefined,
    onWarning: (message) => delivered.push(message),
  });
  return delivered;
}

test("a relayed CLI warning reaches a console seat ending on its own clause", async () => {
  const message = cliWarningMessage();
  // The case is only worth driving if it is past the cap each boundary would
  // otherwise apply: a notice that fits the per-value default proves nothing.
  expect(message.length).toBeGreaterThan(DEFAULT_MAX_DISPLAY_LENGTH);
  expect(message.endsWith(CLOSING_CLAUSE)).toBe(true);

  const relayed = await relayWarningFromChild(message);
  const warnings = relayed.filter((event) => event.type === "warning");
  expect(warnings).toHaveLength(1);
  expect((warnings[0].message as string).endsWith(CLOSING_CLAUSE)).toBe(true);

  const delivered = await warningsAtSeat(relayed);
  expect(delivered).toHaveLength(1);

  const [rendered] = appendSanitizedRunWarning([], delivered[0]);
  // The composition runs to its own last words. Each fragment still truncates at
  // its own cap -- that bound is untouched, and its marker sits inside the
  // message -- so what is asserted is that the composition's tail, not a
  // fragment's, is what a seat ends on.
  expect(rendered.endsWith(CLOSING_CLAUSE)).toBe(true);
  expect(rendered.endsWith(DISPLAY_TRUNCATION_MARKER)).toBe(false);
  expect(rendered).toContain(CONFIRM_STEP);
  expect(rendered).toMatch(EXPLANATION);
  expect(rendered.length).toBeGreaterThan(
    DEFAULT_MAX_DISPLAY_LENGTH + DISPLAY_TRUNCATION_MARKER.length,
  );
});

test("a warning composed at the shared budget reaches a seat uncut", async () => {
  const message = warningComposedAtBudget();
  expect(message.length).toBe(WARNING_MESSAGE_MAX_DISPLAY_LENGTH);

  const relayed = await relayWarningFromChild(message);
  const warnings = relayed.filter((event) => event.type === "warning");
  expect(warnings).toHaveLength(1);
  expect(warnings[0].message).toBe(message);

  const delivered = await warningsAtSeat(relayed);
  expect(delivered).toHaveLength(1);

  const [rendered] = appendSanitizedRunWarning([], delivered[0]);
  expect(rendered).toBe(message);
  expect(rendered.length).toBe(WARNING_MESSAGE_MAX_DISPLAY_LENGTH);
  expect(rendered.endsWith(SYNTHETIC_TAIL)).toBe(true);
  expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
});
