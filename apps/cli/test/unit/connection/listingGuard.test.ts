import { describe, expect, test } from "vitest";
import {
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  DirectoryListingBoundsError,
  DISPLAY_TRUNCATION_MARKER,
  MAX_ERROR_CAUSE_DEPTH,
  sanitizeErrorForDisplay,
  UsageError,
} from "@psilink/core";

import {
  MAX_DIRECTORY_ENTRIES,
  MAX_FILENAME_LENGTH,
  directoryTooLargeError,
  filenameTooLongError,
} from "../../../src/connection/listingGuard";

// The renderer's own cause-link separator, read back out of a two-link render
// rather than restated here, so splitting a rendered chain into its links cannot
// drift from the framing the renderer emits.
const CAUSE_SEPARATOR = sanitizeErrorForDisplay(
  new Error("a", { cause: new Error("b") }),
).slice(1, -1);

const linksOf = (rendered: string): string[] => rendered.split(CAUSE_SEPARATOR);

// The widest a single link renders: the per-link cap plus the marker the
// sanitizer appends when it truncates. Each fragment somebody else chose sits on
// a link of its own, so this is the whole of what any one of them can spend, and
// the renderer's depth bound is what bounds their sum.
const MAX_RENDERED_LINK_LENGTH =
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH + DISPLAY_TRUNCATION_MARKER.length;

const expectEveryLinkBounded = (rendered: string): void => {
  const links = linksOf(rendered);
  expect(links.length).toBeLessThanOrEqual(MAX_ERROR_CAUSE_DEPTH);
  for (const link of links)
    expect(link.length).toBeLessThanOrEqual(MAX_RENDERED_LINK_LENGTH);
};

// The class-uniform next step, read off a minimal construction of the class
// rather than restated here, so an edit to the sentence cannot leave a stale
// copy passing.
const RECOVERY_STEP = (new DirectoryListingBoundsError("x").cause as Error)
  .message;

describe("listing bound constants", () => {
  test("the entry cap leaves wide headroom over a legitimate exchange", () => {
    // A single exchange produces order-of-ten files; the cap must exceed that by
    // orders of magnitude while staying within the memory envelope (see the
    // module's derivation comment). Anchored here so a future edit that narrows
    // it toward the legitimate set, or widens it past the envelope, fails.
    expect(MAX_DIRECTORY_ENTRIES).toBe(8192);
  });

  test("the filename cap is NAME_MAX", () => {
    expect(MAX_FILENAME_LENGTH).toBe(255);
  });
});

describe("directoryTooLargeError", () => {
  test("is a typed, terminal (UsageError) error", () => {
    const err = directoryTooLargeError("/drop", MAX_DIRECTORY_ENTRIES);
    expect(err).toBeInstanceOf(DirectoryListingBoundsError);
    // DirectoryListingBoundsError extends UsageError, which the CLI maps to exit
    // 64 and the poll loop treats as terminal; both adapters must produce that.
    expect(err).toBeInstanceOf(UsageError);
  });

  test("names the directory and the cap", () => {
    const err = directoryTooLargeError("/drop", 8192);
    // The cap is a number and rides the summary; the directory is a fragment
    // somebody else chose and reaches the operator on a labelled link of its
    // own, so the whole rendered chain is where it is read.
    expect(err.message).toContain("8192");
    expect(linksOf(sanitizeErrorForDisplay(err))).toContain("directory: /drop");
  });

  // dirPath can be seeded from a partner invitation endpoint on an offline-accept
  // config, so it must reach the operator escaped. Asserted at the RENDERED
  // boundary, the altitude the escape happens at: on the raw message these would
  // pass equally on a value the operator sees escaped twice. Mirrors the
  // sanitizeForDisplay categories.
  test("escapes control/ANSI characters in the directory path", () => {
    const rendered = sanitizeErrorForDisplay(
      directoryTooLargeError("/drop/\x1b[31mEVIL", 8192),
    );
    expect(rendered).not.toContain("\x1b");
    expect(rendered).toContain("\\x1b");
  });

  test("neutralizes deceptive Unicode (bidi-override) in the directory path", () => {
    const rendered = sanitizeErrorForDisplay(
      directoryTooLargeError("/drop/dir\u202eEVIL", 8192),
    );
    expect(rendered).not.toContain("\u202e");
    expect(rendered).toContain("\\u202e");
  });
});

