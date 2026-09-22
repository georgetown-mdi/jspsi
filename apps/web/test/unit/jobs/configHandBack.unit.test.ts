import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import {
  getDefaultLinkageTerms,
  serializeExchangeDocument,
  snakeizeKeys,
} from "@psilink/core";

import {
  ConfigurationHandBackRefusedError,
  handBackMountedConfiguration,
} from "@jobs/configHandBack";
import {
  ConfigurationLoadRefusedError,
  mountedConfigurationDocument,
} from "@jobs/configLoad";
import { HANDOFF_SIGNING_IDENTITY_PLACEHOLDER } from "@jobs/handoff";
import { jobConfigurationHandBackSchema } from "@jobs/intentSchemas";

import type { ExchangeSpec } from "@psilink/core";
import type { JobConfigurationHandBack } from "@jobs/intentSchemas";

// The hand-back of a webrtc configuration the console opened: the settings the
// authoring steps edit are written into the mounted psilink.yaml, and every
// other key the file stated -- its whole connection, credentials included --
// is written back as it was. Driven through the real mount read, core's
// schema, and core's writer.

/** A signing partner fingerprint of the canonical base64url shape. */
const PARTNER_FINGERPRINT = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA";

/** Obviously fake credential values, written inline so a byte comparison of
 * the handed-back file can find each one. */
const BROKER_KEY = "fake-broker-key-for-tests";
const TURN_CREDENTIAL = "fake-turn-credential-for-tests";
const PROVIDER_OPTION_PATH = "@/run/secrets/fake-provider-option";

/** A webrtc document of the shape the web application writes, its broker key,
 * TURN credential, and a provider option among the connection settings. */
function webrtcDocument(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    connection: {
      channel: "webrtc",
      role: "inviter",
      server: {
        host: "broker.example",
        port: 443,
        path: "/peers",
        key: BROKER_KEY,
        secure: true,
      },
      turn: [
        {
          url: "turn:turn.example.org:3478",
          username: "county",
          credential: TURN_CREDENTIAL,
        },
      ],
      ice_transport_policy: "relay",
      options: { peer_timeout_ms: 600_000 },
      provider_options: { debug_level: 0, config_file: PROVIDER_OPTION_PATH },
    },
    linkage_terms: snakeizeKeys(getDefaultLinkageTerms("County Health")),
    csv_delimiter: "|",
    include_own_columns: "all",
    expected_payload_columns: ["partner_notes"],
    expected_partner_deduplicate: false,
    retention_disposition: "Filed with the 2026 intake.",
    signing: {
      mode: "certificate",
      identity_file: "/home/county/.psilink/identity.json",
      partner_fingerprint: PARTNER_FINGERPRINT,
      receipt_output: "/home/county/receipts/latest.json",
    },
    authentication: { token_max_age_days: 30 },
    ...overrides,
  };
}

const dirs: Array<string> = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function mountHolding(document: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-handback-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "psilink.yaml"), stringifyYaml(document), {
    mode: 0o640,
  });
  return dir;
}

function mountedText(dir: string): string {
  return fs.readFileSync(path.join(dir, "psilink.yaml"), "utf8");
}

/** The hand-back of a document's own values: what the steps hold when the
 * operator changed nothing. Parsed through the route's own schema, so the
 * fixture is one the route admits. */
function unchangedHandBack(document: ExchangeSpec): JobConfigurationHandBack {
  return jobConfigurationHandBackSchema.parse({
    linkageTerms: document.linkageTerms,
    ...(document.metadata !== undefined ? { metadata: document.metadata } : {}),
    ...(document.standardization !== undefined
      ? { standardization: document.standardization }
      : {}),
    ...(document.includeOwnColumns !== undefined
      ? { includeOwnColumns: document.includeOwnColumns }
      : {}),
    ...(document.csvDelimiter !== undefined
      ? { csvDelimiter: document.csvDelimiter }
      : {}),
    signing: {
      mode: document.signing?.mode ?? "none",
      ...(document.signing?.partnerFingerprint !== undefined
        ? { partnerFingerprint: document.signing.partnerFingerprint }
        : {}),
    },
    ...(document.retentionDisposition !== undefined
      ? { retentionDisposition: document.retentionDisposition }
      : {}),
  });
}

/** The document as the mount holds it now. */
function readBack(dir: string): ExchangeSpec {
  return mountedConfigurationDocument(mountedText(dir));
}

describe("a webrtc configuration handed back unchanged", () => {
  test("is the file psilink writes for that document, byte for byte", () => {
    const dir = mountHolding(webrtcDocument());
    const opened = readBack(dir);
    handBackMountedConfiguration(dir, unchangedHandBack(opened));
    expect(mountedText(dir)).toBe(serializeExchangeDocument(opened));
  });

  test("re-writes to itself", () => {
    const dir = mountHolding(webrtcDocument());
    handBackMountedConfiguration(dir, unchangedHandBack(readBack(dir)));
    const first = mountedText(dir);
    handBackMountedConfiguration(dir, unchangedHandBack(readBack(dir)));
    expect(mountedText(dir)).toBe(first);
  });
});

