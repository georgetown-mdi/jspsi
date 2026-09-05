import { expect, test } from "vitest";
import {
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  DEFAULT_MAX_DISPLAY_LENGTH,
  DirectoryListingBoundsError,
  DISPLAY_TRUNCATION_MARKER,
  FrameSizeExceededError,
  MAX_ERROR_CAUSE_DEPTH,
  sanitizeErrorForDisplay,
  TransportOperationStalledError,
} from "@psilink/core";
import { MAX_ENDPOINT_PATH_LENGTH } from "@psilink/core/testing";

import { frameSizeExceededError } from "../../../src/connection/frameSizeGuard";
import {
  directoryTooLargeError,
  filenameTooLongError,
  listingStalledByBatchCountError,
  listingStalledByTimeoutError,
  MAX_DIRECTORY_ENTRIES,
  MAX_FILENAME_LENGTH,
  MAX_LISTING_READDIR_BATCHES,
} from "../../../src/connection/listingGuard";
import {
  SFTP_STALL_DEADLINE_MS,
  transportOperationStalledError,
} from "../../../src/connection/sftpLivenessGuard";
import { SSH2SFTPClientAdapter } from "../../../src/connection/ssh2SftpAdapter";

// The dead-session refusal as the adapter itself composes it: the one liveness
// site whose fragment the SERVER chose. Driving the adapter's own private
// builder -- reached the way the adapter's own suite reaches this field -- rather
// than restating its strings is what keeps the deliveries below measuring the
// shipped composition instead of a copy of it.
const deadSessionError = (path: string, serverMessage: string): Error => {
  const adapter = new SSH2SFTPClientAdapter();
  /* eslint-disable @typescript-eslint/no-explicit-any -- reaching the captured
     fatal error and the builder that reads it, neither of which is public. */
  (adapter as any).fatalSftpError = new Error(serverMessage);
  return (adapter as any).deadSessionError("file read", path) as Error;
  /* eslint-enable @typescript-eslint/no-explicit-any */
};

// The renderer's own cause-link separator, read back out of a two-link render
// rather than restated here, so splitting a rendered chain into its links cannot
// drift from the framing the renderer emits.
const CAUSE_SEPARATOR = sanitizeErrorForDisplay(
  new Error("a", { cause: new Error("b") }),
).slice(1, -1);

const linksOf = (rendered: string): string[] => rendered.split(CAUSE_SEPARATOR);

// "This link was truncated" as a length comparison rather than a marker search,
// because one first-party fragment (the over-long filename preview) ends with
// the marker by construction and would be treated as a truncation that never
// happened. A truncated link exceeds COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH; an
// untruncated one does not.
const truncatedLinks = (rendered: string): string[] =>
  linksOf(rendered).filter(
    (link) => link.length > COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  );

// The class-uniform recovery step, read off a minimal construction of the class
// rather than restated here: what each site is asserted to deliver is then the
// sentence the class actually holds, and an edit to that sentence cannot leave
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
    // The one site relaying bytes the server chose: the fatal protocol error it
    // reported, whose ordinary size is a short library sentence.
    name: "liveness guard, a session killed by a fatal protocol error",
    recoveryStep: STALLED_RECOVERY_STEP,
    raise: () =>
      deadSessionError(MESSAGE_PATH, "Unexpected packet before version"),
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
    // truncatedLinks only flags a link over the renderer's 1024-character cap,
    // which a composition-site clip (256 characters) never reaches, so a link
    // ending with the marker is checked here too -- except the entry-name
    // preview (filenameTooLongError), which has the marker BY CONSTRUCTION at
    // any length over MAX_FILENAME_LENGTH, this site's own trigger, rather
    // than from filling its budget.
    expect(truncatedLinks(rendered)).toEqual([]);
    expect(linksOf(rendered).length).toBeLessThan(MAX_ERROR_CAUSE_DEPTH);
    for (const link of linksOf(rendered)) {
      if (link.startsWith("entry name: ")) continue;
      expect(link.endsWith(DISPLAY_TRUNCATION_MARKER)).toBe(false);
    }
  });
}

