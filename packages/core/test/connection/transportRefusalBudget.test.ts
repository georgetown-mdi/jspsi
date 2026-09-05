import { expect, test } from "vitest";

import type { FileDropConnectionConfig } from "../../src/config/connection";
import { FileSyncConnection } from "../../src/connection/fileSyncConnection";
import type {
  FileInfo,
  FileTransportClient,
} from "../../src/connection/fileSyncConnection";
import { messageFilename } from "../../src/connection/fileSyncMessageLoop";
import { MAX_FRAME_SIZE_BYTES } from "../../src/connection/frameSize";
import {
  DirectoryListingBoundsError,
  FrameSizeExceededError,
  TransportOperationStalledError,
} from "../../src/errors";
import {
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  DEFAULT_MAX_DISPLAY_LENGTH,
} from "../../src/utils/sanitizeForDisplay";
import {
  MAX_ERROR_CAUSE_DEPTH,
  sanitizeErrorForDisplay,
} from "../../src/utils/sanitizeErrorForDisplay";

// The renderer's own cause-link separator, read back out of a two-link render
// rather than restated here, so splitting a rendered chain into its links cannot
// drift from the framing the renderer emits.
const CAUSE_SEPARATOR = sanitizeErrorForDisplay(
  new Error("a", { cause: new Error("b") }),
).slice(1, -1);

const linksOf = (rendered: string): string[] => rendered.split(CAUSE_SEPARATOR);

// A length check, not a marker search: an untruncated first-party fragment
// can end with the same marker by coincidence, but a truncated link is
// always longer than the cap, and an untruncated one is always within it.
const truncatedLinks = (rendered: string): string[] =>
  linksOf(rendered).filter(
    (link) => link.length > COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  );

// The class-uniform recovery step, read off a minimal construction of the
// class rather than restated here: what each site is asserted to deliver is
// then the sentence the class actually holds, and an edit to that sentence
// cannot leave a stale copy passing here.
const recoveryStepOf = (error: Error): string =>
  linksOf(sanitizeErrorForDisplay(error))[1];

const FRAME_SIZE_RECOVERY_STEP = recoveryStepOf(
  new FrameSizeExceededError("x"),
);
const LISTING_RECOVERY_STEP = recoveryStepOf(
  new DirectoryListingBoundsError("x"),
);
const STALLED_RECOVERY_STEP = recoveryStepOf(
  new TransportOperationStalledError("x"),
);

// Variable fragments at their ORDINARY size: the rendezvous path from
// docs/CLI.md's own example, a peer id of the shape uuidv4 produces, and a
// message filename the protocol itself composes. A short fixture would hide
// every overrun this file exists to catch.
const RENDEZVOUS_PATH = "/mnt/sftp-share/exchanges/agency-a-agency-b";
const PEER_ID = "3f2a91c4-8d6e-4b1f-9c07-5ae2d8f3b016";
const OVER_CAP_BYTES = MAX_FRAME_SIZE_BYTES + 1;
const MESSAGE_FILENAME = messageFilename({
  id: PEER_ID,
  timestampInFilename: true,
  byteCount: OVER_CAP_BYTES,
  seq: 7,
  ts: Date.UTC(2026, 7, 11, 14, 3, 22),
});
const TEMP_FILENAME = `temp-${PEER_ID}.tmp`;
// The longest name the protocol writes: an ack marker over a timestamped
// message name.
const ACK_FILENAME = `${PEER_ID}-${MESSAGE_FILENAME.replace(/\.json$/, "")}-ack.json`;

// The widest name a listed entry can have on the shipped path: the bound
// the CLI's directory-listing guard enforces on every entry it enumerates
// (MAX_FILENAME_LENGTH, apps/cli/src/connection/listingGuard.ts). Restated
// rather than imported since packages/core does not depend on apps/cli; it
// is the tightest bound there is, since core and the SFTP protocol impose
// none of their own.
const MAX_LISTED_FILENAME_LENGTH = 255;
// A peer message file at exactly that width, still selected by the loop's
// message grammar: the peer prefix the scan keys on and the byte-count terminal
// segment it parses, padded between them.
const WIDEST_MESSAGE_FILENAME = (() => {
  const prefix = `${PEER_ID}-`;
  const suffix = `-${OVER_CAP_BYTES}.json`;
  const padding = MAX_LISTED_FILENAME_LENGTH - prefix.length - suffix.length;
  return `${prefix}${"w".repeat(padding)}${suffix}`;
})();
// The rendezvous directory an operator nests one run deeper than the example
// above: the width at which the two paths a rename names no longer fit one link
// between them.
const NESTED_RENDEZVOUS_PATH = `${RENDEZVOUS_PATH}/2026-08-11-monthly-linkage-run`;

