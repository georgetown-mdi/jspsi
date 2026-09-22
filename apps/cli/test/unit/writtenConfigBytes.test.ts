import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import type { ExchangeSpec, LinkageTerms } from "@psilink/core";

import { saveConfig } from "../../src/config";

// Every byte of the file `invite`, `accept`, and a saved zero-setup run write is
// pinned, so a change to the serializer or to the guidance comments shows up
// here rather than in an operator's config.
const FIXTURES = path.join(import.meta.dirname, "../fixtures/writtenConfig");

// Fixed values throughout: a written document holds the terms date, so a spec
// built from the current day would pin nothing.
const terms: LinkageTerms = {
  version: "1.0.0",
  identity: "Agency A",
  date: "2025-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};

const specs: Record<string, ExchangeSpec> = {
  sftp: {
    connection: {
      channel: "sftp",
      server: {
        host: "sftp.example.org",
        port: 2222,
        username: "REPLACE_WITH_USER",
        path: "/exchanges/drop",
      },
    },
    authentication: {
      sharedSecret: "PLACEHOLDER_NOT_A_REAL_SECRET",
      expires: "2030-01-01T00:00:00Z",
      tokenMaxAgeDays: 7,
    },
    linkageTerms: terms,
  },
  filedrop: {
    connection: {
      channel: "filedrop",
      inboundPath: "/mnt/from-partner",
      outboundPath: "/mnt/to-partner",
      options: {
        retainFiles: true,
        locklessRendezvous: true,
        timestampInFilename: true,
        pollIntervalMs: 250,
      },
    },
    authentication: {
      sharedSecret: "PLACEHOLDER_NOT_A_REAL_SECRET",
      expires: "2030-01-01T00:00:00Z",
    },
    linkageTerms: { ...terms, identity: "Agency B" },
  },
  webrtc: {
    connection: {
      channel: "webrtc",
      server: { host: "broker.example.org", port: 443, path: "/api" },
      role: "acceptor",
    },
    authentication: {
      sharedSecret: "PLACEHOLDER_NOT_A_REAL_SECRET",
      expires: "2030-01-01T00:00:00Z",
    },
    linkageTerms: { ...terms, identity: "Agency C" },
  },
};

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-written-config-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const [channel, spec] of Object.entries(specs)) {
  test(`saveConfig writes the pinned document for a ${channel} exchange`, () => {
    const configPath = path.join(dir, "psilink.yaml");
    saveConfig(configPath, spec);
    expect(fs.readFileSync(configPath, "utf8")).toBe(
      fs.readFileSync(path.join(FIXTURES, `${channel}.yaml`), "utf8"),
    );
  });
}

test("the shared secret and its expiration reach no written config", () => {
  for (const channel of Object.keys(specs)) {
    const fixture = fs.readFileSync(
      path.join(FIXTURES, `${channel}.yaml`),
      "utf8",
    );
    expect(fixture).not.toContain("shared_secret");
    expect(fixture).not.toContain("PLACEHOLDER_NOT_A_REAL_SECRET");
    expect(fixture).not.toContain("expires");
  }
});
