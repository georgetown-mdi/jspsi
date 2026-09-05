import { describe, expect, test } from "vitest";

import { parse as parseYaml } from "yaml";

import {
  MAX_NAME_LENGTH,
  MAX_RECONNECT_ATTEMPTS,
  MAX_TIMEOUT_SECONDS,
  assessOutboundPayloadConsent,
  disclosedColumnNames,
  safeParseExchangeSpec,
  safeParseMetadata,
} from "@psilink/core";

import {
  JOB_FILE_NAMES,
  MAX_EXPECTED_PAYLOAD_COLUMNS,
  MAX_IDENTITY_LENGTH,
  MAX_INPUT_CSV_LENGTH,
  MAX_METADATA_COLUMNS,
  MAX_METADATA_DESCRIPTION_LENGTH,
  MAX_STANDARDIZATION_STEPS,
  MAX_STANDARDIZATION_TRANSFORMATIONS,
  composeConfigDocument,
  composeKeyFileDocument,
  composeSftpConfigDocument,
  jobCreateIntentSchema,
  jobExchangeIntentSchema,
  jobZeroSetupIntentSchema,
  zeroSetupFiledropArgv,
  zeroSetupOptionsArgv,
  zeroSetupSftpArgv,
} from "@jobs/intent";

import {
  SAMPLE_INPUT_FILE_REF,
  TEST_HOST_KEY_FINGERPRINT,
  TEST_SFTP_REMOTE_NAME,
  testSftpServerEntry,
  testSplitSftpServerEntry,
  validInputFileIntent,
  validIntent,
  validLinkageTerms,
  validSftpIntent,
  validZeroSetupIntent,
  validZeroSetupSftpIntent,
} from "../utils/jobFixtures";

import type {
  LinkageTerms,
  Metadata,
  OutboundPayloadConsent,
  Standardization,
} from "@psilink/core";

// The intent schema is the ONLY channel from the client into a CLI invocation.
// These pin its injection-closure: unknown/injection-shaped values are rejected,
// only the credential-free filedrop channel is admitted, and the composed config
// never holds a client-chosen path, host, or credential.

// The operator's authored per-party data-prep edits. `secret` is roled `ignored`;
// left to metadata inference an unrecognized column defaults to disclosed payload,
// so including this metadata is what keeps it off the wire.
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
  test("accepts an intent holding valid metadata and standardization", () => {
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

  test("accepts expectedPartnerDeduplicate, both booleans", () => {
    for (const declared of [false, true])
      expect(
        jobExchangeIntentSchema.safeParse(
          validIntent({ expectedPartnerDeduplicate: declared }),
        ).success,
      ).toBe(true);
  });

  test("rejects a non-boolean expectedPartnerDeduplicate", () => {
    // A string reaching the composed config would be refused by core's schema at
    // config-parse time on the console, after the job was created; refusing it
    // at this boundary keeps it a create-time error instead.
    const intent = { ...validIntent(), expectedPartnerDeduplicate: "false" };
    expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
  });
});

