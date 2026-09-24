import { describe, expect, test } from "vitest";

import {
  ExchangeSpecSchema,
  parseExchangeSpec,
  parseSensitiveYaml,
  snakeizeKey,
  snakeizeKeys,
} from "@psilink/core";

import {
  HANDOFF_CREDENTIAL_PATH_PLACEHOLDER,
  HANDOFF_PASSPHRASE_PATH_PLACEHOLDER,
  HANDOFF_SHARED_DIRECTORY_PLACEHOLDER,
  HANDOFF_SIGNING_IDENTITY_PLACEHOLDER,
  buildJobHandoff,
} from "@jobs/handoff";

import {
  COMPOSED_BLOCKS,
  carriedThroughFields,
  runHandoffMergeBase,
} from "@jobs/configLoad";

import {
  TEST_HOST_KEY_FINGERPRINT,
  composedServer,
  validIntent,
  validLinkageTerms,
  validSftpIntent,
} from "../../utils/jobFixtures";

import type { ExchangeSpec } from "@psilink/core";
import type { JobFiledropExchangeIntent } from "@jobs/intentSchemas";
import type { JobHandoff } from "@jobs/handoff";
import type { JobSftpServerEntry } from "@jobs/sftpServer";

/**
 * What a console run's hand-off makes of the configuration it was opened from:
 * which of that document's settings the export keeps, which the composition
 * writes over, and which top-level blocks may be kept at all.
 *
 * Everything here runs in process. The parity claim against the REAL CLI's own
 * bytes -- a configuration `psilink invite` or `psilink accept` wrote, opened,
 * run and handed back -- needs the built program and lives in the interop
 * project (test/interop/consoleExportParity.test.ts).
 */

/** A schema-valid shared secret, for the assertion that no such value reaches
 * an export however it got into the document. */
const RUN_SHARED_SECRET = "b".repeat(42) + "A";

/** The rendezvous folder the mounted document names, which belongs to the
 * machine that wrote it and reaches no template. */
const MOUNTED_RENDEZVOUS_PATH = "/srv/partner-drop";

/** A signing partner fingerprint of the canonical base64url shape. */
const PARTNER_FINGERPRINT = "C".repeat(42) + "A";

/** Retain mode with the two settings it requires, which a split folder pair
 * requires in turn. */
const RETAIN_OPTIONS = {
  retainFiles: true,
  timestampInFilename: true,
  locklessRendezvous: true,
};

/** A signing block naming both paths of the machine the document was written
 * on. */
const MOUNTED_SIGNING = {
  mode: "certificate" as const,
  partnerFingerprint: PARTNER_FINGERPRINT,
  identityFile: "/home/operator/.psilink/identity.json",
  receiptOutput: "/home/operator/receipt.json",
};

/** A distinct partner fingerprint, standing in for the console run's own
 * signing values where a test asserts they override the mounted document's. */
const CONSOLE_PARTNER_FINGERPRINT = "D".repeat(42) + "A";

