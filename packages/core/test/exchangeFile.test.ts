import { ZodError } from "zod";
import { expect, test } from "vitest";
import { parse as parseYaml } from "yaml";

import { mintExchangeFile } from "../src/config/exchangeFile";
import type { ExchangeFileInput } from "../src/config/exchangeFile";
import { PLACEHOLDER_SSH_USERNAME } from "../src/config/endpointProducer";
import {
  parseExchangeSpec,
  ExchangeSpecSchema,
} from "../src/config/exchangeSpec";
import { camelizeKeys } from "../src/utils/camelizeKeys";
import type { LinkageTerms } from "../src/config/linkageTerms";
import type { FileSyncOptions } from "../src/config/connection";

// A minimal, valid set of linkage terms shared across cases -- the mint layer
// carries these into the config verbatim; they are not the thing under test.
const baseTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "Inviter",
  date: "2025-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};

// The retain trio a split-directory exchange requires; used to keep the split
// cases valid (the schema rejects a split pair without retain mode).
const retainOptions: FileSyncOptions = {
  retainFiles: true,
  locklessRendezvous: true,
  timestampInFilename: true,
};

// A minimal, valid column-metadata block for the passthrough cases.
const baseMetadata = [
  {
    name: "ssn",
    type: "ssn" as const,
    role: "linkage" as const,
    isPayload: false,
  },
];

// --- Round-trip: minted YAML re-parses equal to the assembled spec -----------

test("mintExchangeFile: an sftp config re-parses (camelize + schema) equal to the assembled spec", () => {
  const yaml = mintExchangeFile({
    connection: {
      channel: "sftp",
      host: "sftp.example.org",
      port: 2222,
      path: "/exchanges/drop",
    },
    linkageTerms: baseTerms,
  });

  // The minted YAML must load through the schema's own parse path unchanged.
  const reparsed = parseExchangeSpec(parseYaml(yaml));
  // What the mint layer asserted internally is exactly what the schema returns
  // for the assembled spec: build that expected spec the same way and compare.
  const expected = ExchangeSpecSchema.parse({
    connection: {
      channel: "sftp",
      server: {
        host: "sftp.example.org",
        username: PLACEHOLDER_SSH_USERNAME,
        port: 2222,
        path: "/exchanges/drop",
      },
    },
    linkageTerms: baseTerms,
  });
  expect(reparsed).toEqual(expected);
});

test("mintExchangeFile: the serialized YAML is snake_case and carries the placeholder username", () => {
  const yaml = mintExchangeFile({
    connection: { channel: "sftp", host: "sftp.example.org" },
    linkageTerms: baseTerms,
  });
  const raw = parseYaml(yaml) as Record<string, unknown>;
  const connection = raw["connection"] as Record<string, unknown>;
  const server = connection["server"] as Record<string, unknown>;
  // On-disk keys are snake_case (linkage_terms, not linkageTerms).
  expect(raw).toHaveProperty("linkage_terms");
  expect(raw).not.toHaveProperty("linkageTerms");
  // The one identity field a locator cannot carry is seeded for the operator.
  expect(server["username"]).toBe(PLACEHOLDER_SSH_USERNAME);
  expect(server["host"]).toBe("sftp.example.org");
});

// --- Filedrop minting --------------------------------------------------------

test("mintExchangeFile: a filedrop config carries the shared directory and no server block", () => {
  const yaml = mintExchangeFile({
    connection: { channel: "filedrop", path: "/mnt/share/drop" },
    linkageTerms: baseTerms,
  });
  const reparsed = parseExchangeSpec(parseYaml(yaml));
  expect(reparsed.connection).toEqual({
    channel: "filedrop",
    path: "/mnt/share/drop",
  });
});

// --- Split-directory pair minting --------------------------------------------

test("mintExchangeFile: an sftp split pair is carried verbatim under server", () => {
  const yaml = mintExchangeFile({
    connection: {
      channel: "sftp",
      host: "sftp.example.org",
      inboundPath: "/exchanges/in",
      outboundPath: "/exchanges/out",
      options: retainOptions,
    },
    linkageTerms: baseTerms,
  });
  const reparsed = parseExchangeSpec(parseYaml(yaml));
  if (reparsed.connection.channel !== "sftp")
    throw new Error("expected sftp connection");
  expect(reparsed.connection.server.inboundPath).toBe("/exchanges/in");
  expect(reparsed.connection.server.outboundPath).toBe("/exchanges/out");
  expect(reparsed.connection.server.path).toBeUndefined();
  expect(reparsed.connection.server.username).toBe(PLACEHOLDER_SSH_USERNAME);
});

test("mintExchangeFile: a filedrop split pair is carried at the top level", () => {
  const yaml = mintExchangeFile({
    connection: {
      channel: "filedrop",
      inboundPath: "/mnt/in",
      outboundPath: "/mnt/out",
      options: retainOptions,
    },
    linkageTerms: baseTerms,
  });
  const reparsed = parseExchangeSpec(parseYaml(yaml));
  if (reparsed.connection.channel !== "filedrop")
    throw new Error("expected filedrop connection");
  expect(reparsed.connection.inboundPath).toBe("/mnt/in");
  expect(reparsed.connection.outboundPath).toBe("/mnt/out");
  expect(reparsed.connection.path).toBeUndefined();
});

