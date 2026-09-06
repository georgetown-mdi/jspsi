import fs from "node:fs";
import path from "node:path";

import { fileURLToPath } from "node:url";

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

// The retained stderr tail is a rolling WINDOW, so a clip taken before
// redaction hands the operator a key body with neither marker on it: the
// BEGIN evicted as the body scrolled past, the END never written. The
// redactor sits in front of the window instead, so what these runs measure is
// the window's content for a key the window itself could never have held.

const roots: Array<string> = [];
const managers: Array<JobManager> = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

const REDACTION = "[redacted private key]";
const BEGIN = "-----BEGIN OPENSSH PRIVATE KEY-----";
const END = "-----END OPENSSH PRIVATE KEY-----";
const KEY_LINE = "MIIByteslookingsecret0123456789ABCDEFabcdef+/wEHEHE";

/** The exit code whose synthesized terminal names the retained tail. */
const PERSISTENCE_LOSS_EXIT = 73;

/** A key body wider than both the retention cap and one pipe delivery. */
function keyBody(lines: number): string {
  return Array.from(
    { length: lines },
    (_unused, line) => `${line}${KEY_LINE}`,
  ).join("\n");
}

/** The `caused by` link the manager composes from the child's retained tail. */
async function stderrLinkFromRun(stderr: string): Promise<string> {
  const manager = new JobManager({
    dataRoot: scratchDir("stderr-redaction"),
    binaryPath: STUB_CLI_PATH,
    jobRendezvousDir: scratchDir("stderr-redaction-rvz"),
    childEnv: {
      STUB_FD3_EVENTS: "[]",
      STUB_STDERR: stderr,
      STUB_EXIT_CODE: String(PERSISTENCE_LOSS_EXIT),
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
  const events: Array<RelayEvent> = record.events.map((entry) => entry.event);
  const chain = events[events.length - 1][
    ERROR_MESSAGE_CHAIN_FIELD
  ] as Array<string>;
  return chain[chain.length - 1];
}

/** A scratch directory registered for cleanup. */
function scratchDir(label: string): string {
  const dir = tempDataRoot(label);
  fs.mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

test("a key wider than the retained window reaches the tail as one replacement", async () => {
  // 120 KiB of body: wider than the 8 KiB retention cap AND wider than one
  // pipe delivery, so the window would have evicted the BEGIN marker long
  // before the child exited and nothing downstream could tell the body from
  // any other bytes.
  const body = keyBody(2300);
  expect(body.length).toBeGreaterThan(100000);
  const link = await stderrLinkFromRun(
    `dialing the partner\n${BEGIN}\n${body}\n${END}\nrun stopped`,
  );
  expect(link).toContain(REDACTION);
  expect(link).toContain("run stopped");
  expect(link).not.toContain(KEY_LINE);
  expect(link).not.toContain("PRIVATE KEY");
}, 30000);

test("a key straddling an eviction boundary leaves no body line behind", async () => {
  // The block opens outside the window and closes inside it, which is the cut
  // that hands the tail a body with neither marker on it: the BEGIN evicted
  // as the body scrolled past, the END the only marker left. What the window
  // holds instead is the replacement the stream already made.
  const opening = Array.from(
    { length: 550 },
    (_unused, line) => `step ${line} ran`,
  ).join("\n");
  expect(opening.length).toBeGreaterThan(4096);
  const link = await stderrLinkFromRun(
    `${opening}\n${BEGIN}\n${keyBody(600)}\n${END}\nrun stopped`,
  );
  expect(link).toContain(REDACTION);
  expect(link).toContain("run stopped");
  expect(link).not.toContain(KEY_LINE);
  expect(link).not.toContain("PRIVATE KEY");
}, 30000);

test("an END marker the child wrote alone deletes none of its diagnosis", async () => {
  // The reach is forward only, so a lone END is ordinary output: the vector a
  // backward-reaching rule would open is the child's own last line vanishing.
  const link = await stderrLinkFromRun(
    `could not read ${END} from the config\nrun stopped`,
  );
  expect(link).toContain(`could not read ${END} from the config`);
  expect(link).toContain("run stopped");
  expect(link).not.toContain(REDACTION);
}, 30000);

test("the child's stderr reaches a retained tail through no other reader", () => {
  // The redactor is complete only while `attachStderrTail` is the one place a
  // child's stderr is retained. The other spawn site drains and discards, so
  // the claim is checkable rather than stated: every reader of a child's
  // stderr in the server's job code is one of those two, and the retaining one
  // fills its window from what the redactor emitted.
  const jobsDir = fileURLToPath(new URL("../../../src/jobs/", import.meta.url));
  // `child.stdio[2]` is the same stream under another name, and the index
  // survives destructuring or an alias where the word `stderr` does not, so
  // the scan takes the indexing idiom the driver already uses for fd 3.
  const reads = /\bstderr[.?]|child\.stderr|\bstdio\s*\[/;
  const readers = new Map<string, Array<string>>();
  const code = new Map<string, Array<string>>();
  const entries = fs.readdirSync(jobsDir, { recursive: true }) as Array<string>;
  for (const entry of entries) {
    if (!entry.endsWith(".ts")) continue;
    const source = fs.readFileSync(path.join(jobsDir, entry), "utf8");
    const lines = source
      .split("\n")
      .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line));
    code.set(entry, lines);
    const reading = lines.filter((line) => reads.test(line));
    if (reading.length > 0) readers.set(entry, reading);
  }
  expect([...readers.keys()].sort()).toEqual([
    "capturedCliChild.ts",
    "cliDriver.ts",
  ]);

  // The discarding site resumes the stream and subscribes to nothing on it.
  for (const line of readers.get("capturedCliChild.ts")!)
    expect(line).toContain("resume()");

  // The retaining site reads two events, and the data one goes through the
  // redactor before anything reaches the window.
  const driver = fs.readFileSync(path.join(jobsDir, "cliDriver.ts"), "utf8");
  expect(
    [...driver.matchAll(/\bstderr\.on\("(\w+)"/g)].map((m) => m[1]),
  ).toEqual(["data", "end"]);
  expect(driver.match(/\btail = \(tail \+ /g)).toHaveLength(1);
  expect(driver).toContain("retain(redactor.push(chunk));");
  expect(driver).toContain("retain(redactor.close());");

  // The index reaches fd 2 without naming a stream the scan above can key on,
  // so every stdio mention in the tree is pinned to one of two shapes: the
  // spawn options, or the fd-3 event stream the driver parses.
  for (const [entry, lines] of code)
    for (const stdioLine of lines.filter((line) => /\bstdio\b/.test(line)))
      expect(`${entry}: ${stdioLine}`).toMatch(/stdio: \[|child\.stdio\[3\]/);
});