describe("the settings a loaded configuration keeps in the export", () => {
  /** A mounted document stating a setting the console composes no key for, and
   * a rendezvous folder of the machine it was written on. */
  function mountedDocument(
    authentication: Record<string, unknown>,
    rest: Record<string, unknown> = {},
  ) {
    return parseExchangeSpec({
      connection: { channel: "filedrop", path: MOUNTED_RENDEZVOUS_PATH },
      linkageTerms: validLinkageTerms(),
      authentication,
      ...rest,
    });
  }

  /** The export of a file-drop run composed over that document, which the
   * operator converted to the console's own paths where `converted` says so. */
  function exportOver(
    document: ExchangeSpec | undefined,
    intentOverrides: Partial<JobFiledropExchangeIntent> = {},
    converted = false,
  ): string {
    const handoff = handoffOver(document, intentOverrides, converted);
    if (handoff.template.kind !== "config")
      throw new Error("an exchange hand-off composed no template");
    return handoff.template.yaml;
  }

  /** The whole hand-off {@link exportOver} reads the template of. */
  function handoffOver(
    document: ExchangeSpec | undefined,
    intentOverrides: Partial<JobFiledropExchangeIntent> = {},
    converted = false,
  ): JobHandoff {
    return buildJobHandoff(
      validIntent({ linkageTerms: validLinkageTerms(), ...intentOverrides }),
      undefined,
      {
        credentialPasted: false,
        filedropSplit: false,
        ...(document !== undefined
          ? { mountedDocument: document, mountedDocumentConverted: converted }
          : {}),
      },
    );
  }

  /** One setting of an exported template, read by the name the load states it
   * under: the file's own snake_case path. */
  function exportedValue(exported: string, field: string): unknown {
    const document = snakeizeKeys(
      parseExchangeSpec(parseSensitiveYaml(exported, "export parity")),
    ) as Record<string, unknown>;
    return field
      .split(".")
      .reduce<unknown>(
        (value, key) =>
          typeof value === "object" && value !== null
            ? (value as Record<string, unknown>)[key]
            : undefined,
        document,
      );
  }

  test("a run's export states the max-age policy the run composed", () => {
    const document = mountedDocument({ tokenMaxAgeDays: 30 });
    const exported = exportOver(runHandoffMergeBase(document), {
      tokenMaxAgeDays: 7,
    });
    expect(carriedThroughFields(document)).toEqual([]);
    expect(
      exportedValue(exported, "authentication.token_max_age_days"),
    ).toEqual(7);
  });

  test("a max-age policy turned off for the run is off in its export", () => {
    const exported = exportOver(
      runHandoffMergeBase(mountedDocument({ tokenMaxAgeDays: 30 })),
    );
    expect(exported).not.toContain("authentication");
  });

  test("an unconverted export states the rendezvous folder as read", () => {
    const document = mountedDocument({ tokenMaxAgeDays: 30 });
    expect(exportedValue(exportOver(document), "connection.path")).toBe(
      MOUNTED_RENDEZVOUS_PATH,
    );
    expect(carriedThroughFields(document)).not.toContain("connection.path");
  });

  test("an unconverted export states a split folder pair as read", () => {
    const document = parseExchangeSpec({
      connection: {
        channel: "filedrop",
        inboundPath: "/srv/partner-in",
        outboundPath: "/srv/partner-out",
        options: RETAIN_OPTIONS,
      },
      linkageTerms: validLinkageTerms(),
    });
    const exported = exportOver(document, { options: RETAIN_OPTIONS });
    expect(exportedValue(exported, "connection.inbound_path")).toBe(
      "/srv/partner-in",
    );
    expect(exportedValue(exported, "connection.outbound_path")).toBe(
      "/srv/partner-out",
    );
    expect(exportedValue(exported, "connection.path")).toBeUndefined();
  });

  test("a converted export states the placeholder for the rendezvous folder", () => {
    const document = mountedDocument({ tokenMaxAgeDays: 30 });
    expect(
      exportedValue(exportOver(document, {}, true), "connection.path"),
    ).toBe(HANDOFF_SHARED_DIRECTORY_PLACEHOLDER);
  });

  test("an unsigned run over an unconverted certificate file hands off its signing block unchanged", () => {
    const document = mountedDocument(
      { tokenMaxAgeDays: 30 },
      { signing: MOUNTED_SIGNING },
    );
    const exported = exportOver(document, { signing: { mode: "none" } });
    expect(exportedValue(exported, "signing")).toEqual({
      mode: "certificate",
      partner_fingerprint: PARTNER_FINGERPRINT,
      identity_file: MOUNTED_SIGNING.identityFile,
      receipt_output: MOUNTED_SIGNING.receiptOutput,
    });
    expect(carriedThroughFields(document)).toEqual([]);
  });

  test("a certificate block handed off as read with the party name removed names linkage_terms.identity", () => {
    const document = mountedDocument(
      { tokenMaxAgeDays: 30 },
      { signing: MOUNTED_SIGNING },
    );
    const { identity: _removed, ...termsWithoutIdentity } = validLinkageTerms();
    const handoff = handoffOver(document, {
      linkageTerms: termsWithoutIdentity,
      signing: { mode: "none" },
    });
    expect(handoff.signingSettingsToSet).toEqual(["linkage_terms.identity"]);
    if (handoff.template.kind !== "config")
      throw new Error("an exchange hand-off composed no template");
    expect(exportedValue(handoff.template.yaml, "signing.mode")).toBe(
      "certificate",
    );
    expect(
      exportedValue(handoff.template.yaml, "linkage_terms.identity"),
    ).toBeUndefined();
  });

  test("a certificate block handed off as read with no identity file names signing.identity_file", () => {
    const { identityFile: _unset, ...signingWithoutIdentityFile } =
      MOUNTED_SIGNING;
    const document = mountedDocument(
      { tokenMaxAgeDays: 30 },
      { signing: signingWithoutIdentityFile },
    );
    const { identity: _removed, ...termsWithoutIdentity } = validLinkageTerms();
    expect(
      handoffOver(document, { signing: { mode: "none" } }).signingSettingsToSet,
    ).toEqual(["signing.identity_file"]);
    expect(
      handoffOver(document, {
        linkageTerms: termsWithoutIdentity,
        signing: { mode: "none" },
      }).signingSettingsToSet,
    ).toEqual(["linkage_terms.identity", "signing.identity_file"]);
  });

  test("a pairable certificate block names no setting and hands off unchanged", () => {
    const document = mountedDocument(
      { tokenMaxAgeDays: 30 },
      { signing: MOUNTED_SIGNING },
    );
    const handoff = handoffOver(document, { signing: { mode: "none" } });
    expect(handoff.signingSettingsToSet).toBeUndefined();
    if (handoff.template.kind !== "config")
      throw new Error("an exchange hand-off composed no template");
    expect(exportedValue(handoff.template.yaml, "signing")).toEqual({
      mode: "certificate",
      partner_fingerprint: PARTNER_FINGERPRINT,
      identity_file: MOUNTED_SIGNING.identityFile,
      receipt_output: MOUNTED_SIGNING.receiptOutput,
    });
    expect(
      handoffOver(mountedDocument({ tokenMaxAgeDays: 30 }), {
        signing: { mode: "certificate" },
      }).signingSettingsToSet,
    ).toBeUndefined();
  });

  test("a signed run over an unconverted file with no signing block names the placeholder identity", () => {
    const document = mountedDocument({ tokenMaxAgeDays: 30 });
    const exported = exportOver(document, {
      signing: {
        mode: "certificate",
        partnerFingerprint: CONSOLE_PARTNER_FINGERPRINT,
      },
    });
    expect(exportedValue(exported, "signing")).toEqual({
      mode: "certificate",
      partner_fingerprint: CONSOLE_PARTNER_FINGERPRINT,
      identity_file: HANDOFF_SIGNING_IDENTITY_PLACEHOLDER,
    });
  });

  test("an unconverted export keeps a signing block under a mode left unchanged", () => {
    const signing = {
      mode: "none" as const,
      identityFile: MOUNTED_SIGNING.identityFile,
    };
    const document = mountedDocument({ tokenMaxAgeDays: 30 }, { signing });
    const exported = exportOver(document, { signing: { mode: "none" } });
    expect(exportedValue(exported, "signing.mode")).toBe("none");
    expect(exportedValue(exported, "signing.identity_file")).toBe(
      MOUNTED_SIGNING.identityFile,
    );
  });

  test("a converted export states the console's signing identity and no receipt file", () => {
    const document = mountedDocument(
      { tokenMaxAgeDays: 30 },
      { signing: MOUNTED_SIGNING },
    );
    const exported = exportOver(
      document,
      {
        signing: {
          mode: "certificate",
          partnerFingerprint: PARTNER_FINGERPRINT,
        },
      },
      true,
    );
    expect(exportedValue(exported, "signing.identity_file")).toBe(
      HANDOFF_SIGNING_IDENTITY_PLACEHOLDER,
    );
    expect(exportedValue(exported, "signing.receipt_output")).toBeUndefined();
  });

  test("signing turned off in the console drops a converted signing block", () => {
    const document = mountedDocument(
      { tokenMaxAgeDays: 30 },
      { signing: MOUNTED_SIGNING },
    );
    // No `signing` override: the run's own intent composes no signing block.
    const exported = exportOver(document, {}, true);
    expect(exportedValue(exported, "signing")).toBeUndefined();
    expect(exported).not.toContain("signing:");
  });

  test("the console's partner pin overrides the mounted one once converted", () => {
    const document = mountedDocument(
      { tokenMaxAgeDays: 30 },
      { signing: MOUNTED_SIGNING },
    );
    const exported = exportOver(
      document,
      {
        signing: {
          mode: "certificate",
          partnerFingerprint: CONSOLE_PARTNER_FINGERPRINT,
        },
      },
      true,
    );
    expect(exportedValue(exported, "signing.partner_fingerprint")).toBe(
      CONSOLE_PARTNER_FINGERPRINT,
    );
  });

  test("a hand-off merged over the whole document keeps its authentication block", () => {
    // The merge a hand-back into an unconducted configuration makes: the block
    // sits outside COMPOSED_BLOCKS, so the document's own survives.
    expect(exportOver(mountedDocument({ tokenMaxAgeDays: 30 }))).toContain(
      "token_max_age_days: 30",
    );
  });

  test("a converted composition wins over the document it was opened from", () => {
    const exported = exportOver(
      mountedDocument({ tokenMaxAgeDays: 30 }),
      {},
      true,
    );
    expect(exported).not.toContain(MOUNTED_RENDEZVOUS_PATH);
    expect(exported).toContain(HANDOFF_SHARED_DIRECTORY_PLACEHOLDER);
  });

  test("a shared secret in the document reaches no export", () => {
    // The load refuses a document stating one, so this states it past that
    // refusal: the writer strips it whatever it is handed.
    const exported = exportOver(
      mountedDocument({
        sharedSecret: RUN_SHARED_SECRET,
        expires: "2026-12-31T00:00:00.000Z",
        tokenMaxAgeDays: 30,
      }),
    );
    expect(exported).not.toContain(RUN_SHARED_SECRET);
    expect(exported).not.toContain("shared_secret");
    expect(exported).not.toContain("expires");
    expect(exported).toContain("token_max_age_days: 30");
  });

  test("a console that opened no configuration exports its composition", () => {
    expect(exportOver(undefined)).not.toContain("authentication");
  });
});

