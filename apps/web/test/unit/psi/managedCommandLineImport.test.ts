import { describe, expect, test } from "vitest";

import {
  assembleExchangeSpec,
  connectionFromLocator,
  generateSharedSecret,
  getDefaultLinkageTerms,
  parseExchangeSpec,
  parseSensitiveYaml,
  snakeizeKey,
  snakeizeKeys,
} from "@psilink/core";

import { stringify as stringifyYaml } from "yaml";

import { ZodError } from "zod";

import {
  ManagedConfigurationRefusedError,
  readManagedCommandLineConfiguration,
} from "@psi/managed/managedCommandLineImport";
import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  runnableManagedExchange,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  composeManagedCronExport,
  composeManagedCronExportConfig,
} from "@psi/managed/managedCronExport";
import { managedImportFileKind } from "@psi/managed/managedExchangeImport";

import {
  encodeManagedExchangeArtifact,
  serializeManagedExchangeArtifact,
} from "@psi/managed/managedExchangeArtifact";

import type {
  ExchangeSpec,
  WebRTCConnectionConfig,
  WebRTCExchangeLocator,
} from "@psilink/core";
import type { NewManagedExchange } from "@psi/managed/managedExchangeRecord";

// Reading a command-line psilink.yaml back as a configuration-only record: what
// the app accepts, what it refuses and in whose words, that an unedited import
// and re-export is the same document, and that what lands holds no secret and so
// runs nowhere here.

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

const webrtcLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
  path: "/api/",
};

/** The document the app itself composes, which is what its own command-line
 * export writes. */
function composedDocument(
  overrides: Partial<Parameters<typeof composeManagedExchangeFile>[0]> = {},
): ExchangeSpec {
  return composeManagedExchangeFile({
    connection: webrtcLocator,
    linkageTerms,
    ...overrides,
  });
}

function newExchange(
  overrides: Partial<NewManagedExchange> = {},
): NewManagedExchange {
  return {
    label: "Riverbend quarterly",
    exchangeFile: composedDocument(),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  };
}

/** The `psilink.yaml` text the app's own command-line export writes for a
 * record: the file an operator brings back. */
function exportedConfigText(overrides: Partial<NewManagedExchange> = {}) {
  return composeManagedCronExport(
    runnableManagedExchangeOrRefuse(
      buildManagedExchangeRecord(newExchange(overrides)),
    ),
  ).config.text;
}

/** A hand-written configuration file, in the snake_case the CLI reads. */
function configText(document: unknown): string {
  return stringifyYaml(snakeizeKeys(document));
}

/** The document a hand-written file holds: the composed one plus the two fields
 * the export injects, since that is what a file on disk looks like. */
function commandLineDocument(overrides: Record<string, unknown> = {}) {
  const composed = composedDocument();
  return {
    ...composed,
    connection: { ...composed.connection, role: "acceptor" },
    ...overrides,
  };
}

/** A hand-written file holding one key spelled exactly as the operator wrote it,
 * at the document, the connection, or the connection's server block. The other
 * fixtures pass through the snake_case rewrite {@link configText} applies, which
 * would respell the key before the import ever read it. */
function configTextHoldingKey(
  key: string,
  block: "document" | "connection" | "server",
): string {
  const document = snakeizeKeys(commandLineDocument()) as Record<
    string,
    unknown
  >;
  const connection = document.connection as Record<string, unknown>;
  const line = { [key]: "hand-edited line" };
  if (block === "document") return stringifyYaml({ ...document, ...line });
  if (block === "connection")
    return stringifyYaml({
      ...document,
      connection: { ...connection, ...line },
    });
  return stringifyYaml({
    ...document,
    connection: {
      ...connection,
      server: { ...(connection.server as Record<string, unknown>), ...line },
    },
  });
}

/** The refusal a file meets, failing the test if it was accepted instead. */
function refusal(source: string): string {
  try {
    readManagedCommandLineConfiguration(source);
  } catch (error) {
    if (error instanceof ManagedConfigurationRefusedError) return error.message;
    throw error;
  }
  throw new Error("the import accepted a configuration it should have refused");
}