// A transport that answers nothing, so every await is ended by the connection's
// own peer-inactivity budget rather than by an error the transport chose.
const withholdingClient = (): FileTransportClient => ({
  connect: async () => {},
  end: () => new Promise<void>(() => {}),
  list: () => new Promise<FileInfo[]>(() => {}),
  get: () => new Promise(() => {}),
  put: () => new Promise<void>(() => {}),
  delete: () => new Promise<void>(() => {}),
  safeDelete: () => new Promise<void>(() => {}),
  rename: () => new Promise<void>(() => {}),
  createExclusive: () => new Promise<void>(() => {}),
  exists: () => new Promise<boolean>(() => {}),
});

async function boundTransportOf(
  client: FileTransportClient,
): Promise<FileTransportClient> {
  const conn = new FileSyncConnection(client, {
    verbose: -1,
    timeToLive: new Date(Date.now() + 60_000),
  });
  const config: FileDropConnectionConfig = {
    channel: "filedrop",
    path: RENDEZVOUS_PATH,
    // Short enough that the budget fires promptly; the number it reports is
    // the one variable the budget's own summary holds, and a wider one only
    // shortens the margin measured here by the digits it adds.
    options: { peerTimeoutMs: 20 },
  };
  await conn.open(config);
  return (conn as unknown as { client: FileTransportClient }).client;
}

const rejection = async (op: Promise<unknown>): Promise<unknown> =>
  op.then(
    () => {
      throw new Error("the operation resolved; nothing was refused");
    },
    (err: unknown) => err,
  );

// A rendezvous directory holding one peer message file whose NAME declares more
// bytes than the frame cap. The declared count is what the read gate refuses on,
// so no over-cap body is ever allocated to drive this.
function overCapMessageClient(name: string): FileTransportClient {
  const listing: FileInfo[] = [{ name, modifyTime: 0, size: OVER_CAP_BYTES }];
  return {
    connect: async () => {},
    end: async () => {},
    list: async () => listing,
    get: async () => {
      throw new Error("the over-cap file was read; the gate did not refuse it");
    },
    put: async () => {},
    delete: async () => {},
    safeDelete: async () => {},
    rename: async () => {},
    createExclusive: async () => {},
    exists: async () => false,
  };
}

// The frame gate through a real poll cycle: the poller lists a directory
// holding one over-cap peer message and refuses it, and the refusal it emits is
// what this returns.
async function frameGateRefusal(messageName: string): Promise<unknown> {
  const conn = new FileSyncConnection(overCapMessageClient(messageName), {
    verbose: -1,
    pollingFrequency: 5,
    timeToLive: new Date(Date.now() + 60_000),
  });
  await conn.open({
    channel: "filedrop",
    path: RENDEZVOUS_PATH,
    options: { peerTimeoutMs: 2_000 },
  } satisfies FileDropConnectionConfig);
  conn.peerId = PEER_ID;
  const errored = new Promise<unknown>((resolve) => conn.on("error", resolve));
  conn.start();
  try {
    return await errored;
  } finally {
    conn.stop();
  }
}