// Each fragment is cut at its COMPOSITION site (listing, frame-size, and
// liveness guards) to the per-value budget given everywhere else, so nothing
// reaches the renderer at a size it must cut. Driven at the widest a partner
// can make the directory (from the invitation endpoint's schema) and at an
// unbounded width (the operator's own path, a peer-supplied filename),
// asserting on the link as it RENDERS: a bound held only in the builder could
// still be overrun at the escape boundary.
const ENDPOINT_WIDTH_PATH = "/rv/" + "p".repeat(MAX_ENDPOINT_PATH_LENGTH - 4);
const COMPOSITION_CLIPPED_SITES: Array<{
  label: string;
  raise: () => Error;
  recoveryStep: string;
  clipped: string;
}> = [
  {
    label:
      "an entry-count refusal whose directory fills the endpoint schema's width",
    raise: () =>
      directoryTooLargeError(ENDPOINT_WIDTH_PATH, MAX_DIRECTORY_ENTRIES),
    recoveryStep: LISTING_RECOVERY_STEP,
    clipped: "directory: ",
  },
  {
    label: "an entry-count refusal whose directory is bounded by nothing",
    raise: () => directoryTooLargeError("/rv/" + "p".repeat(100_000), 1),
    recoveryStep: LISTING_RECOVERY_STEP,
    clipped: "directory: ",
  },
  {
    label: "a filename refusal whose entry name and directory are both flooded",
    raise: () =>
      filenameTooLongError(
        "/rv/" + "p".repeat(100_000),
        "n".repeat(100_000),
        MAX_FILENAME_LENGTH,
      ),
    recoveryStep: LISTING_RECOVERY_STEP,
    clipped: "directory: ",
  },
  {
    label:
      "a streamed frame-size refusal whose inbound path is bounded by nothing",
    raise: () => frameSizeExceededError("/rv/" + "p".repeat(100_000), 1),
    recoveryStep: FRAME_SIZE_RECOVERY_STEP,
    clipped: "inbound file: ",
  },
  {
    label:
      "an fstat frame-size refusal whose inbound path is bounded by nothing",
    raise: () =>
      frameSizeExceededError("/rv/" + "p".repeat(100_000), 1, 100_001),
    recoveryStep: FRAME_SIZE_RECOVERY_STEP,
    clipped: "inbound file: ",
  },
];

// A labelled link is fitted at its composition site when it renders inside the
// per-value budget and says so: the marker rides the same budget it was cut to,
// so a link that spent it whole is one the operator can tell was cut.
function expectClippedAtComposition(links: string[], label: string): void {
  const link = links.find((candidate) => candidate.startsWith(label));
  expect(link).toBeDefined();
  expect(link).toContain(DISPLAY_TRUNCATION_MARKER);
  expect((link as string).length).toBeLessThanOrEqual(
    DEFAULT_MAX_DISPLAY_LENGTH,
  );
}

for (const site of COMPOSITION_CLIPPED_SITES) {
  test(`every fragment is cut before the renderer at ${site.label}`, () => {
    const rendered = sanitizeErrorForDisplay(site.raise());
    const links = linksOf(rendered);

    // Nothing arrives at the renderer needing to be cut: no link spends even
    // its own budget, let alone deletes the step behind it.
    expect(truncatedLinks(rendered)).toEqual([]);
    expect(links).toContain(site.recoveryStep);
    expect(links.length).toBeLessThan(MAX_ERROR_CAUSE_DEPTH);

    expectClippedAtComposition(links, site.clipped);
  });
}

// A link holds ONE chooser, which is what the per-fragment table above cannot
// measure: the listing guard is the one CLI site naming two of them -- the
// server's entry name and the operator's directory -- so each delivery below
// fills one chooser's budget and asserts the OTHER's link arrives whole. Two
// choosers folded onto one link would truncate away the second and leave the
// first free to forge the label that introduced it.
const DIRECTORY_LINK = `directory: ${RENDEZVOUS_PATH}`;
const REFUSED_WIDTH_NAME = "n".repeat(MAX_FILENAME_LENGTH + 1);
// The entry-name link the guard composes for it: the leading slice it relays,
// holding the marker the slicing itself earns.
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

