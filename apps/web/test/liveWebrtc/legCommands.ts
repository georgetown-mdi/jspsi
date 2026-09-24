import { READINESS_BODY } from "@alcove/peerjs-broker/standaloneOptions";

import { CLI_IDENTITY, startCliInviter } from "./cliPeer.ts";
import { startStandaloneBroker } from "./standaloneBroker.ts";

import type { LiveLegCliOutcome, LiveLegStart } from "./legTypes.ts";
import type { CliInviter } from "./cliPeer.ts";
import type { StandaloneBroker } from "./standaloneBroker.ts";

/**
 * The Node half of the live CLI-to-browser WebRTC leg, registered as vitest
 * browser commands on the `live-webrtc` project (apps/web/vite.config.ts).
 *
 * A browser test cannot spawn a broker or an `alcove` process, and this leg
 * needs both standing while it runs. Commands are the channel vitest provides
 * for exactly that, and they are what lets the browser test assert BOTH
 * parties' association tables in its own body rather than in a teardown hook,
 * where a mismatch would report as a run-level error instead of a failed
 * assertion.
 *
 * The state below is per vitest node process, which is one leg: the project
 * holds a single test file, and a second one would have to take a handle
 * rather than share this.
 */

let broker: StandaloneBroker | undefined;
let inviter: CliInviter | undefined;

/**
 * Start the broker on its own loopback origin, then an `alcove invite` waiting
 * at it, and hand the browser peer the invitation.
 *
 * The CLI is invited over `ws://`: the broker terminates no TLS, and the page
 * this leg runs on is itself plain HTTP, so the browser peer resolves the same
 * scheme from its own origin (PeerJS's `secure` default).
 */
async function startLeg(): Promise<LiveLegStart> {
  await stopLeg();
  broker = await startStandaloneBroker();
  inviter = await startCliInviter(
    `ws://127.0.0.1:${broker.port}${broker.path}`,
  );
  return {
    invitation: inviter.invitation,
    brokerOrigin: `http://127.0.0.1:${broker.port}`,
    readinessBody: broker.readinessBody,
    expectedReadinessBody: READINESS_BODY,
    cliIdentity: CLI_IDENTITY,
  };
}

/** Wait for the CLI party to finish and report what its run did. */
async function cliOutcome(): Promise<LiveLegCliOutcome> {
  if (inviter === undefined)
    throw new Error("no CLI party is running; the leg was never started");
  return await inviter.outcome();
}

/** Stop both processes and remove the CLI party's working directory.
 * Idempotent, and safe to call on a leg that never started. */
async function stopLeg(): Promise<void> {
  const running = [inviter?.stop(), broker?.stop()];
  inviter = undefined;
  broker = undefined;
  await Promise.all(running);
}

/**
 * The commands `test.browser.commands` registers. Each takes the browser
 * command context, which this leg does not read: the processes are the Node
 * side's own, not the page's.
 */
export const liveWebrtcLegCommands = {
  startLiveWebrtcLeg: (): Promise<LiveLegStart> => startLeg(),
  liveWebrtcCliOutcome: (): Promise<LiveLegCliOutcome> => cliOutcome(),
  stopLiveWebrtcLeg: (): Promise<void> => stopLeg(),
};
