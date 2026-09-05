import { describe, expect, test } from "vitest";

import { resolveSigningFingerprint } from "@psi/jobClient/signingIdentityClient";

// The console is trusted and its fingerprint body is still re-validated field
// by field on the way in. The stakes are what the card does with it: the
// fingerprint is the value the operator SHARES for a partner to pin, and the two
// file names are what they go looking for in their own folder, so a malformed
// body has to degrade to an accurate failure rather than reach either surface as it
// arrived. These pin that re-validation and the status/HTTP dispatch around it.

/** A canonical 43-character fingerprint (the final character drawn from the
 * aligned set core's regex requires). */
const FINGERPRINT = "B".repeat(42) + "A";

const IDENTITY_FILE = ".psilink-signing-identity.json";
const CERTIFICATE_FILE = "psilink-certificate.json";

/** A fetch answering the one request with the given JSON body and status. */
function answering(body: unknown, status = 200): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
}

/** The server's 200 envelope for an attempt that produced a fingerprint, with
 * one field replaced (or dropped, by passing undefined). */
function okBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    status: "ok",
    fingerprint: FINGERPRINT,
    created: true,
    identityFileName: IDENTITY_FILE,
    ...overrides,
  };
  for (const [key, value] of Object.entries(body))
    if (value === undefined) delete body[key];
  return body;
}

describe("the request has the label and the toggle only", () => {
  /** Resolve one fingerprint through a fetch that records what it was called
   * with and answers a well-formed body. */
  async function captureRequest(
    identity: string,
    exportCertificate?: boolean,
  ): Promise<{ url: unknown; init: RequestInit | undefined }> {
    let url: unknown;
    let init: RequestInit | undefined;
    const recording: typeof fetch = (input, options) => {
      url = input;
      init = options;
      return Promise.resolve(
        new Response(JSON.stringify(okBody()), { status: 200 }),
      );
    };
    await resolveSigningFingerprint(identity, exportCertificate, recording);
    return { url, init };
  }

  test("a plain request POSTs the identity and nothing else", async () => {
    const { url, init } = await captureRequest("Agency A, contact@a.example");
    expect(url).toBe("/api/jobs/signing/fingerprint");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      identity: "Agency A, contact@a.example",
    });
  });

  test("the export toggle adds one boolean, and no path field ever appears", async () => {
    const { init } = await captureRequest("Agency A", true);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual({ identity: "Agency A", exportCertificate: true });
    // The server composes every path; nothing name- or path-shaped is
    // representable on the way out either.
    for (const key of Object.keys(body))
      expect(["identity", "exportCertificate"]).toContain(key);
  });
});

describe("the ok body is re-validated field by field", () => {
  test("a well-formed body crosses whole", async () => {
    expect(
      await resolveSigningFingerprint(
        "Agency A",
        true,
        answering(okBody({ certificateFileName: CERTIFICATE_FILE })),
      ),
    ).toEqual({
      kind: "ok",
      fingerprint: FINGERPRINT,
      created: true,
      identityFileName: IDENTITY_FILE,
      certificateFileName: CERTIFICATE_FILE,
    });
  });

  test("an absent certificate name stays absent rather than becoming a key", async () => {
    const outcome = await resolveSigningFingerprint(
      "Agency A",
      false,
      answering(okBody({ created: false })),
    );
    expect(outcome).toEqual({
      kind: "ok",
      fingerprint: FINGERPRINT,
      created: false,
      identityFileName: IDENTITY_FILE,
    });
    expect("certificateFileName" in outcome).toBe(false);
  });

  test.each([
    ["a value that is not a string", 12345],
    ["an absent value", undefined],
    ["a short digest", "B".repeat(41) + "A"],
    ["a long digest", "B".repeat(43) + "A"],
    ["an unaligned final character", "D".repeat(43)],
    ["a character outside base64url", "B".repeat(42) + "+"],
    ["an empty string", ""],
  ])(
    "a fingerprint that is %s is a malformed body, never a value to share",
    async (_label, fingerprint) => {
      expect(
        await resolveSigningFingerprint(
          "Agency A",
          false,
          answering(okBody({ fingerprint })),
        ),
      ).toEqual({ kind: "error" });
    },
  );

  test.each([
    ["a string", "true"],
    ["absent", undefined],
  ])(
    "a created flag that is %s is a malformed body (the card states which happened)",
    async (_label, created) => {
      expect(
        await resolveSigningFingerprint(
          "Agency A",
          false,
          answering(okBody({ created })),
        ),
      ).toEqual({ kind: "error" });
    },
  );

  test.each([
    ["a POSIX separator", "keys/identity.json"],
    ["a Windows separator", "keys\\identity.json"],
    ["a parent reference", ".."],
    ["the current directory", "."],
    ["an empty name", ""],
    ["a name past 255 characters", "a".repeat(256)],
    ["a value that is not a string", 7],
    ["an absent value", undefined],
  ])(
    "an identity file name holding %s is a malformed body, not a location to render",
    async (_label, identityFileName) => {
      // The name is rendered as a file the operator goes looking for in one
      // folder, so anything that describes a location instead is refused whole
      // rather than shown.
      expect(
        await resolveSigningFingerprint(
          "Agency A",
          false,
          answering(okBody({ identityFileName })),
        ),
      ).toEqual({ kind: "error" });
    },
  );

  test("a 255-character name is admitted, so the bound is the limit and not a rounding", async () => {
    const identityFileName = "a".repeat(255);
    expect(
      await resolveSigningFingerprint(
        "Agency A",
        false,
        answering(okBody({ identityFileName })),
      ),
    ).toMatchObject({ kind: "ok", identityFileName });
  });

  test("a malformed certificate name fails the whole body, not just its own field", async () => {
    // Dropping the bad name and keeping the fingerprint would tell the operator
    // an export landed somewhere this client could not name.
    expect(
      await resolveSigningFingerprint(
        "Agency A",
        true,
        answering(
          okBody({ certificateFileName: "../psilink-certificate.json" }),
        ),
      ),
    ).toEqual({ kind: "error" });
  });

  test.each([
    ["null", null],
    ["an array", [{ status: "ok" }]],
    ["a bare string", "ok"],
    ["a number", 200],
  ])("a 200 body that is %s is an error", async (_label, body) => {
    expect(
      await resolveSigningFingerprint("Agency A", false, answering(body)),
    ).toEqual({ kind: "error" });
  });
});

