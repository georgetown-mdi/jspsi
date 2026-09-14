import fs from "node:fs";

import { afterEach, expect, test } from "vitest";

import { ERROR_MESSAGE_CHAIN_FIELD } from "@psi/relayErrorChain";
import { JobManager } from "@jobs/jobManager";

import {
  STUB_CLI_PATH,
  tempDataRoot,
  validIntent,
} from "../../utils/jobFixtures";

import type { JobRecord } from "@jobs/jobManager";
import type { RelayEvent } from "@jobs/cliDriver";

// What the console's synthesized terminals owe an operator, held over the CLASS
// rather than over one message: whatever the child wrote, the console's own
// sentence arrives byte for byte, and the child's bytes arrive on a labelled
// link of their own.
//
// The class has one chooser, the child's stderr tail, and the type is what
// holds it to one link: the tail reaches the manager branded
// (`PartnerOriginText`), which no `+`, template or `join` accepts, so the one
// elimination is the only way it can be put in front of an operator. A chooser
// added to this class later without a link of its own fails the chain-shape
// assertion below rather than passing unnoticed.
//
// The plants are what a per-fragment redaction is measured against: a marker
// with no partner, a marker whose fail-closed reach is forward only, and a
// whole block. Each rides the tail, and none of them may cost the console's
// sentence a byte.

const roots: Array<string> = [];
const managers: Array<JobManager> = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

const BEGIN = "-----BEGIN OPENSSH PRIVATE KEY-----";
const END = "-----END OPENSSH PRIVATE KEY-----";
const KEY_LINE = "MIIByteslookingsecret0123456789ABCDEFabcdef+/wEHEHE";
const REDACTION = "[redacted private key]";
const STDERR_LABEL = "the CLI last wrote on stderr: ";

/** The child's first line, ahead of whatever the case plants behind it. */
const OPENING = "dialling the partner";

/** The child's last line: what a fail-closed reach forward takes with it. */
const CLOSING = "run stopped";

/** The two terminals the manager synthesizes for a run that emitted none. */
const MESSAGE_CLASSES: Array<{ name: string; exitCode: number }> = [
  // The exchange completed and a local write did not: the one class whose own
  // sentence is a do-not-repeat instruction, so a fragment that could close it
  // and read on as console copy is what the labelling exists to refuse.
  { name: "the persistence-loss terminal", exitCode: 73 },
  // Any other non-interrupt exit with nothing on fd 3.
  { name: "the stream-broke terminal", exitCode: 64 },
];

/**
 * What each case plants in the chooser's fragment, what the redaction does with
 * it, and whether the child's own last line survives.
 *
 * A dangling `BEGIN` is the one plant that costs the child its closing line:
 * the rule reaches forward to the end of the fragment holding it, which is the
 * fail-closed reach the console keeps. A lone `END` is ordinary output and is
 * replaced by nothing -- the reach is forward only, so a rule that took it
 * backwards would delete the child's own diagnosis on a marker it merely
 * mentioned.
 */
const PLANTS: Array<{
  name: string;
  body: string;
  redacted: boolean;
  keepsClosing: boolean;
}> = [
  {
    name: "a dangling BEGIN marker",
    body: BEGIN,
    redacted: true,
    keepsClosing: false,
  },
  { name: "a lone END marker", body: END, redacted: false, keepsClosing: true },
  {
    name: "a whole private-key block",
    body: `${BEGIN}\n${KEY_LINE}\n${KEY_LINE}\n${END}`,
    redacted: true,
    keepsClosing: true,
  },
];

/** A scratch directory registered for cleanup. */
function scratchDir(label: string): string {
  const dir = tempDataRoot(label);
  fs.mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

/** The terminal event the manager synthesized for a stub run writing `stderr`. */
async function terminalFromRun(
  stderr: string,
  exitCode: number,
): Promise<RelayEvent> {
  const manager = new JobManager({
    dataRoot: scratchDir("terminal-provenance"),
    binaryPath: STUB_CLI_PATH,
    jobRendezvousDir: scratchDir("terminal-provenance-rvz"),
    childEnv: {
      STUB_FD3_EVENTS: "[]",
      STUB_STDERR: stderr,
      STUB_EXIT_CODE: String(exitCode),
    },
  });
  managers.push(manager);
  const record: JobRecord = manager.getJob(
    await manager.createJob(validIntent()),
  )!;
  const deadline = Date.now() + 10000;
  while (!record.terminalEmitted) {
    if (Date.now() > deadline)
      throw new Error("timed out waiting for terminal");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return record.events[record.events.length - 1].event;
}

const chainOf = (event: RelayEvent): Array<string> =>
  event[ERROR_MESSAGE_CHAIN_FIELD] as Array<string>;

for (const messageClass of MESSAGE_CLASSES)
  for (const plant of PLANTS)
    test(`${messageClass.name} states itself whole over ${plant.name}`, async () => {
      // The same class over a tail with nothing planted in it. The console's
      // sentence is asserted against THIS rather than against a copy of the
      // string, so an edit to the sentence cannot leave a stale expectation
      // passing, and a plant that cost it a byte cannot pass at all.
      const benign = await terminalFromRun(
        `${OPENING}\n${CLOSING}`,
        messageClass.exitCode,
      );
      const planted = await terminalFromRun(
        `${OPENING}\n${plant.body}\n${CLOSING}`,
        messageClass.exitCode,
      );

      // The first-party sentence, byte for byte, whatever the child wrote.
      expect(planted.message).toBe(benign.message);

      // Exactly two links: the console's sentence, then the chooser's one
      // labelled link. The sentence is the chain's first link unchanged, which
      // is what keeps `message` usable for classification and dedup.
      const chain = chainOf(planted);
      expect(chain).toHaveLength(2);
      expect(chain[0]).toBe(planted.message);
      expect(chain[1].startsWith(STDERR_LABEL)).toBe(true);

      // No key material on any plant, and no marker left where a plant was
      // replaced.
      expect(chain[1]).not.toContain(KEY_LINE);
      expect(chain[1].includes(REDACTION)).toBe(plant.redacted);
      if (plant.redacted) expect(chain[1]).not.toContain("PRIVATE KEY");
      else expect(chain[1]).toContain(END);

      // The child's opening line survives every plant, and its closing one
      // survives every plant but the dangling marker the rule reaches forward
      // from.
      expect(chain[1]).toContain(OPENING);
      expect(chain[1].includes(CLOSING)).toBe(plant.keepsClosing);
    }, 30000);