// Every core site that raises one of the three bounded-transport refusals
// and reaches an operator through sanitizeErrorForDisplay, each driven by
// its real route. The two teardown paths in `close()` are excluded since
// neither reaches the cause-chain renderer this file measures. A site added
// later is covered by the invariants at the foot of this file, not by this
// table.
const CORE_SITES: Array<{
  name: string;
  recoveryStep: string;
  raise: () => Promise<unknown>;
}> = [
  {
    name: "whole-exchange transport budget, directory listing",
    recoveryStep: STALLED_RECOVERY_STEP,
    raise: async () => {
      const bound = await boundTransportOf(withholdingClient());
      return rejection(bound.list(RENDEZVOUS_PATH));
    },
  },
  {
    name: "whole-exchange transport budget, file read",
    recoveryStep: STALLED_RECOVERY_STEP,
    raise: async () => {
      const bound = await boundTransportOf(withholdingClient());
      return rejection(bound.get(`${RENDEZVOUS_PATH}/${MESSAGE_FILENAME}`));
    },
  },
  {
    name: "whole-exchange transport budget, file write",
    recoveryStep: STALLED_RECOVERY_STEP,
    raise: async () => {
      const bound = await boundTransportOf(withholdingClient());
      return rejection(
        bound.put(Buffer.alloc(0), `${RENDEZVOUS_PATH}/${TEMP_FILENAME}`),
      );
    },
  },
  {
    name: "whole-exchange transport budget, delete",
    recoveryStep: STALLED_RECOVERY_STEP,
    raise: async () => {
      const bound = await boundTransportOf(withholdingClient());
      return rejection(bound.delete(`${RENDEZVOUS_PATH}/${ACK_FILENAME}`));
    },
  },
  {
    // The one bounded operation naming two transport paths, more than a
    // display budget of them before any fixed copy is counted, so each
    // takes a link of its own. The width at which one link could not hold
    // both is driven below.
    name: "whole-exchange transport budget, rename",
    recoveryStep: STALLED_RECOVERY_STEP,
    raise: async () => {
      const bound = await boundTransportOf(withholdingClient());
      return rejection(
        bound.rename(
          `${RENDEZVOUS_PATH}/${TEMP_FILENAME}`,
          `${RENDEZVOUS_PATH}/${MESSAGE_FILENAME}`,
        ),
      );
    },
  },
  {
    name: "file-sync frame-size gate",
    recoveryStep: FRAME_SIZE_RECOVERY_STEP,
    raise: () => frameGateRefusal(MESSAGE_FILENAME),
  },
];

for (const site of CORE_SITES) {
  test(`the recovery step renders in full at ${site.name}`, async () => {
    const rendered = sanitizeErrorForDisplay(await site.raise());
    // The whole sentence, on a link of its own: a site that put it back on the
    // summary would deliver a prefix of it, which this does not accept.
    expect(linksOf(rendered)).toContain(site.recoveryStep);
  });

  test(`no link truncates at ${site.name} with every fragment at its ordinary size`, async () => {
    const rendered = sanitizeErrorForDisplay(await site.raise());
    // A first-party link fits its budget by measurement, not by construction:
    // growing the fixed copy of a summary, a label, or the recovery sentence
    // past its budget puts the cap back on the operator's text, so it fails
    // here rather than silently deleting the next step.
    expect(truncatedLinks(rendered)).toEqual([]);
    // The recovery step is chained ahead of the fragment links, so the depth
    // bound reaches it whatever a site chains behind them.
    expect(linksOf(rendered).length).toBeLessThan(MAX_ERROR_CAUSE_DEPTH);
  });
}

// The two core sites naming more than one chooser, driven at the widest
// values the shipped path admits: at ordinary sizes two choosers could share
// a link undetected, but here the cap would delete the second and let the
// first forge the label that introduced it. Each delivery below is a width
// at which one link could not hold both, so a site that folded its choosers
// together fails here.

test("the writing peer keeps a link of its own at the widest message filename a listing admits", async () => {
  expect(WIDEST_MESSAGE_FILENAME).toHaveLength(MAX_LISTED_FILENAME_LENGTH);
  expect(WIDEST_MESSAGE_FILENAME.length + PEER_ID.length).toBeGreaterThan(
    DEFAULT_MAX_DISPLAY_LENGTH,
  );

  const rendered = sanitizeErrorForDisplay(
    await frameGateRefusal(WIDEST_MESSAGE_FILENAME),
  );
  const links = linksOf(rendered);

  // Each chooser on a labelled link of its own, and at the widest name the
  // shipped path admits all three arrive whole -- the name included.
  expect(links).toContain(`writing peer: ${PEER_ID}`);
  expect(links).toContain(`rendezvous directory: ${RENDEZVOUS_PATH}`);
  expect(links).toContain(`message file: ${WIDEST_MESSAGE_FILENAME}`);
  expect(links).toContain(FRAME_SIZE_RECOVERY_STEP);
  expect(truncatedLinks(rendered)).toEqual([]);
  expect(links.length).toBeLessThan(MAX_ERROR_CAUSE_DEPTH);
});

