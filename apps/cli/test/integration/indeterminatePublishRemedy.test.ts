import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect } from "vitest";
import {
  DISPLAY_TRUNCATION_MARKER,
  TransportPublishIndeterminateError,
  UsageError,
  getLogger,
  prepareForExchange,
  sanitizeErrorForDisplay,
} from "@psilink/core";
import type { ExchangeDataSpec, LinkageTerms } from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import { runProtocol, type ProtocolConnectionConfig } from "../../src/protocol";
import { loadKeyFile, saveKeyFile } from "../../src/keyFile";
import { startInProcessSftpServer } from "../sftpServer";
import { serverAuth } from "../sftpServer/testContext";
import type { InProcessSftpServer } from "../sftpServer/types";
import { inProcessOnly } from "../sftpBackendGate";

// What an operator is told after a mid-exchange message publish the transport
// could not settle, and whether what they are told works.
//
// inflightDropExchange.test.ts pins the two FileSyncConnections' side of that
// divergence. This file drives the whole CLI protocol -- two authenticated
// runProtocol parties over the real server -- because two things only exist at
// that level. The first is the composed operator output: runProtocol emits its
// own generic post-handshake advisory alongside the rendered terminal error
// unless that error suppresses it, and the advisory prescribes a plain retry.
// The second is whether a plain retry works: the answer is measured here, in the
// same directory the failed attempt left behind, rather than asserted.
//
// Only the in-process backend can tear a RENAME at a named point inside its
// handler (see test/sftpServer/types.ts), so this runs there against its own
// server instance.

const TEST_TIMEOUT_MS = 120_000;

// 32 zero bytes as base64url: the first exchange's shared secret. Every later
// attempt reads whatever the previous one rotated onto disk, which is what
// "retry without re-inviting" means.
const INITIAL_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// Bounds how long a party waits on a peer that has already failed, so a failed
// attempt reports in seconds rather than spending the one-hour production
// default.
const PEER_TIMEOUT_MS = 45_000;

// The advisory runProtocol emits for an untagged post-handshake failure. It
// prescribes a plain retry, which the retry attempt below measures against this
// condition, so the failing attempt must not print it.
const GENERIC_RETRY_ADVISORY = "Retry the exchange without re-inviting";

// The recovery the failing attempt does prescribe, and the one the retry
// attempt's outcome vindicates.
const REMEDY =
  "Re-run the exchange in a clean directory; both parties must start the new " +
  "exchange fresh.";

const baseTerms: Omit<LinkageTerms, "identity"> = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  deduplicate: false,
  output: { expectsOutput: true, shareWithPartner: true },
  linkageFields: [{ name: "firstName", type: "first_name" }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
};

// Unequal sizes fix the PSI roles regardless of who wins the rendezvous race, so
// "receiver" and "sender" are stable labels across attempts.
const RECEIVER_ROWS = [{ first_name: "Bob" }, { first_name: "Carol" }];
const SENDER_ROWS = [
  { first_name: "Bob" },
  { first_name: "Carol" },
  { first_name: "Dave" },
];

function preparedFor(identity: string, rows: Array<Record<string, string>>) {
  const spec: ExchangeDataSpec = { linkageTerms: { ...baseTerms, identity } };
  return prepareForExchange(spec, identity, rows, ["first_name"]);
}

interface PartyOutcome {
  party: string;
  ok: boolean;
  error?: unknown;
  /** Exactly what exitWithError renders for this party's terminal error. */
  rendered?: string;
  /** The exit code the exchange handler would use for it. */
  exitCode?: number;
}

interface AttemptOutcome {
  parties: PartyOutcome[];
  /** Every operator-visible line the attempt produced, in emission order. */
  logs: string[];
  /** The destination of the RENAME the server tore, when the attempt staged one. */
  tornDestination: string | undefined;
}

interface AttemptOptions {
  srv: InProcessSftpServer;
  remoteDir: string;
  work: string;
  tag: string;
  keyFiles: { receiver: string; sender: string };
  /**
   * Armed once BOTH parties have completed their handshake, so the tear lands on
   * a PSI message publish rather than on a rendezvous or handshake write, and
   * lands where the generic advisory's own precondition (a rotated token) holds.
   */
  stageOnceAuthenticated?: (srv: InProcessSftpServer) => void;
}

/**
 * One attempt at the exchange: both parties run runProtocol concurrently against
 * `remoteDir` with the key files exactly as they are on disk, and every terminal
 * error is rendered and logged the way the CLI's exitWithError does, so the
 * captured lines are the operator's stderr rather than a reconstruction of it.
 */
