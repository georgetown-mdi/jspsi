import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "vitest";
import YAML from "yaml";

import { parseExchangeSpec } from "@psilink/core";
import { loopbackTlsCert } from "@psilink/testkit/loopbackTlsCert";
import {
  ALLOW_MISSING_PREREQUISITES_ENV,
  prerequisitesAreRequired,
} from "@psilink/testkit/prerequisiteGate";

import { describeCliRun, startCli } from "../../cliProcess";
import { loadKeyFile } from "../../../src/keyFile";
import { keysPathFor } from "../../../src/recordFile";
import { startBrokerProcess } from "../../signaling/brokerProcess";
import { startTlsBrokerFront } from "../../signaling/tlsBrokerFront";

import type { RunningCli } from "../../cliProcess";
import type { BrokerProcess } from "../../signaling/brokerProcess";
import type { TlsBrokerFront } from "../../signaling/tlsBrokerFront";

/**
 * The live one-command acceptance: an inviting CLI mints a webrtc invitation
 * and waits, while an accepting CLI runs the whole acceptance -- resolution,
 * the consent prompt, the dial, and the exchange -- in the single command an
 * operator types.
 *
 * Both parties are real child processes, so this exercises the wiring
 * between those steps; the unit suite and
 * `test/integration/onlineInviteAccept.test.ts` cover the steps on their own.
 * Only the acceptance is under test; the inviter is just its peer.
 */

/**
 * A webrtc invitation names a coordination server without a scheme, so the
 * acceptance needs a `wss://` broker (see `test/signaling/tlsBrokerFront.ts`)
 * and a throwaway certificate minted with `openssl`, which the environment
 * supplies rather than this repository.
 *
 * Where the environment must supply `openssl` (CI), its absence is a hard
 * failure rather than a skip. Elsewhere the leg skips and the report names
 * it; `ALLOW_MISSING_PREREQUISITES_ENV` opts out of the hard failure.
 */
if (loopbackTlsCert === null && prerequisitesAreRequired(process.env))
  throw new Error(
    "no loopback TLS certificate could be minted here, so the live " +
      "one-command webrtc acceptance would silently skip in an environment " +
      "that is supposed to supply one. Install `openssl`, or set " +
      `${ALLOW_MISSING_PREREQUISITES_ENV}=1 to skip the leg deliberately.`,
  );
const liveTest = test.skipIf(loopbackTlsCert === null);

/** The broker's own mount and the loopback address the parties dial it at. */
const BROKER_HOST = "127.0.0.1";

/**
 * Each party's budget for the whole run: the wait to meet the partner, plus
 * the exchange's own peer waits after. The inviter sets it with
 * `--accept-timeout` and the accepting party with `--peer-timeout`, which is
 * that party's lever on the same three waits. Generous against the measured
 * ~12s an ICE round takes here, and inside the per-process deadlines below,
 * so a stall reports as a peer timeout, not a killed process. Held in
 * milliseconds beside the flag spelling, since the configuration a run writes
 * is asserted against the same value.
 */
const PARTY_RUN_BUDGET_MS = 60_000;
const PARTY_RUN_BUDGET = `${PARTY_RUN_BUDGET_MS / 1000}s`;

/**
 * Hard deadline on each party: a run that outlives it is killed and reported
 * as killed, rather than left to vitest's worker timeout. Each leg below
 * bounds its own wait well inside it -- the acceptance through
 * `--peer-timeout`, the inviter through `--accept-timeout` -- so a party that
 * reaches this deadline is a failure of that bound, not of the deadline.
 */
const PARTY_DEADLINE_MS = 90_000;

/**
 * The accepting party's budget where the leg is about the wait itself: short
 * enough that a partner who never arrives is reported in seconds, long enough
 * that the acceptance's own startup cannot spend it before the rendezvous
 * begins. The expiry message quotes the seconds, so the spelling and the
 * milliseconds are derived from one value here.
 */
const NO_SHOW_PEER_TIMEOUT_MS = 10_000;
const NO_SHOW_PEER_TIMEOUT = `${NO_SHOW_PEER_TIMEOUT_MS / 1000}s`;

// The de-symmetrized inputs, so the result proves the PSI filtered on both
// sides rather than echoing every record: each side carries one non-matcher
// (the inviter's Dave, the acceptor's Zoe) and the two sit at different
// positions, so the association table is transpose-asymmetric and a swapped or
// mis-keyed partner index fails the assertion, not merely a dropped row.
// Intersection: Bob, Carol.
const INVITE_CSV =
  "first_name,last_name,date_of_birth\n" +
  "Bob,Jones,1990-01-02\n" +
  "Carol,Lee,1985-07-16\n" +
  "Dave,Kim,1978-11-30\n";
