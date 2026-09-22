import { describe, expect, test } from "vitest";

import { getDefaultLinkageTerms } from "@psilink/core";

import {
  CONNECTION_TUNING_DEFAULT,
  connectionTuningOptions,
} from "@console/connectionTuningModel";
import {
  EXCHANGE_FILES_DEFAULT,
  exchangeFilesOptions,
} from "@console/exchangeFilesModel";
import {
  authoringStateFromDocument,
  connectionTuningFromOptions,
  csvDelimiterFromDocument,
  exchangeFilesFromOptions,
  sftpFormFromServerBlock,
} from "@console/loadedConfig";
import { EMPTY_SFTP_FORM } from "@console/sftpConnectionForm";
import { INITIAL_CSV_DELIMITER_CHOICE } from "@components/csvDelimiterChoice";
import { OWN_COLUMNS_DEFAULT } from "@psi/ownColumnsModel";

import type { DisclosedExchangeDocument } from "@jobs/configLoad";

// The authoring-state half of the mount load: each card's draft read back out of
// a loaded document, and the round trip through the composition it is the inverse
// of. The defaults are asserted against the models' own exported constants, never
// restated here, so a changed default cannot leave a loaded configuration and an
// untouched form starting different runs.

const FINGERPRINT = "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA";

function disclosed(
  overrides: Partial<DisclosedExchangeDocument> = {},
): DisclosedExchangeDocument {
  return {
    channel: "sftp",
    server: { host: "sftp.partner.example", hostKeyFingerprint: FINGERPRINT },
    linkageTerms: getDefaultLinkageTerms("County Health"),
    ...overrides,
  };
}

describe("the connection form a loaded server block seeds", () => {
  test("every field the form edits, the credential left empty", () => {
    const form = sftpFormFromServerBlock({
      host: "sftp.partner.example",
      port: 2222,
      path: "/exchange",
      username: "county",
      hostKeyFingerprint: FINGERPRINT,
      keyboardInteractive: true,
      credentialMethod: "private_key",
    });
    expect(form).toEqual({
      ...EMPTY_SFTP_FORM,
      host: "sftp.partner.example",
      port: "2222",
      username: "county",
      remoteDirectory: "/exchange",
      hostKeyFingerprint: FINGERPRINT,
      method: "private_key",
      keyboardInteractive: true,
    });
    expect(form.source).toBeUndefined();
    expect(form.passphrasePath).toBe("");
  });

  test("a split directory pair fills both directory fields", () => {
    const form = sftpFormFromServerBlock({
      host: "h",
      inboundPath: "/in",
      outboundPath: "/out",
    });
    expect(form.remoteDirectory).toBe("/in");
    expect(form.outboundDirectory).toBe("/out");
  });

  test("a rotation list fills the field with its first entry", () => {
    const second = "SHA256:DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA";
    const form = sftpFormFromServerBlock({
      host: "h",
      hostKeyFingerprint: [FINGERPRINT, second],
    });
    expect(form.hostKeyFingerprint).toBe(FINGERPRINT);
  });

  test("a block stating no credential opens on the password method", () => {
    expect(sftpFormFromServerBlock({ host: "h" }).method).toBe("password");
  });
});

describe("the connection-tuning draft a loaded options block seeds", () => {
  test("an unset key takes the card's own default", () => {
    expect(connectionTuningFromOptions(undefined)).toEqual(
      CONNECTION_TUNING_DEFAULT,
    );
    expect(connectionTuningFromOptions({})).toEqual(CONNECTION_TUNING_DEFAULT);
  });

  test("a duration opens in the coarsest unit it is whole in", () => {
    const draft = connectionTuningFromOptions({
      pollIntervalMs: 120_000,
      peerTimeoutMs: 3_600_000,
      serverConnectTimeoutMs: 1_500,
    });
    expect(draft.pollInterval).toEqual({ magnitude: "2", unit: "m" });
    expect(draft.peerTimeout).toEqual({ magnitude: "1", unit: "h" });
    expect(draft.serverConnectTimeout).toEqual({
      magnitude: "1500",
      unit: "ms",
    });
  });

  test("the round trip through the composition it inverts is the identity", () => {
    const stated = {
      pollIntervalMs: 300_000,
      peerTimeoutMs: 1_800_000,
      serverConnectTimeoutMs: 45_000,
      maxReconnectAttempts: 7,
      connectionPerPoll: true,
    };
    expect(
      connectionTuningOptions(connectionTuningFromOptions(stated)),
    ).toEqual(stated);
  });

  test("a retry budget of zero survives, distinct from an unset one", () => {
    const draft = connectionTuningFromOptions({ maxReconnectAttempts: 0 });
    expect(draft.maxReconnectAttempts).toBe("0");
    expect(connectionTuningOptions(draft)).toEqual({ maxReconnectAttempts: 0 });
  });
});

