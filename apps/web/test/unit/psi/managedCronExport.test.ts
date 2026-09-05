import { describe, expect, test } from "vitest";

import {
  assembleExchangeSpec,
  connectionFromLocator,
  generateSharedSecret,
  getDefaultLinkageTerms,
  parseExchangeSpec,
  parseSensitiveYaml,
} from "@psilink/core";

import {
  CRON_EXPORT_CONFIG_FILE_NAME,
  CRON_EXPORT_INPUT_FILE_NAME,
  CRON_EXPORT_KEY_FILE_NAME,
  CRON_EXPORT_OUTPUT_FILE_NAME,
  composeManagedCronExport,
} from "@psi/managed/managedCronExport";
import {
  MANAGED_EXCHANGE_ARTIFACT_VERSION,
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  keyFileFieldsSchema,
  parseManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import {
  importManagedExchangeArtifact,
  serializeExchangeDocument,
} from "@psi/managed/managedExchangeArtifact";

import type {
  ExchangeLocator,
  ExchangeSpec,
  WebRTCConnectionConfig,
  WebRTCExchangeLocator,
} from "@psilink/core";
import type {
  ManagedExchangeRecord,
  ManagedExchangeSide,
  NewManagedExchange,
} from "@psi/managed/managedExchangeRecord";

// The command-line export composer, tested in Node without a store, a download,
// or a spend: the two files it emits are the ones `psilink exchange` opens, the
// document it composes is the stored one plus exactly the two fields the CLI
// needs, the secret stays in the key half, the source record is untouched, and a
// record the app could not have created is refused rather than exported.

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

const webrtcLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
  path: "/api/",
};

function newExchange(
  overrides: Partial<NewManagedExchange> = {},
): NewManagedExchange {
  return {
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: webrtcLocator,
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  };
}

function managedRecord(
  overrides: Partial<NewManagedExchange> = {},
): ManagedExchangeRecord {
  return buildManagedExchangeRecord(newExchange(overrides));
}

/** The exported configuration read back the way the CLI reads it: the sensitive
 * YAML chokepoint, then core's exchange-file parser. */
function parseExportedConfig(record: ManagedExchangeRecord) {
  return parseExchangeSpec(
    parseSensitiveYaml(
      composeManagedCronExport(record).config.text,
      "exported psilink.yaml",
    ),
  );
}

describe("the two files the CLI opens", () => {
  test("are named for the CLI's default config and key paths", () => {
    const exported = composeManagedCronExport(managedRecord());
    expect(exported.config.fileName).toBe("psilink.yaml");
    expect(exported.key.fileName).toBe(".psilink.key");
    expect(CRON_EXPORT_CONFIG_FILE_NAME).toBe("psilink.yaml");
    expect(CRON_EXPORT_KEY_FILE_NAME).toBe(".psilink.key");
  });

  test("the exported configuration parses through core's exchange-spec parser", () => {
    const parsed = parseExportedConfig(
      managedRecord({ expires: "2026-04-06T14:00:00.000Z" }),
    );
    expect(parsed.connection.channel).toBe("webrtc");
    expect(parsed.linkageTerms).toEqual(linkageTerms);
  });

  test("the exported configuration is the snake_case YAML the CLI loads", () => {
    const exported = composeManagedCronExport(
      managedRecord({ tokenMaxAgeDays: 90 }),
    );
    // parseExchangeSpec camelizes, so it would accept either spelling; the
    // on-disk file is snake_case, which is what a CLI load and an operator
    // reading the file both expect.
    expect(exported.config.text).toContain("linkage_terms:");
    expect(exported.config.text).toContain("token_max_age_days: 90");
    expect(exported.config.text).not.toContain("linkageTerms:");
  });

  test("the emitted command is the CLI's own invocation, run beside the two files", () => {
    // `psilink exchange [options] INPUT_FILE [OUTPUT_FILE]` with the config and
    // key read at their defaults: no flag the CLI does not have, and no path.
    expect(composeManagedCronExport(managedRecord()).command).toBe(
      `psilink exchange ${CRON_EXPORT_INPUT_FILE_NAME} ${CRON_EXPORT_OUTPUT_FILE_NAME}`,
    );
  });
});