describe("a webrtc configuration handed back with edits", () => {
  function editedHandBack(opened: ExchangeSpec): JobConfigurationHandBack {
    return {
      ...unchangedHandBack(opened),
      linkageTerms: { ...opened.linkageTerms, identity: "County Health West" },
      csvDelimiter: ";",
      retentionDisposition: "Destroyed after 90 days.",
      signing: { mode: "certificate" },
    };
  }

  test("holds the edits", () => {
    const dir = mountHolding(webrtcDocument());
    handBackMountedConfiguration(dir, editedHandBack(readBack(dir)));
    const written = readBack(dir);
    expect(written.linkageTerms.identity).toBe("County Health West");
    expect(written.csvDelimiter).toBe(";");
    expect(written.retentionDisposition).toBe("Destroyed after 90 days.");
    expect(written.signing?.partnerFingerprint).toBeUndefined();
  });

  test("drops nothing: every other key is the one the file stated", () => {
    const dir = mountHolding(webrtcDocument());
    const opened = readBack(dir);
    handBackMountedConfiguration(dir, editedHandBack(opened));
    const written = readBack(dir);
    const unedited = (document: ExchangeSpec) => {
      const {
        linkageTerms: { identity: _identity, ...terms },
        csvDelimiter: _csvDelimiter,
        retentionDisposition: _retentionDisposition,
        signing,
        ...rest
      } = document;
      const { partnerFingerprint: _pin, ...heldSigning } = signing ?? {};
      return { ...rest, linkageTerms: terms, signing: heldSigning };
    };
    expect(unedited(written)).toEqual(unedited(opened));
    expect(Object.keys(written).sort()).toEqual(Object.keys(opened).sort());
  });

  test("writes the connection block exactly as the file states it", () => {
    const dir = mountHolding(webrtcDocument());
    const opened = readBack(dir);
    handBackMountedConfiguration(dir, editedHandBack(opened));
    expect(readBack(dir).connection).toEqual(opened.connection);
    const connectionBlock = (text: string) =>
      text.slice(text.indexOf("connection:"), text.indexOf("linkage_terms:"));
    expect(connectionBlock(mountedText(dir))).toBe(
      connectionBlock(serializeExchangeDocument(opened)),
    );
    for (const credential of [
      BROKER_KEY,
      TURN_CREDENTIAL,
      PROVIDER_OPTION_PATH,
    ])
      expect(mountedText(dir)).toContain(credential);
  });

  test("keeps the file's own permission bits and leaves no other file", () => {
    const dir = mountHolding(webrtcDocument());
    handBackMountedConfiguration(dir, editedHandBack(readBack(dir)));
    expect(fs.statSync(path.join(dir, "psilink.yaml")).mode & 0o777).toBe(
      0o640,
    );
    expect(fs.readdirSync(dir)).toEqual(["psilink.yaml"]);
  });
});

describe("the signing block a hand-back writes", () => {
  test("turning signing off writes no block", () => {
    const dir = mountHolding(webrtcDocument());
    const opened = readBack(dir);
    handBackMountedConfiguration(dir, {
      ...unchangedHandBack(opened),
      signing: { mode: "none" },
    });
    expect(readBack(dir).signing).toBeUndefined();
  });

  test("turning it on names the placeholder identity where the file names none", () => {
    const dir = mountHolding(webrtcDocument({ signing: undefined }));
    const opened = readBack(dir);
    handBackMountedConfiguration(dir, {
      ...unchangedHandBack(opened),
      signing: { mode: "certificate", partnerFingerprint: PARTNER_FINGERPRINT },
    });
    expect(readBack(dir).signing).toEqual({
      mode: "certificate",
      identityFile: HANDOFF_SIGNING_IDENTITY_PLACEHOLDER,
      partnerFingerprint: PARTNER_FINGERPRINT,
    });
  });

  test("a session-derived block the operator left is kept whole", () => {
    const dir = mountHolding(
      webrtcDocument({ signing: { mode: "session-derived" } }),
    );
    const opened = readBack(dir);
    handBackMountedConfiguration(dir, unchangedHandBack(opened));
    expect(readBack(dir).signing).toEqual({ mode: "session-derived" });
  });
});

describe("what a hand-back refuses", () => {
  test("a mount holding no configuration", () => {
    const dir = mountHolding(webrtcDocument());
    const handBack = unchangedHandBack(readBack(dir));
    fs.rmSync(path.join(dir, "psilink.yaml"));
    expect(() => handBackMountedConfiguration(dir, handBack)).toThrow(
      ConfigurationLoadRefusedError,
    );
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test("a file changed on disk to a channel the console runs itself", () => {
    const dir = mountHolding(webrtcDocument());
    const handBack = unchangedHandBack(readBack(dir));
    const filedrop = webrtcDocument({
      connection: { channel: "filedrop", path: "/drop" },
      signing: undefined,
    });
    fs.writeFileSync(path.join(dir, "psilink.yaml"), stringifyYaml(filedrop));
    const before = mountedText(dir);
    expect(() => handBackMountedConfiguration(dir, handBack)).toThrow(
      /runs over filedrop now/,
    );
    expect(mountedText(dir)).toBe(before);
  });

  test("settings that do not make a valid configuration, leaving the file", () => {
    const dir = mountHolding(webrtcDocument());
    const opened = readBack(dir);
    const before = mountedText(dir);
    let refusal: unknown;
    try {
      // include_own_columns has no result file to act on beside a count-only
      // algorithm, which core's schema refuses once the two are merged.
      handBackMountedConfiguration(dir, {
        ...unchangedHandBack(opened),
        linkageTerms: { ...opened.linkageTerms, algorithm: "psi-c" },
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ConfigurationHandBackRefusedError);
    expect((refusal as Error).message).toContain("save again");
    expect(mountedText(dir)).toBe(before);
  });
});
