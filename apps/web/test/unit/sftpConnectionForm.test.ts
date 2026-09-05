import { describe, expect, test } from "vitest";

import {
  EMPTY_SFTP_FORM,
  KEYBOARD_INTERACTIVE_REQUIRES_PASSWORD,
  PASSPHRASE_REQUIRES_PRIVATE_KEY,
  SPLIT_DIRECTORY_BOTH_HALVES_REQUIREMENT,
  SPLIT_DIRECTORY_DISTINCT_REQUIREMENT,
  SPLIT_DIRECTORY_RETAIN_REQUIREMENT,
  applyHostInput,
  buildAuthoringRequest,
  parseSftpUrl,
  sftpFormError,
  sftpFormFromLocator,
} from "@console/sftpConnectionForm";

import type {
  SftpConnectionFormValues,
  SftpCredentialMethod,
  SftpFormField,
} from "@console/sftpConnectionForm";

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

// Retain mode is read only for the split-directory precondition, so every case
// that does not author a split is unaffected by it. These two run with it on;
// the split cases call the exported functions directly with their own value.
const formError = (values: SftpConnectionFormValues) =>
  sftpFormError(values, true);
const authoringRequest = (values: SftpConnectionFormValues) =>
  buildAuthoringRequest(values, true);

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
    expect(formError(validForm())).toBeUndefined();
  });

  test("requires host and username", () => {
    expect(formError(validForm({ host: "  " }))?.field).toBe("host");
    expect(formError(validForm({ username: "" }))?.field).toBe("username");
  });

  test("rejects a host holding a URL, userinfo, a path, or whitespace", () => {
    for (const host of [
      "sftp://user:pw@host",
      "user:pw@host",
      "sftp.example.org/drop",
      "sftp .example.org",
    ]) {
      const error = formError(validForm({ host }));
      expect(error?.field).toBe("host");
    }
  });

  test("accepts a bare hostname, an IPv4, and a bracketed IPv6 literal", () => {
    for (const host of ["sftp.example.org", "10.0.0.5", "[2001:db8::1]"]) {
      expect(formError(validForm({ host }))).toBeUndefined();
    }
  });

  test("bounds an optional port", () => {
    expect(formError(validForm({ port: "70000" }))?.field).toBe("port");
    expect(formError(validForm({ port: "-1" }))?.field).toBe("port");
    expect(formError(validForm({ port: "22" }))).toBeUndefined();
  });

  test("requires a literal host-key fingerprint", () => {
    const missing = formError(validForm({ hostKeyFingerprint: "" }));
    expect(missing?.field).toBe("hostKeyFingerprint");
    expect(missing?.message).toContain("identity fingerprint");
  });

  test("names the signing-fingerprint confusion", () => {
    // A 43-char base64url value with no SHA256: prefix is a signing fingerprint.
    const error = formError(validForm({ hostKeyFingerprint: "A".repeat(43) }));
    expect(error?.field).toBe("hostKeyFingerprint");
    expect(error?.message).toContain("signing fingerprint");
  });

  test("rejects a malformed fingerprint with the SHA256 format hint", () => {
    const error = formError(
      validForm({ hostKeyFingerprint: "SHA256:not-canonical" }),
    );
    expect(error?.field).toBe("hostKeyFingerprint");
    expect(error?.message).toContain("SHA256:");
  });

  test("requires a credential source", () => {
    expect(formError(validForm({ source: undefined }))?.field).toBe(
      "credential",
    );
    expect(
      formError(validForm({ source: { kind: "mount", subPath: [] } }))?.field,
    ).toBe("credential");
  });

  test("a typed reference must be an @path", () => {
    const error = formError(
      validForm({ source: { kind: "path", ref: "/run/secrets/key" } }),
    );
    expect(error?.field).toBe("credential");
    expect(error?.message).toContain("@-file");
    expect(
      formError(
        validForm({ source: { kind: "path", ref: "@/run/secrets/key" } }),
      ),
    ).toBeUndefined();
  });

  test("accepts a pasted value as the credential source", () => {
    expect(
      formError(validForm({ source: { kind: "raw", value: "hunter2" } })),
    ).toBeUndefined();
  });

  test("a private-key passphrase must be an @path when set", () => {
    expect(
      formError(validForm({ method: "private_key", passphrasePath: "hunter2" }))
        ?.field,
    ).toBe("passphrase");
    expect(
      formError(
        validForm({
          method: "private_key",
          passphrasePath: "@/run/secrets/key.pass",
        }),
      ),
    ).toBeUndefined();
  });
});