describe("the injected role", () => {
  test.each<ManagedExchangeSide>(["inviter", "acceptor"])(
    "equals the record's side (%s)",
    (side) => {
      const record = managedRecord({ side });
      const parsed = parseExportedConfig(record);
      expect(parsed.connection).toMatchObject({
        channel: "webrtc",
        role: side,
      });
      // The stored document has none: the browser dispatches on the local side
      // field, and only the CLI derives a peer id from `role`.
      expect(record.exchangeFile.connection).not.toHaveProperty("role");
    },
  );

  test("is the only thing the export adds to a policy-free document", () => {
    const record = managedRecord();
    // Nothing synthesized: no stun list the browser run never used, no path or
    // value from any machine, and no field the stored document did not have.
    expect(parseExportedConfig(record)).toEqual({
      ...record.exchangeFile,
      connection: { ...record.exchangeFile.connection, role: record.side },
    });
  });
});

describe("the max-age policy", () => {
  test("is included in the exported document so it survives CLI rotation", () => {
    const parsed = parseExportedConfig(managedRecord({ tokenMaxAgeDays: 90 }));
    // The CLI stamps a rotated token's expires only from this config key, so an
    // export that dropped it would hand over a bound that lapses at the first
    // rotation.
    expect(parsed.authentication).toEqual({ tokenMaxAgeDays: 90 });
  });

  test("leaves no authentication block at all when the record has none", () => {
    const record = managedRecord();
    expect(parseExportedConfig(record).authentication).toBeUndefined();
    expect(composeManagedCronExport(record).config.text).not.toContain(
      "authentication",
    );
  });

  test("puts no secret into the configuration half", () => {
    const record = managedRecord({
      tokenMaxAgeDays: 90,
      expires: "2026-04-06T14:00:00.000Z",
    });
    const exported = composeManagedCronExport(record);
    // The secret and its bound ride the key file alone: the authentication block
    // the export writes is the operator-authored, secret-free spelling, and the
    // CLI's loader would warn-and-strip an injected field found here.
    expect(exported.config.text).not.toContain(record.sharedSecret);
    expect(exported.config.text).not.toContain("shared_secret");
    expect(exported.config.text).not.toContain("expires");
    const parsed = parseExportedConfig(record);
    expect(parsed.authentication?.sharedSecret).toBeUndefined();
    expect(parsed.authentication?.expires).toBeUndefined();
  });
});

describe("the exported key file", () => {
  test("parses as the CLI key-file shape, with the exact CLI field names", () => {
    const record = managedRecord({ expires: "2026-04-06T14:00:00.000Z" });
    const exported = composeManagedCronExport(record);
    const parsed: unknown = JSON.parse(exported.key.text);
    // The .psilink.key file the CLI reads is camelCase JSON, parsed without a
    // snake_case conversion, so the file's own key names must be exactly these.
    expect(Object.keys(parsed as object).sort()).toEqual([
      "expires",
      "sharedSecret",
    ]);
    const key = keyFileFieldsSchema.parse(parsed);
    expect(key.sharedSecret).toBe(record.sharedSecret);
    expect(key.expires).toBe(record.expires);
  });

  test("omits expires when no bound is in force", () => {
    const record = managedRecord();
    const parsed: unknown = JSON.parse(
      composeManagedCronExport(record).key.text,
    );
    expect(Object.keys(parsed as object)).toEqual(["sharedSecret"]);
    expect(keyFileFieldsSchema.parse(parsed).sharedSecret).toBe(
      record.sharedSecret,
    );
  });

  test("is written the way the CLI writes one: 2-space JSON, trailing newline", () => {
    const record = managedRecord();
    expect(composeManagedCronExport(record).key.text).toBe(
      `${JSON.stringify({ sharedSecret: record.sharedSecret }, null, 2)}\n`,
    );
  });
});

