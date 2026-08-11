import { expect, test } from "vitest";
import {
  DEFAULT_MAX_DISPLAY_LENGTH,
  DirectoryListingBoundsError,
  DISPLAY_TRUNCATION_MARKER,
  FrameSizeExceededError,
  MAX_ERROR_CAUSE_DEPTH,
  sanitizeErrorForDisplay,
  TransportOperationStalledError,
} from "@psilink/core";

import { frameSizeExceededError } from "../../src/connection/frameSizeGuard";
import {
  directoryTooLargeError,
  filenameTooLongError,
  listingStalledByBatchCountError,
  listingStalledByTimeoutError,
  MAX_DIRECTORY_ENTRIES,
  MAX_FILENAME_LENGTH,
  MAX_LISTING_READDIR_BATCHES,
} from "../../src/connection/listingGuard";
import {
  SFTP_STALL_DEADLINE_MS,
  transportOperationStalledError,
} from "../../src/connection/sftpLivenessGuard";

// The renderer's own cause-link separator, read back out of a two-link render
// rather than restated here, so splitting a rendered chain into its links cannot
// drift from the framing the renderer emits.
const CAUSE_SEPARATOR = sanitizeErrorForDisplay(
  new Error("a", { cause: new Error("b") }),
).slice(1, -1);

const linksOf = (rendered: string): string[] => rendered.split(CAUSE_SEPARATOR);

// "This link was truncated" as a length comparison rather than a marker search,
// because one first-party fragment (the over-long filename preview) ends with
// the marker by construction and would read as a truncation that never happened.
// The two are equivalent: sanitizeForDisplay appends a code point only when its
// whole escape fits, an escape runs to at most ten characters, so a truncated
// link retains more than DEFAULT_MAX_DISPLAY_LENGTH - 10 characters and then
// carries the marker on top -- longer than the cap in every case, while an
// untruncated link is within it by definition.
const truncatedLinks = (rendered: string): string[] =>
  linksOf(rendered).filter((link) => link.length > DEFAULT_MAX_DISPLAY_LENGTH);

// The class-uniform recovery step, read off a minimal construction of the class
// rather than restated here: what each site is asserted to deliver is then the
// sentence the class actually carries, and an edit to that sentence cannot leave
// a stale copy passing here.
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
// docs/CLI.md's own example, and a message filename the protocol itself
// composes over a uuidv4 peer id. A short fixture would hide every overrun this
// file exists to catch.
const RENDEZVOUS_PATH = "/mnt/sftp-share/exchanges/agency-a-agency-b";
const MESSAGE_PATH = `${RENDEZVOUS_PATH}/3f2a91c4-8d6e-4b1f-9c07-5ae2d8f3b016-20260811T140322-007-536870889.json`;
const MAX_FRAME_SIZE_BYTES = 536_870_888;

