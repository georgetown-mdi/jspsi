import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import { prepareForExchange } from "@psilink/core";
import type { ExchangeDataSpec, LinkageTerms } from "@psilink/core";

import { runProtocol, type ProtocolConnectionConfig } from "../../src/protocol";
import { saveKeyFile } from "../../src/keyFile";

// A clean authenticated exchange completes for both parties; then one party's
// result-CSV write fails (its output path has a missing parent directory) AFTER
// runExchange has returned. runProtocol seals the cross-party abort decision the
// moment the exchange completes, before that purely-local output stage, so the
// failing party writes NO abort marker -- a local, post-exchange I/O fault must
// not tell the peer (whose exchange succeeded) to fail fast. Without the seal the
// failing party's catch would still be armed and would drop an <id>-abort.json
// into the shared directory, at worst converting the peer's success into a
// PeerAbortError while its results sit readable on disk.
//
// This is the complement of abortMarkerExchange.test.ts: there a genuine
// mid-exchange transport fault DOES write a marker (the peer is still waiting on
// the protocol); that fault fires before runExchange returns, so it precedes the
// seal this test exercises.

// 32 zero bytes as base64url (43 chars): a valid shared secret. Both key files
// start from it so the handshake -- which must complete for the connection to
// arm -- succeeds and the exchange runs to completion.
const INITIAL_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// firstName-only terms over a one-row dataset both parties share ("Bob"), so the
// clean exchange computes a real intersection and reaches the output stage on
// both sides (mirrors authenticatedExchange.test.ts).
const baseTerms: Omit<LinkageTerms, "identity"> = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi",
  deduplicate: false,
  output: { expectsOutput: true, shareWithPartner: true },
  linkageFields: [{ name: "firstName", type: "firstName" }],
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
  // throws ENOENT after the exchange completes; Party B's path is valid.
  const [resA, resB] = await Promise.allSettled([
    runProtocol(
      makeConfig(),
      { sharedSecret: INITIAL_SECRET, keyFilePath: keyA },
      preparedFor("Party A"),
      path.join(work, "missing-parent", "a-out.csv"),
      -1,
      "noabort-a",
    ),
    runProtocol(
      makeConfig(),
      { sharedSecret: INITIAL_SECRET, keyFilePath: keyB },
      preparedFor("Party B"),
      path.join(work, "b-out.csv"),
      -1,
      "noabort-b",
    ),
  ]);

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
}, 30_000);
