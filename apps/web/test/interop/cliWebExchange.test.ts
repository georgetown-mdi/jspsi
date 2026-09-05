import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ConnectionError } from "@psilink/core";

import {
  acceptAsWebParty,
  inviteAsWebParty,
  runWebPartyExchange,
} from "./webParty";
import {
  cliIsBuilt,
  expectCliSucceeded,
  fillInFileDropConnection,
  invitationFrom,
  namesFileDrop,
  pairsFromResultCsv,
  startCli,
} from "./cliParty";

import type { WebHandshakeDriver, WebPartyOutcome } from "./webParty";
import type { CliRun } from "./cliParty";

/**
 * A CLI party and a web party completing one live exchange over a shared
 * file-drop directory -- the only transport a Node host can stand up without
 * a browser and a broker. This proves the two runtimes complete a handshake
 * and PSI rounds WITH each other (byte-parity fixtures only pin that their
 * outputs agree). The CLI party is the real `psilink` program; the web party
 * is assembled from the web app's own modules (apps/web/src).
 *
 * The harness supplies what apps/web has neither of and may not import from
 * the CLI: the file-sync client (./fileDropTransport) and an AEAD wrap
 * stand-in for `applyEncryption`, which a file-sync CLI party always
 * requests. The app's own driver refuses that wrap (WebRTC only, already
 * DTLS-confidential); the last test below pins the refusal, so the stand-in
 * cannot outlive the day apps/web applies the wrap itself.
 */

// Two rows in common, at different offsets on each side, so a party reading its
// own table back cannot pass by symmetry: the CLI's rows 0 and 1 are the web
// party's rows 1 and 2.
const CLI_CSV =
  "ssn,first_name,last_name,date_of_birth\n" +
  "111223333,bob,smith,1990-01-01\n" +
  "222334444,carol,jones,1985-11-30\n" +
  "333445555,dave,lee,1979-04-02\n";

const WEB_CSV =
  "ssn,first_name,last_name,date_of_birth\n" +
  "444556666,erin,park,1970-07-07\n" +
  "111223333,bob,smith,1990-01-01\n" +
  "222334444,carol,jones,1985-11-30\n";

const CLI_IDENTITY = "Agency A, a@agency-a.example";
const WEB_IDENTITY = "Agency B, b@agency-b.example";

// The pairs each side must resolve: [own row, partner row].
const CLI_PAIRS: Array<[number, number]> = [
  [0, 1],
  [1, 2],
];
const WEB_PAIRS: Array<[number, number]> = [
  [1, 0],
  [2, 1],
];

// A local directory answers in microseconds, so the poll interval is set to
// what keeps the rounds moving rather than to a production cadence.
const POLL_INTERVAL_MS = 20;

// The peer budget for the arms that COMPLETE: it bounds the gaps between a live
// partner's messages, so it is the deadline for a partner that stopped, never
// the test's runtime.
const COMPLETING_PEER_TIMEOUT_MS = 60_000;

// The peer budget for the arm where one party FAILS mid-run and the other is
// left waiting for it. That wait IS this arm's runtime, and the web party has no
// abort marker to cut it short (the CLI's cross-party fast-fail is a file-sync
// mechanism the app has no counterpart for), so it is sized against what the arm
// needs -- a rendezvous and a key exchange over local files -- rather than
// against a production wait.
const REFUSAL_PEER_TIMEOUT_MS = 10_000;

// A hard deadline on each `psilink` invocation, comfortably past every peer
// budget above so a run that hangs is reported as a hang rather than absorbed
// into a budget's expiry.
const CLI_DEADLINE_MS = 150_000;

interface Workspace {
  root: string;
  dropDir: string;
  cliDir: string;
  cliInput: string;
  cliOutput: string;
  cliConfig: string;
  webInput: string;
}

function makeWorkspace(): Workspace {
  const root = mkdtempSync(path.join(tmpdir(), "psilink-cli-web-interop-"));
  const dropDir = path.join(root, "drop");
  const cliDir = path.join(root, "cli");
  const webDir = path.join(root, "web");
  for (const dir of [dropDir, cliDir, webDir]) mkdirSync(dir);
  const cliInput = path.join(cliDir, "input.csv");
  const webInput = path.join(webDir, "input.csv");
  writeFileSync(cliInput, CLI_CSV);
  writeFileSync(webInput, WEB_CSV);
  return {
    root,
    dropDir,
    cliDir,
    cliInput,
    cliOutput: path.join(cliDir, "out.csv"),
    cliConfig: path.join(cliDir, "psilink.yaml"),
    webInput,
  };
}

/** Run both parties at once and settle both, so a party that fails while the
 * other is still running is reported rather than raised as an unhandled
 * rejection. */
async function runBothParties(params: {
  workspace: Workspace;
  driver: WebHandshakeDriver;
  webSetup: Awaited<ReturnType<typeof acceptAsWebParty>>;
  peerTimeoutMs: number;
}): Promise<{
  cli: PromiseSettledResult<CliRun>;
  web: PromiseSettledResult<WebPartyOutcome>;
}> {
  const { workspace, driver, webSetup, peerTimeoutMs } = params;
  const cli = startCli({
    args: ["exchange", workspace.cliInput, workspace.cliOutput],
    cwd: workspace.cliDir,
    timeoutMs: CLI_DEADLINE_MS,
  });
  const web = runWebPartyExchange({
    dropDir: workspace.dropDir,
    setup: webSetup,
    driver,
    pollIntervalMs: POLL_INTERVAL_MS,
    peerTimeoutMs,
  });
  const [cliResult, webResult] = await Promise.allSettled([cli, web]);
  return { cli: cliResult, web: webResult };
}

let workspace: Workspace;

beforeEach(() => {
  workspace = makeWorkspace();
});

