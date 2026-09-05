import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import { prepareForExchange } from "@psilink/core";
import type { ExchangeDataSpec, LinkageTerms } from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import {
  runProtocol,
  type ProtocolConnectionConfig,
} from "../../../src/protocol";
import { saveKeyFile } from "../../../src/keyFile";

// A clean authenticated exchange completes for both parties; then one party's
// result-CSV write fails (missing parent directory) AFTER runExchange has
// returned. runProtocol seals the cross-party abort decision the moment the
// exchange completes, before that local output stage, so the failing party
// writes NO abort marker: a local, post-exchange I/O fault must not tell the
// peer (whose exchange succeeded) to fail fast.
//
// This is the complement of ../abortMarkerExchange.test.ts: there a genuine
// mid-exchange transport fault DOES write a marker (the peer is still waiting on
// the protocol); that fault fires before runExchange returns, so it precedes the
// seal this test exercises.

// 32 zero bytes as base64url (43 chars): a valid shared secret. Both key files
// start from it so the handshake -- which must complete for the connection to
// arm -- succeeds and the exchange runs to completion.
const INITIAL_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// firstName-only terms over a one-row dataset both parties share ("Bob"), so the
// clean exchange computes a real intersection and reaches the output stage on
// both sides (mirrors ../authenticatedExchange.test.ts).
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

function preparedFor(identity: string) {
  const spec: ExchangeDataSpec = {
    linkageTerms: { ...baseTerms, identity },
  };
  return prepareForExchange(
    spec,
    identity,
    [{ first_name: "Bob" }],
    ["first_name"],
  );
}

let work: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-noabort-integ-"));
});

afterEach(() => {
  try {
    if (work) fs.rmSync(work, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

test("a result-write failure after a completed exchange writes no abort marker", async () => {
  const dropDir = fs.mkdtempSync(path.join(work, "drop-"));
  const keyA = path.join(work, "a.key");
  const keyB = path.join(work, "b.key");
  saveKeyFile(keyA, { sharedSecret: INITIAL_SECRET });
  saveKeyFile(keyB, { sharedSecret: INITIAL_SECRET });

  const makeConfig = (): ProtocolConnectionConfig => ({
    channel: "filedrop",
    path: dropDir,
    options: { pollIntervalMs: 1, peerTimeoutMs: 20_000 },
  });

  // Party A's output path has a missing parent directory, so its writeOutput
  // throws ENOENT after the exchange completes; Party B's path is valid. Party
  // A's token rotated before that local failure, so runProtocol emits a
  // recovery advisory at ERROR; run both parties under withCapturedLogs so
  // that intended line is captured below rather than leaked to the suite
  // console.
  const [settled, capturedLogs] = await withCapturedLogs(
    () =>
      Promise.allSettled([
        runProtocol({
          connection: makeConfig(),
          auth: { sharedSecret: INITIAL_SECRET, keyFilePath: keyA },
          prepared: preparedFor("Party A"),
          output: path.join(work, "missing-parent", "a-out.csv"),
          verbosity: -1,
          loggerName: "noabort-a",
        }),
        runProtocol({
          connection: makeConfig(),
          auth: { sharedSecret: INITIAL_SECRET, keyFilePath: keyB },
          prepared: preparedFor("Party B"),
          output: path.join(work, "b-out.csv"),
          verbosity: -1,
          loggerName: "noabort-b",
        }),
      ]),
    (level) => level === "WARN" || level === "ERROR",
  );
  const [resA, resB] = settled;

  // A failed on its local output write -- specifically the ENOENT from the
  // missing parent directory, not some masked earlier fault -- while B completed
  // the exchange unaffected.
  expect(resA.status).toBe("rejected");
  expect((resA as PromiseRejectedResult).reason).toMatchObject({
    code: "ENOENT",
  });
  expect(resB.status).toBe("fulfilled");

  // The decisive guard: A's post-exchange local failure left no cross-party abort
  // marker in the shared directory (the seal scoped the marker to faults terminal
  // to the exchange itself, not the local output stage that runs after it).
  const markers = (await fsp.readdir(dropDir)).filter((n) =>
    n.endsWith("-abort.json"),
  );
  expect(markers).toEqual([]);

  // B's result was actually written -- it was not poisoned by A's failure.
  expect(fs.existsSync(path.join(work, "b-out.csv"))).toBe(true);

  // Exactly one intended WARN/ERROR fired: A's "rotated before this error"
  // recovery advisory (its token was saved before the post-exchange output
  // write failed). B completed cleanly and emits none. Asserting the captured
  // set proves intent and guards against a different error slipping through.
  expect(capturedLogs).toHaveLength(1);
  expect(capturedLogs[0].message).toContain(
    "The shared secret was already rotated and saved before this error.",
  );
}, 30_000);
