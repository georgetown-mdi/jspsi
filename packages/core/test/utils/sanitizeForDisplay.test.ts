import { describe, expect, test } from "vitest";

import {
  sanitizeForDisplay,
  clipToRenderedCost,
  controlCharacterMarker,
  renderedDisplayCost,
  replaceControlCharactersForDisplay,
  trimPartialControlCharacterMarker,
  DISPLAY_TRUNCATION_MARKER,
  DEFAULT_MAX_DISPLAY_LENGTH,
} from "../../src/utils/sanitizeForDisplay";
import { redactPrivateKeyMaterial } from "../../src/utils/sanitizeErrorForDisplay";

describe("sanitizeForDisplay", () => {
  test("passes an ordinary ASCII value through unchanged", () => {
    expect(sanitizeForDisplay("MOU-2025-0042")).toBe("MOU-2025-0042");
    expect(sanitizeForDisplay("Audit and evaluation, FY25")).toBe(
      "Audit and evaluation, FY25",
    );
  });

  test("returns an empty string unchanged", () => {
    expect(sanitizeForDisplay("")).toBe("");
  });

  test("escapes an ANSI / control escape sequence", () => {
    const out = sanitizeForDisplay("\x1b[31mERROR\x1b[0m");
    // The raw ESC that drives the sequence is gone; the inert "[31m" text may
    // remain but cannot be interpreted by a terminal without the ESC.
    expect(out).not.toContain("\x1b");
    expect(out).toContain("\\x1b");
    expect(out).toContain("[31mERROR");
  });

  test("escapes a newline so it cannot spoof a log line", () => {
    const out = sanitizeForDisplay("ok\nFAKE: all clear");
    expect(out).not.toContain("\n");
    expect(out).toContain("\\x0a");
  });

  test("escapes other C0 controls and DEL", () => {
    expect(sanitizeForDisplay("\r")).toBe("\\x0d");
    expect(sanitizeForDisplay("\t")).toBe("\\x09");
    expect(sanitizeForDisplay("\x7f")).toBe("\\x7f");
    expect(sanitizeForDisplay("\x00")).toBe("\\x00");
  });

  test("neutralizes a bidi-override character (RLO)", () => {
    const out = sanitizeForDisplay("user\u202eEVIL");
    expect(out).not.toContain("\u202e");
    expect(out).toContain("\\u202e");
  });

  test("neutralizes zero-width characters", () => {
    const out = sanitizeForDisplay("a\u200bb\ufeffc");
    expect(out).not.toContain("\u200b");
    expect(out).not.toContain("\ufeff");
    expect(out).toBe("a\\u200bb\\ufeffc");
  });

  test("neutralizes a homoglyph / confusable (Cyrillic small a)", () => {
    // U+0430 renders identically to ASCII "a" but is a different character.
    const out = sanitizeForDisplay("c\u0430fe");
    expect(out).not.toContain("\u0430");
    expect(out).toBe("c\\u0430fe");
  });

  test("doubles a literal backslash so the escaping is unambiguous", () => {
    // A literal "\x1b" (four printable ASCII chars) must not be confusable with
    // a real escaped ESC: the backslash is doubled.
    expect(sanitizeForDisplay("a\\b")).toBe("a\\\\b");
    expect(sanitizeForDisplay("\\x1b")).toBe("\\\\x1b");
  });

  test("escapes an astral code point with the \\u{...} form", () => {
    expect(sanitizeForDisplay("\u{1f600}")).toBe("\\u{1f600}");
  });

  test("escapes a lone surrogate rather than splitting or dropping it", () => {
    // Code-point iteration yields a lone high surrogate as one unit; it must be
    // escaped (a future switch to UTF-16 iteration would split it -- this pins
    // against that).
    expect(sanitizeForDisplay("\ud83d")).toBe("\\ud83d");
  });

  test("escapes a combining mark per code point (NFD sequence)", () => {
    // "e" + combining acute (U+0301): the base passes as ASCII, the mark escapes.
    expect(sanitizeForDisplay("e" + String.fromCodePoint(0x301))).toBe(
      "e\\u0301",
    );
  });

  test("returns a bare marker when maxLength is smaller than the first escape", () => {
    // Degenerate cap: the astral first char's escape (9 chars) exceeds a cap of
    // 3, so nothing fits and only the marker is emitted -- bounded and safe, no
    // mid-escape. maxLength 0 behaves the same for any non-empty input.
    expect(sanitizeForDisplay("\u{1f600}abc", { maxLength: 3 })).toBe(
      DISPLAY_TRUNCATION_MARKER,
    );
    expect(sanitizeForDisplay("a", { maxLength: 0 })).toBe(
      DISPLAY_TRUNCATION_MARKER,
    );
    expect(sanitizeForDisplay("", { maxLength: 0 })).toBe("");
  });

  test("truncates an over-long value and appends the marker", () => {
    const value = "a".repeat(DEFAULT_MAX_DISPLAY_LENGTH + 50);
    const out = sanitizeForDisplay(value);
    expect(out).not.toContain(value);
    expect(out.startsWith("a".repeat(DEFAULT_MAX_DISPLAY_LENGTH))).toBe(true);
    expect(out.endsWith(DISPLAY_TRUNCATION_MARKER)).toBe(true);
  });

  test("respects a custom maxLength", () => {
    expect(sanitizeForDisplay("a".repeat(100), { maxLength: 10 })).toBe(
      "aaaaaaaaaa" + DISPLAY_TRUNCATION_MARKER,
    );
  });

  test("does not append the marker for a value exactly at the cap", () => {
    expect(sanitizeForDisplay("a".repeat(10), { maxLength: 10 })).toBe(
      "a".repeat(10),
    );
  });

  test("bounds the output length, not the input code-point count", () => {
    // Each astral emoji escapes to a 9-char \u{1f600} (up to 10 for a 6-hex-digit
    // code point); a code-point cap would let the output run to ~10x. The cap
    // bounds the escaped output instead, so an all-astral hostile value stays
    // small.
    const hostile = "\u{1f600}".repeat(500);
    const out = sanitizeForDisplay(hostile, { maxLength: 64 });
    expect(out.length).toBeLessThanOrEqual(
      64 + DISPLAY_TRUNCATION_MARKER.length,
    );
    expect(out.endsWith(DISPLAY_TRUNCATION_MARKER)).toBe(true);
  });

  test("appends only whole escapes when truncating (never ends mid-escape)", () => {
    // Each emoji escapes to "\u{1f600}" (9 chars); with a 20-char cap exactly two
    // fit (18 chars), the third would overflow, so the cut lands on an escape
    // boundary rather than splitting "\u{1f60...".
    const out = sanitizeForDisplay("\u{1f600}".repeat(5), { maxLength: 20 });
    expect(out).toBe("\\u{1f600}".repeat(2) + DISPLAY_TRUNCATION_MARKER);
  });
});

