import fsp from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";
import {
  FileSyncConnection,
  TransportPublishIndeterminateError,
  UsageError,
  sanitizeErrorForDisplay,
} from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { selectedBackend, startInProcessSftpServer } from "../sftpServer";
import { serverAuth } from "../sftpServer/testContext";
import type { InProcessSftpServer } from "../sftpServer/types";

// A partner server that drops the SFTP session cleanly while a HIGH-LEVEL
// ssh2-sftp-client operation (get, the put family, delete, rename, exists) is in
// flight tears that operation off the wire from the ssh2 Client's 'end' -- the
// library's per-operation listeners clear its session property on either 'end' or
// 'close', so the rejection is delivered a full event before the transport's
// 'close'. The recovery re-dial therefore runs while the dead transport still owes
// that 'close', and ssh2-sftp-client's connect() fails any dial such a stale event
// reaches while leaving the handshake it started running unowned at the server.
//
// The cases here drive that partner for real and hold the recovery to what it
// promises: the operation completes, the drop is counted and reported as one drop,
// and every dial the adapter makes is one it keeps. The raw-wrapper operations
// (list, createExclusive) are torn by the 'close' itself and so never reached this
// window; they are here as the no-regression half.
//
// One case covers the publish the recovery can neither complete nor fail: a
// rename torn after it landed, whose destination something removes before the
// re-dialed session can confirm it. It is staged through the rename-tear controls
// rather than an op-count drop, which cannot say whether the request's filesystem
// work ran before the connection went.
//
// Only the in-process backend can be told to cut a session this way (a native sshd
// cannot; see test/sftpServer/types.ts), so these run there and stand up their own
// server to reach the session controls. The socket-state census over the dials this
// path issues is dialDeferral.test.ts; the withheld-close partner, which leaves the
// session property SET instead, is heldSessionWithheldClose.test.ts.
const inProcessOnly = test.skipIf(selectedBackend() !== "in-process");

const TEST_TIMEOUT_MS = 120_000;

// The per-operation liveness deadline, lowered through the adapter's @internal
// test seam. Only the cases that expect an operation to FAIL depend on it, and
// only to avoid spending the production minute on a rejection they need to have
// happened rather than to have timed.
const STALL_DEADLINE_MS = 3_000;

// Large enough that a cut can land deep inside the transfer rather than only at
// its first opcode: ssh2-sftp-client reads in 32 KiB chunks, so this is a few
// hundred READs to place a cut among.
const TRANSFER_BYTES = 8 * 1024 * 1024;

// The read cap the transport always passes; above the transfer so the cap itself
// is never what ends a read here.
const READ_CAP_BYTES = 64 * 1024 * 1024;

// SFTP opcode indices at which to cut the transfer: its OPEN, the handful of
// opcodes around the first reads, and then deeper and deeper into the READ run.
// The point of the sweep is that "in flight" is not one place.
const CUT_POINTS = [1, 2, 3, 5, 9, 17, 33, 65, 129];

// How a dial the adapter issued ended. The census in dialDeferral.test.ts records
// the socket state a dial was issued ON; this records what became of the dial,
// which is what a stale lifecycle event shows up in.
interface DialOutcome {
  settled: "resolved" | "rejected";
  error?: string;
}

interface DialableClient {
  connect: (options: Record<string, unknown>) => Promise<unknown>;
}