describe("filenameTooLongError", () => {
  test("is a typed, terminal (UsageError) error", () => {
    const err = filenameTooLongError("/drop", "x".repeat(300), 255);
    expect(err).toBeInstanceOf(DirectoryListingBoundsError);
    expect(err).toBeInstanceOf(UsageError);
  });

  test("reports the offending length and the cap", () => {
    const err = filenameTooLongError("/drop", "x".repeat(300), 255);
    expect(err.message).toContain("300 characters");
    expect(err.message).toContain("255");
  });

  test("truncates the offending name so the error cannot relay an attacker-sized string", () => {
    const hostile = "a".repeat(5000);
    const err = filenameTooLongError("/drop", hostile, 255);
    const rendered = sanitizeErrorForDisplay(err);
    // The full name is not echoed; only a short prefix plus an ellipsis, on the
    // labelled link the name is composed onto.
    expect(rendered).not.toContain(hostile);
    expect(linksOf(rendered)).toContain(
      `entry name: ${"a".repeat(64)}${DISPLAY_TRUNCATION_MARKER}`,
    );
    // The whole error stays small regardless of the input name length, so it
    // cannot relay the 5000-character hostile input whole.
    expectEveryLinkBounded(rendered);
  });

  test("escapes control/ANSI characters so a hostile name cannot spoof the terminal", () => {
    const hostile = "evil\x1b[31m" + "n".repeat(300);
    const err = filenameTooLongError("/drop", hostile, 255);
    const rendered = sanitizeErrorForDisplay(err);
    // The raw ESC never reaches the operator's terminal; it survives as text.
    expect(rendered).not.toContain("\x1b");
    expect(rendered).toContain("\\x1b");
    // The true length is still reported.
    expect(rendered).toContain(`${hostile.length} characters`);
  });

  test("stays bounded even when the name is all non-ASCII (escapes expand each char)", () => {
    // Each astral emoji escapes to a 9-char \u{...} (up to 10 for a 6-hex-digit
    // code point), so the composed preview slice is what keeps the name out of
    // memory whole, and the display boundary's per-link cap is what keeps the
    // rendered form small. Both are asserted, because either alone would let the
    // other regress unnoticed.
    const hostile = "\u{1f600}".repeat(5000);
    const err = filenameTooLongError("/drop", hostile, 255);
    const rendered = sanitizeErrorForDisplay(err);
    expect(rendered).not.toContain(hostile);
    expect(err.message.length).toBeLessThan(500);
    expectEveryLinkBounded(rendered);
  });

  test("keeps the truncation marker when the name preview holds a PEM BEGIN marker", () => {
    // The dangling-key rule is fail-closed -- it replaces from an unterminated
    // BEGIN marker to the end of the text -- so redacting the preview and the
    // marker together would let a planted marker consume the marker itself and
    // silently present the truncated name as whole.
    const hostile = "-----BEGIN RSA PRIVATE KEY-----" + "A".repeat(300);
    const err = filenameTooLongError("/drop", hostile, 255);
    const rendered = sanitizeErrorForDisplay(err);
    expect(rendered).toContain(DISPLAY_TRUNCATION_MARKER);
    expect(rendered).not.toContain("AAAA");
    // The refusal and the class-uniform next step still reach the operator, each
    // on a link the planted marker cannot reach.
    expect(err.message).toContain("refusing to process it");
    expect(linksOf(rendered)).toContain(RECOVERY_STEP);
  });

  // The directory path is escaped through the same helper as in
  // directoryTooLargeError, so the rendezvous path is neutralized uniformly
  // across both bound errors -- defense-in-depth for a path that can be seeded
  // from a charset-unconstrained partner invitation endpoint.
  test("escapes control/ANSI characters in the directory path", () => {
    const rendered = sanitizeErrorForDisplay(
      filenameTooLongError("/drop/\x1b[31mEVIL", "x".repeat(300), 255),
    );
    expect(rendered).not.toContain("\x1b");
    expect(rendered).toContain("\\x1b");
  });

  // The dirPath is interpolated raw and is the one fragment here with no bound of
  // its own, so what an operator actually sees is bounded by the display
  // boundary's per-link cap. Pin the bound where it exists, not on the raw
  // message: even with BOTH the path and the name attacker-sized, each spends
  // only the budget of the link it sits alone on.
  test("stays bounded when both the directory path and filename are attacker-sized", () => {
    const hostilePath = "/" + "d".repeat(5000);
    const hostileName = "n".repeat(5000);
    const err = filenameTooLongError(hostilePath, hostileName, 255);
    const rendered = sanitizeErrorForDisplay(err);
    expect(rendered).not.toContain(hostileName);
    expectEveryLinkBounded(rendered);
  });
});