const ACCEPT_CSV =
  "first_name,last_name,date_of_birth\n" +
  "Zoe,Adams,2001-03-03\n" +
  "Bob,Jones,1990-01-02\n" +
  "Carol,Lee,1985-07-16\n";

let broker: BrokerProcess;
let front: TlsBrokerFront;
let suiteDir: string;
let certPath: string;
let work: string;
/** Every party started by a test, stopped after it whether it exited or not. */
const parties: Array<RunningCli> = [];

beforeAll(async () => {
  if (loopbackTlsCert === null) return;
  suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-onecmd-suite-"));
  // The certificate reaches each party as a file, because that is what
  // NODE_EXTRA_CA_CERTS names: the party trusts this one certificate rather
  // than running with verification disabled.
  certPath = path.join(suiteDir, "broker-front.pem");
  fs.writeFileSync(certPath, loopbackTlsCert.cert);
  broker = await startBrokerProcess();
  front = await startTlsBrokerFront(loopbackTlsCert, broker.port);
}, 90_000);

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-onecmd-"));
});

afterEach(async () => {
  await Promise.all(parties.splice(0).map((running) => running.stop()));
  try {
    if (work) fs.rmSync(work, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}, 30_000);

afterAll(async () => {
  try {
    await front?.stop();
    await broker?.stop();
  } finally {
    try {
      if (suiteDir) fs.rmSync(suiteDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

/** Start one party, tracked so the test's teardown cannot leave it running. */
function party(args: string[], stdin?: string): RunningCli {
  const running = startCli({
    args,
    // Each party runs from the work directory, so an artifact written to a
    // relative default path lands there and is removed with it rather than in
    // the workspace this suite runs from.
    cwd: work,
    env: { NODE_EXTRA_CA_CERTS: certPath },
    stdin,
    timeoutMs: PARTY_DEADLINE_MS,
  });
  parties.push(running);
  return running;
}

/**
 * The span between two of a party's own log lines, in milliseconds.
 *
 * A wait is measured from the run's log rather than from the wall clock around
 * the process: starting Node, compiling the sources, loading the PSI engine and
 * preparing the exchange all precede the wait and cost more than it does, so a
 * bound on the whole invocation would be sized against this machine's load
 * instead of against the budget under test.
 *
 * Each line is found by a fixed fragment of its message and read for the
 * timestamp the CLI's own log format puts at the head of it.
 */
function loggedSpanMs(stderr: string, from: string, to: string): number {
  const at = (fragment: string): number => {
    const line = stderr.split("\n").find((l) => l.includes(fragment));
    const stamp = line?.match(/^\[([^\]]+)\]/)?.[1];
    const parsed = stamp === undefined ? NaN : Date.parse(stamp);
    if (Number.isNaN(parsed))
      throw new Error(
        `no timestamped log line contains "${fragment}"; the run wrote:\n${stderr}`,
      );
    return parsed;
  };
  return at(to) - at(from);
}

/** The association table a party wrote, as its header and its row pairs. */
function resultTable(file: string): { header: string; pairs: Set<string> } {
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  return { header: lines[0], pairs: new Set(lines.slice(1)) };
}

liveTest(
  "the vendored broker answers through the TLS front (environment precondition)",
  async () => {
    // Separate from, and ahead of, the leg below: if the broker, front, or
    // certificate itself is broken, it fails here instead of being blamed on
    // the command path.
    //
    // A plain request exercises the whole path: the front terminates TLS
    // with the parties' own certificate and forwards to the broker, whose
    // handler answers 404 to anything but a WebSocket upgrade -- proving
    // what the parties trust is what the front actually presents.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = https.request(
        {
          host: BROKER_HOST,
          port: front.port,
          path: broker.path,
          method: "GET",
          ca: loopbackTlsCert?.cert,
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on("error", (err: Error) =>
        reject(
          new Error(
            "the signaling broker could not be reached through the TLS " +
              `front at ${BROKER_HOST}:${front.port}: ${err.message}`,
          ),
        ),
      );
      request.end();
    });
    expect(
      status,
      "the TLS front answered, but not with the vendored broker's own refusal " +
        "of a non-upgrade request; something other than that broker is behind it",
    ).toBe(404);
  },
  30_000,
);

liveTest(
  "an accepting CLI runs the whole acceptance in one command and both parties get the linkage result",
  async () => {
    const inviteInput = path.join(work, "invite-input.csv");
    fs.writeFileSync(inviteInput, INVITE_CSV);
    const acceptInput = path.join(work, "accept-input.csv");
    fs.writeFileSync(acceptInput, ACCEPT_CSV);
    const inviteOut = path.join(work, "invite-out.csv");
    const acceptOut = path.join(work, "accept-out.csv");
    const inviteConfig = path.join(work, "invite.yaml");
    const acceptConfig = path.join(work, "accept.yaml");
    const inviteKey = path.join(work, "invite.key");
    const acceptKey = path.join(work, "accept.key");
    const acceptRecord = path.join(work, "accept-record.json");

    // The inviting party: a wss:// coordination server of its own, from which
    // the invitation's endpoint is derived. It records no audit, so the one
    // below is unambiguously the acceptance's.
    const inviter = party([
      "invite",
      `wss://${BROKER_HOST}:${front.port}${broker.path}`,
      inviteInput,
      inviteOut,
      "--config-file",
      inviteConfig,
      "--key-file",
      inviteKey,
      "--identity",
      "invite",
      "--accept-timeout",
      PARTY_RUN_BUDGET,
      "--no-record",
      "--log-level",
      "info",
    ]);

    // The invitation is delivered on stdout, so this is the same string an
    // operator copies out of their terminal and sends to their partner.
    const invitation = await inviter.firstStdoutLine(60_000);
    expect(invitation).toMatch(/^[A-Za-z0-9_-]+$/);

    // The acceptance an operator types: the invitation, an input file, and a
    // destination -- no URL, because the invitation names the coordination
    // server itself. `y` answers the confirmation prompt, the one human
    // checkpoint before this command connects and transmits.
    const acceptor = party(
      [
        "accept",
        invitation,
        acceptInput,
        acceptOut,
        "--config-file",
        acceptConfig,
        "--key-file",
        acceptKey,
        "--identity",
        "accept",
        "--record-file",
        acceptRecord,
        // This acceptance runs the exchange, so its own budget bounds it: the
        // wait for the partner at the rendezvous, and the peer waits after.
        "--peer-timeout",
        PARTY_RUN_BUDGET,
        "--log-level",
        "info",
      ],
      "y\n",
    );

    const [acceptRun, inviteRun] = await Promise.all([
      acceptor.finished,
      inviter.finished,
    ]);
    expect(
      acceptRun.exitCode,
      describeCliRun("the acceptance", acceptRun),
    ).toBe(0);
    expect(
      inviteRun.exitCode,
      describeCliRun("the inviting party", inviteRun),
    ).toBe(0);

    // The acceptance asked about the coordination server it actually dialed --
    // host and port, resolved from the invitation's endpoint by the same
    // resolver the dial uses. This is the last checkpoint before a locator the
    // operator never typed is connected to, so a prompt naming something else
    // (or nothing) is a consent failure even where the exchange completes.
    expect(acceptRun.stderr).toContain(
      "Accept this invitation and run the exchange now, through " +
        `${BROKER_HOST}:${front.port}?`,
    );

    // The invitation is the whole of what the inviting party puts on stdout;
    // every diagnostic went to stderr.
    expect(inviteRun.stdout.trim()).toBe(invitation);

    // Both parties hold the intersection, each mapping its own matched rows to
    // the partner's: from the inviter, Bob (row 0) -> accept row 1 and Carol
    // (row 1) -> accept row 2; from the acceptor, Bob (row 1) -> invite row 0
    // and Carol (row 2) -> invite row 1. Neither non-matcher appears.
    const inviteTable = resultTable(inviteOut);
    const acceptTable = resultTable(acceptOut);
    expect(inviteTable.header).toBe("row_id,their_row_id");
    expect(acceptTable.header).toBe("row_id,their_row_id");
    expect(inviteTable.pairs).toEqual(new Set(["0,1", "1,2"]));
    expect(acceptTable.pairs).toEqual(new Set(["1,0", "2,1"]));

    // One command left the acceptance provisioned exactly as a two-command one
    // would: the connection block seeded from the invitation's endpoint, this
    // party's end of the rendezvous stamped on it, and the key file holding the
    // token the exchange rotated. The two parties deriving the SAME rotated
    // secret is what proves the live authenticated handshake ran between them.
    const acceptSpec = parseExchangeSpec(
      YAML.parse(fs.readFileSync(acceptConfig, "utf8")),
    );
    expect(acceptSpec.connection.channel).toBe("webrtc");
    if (acceptSpec.connection.channel !== "webrtc")
      throw new Error("expected a webrtc connection");
    expect(acceptSpec.connection.server.host).toBe(BROKER_HOST);
    expect(acceptSpec.connection.server.port).toBe(front.port);
    expect(acceptSpec.connection.server.path).toBe(broker.path);
    expect(acceptSpec.connection.role).toBe("acceptor");
    // The budget this run dialed on is the one the configuration records, so a
    // later unattended `psilink exchange` from it waits the same.
    expect(acceptSpec.connection.options?.peerTimeoutMs).toBe(
      PARTY_RUN_BUDGET_MS,
    );
    const acceptToken = loadKeyFile(acceptKey);
    const inviteToken = loadKeyFile(inviteKey);
    expect(acceptToken?.sharedSecret).toBeDefined();
    expect(acceptToken?.sharedSecret).toBe(inviteToken?.sharedSecret);

    // And the audit record lands on disk with its private verification keys
    // beside it, naming this exchange's two parties. Recording is the shipped
    // default and no flag turns it off here; only its destination is given, to
    // keep it out of the process's own directory.
    expect(fs.existsSync(acceptRecord)).toBe(true);
    expect(fs.existsSync(keysPathFor(acceptRecord))).toBe(true);
    const record = JSON.parse(fs.readFileSync(acceptRecord, "utf8")) as {
      localIdentity?: unknown;
      partnerIdentity?: unknown;
    };
    expect(record.localIdentity).toBe("accept");
    expect(record.partnerIdentity).toBe("invite");
  },
  180_000,
);

liveTest(
  "an acceptance whose partner never arrives stops at its --peer-timeout",
  async () => {
    // The unattended case the flag exists for: the invitation is real, so the
    // acceptance dials the coordination server the inviter published, but the
    // party that published it is gone before the rendezvous begins. Without a
    // budget of its own this waits out the transport's ten-minute rendezvous
    // default; with one it fails in seconds, on the availability class a
    // supervisor retries.
    const inviteInput = path.join(work, "invite-input.csv");
    fs.writeFileSync(inviteInput, INVITE_CSV);
    const acceptInput = path.join(work, "accept-input.csv");
    fs.writeFileSync(acceptInput, ACCEPT_CSV);
    const acceptConfig = path.join(work, "accept.yaml");
    const acceptKey = path.join(work, "accept.key");
    const acceptOut = path.join(work, "accept-out.csv");

    const inviter = party([
      "invite",
      `wss://${BROKER_HOST}:${front.port}${broker.path}`,
      inviteInput,
      path.join(work, "invite-out.csv"),
      "--config-file",
      path.join(work, "invite.yaml"),
      "--key-file",
      path.join(work, "invite.key"),
      "--identity",
      "invite",
      "--accept-timeout",
      PARTY_RUN_BUDGET,
      "--no-record",
      "--log-level",
      "info",
    ]);
    const invitation = await inviter.firstStdoutLine(60_000);
    // The partner leaves before the acceptance starts, which is what makes this
    // a no-show rather than a slow peer: the broker holds no registration to
    // deliver the offer to, and an offer to an unregistered id is dropped.
    await inviter.stop();

    // --consent-to-terms is the unattended shape: nothing answers a prompt, so
    // the wait under test is the rendezvous rather than a terminal read.
    const acceptor = party([
      "accept",
      "--consent-to-terms",
      invitation,
      acceptInput,
      acceptOut,
      "--config-file",
      acceptConfig,
      "--key-file",
      acceptKey,
      "--identity",
      "accept",
      "--peer-timeout",
      NO_SHOW_PEER_TIMEOUT,
      "--no-record",
      "--log-level",
      "info",
    ]);
    const acceptRun = await acceptor.finished;

    // The availability class, so a supervisor tells "nobody was there" from a
    // refused invitation (64) or a broken exchange (70).
    expect(
      acceptRun.exitCode,
      describeCliRun("the acceptance", acceptRun),
    ).toBe(69);
    // The failure names the wait in the units the flag takes, and the flag that
    // sets it, so the operator who chose ten seconds reads ten seconds back.
    expect(acceptRun.stderr).toContain(
      `did not answer within ${NO_SHOW_PEER_TIMEOUT}`,
    );
    expect(acceptRun.stderr).toContain("--peer-timeout");
    // Its own budget ended the run, not the deadline that kills a party: an
    // acceptance left on the transport's ten-minute rendezvous default would be
    // killed here instead, with no exit code of its own and nothing said.
    expect(acceptRun.timedOut).toBe(false);
    // And it waited the budget it was given rather than failing early for some
    // other reason: at least the ten seconds asked for, and inside a bound
    // generous enough for the ICE gathering that runs within the same wait.
    const waitedMs = loggedSpanMs(
      acceptRun.stderr,
      "rendezvousing through the signaling server",
      "did not answer within",
    );
    expect(waitedMs).toBeGreaterThanOrEqual(NO_SHOW_PEER_TIMEOUT_MS);
    expect(waitedMs).toBeLessThan(45_000);
    // And nothing was provisioned: the configuration and key are written once
    // the handshake succeeds, which never happened.
    expect(fs.existsSync(acceptConfig)).toBe(false);
    expect(fs.existsSync(acceptKey)).toBe(false);
    expect(fs.existsSync(acceptOut)).toBe(false);
  },
  120_000,
);