afterEach(() => {
  rmSync(workspace.root, { recursive: true, force: true });
});

describe.skipIf(!cliIsBuilt)(
  "a CLI party and a web party complete one live exchange",
  () => {
    test("the CLI invites and the web app's acceptor assembly accepts", async () => {
      const invite = await startCli({
        args: ["invite", "--identity", CLI_IDENTITY, workspace.cliInput],
        cwd: workspace.cliDir,
        timeoutMs: CLI_DEADLINE_MS,
      });
      expectCliSucceeded(invite, "invite");
      const token = invitationFrom(invite);

      // An offline invite embeds no endpoint, so its configuration names none
      // and psilink says so; supplying the shared directory is the operator step
      // it asks for.
      expect(namesFileDrop(workspace.cliConfig, workspace.dropDir)).toBe(false);
      fillInFileDropConnection({
        configPath: workspace.cliConfig,
        dropDir: workspace.dropDir,
        pollIntervalMs: POLL_INTERVAL_MS,
        peerTimeoutMs: COMPLETING_PEER_TIMEOUT_MS,
      });

      const webSetup = await acceptAsWebParty({
        token,
        identity: WEB_IDENTITY,
        inputCsvPath: workspace.webInput,
      });
      const { cli, web } = await runBothParties({
        workspace,
        driver: "aead-stand-in",
        webSetup,
        peerTimeoutMs: COMPLETING_PEER_TIMEOUT_MS,
      });

      expectBothPartiesLinked({ cli, web });
    });

    test("the web app mints the invitation and the real CLI accepts it", async () => {
      const minted = await inviteAsWebParty({
        identity: WEB_IDENTITY,
        inputCsvPath: workspace.webInput,
        dropDir: workspace.dropDir,
      });

      const accept = await startCli({
        args: [
          "accept",
          "--identity",
          CLI_IDENTITY,
          "--consent-to-terms",
          minted.encoded,
          workspace.cliInput,
        ],
        cwd: workspace.cliDir,
        timeoutMs: CLI_DEADLINE_MS,
      });
      expectCliSucceeded(accept, "accept");

      // The endpoint the web app minted onto the token is what the CLI's own
      // accept wrote into its configuration: no operator fill-in here, unlike
      // the endpoint-less offline invite above.
      expect(namesFileDrop(workspace.cliConfig, workspace.dropDir)).toBe(true);
      fillInFileDropConnection({
        configPath: workspace.cliConfig,
        dropDir: workspace.dropDir,
        pollIntervalMs: POLL_INTERVAL_MS,
        peerTimeoutMs: COMPLETING_PEER_TIMEOUT_MS,
      });

      const { cli, web } = await runBothParties({
        workspace,
        driver: "aead-stand-in",
        webSetup: minted,
        peerTimeoutMs: COMPLETING_PEER_TIMEOUT_MS,
      });

      expectBothPartiesLinked({ cli, web });
    });

    test("the web app's own handshake driver refuses the AEAD a file-sync CLI party asks for", async () => {
      const invite = await startCli({
        args: ["invite", "--identity", CLI_IDENTITY, workspace.cliInput],
        cwd: workspace.cliDir,
        timeoutMs: CLI_DEADLINE_MS,
      });
      expectCliSucceeded(invite, "invite");
      fillInFileDropConnection({
        configPath: workspace.cliConfig,
        dropDir: workspace.dropDir,
        pollIntervalMs: POLL_INTERVAL_MS,
        peerTimeoutMs: REFUSAL_PEER_TIMEOUT_MS,
      });

      const webSetup = await acceptAsWebParty({
        token: invitationFrom(invite),
        identity: WEB_IDENTITY,
        inputCsvPath: workspace.webInput,
      });
      const { cli, web } = await runBothParties({
        workspace,
        driver: "app",
        webSetup,
        peerTimeoutMs: REFUSAL_PEER_TIMEOUT_MS,
      });

      // The handshake itself succeeds -- both parties derive the same session
      // key -- and the run stops on what it negotiated: a capability the web
      // path does not apply, reported as a local `usage` fault rather than a
      // failed authentication. Nothing reaches the PSI rounds, on either side.
      if (web.status !== "rejected")
        throw new Error("the web party completed an exchange it must refuse");
      expect(web.reason).toBeInstanceOf(ConnectionError);
      expect((web.reason as ConnectionError).kind).toBe("usage");
      expect((web.reason as ConnectionError).message).toContain(
        "application-layer encryption",
      );

      // The CLI party exits on its own peer budget rather than being killed on
      // the harness deadline, so this arm measures a real failure rather than a
      // hang the assertion above would pass over.
      if (cli.status !== "fulfilled") throw cli.reason;
      expect(cli.value.timedOut).toBe(false);
      expect(cli.value.exitCode).toBeGreaterThan(0);
      expect(existsSync(workspace.cliOutput)).toBe(false);
    });
  },
);

/** Both parties finished, the web party naming the CLI's declared identity off
 * the agreed terms, and each resolved the same intersection from its own side --
 * at the offsets its own file holds, which differ between the two. */
function expectBothPartiesLinked(settled: {
  cli: PromiseSettledResult<CliRun>;
  web: PromiseSettledResult<WebPartyOutcome>;
}): void {
  if (settled.web.status === "rejected") throw settled.web.reason;
  if (settled.cli.status === "rejected") throw settled.cli.reason;
  expectCliSucceeded(settled.cli.value, "exchange");

  const web = settled.web.value;
  expect(web.partnerIdentity).toBe(CLI_IDENTITY);
  expect(web.pairs).toEqual(WEB_PAIRS);
  expect(pairsFromResultCsv(workspace.cliOutput)).toEqual(CLI_PAIRS);
}
