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
});
