import { describe, expect, test } from "vitest";
import {
  DEFAULT_MAX_DISPLAY_LENGTH,
  DirectoryListingBoundsError,
  DISPLAY_TRUNCATION_MARKER,
  sanitizeErrorForDisplay,
  UsageError,
} from "@psilink/core";

import {
  MAX_DIRECTORY_ENTRIES,
  MAX_FILENAME_LENGTH,
  directoryTooLargeError,
  filenameTooLongError,
} from "../../src/connection/listingGuard";

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
    expect(err.message).toContain("/drop");
    expect(err.message).toContain("8192");
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
    // The full name is not echoed; only a short prefix plus an ellipsis.
    expect(err.message).not.toContain(hostile);
    expect(err.message).toContain("a".repeat(64));
    expect(err.message).toContain("...");
    // The message itself stays small (the truncated preview plus the fixed
    // class-appended recovery step) regardless of the input name length -- well
    // under the 5000-character hostile input, so it cannot relay it whole.
    expect(err.message.length).toBeLessThan(500);
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
    // code point), so the message's own preview slice is what keeps the name out
    // of memory whole, and the display boundary's per-link cap is what keeps the
    // rendered form small. Both are asserted, because either alone would let the
    // other regress unnoticed.
    const hostile = "\u{1f600}".repeat(5000);
    const err = filenameTooLongError("/drop", hostile, 255);
    expect(err.message).not.toContain(hostile);
    expect(err.message.length).toBeLessThan(500);
    expect(sanitizeErrorForDisplay(err).length).toBeLessThanOrEqual(
      DEFAULT_MAX_DISPLAY_LENGTH + DISPLAY_TRUNCATION_MARKER.length,
    );
  });

  test("keeps the truncation marker when the name preview carries a PEM BEGIN marker", () => {
    // The dangling-key rule is fail-closed -- it replaces from an unterminated
    // BEGIN marker to the end of the text -- so redacting the preview and the
    // marker together would let a planted marker consume the marker itself and
    // silently present the truncated name as whole.
    const hostile = "-----BEGIN RSA PRIVATE KEY-----" + "A".repeat(300);
    const err = filenameTooLongError("/drop", hostile, 255);
    expect(err.message).toContain(DISPLAY_TRUNCATION_MARKER);
    expect(err.message).not.toContain("AAAA");
    // The refusal and the class-appended next step still reach the operator.
    expect(err.message).toContain("refusing to process it");
    expect(sanitizeErrorForDisplay(err)).toContain(DISPLAY_TRUNCATION_MARKER);
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
  // message: even with BOTH the path and the name attacker-sized, the rendered
  // refusal stays one capped link.
  test("stays bounded when both the directory path and filename are attacker-sized", () => {
    const hostilePath = "/" + "d".repeat(5000);
    const hostileName = "n".repeat(5000);
    const err = filenameTooLongError(hostilePath, hostileName, 255);
    expect(err.message).not.toContain(hostileName);
    expect(sanitizeErrorForDisplay(err).length).toBeLessThanOrEqual(
      DEFAULT_MAX_DISPLAY_LENGTH + DISPLAY_TRUNCATION_MARKER.length,
    );
  });
});
