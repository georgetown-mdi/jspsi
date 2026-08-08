import fsp from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";
import { withCapturedLogs } from "@psilink/core/testing";

import {
  MAX_DIRECTORY_ENTRIES,
  MAX_FILENAME_LENGTH,
} from "../../src/connection/listingGuard";
import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { selectedBackend, startInProcessSftpServer } from "../sftpServer";
import { serverAuth } from "../sftpServer/testContext";

// A directory filled to the enforced listing bound is the widest one the adapter
// accepts, so it is the width the test backend has to be able to SERVE before a
// case can drive anything at it. A single SFTP NAME packet does not carry a
// listing that wide, and one too wide never arrives at all, so what is held here
// is that the backend answers such a listing the way a real server does -- over
// as many round trips as it takes -- with no test having to know the batch knob
// or set it to a width that happens to fit.
//
// The knob is driven alongside the default because it is the footgun: a cap
// wider than one packet must still deliver every entry rather than being taken
// literally and losing the reply.
//
// Only the in-process backend exposes the batch knob and the server-side request
// meter these read (see test/sftpServer/types.ts), so these run there and stand
// up their own instance.
const inProcessOnly = test.skipIf(selectedBackend() !== "in-process");

const TEST_TIMEOUT_MS = 300_000;

// Two caps far past what one packet carries, and one comfortably under it. The
// narrow rung holds the cap to being honoured as a cap; the wide ones are the
// settings a test author reaches for when it wants the whole listing at once,
// and are where a backend that took the number literally would lose the reply.
const BATCH_CAPS = [512, MAX_DIRECTORY_ENTRIES, 2 * MAX_DIRECTORY_ENTRIES];

/** `count` distinct filenames of exactly `nameLength` characters each. */
function plantedNames(count: number, nameLength: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const stem = `w${String(index).padStart(6, "0")}`;
    return `${stem.padEnd(nameLength - "-lock.json".length, "x")}-lock.json`;
  });
}

async function plant(dir: string, names: readonly string[]): Promise<void> {
  const perTurn = 512;
  for (let index = 0; index < names.length; index += perTurn)
    await Promise.all(
      names
        .slice(index, index + perTurn)
        .map((name) => fsp.writeFile(path.join(dir, name), "{}")),
    );
}

/** Planted names the listing did not report, so a failure names what was lost. */
function missingFrom(
  planted: readonly string[],
  listed: readonly string[],
): string[] {
  const seen = new Set(listed);
  return planted.filter((name) => !seen.has(name));
}

interface ListingRun {
  planted: string[];
  listed: string[];
  readdirRoundTrips: number;
}

/**
 * Plant `count` names of `nameLength` characters, list the directory through the
 * production adapter under the given batch cap, and report what came back
 * alongside the READDIR round trips the SERVER counted -- the end that owns the
 * batching, rather than the client library's view of it.
 */
async function driveListing({
  count,
  nameLength,
  batchCap,
}: {
  count: number;
  nameLength: number;
  batchCap: number;
}): Promise<ListingRun> {
  const srv = await startInProcessSftpServer();
  const adapter = new SSH2SFTPClientAdapter({ verbosity: -1 });
  try {
    const dir = await fsp.mkdtemp(path.join(srv.handle.backingDir, "wide-"));
    const planted = plantedNames(count, nameLength);
    await plant(dir, planted);
    const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
    srv.inject.readdirBatchSize = batchCap;
    const [listed] = await withCapturedLogs(
      async () => {
        await adapter.connect({
          host: srv.handle.host,
          port: srv.handle.port,
          ...serverAuth(srv.handle.usera),
        });
        srv.sessionControls.requests.reset();
        return (await adapter.list(remote)).map((entry) => entry.name);
      },
      () => true,
    );
    return {
      planted,
      listed,
      readdirRoundTrips:
        srv.sessionControls.requests.read().receivedByOp.READDIR ?? 0,
    };
  } finally {
    await adapter.end().catch(() => {});
    await srv.stop();
  }
}

inProcessOnly(
  `a full ${MAX_DIRECTORY_ENTRIES}-entry directory lists with no batch cap set`,
  async () => {
    const run = await driveListing({
      count: MAX_DIRECTORY_ENTRIES,
      nameLength: 24,
      batchCap: 0,
    });

    expect(missingFrom(run.planted, run.listed)).toEqual([]);
    expect(run.listed).toHaveLength(MAX_DIRECTORY_ENTRIES);
    // Over several round trips rather than one, which is what says the listing
    // was batched to fit the wire instead of arriving by luck at this width.
    expect(run.readdirRoundTrips).toBeGreaterThan(1);
  },
  TEST_TIMEOUT_MS,
);

for (const batchCap of BATCH_CAPS)
  inProcessOnly(
    `a batch cap of ${batchCap} loses no entry of a full listing`,
    async () => {
      const run = await driveListing({
        count: MAX_DIRECTORY_ENTRIES,
        nameLength: 24,
        batchCap,
      });

      expect(missingFrom(run.planted, run.listed)).toEqual([]);
      expect(run.listed).toHaveLength(MAX_DIRECTORY_ENTRIES);
      // The cap is honoured as a cap -- no batch carries more than it -- and a
      // cap wider than one packet is overridden by what the packet carries, so
      // either way the listing cannot have come back in fewer round trips.
      expect(run.readdirRoundTrips).toBeGreaterThanOrEqual(
        Math.max(2, Math.ceil(MAX_DIRECTORY_ENTRIES / batchCap)),
      );
    },
    TEST_TIMEOUT_MS,
  );

inProcessOnly(
  `a full listing of ${MAX_FILENAME_LENGTH}-character names arrives whole`,
  async () => {
    // The widest entries the adapter accepts at the widest listing it accepts:
    // several times the bytes per entry of the case above, at the same entry
    // count. A backend batching on entry count alone rather than on what the
    // packet carries passes that one and loses this.
    const run = await driveListing({
      count: MAX_DIRECTORY_ENTRIES,
      nameLength: MAX_FILENAME_LENGTH,
      batchCap: 0,
    });

    expect(missingFrom(run.planted, run.listed)).toEqual([]);
    expect(run.listed).toHaveLength(MAX_DIRECTORY_ENTRIES);
    expect(run.readdirRoundTrips).toBeGreaterThan(1);
  },
  TEST_TIMEOUT_MS,
);
