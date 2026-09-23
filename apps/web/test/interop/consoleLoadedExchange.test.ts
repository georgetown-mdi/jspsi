import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  parseExchangeSpec,
  parseSensitiveJson,
  parseSensitiveYaml,
} from "@psilink/core";

import { JobManager } from "@jobs/jobManager";
import { authoringStateFromDocument } from "@console/loadedConfig";
import { connectionTuningOptions } from "@console/connectionTuningModel";
import { openMountedConfiguration } from "@jobs/configLoad";

import {
  cliEntry,
  cliIsBuilt,
  expectCliSucceeded,
  fillInFileDropConnection,
  invitationFrom,
  pairsFromResultCsv,
  startCli,
} from "./cliParty";

import type { JobFiledropExchangeIntent } from "@jobs/intentSchemas";

/**
 * The whole of "use the GUI for the settings and the CLI for the work", driven
 * end to end: `psilink` writes a file-drop configuration, the console opens it
 * off its mounted folder, runs the exchange it states against a real `psilink`
 * partner, and hands back the configuration a scheduled command-line run loads.
 *
 * Both parties here are the real program -- the partner spawned directly, this
 * side spawned by the console's own job manager over the configuration it
 * composed -- so what the test settles is that a console run of an OPENED
 * configuration links, on the terms the file states. The linkage terms are
 * passed through untouched: the invitation the partner minted is what both
 * sides run under, and the console changes nothing about it.
 */

// Two rows in common at different offsets on each side, so a party reading its
// own table back cannot pass by symmetry.
const PARTNER_CSV =
  "ssn,first_name,last_name,date_of_birth\n" +
  "111223333,bob,smith,1990-01-01\n" +
  "222334444,carol,jones,1985-11-30\n" +
  "333445555,dave,lee,1979-04-02\n";

const CONSOLE_CSV =
  "ssn,first_name,last_name,date_of_birth\n" +
  "444556666,erin,park,1970-07-07\n" +
  "111223333,bob,smith,1990-01-01\n" +
  "222334444,carol,jones,1985-11-30\n";

const PARTNER_IDENTITY = "Agency A, a@agency-a.example";
const CONSOLE_IDENTITY = "Agency B, b@agency-b.example";

/** The pairs each side must resolve: [own row, partner row]. */
const PARTNER_PAIRS: Array<[number, number]> = [
  [0, 1],
  [1, 2],
];
const CONSOLE_PAIRS: Array<[number, number]> = [
  [1, 0],
  [2, 1],
];

// A local directory answers in microseconds, so the poll interval is what keeps
// the rounds moving rather than a production cadence.
const POLL_INTERVAL_MS = 20;

// The peer budget: it bounds the gaps between a live partner's messages, so it
// is the deadline for a partner that stopped, never the test's runtime.
const PEER_TIMEOUT_MS = 60_000;

// A hard deadline on each `psilink` invocation, past the peer budget so a run
// that hangs is reported as a hang rather than absorbed into a budget's expiry.
const CLI_DEADLINE_MS = 150_000;

/** How long the console's job may take to reach its terminal event. */
const JOB_DEADLINE_MS = 150_000;

interface Workspace {
  root: string;
  dropDir: string;
  partnerDir: string;
  partnerOutput: string;
  partnerConfig: string;
  /** The console's single mounted working folder: the configuration, the key
   * file beside it, and the input CSV. */
  mount: string;
  mountedConfig: string;
}

function makeWorkspace(): Workspace {
  const root = mkdtempSync(path.join(tmpdir(), "psilink-console-loaded-"));
  const dropDir = path.join(root, "drop");
  const partnerDir = path.join(root, "partner");
  const mount = path.join(root, "mount");
  for (const dir of [dropDir, partnerDir, mount]) mkdirSync(dir);
  writeFileSync(path.join(partnerDir, "input.csv"), PARTNER_CSV);
  writeFileSync(path.join(mount, "input.csv"), CONSOLE_CSV);
  return {
    root,
    dropDir,
    partnerDir,
    partnerOutput: path.join(partnerDir, "out.csv"),
    partnerConfig: path.join(partnerDir, "psilink.yaml"),
    mount,
    mountedConfig: path.join(mount, "psilink.yaml"),
  };
}

let workspace: Workspace;
const managers: Array<JobManager> = [];

beforeEach(() => {
  workspace = makeWorkspace();
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
  rmSync(workspace.root, { recursive: true, force: true });
});

/** The shared secret the key file beside the mounted configuration holds,
 * which is what the console's run holds the exchange to. */
function mountedSharedSecret(mount: string): string {
  const parsed = parseSensitiveJson(
    readFileSync(path.join(mount, ".psilink.key"), "utf8"),
    "mounted key file",
  );
  const { sharedSecret } = parsed as { sharedSecret?: unknown };
  if (typeof sharedSecret !== "string")
    throw new Error("the mounted key file states no shared secret");
  return sharedSecret;
}

/**
 * The exchange the console runs for the configuration it opened: the settings
 * the document states, through the manager's own open and the console's own
 * mapping. The linkage terms, metadata, and standardization are the file's,
 * unedited, and the intent reports the configuration as opened and states no
 * secret, which has the run use the key file beside it and its hand-off merge
 * the opened document.
 */
