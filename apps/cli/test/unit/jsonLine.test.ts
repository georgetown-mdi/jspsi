import { describe, expect, test } from "vitest";

import { asciiSafeJsonLine } from "../../src/util/jsonLine";

// The encoder behind every machine-readable line the CLI writes to stdout. What
// it promises is a pair: the emitted TEXT is printable ASCII throughout, and the
// document that text parses to is the one `JSON.stringify` alone would have
// produced -- which is what keeps a consumer's own display escape a single pass.
//
// The bytes under test are built by code point rather than written as literals,
// so this file stays readable ASCII and each case names the byte it drives.

/** Printable ASCII throughout, the property that makes a line safe to print as
 * it stands. Asserted on the emitted text rather than on any field of it. */
const PRINTABLE_ASCII_ONLY = /^[\x20-\x7e]*$/;

const byte = (code: number): string => String.fromCharCode(code);

/** DEL, and the C1 control the peer's own latin1 decoding can carry: the two
 * ranges `JSON.stringify` leaves raw. */
const DEL = byte(0x7f);
const C1_CSI = byte(0x9b);
/** The ESC that drives an ANSI sequence -- C0, so JSON escapes it already. */
const ESC = byte(0x1b);
/** LINE SEPARATOR: legal raw inside a JSON string, and a line terminator to a
 * reader that treats the line as JavaScript source. */
const LINE_SEPARATOR = byte(0x2028);

describe("asciiSafeJsonLine emits printable ASCII", () => {
  test("DEL and the C1 range are escaped, where JSON.stringify leaves them raw", () => {
    // The premise this encoder exists for, driven rather than asserted in prose.
    const bare = JSON.stringify({ excerpt: `a${DEL}b${C1_CSI}c` });
    expect(bare).toContain(DEL);
    expect(bare).toContain(C1_CSI);

    const line = asciiSafeJsonLine({ excerpt: `a${DEL}b${C1_CSI}c` });
    expect(line).toBe('{"excerpt":"a\\u007fb\\u009bc"}');
    expect(PRINTABLE_ASCII_ONLY.test(line)).toBe(true);
  });

  test("the C0 escapes JSON already applies are left as they are", () => {
    expect(asciiSafeJsonLine({ excerpt: `a${ESC}[31m\r\nb` })).toBe(
      '{"excerpt":"a\\u001b[31m\\r\\nb"}',
    );
  });

  test("U+2028, which JSON.stringify passes through raw, is escaped", () => {
    const fields = { excerpt: `a${LINE_SEPARATOR}b` };
    expect(JSON.stringify(fields)).toContain(LINE_SEPARATOR);
    expect(asciiSafeJsonLine(fields)).toBe('{"excerpt":"a\\u2028b"}');
  });

  test("a key outside printable ASCII is escaped exactly as a value is", () => {
    expect(asciiSafeJsonLine({ [`k${C1_CSI}`]: "v" })).toBe('{"k\\u009b":"v"}');
  });

  test("every byte of latin1 -- the excerpt's own decoding -- crosses as ASCII", () => {
    const everyByte = Array.from({ length: 256 }, (_, code) => byte(code)).join(
      "",
    );
    const line = asciiSafeJsonLine({ excerpt: everyByte });
    expect(PRINTABLE_ASCII_ONLY.test(line)).toBe(true);
    expect(JSON.parse(line)).toEqual({ excerpt: everyByte });
  });

  test("an astral code point escapes as the surrogate pair JSON.parse recombines", () => {
    const astral = String.fromCodePoint(0x1f600);
    const line = asciiSafeJsonLine({ excerpt: astral });
    expect(line).toBe('{"excerpt":"\\ud83d\\ude00"}');
    expect(JSON.parse(line)).toEqual({ excerpt: astral });
  });

  test("a lone surrogate stays the escape JSON.stringify made of it", () => {
    const line = asciiSafeJsonLine({ excerpt: byte(0xd800) });
    expect(line).toBe('{"excerpt":"\\ud800"}');
    expect(PRINTABLE_ASCII_ONLY.test(line)).toBe(true);
  });
});

describe("asciiSafeJsonLine changes no part of the document", () => {
  // The escapes are JSON's own, so the value a consumer parses back is identical
  // to what a bare JSON.stringify would have handed it. That is what keeps the
  // encoder off the display-escaping ladder: there is nothing here for a
  // consumer's own sanitize pass to escape a second time.
  test("the parsed document is the one JSON.stringify alone produces", () => {
    const fields = {
      diagnosis: "non_ssh",
      shape: "http",
      excerpt: `HTTP/1.0 403\r\n${byte(0xff)}${DEL}${C1_CSI} back\\slash "q"`,
      count: 3,
      flag: true,
      nothing: null,
    };
    expect(JSON.parse(asciiSafeJsonLine(fields))).toEqual(
      JSON.parse(JSON.stringify(fields)),
    );
  });

  test("an undefined field is dropped, as JSON.stringify drops it", () => {
    expect(asciiSafeJsonLine({ a: "x", b: undefined })).toBe('{"a":"x"}');
  });

  test("the line is one line whatever the value carried", () => {
    const line = asciiSafeJsonLine({
      excerpt: `a\nb\r\nc${LINE_SEPARATOR}d${byte(0x2029)}e`,
    });
    for (const terminator of ["\n", "\r", LINE_SEPARATOR, byte(0x2029)])
      expect(line.includes(terminator)).toBe(false);
  });
});
