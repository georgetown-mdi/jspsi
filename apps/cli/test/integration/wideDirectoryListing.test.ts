import fsp from "node:fs/promises";
import path from "node:path";

import { expect } from "vitest";
import {
  DirectoryListingBoundsError,
  TransportOperationStalledError,
  sanitizeErrorForDisplay,
} from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import {
  MAX_DIRECTORY_ENTRIES,
  MAX_FILENAME_LENGTH,
  MAX_LISTING_READDIR_BATCHES,
} from "../../src/connection/listingGuard";
import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import {
  READDIR_BATCH_BUDGET_BYTES,
  startInProcessSftpServer,
} from "../sftpServer";
import { serverAuth } from "../sftpServer/testContext";
import { inProcessOnly } from "../sftpBackendGate";

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
// Each of the three enforced bounds is then driven one step PAST, where the
// adapter refuses instead of enumerating: an entry too many, a served name a
// character too long, and a flood of batches that carry neither an entry nor
// end-of-directory. Being able to serve the bound is what makes crossing it a
// measurement of the refusal rather than of the backend.
//
// Only the in-process backend exposes the batch knob and the server-side request
// meter these read (see test/sftpServer/types.ts), so these run there and stand
// up their own instance.

const TEST_TIMEOUT_MS = 300_000;

