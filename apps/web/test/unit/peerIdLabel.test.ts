import { describe, expect, test } from "vitest";

import {
  PEER_ID_PATTERN,
  PEER_ID_SHAPE_MESSAGE,
  isAdmissiblePeerId,
} from "@psi/transport/peerIdLabel";

/**
 * The party-name bound and the refusal that reports it, held together: the
 * message tells an operator their name was refused for being outside ASCII, and
 * that is only true while the pattern admits nothing outside ASCII. Both halves
 * are driven from the pattern itself rather than restated, so widening one alone
 * reddens.
 */

/** Every codepoint through Latin Extended-B, plus samples from other scripts:
 * wide enough that a plausible widening -- a Latin-1 range, a Unicode letter
 * class -- admits something this sweep contains. */
const SWEEP: ReadonlyArray<string> = [
  ...Array.from({ length: 0x250 }, (_, code) => String.fromCodePoint(code)),
  "Α",
  "ω",
  "б",
  "א",
  "中",
  "한",
  "\u{1f600}",
];

/** What the pattern admits, asked of the pattern: as a whole one-character
 * label, and in the interior of a longer one (which admits more). */
const ADMITTED = SWEEP.filter(
  (character) =>
    PEER_ID_PATTERN.test(character) || PEER_ID_PATTERN.test(`a${character}a`),
);

const outsideAscii = (character: string): boolean =>
  (character.codePointAt(0) ?? 0) > 0x7f;

describe("the party-name bound and the message that reports it", () => {
  test("the pattern admits no character outside ASCII", () => {
    expect(ADMITTED.filter(outsideAscii)).toEqual([]);
  });

  test("the message names ASCII exactly while the pattern bounds to it", () => {
    expect(PEER_ID_SHAPE_MESSAGE.includes("ASCII")).toBe(
      ADMITTED.every((character) => !outsideAscii(character)),
    );
  });

  test.each([
    ["an accented letter", "clinique-café"],
    ["a diaeresis", "Ünal"],
    ["Cyrillic", "клиника"],
    ["Han", "診療所"],
  ])("a party name containing %s is refused", (_label, peerId) => {
    expect(isAdmissiblePeerId(peerId)).toBe(false);
  });

  test("the ASCII shape an operator would type is admitted", () => {
    expect(isAdmissiblePeerId("clinic-a")).toBe(true);
    expect(isAdmissiblePeerId("Site 2_b")).toBe(true);
  });
});
