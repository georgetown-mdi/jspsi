import { z, ZodError } from "zod";
import { describe, expect, test } from "vitest";

import { describeDecodeError } from "../src/utils/describeDecodeError";

describe("describeDecodeError", () => {
  test("collapses a real ZodError to a one-liner, not its raw issues blob", () => {
    // A real ZodError's own `.message` is the multi-line serialized issues blob
    // (field path, code, message) that the unreadable raw render surfaces;
    // describeDecodeError must instead emit a single readable `<path>: <message>`
    // line drawn from the first issue.
    const err = z
      .object({ host: z.string().max(5) })
      .safeParse({ host: "far too long" }).error;
    expect(err).toBeInstanceOf(ZodError);
    const out = describeDecodeError(err);
    expect(out).toMatch(/^host: /);
    // A one-liner, not the multi-line blob that `err.message` serializes to.
    expect(out).not.toContain("\n");
    expect(out).not.toBe((err as ZodError).message);
  });

  test("collapses a real multi-issue ZodError to one line with an '(and N more)' suffix", () => {
    // The synthetic-issue tests below pin the suffix logic; this pins the same
    // collapse on a genuine multi-issue ZodError -- the readable one-liner this
    // helper exists to produce in place of Zod's raw multi-line blob.
    const err = z
      .object({ a: z.string(), b: z.string() })
      .safeParse({ a: 1, b: 2 }).error;
    expect(err).toBeInstanceOf(ZodError);
    const out = describeDecodeError(err);
    expect(out).toMatch(/^a: .+ \(and 1 more\)$/);
    expect(out).not.toContain("\n");
  });

  test("renders a single-issue ZodError as exactly '<path>: <message>'", () => {
    expect(
      describeDecodeError({
        issues: [{ path: ["connectionEndpoint", "host"], message: "Invalid" }],
      }),
    ).toBe("connectionEndpoint.host: Invalid");
  });

  test("escapes a path component carrying control/deceptive-Unicode bytes", () => {
    // A Zod path can name a partner-controlled object KEY in the general case
    // (the invitation is crafted by the inviting party), not only a fixed schema
    // field, so a key carrying a raw ESC (ANSI) or a bidi override must reach the
    // operator escaped, never raw.
    const out = describeDecodeError({
      issues: [
        { path: ["connectionEndpoint", "\x1b[31mKEY‮"], message: "bad" },
      ],
    });
    expect(out).not.toContain("\x1b");
    expect(out).toContain("\\x1b");
    expect(out).not.toContain("‮");
    expect(out).toContain("\\u202e");
  });

  test("appends an '(and N more)' suffix for a multi-issue ZodError", () => {
    expect(
      describeDecodeError({
        issues: [
          { path: ["sharedSecret"], message: "Invalid" },
          { path: ["expires"], message: "Invalid" },
          { path: ["version"], message: "Invalid" },
        ],
      }),
    ).toBe("sharedSecret: Invalid (and 2 more)");
  });

  test("passes a plain Error's message through unchanged", () => {
    expect(describeDecodeError(new Error("invitation checksum mismatch"))).toBe(
      "invitation checksum mismatch",
    );
  });

  test("renders a pathless issue as just its message", () => {
    expect(
      describeDecodeError({
        issues: [{ message: "schema validation failed" }],
      }),
    ).toBe("schema validation failed");
  });

  test("falls back to String() for a non-Error thrown value", () => {
    expect(describeDecodeError("plain string")).toBe("plain string");
    expect(describeDecodeError(42)).toBe("42");
  });
});
