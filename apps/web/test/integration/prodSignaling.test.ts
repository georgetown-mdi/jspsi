import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  probeUnmatchedUpgrade,
  waitForColdSignaling,
} from "../devServer/signalingProbe";

import {
  getFreePort,
  spawnProdServer,
  stopProdServer,
  waitForRoot,
} from "./prodServer.js";

import type { ChildProcess } from "node:child_process";

// Regression guard for the "create an invitation -> Lost connection to server"
// bug on the DEPLOYED app. The PeerJS signaling server attaches its WebSocket
// `upgrade` handler only when its /api/peerjs route first runs usePeerServer(),
// and the real client dials that WebSocket with an explicit, pre-derived id --
// it never makes the GET /api/peerjs/id that would load the route. So the server
// must warm signaling itself at startup; the nitro production entry
// (server/custom-entry.ts) does this via nitroApp.localFetch. This spawns the
// real built server and connects the upgrade COLD (never an HTTP request to
// /api/peerjs/*), so it only passes if that startup warm attached the handler.
//
// Verified to fail (assertion, exit 1) when the custom-entry warm is removed and
// the server rebuilt, so this is a real guard rather than a no-op.
//
// Build-gated: the production entry exists only after `npm run build`. CI builds
// the web app before this suite runs (eb_build_and_test.yaml: "Build server"
// precedes "Web integration and browser tests"), so this runs there; a local
// `npm run test:integration` without a prior build skips it rather than failing.
//
// A non-skipped LOCAL run tests whatever `.output` currently holds: if you change
// the startup warm and re-run without rebuilding, an OLD build still on disk makes
// this pass green against stale code. To validate a warm change locally, rebuild
// first (`npm run build -w apps/web`); CI always rebuilds before this suite, so it
// is unaffected.
const here = dirname(fileURLToPath(import.meta.url));
// apps/web/test/integration -> apps/web is two levels up.
const webRoot = resolve(here, "../..");
const prodEntry = resolve(webRoot, ".output/server/index.mjs");
const hasBuild = existsSync(prodEntry);

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
      const { child: proc, getLaunchError } = await spawnProdServer(
        prodEntry,
        webRoot,
        port,
      );
      child = proc;

      // Readiness is the ROOT route only -- deliberately not /api/peerjs/*, which
      // would warm signaling and defeat the test.
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
