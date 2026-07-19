import { describe, expect, test } from "vitest";

import { parse as parseYaml } from "yaml";

import {
  MAX_NAME_LENGTH,
  disclosedColumnNames,
  safeParseExchangeSpec,
  safeParseMetadata,
} from "@psilink/core";

import {
  JOB_FILE_NAMES,
  MAX_EXPECTED_PAYLOAD_COLUMNS,
  MAX_INPUT_CSV_LENGTH,
  MAX_METADATA_COLUMNS,
  MAX_METADATA_DESCRIPTION_LENGTH,
  MAX_STANDARDIZATION_STEPS,
  MAX_STANDARDIZATION_TRANSFORMATIONS,
  composeConfigDocument,
  composeKeyFileDocument,
  composeSftpConfigDocument,
  jobExchangeIntentSchema,
} from "@jobs/intent";

import {
  SAMPLE_INPUT_FILE_REF,
  TEST_HOST_KEY_FINGERPRINT,
  TEST_SFTP_REMOTE_NAME,
  testSftpServerEntry,
  validInputFileIntent,
  validIntent,
  validLinkageTerms,
  validSftpIntent,
} from "../utils/jobFixtures";

import type { Metadata, Standardization } from "@psilink/core";

// The intent schema is the ONLY channel from the client into a CLI invocation.
// These pin its injection-closure: unknown/injection-shaped values are rejected,
// only the credential-free filedrop channel is admitted, and the composed config
// never carries a client-chosen path, host, or credential.

