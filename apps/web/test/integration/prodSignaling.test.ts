import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  probeUnmatchedUpgrade,
  waitForColdSignaling,
} from "../devServer/signalingProbe";

import {
  getFreePort,
  hasBuild,
  spawnProdServer,
  stopProdServer,
  waitForRoot,
} from "./prodServer.js";

import type { ChildProcess } from "node:child_process";

// Regression guard for the "create an invitation -> Lost connection to
// server" bug: PeerJS attaches its WebSocket `upgrade` handler only once
// /api/peerjs first runs usePeerServer(), but the real client dials that
// WebSocket directly and never triggers the route -- so the server warms
// signaling itself at startup (server/custom-entry.ts). This connects the
// upgrade COLD, so it only passes if that startup warm attached the handler.
//
// Verified to fail (assertion, exit 1) when the custom-entry warm is removed
// and the server rebuilt.
//
// This runs against whatever `.output` currently holds: re-running without a
// rebuild after changing the startup warm makes an old build pass green
// against stale code. Rebuild (`npm run build -w apps/web`) to validate a
// change locally; CI always rebuilds before this suite. A run with no build
// at all is failed by requireProdBuild unless the opt-out is set, in which
// case the skip below takes effect.

const READY_TIMEOUT_MS = 30_000;
const COLD_PROBE_DEADLINE_MS = 20_000;
const UNMATCHED_PROBE_MS = 3_000;

describe.skipIf(!hasBuild)(
  "the production server warms PeerJS signaling at startup",
  () => {
    let child: ChildProcess | undefined;
    let port = 0;

    beforeAll(async () => {
      port = await getFreePort();
      const { child: proc, getLaunchError } = await spawnProdServer(port);
      child = proc;

      // Readiness is the ROOT route only, not /api/peerjs/*, which would warm
      // signaling and defeat the test.
      await waitForRoot(`http://127.0.0.1:${port}/`, proc, getLaunchError);
    }, READY_TIMEOUT_MS + 10_000);

    afterAll(async () => {
      await stopProdServer(child);
    });

    test(
      "a cold /api/peerjs upgrade answers OPEN without a prior /api/peerjs/* request",
      async () => {
        const opened = await waitForColdSignaling(port, {
          deadlineMs: COLD_PROBE_DEADLINE_MS,
        });
        expect(opened).toBe(true);
      },
      COLD_PROBE_DEADLINE_MS + 10_000,
    );

    // Regression guard: the signaling listener is the only `upgrade` listener on
    // the production server, so an upgrade to any non-/api/peerjs path must be
    // closed rather than left open -- Node does not auto-destroy an unhandled
    // upgrade once a listener exists, and no socket timeout reaps it, so leaving
    // it open is an unauthenticated socket-leak/DoS. Verified to fail (the socket
    // hangs) against the pre-fix routing that simply returned on a path miss.
    test(
      "an upgrade to a non-signaling path is rejected, not left to leak a socket",
      async () => {
        const closed = await probeUnmatchedUpgrade(port, UNMATCHED_PROBE_MS);
        expect(closed).toBe(true);
      },
      UNMATCHED_PROBE_MS + 10_000,
    );
  },
);
