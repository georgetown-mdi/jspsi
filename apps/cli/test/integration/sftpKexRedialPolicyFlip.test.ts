import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import ssh2 from "ssh2";
import { afterEach, expect, vi } from "vitest";
import {
  FileSyncConnection,
  TransportOperationStalledError,
} from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import { startInProcessSftpServer } from "../sftpServer";
import { serverAuth } from "../sftpServer/testContext";
import { APPENDED_MARKERS, createKexinitRecordingRelay } from "./kexOfferWire";
import type { KexPrimitive } from "../../src/connection/sftpKexCapability";
import { inProcessOnly } from "../sftpBackendGate";

// A live connection-per-poll exchange whose partner's SFTP endpoint changes its
// key-exchange policy underneath it: it accepts the handshake the exchange opens
// on, and from the flip onward offers only key exchanges built on a primitive
// this process cannot perform. What that re-dial's rejection is classified as is
// driven here against the real stack rather than against a stubbed client,
// because the diagnostic REPLACES ssh2's message and keeps ssh2's own one cause
// link down, so only a real dial produces the error that actually arrives at the
// cycle-start re-dial.
//
// Both arms of the classification run, and the ONLY thing that differs between
// them is the platform-capability verdict: the offer on the wire withholds every
// X25519 algorithm either way -- by the capability constraint under a forced
// verdict in one, by the operator's own algorithms.kex under an empty verdict in
// the other -- so the server refuses the identical offer with the identical
// message, and what decides "end the exchange" against "skip this cycle" is the
// verdict alone. Each arm holds that reading of the wire as a check of its own:
// the relay decodes every dial's own SSH_MSG_KEXINIT, so what a cycle-start
// re-dial offered is read from the socket alongside the classification it
// produced.
//
// Why a second listener rather than a control on the suite's own server: measured
// against the pinned ssh2, a Server's `algorithms.kex` is read ONCE, as the
// Server is constructed, and not again per connection -- an accessor on the
// config object fires before the first client arrives and never after -- so a
// listener cannot be told to change its policy mid-exchange. The flip is instead
// a relay that hands later connections to a restricted listener of its own,
// which is the same thing from the client's side: one endpoint, one port, a key
// exchange it agreed on and then would not.
//
// Why the verdict is forced rather than produced by a FIPS host, and what the
// forced verdict models: sftpKexOffer.test.ts, which drives the constrained
// offer itself.

const forcedVerdict = vi.hoisted(() => ({
  unavailable: [] as readonly KexPrimitive[],
}));

// Only the host VERDICT is replaced; the classification, the diagnostic, the
// adapter, and ssh2 are the real ones. It defaults to "this process can perform
// everything", which is the reading any host running this suite supplies on its
// own, so the transient arm inherits the neutral seam and the permanent arm sets
// it.
vi.mock("../../src/connection/sftpKexCapability", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/connection/sftpKexCapability")
    >();
  return {
    ...actual,
    unavailableKexPrimitives: () => forcedVerdict.unavailable,
  };
});

const { SSH2SFTPClientAdapter } =
  await import("../../src/connection/ssh2SftpAdapter");

// Back to the neutral reading between cases, wherever a case left it: a verdict
// one case set and the next inherited would silently decide that case's
// classification for it.
afterEach(() => {
  forcedVerdict.unavailable = [];
});

// In-process, as the connection-per-poll coverage is throughout: a native sshd
// is not driven in that mode, and the one native profile with a key-exchange
// policy of its own -- restricted-crypto -- accepts only what the forced verdict
// withholds, so no dial of this exchange could complete against it.

const FLIP_TEST_TIMEOUT_MS = 120_000;

// The peer-inactivity budget for both arms. Generous, and asserted against
// rather than waited on: the ceiling ending the run is the failure the permanent
// arm exists to rule out, and its error is a different type carrying different
// text.
const PEER_TIMEOUT_MS = 30_000;

// A primitive this process cannot perform, without needing a host that cannot
// perform one -- the same stand-in the capability unit, offer integration, and
// fast-fail unit suites use.
const forcedMissingPrimitive: KexPrimitive = {
  primitive: "X25519",
  matchesAlgorithm: /25519/i,
  perform: () => {
    throw new Error("error:0308010C:digital envelope routines::unsupported");
  },
};

