import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { prepareForExchange, SHARED_SECRET_REGEX } from "@psilink/core";
import type { ExchangeDataSpec, LinkageTerms } from "@psilink/core";

import {
  runProtocol,
  type AuthPersist,
  type ProtocolConnectionConfig,
} from "../../src/protocol";
import { loadKeyFile, saveKeyFile } from "../../src/keyFile";
import { sftpPort } from "../container/env";

// Net-new coverage: the full authenticated CLI path -- X25519 handshake +
// per-direction AEAD -- driven end to end over both real transports. The other
// integration tests exercise only the file-sync transport; this one drives
// runProtocol (authenticateConnection -> runKex -> EncryptedMessageConnection ->
// runExchange) with real PSI. The load-bearing assertion is that an
// authenticated exchange yields byte-for-byte the SAME PSI result as an
// unauthenticated one over identical data, proving the AEAD layer is transparent
// to the linkage outcome; plus that the shared secret rotates and the rotated
// value drives the next ("recurring") exchange.

const SFTP_PORT = sftpPort();

// 32 zero bytes as base64url (43 chars): a valid shared secret for the first
// exchange. Subsequent exchanges use the rotated value read back from the key
// files.
const INITIAL_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// firstName-only terms over a tiny dataset: the default key templates all
// require SSN/DOB, so an explicit firstName key gives both parties valid,
// matching terms (same approach as saveBootstrap.test.ts).
const baseTerms: Omit<LinkageTerms, "identity"> = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi",
  deduplicate: false,
  output: { expectsOutput: true, shareWithPartner: true },
  linkageFields: [{ name: "firstName", type: "firstName" }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
};

// Unequal dataset sizes make the PSI roles deterministic regardless of which
// party wins the rendezvous race: the smaller dataset always becomes the
// receiver (resolveRole), so "the receiver" is a stable label across runs and
// its output can be compared run-to-run. Intersection: {Bob, Carol}.
const RECEIVER_ROWS = [{ first_name: "Bob" }, { first_name: "Carol" }];
const SENDER_ROWS = [
  { first_name: "Bob" },
  { first_name: "Carol" },
  { first_name: "Dave" },
];

function preparedFor(identity: string, rows: Array<Record<string, string>>) {
  const spec: ExchangeDataSpec = {
    linkageTerms: { ...baseTerms, identity },
  };
  return prepareForExchange(spec, identity, rows, ["first_name"]);
}

// A connection-config factory: given a party's authentication value (a persisted
// shared secret, or null for the unauthenticated baseline) it produces a fully
// typed ProtocolConnectionConfig. Written per channel at the call site so the
// discriminated union narrows correctly.
type ConfigFactory = (auth: AuthPersist | null) => ProtocolConnectionConfig;

// writeOutput closes its write stream without awaiting 'finish', so the file may
// lag a tick behind runProtocol resolving. Poll until it is present and stable.
async function readWhenReady(file: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  let last = "";
  for (;;) {
    try {
      const cur = await fsp.readFile(file, "utf8");
      if (cur.length > 0 && cur === last) return cur;
      last = cur;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (Date.now() > deadline)
      throw new Error(`output file ${file} never stabilized with content`);
    await new Promise<void>((r) => setTimeout(r, 20));
  }
}

// The unauthenticated baseline (authentication: null): same data and roles, no
// handshake and no AEAD. Returns the receiver's output -- the reference PSI
// result the authenticated runs must reproduce.
async function runBaseline(
  work: string,
  makeConfig: ConfigFactory,
): Promise<string> {
  const outR = path.join(work, "baseline-receiver-out.csv");
  const outS = path.join(work, "baseline-sender-out.csv");
  await Promise.all([
    runProtocol(
      makeConfig(null),
      preparedFor("Receiver", RECEIVER_ROWS),
      outR,
      -1,
      "baseline-receiver",
    ),
    runProtocol(
      makeConfig(null),
      preparedFor("Sender", SENDER_ROWS),
      outS,
      -1,
      "baseline-sender",
    ),
  ]);
  return readWhenReady(outR);
}

interface PairResult {
  /** The receiver party's output CSV (the side that learns the intersection). */
  receiverOut: string;
  /** The rotated secret, identical on both key files after the exchange. */
  rotated: string;
}

// Runs one authenticated exchange between two parties. The receiver is the party
// with the smaller dataset. Both key files start from the same secret (required
// for the handshake to succeed); each rotates to the same new value.
async function runAuthenticatedPair(
  work: string,
  tag: string,
  makeConfig: ConfigFactory,
  secret: string,
): Promise<PairResult> {
  const keyR = path.join(work, `${tag}-receiver.key`);
  const keyS = path.join(work, `${tag}-sender.key`);
  saveKeyFile(keyR, { sharedSecret: secret });
  saveKeyFile(keyS, { sharedSecret: secret });
  const outR = path.join(work, `${tag}-receiver-out.csv`);
  const outS = path.join(work, `${tag}-sender-out.csv`);

  await Promise.all([
    runProtocol(
      makeConfig({ sharedSecret: secret, keyFilePath: keyR }),
      preparedFor("Receiver", RECEIVER_ROWS),
      outR,
      -1,
      `${tag}-receiver`,
    ),
    runProtocol(
      makeConfig({ sharedSecret: secret, keyFilePath: keyS }),
      preparedFor("Sender", SENDER_ROWS),
      outS,
      -1,
      `${tag}-sender`,
    ),
  ]);

  const rotatedR = loadKeyFile(keyR)?.sharedSecret;
  const rotatedS = loadKeyFile(keyS)?.sharedSecret;
  expect(rotatedR).toBeDefined();
  // Both parties independently derive the same rotated secret from the shared
  // session key.
  expect(rotatedR).toBe(rotatedS);
  expect(rotatedR).toMatch(SHARED_SECRET_REGEX);
  expect(rotatedR).not.toBe(secret);

  return { receiverOut: await readWhenReady(outR), rotated: rotatedR! };
}

let work: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-auth-integ-"));
});