// --- Options and optional-block passthrough ----------------------------------

test("mintExchangeFile: FileSyncOptions, metadata, standardization, and payload commitments pass through", () => {
  const input: ExchangeFileInput = {
    connection: {
      channel: "sftp",
      host: "sftp.example.org",
      path: "/drop",
      options: { pollIntervalMs: 3000, unexpectedFiles: "warn" },
    },
    linkageTerms: baseTerms,
    metadata: baseMetadata,
    standardization: [
      { output: "ssn", input: "ssn", steps: [{ function: "trim" }] },
    ],
    disclosedPayloadColumns: ["first_name"],
    expectedPayloadColumns: ["last_name"],
  };
  const yaml = mintExchangeFile(input);
  const reparsed = parseExchangeSpec(parseYaml(yaml));

  if (reparsed.connection.channel !== "sftp")
    throw new Error("expected sftp connection");
  expect(reparsed.connection.options?.pollIntervalMs).toBe(3000);
  expect(reparsed.connection.options?.unexpectedFiles).toBe("warn");
  expect(reparsed.metadata).toEqual(baseMetadata);
  expect(reparsed.standardization).toBeDefined();
  expect(reparsed.disclosedPayloadColumns).toEqual(["first_name"]);
  expect(reparsed.expectedPayloadColumns).toEqual(["last_name"]);
});

test("mintExchangeFile: absent optional blocks are omitted keys, not explicit nulls", () => {
  const yaml = mintExchangeFile({
    connection: { channel: "filedrop", path: "/mnt/share/drop" },
    linkageTerms: baseTerms,
  });
  const raw = parseYaml(yaml) as Record<string, unknown>;
  // An omitted optional is an absent key -- not `metadata: null`, which would
  // re-parse differently than the assembled spec.
  expect(raw).not.toHaveProperty("metadata");
  expect(raw).not.toHaveProperty("standardization");
  expect(raw).not.toHaveProperty("disclosed_payload_columns");
  expect(raw).not.toHaveProperty("expected_payload_columns");
  // Never an authentication block: the secret rides only the invitation code.
  expect(raw).not.toHaveProperty("authentication");
});

// --- Negative: no credential field can appear in a minted file ---------------

test("mintExchangeFile: no credential field appears anywhere in a maximal minted YAML", () => {
  // Fill every optional the input type admits, so the maximal serialized form is
  // swept for credential/secret leakage. The input TYPE has no credential field,
  // so there is no way to smuggle one in -- a smuggling attempt would not
  // typecheck (compile-time documentation); this asserts the property over the
  // serialized string too, the board's explicit negative requirement.
  const yaml = mintExchangeFile({
    connection: {
      channel: "sftp",
      host: "sftp.example.org",
      port: 2222,
      inboundPath: "/exchanges/in",
      outboundPath: "/exchanges/out",
      options: retainOptions,
    },
    linkageTerms: baseTerms,
    metadata: baseMetadata,
    standardization: [
      { output: "ssn", input: "ssn", steps: [{ function: "trim" }] },
    ],
    disclosedPayloadColumns: ["first_name"],
    expectedPayloadColumns: ["last_name"],
  });

  for (const forbidden of [
    "password",
    "private_key",
    "private_key_passphrase",
    "authentication",
    "bearer",
  ])
    expect(yaml).not.toContain(forbidden);
});

// --- Fail loudly on an invalid assembled spec --------------------------------

test("mintExchangeFile: an invalid locator fails loudly with a ZodError at mint", () => {
  // A split pair whose halves are equal is rejected by the connection schema.
  // The mint validates before serializing, so this surfaces here, not later at
  // the CLI's config load.
  expect(() =>
    mintExchangeFile({
      connection: {
        channel: "filedrop",
        inboundPath: "/mnt/same",
        outboundPath: "/mnt/same",
        options: retainOptions,
      },
      linkageTerms: baseTerms,
    }),
  ).toThrow(ZodError);
});

test("mintExchangeFile: an empty sftp host fails loudly at mint", () => {
  expect(() =>
    mintExchangeFile({
      connection: { channel: "sftp", host: "" },
      linkageTerms: baseTerms,
    }),
  ).toThrow(ZodError);
});

// The assembled camelCase spec and its re-camelized snake_case serialization must
// be the same spec: this is the round-trip identity the mint layer guarantees.
test("mintExchangeFile: camelize(parse(mint(x))) equals the schema parse of the assembled spec", () => {
  const yaml = mintExchangeFile({
    connection: { channel: "sftp", host: "h.example.org", path: "/drop" },
    linkageTerms: baseTerms,
    metadata: baseMetadata,
  });
  const viaYaml = ExchangeSpecSchema.parse(camelizeKeys(parseYaml(yaml)));
  const expected = ExchangeSpecSchema.parse({
    connection: {
      channel: "sftp",
      server: {
        host: "h.example.org",
        username: PLACEHOLDER_SSH_USERNAME,
        path: "/drop",
      },
    },
    linkageTerms: baseTerms,
    metadata: baseMetadata,
  });
  expect(viaYaml).toEqual(expected);
});
