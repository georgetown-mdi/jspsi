/// <reference types="@vitest/browser-playwright/context" />

import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { commands } from "vitest/browser";

import { loadCSVFile, runExchange } from "@psilink/core";
// @ts-ignore this is really there
import PSI from "@openmined/psi.js/psi_wasm_web";

import {
  acceptorColumnsEditorState,
  acceptorInitialColumnsState,
  acceptorLaunchPayload,
} from "@exchange/acceptorColumnsModel";
import { HANDSHAKE_ROLE_FOR_SIDE } from "@psi/handshakeRole";
import { authenticateExchange } from "@psi/authenticateExchange";
import { dialAsAcceptor } from "@psi/transport/rendezvous";
import { openPeerMessageConnection } from "@psi/transport/peerMessageConnection";
import { prepareAcceptedInvitation } from "@psi/acceptInvitation";
import { prepareAcceptorExchange } from "@exchange/acceptorExchange";

import { LEG_ENVIRONMENT_FAILURE } from "./legTypes";

import type { LiveLegCliOutcome, LiveLegStart, MatchedPair } from "./legTypes";
import type { DataConnection } from "peerjs";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";
import type { PeerCloseOutcome } from "@psi/transport/waitForPeerClose";

/**
 * A real `psilink` process and a real browser peer completing one WebRTC PSI
 * exchange through the standalone signaling broker, with each side's
 * association table asserted and each side's clean-close wait measured.
 *
 * The known-answer interop vectors
 * (packages/core/test/vectors/webrtc-interop-vectors.json) pin that the two
 * implementations CONSTRUCT the same rendezvous ids, handshake roles and
 * endpoints; they cannot see a divergence that only appears on the wire --
 * framing, close sequencing, delivery on teardown. This is the leg where the
 * two meet.
 *
 * The CLI holds the inviter seat, which is what puts the broker on an origin
 * of its own: the invitation it mints from a `ws://` coordination-server URL
 * names that broker, and the browser peer dials what the invitation names. A
 * browser inviter would name its own page's origin instead.
 *
 * The Node side -- the broker and the `psilink` process -- runs behind the
 * vitest browser commands in `legCommands.ts`. Its failures are prefixed
 * {@link LEG_ENVIRONMENT_FAILURE}, so an environment that could not stand the
 * leg up is never read as an interop divergence.
 */

/**
 * The one module this leg substitutes, and the reason it can run at all:
 * `@psi/transport/rendezvous` loads its config at module scope through
 * `ConfigManager`, whose env read needs `process` -- absent in the browser
 * runner, so the import throws there. The rest of the browser suite stubs the
 * whole rendezvous module for that reason
 * (`apps/web/test/browser/moduleMocks.ts`); this leg stubs the CONFIG instead,
 * one level below, so the dial it drives is the app's own. The values are the
 * schema's defaults, which is what an unset environment resolves to.
 */
vi.mock("@utils/clientConfig", () => {
  class ConfigManager {
    load(): Promise<{
      PEERJS_DEBUG_LEVEL: number;
      LOG_LEVEL: string;
      DEPLOYMENT_PROFILE: string;
      PSILINK_VERSION: string;
    }> {
      return Promise.resolve({
        PEERJS_DEBUG_LEVEL: 1,
        LOG_LEVEL: "INFO",
        DEPLOYMENT_PROFILE: "hosted",
        PSILINK_VERSION: "",
      });
    }
  }
  return { ConfigManager };
});

/** What the browser peer links on. Two rows in common with the CLI party's
 * file, at different offsets on each side, so a party reading its own table
 * back cannot pass by symmetry: the CLI's rows 0 and 1 are this party's 1 and
 * 2. */
const BROWSER_CSV =
  "first_name,last_name,date_of_birth\n" +
  "Zoe,Adams,2001-03-03\n" +
  "Bob,Jones,1990-01-02\n" +
  "Carol,Lee,1985-07-16\n";

const BROWSER_IDENTITY = "Agency B, b@agency-b.example";

/** The pairs each side must resolve: [own row, partner row]. */
const CLI_PAIRS: Array<MatchedPair> = [
  [0, 1],
  [1, 2],
];
const BROWSER_PAIRS: Array<MatchedPair> = [
  [1, 0],
  [2, 1],
];

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    startLiveWebrtcLeg: () => Promise<LiveLegStart>;
    liveWebrtcCliOutcome: () => Promise<LiveLegCliOutcome>;
    stopLiveWebrtcLeg: () => Promise<void>;
  }
}

/**
 * What ended the PeerJS connection before the browser party reached its own
 * close, which is what the two close orderings differ by: `none` is this party
 * closing first, `peer-close` is the CLI party having closed first. The other
 * two are the ways a run can reach the same cleared `open` flag with nothing
 * delivered.
 */
type EndBeforeOwnClose =
  "none" | "peer-close" | "link-failed" | "connection-error";