describe("accepting a command-line configuration", () => {
  test("the app's own exported psilink.yaml imports back", () => {
    const record = readManagedCommandLineConfiguration(exportedConfigText());

    expect(record.side).toBe("inviter");
    expect(record.exchangeFile.linkageTerms).toEqual(linkageTerms);
    expect(record.exchangeFile.connection.channel).toBe("webrtc");
  });

  test("a hand-written file's role becomes the record's side, off the document", () => {
    const record = readManagedCommandLineConfiguration(
      configText(commandLineDocument()),
    );

    expect(record.side).toBe("acceptor");
    expect(record.exchangeFile.connection).not.toHaveProperty("role");
  });

  test("the max-age policy is read as a local field, and the block dropped", () => {
    const record = readManagedCommandLineConfiguration(
      exportedConfigText({ tokenMaxAgeDays: 90 }),
    );

    expect(record.tokenMaxAgeDays).toBe(90);
    expect(record.exchangeFile.authentication).toBeUndefined();
  });

  test("what lands holds no secret, so it is not runnable", () => {
    const record = readManagedCommandLineConfiguration(exportedConfigText());

    expect(record.sharedSecret).toBeUndefined();
    expect(runnableManagedExchange(record)).toBe(false);
    expect(record.expires).toBeUndefined();
    expect(record.schedule).toBeUndefined();
    expect(record.lastRun).toBeUndefined();
  });
});

