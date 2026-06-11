import { describe, expect, test } from "vitest";
import { DirectoryListingBoundsError, UsageError } from "@psilink/core";

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

  // dirPath is operator-configured (not partner-controlled), but it is routed
  // through sanitizeForDisplay anyway so every listingGuard builder treats its
  // interpolated path uniformly. Mirrors the sanitizeForDisplay categories.
  test("escapes control/ANSI characters in the directory path", () => {
    const err = directoryTooLargeError("/drop/\x1b[31mEVIL", 8192);
    expect(err.message).not.toContain("\x1b");
    expect(err.message).toContain("\\x1b");
  });

  test("neutralizes deceptive Unicode (bidi-override) in the directory path", () => {
    const err = directoryTooLargeError("/drop/dir‮EVIL", 8192);
    expect(err.message).not.toContain("‮");
    expect(err.message).toContain("\\u202e");
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
    // The message itself stays small regardless of the input name length.
    expect(err.message.length).toBeLessThan(300);
  });

  test("escapes control/ANSI characters so a hostile name cannot spoof the terminal", () => {
    const hostile = "evil\x1b[31m" + "n".repeat(300);
    const err = filenameTooLongError("/drop", hostile, 255);
    // The raw ESC never reaches the operator's terminal; it survives as text.
    expect(err.message).not.toContain("\x1b");
    expect(err.message).toContain("\\x1b");
    // The true length is still reported.
    expect(err.message).toContain(`${hostile.length} characters`);
  });

  test("stays bounded even when the name is all non-ASCII (escapes expand each char)", () => {
    // Each astral emoji escapes to a 9-char \u{...} (up to 10 for a 6-hex-digit
    // code point); the preview bounds the escaped output, not the code-point
    // count, so the message cannot balloon.
    const hostile = "\u{1f600}".repeat(5000);
    const err = filenameTooLongError("/drop", hostile, 255);
    expect(err.message).not.toContain(hostile);
    expect(err.message.length).toBeLessThan(300);
  });
});
