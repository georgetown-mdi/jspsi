import { describe, expect, test } from "vitest";

import {
  DISPLAY_TRUNCATION_MARKER,
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
} from "@psilink/core";

import { appendSanitizedRunWarning } from "@psi/runWarnings";

// What the console's rendezvous preflight puts in front of an operator when the
// mount is not empty: the entry names are the PARTNER's, since the partner syncs
// its own files into that directory. The seat renders whatever this returns, so
// this is the text an operator reads.
const PARTNER_ENTRY_WARNING = (entries: string) =>
  `the rendezvous directory holds ${entries}`;

describe("appendSanitizedRunWarning", () => {
  test("escapes a partner-chosen fragment once, at this one boundary", () => {
    // A partner names a file with a control character, a non-ASCII code point, and
    // a literal backslash. Each reaches the operator as its own escape, never as
    // the raw byte -- the rendered line is what the shared alert prints.
    const raw = PARTNER_ENTRY_WARNING("handoffé\\share.csv");

    const [rendered] = appendSanitizedRunWarning([], raw);

    expect(rendered).toBe(
      "the rendezvous directory holds hand\\x07off\\xe9\\\\share.csv",
    );
    // Neither the raw control character nor the raw non-ASCII code point survives.
    expect(rendered).not.toContain("");
    expect(rendered).not.toContain("é");
  });

  test("a second pass would double a partner's backslash, so the renderer adds none", () => {
    // The assumption behind escaping at the sink alone: sanitizeForDisplay is not
    // idempotent over a backslash, so a renderer that escaped again would show one
    // backslash in a partner filename as four.
    const raw = PARTNER_ENTRY_WARNING("q1\\cohort.csv");

    const [once] = appendSanitizedRunWarning([], raw);
    const [twice] = appendSanitizedRunWarning([], once);

    expect(once).toContain("q1\\\\cohort.csv");
    expect(twice).toContain("q1\\\\\\\\cohort.csv");
    expect(twice).not.toBe(once);
  });

  test("caps a partner-grown message at the display budget", () => {
    // The partner controls how long the entry listing gets by syncing files in.
    // The cap is the sink's -- the whole-warning budget, since every message
    // this boundary folds is a composition -- so no seat can render past it.
    const raw = PARTNER_ENTRY_WARNING(
      "a".repeat(WARNING_MESSAGE_MAX_DISPLAY_LENGTH + 1),
    );

    const [rendered] = appendSanitizedRunWarning([], raw);

    expect(rendered.length).toBe(
      WARNING_MESSAGE_MAX_DISPLAY_LENGTH + DISPLAY_TRUNCATION_MARKER.length,
    );
    expect(rendered.endsWith(DISPLAY_TRUNCATION_MARKER)).toBe(true);
  });

  test("accumulates in arrival order, so no notice displaces an earlier one", () => {
    // The rendezvous preflight raises the recovery lead and the listing as two
    // messages in order, and the overlap warning can follow both. All three have to
    // stand together.
    const first = appendSanitizedRunWarning(
      [],
      "the rendezvous directory is not empty",
    );
    const second = appendSanitizedRunWarning(
      first,
      "the rendezvous directory holds q1.csv",
    );
    const third = appendSanitizedRunWarning(
      second,
      "the rendezvous directory overlaps the job data root",
    );

    expect(third).toEqual([
      "the rendezvous directory is not empty",
      "the rendezvous directory holds q1.csv",
      "the rendezvous directory overlaps the job data root",
    ]);
    // The input array is never mutated: each seat holds this in React state.
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
  });
});