describe("neither exported file is an importable artifact", () => {
  test("the import flow refuses both", () => {
    // The hand-off's surfaces say these two files are the exchange's backup of
    // record, and name no import recovery -- because there is nothing here the
    // import flow takes. That is this check rather than a sentence in the copy.
    const exported = composeManagedCronExport(managedRecord());
    for (const file of [exported.config, exported.key])
      expect(() => importManagedExchangeArtifact(file.text)).toThrow();
  });
});

describe("the source record", () => {
  test("is not mutated by an export", () => {
    const record = managedRecord({
      tokenMaxAgeDays: 90,
      expires: "2026-04-06T14:00:00.000Z",
    });
    const before = structuredClone(record);
    composeManagedCronExport(record);
    expect(record).toEqual(before);
  });

  test("still parses as a valid stored record after an export", () => {
    const record = managedRecord({ tokenMaxAgeDays: 90 });
    composeManagedCronExport(record);
    // The stored document must have no authentication block (the read-path
    // refine rejects one), so the injected block must not have leaked back.
    expect(() => parseManagedExchangeRecord(record)).not.toThrow();
    expect(record.exchangeFile.authentication).toBeUndefined();
    expect(record.exchangeFile.connection).not.toHaveProperty("role");
  });
});

describe("a record that is not a webrtc exchange", () => {
  const nonWebrtcLocators: Array<[string, ExchangeLocator]> = [
    ["filedrop", { channel: "filedrop", path: "/srv/exchange" }],
    ["sftp", { channel: "sftp", host: "sftp.example.org", path: "/exchange" }],
  ];

  test.each(nonWebrtcLocators)(
    "is refused rather than exported (%s)",
    (channel, locator) => {
      // Unreachable through the UI -- a managed connection is composed from a
      // credential-free webrtc locator -- but reachable by importing a
      // hand-crafted artifact, so the export gates on the channel discriminant
      // exactly as the re-run dispatch does.
      const record = managedRecord({
        exchangeFile: assembleExchangeSpec({
          connection: connectionFromLocator(locator),
          linkageTerms,
        }),
      });
      expect(() => composeManagedCronExport(record)).toThrow(
        new RegExp(`webrtc[\\s\\S]*${channel}`),
      );
    },
  );
});

/** A record as a hand-crafted artifact import produces one. The import path
 * validates the embedded document with the FULL exchange schema rather than the
 * credential-free locator composition, so a document the app itself could never
 * compose reaches a record this way -- each import below succeeding is the
 * reachability half of the refusal the test then asserts. */
function importedRecordWithDocument(
  exchangeFile: ExchangeSpec,
): ManagedExchangeRecord {
  return importManagedExchangeArtifact(
    JSON.stringify({
      artifactVersion: MANAGED_EXCHANGE_ARTIFACT_VERSION,
      exchangeDocument: serializeExchangeDocument(exchangeFile),
      key: { sharedSecret: generateSharedSecret() },
      local: { label: "Imported quarterly", side: "inviter" },
    }),
  );
}

function importedRecordWithConnection(
  connection: WebRTCConnectionConfig,
): ManagedExchangeRecord {
  return importedRecordWithDocument(
    assembleExchangeSpec({ connection, linkageTerms }),
  );
}

/** The message the export refuses a record with, failing the test if it composed
 * one instead. */
