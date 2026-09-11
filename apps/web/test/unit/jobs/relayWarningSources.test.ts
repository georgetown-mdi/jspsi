import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  RELAY_WARNING_SOURCES,
  attachFd3Reader,
  spawnExchangeJob,
} from "@jobs/cliDriver";
import { JobManager } from "@jobs/jobManager";

import {
  STUB_CLI_PATH,
  awaitJobTerminalState,
  tempDataRoot,
  validIntent,
} from "../../utils/jobFixtures";

import type {
  CliDriverHandlers,
  RelayEvent,
  RelayWarningSource,
} from "@jobs/cliDriver";
import type { ChildProcess } from "node:child_process";
import type { JobRecord } from "@jobs/jobManager";

// A supervisor reading one job stream switches on `source`, so each notice the
// relay composes itself reaches the stream under its own value. Every emission
// site is pinned below and the sites are compared against the declared set, so a
// new degradation cannot inherit another site's value by being added without one
// of its own.

const dirs: Array<string> = [];
const managers: Array<JobManager> = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

/** A created scratch directory, removed after the test. */
function scratchDir(label: string): string {
  const dir = tempDataRoot(label);
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

/** The value and text of one degradation notice the driver raised. */
interface Degradation {
  source: RelayWarningSource;
  message: string;
}

/** Resolve once the fd-3 reader has had a turn to deliver what was written. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/**
 * Drive the stub CLI through the real driver and return what it degraded on.
 * `workdir` defaults to a real scratch directory; the spawn-failure case passes
 * one that does not exist.
 */
async function degradationsFromChild(options: {
  env?: NodeJS.ProcessEnv;
  workdir?: string;
}): Promise<Array<Degradation>> {
  const workdir = options.workdir ?? scratchDir("relay-source");
  const degradations: Array<Degradation> = [];
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
      extraEnv: { STUB_EXIT_CODE: "0", ...options.env },
      handlers: {
        onEvent: () => undefined,
        onDegraded: (source, message) => degradations.push({ source, message }),
        onTerminal,
      },
    }),
  );
  return degradations;
}

/** Handlers that collect degradations, with the other two slots inert. */
function collectingHandlers(into: Array<Degradation>): CliDriverHandlers {
  return {
    onEvent: () => undefined,
    onDegraded: (source, message) => into.push({ source, message }),
    onTerminal: () => undefined,
  };
}

/**
 * The degradations the fd-3 reader raises for a child whose fd 3 is `stream`,
 * after `write` has run against it. The stream-level faults (an fd 3 that was
 * never wired, a read error, a flood past the buffer cap) are staged here
 * because a spawned child cannot present them.
 */
async function degradationsFromStream(
  stream: PassThrough | null,
  write: (stream: PassThrough) => void = () => undefined,
): Promise<Array<Degradation>> {
  const degradations: Array<Degradation> = [];
  const child = {
    stdio: [null, null, null, stream],
  } as unknown as ChildProcess;
  attachFd3Reader(child, collectingHandlers(degradations));
  if (stream !== null) write(stream);
  await settle();
  return degradations;
}

/** The buffer cap the fd-3 reader discards an unterminated line past. */
const FD3_LINE_CAP = 1_048_576;

/** The value the filedrop rendezvous preflight's notices are stamped with. */
const PREFLIGHT_SOURCE: RelayWarningSource = "relayRendezvousPreflight";

/** One degradation site, the fault that reaches it, and the value it claims. */
const DEGRADATION_SITES: Array<{
  site: string;
  source: RelayWarningSource;
  degrade: () => Promise<Array<Degradation>>;
}> = [
  {
    site: "an fd-3 line that is not JSON",
    source: "relayUnparsableEvent",
    degrade: () =>
      degradationsFromChild({ env: { STUB_FD3_RAW: "this is not json\n" } }),
  },
  {
    site: "an fd-3 event outside the v1 vocabulary",
    source: "relayUnknownEvent",
    degrade: () =>
      degradationsFromChild({
        env: { STUB_FD3_EVENTS: JSON.stringify([{ v: 1, type: "invented" }]) },
      }),
  },
  {
    site: "a child that could not be spawned",
    source: "relayProcessError",
    degrade: () =>
      degradationsFromChild({
        workdir: path.join(tempDataRoot("relay-source-absent"), "nowhere"),
      }),
  },
  {
    site: "an fd 3 that was never wired",
    source: "relayStreamUnavailable",
    degrade: () => degradationsFromStream(null),
  },
  {
    site: "a read error on fd 3",
    source: "relayStreamReadError",
    degrade: () =>
      degradationsFromStream(new PassThrough(), (stream) => {
        stream.emit("error", new Error("read failed"));
      }),
  },
  {
    site: "an fd-3 line past the reader's buffer cap",
    source: "relayStreamOversizedLine",
    degrade: () =>
      // No newline anywhere in it, so the reader holds the whole flood in its
      // buffer rather than parsing any of it as a line.
      degradationsFromStream(new PassThrough(), (stream) => {
        stream.write("x".repeat(FD3_LINE_CAP + 1));
      }),
  },
];

