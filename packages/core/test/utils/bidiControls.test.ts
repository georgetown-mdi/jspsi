import { describe, expect, test } from "vitest";

import {
  BIDI_CONTROL_PATTERN,
  stripBidiControls,
} from "../../src/utils/bidiControls";

// Written as escapes, never as raw bytes, so the source of a test about
// invisible characters is itself readable.
const LRE = "\u202a";
const RLE = "\u202b";
const PDF = "\u202c";
const LRO = "\u202d";
const RLO = "\u202e";
const LRI = "\u2066";
const RLI = "\u2067";
const FSI = "\u2068";
const PDI = "\u2069";

/** The class as the boundary rule enumerates it: the five embeddings and
 * overrides, then the four isolates. */
const BIDI_CONTROLS = [LRE, RLE, PDF, LRO, RLO, LRI, RLI, FSI, PDI];

describe("stripBidiControls", () => {
  test("removes each of the nine characters the class holds", () => {
    for (const control of BIDI_CONTROLS) {
      expect(BIDI_CONTROL_PATTERN.test(control)).toBe(true);
      expect(stripBidiControls(`pre${control}post`)).toBe("prepost");
    }
    expect(stripBidiControls(BIDI_CONTROLS.join(""))).toBe("");
  });

  test("removes every occurrence, not just the first", () => {
    expect(stripBidiControls(`${RLO}a${RLO}b${PDI}`)).toBe("ab");
  });

  test("leaves ordinary non-ASCII names untouched, by reference", () => {
    for (const name of [
      "first_name",
      "prénom",
      "姓名",
      "имя",
      "الاسم",
      "name 🎉",
      // The implicit direction marks are outside the class: they open no scope
      // that can reach past the name they sit in.
      "name\u200e",
      "name\u200f",
      "name\u061c",
    ]) {
      const stripped = stripBidiControls(name);
      expect(stripped).toBe(name);
      // Identity, so a caller can compare references to learn nothing was removed.
      expect(Object.is(stripped, name)).toBe(true);
    }
  });

  test("the pattern holds no lastIndex state across calls", () => {
    // A `/g` pattern would answer false on every other call here. The rule this
    // guards is that one non-global pattern serves as both the test and the strip.
    expect(BIDI_CONTROL_PATTERN.test(RLO)).toBe(true);
    expect(BIDI_CONTROL_PATTERN.test(RLO)).toBe(true);
  });
});