describe("sftpFormError (credential combination, core's rules)", () => {
  /** One combination the two companion controls and the sign-in method can
   * reach: the method, whether a passphrase is set, whether keyboard-interactive
   * is armed, and the field a blocking error lands on (`undefined` where the
   * combination is coherent). */
  type Combination = readonly [
    SftpCredentialMethod,
    boolean,
    boolean,
    SftpFormField | undefined,
  ];

  /** All eight of them. Core owns which are coherent; what this pins is that
   * each incoherent one is REFUSED on the control that resolves it rather than
   * passed through and discarded. */
  const COMBINATIONS: ReadonlyArray<Combination> = [
    ["password", false, false, undefined],
    ["password", false, true, undefined],
    ["password", true, false, "passphrase"],
    ["password", true, true, "passphrase"],
    ["private_key", false, false, undefined],
    ["private_key", false, true, "keyboardInteractive"],
    ["private_key", true, false, undefined],
    ["private_key", true, true, "keyboardInteractive"],
  ];

  const formFor = ([method, passphrase, keyboardInteractive]: Combination) =>
    validForm({
      method,
      passphrasePath: passphrase ? "@/run/secrets/key.pass" : "",
      keyboardInteractive,
    });

  test("every combination draws the verdict it is labelled with", () => {
    for (const combination of COMBINATIONS)
      expect([
        ...combination.slice(0, 3),
        formError(formFor(combination))?.field,
      ]).toEqual([...combination]);
  });

  test("every refusal is worded in the console's own controls", () => {
    // An unmapped core verdict falls through in core's words on the credential
    // field, naming a configuration key the console never shows; the console's
    // own wording is what every refused combination must reach.
    const messages = [
      PASSPHRASE_REQUIRES_PRIVATE_KEY,
      KEYBOARD_INTERACTIVE_REQUIRES_PASSWORD,
    ];
    for (const combination of COMBINATIONS) {
      if (combination[3] === undefined) continue;
      const message = formError(formFor(combination))?.message ?? "";
      expect([...combination.slice(0, 3), messages.includes(message)]).toEqual([
        ...combination.slice(0, 3),
        true,
      ]);
      expect(message).not.toContain("privateKeyPassphrase");
      expect(message).not.toContain("keyboard_interactive");
    }
  });

  test("a passphrase set against a password sign-in blocks the save", () => {
    // The silent-drop shape: the operator typed a passphrase, then moved the
    // sign-in method. The request must not be built without it.
    const values = validForm({
      method: "password",
      passphrasePath: "@/run/secrets/key.pass",
    });
    expect(formError(values)?.message).toBe(PASSPHRASE_REQUIRES_PRIVATE_KEY);
    expect(authoringRequest(values)).toBeUndefined();
  });

  test("keyboard-interactive against a private key blocks the save", () => {
    const values = validForm({
      method: "private_key",
      source: { kind: "path", ref: "@/run/secrets/id" },
      keyboardInteractive: true,
    });
    expect(formError(values)?.message).toBe(
      KEYBOARD_INTERACTIVE_REQUIRES_PASSWORD,
    );
    expect(authoringRequest(values)).toBeUndefined();
  });

  test("the combination is answered before the reference format", () => {
    // A passphrase that is neither an @path nor allowed under this method draws
    // the rule that explains why it does not belong, not a format complaint.
    expect(
      formError(validForm({ method: "password", passphrasePath: "junk" }))
        ?.message,
    ).toBe(PASSPHRASE_REQUIRES_PRIVATE_KEY);
  });
});

describe("sftpFormError (split inbound/outbound directories)", () => {
  /** A form naming both halves of a split remote directory. */
  const splitForm = (
    overrides: Partial<SftpConnectionFormValues> = {},
  ): SftpConnectionFormValues =>
    validForm({
      remoteDirectory: "/exchange/in",
      outboundDirectory: "/exchange/out",
      ...overrides,
    });

  test("accepts a split pair under retain mode", () => {
    expect(sftpFormError(splitForm(), true)).toBeUndefined();
  });

  test("refuses a split without retain mode, naming the control to turn on", () => {
    const error = sftpFormError(splitForm(), false);
    expect(error?.field).toBe("outboundDirectory");
    expect(error?.message).toBe(SPLIT_DIRECTORY_RETAIN_REQUIREMENT);
    expect(error?.message).toContain("Keep every exchange file");
  });

  test("retain mode is read ONLY for a split; a shared directory is unaffected", () => {
    expect(
      sftpFormError(validForm({ remoteDirectory: "/exchange" }), false),
    ).toBeUndefined();
    expect(sftpFormError(validForm(), false)).toBeUndefined();
  });

  test("rejects two directories that resolve to the same one, in the console's words", () => {
    for (const outboundDirectory of [
      "/exchange/in",
      "/exchange/in/",
      "/exchange/./in",
      "/exchange//in",
    ]) {
      const error = sftpFormError(splitForm({ outboundDirectory }), true);
      expect(error?.field).toBe("outboundDirectory");
      expect(error?.message).toBe(SPLIT_DIRECTORY_DISTINCT_REQUIREMENT);
    }
  });

  test("an outbound directory with no inbound one lands on the empty inbound field", () => {
    // The empty half is the one to fill, and it is labelled "Inbound directory"
    // while the outbound one is set -- so the error attaches there rather than to
    // the field the operator already filled.
    const error = sftpFormError(
      validForm({ remoteDirectory: "", outboundDirectory: "/exchange/out" }),
      true,
    );
    expect(error?.field).toBe("remoteDirectory");
    expect(error?.message).toBe(SPLIT_DIRECTORY_BOTH_HALVES_REQUIREMENT);
  });

  test("no split-directory message shows a configuration key the form never names", () => {
    // Core decides WHEN a pair is wrong and words its rules over `inbound_path`
    // and `outbound_path`; the form maps each verdict to its own labels, and an
    // unmapped one falls through in core's words. Driving every pair shape this
    // form can compose holds that mapping complete: a core rewording lands here
    // as a snake_case key in front of an operator.
    const shapes: Array<Partial<SftpConnectionFormValues>> = [
      { remoteDirectory: "", outboundDirectory: "/exchange/out" },
      { remoteDirectory: "/exchange/in", outboundDirectory: "/exchange/in" },
      { remoteDirectory: "/exchange/in", outboundDirectory: "/exchange/./in" },
      { remoteDirectory: "/exchange/in", outboundDirectory: "relative/out" },
      { remoteDirectory: "/exchange/in", outboundDirectory: "/exchange/out" },
    ];
    for (const shape of shapes) {
      const message = sftpFormError(validForm(shape), true)?.message;
      if (message === undefined) continue;
      expect(message).not.toContain("inbound_path");
      expect(message).not.toContain("outbound_path");
      expect(message).not.toContain("server.path");
    }
  });
});