/**
 * Read that ending off the connection the moment before this party closes.
 * PeerJS clears `open` whenever it ends the connection itself, so an open
 * connection is this party closing first and a cleared one is the CLI party's
 * close sentinel -- unless ICE gave up on the link or a send raised, the two
 * separated here. The remaining way PeerJS ends a connection, a broker-relayed
 * leave, cannot reach this party: it drops its broker socket on the exchange's
 * first frame.
 */
function endBeforeOwnClose(
  conn: DataConnection,
  connectionError: boolean,
): EndBeforeOwnClose {
  if (connectionError) return "connection-error";
  if (conn.open) return "none";
  return conn.peerConnection.connectionState === "failed"
    ? "link-failed"
    : "peer-close";
}

/** What the browser peer's own half of the exchange produced. */
interface BrowserOutcome {
  /** The partner's declared identity, read off the agreed terms. */
  partnerIdentity: string | undefined;
  /** The matched (own row, partner row) pairs, ascending by own row. */
  pairs: Array<MatchedPair>;
  /** How the clean close's wait for the peer ended, or undefined where there
   * was no wait to take. */
  closeOutcome: PeerCloseOutcome | undefined;
  /** Which close ordering the run took, which the outcome above is read
   * against. */
  endBeforeOwnClose: EndBeforeOwnClose;
  /** How long that wait took: the span from asking for the flushing close --
   * which queues the in-band close sentinel behind the final frame -- to the
   * close returning. */
  closeWaitMs: number;
}

let started: LiveLegStart;
let browserOutcome: BrowserOutcome | undefined;
let cliOutcome: LiveLegCliOutcome | undefined;

/** Every URL `fetch` was called with while the leg ran, for the peer-id check
 * below. */
const fetched: Array<string> = [];
let realFetch: typeof globalThis.fetch;

/** The matched pairs an exchange result holds, ordered so two parties' mirrored
 * tables compare directly. */
function matchedPairs(
  associationTable: [Array<number>, Array<number>] | undefined,
): Array<MatchedPair> {
  if (associationTable === undefined) return [];
  const [own, partner] = associationTable;
  return own
    .map((row, index): MatchedPair => [row, partner[index]])
    .sort((a, b) => a[0] - b[0]);
}

/** Run the browser peer's whole half: accept the invitation, dial the broker
 * the invitation names, authenticate, run the PSI rounds, and close cleanly. */
async function runBrowserPeer(invitation: string): Promise<BrowserOutcome> {
  // The app's own accept-path validation: checksum, expiry, an endpoint this
  // build can drive, and the terms' fail-closed checks.
  const accepted = await prepareAcceptedInvitation(invitation, {
    profile: "hosted",
  });
  if (accepted.endpoint.channel !== "webrtc")
    throw new Error(
      `${LEG_ENVIRONMENT_FAILURE} the CLI party minted a ` +
        `${accepted.endpoint.channel} endpoint, not a webrtc one`,
    );

  // Read through the app's own CSV reader, from a File as the accept seat
  // acquires one, so a divergence here cannot be mistaken for a protocol one.
  const parsed = await loadCSVFile(
    new File([BROWSER_CSV], "input.csv", { type: "text/csv" }),
  );
  const rawRows = parsed.data;
  const columns = parsed.meta.fields ?? [];
  const { edits } = acceptorLaunchPayload(
    acceptorColumnsEditorState(
      acceptorInitialColumnsState(columns),
      accepted.token.linkageTerms,
      rawRows,
    ),
  );
  const prepared = prepareAcceptorExchange({
    linkageTerms: accepted.token.linkageTerms,
    acceptorName: BROWSER_IDENTITY,
    edits,
    rawRows,
    columns,
    disclosedPayloadColumns: accepted.token.disclosedPayloadColumns,
    // The value an accept with no control of its own derives.
    deduplicate: false,
  });

  // The app's own dial, against the endpoint the CLI party minted.
  const [peer, conn] = await dialAsAcceptor(
    accepted.token.sharedSecret,
    accepted.endpoint,
  );
  // The lifecycle's own early broker drop: once a frame has arrived the
  // rendezvous is over, and the close below happens with no broker socket left
  // (apps/web/src/psi/exchangeLifecycle.ts).
  conn.once("data", () => peer.disconnect());

  let connectionError = false;
  conn.on("error", () => {
    connectionError = true;
  });

  let closeOutcome: PeerCloseOutcome | undefined;
  const mc = await openPeerMessageConnection(conn, {
    onCloseOutcome: (outcome) => {
      closeOutcome = outcome;
    },
  });
  const handshakeRole = HANDSHAKE_ROLE_FOR_SIDE.acceptor;
  await authenticateExchange(
    mc,
    handshakeRole,
    accepted.token.sharedSecret,
    accepted.token.expires,
  );
  const psiLibrary = await (PSI() as Promise<PSILibrary>);
  const result = await runExchange(mc, handshakeRole, prepared, { psiLibrary });

  const ending = endBeforeOwnClose(conn, connectionError);
  // The measurement: a flushing close queues the in-band close sentinel behind
  // the final frame and then waits for the peer to close the channel, so this
  // span is what a browser operator waits after their result is on screen.
  const closeStartedAt = performance.now();
  await mc.close();
  const closeWaitMs = Math.round(performance.now() - closeStartedAt);
  peer.disconnect();

  return {
    partnerIdentity: result.partnerTerms.identity,
    pairs: matchedPairs(result.associationTable),
    closeOutcome,
    endBeforeOwnClose: ending,
    closeWaitMs,
  };
}

