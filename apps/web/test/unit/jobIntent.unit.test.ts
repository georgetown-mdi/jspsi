import { describe, expect, test } from "vitest";

import { parse as parseYaml } from "yaml";

import {
  composeConfigDocument,
  composeKeyFileDocument,
  jobExchangeIntentSchema,
} from "@jobs/intent";

import { validIntent, validLinkageTerms } from "../utils/jobFixtures";

// The intent schema is the ONLY channel from the client into a CLI invocation.
// These pin its injection-closure: unknown/injection-shaped values are rejected,
// only the credential-free filedrop channel is admitted, and the composed config
// never carries a client-chosen path, host, or credential.

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