describe("buildAuthoringRequest", () => {
  test("builds a mountRef credential from a picked file", () => {
    const body = authoringRequest(
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

  test("builds a typed ref credential and includes a passphrase reference", () => {
    const body = authoringRequest(
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

  test("includes an armed keyboard-interactive toggle", () => {
    const body = authoringRequest(validForm({ keyboardInteractive: true }));
    expect(body?.keyboardInteractive).toBe(true);
    expect(body?.credential).toEqual({
      kind: "mountRef",
      mount: "secrets",
      subPath: ["partner-password"],
      credType: "password",
    });
  });

  test("builds a raw credential from a pasted value, untrimmed", () => {
    const body = authoringRequest(
      validForm({ source: { kind: "raw", value: "  spaced-secret  " } }),
    );
    expect(body?.credential).toEqual({
      kind: "raw",
      value: "  spaced-secret  ",
      credType: "password",
    });
  });

  test("omits an absent port, remote directory, passphrase, and toggle", () => {
    const body = authoringRequest(validForm());
    expect(body?.port).toBeUndefined();
    expect(body?.path).toBeUndefined();
    expect(body?.privateKeyPassphrase).toBeUndefined();
    expect(body?.keyboardInteractive).toBeUndefined();
  });

  test("returns undefined for an invalid form", () => {
    expect(authoringRequest(validForm({ host: "" }))).toBeUndefined();
  });

  test("a named outbound directory sends the pair, never the single path", () => {
    const body = buildAuthoringRequest(
      validForm({
        remoteDirectory: "/exchange/in",
        outboundDirectory: "/exchange/out",
      }),
      true,
    );
    expect(body?.inboundPath).toBe("/exchange/in");
    expect(body?.outboundPath).toBe("/exchange/out");
    expect(body?.path).toBeUndefined();
  });

  test("a blank outbound directory sends the single shared path", () => {
    const body = buildAuthoringRequest(
      validForm({ remoteDirectory: "/exchange", outboundDirectory: "  " }),
      true,
    );
    expect(body?.path).toBe("/exchange");
    expect(body?.inboundPath).toBeUndefined();
    expect(body?.outboundPath).toBeUndefined();
  });

  test("a split form without retain mode builds no request", () => {
    expect(
      buildAuthoringRequest(
        validForm({
          remoteDirectory: "/exchange/in",
          outboundDirectory: "/exchange/out",
        }),
        false,
      ),
    ).toBeUndefined();
  });

  test("a probe-filled fingerprint flows through identically to a typed one", () => {
    // Probe-to-fill sets hostKeyFingerprint via the SAME update() path typing uses,
    // so the required-pin check and the request build are untouched: a form left
    // without a pin is unsavable, and filling it (as the probe does) produces the
    // exact request a typed pin would -- no separate submit path exists.
    const withoutPin = validForm({ hostKeyFingerprint: "" });
    expect(formError(withoutPin)?.field).toBe("hostKeyFingerprint");
    expect(authoringRequest(withoutPin)).toBeUndefined();

    const probeFilled = { ...withoutPin, hostKeyFingerprint: FINGERPRINT };
    expect(formError(probeFilled)).toBeUndefined();
    expect(authoringRequest(probeFilled)).toEqual(
      authoringRequest(validForm()),
    );
    expect(authoringRequest(probeFilled)?.hostKeyFingerprint).toBe(FINGERPRINT);
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
    // The partner locator has no credential or fingerprint, so an authoring
    // request cannot be built from it: the accept guard rejects a launch until the
    // operator adds their own credential and fingerprint.
    const seeded = sftpFormFromLocator({ host: "sftp.partner.example" });
    expect(authoringRequest(seeded)).toBeUndefined();
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
    expect(authoringRequest(seeded)).toBeUndefined();
    expect(formError(seeded)?.field).toBe("hostKeyFingerprint");
  });

  test("the operator's fields, added on top, produce a submittable request", () => {
    const body = authoringRequest({
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
