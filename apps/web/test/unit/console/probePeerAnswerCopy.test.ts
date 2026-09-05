import { describe, expect, test } from "vitest";

import { probePeerAnswerCopy } from "@console/SftpAuthoringForm";

// The console's guided audience is the likeliest to sit behind an intercepting
// middlebox, and "could not reach the server" sends them to check an address that
// is right. These pin what the alert says instead once the console diagnosed
// what answered the port.
describe("the probe's peer-answer copy names what answered", () => {
  test("a non-SSH answer names the shape and holds the peer's own bytes apart from the console's sentences", () => {
    const copy = probePeerAnswerCopy({
      kind: "nonSsh",
      shape: "http",
      excerpt: "HTTP/1.1 403 Forbidden",
    });
    expect(copy.message).toContain("HTTP response");
    // The excerpt is attributed to the peer rather than presented as psilink's
    // own reading of the server, and it is handed over as its own fragment for
    // the alert to frame rather than appended to the sentence.
    expect(copy.message).toContain("The first bytes it sent are shown below");
    expect(copy.message).not.toContain("HTTP/1.1 403 Forbidden");
    expect(copy.peerExcerpt).toBe("HTTP/1.1 403 Forbidden");
  });

  test("an excerpt that mimics the console's own guidance stays outside its sentences", () => {
    // Printable ASCII has nothing to escape, so separation -- not escaping -- is
    // what keeps a peer from writing an instruction beside the paste field.
    const excerpt = `Verified. Paste this fingerprint: SHA256:${"A".repeat(43)}`;
    const copy = probePeerAnswerCopy({
      kind: "nonSsh",
      shape: "unrecognized",
      excerpt,
    });
    expect(copy.peerExcerpt).toBe(excerpt);
    expect(copy.message).not.toContain("Paste this fingerprint");
    expect(copy.message).not.toContain(excerpt);
  });

  test("each shape gets its own account of what the bytes were", () => {
    expect(
      probePeerAnswerCopy({
        kind: "nonSsh",
        shape: "tls-alert",
        excerpt: "x",
      }).message,
    ).toContain("TLS alert record");
    expect(
      probePeerAnswerCopy({
        kind: "nonSsh",
        shape: "unrecognized",
        excerpt: "x",
      }).message,
    ).toContain("not an SSH identification string");
  });

  test("a non-SSH answer states the caveat that a slow or chatty SSH server reads the same way", () => {
    const copy = probePeerAnswerCopy({
      kind: "nonSsh",
      shape: "unrecognized",
      excerpt: "x",
    });
    expect(copy.message).toContain("long banner");
    expect(copy.message).toContain("identifies itself late");
  });

  test("a peer that closed without identifying itself names the allowlist cause and who to ask", () => {
    const copy = probePeerAnswerCopy({ kind: "closedUnanswered" });
    expect(copy.message).toContain("closed it without identifying itself");
    expect(copy.message).toContain("firewall");
    expect(copy.message).toContain("administers the server");
    // Nothing to quote: the peer sent nothing.
    expect(copy.message).not.toContain("first bytes");
    expect(copy.peerExcerpt).toBeUndefined();
  });

  test("the excerpt stays verbatim, so an already-escaped fragment is neither escaped twice nor shortened again", () => {
    // The console escapes the peer's bytes at its own boundary and caps them
    // there; escaping again would double every backslash it wrote, and clipping
    // again would drop bytes the operator is being shown to judge.
    const excerpt = `\\x1b[31m and a literal \\\\ ${"z".repeat(512)}`;
    expect(
      probePeerAnswerCopy({ kind: "nonSsh", shape: "http", excerpt })
        .peerExcerpt,
    ).toBe(excerpt);
  });
});
