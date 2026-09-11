import { z, ZodError } from "zod";
import { describe, expect, test } from "vitest";

import { describeDecodeError } from "../../src/utils/describeDecodeError";
import {
  boundRawFragmentForFit,
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  DEFAULT_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
} from "../../src/utils/sanitizeForDisplay";

describe("describeDecodeError", () => {
  test("collapses a real ZodError to a one-liner, not its raw issues blob", () => {
    // A real ZodError's own `.message` is the multi-line serialized issues blob
    // (field path, code, message) that the unreadable raw render produces;
    // describeDecodeError must instead emit a single readable `<path>:
    // <message>` line drawn from the first issue.
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

  test("escapes a path component holding control/deceptive-Unicode bytes", () => {
    // A Zod path can name a partner-controlled object KEY in the general case
    // (the invitation is crafted by the inviting party), not only a fixed
    // schema field, so a key holding a raw ESC (ANSI) or a bidi override must
    // reach the operator escaped, never raw.
    const out = describeDecodeError({
      issues: [
        { path: ["connectionEndpoint", "\x1b[31mKEY\u202e"], message: "bad" },
      ],
    });
    expect(out).not.toContain("\x1b");
    expect(out).toContain("\\x1b");
    expect(out).not.toContain("\u202e");
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

  // A record key the size the wire admits: on the terms-exchange route the
  // path segment is a partner-chosen `transform.params` key, which Zod's
  // `invalid_key` holds verbatim and nothing upstream bounds but the
  // transport's frame cap.
  const frameSizedKey = (units: number): string =>
    String.fromCharCode(1).repeat(units);
  const pathIssue = (segment: string): unknown => ({
    issues: [
      {
        path: ["transform", "params", segment],
        message: "Invalid key in record",
      },
    ],
  });

  test("describes a frame-sized path segment as its cut prefix does", () => {
    // The cut the fit takes first is allowed to change nothing the operator
    // reads: the description of the whole key is the description of its
    // prefix, to the byte.
    const key = frameSizedKey(2_000_000);
    const described = describeDecodeError(pathIssue(key));
    expect(described).toBe(
      describeDecodeError(
        pathIssue(boundRawFragmentForFit(key, DEFAULT_MAX_DISPLAY_LENGTH)),
      ),
    );
    expect(described).toContain(DISPLAY_TRUNCATION_MARKER);
    expect(described).toContain("Invalid key in record");
  });

  test("a frame-sized path segment costs the budget, not its own length", () => {
    // The fit measures what a segment escapes to by materializing that escaped
    // form, so an uncut segment costs time and memory linear in what the
    // partner sent -- about 1.5 seconds and half a gigabyte at this size, where
    // the cut holds both to the budget. The wall-clock bound is loose enough to
    // pass under CI load and still far below the unbounded measure.
    const key = frameSizedKey(10_000_000);
    const started = Date.now();
    const described = describeDecodeError(pathIssue(key));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(described.length).toBeLessThanOrEqual(
      COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH + DISPLAY_TRUNCATION_MARKER.length,
    );
  });

  test("redacts private-key material a decode failure's message holds", () => {
    // The sink pairs escaping with redaction, as every other display sink in
    // core does, rather than on a reading of which of today's decode failures
    // can hold a file-derived value.
    const body = "k".repeat(200);
    const out = describeDecodeError(
      new Error(
        `could not read the invitation: -----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`,
      ),
    );
    expect(out).toContain("[redacted private key]");
    expect(out).not.toContain("BEGIN");
    expect(out).not.toContain(body.slice(0, 20));
  });
});
