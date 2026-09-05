import { readIceStats } from "../src/connection/webrtc/iceDiagnostics";

import type { RTCPeerConnection } from "werift";

/**
 * A run whose only outstanding work is an ICE stats read that never settles,
 * printing how long the process stayed alive past the read starting.
 *
 * The read is bounded, and what the bound must not do is hold the process: an
 * interrupt waits out none of this transport's budgets
 * (docs/spec/WEBRTC_TRANSPORT.md, Budgets), and the ceiling is armed even where
 * the outcome the read describes has already been decided. Measured from a
 * child process because it is the process exiting that is under test, which the
 * test runner's own process cannot do.
 */

const peer = {
  getStats: () => new Promise<never>(() => {}),
} as unknown as RTCPeerConnection;

const startedAt = Date.now();
process.on("beforeExit", () => {
  process.stdout.write(String(Date.now() - startedAt));
});
void readIceStats(peer);