describe("the outcome is read from the body's status, not from the HTTP status", () => {
  test.each([
    ["refused", { kind: "refused" }],
    ["timeout", { kind: "timeout" }],
  ])("a 200 holding status %s is that category", async (status, expected) => {
    expect(
      await resolveSigningFingerprint("Agency A", false, answering({ status })),
    ).toEqual(expected);
  });

  test.each([
    ["a category this client does not know", { status: "noIdentityLabel" }],
    ["no status at all", { fingerprint: FINGERPRINT, created: true }],
    ["a status that is not a string", { status: 0 }],
  ])(
    "a 200 holding %s degrades to an error rather than an empty ok",
    async (_label, body) => {
      expect(
        await resolveSigningFingerprint("Agency A", false, answering(body)),
      ).toEqual({ kind: "error" });
    },
  );
});

describe("the HTTP status dispatches before the body is read", () => {
  test("a 404 is the disabled build, whatever the body says", async () => {
    // A hosted build serves the whole job API 404, so the status decides even
    // when a body that looks like a success rides along.
    expect(
      await resolveSigningFingerprint(
        "Agency A",
        false,
        answering(okBody(), 404),
      ),
    ).toEqual({ kind: "disabled" });
  });

  test("a 409 is the retryable busy state", async () => {
    expect(
      await resolveSigningFingerprint("Agency A", false, answering(null, 409)),
    ).toEqual({ kind: "busy" });
  });

  test("a 400 passes the server's field-path reason through", async () => {
    expect(
      await resolveSigningFingerprint(
        "Agency A",
        false,
        answering({ error: "identity: must not begin with '-'" }, 400),
      ),
    ).toEqual({
      kind: "invalid",
      message: "identity: must not begin with '-'",
    });
  });

  test.each([
    ["an empty object", JSON.stringify({})],
    ["an error field that is not a string", JSON.stringify({ error: 400 })],
    ["an empty error field", JSON.stringify({ error: "" })],
    ["a body that is not JSON at all", "<html>bad request</html>"],
  ])(
    "a 400 whose body holds %s falls back to a fixed message",
    async (_label, body) => {
      const outcome = await resolveSigningFingerprint("Agency A", false, () =>
        Promise.resolve(new Response(body, { status: 400 })),
      );
      expect(outcome).toEqual({
        kind: "invalid",
        message: "Your identity could not be read. Check it and try again.",
      });
    },
  );

  test.each([
    ["a 500", 500],
    ["a 403", 403],
    ["a 502", 502],
  ])("%s is a generic error", async (_label, status) => {
    expect(
      await resolveSigningFingerprint(
        "Agency A",
        false,
        answering({ status: "ok" }, status),
      ),
    ).toEqual({ kind: "error" });
  });

  test("a fetch that never completes is an error, not a rejection the card must catch", async () => {
    expect(
      await resolveSigningFingerprint("Agency A", false, () =>
        Promise.reject(new Error("network down")),
      ),
    ).toEqual({ kind: "error" });
  });
});