// The size caps live on the shared common fields, so both arms inherit them.
// Each case is exercised against the filedrop and the sftp builder. Overrides are
// loosely typed (some hold over-cap or malformed shapes the schema must reject),
// so they are spread over a valid base as `unknown`.
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

  test("rejects an intent holding BOTH inputCsv and inputFile", () => {
    const both = { ...validIntent(), inputFile: SAMPLE_INPUT_FILE_REF };
    expect(jobExchangeIntentSchema.safeParse(both).success).toBe(false);
  });

  test("rejects an intent holding NEITHER inputCsv nor inputFile", () => {
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

  test("rejects an inputFile holding an unknown field (strict)", () => {
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

describe("composeConfigDocument forwards the operator's data-prep edits", () => {
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
    // Without forwarded metadata the CLI infers `secret` as an unrecognized column
    // and defaults it to disclosed payload. The forwarded metadata roles it
    // `ignored`, so disclosedColumnNames -- the single source of truth for what
    // leaves the machine -- excludes it.
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

describe("composeConfigDocument forwards the received-payload commitment", () => {
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

describe("the composers forward the terms-side commitment", () => {
  // The console runs `psilink exchange` from this document at a separate
  // invocation, so an acceptance's declaration binds the run only if it reaches
  // the YAML. Both composers, because an sftp job assembles its spec directly
  // rather than through mintExchangeFile.
  test("forwards expectedPartnerDeduplicate as expected_partner_deduplicate", () => {
    for (const declared of [false, true]) {
      const intent = validIntent({ expectedPartnerDeduplicate: declared });
      const doc = parseYaml(
        composeConfigDocument(intent, "/srv/jobs/abc/exchange"),
      ) as Record<string, unknown>;
      expect(doc.expected_partner_deduplicate).toBe(declared);
    }
  });

  test("the sftp composer forwards it too", () => {
    for (const declared of [false, true]) {
      const intent = validSftpIntent({
        expectedPartnerDeduplicate: declared,
      });
      const doc = parseYaml(
        composeSftpConfigDocument(intent, testSftpServerEntry()),
      ) as Record<string, unknown>;
      expect(doc.expected_partner_deduplicate).toBe(declared);
    }
  });

  test("omits it when the intent holds no declaration (the two-config case)", () => {
    const doc = parseYaml(
      composeConfigDocument(validIntent(), "/srv/jobs/abc/exchange"),
    ) as Record<string, unknown>;
    expect(doc.expected_partner_deduplicate).toBeUndefined();
  });
});

// The send-side counterpart of the commitment above. An acceptance's own outbound
// set is authored by nobody -- the invitation authors the inviter's, the mirror
// leaves the acceptor's absent -- so without a recorded consent the CLI's
// pre-connect gate reads "no record" and no later unattended run is ever held to
// a set. These pin the record's three states through the composition, and that
// the composed config is one the gate then accepts without asking again.

/** The linkage terms of a party that receives the result but transmits nothing:
 * the shape core's deriver records no consent for, since nothing crosses. */
function notTransmittingTerms(): LinkageTerms {
  const terms = validLinkageTerms();
  return {
    ...terms,
    output: { ...terms.output, shareWithPartner: false },
  };
}

/** The `outbound_payload_consent` block of a composed filedrop config, read back
 * through core's own exchange-spec parser so what is asserted is what the CLI
 * would load. */
function composedConsent(
  overrides: Parameters<typeof validIntent>[0],
): OutboundPayloadConsent | undefined {
  const yaml = composeConfigDocument(
    validIntent(overrides),
    "/srv/jobs/abc/exchange",
  );
  const parsed = safeParseExchangeSpec(parseYaml(yaml));
  expect(parsed.success).toBe(true);
  return parsed.success ? parsed.data.outboundPayloadConsent : undefined;
}

describe("composeConfigDocument records the acceptance's outbound consent", () => {
  test("an acceptance whose metadata resolved records the confirmed set", () => {
    expect(
      composedConsent({ side: "acceptor", metadata: editedMetadata }),
    ).toEqual({
      status: "confirmed",
      columns: disclosedColumnNames(editedMetadata),
    });
  });

  test("the confirmed set is the disclosure predicate's, not the column list", () => {
    // `secret` is roled ignored, so it is in the metadata but not in the set that
    // leaves the machine: recording the raw column names would consent to more
    // than is transmitted.
    const consent = composedConsent({
      side: "acceptor",
      metadata: editedMetadata,
    });
    expect(consent).toMatchObject({ status: "confirmed" });
    if (consent?.status !== "confirmed") return;
    expect(consent.columns).not.toContain("secret");
  });

  test("an acceptance with no resolvable metadata records pending", () => {
    expect(composedConsent({ side: "acceptor" })).toEqual({
      status: "pending",
    });
  });

  test("an acceptance that transmits nothing records no consent at all", () => {
    expect(
      composedConsent({
        side: "acceptor",
        linkageTerms: notTransmittingTerms(),
        metadata: editedMetadata,
      }),
    ).toBeUndefined();
  });

  test("an inviter records none -- its own set was authored at mint", () => {
    expect(
      composedConsent({ side: "inviter", metadata: editedMetadata }),
    ).toBeUndefined();
  });

  test("an intent stating no side records none", () => {
    expect(composedConsent({ metadata: editedMetadata })).toBeUndefined();
  });

  test("the sftp arm records the identical block", () => {
    const fields = { side: "acceptor" as const, metadata: editedMetadata };
    const sftpDoc = parseYaml(
      composeSftpConfigDocument(validSftpIntent(fields), testSftpServerEntry()),
    ) as Record<string, unknown>;
    const filedropDoc = parseYaml(
      composeConfigDocument(validIntent(fields), "/srv/jobs/x/exchange"),
    ) as Record<string, unknown>;
    expect(sftpDoc.outbound_payload_consent).toEqual(
      filedropDoc.outbound_payload_consent,
    );
    expect(sftpDoc.outbound_payload_consent).toBeDefined();
  });
});

describe("a composed acceptance config satisfies the later run's consent gate", () => {
  /** The verdict a later `psilink exchange` reaches on a composed config: the
   * record the config holds, assessed against the set that run would actually
   * transmit -- the exact reading `confirmOutboundPayloadConsent` performs before
   * any credential, terms, or data are sent. `runMetadata` is what the run
   * resolves for itself (the config's own metadata, or an inferred one where the
   * config holds none). */
  function gateVerdictFor(
    overrides: Parameters<typeof validIntent>[0],
    runMetadata: Metadata,
  ) {
    const yaml = composeConfigDocument(
      validIntent(overrides),
      "/srv/jobs/abc/exchange",
    );
    const parsed = safeParseExchangeSpec(parseYaml(yaml));
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("the composed config did not parse");
    return assessOutboundPayloadConsent(
      parsed.data.outboundPayloadConsent,
      runMetadata,
      parsed.data.linkageTerms.output,
    );
  }

  test("an unattended run of the composed config needs no re-confirmation", () => {
    expect(
      gateVerdictFor(
        { side: "acceptor", metadata: editedMetadata },
        editedMetadata,
      ),
    ).toEqual({
      status: "current",
      columns: disclosedColumnNames(editedMetadata),
    });
  });

  test("a pending record makes the gate ASK rather than silently pass", () => {
    // The acceptance resolved no set, so the config holds `pending`. The first
    // run that CAN resolve one -- here from its own input file -- shows and
    // confirms it; an unattended one refuses instead of transmitting it.
    expect(gateVerdictFor({ side: "acceptor" }, editedMetadata)).toMatchObject({
      status: "confirmation-required",
      reason: "unconfirmed",
      columns: disclosedColumnNames(editedMetadata),
    });
  });

  test("with no record the gate is inert -- nothing holds the run to a set", () => {
    expect(
      gateVerdictFor({ metadata: editedMetadata }, editedMetadata),
    ).toEqual({
      status: "not-required",
      reason: "no-record",
    });
  });
});

describe("jobExchangeIntentSchema rejects injection-shaped intents", () => {
  test("accepts a well-formed filedrop intent", () => {
    expect(jobExchangeIntentSchema.safeParse(validIntent()).success).toBe(true);
  });

  test("accepts an sftp intent with no connection field", () => {
    // The sftp arm holds no `remote`: a filedrop intent's shared fields with
    // the channel flipped to sftp is a well-formed sftp intent.
    const intent = { ...validIntent(), channel: "sftp" };
    expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(true);
  });

  test("rejects an unknown channel", () => {
    const intent = { ...validIntent(), channel: "webrtc" };
    expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
  });

  test("admits only the two sides, and admits an intent stating none", () => {
    for (const side of ["inviter", "acceptor"])
      expect(
        jobExchangeIntentSchema.safeParse({ ...validIntent(), side }).success,
      ).toBe(true);
    expect(
      jobExchangeIntentSchema.safeParse({ ...validIntent(), side: "auditor" })
        .success,
    ).toBe(false);
    expect(jobExchangeIntentSchema.safeParse(validIntent()).success).toBe(true);
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
      // A path-valued file-sync option core holds but this boundary never
      // exposes: the server owns every directory.
      options: { outboundPath: "/srv/out", pollIntervalMs: 1000 },
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
    // `identity` is optional in core's terms, but an empty label is not a name a
    // party can send -- the schema holds a present one to non-empty, and the
    // console's intent inherits that rather than restating it.
    const intent = {
      ...validIntent(),
      linkageTerms: { ...validLinkageTerms(), identity: "" },
    };
    expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
  });

  test("accepts linkage terms holding no identity at all", () => {
    // The other side of the same rule: a party that supplied no name omits the
    // field, and the console composes a configuration that states none rather
    // than one naming a party nobody named.
    const { identity: _unnamed, ...withoutIdentity } = validLinkageTerms();
    const intent = { ...validIntent(), linkageTerms: withoutIdentity };
    expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(true);
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

  test("holds no host or credential field for a filedrop config", () => {
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
    // The console provisions the one server, so a client that sends a `remote`
    // is rejected by the strict parse.
    const intent = { ...validSftpIntent(), remote: TEST_SFTP_REMOTE_NAME };
    expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
  });

  test("the filedrop arm rejects a remote field", () => {
    const intent = { ...validIntent(), remote: TEST_SFTP_REMOTE_NAME };
    expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
  });

  // No channel floors the poll interval above core's own positive-integer rule:
  // the console warns about a sub-second interval (the CLI's anti-flood advisory,
  // raised at authoring time) and runs it, exactly as the command line does for
  // the operator who authored the connection.
  test("a sub-second pollIntervalMs is accepted on both channels", () => {
    expect(
      jobExchangeIntentSchema.safeParse(
        validSftpIntent({ options: { pollIntervalMs: 250 } }),
      ).success,
    ).toBe(true);
    expect(
      jobExchangeIntentSchema.safeParse(
        validIntent({ options: { pollIntervalMs: 250 } }),
      ).success,
    ).toBe(true);
  });

  test("a zero or negative pollIntervalMs is still refused on both channels", () => {
    for (const pollIntervalMs of [0, -1])
      for (const intent of [
        validSftpIntent({ options: { pollIntervalMs } }),
        validIntent({ options: { pollIntervalMs } }),
      ])
        expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
  });

  test("connectionPerPoll is admitted on sftp and refused on filedrop", () => {
    expect(
      jobExchangeIntentSchema.safeParse(
        validSftpIntent({ options: { connectionPerPoll: true } }),
      ).success,
    ).toBe(true);
    // The mode dials a real SFTP session, which a filedrop client has none of, so
    // the strict parse refuses it rather than taking a value the run cannot honour.
    expect(
      jobExchangeIntentSchema.safeParse(
        validIntent({ options: { connectionPerPoll: true } }),
      ).success,
    ).toBe(false);
  });

  test("connectionPerPoll reaches the composed sftp config", () => {
    const yaml = composeSftpConfigDocument(
      validSftpIntent({ options: { connectionPerPoll: true } }),
      testSftpServerEntry(),
    );
    const doc = parseYaml(yaml) as {
      connection: { options?: Record<string, unknown> };
    };
    expect(doc.connection.options?.connection_per_poll).toBe(true);
  });
});

// Each tuning setting authored on the console must survive to the config the CLI
// loads, under the snake_case name core's schema reads.
describe("the connection-tuning settings reach the composed config", () => {
  test("every setting round-trips into a filedrop config", () => {
    const yaml = composeConfigDocument(
      validIntent({
        options: {
          pollIntervalMs: 250,
          peerTimeoutMs: 7_200_000,
          serverConnectTimeoutMs: 45_000,
          maxReconnectAttempts: 12,
        },
      }),
      "/srv/jobs/abc/exchange",
    );
    const doc = parseYaml(yaml) as {
      connection: { options?: Record<string, unknown> };
    };
    expect(doc.connection.options).toMatchObject({
      poll_interval_ms: 250,
      peer_timeout_ms: 7_200_000,
      server_connect_timeout_ms: 45_000,
      max_reconnect_attempts: 12,
    });
  });

  test("an intent with no options composes no options block at all", () => {
    const doc = parseYaml(
      composeConfigDocument(validIntent(), "/srv/jobs/abc/exchange"),
    ) as { connection: { options?: Record<string, unknown> } };
    expect(doc.connection.options).toBeUndefined();
  });
});

// The retry-budget ceiling is imported from core rather than a copied
// literal, so these bind to core's own MAX_RECONNECT_ATTEMPTS: a schema that
// drifted back to a stale literal would fail one of the two assertions below.
describe("maxReconnectAttempts is bounded by core's own MAX_RECONNECT_ATTEMPTS", () => {
  test("refuses a value past the ceiling on the exchange and zero-setup arms", () => {
    for (const result of [
      jobExchangeIntentSchema.safeParse(
        validIntent({
          options: { maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS + 1 },
        }),
      ),
      jobZeroSetupIntentSchema.safeParse(
        validZeroSetupIntent({
          options: { maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS + 1 },
        }),
      ),
    ])
      expect(result.success).toBe(false);
  });

  test("admits the ceiling itself on both arms", () => {
    for (const result of [
      jobExchangeIntentSchema.safeParse(
        validIntent({
          options: { maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS },
        }),
      ),
      jobZeroSetupIntentSchema.safeParse(
        validZeroSetupIntent({
          options: { maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS },
        }),
      ),
    ])
      expect(result.success).toBe(true);
  });
});

// peer_id is the one free-text option: it becomes a filename prefix in a
// server-owned directory, so its shape is bounded here, while every rule ABOUT it
// (the timestamp dependency, the reserved value) stays core's and is enforced by
// running core's own schema over the block.
describe("the options peer_id and its cross-field rules", () => {
  const withPeerId = (peerId: string) =>
    validIntent({ options: { peerId, timestampInFilename: true } });

  test("accepts a plain label", () => {
    expect(
      jobExchangeIntentSchema.safeParse(withPeerId("clinic-a")).success,
    ).toBe(true);
    expect(
      jobExchangeIntentSchema.safeParse(withPeerId("Site 2_b")).success,
    ).toBe(true);
  });

  test.each([
    ["a path separator", "../etc/passwd"],
    ["a bare separator", "a/b"],
    ["a leading dash", "-save"],
    ["a trailing space", "site "],
    ["an empty label", ""],
    ["a newline", "site\nother"],
    ["a Windows-reserved character", 'site"x'],
    ["a NUL byte", `site${String.fromCharCode(0)}`],
    ["an over-long label", "a".repeat(65)],
  ])("rejects %s", (_label, peerId) => {
    expect(jobExchangeIntentSchema.safeParse(withPeerId(peerId)).success).toBe(
      false,
    );
  });

  test("rejects the reserved peer_id in core's own words", () => {
    const parsed = jobExchangeIntentSchema.safeParse(withPeerId("temp"));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(
      parsed.error.issues.some((i) => i.message.includes("reserved")),
    ).toBe(true);
  });

  test("rejects a peer_id without timestamped filenames", () => {
    const intent = validIntent({ options: { peerId: "clinic-a" } });
    const parsed = jobExchangeIntentSchema.safeParse(intent);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(
      parsed.error.issues.some((i) =>
        i.message.includes("peer_id requires timestamp_in_filename"),
      ),
    ).toBe(true);
  });

  test("rejects retain mode contradicted by an explicit toggle", () => {
    const parsed = jobExchangeIntentSchema.safeParse(
      validIntent({
        options: {
          retainFiles: true,
          locklessRendezvous: true,
          timestampInFilename: false,
        },
      }),
    );
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(
      parsed.error.issues.some((i) =>
        i.message.includes("retain_files requires timestamp_in_filename"),
      ),
    ).toBe(true);
  });

  test("accepts the retain trio, and forwards it into the composed config", () => {
    const options = {
      retainFiles: true,
      locklessRendezvous: true,
      timestampInFilename: true,
      peerId: "clinic-a",
    };
    expect(
      jobExchangeIntentSchema.safeParse(validIntent({ options })).success,
    ).toBe(true);
    const doc = parseYaml(
      composeConfigDocument(validIntent({ options }), "/srv/jobs/x/exchange"),
    ) as { connection: { options?: Record<string, unknown> } };
    expect(doc.connection.options?.retain_files).toBe(true);
    expect(doc.connection.options?.lockless_rendezvous).toBe(true);
    expect(doc.connection.options?.timestamp_in_filename).toBe(true);
    expect(doc.connection.options?.peer_id).toBe("clinic-a");
  });

  test("the same rules hold on the zero-setup arm", () => {
    expect(
      jobZeroSetupIntentSchema.safeParse(
        validZeroSetupIntent({ options: { peerId: "clinic-a" } }),
      ).success,
    ).toBe(false);
    expect(
      jobZeroSetupIntentSchema.safeParse(
        validZeroSetupIntent({
          options: { peerId: "clinic-a", timestampInFilename: true },
        }),
      ).success,
    ).toBe(true);
  });
});

describe("zeroSetupOptionsArgv", () => {
  test("emits nothing when no option was set", () => {
    expect(zeroSetupOptionsArgv(undefined)).toEqual([]);
    expect(zeroSetupOptionsArgv({})).toEqual([]);
  });

  test("emits the retain trio and the party name", () => {
    expect(
      zeroSetupOptionsArgv({
        retainFiles: true,
        locklessRendezvous: true,
        timestampInFilename: true,
        peerId: "clinic-a",
      }),
    ).toEqual([
      "--retain-files",
      "--lockless-rendezvous",
      "--timestamp-in-filename",
      "--peer-id=clinic-a",
    ]);
  });

  test("emits nothing for an explicitly-off toggle", () => {
    expect(
      zeroSetupOptionsArgv({
        retainFiles: false,
        locklessRendezvous: false,
        timestampInFilename: false,
      }),
    ).toEqual([]);
  });

  test("holds the party name as a single =value token", () => {
    const argv = zeroSetupOptionsArgv({
      timestampInFilename: true,
      peerId: "clinic-a",
    });
    expect(argv).toContain("--peer-id=clinic-a");
    expect(argv).not.toContain("--peer-id");
  });

  test("emits no flag for unexpected_files, which has none", () => {
    expect(zeroSetupOptionsArgv({ unexpectedFiles: "warn" })).toEqual([]);
  });

  test("emits each tuning setting in the unit its own flag takes", () => {
    expect(
      zeroSetupOptionsArgv({
        pollIntervalMs: 250,
        peerTimeoutMs: 7_200_000,
        serverConnectTimeoutMs: 45_000,
        maxReconnectAttempts: 12,
        connectionPerPoll: true,
      }),
    ).toEqual([
      "--polling-frequency=250ms",
      "--peer-timeout=7200s",
      "--connection-timeout=45s",
      "--max-reconnect-attempts=12",
      "--connection-per-poll",
    ]);
  });

  test("emits a zero retry budget, which means connect once and do not retry", () => {
    expect(zeroSetupOptionsArgv({ maxReconnectAttempts: 0 })).toEqual([
      "--max-reconnect-attempts=0",
    ]);
  });

  test("emits no session-mode flag when the mode is off", () => {
    expect(zeroSetupOptionsArgv({ connectionPerPoll: false })).toEqual([]);
  });
});

/** Retain mode with the two settings core requires alongside it -- the option
 * block a split-directory exchange runs under. */
function retainModeOptions() {
  return {
    retainFiles: true,
    timestampInFilename: true,
    locklessRendezvous: true,
  };
}

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
    expect(yaml).not.toContain("hostKeyFingerprint");
    expect(yaml).not.toContain("keyboardInteractive");
  });

  test("holds no client connection field (server block is the entry alone)", () => {
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

  test("a split-directory entry composes the pair, never a shared path", () => {
    const yaml = composeSftpConfigDocument(
      validSftpIntent({ options: retainModeOptions() }),
      testSplitSftpServerEntry(),
    );
    const doc = parseYaml(yaml) as {
      connection: { server: Record<string, unknown> };
    };
    expect(doc.connection.server.inbound_path).toBe("/exchange/in");
    expect(doc.connection.server.outbound_path).toBe("/exchange/out");
    expect(doc.connection.server.path).toBeUndefined();
    expect(yaml).not.toContain("inboundPath");
    expect(safeParseExchangeSpec(parseYaml(yaml)).success).toBe(true);
  });

  test("a split-directory entry without retain mode composes no document", () => {
    // The precondition the console states while the operator is still at the
    // controls is not merely advisory: the compose refuses the same combination,
    // so a split can never reach a run under delete mode.
    expect(() =>
      composeSftpConfigDocument(validSftpIntent(), testSplitSftpServerEntry()),
    ).toThrow(/retain_files/);
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

// The zero-setup intent is the ONLY channel from the client into a zero-setup CLI
// invocation. These pin its injection-closure: it holds no secret/terms/
// connection material, only a bounded input source and closed-vocabulary tuning.
describe("jobZeroSetupIntentSchema accepts the allowed fields", () => {
  test("accepts a well-formed filedrop zero-setup intent", () => {
    expect(
      jobZeroSetupIntentSchema.safeParse(validZeroSetupIntent()).success,
    ).toBe(true);
  });

  test("accepts a well-formed sftp zero-setup intent with no connection field", () => {
    expect(
      jobZeroSetupIntentSchema.safeParse(validZeroSetupSftpIntent()).success,
    ).toBe(true);
  });

  test("accepts the optional linkageStrategy enum and identity label", () => {
    for (const linkageStrategy of ["cascade", "single-pass"] as const)
      expect(
        jobZeroSetupIntentSchema.safeParse(
          validZeroSetupIntent({ linkageStrategy, identity: "county-health" }),
        ).success,
      ).toBe(true);
  });

  test("accepts a mounted inputFile reference in place of inputCsv", () => {
    const intent = {
      mode: "zeroSetup",
      channel: "filedrop",
      inputFile: SAMPLE_INPUT_FILE_REF,
    };
    expect(jobZeroSetupIntentSchema.safeParse(intent).success).toBe(true);
  });

  test("accepts a sub-second poll interval and the event-stream toggle", () => {
    expect(
      jobZeroSetupIntentSchema.safeParse(
        validZeroSetupSftpIntent({
          options: { pollIntervalMs: 250 },
          eventStream: true,
        }),
      ).success,
    ).toBe(true);
  });
});

// Every option a zero-setup arm admits has a flag on the argv this mode builds,
// so nothing an operator authors is accepted and then dropped. What has no flag
// -- or no faithful flag form -- is refused here instead.
describe("the zero-setup arms admit only what their argv can hold", () => {
  test("refuses unexpectedFiles, which has no CLI flag at all", () => {
    for (const intent of [
      validZeroSetupIntent({ options: { unexpectedFiles: "warn" } }),
      validZeroSetupSftpIntent({ options: { unexpectedFiles: "warn" } }),
    ])
      expect(jobZeroSetupIntentSchema.safeParse(intent).success).toBe(false);
  });

  test("refuses a timeout that is not a whole number of seconds", () => {
    for (const options of [
      { peerTimeoutMs: 1500 },
      { serverConnectTimeoutMs: 45_500 },
    ])
      expect(
        jobZeroSetupIntentSchema.safeParse(validZeroSetupIntent({ options }))
          .success,
      ).toBe(false);
  });

  test("refuses a timeout past the seven-day ceiling its flag is capped at", () => {
    // Accepting one would create a job -- occupying the console's single run
    // slot -- whose spawned CLI refuses the argv it was created to run.
    const overCeilingMs = (MAX_TIMEOUT_SECONDS + 1) * 1000;
    for (const options of [
      { peerTimeoutMs: overCeilingMs },
      { serverConnectTimeoutMs: overCeilingMs },
    ])
      expect(
        jobZeroSetupIntentSchema.safeParse(validZeroSetupIntent({ options }))
          .success,
      ).toBe(false);
    // The ceiling itself is admissible: the CLI's own cap is inclusive.
    expect(
      jobZeroSetupIntentSchema.safeParse(
        validZeroSetupIntent({
          options: { peerTimeoutMs: MAX_TIMEOUT_SECONDS * 1000 },
        }),
      ).success,
    ).toBe(true);
    // The ceiling is the duration FLAG's, so the exchange mode -- which composes
    // a configuration document and passes no such flag -- keeps admitting it.
    expect(
      jobExchangeIntentSchema.safeParse(
        validIntent({ options: { peerTimeoutMs: overCeilingMs } }),
      ).success,
    ).toBe(true);
  });

  test("accepts a whole-second timeout and every other tuning setting", () => {
    expect(
      jobZeroSetupIntentSchema.safeParse(
        validZeroSetupSftpIntent({
          options: {
            pollIntervalMs: 250,
            peerTimeoutMs: 7_200_000,
            serverConnectTimeoutMs: 45_000,
            maxReconnectAttempts: 12,
            connectionPerPoll: true,
          },
        }),
      ).success,
    ).toBe(true);
  });

  test("refuses connectionPerPoll on the filedrop arm, as the exchange mode does", () => {
    expect(
      jobZeroSetupIntentSchema.safeParse(
        validZeroSetupIntent({ options: { connectionPerPoll: true } }),
      ).success,
    ).toBe(false);
  });
});

describe("jobZeroSetupIntentSchema is injection-closed and strict", () => {
  test("rejects a body that omits mode (a zero-setup intent must name itself)", () => {
    const noMode: Record<string, unknown> = { ...validZeroSetupIntent() };
    delete noMode.mode;
    expect(jobZeroSetupIntentSchema.safeParse(noMode).success).toBe(false);
  });

  test("rejects a sharedSecret on either arm", () => {
    for (const base of [validZeroSetupIntent(), validZeroSetupSftpIntent()]) {
      const intent = { ...base, sharedSecret: "A".repeat(43) };
      expect(jobZeroSetupIntentSchema.safeParse(intent).success).toBe(false);
    }
  });

  test("rejects linkageTerms, metadata, standardization, the two commitments, side", () => {
    for (const smuggled of [
      { linkageTerms: validLinkageTerms() },
      { metadata: editedMetadata },
      { standardization: editedStandardization },
      { expectedPayloadColumns: ["program_code"] },
      { expectedPartnerDeduplicate: false },
      { side: "acceptor" },
    ]) {
      const intent = { ...validZeroSetupIntent(), ...smuggled };
      expect(jobZeroSetupIntentSchema.safeParse(intent).success).toBe(false);
    }
  });

  test("rejects a smuggled connection field (server / remote / path)", () => {
    for (const smuggled of [
      { server: { host: "evil.example", password: "@/etc/shadow" } },
      { remote: TEST_SFTP_REMOTE_NAME },
      { path: "/etc/passwd" },
    ]) {
      const intent = { ...validZeroSetupSftpIntent(), ...smuggled };
      expect(jobZeroSetupIntentSchema.safeParse(intent).success).toBe(false);
    }
  });

  test("rejects an unknown linkageStrategy value (closed enum)", () => {
    const intent = { ...validZeroSetupIntent(), linkageStrategy: "turbo" };
    expect(jobZeroSetupIntentSchema.safeParse(intent).success).toBe(false);
  });

  test("rejects an over-length identity label", () => {
    const intent = validZeroSetupIntent({
      identity: "i".repeat(MAX_IDENTITY_LENGTH + 1),
    });
    expect(jobZeroSetupIntentSchema.safeParse(intent).success).toBe(false);
  });

  test("rejects a flag-shaped (leading-dash) identity label", () => {
    // A `-`-leading identity such as "--save" could, absent this guard, be parsed
    // by the CLI as its own flag. The schema refuses it on both channel arms; the
    // driver's =value emission is the second layer.
    for (const identity of ["--save", "-x", "-"]) {
      for (const base of [validZeroSetupIntent(), validZeroSetupSftpIntent()]) {
        const intent = { ...base, identity };
        expect(jobZeroSetupIntentSchema.safeParse(intent).success).toBe(false);
        expect(jobCreateIntentSchema.safeParse(intent).success).toBe(false);
      }
    }
    // A benign label that merely contains a dash later is still accepted.
    expect(
      jobZeroSetupIntentSchema.safeParse(
        validZeroSetupIntent({ identity: "county-health" }),
      ).success,
    ).toBe(true);
  });

  test("rejects an identity label holding a control character", () => {
    // The label rides the run into this party's own disclosure record, so a NUL or
    // an ESC in it is refused at the boundary rather than caught incidentally where
    // the child is spawned. Single-line, so the whitespace controls the retention
    // note admits are refused here too.
    for (const code of [0x00, 0x07, 0x09, 0x0a, 0x0d, 0x1b, 0x7f, 0x9b]) {
      const identity = `County${String.fromCharCode(code)}Health`;
      for (const base of [validZeroSetupIntent(), validZeroSetupSftpIntent()]) {
        const intent = { ...base, identity };
        expect(jobZeroSetupIntentSchema.safeParse(intent).success).toBe(false);
        expect(jobCreateIntentSchema.safeParse(intent).success).toBe(false);
      }
    }
  });

  test("accepts an identity label written in the operator's own script", () => {
    // The rule bounds control characters, not the operator's alphabet: a label
    // that cannot be spelled in ASCII is a legitimate party name, and the value
    // reaches the CLI as one argv token whatever letters it holds.
    for (const identity of [
      "Agencia Española de Protección de Datos",
      "北京市统计局",
      "Département de la Santé",
    ])
      expect(
        jobZeroSetupIntentSchema.safeParse(validZeroSetupIntent({ identity }))
          .success,
      ).toBe(true);
  });

  test("rejects an unknown channel", () => {
    const intent = { ...validZeroSetupIntent(), channel: "webrtc" };
    expect(jobZeroSetupIntentSchema.safeParse(intent).success).toBe(false);
  });

  test("enforces exactly one input source (neither and both fail)", () => {
    const neither: Record<string, unknown> = { ...validZeroSetupIntent() };
    delete neither.inputCsv;
    expect(jobZeroSetupIntentSchema.safeParse(neither).success).toBe(false);
    const both = {
      ...validZeroSetupIntent(),
      inputFile: SAMPLE_INPUT_FILE_REF,
    };
    expect(jobZeroSetupIntentSchema.safeParse(both).success).toBe(false);
  });

  test("refuses a non-positive poll interval, as the exchange arm does", () => {
    expect(
      jobZeroSetupIntentSchema.safeParse(
        validZeroSetupSftpIntent({ options: { pollIntervalMs: 0 } }),
      ).success,
    ).toBe(false);
  });
});

describe("jobCreateIntentSchema discriminates on mode", () => {
  test("a body with no mode defaults to the exchange arm (merged client)", () => {
    const parsed = jobCreateIntentSchema.safeParse(validIntent());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.mode).toBe("exchange");
  });

  test("an explicit mode: exchange parses as exchange", () => {
    const parsed = jobCreateIntentSchema.safeParse({
      ...validIntent(),
      mode: "exchange",
    });
    expect(parsed.success).toBe(true);
  });

  test("a zeroSetup body routes to the zero-setup arm", () => {
    const parsed = jobCreateIntentSchema.safeParse(validZeroSetupIntent());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.mode).toBe("zeroSetup");
  });

  test("a zeroSetup body holding a sharedSecret fails the strict parse", () => {
    const intent = { ...validZeroSetupIntent(), sharedSecret: "A".repeat(43) };
    expect(jobCreateIntentSchema.safeParse(intent).success).toBe(false);
  });

  test("an exchange body missing its sharedSecret fails (not silently zeroSetup)", () => {
    const noSecret: Record<string, unknown> = { ...validIntent() };
    delete noSecret.sharedSecret;
    expect(jobCreateIntentSchema.safeParse(noSecret).success).toBe(false);
  });

  test("an unknown mode is rejected", () => {
    const intent = { ...validZeroSetupIntent(), mode: "bootstrap" };
    expect(jobCreateIntentSchema.safeParse(intent).success).toBe(false);
  });

  test("a connection key on either mode fails the strict parse", () => {
    for (const base of [validIntent(), validZeroSetupIntent()]) {
      const intent = { ...base, connection: { host: "evil.example" } };
      expect(jobCreateIntentSchema.safeParse(intent).success).toBe(false);
    }
  });
});

describe("zeroSetupSftpArgv maps the effective connection to argv", () => {
  test("builds the sftp URL from host, port, and path", () => {
    const argv = zeroSetupSftpArgv(testSftpServerEntry());
    expect(argv[0]).toBe("sftp://sftp.example.org:2222/exchange");
  });

  test("a split entry puts the inbound half on the URL and flags the outbound", () => {
    const argv = zeroSetupSftpArgv(testSplitSftpServerEntry());
    expect(argv[0]).toBe("sftp://sftp.example.org:2222/exchange/in");
    expect(argv).toContain("--outbound-path=/exchange/out");
  });

  test("a single shared directory flags no outbound path", () => {
    expect(zeroSetupSftpArgv(testSftpServerEntry()).join(" ")).not.toContain(
      "--outbound-path",
    );
  });

  test("brackets a bare IPv6 host into a valid URL", () => {
    const argv = zeroSetupSftpArgv({
      host: "::1",
      hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
    });
    expect(argv[0]).toBe("sftp://[::1]");
  });

  test("adopts the WHATWG-canonical form of a non-canonical IPv6 literal", () => {
    // A legitimately-provisioned but non-canonical IPv6 (leading zeros) and an
    // uppercase-hex one both compose to the single canonical bracketed form. The
    // relaxed check adopts url.hostname rather than rejecting a host that does not
    // equal the input verbatim, matching what exchange mode accepts.
    for (const host of ["2001:0db8::0001", "2001:DB8::1", "2001:db8::1"]) {
      const argv = zeroSetupSftpArgv({
        host,
        hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
      });
      expect(argv[0]).toBe("sftp://[2001:db8::1]");
    }
  });

  test("composes a normal host and an IPv4 unchanged", () => {
    expect(
      zeroSetupSftpArgv({
        host: "sftp.example.org",
        hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
      })[0],
    ).toBe("sftp://sftp.example.org");
    expect(
      zeroSetupSftpArgv({
        host: "192.0.2.1",
        hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
      })[0],
    ).toBe("sftp://192.0.2.1");
  });

  test("emits the username and the @path credential VERBATIM as =value tokens", () => {
    const argv = zeroSetupSftpArgv(testSftpServerEntry());
    expect(argv).toContain("--server-username=linkage");
    // The @path is emitted as a filename reference, never resolved to a secret.
    expect(argv).toContain(
      "--server-password=@/etc/psilink/prod-east-password",
    );
    // Single tokens throughout: no bare value flag whose value could be misparsed.
    expect(argv).not.toContain("--server-username");
    expect(argv).not.toContain("--server-password");
  });

  test("emits --server-private-key and its passphrase as @path =value refs", () => {
    const argv = zeroSetupSftpArgv({
      host: "sftp.example.org",
      hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
      privateKey: "@/etc/psilink/id_ed25519",
      privateKeyPassphrase: "@/etc/psilink/passphrase",
    });
    expect(argv).toContain("--server-private-key=@/etc/psilink/id_ed25519");
    expect(argv).toContain(
      "--server-private-key-passphrase=@/etc/psilink/passphrase",
    );
    expect(argv.some((token) => token.startsWith("--server-password"))).toBe(
      false,
    );
  });

  test("emits --server-keyboard-interactive only when enabled", () => {
    expect(zeroSetupSftpArgv(testSftpServerEntry())).not.toContain(
      "--server-keyboard-interactive",
    );
    const argv = zeroSetupSftpArgv({
      ...testSftpServerEntry(),
      keyboardInteractive: true,
    });
    expect(argv).toContain("--server-keyboard-interactive");
  });

  test("ALWAYS emits the mandatory literal host-key fingerprint", () => {
    const argv = zeroSetupSftpArgv(testSftpServerEntry());
    expect(argv).toContain(
      `--server-host-key-fingerprint=${TEST_HOST_KEY_FINGERPRINT}`,
    );
  });

  test("holds no secret byte and no config/key/save token on argv", () => {
    const argv = zeroSetupSftpArgv(testSftpServerEntry());
    const joined = argv.join(" ");
    expect(joined).not.toContain("--config-file");
    expect(joined).not.toContain("--key-file");
    expect(joined).not.toContain("--save");
    // The only credential-bearing tokens are @path references, never values: the
    // value portion (after the flag's `=`) always starts with `@`.
    for (const token of argv) {
      if (!token.includes("psilink")) continue;
      expect(token.slice(token.indexOf("=") + 1).startsWith("@")).toBe(true);
    }
  });

  test("throws when the host TOTAL-DROPS through the URL (no-op or empty)", () => {
    // The relaxed check adopts the canonical hostname rather than requiring an exact
    // round-trip, but still refuses a total drop: a setter no-op (a host it cannot
    // parse, which leaves the sentinel `host.invalid` in place) or an empty hostname,
    // either of which would otherwise point the exchange at the wrong server.
    for (const host of ["foo\\bar", "foo bar", ""]) {
      expect(() =>
        zeroSetupSftpArgv({
          host,
          password: "@/etc/psilink/pw",
          hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
        }),
      ).toThrow(/could not encode/);
    }
  });

  test("an array (multi) fingerprint fails compose -- single-pin only this slice", () => {
    expect(() =>
      zeroSetupSftpArgv({
        host: "sftp.example.org",
        password: "@/etc/psilink/pw",
        hostKeyFingerprint: [
          TEST_HOST_KEY_FINGERPRINT,
          `SHA256:${"B".repeat(43)}`,
        ],
      }),
    ).toThrow(/single-valued/);
  });

  test("omits --server-username when the entry holds none", () => {
    const argv = zeroSetupSftpArgv({
      host: "sftp.example.org",
      password: "@/etc/psilink/pw",
      hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
    });
    expect(argv.some((token) => token.startsWith("--server-username"))).toBe(
      false,
    );
  });
});

/** The `connection` block of a composed filedrop config, for the directory-shape
 * assertions. */
function composedFiledropConnection(yaml: string): Record<string, unknown> {
  const parsed = parseYaml(yaml) as { connection?: Record<string, unknown> };
  const connection = parsed.connection;
  if (connection === undefined)
    throw new Error("composed psilink.yaml has no connection");
  return connection;
}

describe("composeConfigDocument on a split-provisioned console", () => {
  test("forwards the inbound/outbound pair and never a shared path beside it", () => {
    const connection = composedFiledropConnection(
      composeConfigDocument(
        validIntent({
          options: {
            retainFiles: true,
            timestampInFilename: true,
            locklessRendezvous: true,
          },
        }),
        "/mnt/from-partner",
        "/mnt/to-partner",
      ),
    );
    expect(connection.channel).toBe("filedrop");
    expect(connection.inbound_path).toBe("/mnt/from-partner");
    expect(connection.outbound_path).toBe("/mnt/to-partner");
    expect(connection.path).toBeUndefined();
  });

  test("core refuses the pair without retain mode, so the console never composes one", () => {
    // The rule is core's, applied by mintExchangeFile's own schema on the composed
    // connection; the console states it in its own words at every gate ahead of
    // this so an operator never meets the throw.
    expect(() =>
      composeConfigDocument(validIntent(), "/mnt/in", "/mnt/out"),
    ).toThrow();
  });

  test("core refuses two legs that resolve to one directory", () => {
    expect(() =>
      composeConfigDocument(
        validIntent({
          options: {
            retainFiles: true,
            timestampInFilename: true,
            locklessRendezvous: true,
          },
        }),
        "/mnt/share",
        "/mnt/share/",
      ),
    ).toThrow();
  });
});

describe("zeroSetupFiledropArgv builds the file:// locator", () => {
  test("builds a file:// URL via pathToFileURL from the server-side directory", () => {
    const argv = zeroSetupFiledropArgv("/srv/jobs/abc/rendezvous");
    expect(argv).toEqual(["file:///srv/jobs/abc/rendezvous"]);
  });

  test("holds no host or credential (filedrop has neither)", () => {
    const argv = zeroSetupFiledropArgv("/srv/jobs/abc/rendezvous");
    expect(argv.join(" ")).not.toContain("--server-");
  });

  test("a split console forwards the outbound leg on --outbound-path", () => {
    // The positional is the inbound leg (the CLI maps it to inbound_path); the
    // flag takes the plain absolute directory, not a file:// URL, because the CLI
    // copies it straight into outbound_path where core requires an absolute path.
    expect(zeroSetupFiledropArgv("/mnt/in", "/mnt/out")).toEqual([
      "file:///mnt/in",
      "--outbound-path=/mnt/out",
    ]);
  });
});