// Every CLI site that raises one of the three bounded-transport refusals, built
// through the builder that composes it. The detail strings are the ones the
// adapter passes at each stall it bounds; a stall shape added there is covered
// by the class-level invariant at the foot of this file, not by this table.
const CLI_SITES: Array<{
  name: string;
  recoveryStep: string;
  raise: () => Error;
}> = [
  {
    name: "frame-size guard, streamed read over the cap",
    recoveryStep: FRAME_SIZE_RECOVERY_STEP,
    raise: () => frameSizeExceededError(MESSAGE_PATH, MAX_FRAME_SIZE_BYTES),
  },
  {
    name: "frame-size guard, fstat over the cap",
    recoveryStep: FRAME_SIZE_RECOVERY_STEP,
    raise: () =>
      frameSizeExceededError(
        MESSAGE_PATH,
        MAX_FRAME_SIZE_BYTES,
        MAX_FRAME_SIZE_BYTES + 1,
      ),
  },
  {
    name: "directory-listing guard, entry count over the bound",
    recoveryStep: LISTING_RECOVERY_STEP,
    raise: () => directoryTooLargeError(RENDEZVOUS_PATH, MAX_DIRECTORY_ENTRIES),
  },
  {
    name: "directory-listing guard, filename over the bound",
    recoveryStep: LISTING_RECOVERY_STEP,
    raise: () =>
      filenameTooLongError(
        RENDEZVOUS_PATH,
        "x".repeat(MAX_FILENAME_LENGTH + 1),
        MAX_FILENAME_LENGTH,
      ),
  },
  {
    name: "liveness guard, listing over the readdir round-trip cap",
    recoveryStep: STALLED_RECOVERY_STEP,
    raise: () =>
      listingStalledByBatchCountError(
        RENDEZVOUS_PATH,
        MAX_LISTING_READDIR_BATCHES,
      ),
  },
  {
    name: "liveness guard, listing past its deadline",
    recoveryStep: STALLED_RECOVERY_STEP,
    raise: () =>
      listingStalledByTimeoutError(RENDEZVOUS_PATH, SFTP_STALL_DEADLINE_MS),
  },
  {
    name: "liveness guard, a read that received no data",
    recoveryStep: STALLED_RECOVERY_STEP,
    raise: () =>
      transportOperationStalledError(
        "file read",
        MESSAGE_PATH,
        `received no data for ${SFTP_STALL_DEADLINE_MS} ms (the server ` +
          `withheld the transfer)`,
      ),
  },
  {
    name: "liveness guard, an upload that made no progress",
    recoveryStep: STALLED_RECOVERY_STEP,
    raise: () =>
      transportOperationStalledError(
        "file write",
        MESSAGE_PATH,
        `made no upload progress for ${SFTP_STALL_DEADLINE_MS} ms (the server ` +
          `withheld write acknowledgement)`,
      ),
  },
  {
    name: "liveness guard, an operation whose response was withheld",
    recoveryStep: STALLED_RECOVERY_STEP,
    raise: () =>
      transportOperationStalledError(
        "file read",
        MESSAGE_PATH,
        `did not complete within ${SFTP_STALL_DEADLINE_MS} ms (the server ` +
          `withheld the read response)`,
      ),
  },
  {
    // The one detail carrying bytes the server chose: the fatal protocol error
    // it reported, whose ordinary size is a short library sentence.
    name: "liveness guard, a session killed by a fatal protocol error",
    recoveryStep: STALLED_RECOVERY_STEP,
    raise: () =>
      transportOperationStalledError(
        "file read",
        MESSAGE_PATH,
        `the SFTP session was killed by a fatal server protocol error ` +
          `(Unexpected packet before version)`,
      ),
  },
  {
    name: "liveness guard, a keepalive whose response was withheld",
    recoveryStep: STALLED_RECOVERY_STEP,
    raise: () =>
      transportOperationStalledError(
        "keepalive",
        ".",
        `did not complete within ${SFTP_STALL_DEADLINE_MS} ms (the server ` +
          `withheld the realPath response)`,
      ),
  },
];

for (const site of CLI_SITES) {
  test(`the recovery step renders in full at the ${site.name}`, () => {
    const rendered = sanitizeErrorForDisplay(site.raise());
    // The whole sentence, on a link of its own: a site that put it back on the
    // summary would deliver a prefix of it, which this does not accept.
    expect(linksOf(rendered)).toContain(site.recoveryStep);
  });

  test(`no link truncates at the ${site.name} with every fragment at its ordinary size`, () => {
    const rendered = sanitizeErrorForDisplay(site.raise());
    // A first-party link fits its budget by measurement, not by construction:
    // growing the fixed copy of a summary, a label, or the recovery sentence
    // past its budget puts the cap back on the operator's text, so it fails
    // here rather than silently deleting the next step.
    expect(truncatedLinks(rendered)).toEqual([]);
    expect(linksOf(rendered).length).toBeLessThan(MAX_ERROR_CAUSE_DEPTH);
  });
}