// One cap far past what one packet carries, and one comfortably under it. The
// narrow rung holds the cap to being honoured as a cap; the wide one is the
// setting a test author reaches for when it wants the whole listing at once, and
// is where a backend that took the number literally would lose the reply.
const BATCH_CAPS = [512, MAX_DIRECTORY_ENTRIES];

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
  /** The entry names the listing reported, empty where it was refused. */
  listed: string[];
  /** The refusal the listing raised, undefined where it completed. */
  error: unknown;
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
  oversizeName,
  emptyNonEofBatches,
}: {
  count: number;
  nameLength: number;
  batchCap: number;
  /** Served in place of the first READDIR batch, where a case arms one. */
  oversizeName?: string;
  /** Progress-free batches served ahead of the listing, where a case arms them. */
  emptyNonEofBatches?: number;
}): Promise<ListingRun> {
  const srv = await startInProcessSftpServer();
  const adapter = new SSH2SFTPClientAdapter({ verbosity: -1 });
  try {
    const dir = await fsp.mkdtemp(path.join(srv.handle.backingDir, "wide-"));
    const planted = plantedNames(count, nameLength);
    await plant(dir, planted);
    const remote = `${srv.handle.remoteRoot}/${path.basename(dir)}`;
    srv.inject.readdirBatchSize = batchCap;
    const [settled] = await withCapturedLogs(
      async () => {
        await adapter.connect({
          host: srv.handle.host,
          port: srv.handle.port,
          ...serverAuth(srv.handle.usera),
        });
        srv.sessionControls.requests.reset();
        if (oversizeName !== undefined)
          srv.inject.oversizeNameOnNextReaddir = oversizeName;
        if (emptyNonEofBatches !== undefined)
          srv.inject.emptyNonEofReaddirBatches = emptyNonEofBatches;
        return await adapter.list(remote).then(
          (entries) => ({
            listed: entries.map((entry) => entry.name),
            error: undefined as unknown,
          }),
          (error: unknown) => ({ listed: [] as string[], error }),
        );
      },
      () => true,
    );
    return {
      planted,
      ...settled,
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
  "a synthetic name too wide to deliver is refused where it is armed",
  async () => {
    const srv = await startInProcessSftpServer();
    try {
      // The one-entry NAME reply the oversize-name injection writes is packed
      // against the same budget as a real listing batch. A name that overruns it
      // would ride a reply the client refuses fatally, tearing down the session
      // the case was driving, so it is refused in that case's own stack instead.
      expect(() => {
        srv.inject.oversizeNameOnNextReaddir = "x".repeat(
          READDIR_BATCH_BUDGET_BYTES,
        );
      }).toThrow(/NAME batch budget/);
      expect(srv.inject.oversizeNameOnNextReaddir).toBeNull();

      // The width this suite's own uses sit at is nowhere near the budget, and
      // is taken unchanged.
      const overLengthName = "x".repeat(MAX_FILENAME_LENGTH + 1);
      srv.inject.oversizeNameOnNextReaddir = overLengthName;
      expect(srv.inject.oversizeNameOnNextReaddir).toBe(overLengthName);
    } finally {
      await srv.stop();
    }
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

inProcessOnly(
  `a directory one entry past ${MAX_DIRECTORY_ENTRIES} is refused rather than ` +
    `enumerated`,
  async () => {
    // The smallest fixture that crosses the bound: the guard checks the count
    // before it takes each entry, so the entry after the bound is the one
    // refused, and a directory of exactly the bound is the passing case above.
    const run = await driveListing({
      count: MAX_DIRECTORY_ENTRIES + 1,
      nameLength: 24,
      batchCap: 0,
    });

    expect(run.error).toBeInstanceOf(DirectoryListingBoundsError);
    expect(sanitizeErrorForDisplay(run.error)).toContain(
      `contains more than ${MAX_DIRECTORY_ENTRIES} entries`,
    );
    // Refused off the wire rather than after the whole directory was read: the
    // listing gave up mid-stream, so the entries past the bound were never taken
    // into memory.
    expect(run.listed).toEqual([]);
    expect(run.readdirRoundTrips).toBeGreaterThan(1);
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  `a served name one character past ${MAX_FILENAME_LENGTH} is refused`,
  async () => {
    // The name bound is the one an honest filesystem cannot cross -- every
    // mainstream one caps a component at 255 -- so it is reached through the
    // backend's oversize-name injection rather than by planting a file: a
    // synthesized READDIR name is the only way a real server produces one, and
    // it is what the guard exists for.
    const overLength = "x".repeat(MAX_FILENAME_LENGTH + 1);
    const run = await driveListing({
      count: 0,
      nameLength: 24,
      batchCap: 0,
      oversizeName: overLength,
    });

    expect(run.error).toBeInstanceOf(DirectoryListingBoundsError);
    const rendered = sanitizeErrorForDisplay(run.error);
    expect(rendered).toContain(
      `filename is ${overLength.length} characters, exceeding the maximum of ` +
        `${MAX_FILENAME_LENGTH}`,
    );
    // Only a leading slice of the server's name is relayed, so the refusal
    // cannot carry an attacker-sized string onward.
    expect(rendered).not.toContain(overLength);
    expect(run.listed).toEqual([]);
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  `a listing flooded past ${MAX_LISTING_READDIR_BATCHES} progress-free readdir ` +
    `batches is refused`,
  async () => {
    // The round-trip cap is the LIVENESS sibling of the two size bounds above,
    // and the only listing failure a well-formed reply can drive without ever
    // carrying an entry: each batch says "more to come" and delivers nothing, so
    // neither size bound advances and the listing would recurse without end.
    // Armed one batch past the cap, which is the smallest flood that crosses it.
    const run = await driveListing({
      count: 0,
      nameLength: 24,
      batchCap: 0,
      emptyNonEofBatches: MAX_LISTING_READDIR_BATCHES + 1,
    });

    expect(run.error).toBeInstanceOf(TransportOperationStalledError);
    expect(sanitizeErrorForDisplay(run.error)).toContain(
      `made no progress over ${MAX_LISTING_READDIR_BATCHES} readdir round-trips`,
    );
    expect(run.listed).toEqual([]);
    // Counted at the server, which is what says the cap bit where the adapter
    // says it does: the batch past the cap is refused before another readdir
    // goes out, so the flood costs exactly the cap and not one round trip more.
    expect(run.readdirRoundTrips).toBe(MAX_LISTING_READDIR_BATCHES);
  },
  TEST_TIMEOUT_MS,
);