describe("the file-handling draft a loaded options block seeds", () => {
  test("an unset key takes the card's own default", () => {
    expect(exchangeFilesFromOptions(undefined)).toEqual(EXCHANGE_FILES_DEFAULT);
    expect(exchangeFilesFromOptions({})).toEqual(EXCHANGE_FILES_DEFAULT);
  });

  test("an explicitly-off toggle opens off, not on auto", () => {
    const draft = exchangeFilesFromOptions({ timestampInFilename: false });
    expect(draft.timestampInFilename).toBe("off");
    expect(exchangeFilesFromOptions({}).timestampInFilename).toBe("auto");
  });

  test("the round trip through the composition it inverts is the identity", () => {
    const stated = {
      retainFiles: true,
      timestampInFilename: true,
      locklessRendezvous: true,
      peerId: "county",
      unexpectedFiles: "warn" as const,
    };
    expect(exchangeFilesOptions(exchangeFilesFromOptions(stated))).toEqual(
      stated,
    );
  });
});

describe("the delimiter control a loaded delimiter seeds", () => {
  test("an unset delimiter opens on the control's own starting choice", () => {
    expect(csvDelimiterFromDocument(undefined)).toEqual(
      INITIAL_CSV_DELIMITER_CHOICE,
    );
  });

  test("a named delimiter opens on its option", () => {
    expect(csvDelimiterFromDocument("|")).toEqual({ option: "|", other: "" });
    expect(csvDelimiterFromDocument("\t")).toEqual({
      option: "\t",
      other: "",
    });
  });

  test("a delimiter no option names opens in the free-text field", () => {
    expect(csvDelimiterFromDocument("^")).toEqual({
      option: "other",
      other: "^",
    });
  });
});

describe("the authoring state a loaded document seeds", () => {
  test("a document stating nothing local opens every card on its default", () => {
    const state = authoringStateFromDocument(disclosed());
    expect(state.connectionTuning).toEqual(CONNECTION_TUNING_DEFAULT);
    expect(state.exchangeFiles).toEqual(EXCHANGE_FILES_DEFAULT);
    expect(state.csvDelimiter).toEqual(INITIAL_CSV_DELIMITER_CHOICE);
    expect(state.ownColumns).toBe(OWN_COLUMNS_DEFAULT);
    expect(state.receipts).toEqual({
      mode: "none",
      partnerFingerprint: "",
      retentionDisposition: "",
    });
    expect(state.records).toEqual({});
  });

  test("the receipts card opens on the mode the file states", () => {
    const state = authoringStateFromDocument(
      disclosed({
        signing: { mode: "certificate", partnerFingerprint: "x".repeat(43) },
        retentionDisposition: "Filed with the 2026 intake.",
      }),
    );
    expect(state.receipts).toEqual({
      mode: "certificate",
      partnerFingerprint: "x".repeat(43),
      retentionDisposition: "Filed with the 2026 intake.",
    });
  });

  test("a session-derived mode opens as stated rather than as unsigned", () => {
    // The card offers that mode disabled, so stating it shows what the file
    // names and blocks the run; folding it to "none" would reopen the exchange
    // as one that signs nothing.
    const state = authoringStateFromDocument(
      disclosed({ signing: { mode: "session-derived" } }),
    );
    expect(state.receipts.mode).toBe("session-derived");
  });

  test("the three enforcement records reach the intent fields verbatim", () => {
    const state = authoringStateFromDocument(
      disclosed({
        expectedPayloadColumns: ["partner_notes"],
        expectedPartnerDeduplicate: false,
        disclosedPayloadColumns: [],
      }),
    );
    expect(state.records).toEqual({
      expectedPayloadColumns: ["partner_notes"],
      expectedPartnerDeduplicate: false,
      disclosedPayloadColumns: [],
    });
  });

  test("a filedrop document seeds no connection form", () => {
    const { server: _sftpOnly, ...filedrop } = disclosed();
    const state = authoringStateFromDocument({
      ...filedrop,
      channel: "filedrop",
    });
    expect(state.sftpForm).toBeUndefined();
    expect(state.channel).toBe("filedrop");
  });

  test("the terms, metadata, and standardization are held for the input step", () => {
    const state = authoringStateFromDocument(
      disclosed({
        metadata: [
          {
            name: "first_name",
            role: "linkage",
            type: "first_name",
            isPayload: false,
          },
        ],
        standardization: [],
      }),
    );
    expect(state.linkageTerms.identity).toBe("County Health");
    expect(state.metadata).toHaveLength(1);
    expect(state.standardization).toEqual([]);
  });
});