describe("refusing what this app cannot hold", () => {
  test("a connection on another channel names the channel and the limit", () => {
    const message = refusal(
      configText({
        ...composedDocument(),
        connection: { channel: "filedrop", path: "/srv/drop" },
      }),
    );

    expect(message).toContain("filedrop");
    expect(message).toContain("webrtc exchanges only");
  });

  test("a credential-bearing connection names the fields, never their values", () => {
    const credential = "turn-credential-not-in-any-message";
    const message = refusal(
      configText(
        commandLineDocument({
          connection: {
            ...connectionFromLocator(webrtcLocator),
            role: "inviter",
            turn: [
              {
                url: "turn:relay.example.org:3478",
                username: "operator",
                credential,
              },
            ],
          },
        }),
      ),
    );

    expect(message).toContain("turn");
    expect(message).not.toContain(credential);
  });

  test("a document holding a signing block is refused by field name", () => {
    const identityFile = "@/home/operator/signing-identity-not-in-any-message";
    const message = refusal(
      configText(
        commandLineDocument({
          signing: { mode: "certificate", identityFile },
        }),
      ),
    );

    expect(message).toContain("signing");
    expect(message).not.toContain(identityFile);
  });

  test("a shared secret in the file is refused: the key file is not imported", () => {
    const secret = generateSharedSecret();
    const message = refusal(
      configText(
        commandLineDocument({ authentication: { sharedSecret: secret } }),
      ),
    );

    expect(message).toContain("shared_secret");
    expect(message).toContain(".psilink.key");
    expect(message).not.toContain(secret);
  });

  test("a connection naming no role is refused rather than guessed", () => {
    const message = refusal(configText(composedDocument()));

    expect(message).toContain("role: inviter");
    expect(message).toContain("role: acceptor");
  });

  test("bytes that are not YAML at all are refused", () => {
    expect(() => readManagedCommandLineConfiguration("\tnot: [yaml")).toThrow();
  });

  test("a document off the exchange-file schema names the lines to fix", () => {
    const message = refusal(
      configText(
        commandLineDocument({ linkage_terms: { identity: "no keys here" } }),
      ),
    );

    expect(message).toContain("linkage_terms");
    expect(message).toContain("import it again");
  });

  test("a key outside the schema is named, not mistaken for another file", () => {
    const message = refusal(
      configText(commandLineDocument({ surprise_field: "hand-edited line" })),
    );

    expect(message).toContain("surprise_field");
    expect(message).toContain("import it again");
  });

  test("a key outside the schema under a block is named with its block", () => {
    const document = commandLineDocument();
    const message = refusal(
      configText({
        ...document,
        connection: {
          ...(document.connection as WebRTCConnectionConfig),
          secret_sauce: "hand-edited line",
        },
      }),
    );

    expect(message).toContain("connection.secret_sauce");
  });

  test.each(["mysteryKey", "Mystery-Key", "MYSTERY_KEY"])(
    "a top-level key outside the schema is named exactly as written: %s",
    (key) => {
      const message = refusal(configTextHoldingKey(key, "document"));

      expect(message).toContain(key);
      expect(message).not.toContain(snakeizeKey(key));
    },
  );

  test.each(["mysteryKey", "Mystery-Key", "MYSTERY_KEY"])(
    "a key outside the schema under the connection is named as written: %s",
    (key) => {
      const message = refusal(configTextHoldingKey(key, "connection"));

      expect(message).toContain(`connection.${key}`);
      expect(message).not.toContain(snakeizeKey(key));
    },
  );

  test("a key outside the schema under a nested block is refused, not trimmed", () => {
    // The blocks below the top level strip an unrecognized key on parse, so an
    // import that stored the parse result would hand the command line back a
    // file a line short of the one it read.
    const document = commandLineDocument();
    const message = refusal(
      configText({
        ...document,
        linkageTerms: { ...document.linkageTerms, mysterySetting: "a line" },
      }),
    );

    expect(message).toContain("linkage_terms.mystery_setting");
    expect(message).toContain("import it again");
  });

  test("one setting written in both spellings is refused, naming both lines", () => {
    // The case conversion ahead of the schema reads the two as one key and keeps
    // one of them, so neither the parse nor the document-against-result
    // comparison sees the other go. The refusal names both lines to fix.
    const message = refusal(
      stringifyYaml({
        ...(snakeizeKeys(commandLineDocument()) as Record<string, unknown>),
        expected_payload_columns: ["partner_program"],
        expectedPayloadColumns: ["other_program"],
      }),
    );

    expect(message).toContain("expected_payload_columns");
    expect(message).toContain("expectedPayloadColumns");
    expect(message).not.toContain("partner_program");
  });

  test("a key outside the schema under the server block is refused, not trimmed", () => {
    const message = refusal(configTextHoldingKey("mysteryKey", "server"));

    expect(message).toContain("server.mysteryKey");
    expect(() =>
      readManagedCommandLineConfiguration(
        configTextHoldingKey("mysteryKey", "server"),
      ),
    ).toThrow(ManagedConfigurationRefusedError);
  });

  test("a refused field is named as the file spells it, not as Zod saw it", () => {
    const document = commandLineDocument({ csvDelimiter: ";;" });
    const connection = document.connection as WebRTCConnectionConfig;
    const message = refusal(
      configText({
        ...document,
        connection: {
          ...connection,
          server: { ...connection.server, port: 70_000 },
        },
      }),
    );

    expect(message).toContain("csv_delimiter");
    expect(message).toContain("connection.server.port");
    expect(message).not.toContain("csvDelimiter");
  });

  test("nothing about a refused file is representable as a record", () => {
    expect(() =>
      readManagedCommandLineConfiguration(configText({ connection: {} })),
    ).toThrow();
  });
});

