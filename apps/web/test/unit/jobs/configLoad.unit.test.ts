import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import { getDefaultLinkageTerms, snakeizeKeys } from "@psilink/core";

import {
  ConfigurationLoadRefusedError,
  carriedThroughFields,
  credentialFieldsNotAdopted,
  disclosedDocument,
  loadMountedConfiguration,
  readMountedConfiguration,
} from "@jobs/configLoad";

import type { ExchangeSpec } from "@psilink/core";

// The mount load's server half: what it reads, what it refuses, what it
// discloses, and which settings it reports holding without an editor.
//
// Every document here is written as YAML and read through the real
// readMountedConfiguration, so the sensitive-parse chokepoint, core's own
// exchange-file schema (the unread-key refusal included), and the console's
// three refusals are all in the path under test.

/** The host-key fingerprint every sftp fixture pins. Obviously fake, of the
 * canonical OpenSSH SHA256 shape core's schema grades. */
const FINGERPRINT = "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA";

/** A signing partner fingerprint of the canonical base64url shape. */
const PARTNER_FINGERPRINT = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA";

function terms() {
  return getDefaultLinkageTerms("County Health");
}

/** The document a CLI `psilink invite --save` writes for an sftp exchange, as
 * the file spells it. */
function savedSftpDocument(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...(snakeizeKeys({
      connection: {
        channel: "sftp",
        server: {
          host: "sftp.partner.example",
          port: 2222,
          path: "/exchange",
          username: "county",
          password: "@/run/secrets/sftp-password",
          hostKeyFingerprint: FINGERPRINT,
        },
        options: { pollIntervalMs: 120_000, retainFiles: false },
      },
      linkageTerms: terms(),
      csvDelimiter: "|",
      includeOwnColumns: "all",
      expectedPayloadColumns: ["partner_notes"],
      expectedPartnerDeduplicate: false,
      disclosedPayloadColumns: ["own_notes"],
      retentionDisposition: "Filed with the 2026 intake.",
    }) as Record<string, unknown>),
    ...overrides,
  };
}

function loadDocument(document: Record<string, unknown>) {
  return readMountedConfiguration(stringifyYaml(document));
}

function refusal(document: Record<string, unknown>): string {
  try {
    loadDocument(document);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationLoadRefusedError);
    return (error as Error).message;
  }
  throw new Error("the load was expected to refuse this document");
}

describe("what the load discloses", () => {
  test("the connection fields the form edits, the credential excepted", () => {
    const { document } = loadDocument(savedSftpDocument());
    expect(document?.channel).toBe("sftp");
    expect(document?.server).toEqual({
      host: "sftp.partner.example",
      port: 2222,
      path: "/exchange",
      username: "county",
      hostKeyFingerprint: FINGERPRINT,
      credentialMethod: "password",
    });
  });

  test("the local settings each authoring card edits", () => {
    const { document } = loadDocument(savedSftpDocument());
    expect(document?.csvDelimiter).toBe("|");
    expect(document?.includeOwnColumns).toBe("all");
    expect(document?.retentionDisposition).toBe("Filed with the 2026 intake.");
    expect(document?.linkageTerms.identity).toBe("County Health");
  });

  test("the signing mode and pin, never the paths the console owns", () => {
    const { document } = loadDocument(
      savedSftpDocument({
        signing: {
          mode: "certificate",
          partner_fingerprint: PARTNER_FINGERPRINT,
          identity_file: "/home/operator/.psilink/identity.json",
          receipt_output: "/home/operator/receipts/latest.json",
        },
      }),
    );
    expect(document?.signing).toEqual({
      mode: "certificate",
      partnerFingerprint: PARTNER_FINGERPRINT,
    });
  });

  test("no credential value and no @ reference appears anywhere in the body", () => {
    const response = loadDocument(
      savedSftpDocument({
        signing: {
          mode: "certificate",
          identity_file: "@/run/secrets/identity",
          receipt_output: "/out/receipt.json",
        },
      }),
    );
    const body = JSON.stringify(response);
    expect(body).not.toContain("@/run/secrets/sftp-password");
    expect(body).not.toContain("@/run/secrets/identity");
    expect(body).not.toMatch(/"@/);
  });

  test("a shared secret in the key file's own shape never reaches the body", () => {
    // The key file sits beside the configuration; nothing here opens it, and a
    // document naming a secret is refused rather than disclosed.
    const message = refusal(
      savedSftpDocument({
        authentication: { shared_secret: "x".repeat(43) },
      }),
    );
    expect(message).toContain("shared_secret");
    expect(message).not.toContain("x".repeat(43));
  });

  test("an absent file is present: false with no error", () => {
    // The route's own absent-file answer; `readMountedConfiguration` is only
    // reached once bytes exist, so the shape is asserted at the loader below.
    expect(loadDocument(savedSftpDocument()).present).toBe(true);
  });
});

describe("a mounted file the load cannot open", () => {
  const dirs: Array<string> = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.chmodSync(dir, 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function mountDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-configload-"));
    dirs.push(dir);
    return dir;
  }

  function unreadableMountDir(): string {
    const dir = mountDir();
    const filePath = path.join(dir, "psilink.yaml");
    fs.writeFileSync(filePath, "connection: {}");
    fs.chmodSync(filePath, 0o000);
    return dir;
  }

  function refusalFrom(dir: string): string {
    try {
      loadMountedConfiguration(dir);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationLoadRefusedError);
      return (error as Error).message;
    }
    throw new Error("the load was expected to refuse this mount");
  }

  test("an absent mount is present: false, not a refusal", () => {
    expect(loadMountedConfiguration(mountDir())).toEqual({
      configured: true,
      present: false,
      carriedThrough: [],
      warnings: [],
    });
  });

  test("an unreadable file refuses, naming neither errno nor path", () => {
    const message = refusalFrom(unreadableMountDir());
    expect(message).toContain("could not");
    expect(message).not.toContain("EACCES");
    expect(message).not.toMatch(/\/tmp/);
  });

  test("a directory at the config path refuses the same way as unreadable", () => {
    const dir = mountDir();
    fs.mkdirSync(path.join(dir, "psilink.yaml"));
    expect(refusalFrom(dir)).toBe(refusalFrom(unreadableMountDir()));
  });

  test("an over-large file refuses by size, distinctly from unreadable", () => {
    const dir = mountDir();
    fs.writeFileSync(path.join(dir, "psilink.yaml"), "x".repeat(1_000_001));
    const message = refusalFrom(dir);
    expect(message).toContain("too large");
    expect(message).not.toMatch(/\/tmp/);
    expect(message).not.toBe(refusalFrom(unreadableMountDir()));
  });
});