describe("the sftp credential paths a loaded configuration keeps in the export", () => {
  /** The credential files the console run was pointed at, which are container
   * paths and reach no template. */
  const RUN_PASSWORD_PATH = "@/run/secrets/password";
  const RUN_KEY_PATH = "@/run/secrets/id_ed25519";
  const RUN_PASSPHRASE_PATH = "@/run/secrets/passphrase";

  /** A mounted sftp document whose server states `credential`. */
  function sftpDocument(credential: Record<string, string>): ExchangeSpec {
    return parseExchangeSpec({
      connection: {
        channel: "sftp",
        server: {
          host: "sftp.example.org",
          hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
          ...credential,
        },
      },
      linkageTerms: validLinkageTerms(),
    });
  }

  /** The exported `connection.server` of a run over `document` with the run's
   * own credential `runCredential`. */
  function exportedServer(
    document: ExchangeSpec,
    runCredential: Partial<JobSftpServerEntry>,
    converted: boolean,
  ): Record<string, unknown> {
    const handoff = buildJobHandoff(
      validSftpIntent({ linkageTerms: validLinkageTerms() }),
      {
        host: "sftp.example.org",
        hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
        ...runCredential,
      },
      {
        credentialPasted: false,
        filedropSplit: false,
        mountedDocument: document,
        mountedDocumentConverted: converted,
      },
    );
    if (handoff.template.kind !== "config")
      throw new Error("an exchange hand-off composed no template");
    return composedServer(handoff.template.yaml);
  }

  /** The full rendered hand-off YAML of a run over `document` with the run's own
   * credential `runCredential`, for the assertion that an inline mounted-document
   * value never reaches the template TEXT (composedServer only checks the parsed
   * field, and a leak anywhere in the file is what a no-leak assertion holds). */
  function exportedYaml(
    document: ExchangeSpec,
    runCredential: Partial<JobSftpServerEntry>,
    converted: boolean,
  ): string {
    const handoff = buildJobHandoff(
      validSftpIntent({ linkageTerms: validLinkageTerms() }),
      {
        host: "sftp.example.org",
        hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
        ...runCredential,
      },
      {
        credentialPasted: false,
        filedropSplit: false,
        mountedDocument: document,
        mountedDocumentConverted: converted,
      },
    );
    if (handoff.template.kind !== "config")
      throw new Error("an exchange hand-off composed no template");
    return handoff.template.yaml;
  }

  test("an unconverted export states the password path as read", () => {
    const server = exportedServer(
      sftpDocument({ password: "@/home/operator/.psilink/password" }),
      { password: RUN_PASSWORD_PATH },
      false,
    );
    expect(server.password).toBe("@/home/operator/.psilink/password");
  });

  test("an unconverted export states the private key and passphrase paths as read", () => {
    const server = exportedServer(
      sftpDocument({
        privateKey: "@/home/operator/.ssh/id_ed25519",
        privateKeyPassphrase: "@/home/operator/.ssh/passphrase",
      }),
      { privateKey: RUN_KEY_PATH, privateKeyPassphrase: RUN_PASSPHRASE_PATH },
      false,
    );
    expect(server.private_key).toBe("@/home/operator/.ssh/id_ed25519");
    expect(server.private_key_passphrase).toBe(
      "@/home/operator/.ssh/passphrase",
    );
  });

  test("a converted export states the placeholders for all three credential paths", () => {
    const password = exportedServer(
      sftpDocument({ password: "@/home/operator/.psilink/password" }),
      { password: RUN_PASSWORD_PATH },
      true,
    );
    expect(password.password).toBe(HANDOFF_CREDENTIAL_PATH_PLACEHOLDER);
    const key = exportedServer(
      sftpDocument({
        privateKey: "@/home/operator/.ssh/id_ed25519",
        privateKeyPassphrase: "@/home/operator/.ssh/passphrase",
      }),
      { privateKey: RUN_KEY_PATH, privateKeyPassphrase: RUN_PASSPHRASE_PATH },
      true,
    );
    expect(key.private_key).toBe(HANDOFF_CREDENTIAL_PATH_PLACEHOLDER);
    expect(key.private_key_passphrase).toBe(
      HANDOFF_PASSPHRASE_PATH_PLACEHOLDER,
    );
  });

  test("an inline credential in the document reaches no export", () => {
    const inlinePassword = "an-inline-password-value";
    const server = exportedServer(
      sftpDocument({ password: inlinePassword }),
      { password: RUN_PASSWORD_PATH },
      false,
    );
    expect(server.password).toBe(HANDOFF_CREDENTIAL_PATH_PLACEHOLDER);
  });

  test("an inline private key and passphrase in the document reach no export", () => {
    const inlinePrivateKey = "an-inline-private-key-value";
    const inlinePassphrase = "an-inline-passphrase-value";
    const yaml = exportedYaml(
      sftpDocument({
        privateKey: inlinePrivateKey,
        privateKeyPassphrase: inlinePassphrase,
      }),
      { privateKey: RUN_KEY_PATH, privateKeyPassphrase: RUN_PASSPHRASE_PATH },
      false,
    );
    expect(yaml).not.toContain(inlinePrivateKey);
    expect(yaml).not.toContain(inlinePassphrase);
    const server = composedServer(yaml);
    expect(server.private_key).toBe(HANDOFF_CREDENTIAL_PATH_PLACEHOLDER);
    expect(server.private_key_passphrase).toBe(
      HANDOFF_PASSPHRASE_PATH_PLACEHOLDER,
    );
  });

  test("a converted export states placeholders over inline document credentials", () => {
    const inlinePassword = "an-inline-password-value";
    const passwordYaml = exportedYaml(
      sftpDocument({ password: inlinePassword }),
      { password: RUN_PASSWORD_PATH },
      true,
    );
    expect(passwordYaml).not.toContain(inlinePassword);
    expect(composedServer(passwordYaml).password).toBe(
      HANDOFF_CREDENTIAL_PATH_PLACEHOLDER,
    );

    const inlinePrivateKey = "an-inline-private-key-value";
    const inlinePassphrase = "an-inline-passphrase-value";
    const keyYaml = exportedYaml(
      sftpDocument({
        privateKey: inlinePrivateKey,
        privateKeyPassphrase: inlinePassphrase,
      }),
      { privateKey: RUN_KEY_PATH, privateKeyPassphrase: RUN_PASSPHRASE_PATH },
      true,
    );
    expect(keyYaml).not.toContain(inlinePrivateKey);
    expect(keyYaml).not.toContain(inlinePassphrase);
    const key = composedServer(keyYaml);
    expect(key.private_key).toBe(HANDOFF_CREDENTIAL_PATH_PLACEHOLDER);
    expect(key.private_key_passphrase).toBe(
      HANDOFF_PASSPHRASE_PATH_PLACEHOLDER,
    );
  });

  test("an unconverted export carries an @path key but not an inline passphrase", () => {
    const inlinePassphrase = "an-inline-passphrase-value";
    const yaml = exportedYaml(
      sftpDocument({
        privateKey: "@/home/operator/.ssh/id_ed25519",
        privateKeyPassphrase: inlinePassphrase,
      }),
      { privateKey: RUN_KEY_PATH, privateKeyPassphrase: RUN_PASSPHRASE_PATH },
      false,
    );
    expect(yaml).not.toContain(inlinePassphrase);
    const server = composedServer(yaml);
    expect(server.private_key).toBe("@/home/operator/.ssh/id_ed25519");
    expect(server.private_key_passphrase).toBe(
      HANDOFF_PASSPHRASE_PATH_PLACEHOLDER,
    );
  });

  test("a sign-in method the run changed keeps the run's placeholder", () => {
    const server = exportedServer(
      sftpDocument({ password: "@/home/operator/.psilink/password" }),
      { privateKey: RUN_KEY_PATH },
      false,
    );
    expect(server.password).toBeUndefined();
    expect(server.private_key).toBe(HANDOFF_CREDENTIAL_PATH_PLACEHOLDER);
  });
});

describe("the blocks the export holds from the mounted document are pinned", () => {
  test("authentication is the only block held outside the composed ones", () => {
    const held = Object.keys(ExchangeSpecSchema.shape)
      .map((key) => snakeizeKey(key))
      .filter((key) => !COMPOSED_BLOCKS.has(key))
      .sort();
    expect(
      held,
      "the hand-off holds every top-level block of the mounted document that " +
        "sits outside COMPOSED_BLOCKS, so a new block in core's " +
        "ExchangeSpecSchema must be either composed by this console or added " +
        "to the load's credential-name refusals (credentialFieldsNotAdopted) " +
        "before it may be held.",
    ).toEqual(["authentication"]);
  });
});
