import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { mintExchangeFile, PLACEHOLDER_SSH_USERNAME } from "@psilink/core";
import type { LinkageTerms } from "@psilink/core";

import { loadConfig } from "../../src/commands/exchange";
import { saveKeyFile } from "../../src/keyFile";

// A 43-char base64url token satisfying the sharedSecret format constraint, so
// the key file the CLI loads alongside the config is valid.
const TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

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

let dir: string;
let configFile: string;
let keyFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-exchange-file-test-"));
  configFile = path.join(dir, "psilink.yaml");
  keyFile = path.join(dir, ".psilink.key");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a core-minted sftp YAML loads through the CLI config path with the placeholder username intact", () => {
  // The mint layer produces the config; the CLI loads it verbatim -- no hand
  // edits between mint and load, the board's core requirement.
  const yaml = mintExchangeFile({
    connection: {
      channel: "sftp",
      host: "sftp.example.org",
      port: 2222,
      path: "/exchanges/drop",
    },
    linkageTerms: baseTerms,
  });
  fs.writeFileSync(configFile, yaml);
  saveKeyFile(keyFile, { sharedSecret: TOKEN });

  const result = loadConfig({ configFile, keyFile });
  expect(result.connection.channel).toBe("sftp");
  if (result.connection.channel !== "sftp")
    throw new Error("expected sftp connection");
  expect(result.connection.server.host).toBe("sftp.example.org");
  expect(result.connection.server.port).toBe(2222);
  expect(result.connection.server.path).toBe("/exchanges/drop");
  // The placeholder username survives the mint -> serialize -> load round-trip
  // unchanged, so the operator sees the field they must fill in.
  expect(result.connection.server.username).toBe(PLACEHOLDER_SSH_USERNAME);
  // The secret rides only the key file, injected at load -- never the config.
  expect(result.authentication.sharedSecret).toBe(TOKEN);
});

test("a core-minted filedrop YAML loads through the CLI config path unchanged", () => {
  const yaml = mintExchangeFile({
    connection: { channel: "filedrop", path: "/mnt/share/drop" },
    linkageTerms: baseTerms,
  });
  fs.writeFileSync(configFile, yaml);
  saveKeyFile(keyFile, { sharedSecret: TOKEN });

  const result = loadConfig({ configFile, keyFile });
  expect(result.connection.channel).toBe("filedrop");
  if (result.connection.channel !== "filedrop")
    throw new Error("expected filedrop connection");
  expect(result.connection.path).toBe("/mnt/share/drop");
  expect(result.linkageTerms?.identity).toBe("Inviter");
});
