import { execFileSync } from "node:child_process";
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
import { authoringStateFromDocument } from "@console/loadedConfig";
import { composeSftpConfigSpec } from "@jobs/intentConfig";

import { testSftpServerEntry, validSftpIntent } from "../../utils/jobFixtures";

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

/** The same document with a private key and its passphrase in place of the
 * password: core's server schema admits one primary credential at a time. The
 * remote directory is the split pair, which core admits only under retained
 * files and the two settings retention implies. */
function privateKeySftpDocument(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const document = savedSftpDocument(overrides);
  document.connection = snakeizeKeys({
    channel: "sftp",
    server: {
      host: "sftp.partner.example",
      inboundPath: "/exchange/in",
      outboundPath: "/exchange/out",
      username: "county",
      privateKey: "@/run/secrets/key",
      privateKeyPassphrase: "@/run/secrets/key-passphrase",
      hostKeyFingerprint: FINGERPRINT,
    },
    options: {
      retainFiles: true,
      timestampInFilename: true,
      locklessRendezvous: true,
    },
  });
  return document;
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

  test("a directory named psilink.yaml refuses as unreadable", () => {
    const dir = mountDir();
    fs.mkdirSync(path.join(dir, "psilink.yaml"));
    const message = refusalFrom(dir);
    expect(message).toContain("could not");
    expect(message).not.toContain("too large");
  });

  test("a FIFO named psilink.yaml refuses as unreadable, without blocking", () => {
    // A plain open() of a FIFO for reading blocks until a writer opens it; with
    // no writer ever attached here, a blocking open would wedge this
    // synchronous server. The load must open non-blocking so the refusal
    // returns promptly instead.
    let mkfifoAvailable = true;
    const dir = mountDir();
    const filePath = path.join(dir, "psilink.yaml");
    try {
      execFileSync("mkfifo", [filePath]);
    } catch {
      mkfifoAvailable = false;
    }
    if (!mkfifoAvailable) {
      console.warn("skipping FIFO test: mkfifo is not available");
      return;
    }
    const started = Date.now();
    const message = refusalFrom(dir);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(message).toContain("could not");
    expect(message).not.toContain("too large");
  });

  test("an over-large file refuses by size, distinctly from unreadable", () => {
    const dir = mountDir();
    fs.writeFileSync(path.join(dir, "psilink.yaml"), "x".repeat(1_000_001));
    const message = refusalFrom(dir);
    expect(message).toContain("too large");
    expect(message).not.toMatch(/\/tmp/);
    expect(message).not.toBe(refusalFrom(unreadableMountDir()));
  });

  test("a file of exactly the cap plus one byte refuses as over-large", () => {
    const dir = mountDir();
    fs.writeFileSync(path.join(dir, "psilink.yaml"), "x".repeat(1_000_001));
    expect(refusalFrom(dir)).toContain("too large");
  });

  test("a file of exactly the cap is read rather than refused by size", () => {
    const dir = mountDir();
    fs.writeFileSync(path.join(dir, "psilink.yaml"), "x".repeat(1_000_000));
    expect(refusalFrom(dir)).not.toContain("too large");
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

  test("a document nested past the case conversion's bound, as a refusal", () => {
    // The bound is raised by the case conversion rather than the schema, and
    // it is reported at the document root, which names no setting to fix.
    let nested: Record<string, unknown> = { host: "sftp.partner.example" };
    for (let depth = 0; depth < 300; depth += 1) nested = { server: nested };
    const message = refusal({ connection: nested });
    expect(message).toContain("not a psilink exchange configuration");
    expect(message).not.toContain("sftp.partner.example");
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
    const response = loadDocument(privateKeySftpDocument());
    expect(response.warnings).toEqual([
      "connection.server.private_key",
      "connection.server.private_key_passphrase",
    ]);
    // Named once, as a credential the hand-off writes a placeholder for --
    // never as a setting the export writes back unchanged.
    expect(response.carriedThrough).toEqual([]);
  });

  test("no credential the load warns about is also reported as held", () => {
    // The two claims are mutually exclusive: a field the console cannot
    // pre-fill is one the operator authors again and the composition writes,
    // so telling the operator in one answer that the file's value is kept
    // would invite them to believe a credential reference survives a
    // re-author that overwrites it.
    for (const document of [savedSftpDocument(), privateKeySftpDocument()]) {
      const response = loadDocument(document);
      expect(response.warnings.length).toBeGreaterThan(0);
      for (const field of response.warnings)
        expect(response.carriedThrough).not.toContain(field);
    }
  });

  test("a split remote directory is composed, not held without an editor", () => {
    // Both directory forms are the connection form's own fields, so neither is
    // a setting this surface keeps unchanged.
    expect(loadDocument(privateKeySftpDocument()).carriedThrough).toEqual([]);
  });

  test("a filedrop connection draws no credential warning of its own", () => {
    const spec = {
      connection: { channel: "filedrop", path: "/mnt/partner-drop" },
      linkageTerms: terms(),
    } as unknown as ExchangeSpec;
    expect(credentialFieldsNotAdopted(spec)).toEqual([]);
  });

  test("the rendezvous directory a filedrop file names is not held", () => {
    // A run here writes its own rendezvous folder and the hand-off writes a
    // placeholder for it, so the document's value is replaced rather than
    // kept, and the held list does not claim it.
    const spec = {
      connection: { channel: "filedrop", path: "/mnt/partner-drop" },
      linkageTerms: terms(),
    } as unknown as ExchangeSpec;
    expect(carriedThroughFields(spec)).toEqual([]);
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

  test("the signing paths the console pins itself are not held", () => {
    const response = loadDocument(
      savedSftpDocument({
        signing: {
          mode: "certificate",
          partner_fingerprint: PARTNER_FINGERPRINT,
          identity_file: "/home/operator/.psilink/identity.json",
          receipt_output: "/out/receipt.json",
        },
      }),
    );
    expect(response.carriedThrough).toEqual([]);
  });

  test("a setting the console composes is not reported as held", () => {
    const response = loadDocument(savedSftpDocument());
    expect(response.carriedThrough).toEqual([]);
  });

  test("the column roles and the cleaning pipeline are not reported as held", () => {
    // The columns step edits both and the run writes what it holds, so a
    // document stating either is opened into that step rather than kept
    // unchanged.
    const response = loadDocument(
      savedSftpDocument({
        metadata: [
          {
            name: "own_notes",
            type: "other",
            role: "ignored",
            is_payload: false,
          },
        ],
        standardization: [
          { output: "first_name", input: "own_notes", steps: [] },
        ],
      }),
    );
    expect(response.carriedThrough).toEqual([]);
  });

  test("names only: no value of a held setting is reported", () => {
    const response = loadDocument(
      savedSftpDocument({ authentication: { token_max_age_days: 30 } }),
    );
    expect(response.carriedThrough).toEqual([
      "authentication.token_max_age_days",
    ]);
    expect(JSON.stringify(response.carriedThrough)).not.toContain("30");
  });
});

describe("a setting inside a block the composition writes", () => {
  // The export writes a composed block over the opened document's whole
  // (apps/web/src/jobs/handoff.ts), so a setting inside one cannot be kept.
  // The portable-configuration rule lets a consumer hold a setting or refuse
  // naming it, and this is the refusal: reporting it as kept and then writing
  // over it is what the rule does not allow.
  const CONNECTION_SETTINGS: ReadonlyArray<[string, Record<string, unknown>]> =
    [
      [
        "connection.server.provision",
        { provision: { host: "wake.partner.example", port: 8080 } },
      ],
      ["connection.provider_options", { provider_options: {} }],
      ["connection.proxy", { proxy: { host: "proxy.partner.example" } }],
    ];

  test.each(CONNECTION_SETTINGS)("%s refuses by name", (field, stated) => {
    const document = savedSftpDocument();
    const connection = document.connection as Record<string, unknown>;
    const inServer = field.startsWith("connection.server.");
    document.connection = inServer
      ? {
          ...connection,
          server: { ...(connection.server as object), ...stated },
        }
      : { ...connection, ...stated };
    const message = refusal(document);
    expect(message).toContain(field);
    expect(message).toContain("psilink on the command line");
  });

  test("the refusal names the setting only, never its value", () => {
    const document = savedSftpDocument();
    const connection = document.connection as Record<string, unknown>;
    document.connection = {
      ...connection,
      proxy: { host: "proxy.partner.example", port: 8080 },
    };
    expect(refusal(document)).not.toContain("proxy.partner.example");
  });

  test("a block the composition never writes is kept, not refused", () => {
    // The counter-case the refusal above is measured against: `authentication`
    // is no composition's block here, so its setting rides the export.
    const response = loadDocument(
      savedSftpDocument({ authentication: { token_max_age_days: 30 } }),
    );
    expect(response.carriedThrough).toEqual([
      "authentication.token_max_age_days",
    ]);
  });
});

describe("the records that must survive a load", () => {
  const MUST_SURVIVE = [
    "expected_payload_columns",
    "expected_partner_deduplicate",
    "disclosed_payload_columns",
    "outbound_payload_consent",
  ];

  test("none of them is reported as held without an editor", () => {
    // Held-without-an-editor is what a setting the composition cannot emit
    // gets, and these records have no such fallback: one this console cannot
    // put back into the document it composes turns off a check the operator
    // wrote.
    const response = loadDocument(
      savedSftpDocument({
        outbound_payload_consent: {
          status: "confirmed",
          columns: ["own_notes"],
        },
      }),
    );
    for (const field of MUST_SURVIVE)
      expect(response.carriedThrough).not.toContain(field);
  });

  test("each reaches the disclosed document with the value the file states", () => {
    const { document } = loadDocument(
      savedSftpDocument({
        outbound_payload_consent: {
          status: "confirmed",
          columns: ["own_notes"],
        },
      }),
    );
    expect(document?.expectedPayloadColumns).toEqual(["partner_notes"]);
    expect(document?.expectedPartnerDeduplicate).toBe(false);
    expect(document?.disclosedPayloadColumns).toEqual(["own_notes"]);
    expect(document?.outboundPayloadConsent).toEqual({
      status: "confirmed",
      columns: ["own_notes"],
    });
  });

  test("a pending consent record survives as pending", () => {
    // The state that refuses an unattended run until the set is confirmed:
    // losing it would let the next run proceed against no record at all.
    const { document } = loadDocument(
      savedSftpDocument({ outbound_payload_consent: { status: "pending" } }),
    );
    expect(document?.outboundPayloadConsent).toEqual({ status: "pending" });
  });

  test("each survives the whole cycle: load, authoring state, composition", () => {
    // The cycle a console run makes of a mounted configuration. Each record's
    // absence is a valid state that turns its own enforcement off, so the
    // composed configuration has to state what the file stated.
    const consent = { status: "confirmed" as const, columns: ["own_notes"] };
    const { document } = loadDocument(
      savedSftpDocument({ outbound_payload_consent: consent }),
    );
    if (document === undefined)
      throw new Error("the load disclosed no document");
    const { records } = authoringStateFromDocument(document);
    const composed = composeSftpConfigSpec(
      validSftpIntent({ ...records, side: "acceptor" }),
      testSftpServerEntry(),
    );
    expect(composed.expectedPayloadColumns).toEqual(["partner_notes"]);
    expect(composed.expectedPartnerDeduplicate).toBe(false);
    expect(composed.disclosedPayloadColumns).toEqual(["own_notes"]);
    expect(composed.outboundPayloadConsent).toEqual(consent);
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
      outboundPayloadConsent: { status: "pending" },
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

  test("the options block states exactly the file-sync tuning fields", () => {
    const spec = {
      connection: {
        channel: "sftp",
        server: {
          host: "h",
          hostKeyFingerprint: FINGERPRINT,
          password: "@/secret",
        },
        options: {
          peerTimeoutMs: 1,
          serverConnectTimeoutMs: 2,
          maxReconnectAttempts: 3,
          pollIntervalMs: 4,
          timestampInFilename: true,
          locklessRendezvous: true,
          peerId: "site",
          retainFiles: true,
          unexpectedFiles: "warn",
          connectionPerPoll: true,
        },
      },
      linkageTerms: terms(),
    } as unknown as ExchangeSpec;
    const disclosed = disclosedDocument(spec);
    expect(Object.keys(disclosed.options ?? {}).sort()).toEqual(
      [
        "peerTimeoutMs",
        "serverConnectTimeoutMs",
        "maxReconnectAttempts",
        "pollIntervalMs",
        "timestampInFilename",
        "locklessRendezvous",
        "peerId",
        "retainFiles",
        "unexpectedFiles",
        "connectionPerPoll",
      ].sort(),
    );
  });
});
