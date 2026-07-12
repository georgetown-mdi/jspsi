import { describe, expect, test } from "vitest";

import { parse as parseYaml } from "yaml";

import { disclosedColumnNames, safeParseMetadata } from "@psilink/core";

import {
  JOB_FILE_NAMES,
  composeConfigDocument,
  composeKeyFileDocument,
  jobExchangeIntentSchema,
} from "@jobs/intent";

import { validIntent, validLinkageTerms } from "../utils/jobFixtures";

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

describe("jobExchangeIntentSchema rejects injection-shaped intents", () => {
  test("accepts a well-formed filedrop intent", () => {
    expect(jobExchangeIntentSchema.safeParse(validIntent()).success).toBe(true);
  });

  test("rejects an sftp channel (unknown intent for this cut)", () => {
    const intent = { ...validIntent(), channel: "sftp" };
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

describe("composeKeyFileDocument", () => {
  test("writes only the shared secret, no expiry", () => {
    const body = JSON.parse(composeKeyFileDocument(validIntent())) as {
      sharedSecret: string;
      expires?: string;
    };
    expect(body.sharedSecret).toBe(validIntent().sharedSecret);
    expect(body.expires).toBeUndefined();
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