beforeAll(async () => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    fetched.push(input instanceof Request ? input.url : String(input));
    return realFetch.call(globalThis, input, init);
  };
  started = await commands.startLiveWebrtcLeg();
}, 120_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  await commands.stopLiveWebrtcLeg();
}, 60_000);

test("the standalone broker answers on an origin of its own (environment precondition)", () => {
  // Separate from, and ahead of, the exchange below: a broker that is not the
  // vendored one, or that sits on the page's own origin, fails here rather than
  // being blamed on the interop path.
  expect(
    started.readinessBody,
    "the port answered, but not with the standalone broker's own readiness " +
      "body; something other than that broker is behind it",
  ).toBe(started.expectedReadinessBody);
  expect(started.brokerOrigin).not.toBe(window.location.origin);
  expect(started.invitation).toMatch(/^[A-Za-z0-9_-]+$/);
});

test("a CLI peer and a browser peer resolve the same intersection", async () => {
  browserOutcome = await runBrowserPeer(started.invitation);
  cliOutcome = await commands.liveWebrtcCliOutcome();

  expect(
    cliOutcome.killedOnDeadline,
    `the CLI party was killed on its deadline\n${cliOutcome.output}`,
  ).toBe(false);
  expect(cliOutcome.exitCode, cliOutcome.output).toBe(0);

  // Each side resolved the intersection at the offsets its OWN file holds,
  // which differ between the two, and the browser peer read the CLI party's
  // declared identity off the agreed terms.
  expect(browserOutcome.partnerIdentity).toBe(started.cliIdentity);
  expect(browserOutcome.pairs).toEqual(BROWSER_PAIRS);
  expect(cliOutcome.pairs).toEqual(CLI_PAIRS);
}, 420_000);

/**
 * The ceiling this leg holds the browser party's wait under. Sized between the
 * two outcomes it separates rather than around the measurement: a wait that
 * ends on the CLI party's close costs milliseconds, while a wait left to end on
 * ICE giving up on that party costs 15 s or more. Anything under this is the
 * former, and a regression to the latter cannot pass.
 */
const BROWSER_CLOSE_WAIT_CEILING_MS = 5_000;

test("each side's clean-close wait is measured and recorded", () => {
  if (browserOutcome === undefined || cliOutcome === undefined)
    throw new Error("the exchange did not run, so there is nothing to measure");

  // The numbers themselves stay a tracked limit recorded in
  // docs/spec/WEBRTC_TRANSPORT.md ("The clean close"), read across nightly runs;
  // what is asserted below is the exit each wait takes, not a duration drawn
  // from one measurement.
  console.log(
    `[live-webrtc] close wait: browser ${browserOutcome.closeWaitMs}ms ` +
      `(${String(browserOutcome.closeOutcome)}, ended before its own close: ` +
      `${browserOutcome.endBeforeOwnClose}), CLI ` +
      `${String(cliOutcome.closeWaitMs)}ms`,
  );
  // The exit is read against the ordering the run took, because the two
  // orderings have different right answers and an absent outcome on its own is
  // also what a link that died before this party's close leaves behind.
  if (browserOutcome.endBeforeOwnClose === "none") {
    // This party closed first, so the CLI party's close has to end the wait --
    // the one exit that is a delivery signal. Every other one raises the
    // operator's doubt notice on a run whose result is correct.
    expect(browserOutcome.closeOutcome).toBe("peer-closed");
  } else {
    expect(
      browserOutcome.endBeforeOwnClose,
      "the connection ended before this party's close, and on something other " +
        "than the CLI party's close sentinel",
    ).toBe("peer-close");
    // PeerJS ends the connection on reading that sentinel, so the flushing
    // close finds it already ended, takes no wait, and reports no outcome.
    expect(browserOutcome.closeOutcome).toBeUndefined();
  }
  expect(browserOutcome.closeWaitMs).toBeLessThan(
    BROWSER_CLOSE_WAIT_CEILING_MS,
  );
  // A null CLI number means that party never reached a close at all.
  expect(cliOutcome.closeWaitMs).not.toBeNull();
});

test("the browser peer reaches the broker over the signaling socket alone", () => {
  // PeerJS asks the broker for an id over HTTP only when constructed without
  // one, and psilink always supplies the id derived from the invitation secret.
  // So a broker on an origin of its own needs no CORS header for this app: the
  // only thing that crosses is the WebSocket, which CORS does not govern. This
  // is that claim as a check rather than a note.
  //
  // The recorder is asserted to still be in place, so an empty list is the
  // absence of a request rather than the absence of a recorder.
  expect(globalThis.fetch).not.toBe(realFetch);
  expect(fetched.filter((url) => url.startsWith(started.brokerOrigin))).toEqual(
    [],
  );
});