// The same site past the link budget. What the listing guard admits is not what
// bounds this file's name -- an adapter that lists no guard of its own is the
// reach limit the guard's own docs state -- so the width at which the cap fires
// is driven directly here. What the wide name spends is the budget of the link
// it sits alone on, and nothing else.
test("a message filename past the link budget spends only its own link", async () => {
  const flooded = `${PEER_ID}-${"w".repeat(COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH)}-${OVER_CAP_BYTES}.json`;

  const rendered = sanitizeErrorForDisplay(await frameGateRefusal(flooded));
  const links = linksOf(rendered);

  expect(links).toContain(`writing peer: ${PEER_ID}`);
  expect(links).toContain(`rendezvous directory: ${RENDEZVOUS_PATH}`);
  expect(links).toContain(FRAME_SIZE_RECOVERY_STEP);
  const [truncated] = truncatedLinks(rendered);
  expect(truncatedLinks(rendered)).toHaveLength(1);
  expect(truncated.slice(0, "message file: ".length)).toBe("message file: ");
  expect(links.length).toBeLessThan(MAX_ERROR_CAUSE_DEPTH);
});

test("both rename paths keep links of their own at a nested rendezvous directory", async () => {
  const fromPath = `${NESTED_RENDEZVOUS_PATH}/${TEMP_FILENAME}`;
  const toPath = `${NESTED_RENDEZVOUS_PATH}/${MESSAGE_FILENAME}`;
  expect(fromPath.length + toPath.length).toBeGreaterThan(
    DEFAULT_MAX_DISPLAY_LENGTH,
  );

  const bound = await boundTransportOf(withholdingClient());
  const rendered = sanitizeErrorForDisplay(
    await rejection(bound.rename(fromPath, toPath)),
  );
  const links = linksOf(rendered);

  // Both paths whole, each on its own labelled link: the destination is what a
  // shared link deletes at this width, and the label introducing it is what the
  // source could otherwise forge.
  expect(links).toContain(`rename source: ${fromPath}`);
  expect(links).toContain(`rename destination: ${toPath}`);
  expect(links).toContain(STALLED_RECOVERY_STEP);
  expect(truncatedLinks(rendered)).toEqual([]);
  expect(links.length).toBeLessThan(MAX_ERROR_CAUSE_DEPTH);
});

// The site-agnostic half of the property, so a site added later is covered
// without being remembered here. Whatever a call site composes -- however wide,
// and with however many fragments -- the step keeps a link of its own and that
// link is what the operator reads.
const REFUSAL_CLASSES: Array<{
  name: string;
  recoveryStep: string;
  build: (message: string, details: string[]) => Error;
}> = [
  {
    name: "FrameSizeExceededError",
    recoveryStep: FRAME_SIZE_RECOVERY_STEP,
    build: (message, details) =>
      new FrameSizeExceededError(message, { details }),
  },
  {
    name: "DirectoryListingBoundsError",
    recoveryStep: LISTING_RECOVERY_STEP,
    build: (message, details) =>
      new DirectoryListingBoundsError(message, { details }),
  },
  {
    name: "TransportOperationStalledError",
    recoveryStep: STALLED_RECOVERY_STEP,
    build: (message, details) =>
      new TransportOperationStalledError(message, { details }),
  },
];

for (const refusal of REFUSAL_CLASSES) {
  test(`${refusal.name} keeps its recovery step off the summary's budget`, () => {
    const flooded = refusal.build("s".repeat(100_000), [
      "d".repeat(100_000),
      "e".repeat(100_000),
    ]);
    const links = linksOf(sanitizeErrorForDisplay(flooded));

    expect(links).toContain(refusal.recoveryStep);
    // The cap is kept, not widened: the flooded links truncate on their own
    // budgets, which is the whole of what the flood can spend.
    expect(truncatedLinks(sanitizeErrorForDisplay(flooded))).toHaveLength(3);
    expect(refusal.recoveryStep.length).toBeLessThanOrEqual(
      DEFAULT_MAX_DISPLAY_LENGTH,
    );
  });

  test(`${refusal.name} keeps the message and the tag its consumers read`, () => {
    const error = refusal.build("the refusal summary", ["a fragment"]);

    // The summary alone, so message-equality dedup and the CLI hint-walker read
    // what they read today; the step is delivered by the chain instead.
    expect(error.message).toBe("the refusal summary");
    expect(error.message).not.toContain(refusal.recoveryStep);
    expect(
      (error as { psilinkRecoveryHintEmitted?: unknown })
        .psilinkRecoveryHintEmitted,
    ).toBe(true);
  });
}
