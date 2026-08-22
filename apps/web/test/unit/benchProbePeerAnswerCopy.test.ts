import { describe, expect, test } from "vitest";

import { probePeerAnswerMessage } from "@bench/SftpAuthoringForm";

// The console's guided audience is the likeliest to sit behind an intercepting
// middlebox, and "could not reach the server" sends them to check an address that
// is right. These pin what the alert says instead once the appliance diagnosed
// what answered the port.
describe("the probe's peer-answer copy names what answered", () => {
  test("a non-SSH answer names the shape and quotes the peer's own bytes", () => {
    const message = probePeerAnswerMessage({
      kind: "nonSsh",
      shape: "http",
      excerpt: "HTTP/1.1 403 Forbidden",
    });
    expect(message).toContain("HTTP response");
    expect(message).toContain("HTTP/1.1 403 Forbidden");
    // The excerpt is attributed to the peer rather than presented as psilink's
    // own reading of the server.
    expect(message).toContain("The first bytes it sent were");
  });

  test("each shape gets its own account of what the bytes were", () => {
    expect(
      probePeerAnswerMessage({
        kind: "nonSsh",
        shape: "tls-alert",
        excerpt: "x",
      }),
    ).toContain("TLS alert record");
    expect(
      probePeerAnswerMessage({
        kind: "nonSsh",
        shape: "unrecognized",
        excerpt: "x",
      }),
    ).toContain("not an SSH identification string");
  });

  test("a non-SSH answer carries the caveat that a slow or chatty SSH server reads the same way", () => {
    const message = probePeerAnswerMessage({
      kind: "nonSsh",
      shape: "unrecognized",
      excerpt: "x",
    });
    expect(message).toContain("long banner");
    expect(message).toContain("identifies itself late");
  });

  test("a peer that closed without identifying itself names the allowlist cause and who to ask", () => {
    const message = probePeerAnswerMessage({ kind: "closedUnanswered" });
    expect(message).toContain("closed it without identifying itself");
    expect(message).toContain("firewall");
    expect(message).toContain("administers the server");
    // Nothing to quote: the peer sent nothing.
    expect(message).not.toContain("first bytes");
  });

  test("the excerpt is interpolated verbatim, so an already-escaped fragment is not escaped twice", () => {
    // The appliance escapes the peer's bytes at its own boundary; escaping again
    // here would double every backslash it wrote.
    const excerpt = "\\x1b[31m and a literal \\\\";
    expect(
      probePeerAnswerMessage({ kind: "nonSsh", shape: "http", excerpt }),
    ).toContain(excerpt);
  });
});
