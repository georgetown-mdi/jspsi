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
} from "@psi/managedCronExport";
import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  keyFileFieldsSchema,
  parseManagedExchangeRecord,
} from "@psi/managedExchangeRecord";

import type { ExchangeLocator, WebRTCExchangeLocator } from "@psilink/core";
import type {
  ManagedExchangeRecord,
  ManagedExchangeSide,
  NewManagedExchange,
} from "@psi/managedExchangeRecord";

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
    // value from any machine, and no field the stored document did not carry.
    expect(parseExportedConfig(record)).toEqual({
      ...record.exchangeFile,
      connection: { ...record.exchangeFile.connection, role: record.side },
    });
  });
});

describe("the max-age policy", () => {
  test("is carried into the exported document so it survives CLI rotation", () => {
    const parsed = parseExportedConfig(managedRecord({ tokenMaxAgeDays: 90 }));
    // The CLI stamps a rotated token's expires only from this config key, so an
    // export that dropped it would hand over a bound that lapses at the first
    // rotation.
    expect(parsed.authentication).toEqual({ tokenMaxAgeDays: 90 });
  });

  test("leaves no authentication block at all when the record carries none", () => {
    const record = managedRecord();
    expect(parseExportedConfig(record).authentication).toBeUndefined();
    expect(composeManagedCronExport(record).config.text).not.toContain(
      "authentication",
    );
  });

  test("carries no secret into the configuration half", () => {
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

  test("still reads back as a valid stored record after an export", () => {
    const record = managedRecord({ tokenMaxAgeDays: 90 });
    composeManagedCronExport(record);
    // The stored document must carry no authentication block (the read-path
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
