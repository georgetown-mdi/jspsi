import { describe, expect, test } from "vitest";

import {
  EMPTY_SFTP_FORM,
  applyHostInput,
  buildAuthoringRequest,
  parseSftpUrl,
  sftpFormError,
  sftpFormFromLocator,
} from "@bench/sftpConnectionForm";

import type { SftpConnectionFormValues } from "@bench/sftpConnectionForm";

// A valid literal OpenSSH SHA256 host-key fingerprint (matches core's regex).
const FINGERPRINT = `SHA256:${"A".repeat(43)}`;

/** A minimal savable form: required fields plus a picked credential file. */
function validForm(
  overrides: Partial<SftpConnectionFormValues> = {},
): SftpConnectionFormValues {
  return {
    ...EMPTY_SFTP_FORM,
    host: "sftp.partner.example",
    username: "linkage",
    hostKeyFingerprint: FINGERPRINT,
    source: { kind: "mount", subPath: ["partner-password"] },
    ...overrides,
  };
}

describe("parseSftpUrl", () => {
  test("splits a full sftp URL into its fields", () => {
    expect(parseSftpUrl("sftp://linkage@sftp.example.gov:2022/drop")).toEqual({
      host: "sftp.example.gov",
      username: "linkage",
      port: 2022,
      path: "/drop",
    });
  });

  test("omits an absent user, port, and path", () => {
    expect(parseSftpUrl("sftp://sftp.example.gov")).toEqual({
      host: "sftp.example.gov",
    });
  });

  test("returns null for a non-sftp or unparseable input", () => {
    expect(parseSftpUrl("sftp.example.gov")).toBeNull();
    expect(parseSftpUrl("https://example.gov")).toBeNull();
    expect(parseSftpUrl("sftp://")).toBeNull();
  });
});

describe("applyHostInput", () => {
  test("splits a pasted sftp URL across the fields", () => {
    const result = applyHostInput(
      EMPTY_SFTP_FORM,
      "sftp://linkage@sftp.example.gov:2022/drop",
    );
    expect(result.host).toBe("sftp.example.gov");
    expect(result.username).toBe("linkage");
    expect(result.port).toBe("2022");
    expect(result.remoteDirectory).toBe("/drop");
  });

  test("sets the raw text as the host when it is not a URL", () => {
    const result = applyHostInput(EMPTY_SFTP_FORM, "sftp.example.gov");
    expect(result.host).toBe("sftp.example.gov");
    expect(result.username).toBe("");
  });
});

describe("sftpFormError", () => {
  test("no error for a savable form", () => {
    expect(sftpFormError(validForm())).toBeUndefined();
  });

  test("requires host and username", () => {
    expect(sftpFormError(validForm({ host: "  " }))?.field).toBe("host");
    expect(sftpFormError(validForm({ username: "" }))?.field).toBe("username");
  });

  test("rejects a host carrying a URL, userinfo, a path, or whitespace", () => {
    for (const host of [
      "sftp://user:pw@host",
      "user:pw@host",
      "sftp.example.org/drop",
      "sftp .example.org",
    ]) {
      const error = sftpFormError(validForm({ host }));
      expect(error?.field).toBe("host");
    }
  });

  test("accepts a bare hostname, an IPv4, and a bracketed IPv6 literal", () => {
    for (const host of ["sftp.example.org", "10.0.0.5", "[2001:db8::1]"]) {
      expect(sftpFormError(validForm({ host }))).toBeUndefined();
    }
  });

  test("bounds an optional port", () => {
    expect(sftpFormError(validForm({ port: "70000" }))?.field).toBe("port");
    expect(sftpFormError(validForm({ port: "-1" }))?.field).toBe("port");
    expect(sftpFormError(validForm({ port: "22" }))).toBeUndefined();
  });

  test("requires a literal host-key fingerprint", () => {
    const missing = sftpFormError(validForm({ hostKeyFingerprint: "" }));
    expect(missing?.field).toBe("hostKeyFingerprint");
    expect(missing?.message).toContain("identity fingerprint");
  });

  test("names the signing-fingerprint confusion", () => {
    // A 43-char base64url value with no SHA256: prefix is a signing fingerprint.
    const error = sftpFormError(
      validForm({ hostKeyFingerprint: "A".repeat(43) }),
    );
    expect(error?.field).toBe("hostKeyFingerprint");
    expect(error?.message).toContain("signing fingerprint");
  });

  test("rejects a malformed fingerprint with the SHA256 format hint", () => {
    const error = sftpFormError(
      validForm({ hostKeyFingerprint: "SHA256:not-canonical" }),
    );
    expect(error?.field).toBe("hostKeyFingerprint");
    expect(error?.message).toContain("SHA256:");
  });

  test("requires a credential source", () => {
    expect(sftpFormError(validForm({ source: undefined }))?.field).toBe(
      "credential",
    );
    expect(
      sftpFormError(validForm({ source: { kind: "mount", subPath: [] } }))
        ?.field,
    ).toBe("credential");
  });

  test("a typed reference must be an @path", () => {
    const error = sftpFormError(
      validForm({ source: { kind: "path", ref: "/run/secrets/key" } }),
    );
    expect(error?.field).toBe("credential");
    expect(error?.message).toContain("@-file");
    expect(
      sftpFormError(
        validForm({ source: { kind: "path", ref: "@/run/secrets/key" } }),
      ),
    ).toBeUndefined();
  });

  test("accepts a pasted value as the credential source", () => {
    expect(
      sftpFormError(validForm({ source: { kind: "raw", value: "hunter2" } })),
    ).toBeUndefined();
  });

  test("a private-key passphrase must be an @path when set", () => {
    expect(
      sftpFormError(
        validForm({ method: "private_key", passphrasePath: "hunter2" }),
      )?.field,
    ).toBe("passphrase");
    expect(
      sftpFormError(
        validForm({
          method: "private_key",
          passphrasePath: "@/run/secrets/key.pass",
        }),
      ),
    ).toBeUndefined();
    // The passphrase is ignored under the password method.
    expect(
      sftpFormError(validForm({ method: "password", passphrasePath: "junk" })),
    ).toBeUndefined();
  });
});

