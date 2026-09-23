import { describe, expect, test } from "vitest";

import {
  assembleExchangeSpec,
  connectionFromLocator,
  getDefaultLinkageTerms,
} from "@psilink/core";

import {
  configurationOnlyLead,
  fileReferenceExportNote,
  fileReferenceNotice,
  heldSettings,
  heldSettingsNotice,
  pendingOutboundConsentNotice,
  sftpCredentialNote,
} from "@recurring/managedConfigurationModel";
import { buildManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";

import type {
  ExchangeLocator,
  ExchangeSpec,
  SFTPConnectionConfig,
} from "@psilink/core";
import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";

// What a configuration-only exchange's surface tells the operator, derived from
// the stored record alone: why this browser does not run it, naming the channel
// where that is the reason, the settings kept without an editor in the file's
// own snake_case, and a pending outbound payload consent.

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

const locators: Record<ExchangeLocator["channel"], ExchangeLocator> = {
  webrtc: { channel: "webrtc", host: "signaling.example.org" },
  sftp: { channel: "sftp", host: "sftp.example.org", path: "/exchange" },
  filedrop: { channel: "filedrop", path: "/srv/exchange" },
};

/** A configuration-only record on `channel`, holding `document` fields beside
 * the connection and the terms. */
function configuration(
  channel: ExchangeLocator["channel"],
  document: Partial<ExchangeSpec> = {},
): ManagedExchangeRecord {
  return buildManagedExchangeRecord({
    label: "",
    exchangeFile: {
      ...assembleExchangeSpec({
        connection: connectionFromLocator(locators[channel]),
        linkageTerms,
      }),
      ...document,
    },
    ...(channel === "webrtc" ? { side: "acceptor" as const } : {}),
  });
}

describe("why nothing here runs the exchange", () => {
  test.each([
    ["sftp", "SFTP (channel: sftp)"],
    ["filedrop", "a shared folder (channel: filedrop)"],
  ] as const)(
    "a %s configuration names its channel and the app's limit",
    (channel, named) => {
      const lead = configurationOnlyLead(configuration(channel));

      expect(lead).toContain(named);
      expect(lead).toContain("only live exchanges in the browser");
      expect(lead).toContain("run it with psilink on the command line");
    },
  );

  test("a webrtc configuration names the key file, not the channel", () => {
    const lead = configurationOnlyLead(configuration("webrtc"));

    expect(lead).toContain(".psilink.key");
    expect(lead).not.toContain("channel:");
  });
});

describe("the settings held without an editor", () => {
  test("are named in the file's snake_case, never their values", () => {
    const record = configuration("sftp", {
      disclosedPayloadColumns: ["program_code"],
      expectedPartnerDeduplicate: true,
    });

    expect(heldSettings(record)).toEqual([
      "disclosed_payload_columns",
      "expected_partner_deduplicate",
    ]);
    const notice = heldSettingsNotice(record);
    expect(notice).toContain(
      "disclosed_payload_columns, expected_partner_deduplicate",
    );
    expect(notice).not.toContain("program_code");
  });

  test("leave out the three settings the settings editor edits", () => {
    const record = configuration("sftp", {
      includeOwnColumns: "all",
      csvDelimiter: ";",
      retentionDisposition: "Filed with the program office for seven years.",
    });

    expect(heldSettings(record)).toEqual([]);
    expect(heldSettingsNotice(record)).toBeUndefined();
  });

  test("name the connection's options block, which the rows do not show", () => {
    const record = buildManagedExchangeRecord({
      label: "",
      exchangeFile: assembleExchangeSpec({
        connection: connectionFromLocator({
          channel: "filedrop",
          path: "/srv/exchange",
          options: { pollIntervalMs: 5000 },
        }),
        linkageTerms,
      }),
    });

    expect(heldSettings(record)).toEqual(["connection.options"]);
  });

  test("leave nothing to say for a document holding only what is shown", () => {
    expect(heldSettingsNotice(configuration("filedrop"))).toBeUndefined();
  });
});

/** A configuration-only sftp record whose connection states `server` lines
 * and connection lines beyond its locator. */
function sftpConfiguration(
  server: Partial<SFTPConnectionConfig["server"]>,
  connection: Partial<SFTPConnectionConfig> = {},
): ManagedExchangeRecord {
  const base = connectionFromLocator(locators.sftp);
  if (base.channel !== "sftp") throw new Error("not an sftp locator");
  return buildManagedExchangeRecord({
    label: "",
    exchangeFile: assembleExchangeSpec({
      connection: {
        ...base,
        ...connection,
        server: { ...base.server, ...server },
      },
      linkageTerms,
    }),
  });
}

const PIN = `SHA256:${"A".repeat(43)}`;

describe("the SFTP connection settings held without an editor", () => {
  test("are named under connection, never their values", () => {
    const record = sftpConfiguration(
      { privateKey: "@/keys/exchange_key", hostKeyFingerprint: PIN },
      { providerOptions: { readyTimeout: 20000 } },
    );

    expect(heldSettings(record)).toEqual([
      "connection.provider_options",
      "connection.server.host_key_fingerprint",
      "connection.server.private_key",
    ]);
    expect(heldSettingsNotice(record)).not.toContain("@/keys/exchange_key");
  });
});

describe("the settings naming a file by @path", () => {
  test("are warned about by name, and the path is not echoed", () => {
    const record = sftpConfiguration(
      { password: "@/secrets/sftp-password", hostKeyFingerprint: PIN },
      {
        proxy: {
          host: "proxy.example.org",
          auth: { bearer: "@/secrets/proxy.bearer" },
        },
      },
    );
    const notice = fileReferenceNotice(record);
    const exportNote = fileReferenceExportNote(record);

    for (const text of [notice, exportNote]) {
      expect(text).toContain(
        "connection.proxy.auth.bearer, connection.server.password",
      );
      expect(text).not.toContain("@/secrets");
    }
    expect(notice).toContain("This browser does not open them");
    expect(notice).toContain("on the machine that runs the exchange");
  });

  test("a host-key pin read from a file is named too", () => {
    expect(
      fileReferenceNotice(
        sftpConfiguration({
          privateKey: "@/keys/exchange_key",
          hostKeyFingerprint: "@/pins/server",
        }),
      ),
    ).toContain(
      "connection.server.host_key_fingerprint, connection.server.private_key",
    );
  });

  test("leave nothing to say where no setting names a file", () => {
    for (const record of [
      configuration("sftp"),
      configuration("filedrop"),
      configuration("webrtc"),
      sftpConfiguration({ hostKeyFingerprint: PIN }),
    ]) {
      expect(fileReferenceNotice(record)).toBeUndefined();
      expect(fileReferenceExportNote(record)).toBeUndefined();
    }
  });
});

describe("a pending outbound payload consent", () => {
  test("is warned about by the setting's name", () => {
    const notice = pendingOutboundConsentNotice(
      configuration("sftp", { outboundPayloadConsent: { status: "pending" } }),
    );

    expect(notice).toContain("outbound_payload_consent is pending");
    expect(notice).toContain("at a terminal");
  });

  test("a confirmed one, or none, says nothing", () => {
    expect(
      pendingOutboundConsentNotice(
        configuration("sftp", {
          outboundPayloadConsent: { status: "confirmed", columns: [] },
        }),
      ),
    ).toBeUndefined();
    expect(pendingOutboundConsentNotice(configuration("sftp"))).toBeUndefined();
  });
});

describe("the SFTP credential note", () => {
  test("names the lines an SFTP configuration needs before it runs", () => {
    const note = sftpCredentialNote(configuration("sftp"));

    expect(note).toContain("private_key");
    expect(note).toContain("host_key_fingerprint");
  });

  test("names only the host key where the credential is already there", () => {
    const note = sftpCredentialNote(
      sftpConfiguration({ privateKey: "@/keys/exchange_key" }),
    );

    expect(note).toContain("host_key_fingerprint");
    expect(note).not.toContain("private_key");
  });

  test("names only the credential where the host key is already there", () => {
    const note = sftpCredentialNote(
      sftpConfiguration({ hostKeyFingerprint: PIN }),
    );

    expect(note).toContain("private_key or password");
    expect(note).not.toContain("host_key_fingerprint");
  });

  test("says nothing where both are there", () => {
    expect(
      sftpCredentialNote(
        sftpConfiguration({
          password: "@/secrets/sftp-password",
          hostKeyFingerprint: PIN,
        }),
      ),
    ).toBeUndefined();
  });

  test.each(["webrtc", "filedrop"] as const)(
    "a %s configuration has none",
    (channel) => {
      expect(sftpCredentialNote(configuration(channel))).toBeUndefined();
    },
  );
});
