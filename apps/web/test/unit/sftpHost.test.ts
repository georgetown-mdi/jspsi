import { describe, expect, test } from "vitest";

import { isBareSftpHost } from "@psi/sftpHost";

// The one bare-host rule shared by the authoring form, the server PUT backstop,
// and the accept-side refusal. Tightening it is a strict improvement across every
// call site: a genuine bare address still passes, and only URL-significant or
// login-shaped values are newly rejected.
describe("isBareSftpHost", () => {
  test("accepts a bare hostname, an IPv4, and a bracketed IPv6 literal", () => {
    for (const host of [
      "sftp.example.org",
      "10.0.0.5",
      "[2001:db8::1]",
      "partner-host.internal",
    ]) {
      expect(isBareSftpHost(host)).toBe(true);
    }
  });

  test("rejects userinfo, a scheme/path separator, or whitespace", () => {
    for (const host of [
      "user@host",
      "sftp://host",
      "sftp.example.org/drop",
      "sftp .example.org",
    ]) {
      expect(isBareSftpHost(host)).toBe(false);
    }
  });

  test("rejects URL-significant delimiters a WHATWG hostname setter truncates on", () => {
    // `#`/`?` truncate the WHATWG hostname; `\` no-ops it; `%` introduces
    // percent-encoding. A bare address carries none of them.
    for (const host of ["foo#bar", "foo?bar", "foo\\bar", "foo%00", "foo%2f"]) {
      expect(isBareSftpHost(host)).toBe(false);
    }
  });
});
