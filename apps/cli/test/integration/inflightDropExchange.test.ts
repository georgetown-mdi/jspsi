import fsp from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";
import { FileSyncConnection } from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { selectedBackend, startInProcessSftpServer } from "../sftpServer";
import { serverAuth } from "../sftpServer/testContext";
import type { InProcessSftpServer } from "../sftpServer/types";

// The two-party statement of what inflightDropRecovery.test.ts pins one adapter at
// a time: a clean partner-side drop landing while a message is in flight between
// two FileSyncConnections either delivers that message or rejects the sender's
// send(). A resolved send() over a message the peer never receives is the one
// outcome the exchange must never produce -- the sender's exchange proceeds to the
// next protocol step believing the peer has what it needs, while the peer is still
// waiting for it.
//
// Both parties connect and synchronize BEFORE the drop is armed, so no connection
// is established under a standing control, but unlike the withheld-close exercise
// in heldSessionWithheldClose.test.ts neither party is left ungoverned: the op
// counter behind dropActiveAfterOps is server-wide (see test/sftpServer/types.ts),
// so the cut lands on whichever party's session is serving the counted operation.
// That is deliberate. A real partner cuts the session it cuts, and the contract
// asserted here is the one that must hold either way -- the sender torn mid-write
// and the receiver torn mid-read are both mid-message drops.
//
// Only the in-process backend can be told to cut a session this way (a native sshd
// cannot; see test/sftpServer/types.ts), so this runs there and stands up its own
// server to reach the session controls.
const inProcessOnly = test.skipIf(selectedBackend() !== "in-process");

const TEST_TIMEOUT_MS = 120_000;

// The per-operation liveness deadline, lowered through the adapter's @internal
// test seam, so a cut this exercise cannot recover from surfaces as the failure it
// is rather than spending the production minute per party on the way there.
const STALL_DEADLINE_MS = 3_000;

// How long a message that the sender reports as sent is given to reach the peer.
// Generous against the 10 ms poll interval: a position that recovers delivers in
// well under a second, and this only bounds how long a position that does not
// takes to say so.
const DELIVERY_DEADLINE_MS = 20_000;

// SFTP operation counts after the rendezvous at which to cut. send() writes
// through a list (its consume gate), a put (OPEN/WRITE/CLOSE) and a rename, while
// the receiver's poll loop lists, gets and removes over the same counter, so these
// indices reach into both parties' high-level operations. They are the positions at
// which the measured interleaving on this backend places the cut inside a
// high-level operation on one side or the other; the contract below is asserted at
// each rather than a per-position outcome, so an interleaving that shifts costs
// this case its aim, never its truth.
const CUT_POINTS = [11, 14, 15, 16];

interface ExchangeOutcome {
  cutPoint: number;
  sendRejection: string | undefined;
  delivered: boolean;
  redials: number;
}