// The operator's authored per-party data-prep edits. `secret` is roled `ignored`;
// left to metadata inference an unrecognized column defaults to disclosed payload,
// so carrying this metadata is what keeps it off the wire.
const editedMetadata: Metadata = [
  { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
  { name: "last_name", type: "last_name", role: "linkage", isPayload: false },
  {
    name: "date_of_birth",
    type: "date_of_birth",
    role: "linkage",
    isPayload: false,
  },
  { name: "secret", type: "other", role: "ignored", isPayload: true },
];

const editedStandardization: Standardization = [
  {
    output: "ssn",
    input: "ssn",
    steps: [{ function: "trim" }],
  },
];

describe("jobExchangeIntentSchema validates metadata and standardization", () => {
  test("accepts an intent carrying valid metadata and standardization", () => {
    const intent = validIntent({
      metadata: editedMetadata,
      standardization: editedStandardization,
    });
    expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(true);
  });

  test("rejects malformed metadata (a duplicate column name)", () => {
    const intent = validIntent({
      metadata: [...editedMetadata, editedMetadata[0]],
    });
    expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
  });

  test("rejects malformed standardization (a missing output field)", () => {
    const intent = {
      ...validIntent(),
      standardization: [{ input: "ssn" }],
    };
    expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
  });

  test("still rejects an unknown top-level key alongside the new fields", () => {
    const intent = {
      ...validIntent({ metadata: editedMetadata }),
      path: "/etc/passwd",
    };
    expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
  });

  test("accepts expectedPayloadColumns, including an empty array", () => {
    expect(
      jobExchangeIntentSchema.safeParse(
        validIntent({ expectedPayloadColumns: ["program_code"] }),
      ).success,
    ).toBe(true);
    // An empty array is a valid, meaningful value (strict "receive nothing").
    expect(
      jobExchangeIntentSchema.safeParse(
        validIntent({ expectedPayloadColumns: [] }),
      ).success,
    ).toBe(true);
  });

  test("rejects a non-string-array expectedPayloadColumns", () => {
    const intent = { ...validIntent(), expectedPayloadColumns: [1, 2] };
    expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
  });
});

// The size caps live on the shared common fields, so both arms inherit them.
// Each case is exercised against the filedrop and the sftp builder. Overrides are
// loosely typed (some carry deliberately over-cap or malformed shapes the schema
// must reject), so they are spread over a valid base as `unknown`.
const intentArms: Array<{
  name: string;
  build: (overrides: Record<string, unknown>) => unknown;
}> = [
  {
    name: "filedrop",
    build: (overrides) => ({ ...validIntent(), ...overrides }),
  },
  {
    name: "sftp",
    build: (overrides) => ({ ...validSftpIntent(), ...overrides }),
  },
];

describe("jobExchangeIntentSchema enforces exactly-one-of inputCsv/inputFile", () => {
  test("accepts an inputFile reference and no inputCsv, both arms", () => {
    expect(
      jobExchangeIntentSchema.safeParse(validInputFileIntent()).success,
    ).toBe(true);
    expect(
      jobExchangeIntentSchema.safeParse({
        ...validInputFileIntent(),
        channel: "sftp",
      }).success,
    ).toBe(true);
  });

  test("rejects an intent carrying BOTH inputCsv and inputFile", () => {
    const both = { ...validIntent(), inputFile: SAMPLE_INPUT_FILE_REF };
    expect(jobExchangeIntentSchema.safeParse(both).success).toBe(false);
  });

  test("rejects an intent carrying NEITHER inputCsv nor inputFile", () => {
    const neither: Record<string, unknown> = { ...validInputFileIntent() };
    delete neither.inputFile;
    expect(jobExchangeIntentSchema.safeParse(neither).success).toBe(false);
  });

  test("rejects a smuggled extra field inside inputFile (sub-object is strict)", () => {
    // A client attempts to smuggle an absolute path alongside the opaque name.
    const intent = {
      ...validInputFileIntent(),
      inputFile: { ...SAMPLE_INPUT_FILE_REF, path: "/etc/passwd" },
    };
    expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
  });

  test("rejects a non-segment inputFile name (same shape rule as the listing)", () => {
    for (const name of ["../secret", "a/b", ".psilink.key", ""]) {
      const intent = validInputFileIntent({ ...SAMPLE_INPUT_FILE_REF, name });
      expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
    }
  });

  test("rejects an inputFile carrying an unknown field (strict)", () => {
    const intent = validInputFileIntent();
    const smuggled = {
      ...intent,
      inputFile: { name: "input.csv", sizeBytes: 42 },
    };
    expect(jobExchangeIntentSchema.safeParse(smuggled).success).toBe(false);
  });
});

describe("jobExchangeIntentSchema bounds the intent's sizes", () => {
  for (const arm of intentArms) {
    test(`[${arm.name}] rejects an over-cap inputCsv`, () => {
      // One allocation just past the char cap; freed when the test ends. Every
      // other cap below is exercised with small values.
      const intent = arm.build({
        inputCsv: "a".repeat(MAX_INPUT_CSV_LENGTH + 1),
      });
      expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
    });

    test(`[${arm.name}] accepts an inputCsv at the cap`, () => {
      const intent = arm.build({ inputCsv: "a".repeat(MAX_INPUT_CSV_LENGTH) });
      expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(true);
    });

    test(`[${arm.name}] rejects too many expectedPayloadColumns`, () => {
      const intent = arm.build({
        expectedPayloadColumns: Array.from(
          { length: MAX_EXPECTED_PAYLOAD_COLUMNS + 1 },
          (_, i) => `c${i}`,
        ),
      });
      expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
    });

    test(`[${arm.name}] rejects an over-length expectedPayloadColumns entry`, () => {
      const intent = arm.build({
        expectedPayloadColumns: ["a".repeat(MAX_NAME_LENGTH + 1)],
      });
      expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
    });

    test(`[${arm.name}] rejects too many metadata columns`, () => {
      const intent = arm.build({
        metadata: Array.from({ length: MAX_METADATA_COLUMNS + 1 }, (_, i) => ({
          name: `col_${i}`,
          type: "other",
          role: "payload",
          isPayload: true,
        })),
      });
      expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
    });

    test(`[${arm.name}] rejects an over-length metadata description`, () => {
      const intent = arm.build({
        metadata: [
          {
            name: "ssn",
            type: "ssn",
            role: "linkage",
            isPayload: false,
            description: "d".repeat(MAX_METADATA_DESCRIPTION_LENGTH + 1),
          },
        ],
      });
      expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
    });

    test(`[${arm.name}] rejects too many standardization transformations`, () => {
      const intent = arm.build({
        standardization: Array.from(
          { length: MAX_STANDARDIZATION_TRANSFORMATIONS + 1 },
          (_, i) => ({ output: `o${i}`, input: `i${i}` }),
        ),
      });
      expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
    });

    test(`[${arm.name}] rejects too many standardization steps`, () => {
      const intent = arm.build({
        standardization: [
          {
            output: "ssn",
            input: "ssn",
            steps: Array.from(
              { length: MAX_STANDARDIZATION_STEPS + 1 },
              () => ({ function: "trim" }),
            ),
          },
        ],
      });
      expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
    });

    test(`[${arm.name}] rejects an over-length standardization output`, () => {
      const intent = arm.build({
        standardization: [
          { output: "o".repeat(MAX_NAME_LENGTH + 1), input: "ssn" },
        ],
      });
      expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
    });

    test(`[${arm.name}] rejects an over-length standardization input`, () => {
      const intent = arm.build({
        standardization: [
          { output: "ssn", input: "i".repeat(MAX_NAME_LENGTH + 1) },
        ],
      });
      expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
    });

    test(`[${arm.name}] accepts a realistically large well-formed intent`, () => {
      const intent = arm.build({
        expectedPayloadColumns: Array.from(
          { length: 64 },
          (_, i) => `program_${i}`,
        ),
        metadata: [
          {
            name: "ssn",
            type: "ssn",
            role: "linkage",
            isPayload: false,
            description: "d".repeat(1024),
          },
        ],
        standardization: [
          {
            output: "ssn",
            input: "ssn",
            steps: Array.from({ length: 32 }, () => ({ function: "trim" })),
          },
        ],
      });
      expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(true);
    });
  }
});

describe("composeConfigDocument carries the operator's data-prep edits", () => {
  test("forwards edited metadata and standardization into the composed config", () => {
    const intent = validIntent({
      metadata: editedMetadata,
      standardization: editedStandardization,
    });
    const yaml = composeConfigDocument(intent, "/srv/jobs/abc/exchange");
    const doc = parseYaml(yaml) as {
      metadata?: unknown;
      standardization?: unknown;
    };

    // The metadata block reaches the CLI verbatim (snake_case on disk); parse it
    // back through core's own parser to compare on the camelCase side.
    const parsed = safeParseMetadata(doc.metadata);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(editedMetadata);

    expect(doc.standardization).toEqual(editedStandardization);
  });

  test("the operator-ignored column is NOT disclosed in the composed metadata", () => {
    // The bug this slice closes: without carried metadata the CLI infers `secret`
    // as an unrecognized column and defaults it to disclosed payload. The forwarded
    // metadata roles it `ignored`, so disclosedColumnNames -- the single source of
    // truth for what leaves the machine -- excludes it.
    const intent = validIntent({ metadata: editedMetadata });
    const yaml = composeConfigDocument(intent, "/srv/jobs/abc/exchange");
    const doc = parseYaml(yaml) as { metadata?: unknown };
    const parsed = safeParseMetadata(doc.metadata);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(disclosedColumnNames(parsed.data)).not.toContain("secret");
  });

  test("omits metadata and standardization when the intent sets neither", () => {
    const yaml = composeConfigDocument(validIntent(), "/srv/jobs/abc/exchange");
    const doc = parseYaml(yaml) as Record<string, unknown>;
    expect(doc.metadata).toBeUndefined();
    expect(doc.standardization).toBeUndefined();
  });
});

describe("composeConfigDocument carries the received-payload lock-in", () => {
  // The acceptor's expectedPayloadColumns must reach the config as
  // expected_payload_columns so the CLI enforces the received set explicitly
  // rather than falling back (fail open) to linkageTerms.payload.receive.
  test("forwards a non-empty expectedPayloadColumns as expected_payload_columns", () => {
    const intent = validIntent({ expectedPayloadColumns: ["program_code"] });
    const yaml = composeConfigDocument(intent, "/srv/jobs/abc/exchange");
    const doc = parseYaml(yaml) as { expected_payload_columns?: unknown };
    expect(doc.expected_payload_columns).toEqual(["program_code"]);
  });

  test("an empty expectedPayloadColumns SURVIVES into the config (strict), not dropped", () => {
    // The empty-vs-undefined distinction: an empty array is a strict "receive
    // nothing" and must lock in, not collapse to an omitted (lazy) field.
    const intent = validIntent({ expectedPayloadColumns: [] });
    const yaml = composeConfigDocument(intent, "/srv/jobs/abc/exchange");
    const doc = parseYaml(yaml) as { expected_payload_columns?: unknown };
    expect(doc.expected_payload_columns).toEqual([]);
  });

  test("omits expected_payload_columns when the intent leaves it undefined (lazy)", () => {
    const yaml = composeConfigDocument(validIntent(), "/srv/jobs/abc/exchange");
    const doc = parseYaml(yaml) as Record<string, unknown>;
    expect(doc.expected_payload_columns).toBeUndefined();
  });
});

describe("jobExchangeIntentSchema rejects injection-shaped intents", () => {
  test("accepts a well-formed filedrop intent", () => {
    expect(jobExchangeIntentSchema.safeParse(validIntent()).success).toBe(true);
  });

  test("accepts an sftp intent with no connection field", () => {
    // The sftp arm carries no `remote`: a filedrop intent's shared fields with
    // the channel flipped to sftp is a well-formed sftp intent.
    const intent = { ...validIntent(), channel: "sftp" };
    expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(true);
  });

  test("rejects an unknown channel", () => {
    const intent = { ...validIntent(), channel: "webrtc" };
    expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
  });

  test("rejects an unknown top-level key (no smuggled path/host)", () => {
    const intent = {
      ...validIntent(),
      // A client attempts to smuggle a connection path or credential reference.
      path: "/etc/passwd",
      server: { host: "evil.example", password: "@/root/.ssh/id_rsa" },
    };
    expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
  });

  test("rejects an unknown key inside options", () => {
    const intent = {
      ...validIntent(),
      options: { peerId: "temp", pollIntervalMs: 1000 },
    };
    expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
  });

  test("rejects a malformed shared secret", () => {
    const intent = { ...validIntent(), sharedSecret: "@/etc/shadow" };
    expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
  });

  test("rejects an empty input CSV", () => {
    const intent = { ...validIntent(), inputCsv: "" };
    expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
  });

  test("rejects linkage terms that fail core's schema", () => {
    const intent = {
      ...validIntent(),
      linkageTerms: { ...validLinkageTerms(), identity: undefined },
    };
    expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
  });
});

describe("composeConfigDocument is injection-closed", () => {
  test("forces the connection path to the server-chosen exchange directory", () => {
    const intent = validIntent();
    const yaml = composeConfigDocument(intent, "/srv/jobs/abc/exchange");
    const doc = parseYaml(yaml) as {
      connection: { channel: string; path: string };
      authentication?: unknown;
    };
    expect(doc.connection.channel).toBe("filedrop");
    expect(doc.connection.path).toBe("/srv/jobs/abc/exchange");
  });

  test("never assembles an authentication block (secret rides the key file)", () => {
    const yaml = composeConfigDocument(validIntent(), "/srv/jobs/abc/exchange");
    const doc = parseYaml(yaml) as Record<string, unknown>;
    expect(doc.authentication).toBeUndefined();
  });

  test("carries no host or credential field for a filedrop config", () => {
    const yaml = composeConfigDocument(validIntent(), "/srv/jobs/abc/exchange");
    expect(yaml).not.toContain("host");
    expect(yaml).not.toContain("password");
    expect(yaml).not.toContain("private_key");
  });

  test("passes only the numeric/boolean option subset through", () => {
    const intent = validIntent({
      options: { pollIntervalMs: 250, unexpectedFiles: "warn" },
    });
    const yaml = composeConfigDocument(intent, "/srv/jobs/abc/exchange");
    const doc = parseYaml(yaml) as {
      connection: { options?: Record<string, unknown> };
    };
    expect(doc.connection.options?.poll_interval_ms).toBe(250);
    expect(doc.connection.options?.unexpected_files).toBe("warn");
  });
});

describe("the sftp intent arm", () => {
  test("accepts a well-formed sftp intent", () => {
    expect(jobExchangeIntentSchema.safeParse(validSftpIntent()).success).toBe(
      true,
    );
  });

  test("rejects an unknown key on the sftp arm", () => {
    const intent = { ...validSftpIntent(), path: "/etc/passwd" };
    expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
  });

  test("rejects a smuggled server block on the sftp arm", () => {
    const intent = {
      ...validSftpIntent(),
      server: { host: "evil.example", password: "@/etc/shadow" },
    };
    expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
  });

  test("the sftp arm rejects a sent remote field as an unknown key", () => {
    // The connection field is gone: the appliance provisions the one server, so
    // a client that still sends a `remote` is rejected by the strict parse.
    const intent = { ...validSftpIntent(), remote: TEST_SFTP_REMOTE_NAME };
    expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
  });

  test("the filedrop arm rejects a remote field", () => {
    const intent = { ...validIntent(), remote: TEST_SFTP_REMOTE_NAME };
    expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
  });

  test("pollIntervalMs 999 is rejected on sftp, accepted on filedrop", () => {
    expect(
      jobExchangeIntentSchema.safeParse(
        validSftpIntent({ options: { pollIntervalMs: 999 } }),
      ).success,
    ).toBe(false);
    expect(
      jobExchangeIntentSchema.safeParse(
        validSftpIntent({ options: { pollIntervalMs: 1000 } }),
      ).success,
    ).toBe(true);
    expect(
      jobExchangeIntentSchema.safeParse(
        validIntent({ options: { pollIntervalMs: 999 } }),
      ).success,
    ).toBe(true);
  });
});

describe("composeSftpConfigDocument", () => {
  test("writes snake_case fields with @path credential refs verbatim at rest", () => {
    const entry = {
      ...testSftpServerEntry(),
      keyboardInteractive: true,
    };
    const yaml = composeSftpConfigDocument(validSftpIntent(), entry);
    const doc = parseYaml(yaml) as {
      connection: { channel: string; server: Record<string, unknown> };
    };
    expect(doc.connection.channel).toBe("sftp");
    expect(doc.connection.server.host).toBe("sftp.example.org");
    expect(doc.connection.server.port).toBe(2222);
    expect(doc.connection.server.password).toBe(
      "@/etc/psilink/prod-east-password",
    );
    expect(doc.connection.server.host_key_fingerprint).toBe(
      TEST_HOST_KEY_FINGERPRINT,
    );
    expect(doc.connection.server.keyboard_interactive).toBe(true);
    // The camelCase spellings never reach the file.
    expect(yaml).not.toContain("hostKeyFingerprint");
    expect(yaml).not.toContain("keyboardInteractive");
  });

  test("carries no client connection field (server block is the entry alone)", () => {
    const yaml = composeSftpConfigDocument(
      validSftpIntent(),
      testSftpServerEntry(),
    );
    // The intent contributes no connection material: no `remote` key, and no
    // would-be remote name reaches the document.
    expect(yaml).not.toContain("remote");
    expect(yaml).not.toContain(TEST_SFTP_REMOTE_NAME);
  });

  test("client linkage terms and metadata land exactly as filedrop's do", () => {
    const intentFields = {
      metadata: editedMetadata,
      standardization: editedStandardization,
      expectedPayloadColumns: ["program_code"],
    };
    const sftpDoc = parseYaml(
      composeSftpConfigDocument(
        validSftpIntent(intentFields),
        testSftpServerEntry(),
      ),
    ) as Record<string, unknown>;
    const filedropDoc = parseYaml(
      composeConfigDocument(validIntent(intentFields), "/srv/jobs/x/exchange"),
    ) as Record<string, unknown>;
    expect(sftpDoc.linkage_terms).toEqual(filedropDoc.linkage_terms);
    expect(sftpDoc.metadata).toEqual(filedropDoc.metadata);
    expect(sftpDoc.standardization).toEqual(filedropDoc.standardization);
    expect(sftpDoc.expected_payload_columns).toEqual(
      filedropDoc.expected_payload_columns,
    );
  });

  test("never assembles an authentication block", () => {
    const doc = parseYaml(
      composeSftpConfigDocument(validSftpIntent(), testSftpServerEntry()),
    ) as Record<string, unknown>;
    expect(doc.authentication).toBeUndefined();
  });

  test("forwards the sftp option subset under the connection", () => {
    const yaml = composeSftpConfigDocument(
      validSftpIntent({
        options: { pollIntervalMs: 5000, retainFiles: false },
      }),
      testSftpServerEntry(),
    );
    const doc = parseYaml(yaml) as {
      connection: { options?: Record<string, unknown> };
    };
    expect(doc.connection.options?.poll_interval_ms).toBe(5000);
    expect(doc.connection.options?.retain_files).toBe(false);
  });

  test("the document parses back through core's exchange-spec schema", () => {
    const yaml = composeSftpConfigDocument(
      validSftpIntent(),
      testSftpServerEntry(),
    );
    const parsed = safeParseExchangeSpec(parseYaml(yaml));
    expect(parsed.success).toBe(true);
  });
});

describe("composeKeyFileDocument", () => {
  test("writes only the shared secret, no expiry", () => {
    const body = JSON.parse(composeKeyFileDocument(validIntent())) as {
      sharedSecret: string;
      expires?: string;
    };
    expect(body.sharedSecret).toBe(validIntent().sharedSecret);
    expect(body.expires).toBeUndefined();
  });

  test("serializes the sftp arm's secret identically", () => {
    expect(composeKeyFileDocument(validSftpIntent())).toBe(
      composeKeyFileDocument(validIntent()),
    );
  });
});

describe("JOB_FILE_NAMES record/keys pairing", () => {
  // The web app cannot import apps/cli's keysPathFor, so this pins the same
  // derivation (a trailing `.json` replaced by `.keys.json`) the CLI applies to
  // the record path: the keys name the server serves must match the one the CLI
  // writes alongside the record it is pointed at via --record-file.
  test("recordKeys is the record name under the .json -> .keys.json rule", () => {
    const derivedKeysName = JOB_FILE_NAMES.record.endsWith(".json")
      ? `${JOB_FILE_NAMES.record.slice(0, -".json".length)}.keys.json`
      : `${JOB_FILE_NAMES.record}.keys.json`;
    expect(JOB_FILE_NAMES.recordKeys).toBe(derivedKeysName);
  });
});