describe("what the load refuses", () => {
  test("a webrtc connection, by channel", () => {
    const message = refusal({
      connection: {
        channel: "webrtc",
        role: "inviter",
        server: { host: "broker.example" },
      },
      linkage_terms: snakeizeKeys(terms()),
    });
    expect(message).toContain("webrtc");
    expect(message).toContain("command line");
  });

  test("a schema violation, naming the setting in the file's snake_case", () => {
    const document = savedSftpDocument();
    (document.connection as Record<string, unknown>) = {
      channel: "sftp",
      server: { host: "sftp.partner.example", port: 70_000 },
    };
    const message = refusal(document);
    expect(message).toContain("connection.server.port");
    expect(message).not.toContain("70000");
  });

  test("a key no schema block reads, spelled as the file wrote it", () => {
    const message = refusal(savedSftpDocument({ retian_disposition: "typo" }));
    expect(message).toContain("retian_disposition");
  });

  test("an authentication expiry, beside the shared secret", () => {
    expect(
      refusal(
        savedSftpDocument({ authentication: { expires: 1_800_000_000 } }),
      ),
    ).toContain("expires");
  });

  test("bytes that are not YAML, without the parser's own words", () => {
    let message = "";
    try {
      readMountedConfiguration("connection: [unclosed\n  host: x");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("could not be read as YAML");
  });
});

describe("what the load reads and does not adopt", () => {
  test("an sftp credential reference, by field name only", () => {
    expect(loadDocument(savedSftpDocument()).warnings).toEqual([
      "connection.server.password",
    ]);
  });

  test("a @path credential warns and the load proceeds", () => {
    const response = loadDocument(savedSftpDocument());
    expect(response.present).toBe(true);
    expect(response.document?.server?.credentialMethod).toBe("password");
    expect(response.warnings).toContain("connection.server.password");
  });

  test("a private key and its passphrase, both named", () => {
    const document = savedSftpDocument();
    document.connection = snakeizeKeys({
      channel: "sftp",
      server: {
        host: "sftp.partner.example",
        privateKey: "@/run/secrets/key",
        privateKeyPassphrase: "@/run/secrets/key-passphrase",
        hostKeyFingerprint: FINGERPRINT,
      },
    });
    expect(loadDocument(document).warnings).toEqual([
      "connection.server.private_key",
      "connection.server.private_key_passphrase",
    ]);
  });

  test("a filedrop connection draws no credential warning of its own", () => {
    const spec = {
      connection: { channel: "filedrop", path: "/mnt/partner-drop" },
      linkageTerms: terms(),
    } as unknown as ExchangeSpec;
    expect(credentialFieldsNotAdopted(spec)).toEqual([]);
  });

  test("the rendezvous directory a filedrop file names is held, not adopted", () => {
    const spec = {
      connection: { channel: "filedrop", path: "/mnt/partner-drop" },
      linkageTerms: terms(),
    } as unknown as ExchangeSpec;
    expect(carriedThroughFields(spec)).toEqual(["connection.path"]);
  });
});

describe("the settings the console holds without an editor", () => {
  test("a max-age policy is carried through, named as the file spells it", () => {
    const response = loadDocument(
      savedSftpDocument({ authentication: { token_max_age_days: 30 } }),
    );
    expect(response.carriedThrough).toContain(
      "authentication.token_max_age_days",
    );
  });

  test("the receipt output is carried through, the console pinning its own", () => {
    const response = loadDocument(
      savedSftpDocument({
        signing: { mode: "certificate", receipt_output: "/out/receipt.json" },
      }),
    );
    expect(response.carriedThrough).toContain("signing.receipt_output");
  });

  test("a setting the console composes is not reported as held", () => {
    const response = loadDocument(savedSftpDocument());
    expect(response.carriedThrough).toEqual([]);
  });

  test("names only: no value of a carried-through setting is reported", () => {
    const response = loadDocument(
      savedSftpDocument({
        signing: {
          mode: "certificate",
          identity_file: "/home/operator/.psilink/identity.json",
        },
      }),
    );
    expect(response.carriedThrough).toContain("signing.identity_file");
    expect(JSON.stringify(response.carriedThrough)).not.toContain("/home");
  });
});

describe("the records that must survive a load", () => {
  const MUST_SURVIVE = [
    "expected_payload_columns",
    "expected_partner_deduplicate",
    "disclosed_payload_columns",
  ];

  test("none of the three is reported as held without an editor", () => {
    // Held-without-an-editor is what a setting the composition cannot emit
    // gets, and these three have no such fallback: a record this console
    // cannot put back into the document it composes turns off a check the
    // operator wrote.
    const response = loadDocument(savedSftpDocument());
    for (const field of MUST_SURVIVE)
      expect(response.carriedThrough).not.toContain(field);
  });

  test("each reaches the disclosed document with the value the file states", () => {
    const { document } = loadDocument(savedSftpDocument());
    expect(document?.expectedPayloadColumns).toEqual(["partner_notes"]);
    expect(document?.expectedPartnerDeduplicate).toBe(false);
    expect(document?.disclosedPayloadColumns).toEqual(["own_notes"]);
  });

  test("an empty list survives as an empty list, not as an absence", () => {
    const { document } = loadDocument(
      savedSftpDocument({
        expected_payload_columns: [],
        disclosed_payload_columns: [],
      }),
    );
    expect(document?.expectedPayloadColumns).toEqual([]);
    expect(document?.disclosedPayloadColumns).toEqual([]);
  });

  test("a document stating one the composition cannot emit refuses by name", () => {
    // Driven against carriedThroughFields directly: were one of the three to
    // leave the composers, it would appear here, which is the condition the
    // load's own refusal reads. This is the check standing in for a comment
    // claiming the three survive.
    const spec = {
      connection: {
        channel: "sftp",
        server: { host: "h", hostKeyFingerprint: FINGERPRINT },
      },
      linkageTerms: terms(),
      expectedPayloadColumns: ["a"],
      expectedPartnerDeduplicate: true,
      disclosedPayloadColumns: ["b"],
    } as unknown as ExchangeSpec;
    expect(carriedThroughFields(spec)).toEqual([]);
  });
});

describe("the disclosed projection", () => {
  test("states no key the schema holds and the forms do not edit", () => {
    const spec = {
      connection: {
        channel: "sftp",
        server: {
          host: "h",
          hostKeyFingerprint: FINGERPRINT,
          password: "@/secret",
          knownHosts: "/etc/ssh/known_hosts",
        },
      },
      linkageTerms: terms(),
      authentication: { tokenMaxAgeDays: 30 },
    } as unknown as ExchangeSpec;
    const disclosed = disclosedDocument(spec);
    expect(Object.keys(disclosed.server ?? {})).toEqual([
      "host",
      "hostKeyFingerprint",
      "credentialMethod",
    ]);
    expect(Object.hasOwn(disclosed, "authentication")).toBe(false);
  });
});