function exportRefusal(record: ManagedExchangeRecord): string {
  try {
    composeManagedCronExport(record);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("the export composed a record it was expected to refuse");
}

describe("a webrtc connection outside the credential-free locator subset", () => {
  const locatorServer = {
    host: "signaling.example.org",
    port: 3000,
    path: "/api/",
  };

  // Each row is a field the shared webrtc connection schema can represent and
  // the locator expansion never writes: the export must name it and republish
  // none of it. The value column is what the emitted psilink.yaml would have
  // handed the CLI to resolve, and is what the refusal must not echo back.
  const outsideLocatorSubset: Array<
    [string, WebRTCConnectionConfig, string, string]
  > = [
    [
      "a TURN relay credential",
      {
        channel: "webrtc",
        server: locatorServer,
        turn: [
          {
            url: "turn:relay.example.org",
            username: "relay-account",
            credential: "@/home/other/turn.secret",
          },
        ],
      },
      "turn",
      "@/home/other/turn.secret",
    ],
    [
      "an opaque provider-options token",
      {
        channel: "webrtc",
        server: locatorServer,
        providerOptions: { token: "@/home/other/peerjs.token" },
      },
      "provider_options",
      "@/home/other/peerjs.token",
    ],
    [
      "an ICE-provision auth block",
      {
        channel: "webrtc",
        server: locatorServer,
        iceProvision: {
          host: "ice.example.org",
          auth: { bearer: "@/home/other/ice.bearer" },
        },
      },
      "ice_provision",
      "@/home/other/ice.bearer",
    ],
    [
      "a PeerJS server key",
      {
        channel: "webrtc",
        server: { ...locatorServer, key: "@/home/other/peerjs.key" },
      },
      "server.key",
      "@/home/other/peerjs.key",
    ],
    [
      "a server username",
      {
        channel: "webrtc",
        server: { ...locatorServer, username: "other-machine-account" },
      },
      "server.username",
      "other-machine-account",
    ],
    [
      "a server provisioning endpoint's auth",
      {
        channel: "webrtc",
        server: {
          ...locatorServer,
          provision: {
            host: "provision.example.org",
            auth: { bearer: "@/home/other/provision.bearer" },
          },
        },
      },
      "server.provision",
      "@/home/other/provision.bearer",
    ],
    [
      "a stun list the locator never carried",
      {
        channel: "webrtc",
        server: locatorServer,
        stun: ["stun:stun.example.org"],
      },
      "stun",
      "stun:stun.example.org",
    ],
    [
      "a document-carried role",
      { channel: "webrtc", server: locatorServer, role: "acceptor" },
      "role",
      "acceptor",
    ],
  ];

  test.each(outsideLocatorSubset)(
    "is refused rather than republished (%s)",
    (_case, connection, field, value) => {
      const record = importedRecordWithConnection(connection);
      const message = exportRefusal(record);
      expect(message).toContain(field);
      // Named in kind: the field, never what it holds.
      expect(message).not.toContain(value);
    },
  );

  test("names every offending field at once, and no value", () => {
    const record = importedRecordWithConnection({
      channel: "webrtc",
      server: { ...locatorServer, key: "@/home/other/peerjs.key" },
      turn: [
        {
          url: "turn:relay.example.org",
          username: "relay-account",
          credential: "@/home/other/turn.secret",
        },
      ],
      providerOptions: { token: "@/home/other/peerjs.token" },
    });
    const message = exportRefusal(record);
    // The whole list, in one deterministic order, and nothing else named.
    expect(message).toContain("Remove: provider_options, server.key, turn");
    for (const value of [
      "@/home/other/peerjs.key",
      "@/home/other/peerjs.token",
      "@/home/other/turn.secret",
    ])
      expect(message).not.toContain(value);
  });

  test("admits a locator that has only the optional fields it composed", () => {
    // The allowlist is the expansion's own output, so an omitted optional
    // locator field is admitted exactly as a present one is.
    const record = managedRecord({
      exchangeFile: composeManagedExchangeFile({
        connection: { channel: "webrtc", host: "signaling.example.org" },
        linkageTerms,
      }),
    });
    expect(parseExportedConfig(record).connection).toEqual({
      channel: "webrtc",
      server: { host: "signaling.example.org" },
      role: record.side,
    });
  });
});

describe("an authentication block on the stored document", () => {
  function recordCarrying(
    authentication: ExchangeSpec["authentication"],
    overrides: Partial<NewManagedExchange> = {},
  ): ManagedExchangeRecord {
    const record = managedRecord(overrides);
    return {
      ...record,
      exchangeFile: { ...record.exchangeFile, authentication },
    };
  }

  test("is not a record shape the read path admits", () => {
    // The refusals below are the composer holding its own contract on the shape
    // it is handed, not a second copy of this rule -- so this measures the same
    // secret-bearing block they do.
    expect(() =>
      parseManagedExchangeRecord(
        recordCarrying({
          sharedSecret: generateSharedSecret(),
          expires: "2026-04-06T14:00:00.000Z",
        }),
      ),
    ).toThrow();
  });

  test.each([
    ["no max-age policy is set", {}],
    ["a max-age policy is set", { tokenMaxAgeDays: 90 }],
  ] as Array<[string, Partial<NewManagedExchange>]>)(
    "cannot reach the configuration half when %s",
    (_case, overrides) => {
      const secret = generateSharedSecret();
      const record = recordCarrying(
        { sharedSecret: secret, expires: "2026-04-06T14:00:00.000Z" },
        overrides,
      );
      const message = exportRefusal(record);
      expect(message).toContain("authentication");
      expect(message).not.toContain(secret);
    },
  );
});

describe("a signing block on the stored document", () => {
  // Every field here is live on the operator's scheduled CLI run: identityFile
  // is opened as this party's private signing identity, receiptOutput is a
  // verbatim local write path, and partnerFingerprint is the pin a presented
  // partner certificate is trusted against.
  const signing = {
    mode: "certificate",
    identityFile: "@/home/other/psilink-signing.identity",
    partnerFingerprint: "0123456789012345678901234567890123456789abA",
    receiptOutput: "/home/other/receipts/planted-receipt.json",
  } as const;

  function importedRecordWithSigning(): ManagedExchangeRecord {
    return importedRecordWithDocument(
      assembleExchangeSpec({
        connection: connectionFromLocator(webrtcLocator),
        linkageTerms,
        signing,
      }),
    );
  }

  test("rides a hand-crafted artifact into a record the read path admits", () => {
    // Unreachable through the app: the record composer's input has no signing
    // field, and the read path refines away only an authentication block. So the
    // import succeeds and the export is the only gate between the block and the
    // emitted psilink.yaml.
    const record = importedRecordWithSigning();
    expect(record.exchangeFile.signing).toEqual(signing);
    expect(() => parseManagedExchangeRecord(record)).not.toThrow();
  });

  test("is refused rather than republished, naming the block and no value", () => {
    const message = exportRefusal(importedRecordWithSigning());
    expect(message).toContain("signing");
    for (const value of [
      signing.identityFile,
      signing.partnerFingerprint,
      signing.receiptOutput,
    ])
      expect(message).not.toContain(value);
  });
});

describe("the exportable top-level document fields", () => {
  test("admit every field the record composer itself writes", () => {
    // The allowlist is the composer's own output, so a document holding each
    // optional block exports rather than being refused as unrecognized.
    const record = managedRecord({
      exchangeFile: composeManagedExchangeFile({
        connection: webrtcLocator,
        linkageTerms,
        metadata: [
          { name: "SSN", type: "ssn", role: "linkage", isPayload: false },
        ],
        standardization: [{ output: "ssn", input: "SSN" }],
        disclosedPayloadColumns: ["program"],
        expectedPayloadColumns: ["enrollment"],
        expectedPartnerDeduplicate: true,
        outboundPayloadConsent: { status: "confirmed", columns: ["program"] },
      }),
    });
    expect(parseExportedConfig(record)).toEqual({
      ...record.exchangeFile,
      connection: { ...record.exchangeFile.connection, role: record.side },
    });
  });

  test("admit the retention note the record spec sanctions", () => {
    const retentionDisposition =
      "Filed with the county records office; disposed after seven years.";
    const record = importedRecordWithDocument(
      assembleExchangeSpec({
        connection: connectionFromLocator(webrtcLocator),
        linkageTerms,
        retentionDisposition,
      }),
    );
    expect(parseExportedConfig(record).retentionDisposition).toBe(
      retentionDisposition,
    );
  });
});