// The cap is kept rather than widened: a fragment somebody else chose still
// truncates, and what it can spend is the budget of the link it sits alone on.
const FLOODED_SITES: Array<[string, () => Error, string]> = [
  [
    "the frame-size guard's path",
    () => frameSizeExceededError("/rv/" + "p".repeat(100_000), 1),
    FRAME_SIZE_RECOVERY_STEP,
  ],
  [
    "the listing guard's directory",
    () => directoryTooLargeError("/rv/" + "p".repeat(100_000), 1),
    LISTING_RECOVERY_STEP,
  ],
  [
    "the listing guard's entry name and directory at once",
    () =>
      filenameTooLongError(
        "/rv/" + "p".repeat(100_000),
        "n".repeat(100_000),
        MAX_FILENAME_LENGTH,
      ),
    LISTING_RECOVERY_STEP,
  ],
  [
    "the liveness guard's path",
    () =>
      transportOperationStalledError(
        "file read",
        "/rv/" + "p".repeat(100_000),
        "received no data",
      ),
    STALLED_RECOVERY_STEP,
  ],
];

for (const [label, raise, recoveryStep] of FLOODED_SITES) {
  test(`a flooded fragment spends only its own link at ${label}`, () => {
    const rendered = sanitizeErrorForDisplay(raise());

    expect(linksOf(rendered)).toContain(recoveryStep);
    // Whatever truncated, the summary and the recovery step were not it.
    for (const link of truncatedLinks(rendered))
      expect(link).not.toBe(recoveryStep);
    expect(truncatedLinks(rendered).length).toBeGreaterThan(0);
    expect(linksOf(rendered).length).toBeLessThan(MAX_ERROR_CAUSE_DEPTH);
  });
}

// A link carries ONE chooser, which is what the per-fragment table above cannot
// measure: the listing guard is the one CLI site naming two of them -- the
// server's entry name and the operator's directory -- so each delivery below
// fills one chooser's budget and asserts the OTHER's link arrives whole. Two
// choosers folded onto one link would truncate away the second and leave the
// first free to forge the label that introduced it.
const DIRECTORY_LINK = `directory: ${RENDEZVOUS_PATH}`;
const REFUSED_WIDTH_NAME = "n".repeat(MAX_FILENAME_LENGTH + 1);
// The entry-name link the guard composes for it: the leading slice it relays,
// carrying the marker the slicing itself earns.
const REFUSED_WIDTH_NAME_LINK = `entry name: ${REFUSED_WIDTH_NAME.slice(0, 64)}${DISPLAY_TRUNCATION_MARKER}`;

const TWO_CHOOSER_DELIVERIES: Array<[string, () => Error, string]> = [
  [
    "an entry name at the narrowest width the guard refuses",
    () =>
      filenameTooLongError(
        RENDEZVOUS_PATH,
        REFUSED_WIDTH_NAME,
        MAX_FILENAME_LENGTH,
      ),
    DIRECTORY_LINK,
  ],
  [
    "an entry name flooded past every budget",
    () =>
      filenameTooLongError(
        RENDEZVOUS_PATH,
        "n".repeat(100_000),
        MAX_FILENAME_LENGTH,
      ),
    DIRECTORY_LINK,
  ],
  [
    "a directory flooded past every budget",
    () =>
      filenameTooLongError(
        "/rv/" + "p".repeat(100_000),
        REFUSED_WIDTH_NAME,
        MAX_FILENAME_LENGTH,
      ),
    REFUSED_WIDTH_NAME_LINK,
  ],
];

for (const [label, raise, wholeLink] of TWO_CHOOSER_DELIVERIES) {
  test(`the other chooser arrives on a whole link of its own with ${label}`, () => {
    const rendered = sanitizeErrorForDisplay(raise());

    expect(linksOf(rendered)).toContain(wholeLink);
    expect(linksOf(rendered)).toContain(LISTING_RECOVERY_STEP);
    expect(linksOf(rendered).length).toBeLessThan(MAX_ERROR_CAUSE_DEPTH);
  });
}
