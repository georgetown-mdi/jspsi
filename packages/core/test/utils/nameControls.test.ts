import { describe, expect, test } from "vitest";

import {
  BIDI_CONTROL_PATTERN,
  NAME_CONTROL_CHAR_PATTERN,
  stripNameControlChars,
} from "../../src/utils/nameControls";

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

/** One character from each range the class is written as, plus the edges of
 * each: NUL, tab, line feed and carriage return, unit separator, DEL, the C1
 * ends, and the escape a terminal would act on. */
const CONTROL_CHARACTERS = [
  "\u0000",
  "\u0009",
  "\u000a",
  "\u000d",
  "\u001b",
  "\u001f",
  "\u007f",
  "\u0085",
  "\u009f",
];

describe("stripNameControlChars", () => {
  test("removes each of the nine bidi characters the class holds", () => {
    for (const control of BIDI_CONTROLS) {
      expect(BIDI_CONTROL_PATTERN.test(control)).toBe(true);
      expect(stripNameControlChars(`pre${control}post`)).toBe("prepost");
    }
    expect(stripNameControlChars(BIDI_CONTROLS.join(""))).toBe("");
  });

  test("removes the C0 and C1 control characters too", () => {
    for (const control of CONTROL_CHARACTERS) {
      expect(NAME_CONTROL_CHAR_PATTERN.test(control)).toBe(true);
      expect(stripNameControlChars(`pre${control}post`)).toBe("prepost");
    }
    expect(stripNameControlChars(CONTROL_CHARACTERS.join(""))).toBe("");
    // A tab inside a name is the shape an operator's own export produces.
    expect(stripNameControlChars("date\tof\tbirth")).toBe("dateofbirth");
  });

  test("removes every occurrence, not just the first", () => {
    expect(stripNameControlChars(`${RLO}a${RLO}b${PDI}`)).toBe("ab");
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
      const stripped = stripNameControlChars(name);
      expect(stripped).toBe(name);
      // Identity, so a caller can compare references to learn nothing was removed.
      expect(Object.is(stripped, name)).toBe(true);
    }
  });

  test("the pattern holds no lastIndex state across calls", () => {
    // A `/g` pattern would answer false on every other call here. The rule this
    // guards is that one non-global pattern serves as both the test and the strip.
    expect(NAME_CONTROL_CHAR_PATTERN.test(RLO)).toBe(true);
    expect(NAME_CONTROL_CHAR_PATTERN.test(RLO)).toBe(true);
    expect(BIDI_CONTROL_PATTERN.test(RLO)).toBe(true);
    expect(BIDI_CONTROL_PATTERN.test(RLO)).toBe(true);
  });
});
