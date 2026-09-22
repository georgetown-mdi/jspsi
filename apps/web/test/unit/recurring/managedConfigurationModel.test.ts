import { describe, expect, test } from "vitest";

import {
  assembleExchangeSpec,
  connectionFromLocator,
  getDefaultLinkageTerms,
} from "@psilink/core";

import {
  configurationOnlyLead,
  heldSettings,
  heldSettingsNotice,
  pendingOutboundConsentNotice,
  sftpCredentialNote,
} from "@recurring/managedConfigurationModel";
import { buildManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";

import type { ExchangeLocator, ExchangeSpec } from "@psilink/core";
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
    const disposition = "Filed with the program office for seven years.";
    const record = configuration("sftp", {
      retentionDisposition: disposition,
      csvDelimiter: ";",
    });

    expect(heldSettings(record)).toEqual([
      "csv_delimiter",
      "retention_disposition",
    ]);
    const notice = heldSettingsNotice(record);
    expect(notice).toContain("csv_delimiter, retention_disposition");
    expect(notice).not.toContain(disposition);
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

  test.each(["webrtc", "filedrop"] as const)(
    "a %s configuration has none",
    (channel) => {
      expect(sftpCredentialNote(configuration(channel))).toBeUndefined();
    },
  );
});