describe("import then export", () => {
  test("re-exporting an unedited import yields an equivalent document", () => {
    const exported = exportedConfigText({ tokenMaxAgeDays: 45 });
    const record = readManagedCommandLineConfiguration(exported);

    const reexported = composeManagedCronExportConfig(record).config.text;

    expect(
      parseExchangeSpec(parseSensitiveYaml(reexported, "re-export")),
    ).toEqual(parseExchangeSpec(parseSensitiveYaml(exported, "export")));
  });

  test("a setting this app holds without an editor survives the round trip", () => {
    // The rule's middle outcome: a setting the app can keep but not edit is
    // written back out as it was read (docs/spec/EXCHANGE_FILE.md, "What a
    // consumer does with a setting it cannot honor"). `retention_disposition` is
    // one -- operator-authored free text a stored document may hold, which no
    // screen here edits.
    const note = "Filed with the program office for seven years.";
    const imported = configText({
      ...commandLineDocument(),
      retentionDisposition: note,
    });
    const record = readManagedCommandLineConfiguration(imported);

    expect(record.exchangeFile.retentionDisposition).toBe(note);
    const reexported = parseExchangeSpec(
      parseSensitiveYaml(
        composeManagedCronExportConfig(record).config.text,
        "re-export",
      ),
    );
    expect(reexported.retentionDisposition).toBe(note);
  });

  test("the fail-closed per-party fields survive the round trip", () => {
    const exported = exportedConfigText({
      exchangeFile: composedDocument({
        metadata: [
          {
            name: "case_id",
            type: "identifier",
            role: "identifier",
            isPayload: false,
          },
          { name: "program", type: "other", role: "payload", isPayload: true },
        ],
        disclosedPayloadColumns: ["program"],
        expectedPayloadColumns: ["partner_program"],
        expectedPartnerDeduplicate: true,
      }),
    });
    const record = readManagedCommandLineConfiguration(exported);

    expect(record.exchangeFile.disclosedPayloadColumns).toEqual(["program"]);
    expect(record.exchangeFile.expectedPayloadColumns).toEqual([
      "partner_program",
    ]);
    expect(record.exchangeFile.expectedPartnerDeduplicate).toBe(true);

    const reexported = parseExchangeSpec(
      parseSensitiveYaml(
        composeManagedCronExportConfig(record).config.text,
        "re-export",
      ),
    );
    expect(reexported.disclosedPayloadColumns).toEqual(["program"]);
    expect(reexported.expectedPayloadColumns).toEqual(["partner_program"]);
    expect(reexported.expectedPartnerDeduplicate).toBe(true);
  });
});

describe("routing a file to its leg", () => {
  test("the app's backup artifact routes to the backup leg", () => {
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(
        runnableManagedExchangeOrRefuse(
          buildManagedExchangeRecord(newExchange()),
        ),
      ),
    );

    expect(managedImportFileKind(bytes)).toBe("backup");
  });

  test("a command-line configuration routes to the configuration leg", () => {
    expect(managedImportFileKind(exportedConfigText())).toBe(
      "command-line-configuration",
    );
  });

  test("bytes that parse as neither are the backup leg's to refuse", () => {
    expect(managedImportFileKind("\tnot: [yaml")).toBe("backup");
  });
});

describe("the configuration-only record shape", () => {
  test("a schedule cannot be stored on a record holding no secret", () => {
    const configuration =
      readManagedCommandLineConfiguration(exportedConfigText());

    expect(() =>
      buildManagedExchangeRecord({
        label: configuration.label,
        exchangeFile: configuration.exchangeFile,
        side: configuration.side,
        schedule: {
          anchor: "2026-01-06T14:00:00.000Z",
          intervalDays: 7,
          windowSeconds: 3600,
          nextWindow: "2026-01-13T14:00:00.000Z",
          consecutiveMisses: 0,
        },
      }),
    ).toThrow(ZodError);
  });

  test("the widest assembled document is still what the app composes", () => {
    // The probe the refusals measure against: a spec assembled from the same
    // locator holds only fields the import accepts, so a refusal above reports a
    // field the file added rather than one composition itself produces.
    const assembled = assembleExchangeSpec({
      connection: connectionFromLocator(webrtcLocator),
      linkageTerms,
    });

    expect(() =>
      readManagedCommandLineConfiguration(
        configText({
          ...assembled,
          connection: { ...assembled.connection, role: "inviter" },
        }),
      ),
    ).not.toThrow();
  });
});