// The offer the transient arm puts on the wire: ssh2's own list minus everything
// built on X25519, expressed exactly as the capability constraint expresses it,
// so the dial the empty verdict classifies is refused for the same reason and
// with the same message as the dial the forced verdict classifies.
const OPERATOR_WITHHELD_X25519 = {
  algorithms: { kex: { remove: [/25519/i] } },
};

// Poll a predicate until it holds, failing if it never does.
async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 60_000, intervalMs = 50, what = "condition" } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor: ${what} not met within timeout`);
}

// Every message in an error's cause chain, so a case can assert which link a
// fragment is on: the diagnostic replaces ssh2's message and keeps it one link
// down, and the exchange's own error handling may add links of its own above.
function chainedMessages(error: unknown): string[] {
  const messages: string[] = [];
  for (
    let link: unknown = error;
    link instanceof Error && messages.length < 10;
    link = link.cause
  )
    messages.push(link.message);
  return messages;
}

/**
 * A listener whose key-exchange policy accepts only `curve25519-sha256` -- every
 * algorithm the forced verdict withholds, and nothing else -- counting the
 * connections that reach it. A real `ssh2.Server`: what a dial meeting this
 * policy produces is ssh2's own negotiation failure, not a message this suite
 * composed.
 */
async function startKexRestrictedListener(): Promise<{
  host: string;
  port: number;
  connections: () => number;
  close: () => Promise<void>;
}> {
  const { Server, utils } = ssh2;
  let connections = 0;
  const server = new Server(
    {
      hostKeys: [utils.generateKeyPairSync("ecdsa", { bits: 256 }).private],
      algorithms: { kex: ["curve25519-sha256"] },
    },
    (client) => {
      connections += 1;
      // The client abandons a handshake it cannot negotiate; that is the point,
      // and it must not reach the process as an unhandled error.
      client.on("error", () => {});
    },
  );
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
  return {
    host: "127.0.0.1",
    port,
    connections: () => connections,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * What every dial through the relay must have carried: the constrained offer,
 * identical from dial to dial. A cycle-start re-dial enters `connectLocked` with
 * the RETAINED connect options, already constrained, so constraining them again
 * has to be a no-op -- a compounded or dropped constraint is an offer differing
 * from the one the exchange opened on.
 */
function expectOneConstrainedOfferThroughout(offers: string[][]): void {
  for (const offer of offers) {
    expect(offer.filter((name) => /25519/i.test(name))).toEqual([]);
    for (const marker of APPENDED_MARKERS) expect(offer).toContain(marker);
  }
  for (const offer of offers.slice(1)) expect(offer).toEqual(offers[0]);
}

inProcessOnly(
  "a cycle-start re-dial into a key exchange this process cannot perform ends " +
    "the exchange at once, naming the primitive",
  async () => {
    forcedVerdict.unavailable = [forcedMissingPrimitive];
    const srv = await startInProcessSftpServer();
    const restricted = await startKexRestrictedListener();
    const relay = createKexinitRecordingRelay(srv.handle);
    const dir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "kex-flip-permanent-"),
    );
    const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
    const sender = new FileSyncConnection(new SSH2SFTPClientAdapter(), {
      verbose: -1,
      pollingFrequency: 10,
    });
    const receiver = new FileSyncConnection(
      new SSH2SFTPClientAdapter({ ephemeralSessions: true }),
      { verbose: -1, pollingFrequency: 10 },
    );
    const failures: unknown[] = [];
    sender.on("error", (err: unknown) => failures.push(err));
    receiver.on("error", (err: unknown) => failures.push(err));

    try {
      // The sender holds one session for the whole exchange and dials the server
      // directly, so the flip governs the polling party's dials alone.
      await sender.open({
        channel: "sftp",
        server: {
          host: srv.handle.host,
          port: srv.handle.port,
          ...serverAuth(srv.handle.usera),
          path: remote,
        },
        options: { peerTimeoutMs: PEER_TIMEOUT_MS },
      });
      await receiver.open({
        channel: "sftp",
        server: {
          host: "127.0.0.1",
          port: await relay.port,
          ...serverAuth(srv.handle.userb),
          path: remote,
        },
        options: { peerTimeoutMs: PEER_TIMEOUT_MS, maxReconnectAttempts: 0 },
      });
      await Promise.all([sender.synchronize(), receiver.synchronize()]);

      const [outcome, logs] = await withCapturedLogs(
        async () => {
          receiver.start();
          // Cycle at least once through the relay first, so what the flip
          // interrupts is a poll loop that was dialing this endpoint happily.
          // Waited out as a re-dial whose own SSH_MSG_KEXINIT the relay
          // DECODED rather than as one it merely accepted: a dial that completes
          // its handshake is the one whose offer can be read at all.
          const offersBeforeStart = relay.offers.length;
          await waitFor(() => relay.offers.length > offersBeforeStart, {
            what: "a cycle-start re-dial's own SSH_MSG_KEXINIT through the relay",
          });
          const offersUpToTheFlip = relay.offers.slice();

          const flippedAt = Date.now();
          relay.pointAt(restricted);
          await waitFor(() => failures.length > 0, {
            what: "the exchange to end",
            timeoutMs: 30_000,
          });
          const endedAfterMs = Date.now() - flippedAt;
          const dialsMeetingTheFlip = restricted.connections();
          // A poll loop that had merely skipped the cycle would dial again on
          // the next tick; several ticks fit in this wait.
          await new Promise((resolve) => setTimeout(resolve, 500));
          return {
            endedAfterMs,
            dialsMeetingTheFlip,
            dialsAfterTheEnd: restricted.connections() - dialsMeetingTheFlip,
            offersUpToTheFlip,
            cycleStartRedials: offersUpToTheFlip.length - offersBeforeStart,
          };
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      // The exchange ended, once, with the diagnostic the operator can act on:
      // the missing primitive and its remedy, over ssh2's own account of the
      // refusal.
      expect(failures).toHaveLength(1);
      const failure = failures[0] as Error;
      expect(failure).toBeInstanceOf(Error);
      const chain = chainedMessages(failure);
      expect(chain[0]).toContain("X25519");
      expect(chain[0]).toContain("server's administrator");
      // ssh2's own account of the refusal is a link DOWN and no longer on the
      // message: what arrives at the cycle-start re-dial is the diagnostic, the
      // fragment the connect loop matches having been replaced by it. A stubbed
      // client cannot produce that ordering, which is why this leg exists.
      expect(chain[0]).not.toContain("no matching key exchange algorithm");
      expect(chain.slice(1).join("\n")).toContain(
        "no matching key exchange algorithm",
      );
      // What ended it was the re-dial and not the peer-inactivity ceiling, which
      // terminates a run with a typed stall error and text of its own.
      expect(failure).not.toBeInstanceOf(TransportOperationStalledError);
      expect(chain.join("\n")).not.toContain("peer-inactivity budget");
      expect(outcome.endedAfterMs).toBeLessThan(PEER_TIMEOUT_MS / 2);
      // One dial met the flipped policy and the exchange was over: it was not
      // retried tick after tick, and nothing was dialed after the end.
      expect(outcome.dialsMeetingTheFlip).toBe(1);
      expect(outcome.dialsAfterTheEnd).toBe(0);
      // What the cycle-start re-dial OFFERED, read off the socket: the dial
      // the exchange opened on and every cycle-start re-dial that completed one
      // carry the same X25519-free offer, both markers included, under the
      // forced verdict this arm classifies on.
      expect(outcome.cycleStartRedials).toBeGreaterThanOrEqual(1);
      expectOneConstrainedOfferThroughout(outcome.offersUpToTheFlip);
      // And that cycle was ended rather than skipped -- the two are the branches
      // this leg separates, and the skip promises a next tick that never comes.
      expect(
        logs.filter((entry) =>
          entry.message.includes("skipping this poll cycle"),
        ),
      ).toEqual([]);
    } finally {
      receiver.stop();
      // Point back before teardown: close() re-dials, and a teardown against the
      // restricted listener would spend its bounds on a handshake that cannot
      // succeed.
      relay.pointAt(srv.handle);
      await receiver.close().catch(() => {});
      await sender.close().catch(() => {});
      await relay.close({ destroyLiveSessions: true });
      await restricted.close();
      await fsp.rm(dir, { recursive: true, force: true });
      await srv.stop();
    }
  },
  FLIP_TEST_TIMEOUT_MS,
);

inProcessOnly(
  "the same refusal on a host that can perform everything skips the cycle and " +
    "the exchange survives to the next tick",
  async () => {
    // The verdict is left empty, and the offer is withheld by the operator's own
    // algorithms.kex instead, so the wire is identical to the arm above: the same
    // server refuses the same offer with the same message. The classification is
    // conditioned on the verdict rather than on that message, so this cycle is
    // skipped and the next tick carries the exchange on.
    const srv = await startInProcessSftpServer();
    const restricted = await startKexRestrictedListener();
    const relay = createKexinitRecordingRelay(srv.handle);
    const dir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "kex-flip-transient-"),
    );
    const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
    const sender = new FileSyncConnection(new SSH2SFTPClientAdapter(), {
      verbose: -1,
      pollingFrequency: 10,
    });
    const receiver = new FileSyncConnection(
      new SSH2SFTPClientAdapter({ ephemeralSessions: true }),
      { verbose: -1, pollingFrequency: 10 },
    );
    const failures: unknown[] = [];
    sender.on("error", (err: unknown) => failures.push(err));
    receiver.on("error", (err: unknown) => failures.push(err));

    try {
      await sender.open({
        channel: "sftp",
        server: {
          host: srv.handle.host,
          port: srv.handle.port,
          ...serverAuth(srv.handle.usera),
          path: remote,
        },
        options: { peerTimeoutMs: PEER_TIMEOUT_MS },
      });
      await receiver.open({
        channel: "sftp",
        server: {
          host: "127.0.0.1",
          port: await relay.port,
          ...serverAuth(srv.handle.userb),
          path: remote,
        },
        options: { peerTimeoutMs: PEER_TIMEOUT_MS, maxReconnectAttempts: 0 },
        providerOptions: OPERATOR_WITHHELD_X25519,
      });
      await Promise.all([sender.synchronize(), receiver.synchronize()]);

      const [delivered, logs] = await withCapturedLogs(
        async () => {
          receiver.start();
          const dialsBefore = relay.accepted();
          await waitFor(() => relay.accepted() > dialsBefore, {
            what: "a cycle-start re-dial through the relay",
          });

          relay.pointAt(restricted);
          // More than one cycle has to meet the flipped policy: a single one
          // could be an exchange that ended, and what this measures is a loop
          // still ticking after the refusal.
          await waitFor(
            () => {
              // An exchange ended here leaves nothing to wait for, so report
              // what ended it rather than spending the whole bound on a tick
              // that cannot come.
              if (failures.length > 0) throw failures[0] as Error;
              return restricted.connections() >= 2;
            },
            {
              what: "two cycles refused by the flipped policy",
              timeoutMs: 30_000,
            },
          );
          relay.pointAt(srv.handle);

          const message = new Promise((resolve) =>
            receiver.once("data", resolve),
          );
          await sender.send({ message: "past the refused cycles" });
          const received = await message;
          receiver.stop();
          return received;
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      // The exchange rode the refusals out and delivered on a session dialed
      // after them; nothing surfaced to the caller.
      expect(delivered).toEqual({ message: "past the refused cycles" });
      expect(failures).toEqual([]);
      // Each refused cycle told the operator what it did and what happens next,
      // over ssh2's own message: with nothing unavailable there is no primitive
      // to name and no diagnostic to raise.
      const skipped = logs.filter((entry) =>
        entry.message.includes("ephemeral SFTP re-dial failed"),
      );
      expect(skipped.length).toBeGreaterThanOrEqual(2);
      expect(skipped[0].level).toBe("WARN");
      expect(skipped[0].message).toContain(
        "skipping this poll cycle and retrying on the next tick",
      );
      expect(skipped[0].message).toContain(
        "no matching key exchange algorithm",
      );
      expect(skipped[0].message).not.toContain("X25519");
      // The wire this arm shares with the one above: the operator's own
      // algorithms.kex withheld on every dial what the forced verdict withholds
      // there, so the refusal both arms classify is the same refusal of the same
      // offer.
      expect(relay.offers.length).toBeGreaterThanOrEqual(2);
      expectOneConstrainedOfferThroughout(relay.offers);
    } finally {
      receiver.stop();
      relay.pointAt(srv.handle);
      await receiver.close().catch(() => {});
      await sender.close().catch(() => {});
      await relay.close({ destroyLiveSessions: true });
      await restricted.close();
      await fsp.rm(dir, { recursive: true, force: true });
      await srv.stop();
    }
  },
  FLIP_TEST_TIMEOUT_MS,
);
