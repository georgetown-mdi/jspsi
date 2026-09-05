import { describe, expect, test } from "vitest";

import {
  MAX_INPUT_NAME_LENGTH,
  browseSegment,
  isAdmissibleInputName,
} from "@jobs/workInputName";

// The two name rules share ONE single-segment shape predicate and must differ
// only on the leading dot: browseSegment admits a dot-prefixed segment (SSH key
// material lives under `.ssh/...`) while isAdmissibleInputName rejects it. These
// pin that they cannot drift on any other check.

const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(0x7f);

// Shape-admissible names with no leading dot: both rules agree they are allowed.
// A space is permitted, so it belongs here, not among the rejects.
const SHAPED_NO_DOT = ["input.csv", "clients", "a b", "id_ed25519", "x"];

// Shape-admissible names that DO start with a dot: the only divergence point.
const SHAPED_LEADING_DOT = [".ssh", ".psilink.key", ".env", "...", ".a"];

// Names failing a SHARED shape check: both rules reject, regardless of the dot.
// Control-char cases are built from char codes so no literal control byte lands
// in this source (NUL and DEL bracket the C0/DEL range the rule bans).
const SHAPE_INADMISSIBLE = [
  "",
  ".",
  "..",
  "a/b",
  "a\\b",
  `a${NUL}b`,
  `a${DEL}b`,
  "x".repeat(MAX_INPUT_NAME_LENGTH + 1),
];

describe("browseSegment vs isAdmissibleInputName", () => {
  test("agree on every name that does not begin with a dot", () => {
    for (const name of [...SHAPED_NO_DOT, ...SHAPE_INADMISSIBLE])
      expect(browseSegment(name)).toBe(isAdmissibleInputName(name));
  });

  test("differ ONLY on the leading dot: browse admits it, input rejects it", () => {
    for (const name of SHAPED_LEADING_DOT) {
      expect(browseSegment(name)).toBe(true);
      expect(isAdmissibleInputName(name)).toBe(false);
    }
  });

  test("both reject separators, dot segments, control chars, and empties", () => {
    for (const name of SHAPE_INADMISSIBLE) {
      expect(browseSegment(name)).toBe(false);
      expect(isAdmissibleInputName(name)).toBe(false);
    }
  });

  test("both apply the same length bound", () => {
    const atCap = "x".repeat(MAX_INPUT_NAME_LENGTH);
    const overCap = "x".repeat(MAX_INPUT_NAME_LENGTH + 1);
    expect(browseSegment(atCap)).toBe(true);
    expect(isAdmissibleInputName(atCap)).toBe(true);
    expect(browseSegment(overCap)).toBe(false);
    expect(isAdmissibleInputName(overCap)).toBe(false);
  });
});