describe("the relay stamps its own source on each degradation", () => {
  test.each(DEGRADATION_SITES)(
    "$site is reported as $source",
    async ({ source, degrade }) => {
      const degradations = await degrade();
      expect(degradations.map((entry) => entry.source)).toEqual([source]);
    },
  );

  test("every declared source has a site pinned above", () => {
    const pinned = [...DEGRADATION_SITES.map((entry) => entry.source)];
    expect([...pinned, PREFLIGHT_SOURCE].sort()).toEqual(
      [...RELAY_WARNING_SOURCES].sort(),
    );
  });
});

describe("the stamped source reaches the job's event stream", () => {
  /** A manager on a stub CLI that writes one malformed fd-3 line, then exits. */
  function makeManager(rendezvousDir: string): JobManager {
    const manager = new JobManager({
      dataRoot: scratchDir("relay-source-root"),
      binaryPath: STUB_CLI_PATH,
      jobRendezvousDir: rendezvousDir,
      childEnv: {
        STUB_EXIT_CODE: "0",
        STUB_FD3_RAW: "this is not json\n",
        STUB_FD3_EVENTS: JSON.stringify([
          { v: 1, type: "result", resultWritten: true },
        ]),
      },
    });
    managers.push(manager);
    return manager;
  }

  /** The warning events a finished job buffered, in order. */
  async function warningsOf(record: JobRecord): Promise<Array<RelayEvent>> {
    const deadline = Date.now() + 5000;
    while (!record.terminalEmitted) {
      if (Date.now() > deadline)
        throw new Error("timed out waiting for terminal");
      await settle();
    }
    return record.events
      .map((entry) => entry.event)
      .filter((event) => event.type === "warning");
  }

  test("a degradation rides the buffered warning beside its degraded mark", async () => {
    const manager = makeManager(scratchDir("relay-source-rvz"));
    const id = await manager.createJob(validIntent());
    const warnings = await warningsOf(manager.getJob(id)!);
    expect(warnings).toEqual([
      expect.objectContaining({
        type: "warning",
        source: "relayUnparsableEvent",
        degraded: true,
      }),
    ]);
  });

  test("a rendezvous preflight notice names the preflight and is not degraded", async () => {
    // A mount that does not exist raises the preflight's own notice; the job
    // still runs, so the degradation above follows it onto the same stream.
    const manager = makeManager(
      path.join(scratchDir("relay-source-rvz"), "no"),
    );
    const id = await manager.createJob(validIntent());
    const warnings = await warningsOf(manager.getJob(id)!);
    expect(warnings[0]).toEqual(
      expect.objectContaining({ type: "warning", source: PREFLIGHT_SOURCE }),
    );
    expect(warnings[0].degraded).toBeUndefined();
    expect(warnings.map((event) => event.source)).toContain(
      "relayUnparsableEvent",
    );
  });

  test("a CLI warning keeps the source the child put on fd 3", async () => {
    const manager = new JobManager({
      dataRoot: scratchDir("relay-source-root"),
      binaryPath: STUB_CLI_PATH,
      jobRendezvousDir: scratchDir("relay-source-rvz"),
      childEnv: {
        STUB_EXIT_CODE: "0",
        STUB_FD3_EVENTS: JSON.stringify([
          {
            v: 1,
            type: "warning",
            source: "hostKeyDivergence",
            message: "the partner reported a different host key",
          },
          { v: 1, type: "result", resultWritten: true },
        ]),
      },
    });
    managers.push(manager);
    const id = await manager.createJob(validIntent());
    const warnings = await warningsOf(manager.getJob(id)!);
    expect(warnings).toEqual([
      expect.objectContaining({
        type: "warning",
        source: "hostKeyDivergence",
      }),
    ]);
    expect(warnings[0].degraded).toBeUndefined();
  });
});
