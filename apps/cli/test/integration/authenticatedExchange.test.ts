import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { prepareForExchange, SHARED_SECRET_REGEX } from "@psilink/core";
import type { ExchangeDataSpec, LinkageTerms } from "@psilink/core";

import { runProtocol, type ProtocolConnectionConfig } from "../../src/protocol";
import { loadKeyFile, saveKeyFile } from "../../src/keyFile";
import {
  localPath,
  remotePath,
  serverAuth,
  sftpServer,
} from "../sftpServer/testContext";

// Net-new coverage: the full authenticated CLI path -- X25519 handshake +
// per-direction AEAD -- driven end to end over both real transports. The other
// integration tests exercise only the file-sync transport; this one drives
// runProtocol (authenticateConnection -> runKex -> EncryptedMessageConnection ->
// runExchange) with real PSI. The load-bearing assertion is that an
// authenticated exchange yields byte-for-byte the SAME PSI result as an
// unauthenticated one over identical data, proving the AEAD layer is transparent
// to the linkage outcome; plus that the shared secret rotates and the rotated
// value drives the next ("recurring") exchange.

const srv = sftpServer();

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

// A connection-config factory producing a fully typed ProtocolConnectionConfig.
// Authentication is no longer part of the connection; it is passed to runProtocol
// on its own parameter at the call site. Written per channel so the discriminated
// union narrows correctly.
type ConfigFactory = () => ProtocolConnectionConfig;

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

// The unauthenticated baseline (auth: null): same data and roles, no handshake
// and no AEAD. Returns the receiver's output -- the reference PSI result the
// authenticated runs must reproduce.
async function runBaseline(
  work: string,
  makeConfig: ConfigFactory,
): Promise<string> {
  const outR = path.join(work, "baseline-receiver-out.csv");
  const outS = path.join(work, "baseline-sender-out.csv");
  await Promise.all([
    runProtocol(
      makeConfig(),
      null,
      preparedFor("Receiver", RECEIVER_ROWS),
      outR,
      -1,
      "baseline-receiver",
    ),
    runProtocol(
      makeConfig(),
      null,
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
      makeConfig(),
      { sharedSecret: secret, keyFilePath: keyR },
      preparedFor("Receiver", RECEIVER_ROWS),
      outR,
      -1,
      `${tag}-receiver`,
    ),
    runProtocol(
      makeConfig(),
      { sharedSecret: secret, keyFilePath: keyS },
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

afterEach(() => {
  // Each test gets its own work dir (and nests its drop dirs under it), so a
  // recursive remove after every test cleans up everything it created rather
  // than leaving all but the last for the OS to reclaim.
  try {
    if (work) fs.rmSync(work, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

test("filedrop: authenticated recurring exchange matches the unauthenticated PSI result and rotates the secret", async () => {
  const filedrop =
    (dropDir: string): ConfigFactory =>
    () => ({
      channel: "filedrop",
      path: dropDir,
      options: { pollIntervalMs: 1 },
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

// Grouped so the rendezvous-root lifecycle hooks below scope to the SFTP test
// alone; file-scoped beforeAll/afterAll would otherwise also bracket the
// filedrop test above, which has no business with the SFTP root.
describe("sftp", () => {
  // Both parties are SFTP clients of the same served path -- the realistic
  // recurring-exchange topology. Each phase (baseline -> run1 -> run2) runs in
  // its own subdir under this root, derived from its run tag, so the hello/lock
  // rendezvous namespace is never shared across phases: both parties within a
  // phase share a subdir (so they rendezvous), and distinct phases get distinct
  // subdirs (so they cannot cross-contaminate). Isolation is therefore
  // structural and does not depend on deleting files between phases. The root is
  // the test server's `authexchange` namespace, kept distinct from the sibling
  // integration files' namespaces (sftpConnection -> sftp, mixedConnection ->
  // mixed).
  const SFTP_LOCAL_ROOT = localPath(srv, "authexchange");
  const SFTP_PATH_ROOT = remotePath(srv, "authexchange");

  // A config factory bound to a per-phase server subdir. Creates the host
  // directory the server serves so the SFTP path exists before either party
  // connects (the connection does not create remote directories).
  async function sftpForPhase(tag: string): Promise<ConfigFactory> {
    await fsp.mkdir(path.join(SFTP_LOCAL_ROOT, tag), { recursive: true });
    const serverPath = `${SFTP_PATH_ROOT}/${tag}`;
    return () => ({
      channel: "sftp",
      server: {
        host: srv.host,
        port: srv.port,
        ...serverAuth(srv.usera),
        path: serverPath,
      },
      options: { pollIntervalMs: 50 },
    });
  }

  // Start each run from a clean root so stale files from a previously crashed
  // run cannot leak into a phase subdir; within a run, isolation is the
  // per-phase subdir, not this wipe. afterAll leaves the mounted dir tidy.
  beforeAll(async () => {
    await fsp.rm(SFTP_LOCAL_ROOT, { recursive: true, force: true });
    await fsp.mkdir(SFTP_LOCAL_ROOT, { recursive: true });
  });

  afterAll(async () => {
    await fsp.rm(SFTP_LOCAL_ROOT, { recursive: true, force: true });
  });

  test("sftp: authenticated recurring exchange over the real server matches the unauthenticated PSI result and rotates the secret", async () => {
    const baseline = await runBaseline(work, await sftpForPhase("baseline"));
    expect(baseline.trim().split("\n").length).toBe(1 + RECEIVER_ROWS.length);

    const run1 = await runAuthenticatedPair(
      work,
      "sftp1",
      await sftpForPhase("sftp1"),
      INITIAL_SECRET,
    );
    expect(run1.receiverOut).toBe(baseline);

    // Recurring: the rotated secret from run 1 drives a second authenticated
    // exchange over the real server in its own subdir, which must still
    // authenticate and yield the same PSI result while rotating again to a fresh
    // value.
    const run2 = await runAuthenticatedPair(
      work,
      "sftp2",
      await sftpForPhase("sftp2"),
      run1.rotated,
    );
    expect(run2.receiverOut).toBe(baseline);
    expect(run2.rotated).not.toBe(run1.rotated);
  }, 90_000);
});