async function runAttempt(options: AttemptOptions): Promise<AttemptOutcome> {
  const { srv, remoteDir, work, tag, keyFiles } = options;
  const serverBlock = (
    party: (typeof srv.handle)["usera"],
  ): ProtocolConnectionConfig => ({
    channel: "sftp",
    server: {
      host: srv.handle.host,
      port: srv.handle.port,
      ...serverAuth(party),
      path: remoteDir,
    },
    options: { pollIntervalMs: 50, peerTimeoutMs: PEER_TIMEOUT_MS },
  });

  const outR = path.join(work, `${tag}-receiver-out.csv`);
  const outS = path.join(work, `${tag}-sender-out.csv`);
  const secretR = loadKeyFile(keyFiles.receiver)!.sharedSecret;
  const secretS = loadKeyFile(keyFiles.sender)!.sharedSecret;

  let authenticated = 0;
  const onAuthenticated = () => {
    authenticated += 1;
    if (authenticated === 2) options.stageOnceAuthenticated?.(srv);
  };

  const settle = async (
    party: string,
    run: Promise<unknown>,
  ): Promise<PartyOutcome> => {
    try {
      await run;
      return { party, ok: true };
    } catch (error: unknown) {
      // exitWithError's two observable effects, minus the process.exit.
      const rendered = sanitizeErrorForDisplay(error);
      getLogger(`${tag}-${party}`).error(rendered);
      return {
        party,
        ok: false,
        error,
        rendered,
        exitCode: error instanceof UsageError ? 64 : 69,
      };
    }
  };

  const [parties, logs] = await withCapturedLogs(
    async () => {
      const receiver = runProtocol({
        connection: serverBlock(srv.handle.usera),
        auth: { sharedSecret: secretR, keyFilePath: keyFiles.receiver },
        prepared: preparedFor("Receiver", RECEIVER_ROWS),
        output: outR,
        verbosity: -1,
        loggerName: `${tag}-receiver`,
        onAuthenticated,
      });
      const sender = runProtocol({
        connection: serverBlock(srv.handle.userb),
        auth: { sharedSecret: secretS, keyFilePath: keyFiles.sender },
        prepared: preparedFor("Sender", SENDER_ROWS),
        output: outS,
        verbosity: -1,
        loggerName: `${tag}-sender`,
        onAuthenticated,
      });
      // Both settlements are attached before either is awaited, so a party that
      // rejects while the other is still running is never an unhandled rejection.
      const settled = [settle("receiver", receiver), settle("sender", sender)];
      return [await settled[0], await settled[1]];
    },
    (level) => level === "WARN" || level === "ERROR",
  );

  const tornDestination = srv.sessionControls.renameTear.tornDestination;
  srv.sessionControls.renameTear.reset();
  return {
    parties,
    logs: logs.map((entry) => entry.message),
    tornDestination,
  };
}