afterAll(() => {
  // beforeEach dirs live under os.tmpdir(); the OS reclaims them, but remove the
  // last one explicitly to be tidy.
  try {
    if (work) fs.rmSync(work, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

test("filedrop: authenticated recurring exchange matches the unauthenticated PSI result and rotates the secret", async () => {
  const filedrop =
    (dropDir: string): ConfigFactory =>
    (auth) => ({
      channel: "filedrop",
      path: dropDir,
      options: { pollIntervalMs: 1 },
      authentication: auth,
    });

  // Baseline over its own drop directory.
  const baseline = await runBaseline(
    work,
    filedrop(fs.mkdtempSync(path.join(work, "base-drop-"))),
  );
  // A real intersection occurred: the receiver has a header plus one row per
  // matched name ({Bob, Carol}).
  expect(baseline.trim().split("\n").length).toBe(1 + RECEIVER_ROWS.length);

  // First authenticated exchange (handshake + AEAD) over its own drop directory.
  const run1 = await runAuthenticatedPair(
    work,
    "run1",
    filedrop(fs.mkdtempSync(path.join(work, "auth-drop1-"))),
    INITIAL_SECRET,
  );
  // AEAD is transparent to the linkage outcome: identical to the cleartext run.
  expect(run1.receiverOut).toBe(baseline);

  // Recurring: the rotated secret from run 1 drives a second authenticated
  // exchange, which must still authenticate and yield the same PSI result while
  // rotating again to a fresh value.
  const run2 = await runAuthenticatedPair(
    work,
    "run2",
    filedrop(fs.mkdtempSync(path.join(work, "auth-drop2-"))),
    run1.rotated,
  );
  expect(run2.receiverOut).toBe(baseline);
  expect(run2.rotated).not.toBe(run1.rotated);
}, 30_000);

// --- SFTP ---------------------------------------------------------------------

// compose.yaml mounts apps/cli/test/container/sftp/srv/ as /home/{user}/psi, so
// srv/authexchange is served at /psi/authexchange over SFTP. Both parties are
// SFTP clients of the same path -- the realistic recurring-exchange topology.
const SFTP_LOCAL_DIRECTORY = "test/container/sftp/srv/authexchange";
const SFTP_PATH = "/psi/authexchange";

async function cleanSftpDir() {
  await fsp.mkdir(SFTP_LOCAL_DIRECTORY, { recursive: true });
  for (const file of await fsp.readdir(SFTP_LOCAL_DIRECTORY)) {
    try {
      await fsp.unlink(path.join(SFTP_LOCAL_DIRECTORY, file));
    } catch {
      // ignore
    }
  }
}

const sftp: ConfigFactory = (auth) => ({
  channel: "sftp",
  server: {
    host: "localhost",
    port: SFTP_PORT,
    username: "usera",
    password: "usera",
    path: SFTP_PATH,
  },
  options: { pollIntervalMs: 50 },
  authentication: auth,
});

beforeAll(cleanSftpDir);

test("sftp: authenticated recurring exchange over the real server matches the unauthenticated PSI result and rotates the secret", async () => {
  const baseline = await runBaseline(work, sftp);
  expect(baseline.trim().split("\n").length).toBe(1 + RECEIVER_ROWS.length);

  await cleanSftpDir();

  const run1 = await runAuthenticatedPair(work, "sftp1", sftp, INITIAL_SECRET);
  expect(run1.receiverOut).toBe(baseline);

  await cleanSftpDir();

  // Recurring: the rotated secret from run 1 drives a second authenticated
  // exchange over the real server, which must still authenticate and yield the
  // same PSI result while rotating again to a fresh value.
  const run2 = await runAuthenticatedPair(work, "sftp2", sftp, run1.rotated);
  expect(run2.receiverOut).toBe(baseline);
  expect(run2.rotated).not.toBe(run1.rotated);

  await cleanSftpDir();
}, 90_000);