function intentFromOpen(manager: JobManager): JobFiledropExchangeIntent {
  const response = manager.openMountedConfiguration();
  if (response.document === undefined)
    throw new Error("the mount holds no configuration to open");
  const loaded = authoringStateFromDocument(response.document);
  if (loaded.channel !== "filedrop")
    throw new Error(`the mounted configuration runs over ${loaded.channel}`);
  const options = connectionTuningOptions(loaded.connectionTuning);
  return {
    channel: "filedrop",
    side: "acceptor",
    linkageTerms: loaded.linkageTerms,
    inputFile: { name: "input.csv" },
    mountedConfigurationOpened: true,
    ...(loaded.metadata !== undefined ? { metadata: loaded.metadata } : {}),
    ...(loaded.standardization !== undefined
      ? { standardization: loaded.standardization }
      : {}),
    ...loaded.records,
    ...(options !== undefined ? { options } : {}),
  };
}

/** The configuration the mount holds, as the export's merge base reads it. */
function mountedDocumentOf(mount: string) {
  const document = openMountedConfiguration(mount).opened?.document;
  if (document === undefined)
    throw new Error("the mount holds no configuration to open");
  return document;
}

/** Resolve once the console's child has exited, or fail on the deadline. The
 * wait is on the terminal STATE rather than on the terminal event: the event is
 * the run's own last word, and the exit that follows it is what says the child
 * is done with the folder this test reads next. */
async function waitForTerminal(manager: JobManager, id: string): Promise<void> {
  const deadline = Date.now() + JOB_DEADLINE_MS;
  for (;;) {
    const record = manager.getJob(id);
    if (record === undefined) throw new Error("the job left the slot");
    if (record.terminal !== null) {
      if (record.terminal.outcome !== "succeeded")
        throw new Error(
          `the console run ended ${record.terminal.outcome}: ` +
            JSON.stringify(record.events.slice(-3)),
        );
      return;
    }
    if (Date.now() > deadline)
      throw new Error("the console run reached no terminal event");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe.skipIf(!cliIsBuilt)(
  "a configuration psilink wrote, opened in the console and run",
  () => {
    test("the console links against a real psilink partner on the file's terms", async () => {
      const invite = await startCli({
        args: ["invite", "--identity", PARTNER_IDENTITY, "input.csv"],
        cwd: workspace.partnerDir,
        timeoutMs: CLI_DEADLINE_MS,
      });
      expectCliSucceeded(invite, "invite");
      fillInFileDropConnection({
        configPath: workspace.partnerConfig,
        dropDir: workspace.dropDir,
        pollIntervalMs: POLL_INTERVAL_MS,
        peerTimeoutMs: PEER_TIMEOUT_MS,
      });

      // The console's mount is what an operator has after accepting the
      // invitation on the command line: a psilink.yaml, the key file beside it,
      // and their own input. The connection block is theirs to fill in, which an
      // offline invitation asks for.
      const accept = await startCli({
        args: [
          "accept",
          "--identity",
          CONSOLE_IDENTITY,
          "--consent-to-terms",
          invitationFrom(invite),
          "input.csv",
        ],
        cwd: workspace.mount,
        timeoutMs: CLI_DEADLINE_MS,
      });
      expectCliSucceeded(accept, "accept");
      fillInFileDropConnection({
        configPath: workspace.mountedConfig,
        dropDir: "/not-the-folder-the-console-runs-over",
        pollIntervalMs: POLL_INTERVAL_MS,
        peerTimeoutMs: PEER_TIMEOUT_MS,
      });

      const manager = new JobManager({
        dataRoot: workspace.mount,
        binaryPath: cliEntry,
        jobInputDir: workspace.mount,
        jobRendezvousDir: workspace.dropDir,
      });
      managers.push(manager);

      const secretBeforeRun = mountedSharedSecret(workspace.mount);
      const id = await manager.createJob(intentFromOpen(manager));
      const partner = startCli({
        args: ["exchange", "input.csv", "out.csv"],
        cwd: workspace.partnerDir,
        timeoutMs: CLI_DEADLINE_MS,
      });

      await waitForTerminal(manager, id);
      expectCliSucceeded(await partner, "exchange");

      const record = manager.getJob(id);
      if (record === undefined) throw new Error("the job left the slot");
      expect(pairsFromResultCsv(record.outputPath)).toEqual(CONSOLE_PAIRS);
      expect(pairsFromResultCsv(workspace.partnerOutput)).toEqual(
        PARTNER_PAIRS,
      );

      // The run continued the exchange under the key file beside the
      // configuration and left its rotated secret there, as a command-line run
      // does; it wrote no key file of its own.
      expect(mountedSharedSecret(workspace.mount)).not.toBe(secretBeforeRun);
      expect(
        mountedSharedSecret(workspace.mount) ===
          mountedSharedSecret(workspace.partnerDir),
      ).toBe(true);
      expect(existsSync(path.join(record.workdir, ".psilink.key"))).toBe(false);

      // The hand-off the same run composed is the configuration the operator
      // takes to cron: the terms the file stated, and the rendezvous folder as a
      // placeholder rather than the console's own mount.
      const handoff = manager.getJobHandoff(id);
      if (handoff?.template.kind !== "config")
        throw new Error("the run composed no configuration template");
      const exported = parseExchangeSpec(
        parseSensitiveYaml(handoff.template.yaml, "exported configuration"),
      );
      expect(exported.linkageTerms).toEqual(
        mountedDocumentOf(workspace.mount).linkageTerms,
      );
      expect(handoff.template.yaml).not.toContain(workspace.dropDir);
    });
  },
);