describe("buildAuthoringRequest", () => {
  test("builds a mountRef credential from a picked file", () => {
    const body = buildAuthoringRequest(
      validForm({
        port: "2022",
        remoteDirectory: "/drop",
        source: { kind: "mount", subPath: [".ssh", "id_ed25519"] },
        method: "private_key",
      }),
    );
    expect(body).toEqual({
      host: "sftp.partner.example",
      port: 2022,
      username: "linkage",
      path: "/drop",
      hostKeyFingerprint: FINGERPRINT,
      credential: {
        kind: "mountRef",
        mount: "secrets",
        subPath: [".ssh", "id_ed25519"],
        credType: "private_key",
      },
    });
  });

  test("builds a typed ref credential and carries a passphrase reference", () => {
    const body = buildAuthoringRequest(
      validForm({
        method: "private_key",
        source: { kind: "path", ref: "@/run/secrets/id" },
        passphrasePath: "@/run/secrets/id.pass",
      }),
    );
    expect(body?.credential).toEqual({
      kind: "ref",
      ref: "@/run/secrets/id",
      credType: "private_key",
    });
    expect(body?.privateKeyPassphrase).toBe("@/run/secrets/id.pass");
  });

  test("builds a raw credential from a pasted value, untrimmed", () => {
    const body = buildAuthoringRequest(
      validForm({ source: { kind: "raw", value: "  spaced-secret  " } }),
    );
    expect(body?.credential).toEqual({
      kind: "raw",
      value: "  spaced-secret  ",
      credType: "password",
    });
  });

  test("omits an absent port, remote directory, and passphrase", () => {
    const body = buildAuthoringRequest(validForm());
    expect(body?.port).toBeUndefined();
    expect(body?.path).toBeUndefined();
    expect(body?.privateKeyPassphrase).toBeUndefined();
  });

  test("returns undefined for an invalid form", () => {
    expect(buildAuthoringRequest(validForm({ host: "" }))).toBeUndefined();
  });
});

describe("sftpFormFromLocator (accept-side pre-fill)", () => {
  test("pre-fills ONLY host/port/path; credential and fingerprint stay empty", () => {
    const seeded = sftpFormFromLocator({
      host: "sftp.partner.example",
      port: 2022,
      path: "/drop",
    });
    // The partner-supplied locator pre-fills the three locator fields...
    expect(seeded.host).toBe("sftp.partner.example");
    expect(seeded.port).toBe("2022");
    expect(seeded.remoteDirectory).toBe("/drop");
    // ...and NOTHING else: the operator supplies the username, fingerprint, and
    // credential. No invitation field can populate a credential or the fingerprint.
    expect(seeded.username).toBe("");
    expect(seeded.hostKeyFingerprint).toBe("");
    expect(seeded.source).toBeUndefined();
    expect(seeded.passphrasePath).toBe("");
    expect(seeded.method).toBe("password");
  });

  test("omits an absent port and path", () => {
    const seeded = sftpFormFromLocator({ host: "sftp.partner.example" });
    expect(seeded.port).toBe("");
    expect(seeded.remoteDirectory).toBe("");
  });

  test("a form built from the locator alone is unsubmittable", () => {
    // The partner locator carries no credential or fingerprint, so an authoring
    // request cannot be built from it: the accept guard rejects a launch until the
    // operator adds their own credential and fingerprint.
    const seeded = sftpFormFromLocator({ host: "sftp.partner.example" });
    expect(buildAuthoringRequest(seeded)).toBeUndefined();
  });

  test("still rejects a submit that lacks the operator's fingerprint", () => {
    // With the operator's username and credential filled but NO fingerprint, the
    // request is still unbuildable and the blocking error names the fingerprint --
    // the pin-before-credential control is operator-supplied and required.
    const seeded = {
      ...sftpFormFromLocator({ host: "sftp.partner.example" }),
      username: "linkage",
      source: { kind: "raw" as const, value: "hunter2" },
    };
    expect(buildAuthoringRequest(seeded)).toBeUndefined();
    expect(sftpFormError(seeded)?.field).toBe("hostKeyFingerprint");
  });

  test("the operator's fields, added on top, produce a submittable request", () => {
    const body = buildAuthoringRequest({
      ...sftpFormFromLocator({
        host: "sftp.partner.example",
        port: 2022,
        path: "/drop",
      }),
      username: "linkage",
      hostKeyFingerprint: FINGERPRINT,
      source: { kind: "mount", subPath: ["partner-password"] },
    });
    // The locator rides through as the connection's host/port/path; the operator's
    // username, fingerprint, and credential are the only source of those fields.
    expect(body).toEqual({
      host: "sftp.partner.example",
      port: 2022,
      username: "linkage",
      path: "/drop",
      hostKeyFingerprint: FINGERPRINT,
      credential: {
        kind: "mountRef",
        mount: "secrets",
        subPath: ["partner-password"],
        credType: "password",
      },
    });
  });
});