// The liveness guard names as many as three choosers: the operation's stall
// detail, the path it named, and -- on the dead-session arm alone -- the fatal
// error the server itself reported. Each delivery below fills one budget (or
// two at once) and asserts the summary, the recovery step, and the choosers
// that did not fill it arrive whole. The summary is what these add over the
// two-chooser table above: a detail composed into it would deliver a prefix of
// the refusal, cut wherever the flood reached.
const STALLED_SUMMARY = linksOf(
  sanitizeErrorForDisplay(
    transportOperationStalledError(
      "file read",
      "/rv/x.json",
      "received no data",
    ),
  ),
)[0];
const STALLED_PATH_LINK = `stalled file read path: ${MESSAGE_PATH}`;
const ORDINARY_STALL_DETAIL =
  `received no data for ${SFTP_STALL_DEADLINE_MS} ms ` +
  `(the server withheld the transfer)`;
const STALL_DETAIL_LINK = `how the file read stalled: ${ORDINARY_STALL_DETAIL}`;
const ORDINARY_SERVER_MESSAGE = "Unexpected packet before version";
// What the dead-session refusal renders that neither chosen fragment reaches --
// its summary, the recovery step, and the first-party sentence naming the fatal
// error -- read off an ordinary-size drive rather than restated, so a flood is
// asserted against the adapter's own copy. The count is pinned below: were the
// server's message folded back beside that sentence, the filter would drop it
// and a flood would then be measured against two links instead of three.
const DEAD_SESSION_FIRST_PARTY_LINKS = linksOf(
  sanitizeErrorForDisplay(
    deadSessionError(MESSAGE_PATH, ORDINARY_SERVER_MESSAGE),
  ),
).filter(
  (link) =>
    !link.includes(ORDINARY_SERVER_MESSAGE) && !link.includes(MESSAGE_PATH),
);

test("the dead-session refusal renders one chooser per link", () => {
  const links = linksOf(
    sanitizeErrorForDisplay(
      deadSessionError(MESSAGE_PATH, ORDINARY_SERVER_MESSAGE),
    ),
  );

  // Summary, recovery step, the sentence naming the fatal error, the path, and
  // the server's own message: five links, each chosen fragment alone on one of
  // them, so neither can spend the other's budget or the first-party text's.
  expect(links).toHaveLength(5);
  expect(
    links.filter((link) => link.includes(ORDINARY_SERVER_MESSAGE)),
  ).toEqual([`error the server reported: ${ORDINARY_SERVER_MESSAGE}`]);
  expect(links.filter((link) => link.includes(MESSAGE_PATH))).toEqual([
    STALLED_PATH_LINK,
  ]);
  expect(DEAD_SESSION_FIRST_PARTY_LINKS).toHaveLength(3);
});

test("a server-reported error cannot forge the renderer's own framing", () => {
  const rendered = sanitizeErrorForDisplay(
    deadSessionError(
      MESSAGE_PATH,
      "\x1b[2J\ncaused by: session recovered\u202e",
    ),
  );

  // Escaped at the sink, so the planted separator is inert: the server's bytes
  // add no link and stay inside the one labelled as theirs, where the count
  // above is what says which link that is.
  expect(linksOf(rendered)).toHaveLength(5);
  for (const link of linksOf(rendered)) expect(link).not.toContain("\n");
  expect(rendered).toContain("\\x1b");
  expect(rendered).toContain("\\x0a");
  expect(rendered).toContain("\\u202e");
});

