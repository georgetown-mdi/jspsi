import { describe, expect, test } from "vitest";

import { DISPLAY_TRUNCATION_MARKER } from "@psilink/core";

import { probeSftpHostKey } from "@psi/sftpAuthoringClient";

// The appliance is trusted and its probe body is still re-validated field by
// field on the way in, so that a malformed one degrades to an honest state
// rather than reaching the operator's alert as it arrived. These pin the
// peer-answer half of that boundary, whose excerpt is bytes an untrusted party
// chose.
describe("the probe body's peer answer is re-validated client-side", () => {
  /** The appliance's cap on the escaped excerpt, mirrored by the client. */
  const EXCERPT_MAX_LENGTH = 512;

  /** A fetch answering one probe with the given JSON body. */
  function probeAnswering(body: unknown): typeof fetch {
    return () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
  }

  function unreachableWithExcerpt(excerpt: string): unknown {
    return {
      status: "unreachable",
      peerAnswer: "nonSsh",
      peerAnswerShape: "http",
      peerAnswerExcerpt: excerpt,
    };
  }

  test("an excerpt within the bound crosses whole", async () => {
    const excerpt = "HTTP/1.1 403 Forbidden\\x0d\\x0a";
    const result = await probeSftpHostKey(
      "sftp.example.org",
      undefined,
      probeAnswering(unreachableWithExcerpt(excerpt)),
    );
    expect(result).toEqual({
      kind: "unreachable",
      peerAnswer: { kind: "nonSsh", shape: "http", excerpt },
    });
  });

  test("an over-long excerpt is truncated rather than carried at whatever length it arrived", async () => {
    const result = await probeSftpHostKey(
      "sftp.example.org",
      undefined,
      probeAnswering(unreachableWithExcerpt("A".repeat(10_000))),
    );

    expect(result.kind).toBe("unreachable");
    const peerAnswer =
      result.kind === "unreachable" ? result.peerAnswer : undefined;
    expect(peerAnswer?.kind).toBe("nonSsh");
    const excerpt =
      peerAnswer?.kind === "nonSsh" ? peerAnswer.excerpt : undefined;
    expect(excerpt).toBe(
      "A".repeat(EXCERPT_MAX_LENGTH) + DISPLAY_TRUNCATION_MARKER,
    );
    // The diagnosis survives the bound: an over-long excerpt is a malformed
    // body, not a reason to lose what answered the port.
    expect(peerAnswer).toEqual({
      kind: "nonSsh",
      shape: "http",
      excerpt,
    });
  });

  test("an excerpt the appliance already truncated passes through unchanged", async () => {
    // The appliance appends the marker ON TOP of its own cap, so its longest
    // honest excerpt is longer than the cap; re-applying the bound here must not
    // clip it a second time.
    const applianceTruncated =
      "A".repeat(EXCERPT_MAX_LENGTH) + DISPLAY_TRUNCATION_MARKER;
    const result = await probeSftpHostKey(
      "sftp.example.org",
      undefined,
      probeAnswering(unreachableWithExcerpt(applianceTruncated)),
    );

    expect(result).toEqual({
      kind: "unreachable",
      peerAnswer: {
        kind: "nonSsh",
        shape: "http",
        excerpt: applianceTruncated,
      },
    });
  });

  test("a shape outside the closed vocabulary degrades to the bare category", async () => {
    const result = await probeSftpHostKey(
      "sftp.example.org",
      undefined,
      probeAnswering({
        status: "unreachable",
        peerAnswer: "nonSsh",
        peerAnswerShape: "smtp",
        peerAnswerExcerpt: "220 mail.example.org ESMTP",
      }),
    );
    expect(result).toEqual({ kind: "unreachable" });
  });
});