inProcessOnly(
  "a message publish the transport could not settle prescribes the restart " +
    "that works, and only that one",
  async () => {
    const srv = await startInProcessSftpServer();
    const work = fs.mkdtempSync(
      path.join(os.tmpdir(), "psilink-undetermined-"),
    );
    try {
      const keyFiles = {
        receiver: path.join(work, "receiver.key"),
        sender: path.join(work, "sender.key"),
      };
      saveKeyFile(keyFiles.receiver, { sharedSecret: INITIAL_SECRET });
      saveKeyFile(keyFiles.sender, { sharedSecret: INITIAL_SECRET });

      const shared = "undetermined-publish";
      await fsp.mkdir(path.join(srv.handle.backingDir, shared), {
        recursive: true,
      });

      // The publish lands durably at the server and its destination is consumed
      // by the partner before the publishing party's landed-confirmation probe of
      // that same path is served, which is what leaves that party reading exactly
      // what a publish that never landed reads.
      const first = await runAttempt({
        srv,
        remoteDir: `${srv.handle.remoteRoot}/${shared}`,
        work,
        tag: "first",
        keyFiles,
        stageOnceAuthenticated: (server) => {
          const tear = server.sessionControls.renameTear;
          tear.reset();
          tear.tearAfterRenameLands = true;
          tear.holdProbeUntilDestinationConsumed = true;
        },
      });

      // The staging really produced the condition, and produced it on a MESSAGE
      // publish: a message's name ends in its byte count, where every other
      // publish this exchange makes ends in a word token.
      expect(first.tornDestination).toMatch(/-\d+\.json$/);
      const publisher = first.parties.find((party) =>
        causeChain(party.error).some(
          (link) => link instanceof TransportPublishIndeterminateError,
        ),
      );
      expect(publisher).toBeDefined();
      // A transport-availability failure, not a local usage error.
      expect(publisher!.exitCode).toBe(69);

      // The advisory's own precondition, so its absence below cannot pass
      // vacuously: it fires on a post-handshake failure whose token was already
      // rotated, and both key files hold a rotated value after this attempt.
      for (const keyFile of Object.values(keyFiles))
        expect(loadKeyFile(keyFile)!.sharedSecret).not.toBe(INITIAL_SECRET);

      // Everything the operator sees, in the order stderr carries it: the
      // advisory runProtocol would emit, then the rendered terminal error. It is
      // absent only because the error suppresses it, which is what keeps the
      // operator from being given two recoveries. Read from the party the tear
      // landed on, which is whichever one was publishing when the cut fell rather
      // than a fixed side.
      const publisherOutput = first.logs
        .filter((message) => message.includes(`first-${publisher!.party}`))
        .join("\n");
      expect(publisherOutput).toContain(publisher!.rendered);
      expect(publisherOutput).not.toContain(GENERIC_RETRY_ADVISORY);
      expect(first.logs.join("\n")).not.toContain(GENERIC_RETRY_ADVISORY);

      // The remedy reaches the operator whole. Asserted at the rendering
      // boundary, which caps each link of the cause chain: the tag above is what
      // makes this the only next step printed, so a remedy falling past the cap
      // would leave no next step at all.
      const [publishLink, ...causeLinks] =
        publisher!.rendered!.split("\ncaused by: ");
      expect(publishLink).toContain(
        "the message may or may not have reached the partner",
      );
      expect(publishLink).toContain(REMEDY);
      expect(publishLink).not.toContain(DISPLAY_TRUNCATION_MARKER);
      // The transport's own rejection keeps its own link and its own budget, so
      // the destination and the SFTP status are still there.
      expect(causeLinks.join("\n")).toContain("Destination:");
      expect(causeLinks.join("\n")).toContain("_rename");

      // What the suppressed advisory would have prescribed, measured: a plain
      // retry, same directory, no re-invite, both parties on the token the failed
      // attempt rotated. In THIS shape of the condition the torn publish's
      // destination was consumed before the tear, so the failed party's abort
      // marker is the only residue -- asserted, so the retry below is measured
      // against a known directory -- and entry recognize-and-sweeps a leftover
      // marker under any id, leaving both parties a clean slate to run a whole
      // fresh exchange on.
      const residue = await fsp.readdir(
        path.join(srv.handle.backingDir, shared),
      );
      expect(residue).toHaveLength(1);
      expect(residue[0]).toMatch(/-abort\.json$/);
      const retry = await runAttempt({
        srv,
        remoteDir: `${srv.handle.remoteRoot}/${shared}`,
        work,
        tag: "retry",
        keyFiles,
      });
      expect(retry.parties.filter((party) => !party.ok)).toEqual([]);
      expect(
        (await fsp.readFile(path.join(work, "retry-receiver-out.csv"), "utf8"))
          .trim()
          .split("\n"),
      ).toHaveLength(1 + RECEIVER_ROWS.length);

      // That success does not make a retry the recovery to prescribe: the
      // publishing party cannot tell this shape from the one where its message
      // landed and was NOT consumed, which leaves that message in the directory
      // for the clean-entry guard to refuse. That arm is the sibling case below,
      // driven rather than argued. So the remedy names a clean directory, which
      // works whichever shape the publish was in: both parties fresh, carrying
      // the same key files forward.
      const clean = "undetermined-publish-clean";
      await fsp.mkdir(path.join(srv.handle.backingDir, clean), {
        recursive: true,
      });
      const restart = await runAttempt({
        srv,
        remoteDir: `${srv.handle.remoteRoot}/${clean}`,
        work,
        tag: "restart",
        keyFiles,
      });
      expect(restart.parties.filter((party) => !party.ok)).toEqual([]);
      expect(
        (
          await fsp.readFile(
            path.join(work, "restart-receiver-out.csv"),
            "utf8",
          )
        )
          .trim()
          .split("\n"),
      ).toHaveLength(1 + RECEIVER_ROWS.length);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

/** The error and every error it was caused by, outermost first. */
function causeChain(error: unknown): Error[] {
  const chain: Error[] = [];
  const seen = new Set<unknown>();
  let cursor: unknown = error;
  while (cursor instanceof Error && !seen.has(cursor)) {
    seen.add(cursor);
    chain.push(cursor);
    cursor = cursor.cause;
  }
  return chain;
}

inProcessOnly(
  "a torn publish left UNCONSUMED is refused at entry by a plain retry, and a " +
    "clean directory runs",
  async () => {
    // The other arm of the same indeterminate publish, and the one the
    // clean-directory remedy exists for. Here the publish landed and was NOT
    // consumed, so its message file is still in the directory: the entry guard
    // refuses it on both sides -- the widened abort-marker sweep matches only the
    // control grammar, so a leftover MESSAGE is untouched by it -- which is why a
    // plain retry is not the remedy and a restart in a clean directory is.
    const srv = await startInProcessSftpServer();
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-unconsumed-"));
    try {
      const keyFiles = {
        receiver: path.join(work, "receiver.key"),
        sender: path.join(work, "sender.key"),
      };
      saveKeyFile(keyFiles.receiver, { sharedSecret: INITIAL_SECRET });
      saveKeyFile(keyFiles.sender, { sharedSecret: INITIAL_SECRET });

      const shared = "unconsumed-publish";
      await fsp.mkdir(path.join(srv.handle.backingDir, shared), {
        recursive: true,
      });

      const first = await runAttempt({
        srv,
        remoteDir: `${srv.handle.remoteRoot}/${shared}`,
        work,
        tag: "first",
        keyFiles,
        stageOnceAuthenticated: (server) => {
          const tear = server.sessionControls.renameTear;
          tear.reset();
          // The publish lands durably, the connection goes before its reply, and
          // the landed-confirmation probe of that same destination cannot settle
          // it either way -- the state a probe torn, expired, or refused on a
          // dead session reaches, staged deterministically here.
          tear.tearAfterRenameLands = true;
          tear.refuseProbeOfTornDestination = true;
          // ... and the partner's consume-delete of that destination is
          // acknowledged without being performed, so the message it read is left
          // where a run whose abort marker beat the partner's next poll would
          // have left it.
          tear.preserveTornDestinationOnRemove = true;
        },
      });

      // The staging produced the condition on a MESSAGE publish, and the
      // publishing party got the undetermined outcome rather than a determined
      // failure.
      expect(first.tornDestination).toMatch(/-\d+\.json$/);
      const publisher = first.parties.find((party) =>
        causeChain(party.error).some(
          (link) => link instanceof TransportPublishIndeterminateError,
        ),
      );
      expect(publisher).toBeDefined();
      expect(publisher!.exitCode).toBe(69);
      expect(publisher!.rendered).toContain(REMEDY);

      // The residue this arm leaves, asserted BEFORE the retry so that retry is
      // measured against a known directory: the message file the publish landed,
      // plus whatever abort marker the failing party wrote.
      const tornName = first.tornDestination!.split("/").pop()!;
      const residue = await fsp.readdir(
        path.join(srv.handle.backingDir, shared),
      );
      expect(residue).toContain(tornName);
      expect(residue.filter((name) => !name.endsWith("-abort.json"))).toEqual([
        tornName,
      ]);

      // The plain retry the generic advisory would have prescribed: refused at
      // entry by BOTH parties, terminally and with the leftover message named.
      const retry = await runAttempt({
        srv,
        remoteDir: `${srv.handle.remoteRoot}/${shared}`,
        work,
        tag: "retry",
        keyFiles,
      });
      expect(retry.parties.map((party) => party.exitCode)).toEqual([64, 64]);
      for (const party of retry.parties) {
        // Rendered through the real renderer, which walks the cause chain: the
        // refusal sentence and its recovery step are the UsageError's own
        // message and the offending filenames are a link below it, so an
        // assertion against `.message` alone would not find the name.
        expect(party.rendered).toContain(tornName);
        expect(party.rendered).toContain("--sweep-exchange-files");
      }
      // The directory is untouched by the refusal, so the operator still has the
      // file the message went into.
      expect(
        await fsp.readdir(path.join(srv.handle.backingDir, shared)),
      ).toContain(tornName);

      // And the remedy the publish actually prescribed works: both parties
      // fresh in a clean directory, carrying the same key files forward.
      const clean = "unconsumed-publish-clean";
      await fsp.mkdir(path.join(srv.handle.backingDir, clean), {
        recursive: true,
      });
      const restart = await runAttempt({
        srv,
        remoteDir: `${srv.handle.remoteRoot}/${clean}`,
        work,
        tag: "restart",
        keyFiles,
      });
      expect(restart.parties.filter((party) => !party.ok)).toEqual([]);
      expect(
        (
          await fsp.readFile(
            path.join(work, "restart-receiver-out.csv"),
            "utf8",
          )
        )
          .trim()
          .split("\n"),
      ).toHaveLength(1 + RECEIVER_ROWS.length);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);
