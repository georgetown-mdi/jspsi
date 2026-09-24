import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";
import YAML from "yaml";

import { generateSigningIdentity } from "@alcove/core";

import { handler } from "../../../src/commands/exchange";
import { saveKeyFile } from "../../../src/keyFile";
import { saveSigningIdentity } from "../../../src/signingIdentityFile";
import { captureFd3 } from "../../eventStreamTestSupport";
import { captureProcessExit } from "../../exitCapture";

import type { Arguments } from "yargs";

// The refusal of a first authenticated contact whose configuration directory
// cannot take the pin it would record (assertPartnerFingerprintRecordable,
// ../../../src/config.ts), driven through the command as an operator runs it:
// nothing here is mocked but `process.exit` and fd 3 itself, so what the run
// reaches is what production reaches.
//
// A supervisor watching the machine channel is told nothing by this refusal,
// which is what docs/spec/SERVER_JOB_API.md rests its statement that the console
// relay has no event to rewrite on: the check stands ahead of the exchange, and
// the event stream is opened inside it.

const SHARED_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-pin-preflight-"));
});

afterEach(() => {
  fs.chmodSync(dir, 0o755);
  fs.rmSync(dir, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "a first contact that cannot record its pin exits 64 with nothing on fd 3 (skipped where a directory cannot be made read-only for its owner)",
  async () => {
    const configFile = path.join(dir, "alcove.yaml");
    const keyFile = path.join(dir, ".alcove.key");
    const identityFile = path.join(dir, "signing-identity.json");
    const input = path.join(dir, "in.csv");
    fs.writeFileSync(input, "ssn\n123456789\n");
    // Everything else this run needs is in place -- the identity it signs with
    // is bound to the party the terms name -- so the pin it cannot record is the
    // only thing left to stop it.
    saveSigningIdentity(
      identityFile,
      await generateSigningIdentity("Test Party"),
      { exclusive: true },
    );
    fs.writeFileSync(
      configFile,
      YAML.stringify({
        connection: { channel: "filedrop", path: path.join(dir, "drop") },
        linkage_terms: {
          version: "1.0.0",
          identity: "Test Party",
          date: "2025-01-01",
          algorithm: "psi",
          output: { expects_output: true, share_with_partner: false },
          deduplicate: false,
          linkage_fields: [{ name: "ssn", type: "ssn" }],
          linkage_keys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
        },
        // Certificate mode with no partner_fingerprint: the run would pin the
        // certificate its partner presents and record the value here.
        signing: { mode: "certificate", identity_file: identityFile },
      }),
    );
    saveKeyFile(keyFile, {
      sharedSecret: SHARED_SECRET,
      expires: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    });
    fs.chmodSync(dir, 0o555);
    const argv = {
      _: [],
      $0: "alcove",
      input,
      "config-file": configFile,
      "key-file": keyFile,
      "log-level": "silent",
      "event-stream": true,
    } as unknown as Arguments;
    const exitSpy = captureProcessExit();
    try {
      const { lines } = await captureFd3(async () => {
        await expect(handler(argv)).rejects.toThrow("exit:64");
      });
      expect(lines).toEqual([]);
    } finally {
      exitSpy.mockRestore();
    }
  },
);