// Wrap the ssh2-sftp-client connect() the adapter calls, not the adapter's own:
// the dialing-retry loop inside it dials once per attempt, and a dial failed by a
// stale event is exactly what that loop hides from the adapter's callers.
function recordDials(adapter: SSH2SFTPClientAdapter): DialOutcome[] {
  const dials: DialOutcome[] = [];
  const client = (adapter as unknown as { client: DialableClient }).client;
  const connect = client.connect.bind(client);
  client.connect = async (options: Record<string, unknown>) => {
    const dial: DialOutcome = { settled: "resolved" };
    dials.push(dial);
    try {
      return await connect(options);
    } catch (error: unknown) {
      dial.settled = "rejected";
      dial.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };
  return dials;
}

interface Party {
  srv: InProcessSftpServer;
  adapter: SSH2SFTPClientAdapter;
  conn: FileSyncConnection;
  dials: DialOutcome[];
  remote: string;
  localDir: string;
  stop: () => Promise<void>;
}

// One connected party on its own server, in its own rendezvous directory (never a
// shared one; see sftpConnection.test.ts's header). The party drives the adapter
// directly rather than through a poll loop, so the server's op counter -- which is
// server-wide -- counts only this test's operations and a cut lands where the case
// aimed it.
async function connectParty(options: {
  maxReconnectAttempts: number;
  ephemeralSessions?: boolean;
  stallDeadlineMs?: number;
}): Promise<Party> {
  const srv = await startInProcessSftpServer();
  const localDir = await fsp.mkdtemp(
    path.join(srv.handle.backingDir, "inflight-"),
  );
  const remote = `${srv.handle.remoteRoot}/${path.basename(localDir)}`;
  const adapter = new SSH2SFTPClientAdapter({
    ephemeralSessions: options.ephemeralSessions ?? false,
    ...(options.stallDeadlineMs === undefined
      ? {}
      : { stallDeadlineMs: options.stallDeadlineMs }),
  });
  const dials = recordDials(adapter);
  const conn = new FileSyncConnection(adapter, {
    verbose: -1,
    pollingFrequency: 10,
  });
  conn.on("error", () => {});
  await conn.open({
    channel: "sftp",
    server: {
      host: srv.handle.host,
      port: srv.handle.port,
      ...serverAuth(srv.handle.usera),
      path: remote,
    },
    options: { maxReconnectAttempts: options.maxReconnectAttempts },
  });
  // From here on the record holds only the dials a case provoked; the party's own
  // first connect is setup, not a subject.
  dials.length = 0;
  return {
    srv,
    adapter,
    conn,
    dials,
    remote,
    localDir,
    stop: async () => {
      // Clear every standing cap before the teardown dials and closes: a cap left
      // armed cuts the pre-drain reconnect instead of the call under test.
      srv.sessionControls.maxIdleMs = 0;
      srv.sessionControls.maxOps = 0;
      srv.sessionControls.maxLifetimeMs = 0;
      srv.sessionControls.dropActiveAfterOps(0);
      srv.sessionControls.stopWithholdingCloses();
      await conn.close().catch(() => {});
      await fsp.rm(localDir, { recursive: true, force: true });
      await srv.stop();
    },
  };
}

async function plantTransfer(party: Party): Promise<string> {
  await fsp.writeFile(
    path.join(party.localDir, "transfer.bin"),
    Buffer.alloc(TRANSFER_BYTES, 7),
  );
  return `${party.remote}/transfer.bin`;
}

inProcessOnly(
  "an in-flight read torn by a clean drop returns its result, wherever inside " +
    "the transfer the cut lands",
  async () => {
    const party = await connectParty({
      maxReconnectAttempts: CUT_POINTS.length + 1,
    });
    try {
      const remoteFile = await plantTransfer(party);
      const controls = party.srv.sessionControls;
      controls.resetHandshakeCount();

      const [, logs] = await withCapturedLogs(
        async () => {
          for (const cutPoint of CUT_POINTS) {
            // The cut: the server ends the SSH connection as the cutPoint'th
            // further opcode is dispatched, which for a read of this size is
            // inside the READ run rather than at its edges.
            controls.dropActiveAfterOps(cutPoint);
            const read = await party.adapter.get(remoteFile, {
              maxBytes: READ_CAP_BYTES,
            });
            expect(read).toHaveLength(TRANSFER_BYTES);
          }
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      // Each cut cost exactly one re-dial, and each re-dial exactly one further
      // SSH session: no dial was spent on one a stale event failed, so none left a
      // session behind at the server for a later dial to trip over.
      expect(party.adapter.midExchangeReconnectCount).toBe(CUT_POINTS.length);
      expect(party.adapter.reconnectCount).toBe(CUT_POINTS.length);
      expect(controls.handshakeCount()).toBe(CUT_POINTS.length);
      expect(party.dials).toHaveLength(CUT_POINTS.length);
      expect(party.dials.filter((dial) => dial.settled === "rejected")).toEqual(
        [],
      );

      // Every recovered drop is reported to the operator as a survived drop, on
      // the existing warn cadence: the first, then every tenth.
      const recovered = logs.filter((entry) =>
        entry.message.includes("dropped mid-exchange and was transparently"),
      );
      expect(recovered.length).toBeGreaterThanOrEqual(1);
      expect(recovered[0].level).toBe("WARN");
      expect(recovered[0].message).toContain("--connection-per-poll");
      // A recovered drop is never reported as zero drops.
      expect(
        logs.filter((entry) =>
          entry.message.includes(
            "not compatible with the installed SFTP library",
          ),
        ),
      ).toEqual([]);
    } finally {
      await party.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

// Off an IDENTICAL first cut, the only difference between these two arms is what
// the partner does to sessions the adapter is not using. The first models a server
// that keeps cutting -- every quiet session is dropped, so a session a failed dial
// abandoned is killed for the adapter -- and the second a HEALTHIER partner that
// simply leaves them open. A recovery that only works against the first is not a
// recovery, so both arms are driven and both must complete.
for (const [arm, keepsCutting] of [
  ["a partner that keeps cutting quiet sessions", true],
  ["a partner that leaves quiet sessions open", false],
] as const) {
  inProcessOnly(
    `an in-flight read torn by a clean drop completes against ${arm}`,
    async () => {
      const party = await connectParty({ maxReconnectAttempts: 3 });
      try {
        const remoteFile = await plantTransfer(party);
        const controls = party.srv.sessionControls;
        controls.resetHandshakeCount();

        await withCapturedLogs(
          async () => {
            controls.dropActiveAfterOps(3);
            const read = party.adapter.get(remoteFile, {
              maxBytes: READ_CAP_BYTES,
            });
            // Armed AFTER the operation is issued, so both arms take the same
            // first cut and differ only in what follows it. A session serving a
            // transfer re-arms this timer on every opcode; one nobody is using
            // serves none and is dropped.
            if (keepsCutting) controls.maxIdleMs = 400;
            expect(await read).toHaveLength(TRANSFER_BYTES);
          },
          (level) => level === "WARN" || level === "ERROR",
        );

        expect(party.adapter.midExchangeReconnectCount).toBe(1);
        expect(party.dials).toHaveLength(1);
        expect(
          party.dials.filter((dial) => dial.settled === "rejected"),
        ).toEqual([]);
        // One re-dial, one further session: the arm that leaves quiet sessions
        // open has none to leave, because the adapter opened none it walked away
        // from.
        expect(controls.handshakeCount()).toBe(1);
      } finally {
        await party.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
}

inProcessOnly(
  "a drop that cannot be recovered surfaces the session loss and its remedies, " +
    "not a connect failure",
  async () => {
    // max_reconnect_attempts=0 permits no mid-exchange reconnection at all, so the
    // very first in-flight tear is terminal. What the operator is owed there is the
    // drop and what to do about it -- a dial failure would name neither, and the
    // budget clause would be the wrong one.
    const party = await connectParty({
      maxReconnectAttempts: 0,
      stallDeadlineMs: STALL_DEADLINE_MS,
    });
    try {
      const remoteFile = await plantTransfer(party);
      const controls = party.srv.sessionControls;
      controls.resetHandshakeCount();

      const error = await withCapturedLogs(
        async () => {
          controls.dropActiveAfterOps(3);
          return party.adapter
            .get(remoteFile, { maxBytes: READ_CAP_BYTES })
            .then(
              () => undefined,
              (e: unknown) => e,
            );
        },
        (level) => level === "WARN" || level === "ERROR",
      ).then(([result]) => result);

      expect(error).toBeInstanceOf(UsageError);
      const message = (error as Error).message;
      expect(message).toContain("dropped mid-exchange");
      expect(message).toContain(
        "max_reconnect_attempts=0 permits no mid-exchange reconnection",
      );
      expect(message).toContain("--connection-per-poll");
      // No re-dial was attempted, so no session was left behind by one either.
      expect(party.dials).toEqual([]);
      expect(controls.handshakeCount()).toBe(0);
      // The session was lost all the same, and the budget bounds the losses.
      expect(party.adapter.midExchangeReconnectCount).toBe(1);
    } finally {
      await party.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "an exhausted mid-exchange budget surfaces the session loss and its remedies",
  async () => {
    // The same statement one drop later: the budget's last re-dial is spent on the
    // first cut, so the second is terminal -- and terminal on the budget, with the
    // remedies, rather than on a dial.
    const party = await connectParty({
      maxReconnectAttempts: 1,
      stallDeadlineMs: STALL_DEADLINE_MS,
    });
    try {
      const remoteFile = await plantTransfer(party);
      const controls = party.srv.sessionControls;
      controls.resetHandshakeCount();

      const error = await withCapturedLogs(
        async () => {
          controls.dropActiveAfterOps(3);
          expect(
            await party.adapter.get(remoteFile, { maxBytes: READ_CAP_BYTES }),
          ).toHaveLength(TRANSFER_BYTES);
          controls.dropActiveAfterOps(3);
          return party.adapter
            .get(remoteFile, { maxBytes: READ_CAP_BYTES })
            .then(
              () => undefined,
              (e: unknown) => e,
            );
        },
        (level) => level === "WARN" || level === "ERROR",
      ).then(([result]) => result);

      expect(error).toBeInstanceOf(UsageError);
      expect((error as Error).message).toContain("max_reconnect_attempts=1");
      expect((error as Error).message).toContain("--connection-per-poll");
      // Two sessions lost: the one the budget's single re-dial recovered and the
      // one it refused.
      expect(party.adapter.midExchangeReconnectCount).toBe(2);
      // The re-dial the budget did allow, and no dial beyond it.
      expect(controls.handshakeCount()).toBe(1);
      expect(party.dials).toHaveLength(1);
    } finally {
      await party.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

// How many times each arm of the landed-publish pair is driven. The staging is
// deterministic by construction -- the tear cuts inside the RENAME handler at a
// named point, and the destination's removal is the server's own -- so the repeat
// is there to show that determinism holds rather than to hunt for an interleaving.
const LANDED_PUBLISH_REPEATS = 10;

inProcessOnly(
  "a publish torn after it landed resolves while its destination is there and " +
    "is reported indeterminate once something has taken it",
  async () => {
    // Each tear costs one re-dial, and the two determinate arms one each.
    const party = await connectParty({
      maxReconnectAttempts: LANDED_PUBLISH_REPEATS * 2 + 4,
      stallDeadlineMs: STALL_DEADLINE_MS,
    });
    const tear = party.srv.sessionControls.renameTear;
    // One publish: write the temp, tear its rename as staged, and report what the
    // adapter's rename() made of the recovery.
    const publish = async (
      name: string,
      stage: () => void,
      destination?: string,
    ): Promise<{ source: string; dest: string; error: unknown }> => {
      const source = `${party.remote}/temp-${name}.tmp`;
      const dest = destination ?? `${party.remote}/${name}.json`;
      await party.adapter.put(Buffer.from(name), source, {
        flags: "w",
        encoding: null,
      });
      tear.reset();
      stage();
      const error = await party.adapter.rename(source, dest).then(
        () => undefined,
        (e: unknown) => e,
      );
      return { source, dest, error };
    };

    try {
      await withCapturedLogs(
        async () => {
          for (let i = 0; i < LANDED_PUBLISH_REPEATS; i++) {
            // The publish LANDED and its destination is still on the server: the
            // premise the landed-confirmation probe rests on is intact, so the
            // torn rename resolves as the success it was.
            const kept = await publish(`kept-${i}`, () => {
              tear.tearAfterRenameLands = true;
            });
            expect(kept.error).toBeUndefined();
            await expect(party.adapter.exists(kept.dest)).resolves.toBe(true);

            // The same publish, with the destination consumed inside the recovery
            // window -- what a partner's consume-delete of this party's own
            // message does. The re-issue and both probes now read exactly what a
            // publish that never landed reads, so the rename rejects, and rejects
            // as the undetermined outcome it is rather than as a failure to
            // publish.
            const taken = await publish(`taken-${i}`, () => {
              tear.tearAfterRenameLands = true;
              tear.consumeDestinationAtTear = true;
            });
            expect(taken.error).toBeInstanceOf(
              TransportPublishIndeterminateError,
            );
            // The publish is never reported as sent: the operation still rejects,
            // and the transport's own error -- the SFTP status and both paths --
            // is carried rather than replaced. Both reach the operator, each
            // rendered under its own display cap.
            const cause = (taken.error as Error).cause;
            expect(cause).toBeInstanceOf(Error);
            expect((cause as Error).message).toContain("_rename");
            const rendered = sanitizeErrorForDisplay(taken.error);
            expect(rendered).toContain(
              "the publish may or may not have reached the partner",
            );
            expect(rendered).toContain((cause as Error).message);
            await expect(party.adapter.exists(taken.dest)).resolves.toBe(false);
          }

          // A determinate non-delivery, on an ENOENT that is not about the
          // source: the destination's directory does not exist, and the source
          // is still on the server, so nothing this party wrote can be in the
          // peer's hands. Its own error stands.
          const unreachable = await publish(
            "unreachable",
            () => {
              tear.tearBeforeRenameLands = true;
            },
            `${party.remote}/no-such-directory/unreachable.json`,
          );
          expect(unreachable.error).not.toBeInstanceOf(
            TransportPublishIndeterminateError,
          );
          expect((unreachable.error as Error).message).toContain("_rename");
          await expect(party.adapter.exists(unreachable.source)).resolves.toBe(
            true,
          );

          // A determinate non-delivery on a non-ENOENT status: the server reports
          // the generic failure that means the rename did not take effect, which
          // is an answer and not an ambiguity.
          const refused = await publish("refused", () => {
            tear.tearBeforeRenameLands = true;
            // Above the rename retry budget, so every attempt of the re-issue is
            // answered with the generic failure rather than the last one landing.
            party.srv.inject.renameFailuresRemaining = 10;
          });
          party.srv.inject.renameFailuresRemaining = 0;
          expect(refused.error).not.toBeInstanceOf(
            TransportPublishIndeterminateError,
          );
          expect((refused.error as Error).message).toContain("_rename");
          await expect(party.adapter.exists(refused.source)).resolves.toBe(
            true,
          );
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      // Every arm's tear was a real drop the adapter recovered from, so no
      // outcome above is one the staging failed to produce.
      expect(party.adapter.midExchangeReconnectCount).toBe(
        LANDED_PUBLISH_REPEATS * 2 + 2,
      );
    } finally {
      tear.reset();
      party.srv.inject.renameFailuresRemaining = 0;
      await party.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

for (const [mode, ephemeralSessions] of [
  ["the held-session mode", false],
  ["connection-per-poll mode", true],
] as const) {
  inProcessOnly(
    `the drop classes that recover today still recover in ${mode}`,
    async () => {
      // The no-regression half, in both modes: the raw-wrapper operations, which
      // are torn by the transport's 'close' rather than its 'end' and so never
      // meet the window above, and a drop that lands on an idle wire BEFORE the
      // operation is issued -- the class whose whole lifecycle sequence has run by
      // the time recovery is reached.
      const party = await connectParty({
        maxReconnectAttempts: 4,
        ephemeralSessions,
      });
      try {
        const controls = party.srv.sessionControls;
        controls.resetHandshakeCount();

        await withCapturedLogs(
          async () => {
            controls.dropActiveAfterOps(1);
            await expect(party.adapter.list(party.remote)).resolves.toEqual([]);

            controls.dropActiveAfterOps(1);
            await expect(
              party.adapter.createExclusive(`${party.remote}/lock-a.json`),
            ).resolves.toBeUndefined();

            // The drop lands with nothing on the wire: the session is already gone
            // when the operation is issued, so it fails at once and the re-dial
            // follows a settled transport.
            controls.dropActiveAfterMs(1);
            await new Promise((resolve) => setTimeout(resolve, 250));
            await expect(
              party.adapter.exists(`${party.remote}/lock-a.json`),
            ).resolves.toBe(true);
          },
          (level) => level === "WARN" || level === "ERROR",
        );

        expect(party.adapter.midExchangeReconnectCount).toBe(3);
        expect(controls.handshakeCount()).toBe(3);
        expect(
          party.dials.filter((dial) => dial.settled === "rejected"),
        ).toEqual([]);
      } finally {
        await party.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
}