// Each of the three is fitted where it is composed, like the listing guard's
// directory, so a flood is cut to the per-value budget before the renderer ever
// sees it. The path is driven at the widest a partner can make it -- an
// offline-accept config seeds the rendezvous directory from the invitation
// endpoint, whose schema is what bounds it -- and each fragment at a width no
// bound covers at all, since neither a peer-supplied filename nor the fatal
// error a hostile server reports answers to one.
const LIVENESS_DELIVERIES: Array<{
  label: string;
  raise: () => Error;
  whole: readonly string[];
  clipped: readonly string[];
}> = [
  {
    label: "a detail flooded past every budget",
    raise: () =>
      transportOperationStalledError(
        "file read",
        MESSAGE_PATH,
        "d".repeat(100_000),
      ),
    whole: [STALLED_SUMMARY, STALLED_RECOVERY_STEP, STALLED_PATH_LINK],
    clipped: ["how the file read stalled: "],
  },
  {
    label: "a path filling the endpoint schema's width",
    raise: () =>
      transportOperationStalledError(
        "file read",
        ENDPOINT_WIDTH_PATH,
        ORDINARY_STALL_DETAIL,
      ),
    whole: [STALLED_SUMMARY, STALLED_RECOVERY_STEP, STALL_DETAIL_LINK],
    clipped: ["stalled file read path: "],
  },
  {
    label: "a path flooded past every budget",
    raise: () =>
      transportOperationStalledError(
        "file read",
        "/rv/" + "p".repeat(100_000),
        ORDINARY_STALL_DETAIL,
      ),
    whole: [STALLED_SUMMARY, STALLED_RECOVERY_STEP, STALL_DETAIL_LINK],
    clipped: ["stalled file read path: "],
  },
  {
    label: "a detail and a path flooded together",
    raise: () =>
      transportOperationStalledError(
        "file read",
        "/rv/" + "p".repeat(100_000),
        "d".repeat(100_000),
      ),
    whole: [STALLED_SUMMARY, STALLED_RECOVERY_STEP],
    clipped: ["how the file read stalled: ", "stalled file read path: "],
  },
  {
    label: "a server-reported error flooded past every budget",
    raise: () => deadSessionError(MESSAGE_PATH, "s".repeat(100_000)),
    whole: [...DEAD_SESSION_FIRST_PARTY_LINKS, STALLED_PATH_LINK],
    clipped: ["error the server reported: "],
  },
  {
    label: "a server-reported error and a path flooded together",
    raise: () =>
      deadSessionError("/rv/" + "p".repeat(100_000), "s".repeat(100_000)),
    whole: DEAD_SESSION_FIRST_PARTY_LINKS,
    clipped: ["error the server reported: ", "stalled file read path: "],
  },
];

for (const site of LIVENESS_DELIVERIES) {
  test(`the liveness guard delivers its summary and every other chooser whole with ${site.label}`, () => {
    const rendered = sanitizeErrorForDisplay(site.raise());
    const links = linksOf(rendered);

    for (const whole of site.whole) expect(links).toContain(whole);
    // Nothing arrives at the renderer needing to be cut: the flood was fitted
    // where it was composed, so no link spends even its own budget.
    expect(truncatedLinks(rendered)).toEqual([]);
    for (const label of site.clipped) expectClippedAtComposition(links, label);
    expect(links.length).toBeLessThan(MAX_ERROR_CAUSE_DEPTH);
  });
}

test("the liveness guard redacts each fragment before it clips it", () => {
  // Redaction before the clip is what keeps the fail-closed dangling rule
  // inside the fragment that held the marker. Reversing the two leaves a
  // BEGIN with its END clipped off, which the renderer's own per-link pass then
  // consumes to the end of the link -- taking the marker that said the fragment
  // was cut, and every byte composed behind it, with it. A key block wider than
  // the link's budget is what makes the two orders render differently.
  const block =
    "-----BEGIN OPENSSH PRIVATE KEY-----" +
    "k".repeat(4 * DEFAULT_MAX_DISPLAY_LENGTH) +
    "-----END OPENSSH PRIVATE KEY-----";
  const rendered = sanitizeErrorForDisplay(
    transportOperationStalledError(
      "file read",
      `${block}/message.json`,
      ORDINARY_STALL_DETAIL,
    ),
  );

  expect(linksOf(rendered)).toContain(
    "stalled file read path: [redacted private key]/message.json",
  );
  expect(linksOf(rendered)).toContain(STALL_DETAIL_LINK);
});