// One two-party exchange, in its own rendezvous directory under the shared server
// (never a shared one; see sftpConnection.test.ts's header), cut once at the given
// operation count and reported on. Throws nothing for the drop itself: a rejected
// send() is a permitted outcome here, so it is recorded rather than raised.
async function exchangeCutAt(
  srv: InProcessSftpServer,
  cutPoint: number,
): Promise<ExchangeOutcome> {
  const dir = await fsp.mkdtemp(path.join(srv.handle.backingDir, "inflight-"));
  const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
  const senderAdapter = new SSH2SFTPClientAdapter({
    stallDeadlineMs: STALL_DEADLINE_MS,
  });
  const sender = new FileSyncConnection(senderAdapter, {
    verbose: -1,
    pollingFrequency: 10,
  });
  const receiverAdapter = new SSH2SFTPClientAdapter({
    stallDeadlineMs: STALL_DEADLINE_MS,
  });
  const receiver = new FileSyncConnection(receiverAdapter, {
    verbose: -1,
    pollingFrequency: 10,
  });
  // Both parties surface a terminal drop through the delivery race below, so the
  // emitter's own 'error' is drained here rather than left to throw unhandled.
  sender.on("error", () => {});
  receiver.on("error", () => {});

  try {
    await sender.open({
      channel: "sftp",
      server: {
        host: srv.handle.host,
        port: srv.handle.port,
        ...serverAuth(srv.handle.usera),
        path: remote,
      },
    });
    await receiver.open({
      channel: "sftp",
      server: {
        host: srv.handle.host,
        port: srv.handle.port,
        ...serverAuth(srv.handle.userb),
        path: remote,
      },
    });
    await Promise.all([sender.synchronize(), receiver.synchronize()]);

    const delivery = new Promise<boolean>((resolve) => {
      receiver.once("data", (message: unknown) => {
        resolve(
          JSON.stringify(message) ===
            JSON.stringify({ message: `in flight at ${cutPoint}` }),
        );
      });
      // A drop the exchange cannot recover from ends the receiver with no `data`
      // event at all; resolving false on it reports that outcome at once rather
      // than leaving the case to spend the delivery deadline on it.
      receiver.once("error", () => resolve(false));
    });

    srv.sessionControls.dropActiveAfterOps(cutPoint);
    receiver.start();
    const sendRejection = await sender
      .send({ message: `in flight at ${cutPoint}` })
      .then(
        () => undefined,
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      );
    let deliveryTimer: NodeJS.Timeout | undefined;
    const delivered = await Promise.race([
      delivery,
      new Promise<boolean>((resolve) => {
        deliveryTimer = setTimeout(() => resolve(false), DELIVERY_DEADLINE_MS);
      }),
    ]).finally(() => clearTimeout(deliveryTimer));
    receiver.stop();

    return {
      cutPoint,
      sendRejection,
      delivered,
      redials:
        senderAdapter.midExchangeReconnectCount +
        receiverAdapter.midExchangeReconnectCount,
    };
  } finally {
    receiver.stop();
    // Disarm before the teardown dials and closes, so a drop this position did not
    // spend cannot cut the pre-drain reconnect or the next position's exchange.
    srv.sessionControls.dropActiveAfterOps(0);
    await receiver.close().catch(() => {});
    await sender.close().catch(() => {});
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

inProcessOnly(
  "a clean drop mid-message either delivers the message or rejects send()",
  async () => {
    const srv = await startInProcessSftpServer();
    try {
      const [outcomes, logs] = await withCapturedLogs(
        async () => {
          const results: ExchangeOutcome[] = [];
          for (const cutPoint of CUT_POINTS)
            results.push(await exchangeCutAt(srv, cutPoint));
          return results;
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      // The contract. A send() that rejects has told its caller the message may not
      // be there; a send() that resolves has promised it is.
      expect(
        outcomes.filter(
          (outcome) =>
            outcome.sendRejection === undefined && !outcome.delivered,
        ),
      ).toEqual([]);
      // Every position's drop was survived by the party it landed on rather than
      // absorbed somewhere quieter: an outcome that satisfies the contract only
      // because nothing was ever torn would pin nothing.
      expect(outcomes.filter((outcome) => outcome.redials < 1)).toEqual([]);
      // A send() that does reject names what the exchange actually met -- the
      // partner's SFTP status, or the drop and its remedies. The two library
      // lifecycle strings are neither: `getConnection:` is a dial the adapter could
      // not complete, which points the operator at the connection rather than at
      // the partner's session cap, and a bare tear reaching the caller is a
      // recovery that refused to run.
      expect(
        outcomes.filter((outcome) =>
          /getConnection|Unexpected (end|close) event/.test(
            outcome.sendRejection ?? "",
          ),
        ),
      ).toEqual([]);
      // The set is not vacuous: at least one position carried the message through
      // its drop on a send() that resolved, so the contract above is satisfied by
      // delivery and not only by rejection.
      expect(
        outcomes.filter(
          (outcome) => outcome.sendRejection === undefined && outcome.delivered,
        ).length,
      ).toBeGreaterThanOrEqual(1);

      // Each survived drop is reported to the operator as one, and no seam the
      // recovery drives degraded on the way (every degradation warns with the
      // upgrade checklist).
      expect(
        logs.filter((entry) =>
          entry.message.includes("dropped mid-exchange and was transparently"),
        ).length,
      ).toBeGreaterThanOrEqual(1);
      expect(
        logs.filter((entry) =>
          entry.message.includes("Upgrading the SFTP Stack"),
        ),
      ).toEqual([]);
    } finally {
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);