// Every control character, driven rather than sampled: the class is small
// enough to enumerate, and what the treatment claims is a property of all of it
// rather than of the line break it was written for.
const CONTROL_CHARACTERS = Array.from({ length: 0xa0 }, (_, codePoint) =>
  String.fromCodePoint(codePoint),
).filter((character) => /\p{Cc}/u.test(character));

describe("replaceControlCharactersForDisplay", () => {
  test("covers the whole control class and nothing else", () => {
    expect(CONTROL_CHARACTERS.length).toBe(65);
    for (const character of CONTROL_CHARACTERS)
      expect(replaceControlCharactersForDisplay(character)).toBe(
        controlCharacterMarker(character.codePointAt(0)!),
      );
    // A printable byte, a backslash, a confusable, a bidi override, a
    // zero-width space, and an astral code point are left to the escape, which
    // renders each visibly and none of them as anything a composition's own
    // structure is made of.
    for (const untouched of ["a", "\\", "а", "‮", "​", "\u{1f600}"])
      expect(replaceControlCharactersForDisplay(untouched)).toBe(untouched);
  });

  test("the marker is printable ASCII the escape passes through", () => {
    // What keeps the treatment from becoming a second escaping altitude: the
    // sink's pass finds nothing to rewrite, so a treated fragment escaped there
    // is byte-identical to itself.
    for (const character of CONTROL_CHARACTERS) {
      const marker = controlCharacterMarker(character.codePointAt(0)!);
      expect(sanitizeForDisplay(marker)).toBe(marker);
      expect(marker).not.toContain("\\");
    }
  });

  test("no marker is a token the escape writes for a control character", () => {
    // The whole point of the marker's shape. A composition builds its own
    // structure out of control characters and is escaped where it is shown, so
    // a value able to render the escape's token for one could stand in that
    // structure's place.
    const escaped = new Set(
      CONTROL_CHARACTERS.map((character) => sanitizeForDisplay(character)),
    );
    for (const character of CONTROL_CHARACTERS) {
      const treated = replaceControlCharactersForDisplay(character);
      for (const token of escaped) expect(treated).not.toContain(token);
    }
  });

  test("a treated value costs the display what the untreated one asked for", () => {
    // A budget is measured over a fragment after this runs, so parity is
    // not critical -- but a marker WIDER than the escape's own token would
    // quietly buy a chooser room in every message that fits one, so it is
    // pinned rather than left to the arithmetic.
    for (const character of CONTROL_CHARACTERS)
      expect(
        renderedDisplayCost(replaceControlCharactersForDisplay(character)),
      ).toBe(renderedDisplayCost(character));
  });

  test("the emitter emits only markers the back-off covers", () => {
    // The pairing between the two: what makes a cut inside a marker recoverable
    // is that every proper prefix of every marker is a shape the back-off knows,
    // and both sides are read off the same class. A code point outside it would
    // render SIX characters wide -- `<1234>` -- whose prefixes the back-off does
    // not cover, leaving `abc<123` standing where a cut fell, which is the
    // fragment the pair exists to prevent. So it is refused rather than emitted.
    for (const character of CONTROL_CHARACTERS) {
      const marker = controlCharacterMarker(character.codePointAt(0)!);
      expect(marker.length).toBe(4);
      for (let offset = 1; offset < marker.length; offset += 1)
        expect(
          trimPartialControlCharacterMarker(`abc${marker.slice(0, offset)}`),
          marker,
        ).toBe("abc");
    }
    for (let codePoint = 0; codePoint <= 0x200; codePoint += 1)
      if (!/\p{Cc}/u.test(String.fromCodePoint(codePoint)))
        expect(
          () => controlCharacterMarker(codePoint),
          `U+${codePoint.toString(16)}`,
        ).toThrow(RangeError);
    for (const outside of [0x1234, 0x10ffff, -1, 1.5])
      expect(() => controlCharacterMarker(outside), `${outside}`).toThrow(
        RangeError,
      );
  });

  test("either order against redaction renders the same bytes", () => {
    // What the treatment's place in the composition order does NOT rest on.
    // The private-key patterns span every character class and their
    // markers hold no control character, so neither pass can make or
    // unmake the other's match -- held here rather than by a sentence in
    // the docstring, which could not tell a real dependency from an
    // assumed one.
    const body = "MIIByteslookingsecret0123456789ABCDEFabcdef+/wEHEHE";
    const block = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----`;
    for (const text of [
      block,
      `could not load key: ${block}\nretry`,
      block.replace(/\n/g, "\r\n"),
      `dangling\r\n${block.slice(0, 60)}`,
      `-----BEGIN PRIVATE KEY-----${body}-----END PRIVATE KEY-----`,
    ]) {
      const redactedFirst = replaceControlCharactersForDisplay(
        redactPrivateKeyMaterial(text),
      );
      expect(redactedFirst).toContain("[redacted private key]");
      expect(redactedFirst).not.toContain(body);
      expect(
        redactPrivateKeyMaterial(replaceControlCharactersForDisplay(text)),
      ).toBe(redactedFirst);
    }
  });
});

describe("a cut lands outside a control-character marker", () => {
  // The marker is four printable characters standing where a control character
  // was, and both cut routines below measure in units smaller than that: a
  // budget landing between them would show the operator a fragment of a token
  // that is neither the value's own bytes nor the marker.
  const LEAD = "x".repeat(20);
  // Long enough that every budget spanning the marker still cuts, rather than
  // reaching the end of the value and returning it whole.
  const TAIL = "y".repeat(DISPLAY_TRUNCATION_MARKER.length + 6);
  const MARKER = controlCharacterMarker("\n".codePointAt(0)!);
  const treated = replaceControlCharactersForDisplay(`${LEAD}\n${TAIL}`);

  // What a cut may not leave in front of the truncation marker, read off the
  // marker rather than restated: any proper prefix of it.
  const FRAGMENTS = Array.from(
    { length: MARKER.length - 1 },
    (_unused, index) => MARKER.slice(0, index + 1),
  );
  const endsInAFragment = (rendered: string): boolean => {
    const kept = rendered.endsWith(DISPLAY_TRUNCATION_MARKER)
      ? rendered.slice(0, -DISPLAY_TRUNCATION_MARKER.length)
      : rendered;
    return FRAGMENTS.some((fragment) => kept.endsWith(fragment));
  };

  test("the value places the marker where a budget can be walked across it", () => {
    expect(treated).toBe(`${LEAD}${MARKER}${TAIL}`);
    // Every character of it is printable ASCII, so a character of the treated
    // value costs the escape one and the two routines' units line up with the
    // offsets below.
    expect(renderedDisplayCost(treated)).toBe(treated.length);
  });

  test("sanitizeForDisplay's own truncation backs off to before the marker", () => {
    // The cut walked across the marker's four positions. Landing inside it
    // undershoots the cap by up to three characters -- the cap bounds the
    // output rather than being met by it -- and the marker is shown whole only
    // where the whole of it fits.
    const keptAt = (offset: number): string =>
      sanitizeForDisplay(treated, { maxLength: LEAD.length + offset });
    for (const offset of [0, 1, 2, 3])
      expect(keptAt(offset)).toBe(LEAD + DISPLAY_TRUNCATION_MARKER);
    expect(keptAt(MARKER.length)).toBe(
      LEAD + MARKER + DISPLAY_TRUNCATION_MARKER,
    );
  });

  test("clipToRenderedCost backs off to before the marker", () => {
    // The same walk on the routine that clips to a RENDERED cost, whose budget
    // pays for the truncation marker out of itself.
    const keptAt = (offset: number): string =>
      clipToRenderedCost(
        treated,
        DISPLAY_TRUNCATION_MARKER.length + LEAD.length + offset,
      );
    for (const offset of [0, 1, 2, 3])
      expect(keptAt(offset)).toBe(LEAD + DISPLAY_TRUNCATION_MARKER);
    expect(keptAt(MARKER.length)).toBe(
      LEAD + MARKER + DISPLAY_TRUNCATION_MARKER,
    );
  });

  test("at no width does either routine leave a fragment of a marker", () => {
    // Said over every width rather than at the four offsets above: a value the
    // partner sized decides where the cut falls, so the property is read across
    // all of them.
    let sawWholeMarker = false;
    let sawCut = false;
    for (let width = 0; width <= treated.length + 4; width += 1) {
      const escaped = sanitizeForDisplay(treated, { maxLength: width });
      const clipped = clipToRenderedCost(treated, width);
      expect(endsInAFragment(escaped), `maxLength ${width}`).toBe(false);
      expect(endsInAFragment(clipped), `budget ${width}`).toBe(false);
      sawWholeMarker ||= escaped.includes(MARKER) && clipped.includes(MARKER);
      sawCut ||=
        escaped.endsWith(DISPLAY_TRUNCATION_MARKER) &&
        clipped.endsWith(DISPLAY_TRUNCATION_MARKER);
    }
    // Non-vacuous: the sweep covered widths that cut the value and widths that
    // held the whole marker.
    expect(sawWholeMarker).toBe(true);
    expect(sawCut).toBe(true);
  });

  test("a value spelling a marker in its own bytes is backed off over too", () => {
    // The marker's shape is an open class: nothing in a treated string
    // tells a marker from a value that spelled one character by character,
    // so the back-off reads the shape and moves the cut for either. It
    // costs the same three characters, and what it cannot do is leave the
    // operator a fragment whose provenance they would have to guess at.
    const literal = `${LEAD}${MARKER}${TAIL}`;
    expect(replaceControlCharactersForDisplay(literal)).toBe(literal);
    expect(sanitizeForDisplay(literal, { maxLength: LEAD.length + 2 })).toBe(
      LEAD + DISPLAY_TRUNCATION_MARKER,
    );
    // A `<` the value holds mid-run is not a cut and is left alone.
    expect(sanitizeForDisplay(`a<b${LEAD}`, { maxLength: 4 })).toBe(
      "a<b" + LEAD[0] + DISPLAY_TRUNCATION_MARKER,
    );
  });

  test("the back-off is one marker wide, whatever it lands beside", () => {
    // What bounds it: a whole marker ends in `>`, a character no proper prefix
    // of a marker holds, so one back-off removes the split marker's prefix and
    // cannot expose a second one behind it. Read over the emitter's whole
    // domain, at every cut inside a marker, and behind leads ending in a whole
    // marker and in marker SHAPES the lead spells in its own bytes.
    for (const lead of [LEAD, `${LEAD}${MARKER}`, `${LEAD}<0`, `${LEAD}<`])
      for (const character of CONTROL_CHARACTERS) {
        const marker = controlCharacterMarker(character.codePointAt(0)!);
        for (let offset = 1; offset < marker.length; offset += 1)
          expect(
            trimPartialControlCharacterMarker(lead + marker.slice(0, offset)),
            `${JSON.stringify(lead)} cut at ${offset} of ${marker}`,
          ).toBe(lead);
      }
    expect(trimPartialControlCharacterMarker("abc<0<0<0")).toBe("abc<0<0");
  });

  test("a value that spells the shape end to end keeps all but a cut's three", () => {
    // The residual the bound admits, and the floor it holds. A tail of
    // marker-shaped bytes is the partner's own text, so a cut costs it the three
    // characters a split marker costs and not the run: backing off over the run
    // would leave a value that is nothing else rendering as the truncation
    // marker alone, with none of the bytes the budget was going to show. Read
    // against an inert value of the same width at every width, which is what the
    // budget would have shown for anything else.
    const shaped = "<0".repeat(150);
    const inert = "x".repeat(shaped.length);
    const kept = (rendered: string): string =>
      rendered.endsWith(DISPLAY_TRUNCATION_MARKER)
        ? rendered.slice(0, -DISPLAY_TRUNCATION_MARKER.length)
        : rendered;
    const backOff = MARKER.length - 1;
    for (let width = 0; width <= 64; width += 1) {
      expect(
        kept(sanitizeForDisplay(shaped, { maxLength: width })).length,
        `maxLength ${width}`,
      ).toBeGreaterThanOrEqual(
        kept(sanitizeForDisplay(inert, { maxLength: width })).length - backOff,
      );
      expect(
        kept(clipToRenderedCost(shaped, width)).length,
        `budget ${width}`,
      ).toBeGreaterThanOrEqual(
        kept(clipToRenderedCost(inert, width)).length - backOff,
      );
    }
    // The two widths the shape costs the most at, spelled out: the escape's own
    // cap, and a clip whose budget pays for the truncation marker out of itself.
    expect(sanitizeForDisplay("<".repeat(300))).toBe(
      "<".repeat(DEFAULT_MAX_DISPLAY_LENGTH - 1) + DISPLAY_TRUNCATION_MARKER,
    );
    expect(clipToRenderedCost(`${"b".repeat(10)}${"<0".repeat(40)}`, 60)).toBe(
      `${"b".repeat(10)}${"<0".repeat(17)}${DISPLAY_TRUNCATION_MARKER}`,
    );
  });
});
