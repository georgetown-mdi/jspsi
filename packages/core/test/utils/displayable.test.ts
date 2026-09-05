import { describe, expect, test } from "vitest";

import {
  displayText,
  sanitizeForDisplay,
} from "../../src/utils/sanitizeForDisplay";

import type { Displayable } from "../../src/utils/sanitizeForDisplay";

// Stands in for any partner-controlled value: typed as the wide `string`, which
// is what an un-sanitized value is typed as everywhere it is held. The
// right-to-left override is built from its code point so the source itself
// contains no raw deceptive byte.
const partnerControlled: string = `Acme${String.fromCodePoint(0x202e)}org`;
const sanitized = "Acme\\u202eorg";

// The type-level assertions below are checked by `npm run typecheck` (both this
// package's tsconfig and the web app's include their test trees) and so by CI.
// An expect-error directive that stops guarding anything is itself an error
// (TS2578, unused directive), which is what keeps these from quietly passing
// forever once the brand they assert is gone.
describe("Displayable (the sanitized-display brand)", () => {
  test("rejects an un-sanitized string where a Displayable is required", () => {
    // @ts-expect-error -- a plain string has not passed the display boundary
    const branded: Displayable = partnerControlled;
    expect(branded).toBe(partnerControlled);
  });

  test("rejects fixed copy written as a bare literal", () => {
    // @ts-expect-error -- first-party copy enters through displayText
    const branded: Displayable = "First name";
    expect(branded).toBe("First name");
  });

  test("accepts a sanitizeForDisplay return value", () => {
    const branded: Displayable = sanitizeForDisplay(partnerControlled);
    expect(branded).toBe(sanitized);
  });

  test("is an ordinary string at runtime -- the brand adds no bytes", () => {
    const branded = sanitizeForDisplay(partnerControlled);
    expect(typeof branded).toBe("string");
    expect(branded).toBe(sanitized);
  });

  test("is usable anywhere a string is, with no cast or unwrapping", () => {
    const branded = sanitizeForDisplay(partnerControlled);
    const assigned: string = branded;
    const interpolated = `Proposed by ${branded}`;
    const concatenated = "Proposed by " + branded;
    const collected: Array<string> = [branded];
    expect(assigned).toBe(sanitized);
    expect(interpolated).toBe(`Proposed by ${sanitized}`);
    expect(concatenated).toBe(`Proposed by ${sanitized}`);
    expect(collected.join("")).toBe(sanitized);
    expect(branded.startsWith("Acme")).toBe(true);
  });
});

describe("displayText", () => {
  test("composes the same bytes the equivalent template literal would produce", () => {
    const label = sanitizeForDisplay("last name");
    const marker = displayText`partial`;
    const composed: Displayable = displayText`${label} (${marker})`;
    expect(composed).toBe("last name (partial)");
  });

  test("admits a number, whose string form is always printable ASCII", () => {
    expect(displayText`... ${7} more`).toBe("... 7 more");
  });

  test("rejects an un-sanitized string interpolation", () => {
    // @ts-expect-error -- only a Displayable or a number may be interpolated
    const composed: Displayable = displayText`Proposed by ${partnerControlled}`;
    expect(composed).toBe(`Proposed by ${partnerControlled}`);
  });

  test("an ordinary template literal drops the brand, so composing needs the tag", () => {
    const label = sanitizeForDisplay("last name");
    // @ts-expect-error -- interpolation yields a plain string, brand or not
    const composed: Displayable = `${label} (partial)`;
    expect(composed).toBe("last name (partial)");
  });
});
