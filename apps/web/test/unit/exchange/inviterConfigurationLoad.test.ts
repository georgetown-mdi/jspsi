import { describe, expect, test } from "vitest";

import { getDefaultLinkageTerms } from "@psilink/core";

import {
  CONFIG_EXCHANGE_FILES,
  EXCHANGE_FILES_DEFAULT,
  exchangeFilesOptions,
} from "@console/exchangeFilesModel";
import {
  CONNECTION_TUNING_DEFAULT,
  SFTP_CONNECTION_TUNING,
  withConnectionTuning,
} from "@console/connectionTuningModel";
import { RECEIPTS_DEFAULT, receiptsIntentFields } from "@psi/receiptsModel";

import { EMPTY_SFTP_FORM } from "@console/sftpConnectionForm";
import { csvDelimiterFromDocument } from "@console/loadedConfig";
import { resolveCsvDelimiter } from "@components/csvDelimiterChoice";

import {
  INVITER_SCREEN_INITIAL,
  inviterScreenReducer,
} from "@exchange/inviterScreenModel";

import { inviterServerJobConfig } from "@exchange/useInviterExchange";

import type { DisclosedExchangeDocument } from "@jobs/configLoad";
import type { InviterScreenState } from "@exchange/inviterScreenModel";
import type { MountedConfigurationAnswer } from "@psi/jobClient/mountedConfigClient";
import type { ServerJobExchangeTransport } from "@psi/jobClient/serverJobExchangeDriver";

// Opening a mounted configuration into the inviter console: which authoring step
// each block of the document fills, that a setting the file omits keeps the
// model's own default, and that a run started from a loaded configuration
// composes the same driver config a hand-authored one does. The defaults are
// asserted against the models' exported constants rather than restated here.

const FINGERPRINT = "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA";
const PARTNER_FINGERPRINT = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA";

/** A `psilink invite --save` sftp document: a host and pin, both cards' tuning,
 * a non-default delimiter, own columns, a signed receipt and a retention note. */
function sftpDocument(): DisclosedExchangeDocument {
  return {
    channel: "sftp",
    server: {
      host: "sftp.partner.example",
      port: 2222,
      path: "/exchange",
      username: "county",
      hostKeyFingerprint: FINGERPRINT,
      keyboardInteractive: true,
      credentialMethod: "private_key",
    },
    options: {
      pollIntervalMs: 120_000,
      peerTimeoutMs: 3_600_000,
      maxReconnectAttempts: 7,
      connectionPerPoll: true,
      retainFiles: true,
      timestampInFilename: true,
      locklessRendezvous: true,
      peerId: "county",
      unexpectedFiles: "warn",
    },
    linkageTerms: getDefaultLinkageTerms("County Health"),
    includeOwnColumns: "all",
    csvDelimiter: "|",
    retentionDisposition: "Filed with the 2026 cohort, kept seven years.",
    signing: { mode: "certificate", partnerFingerprint: PARTNER_FINGERPRINT },
  };
}

function loadedInto(
  state: InviterScreenState,
  document: DisclosedExchangeDocument,
  carriedThrough: Array<string> = [],
  warnings: Array<string> = [],
): InviterScreenState {
  const answer: MountedConfigurationAnswer = {
    kind: "opened",
    document,
    carriedThrough,
    warnings,
  };
  return inviterScreenReducer(state, {
    type: "mounted-configuration-read",
    answer,
  });
}

describe("every step the document covers is filled in", () => {
  const state = loadedInto(INVITER_SCREEN_INITIAL, sftpDocument());

  test("the connection step opens on the file's host, pin, and method", () => {
    expect(state.loadedSftpForm).toEqual({
      ...EMPTY_SFTP_FORM,
      host: "sftp.partner.example",
      port: "2222",
      username: "county",
      remoteDirectory: "/exchange",
      hostKeyFingerprint: FINGERPRINT,
      method: "private_key",
      keyboardInteractive: true,
    });
  });

  test("connection tuning reads the durations in their coarsest unit", () => {
    expect(state.connectionTuning).toEqual({
      ...CONNECTION_TUNING_DEFAULT,
      pollInterval: { magnitude: "2", unit: "m" },
      peerTimeout: { magnitude: "1", unit: "h" },
      maxReconnectAttempts: "7",
      connectionPerPoll: true,
    });
  });

  test("file handling reads retain mode and the toggles that travel with it", () => {
    expect(state.exchangeFiles).toEqual({
      retainFiles: true,
      timestampInFilename: "on",
      locklessRendezvous: "on",
      peerId: "county",
      unexpectedFiles: "warn",
    });
  });

  test("receipts read the signing mode, the pin, and the retention note", () => {
    expect(state.receipts).toEqual({
      ...RECEIPTS_DEFAULT,
      mode: "certificate",
      partnerFingerprint: PARTNER_FINGERPRINT,
      retentionDisposition: "Filed with the 2026 cohort, kept seven years.",
    });
  });

  test("the delimiter control opens on the character the file states", () => {
    const choice = csvDelimiterFromDocument(sftpDocument().csvDelimiter);
    const resolved = resolveCsvDelimiter(choice);
    expect(resolved.ok && resolved.delimiter).toBe("|");
  });

  test("the terms and own-column choice wait for the file step", () => {
    expect(state.pendingLoadedTerms).toEqual({
      linkageTerms: sftpDocument().linkageTerms,
      ownColumns: "all",
    });
  });

  test("the notices beside the control report both lists", () => {
    const withLists = loadedInto(
      INVITER_SCREEN_INITIAL,
      sftpDocument(),
      ["signing.receipt_output"],
      ["connection.server.private_key"],
    );
    expect(withLists.mountedConfiguration).toEqual({
      status: "opened",
      carriedThrough: ["signing.receipt_output"],
      warnings: ["connection.server.private_key"],
    });
  });
});

describe("a shared-folder configuration", () => {
  const document: DisclosedExchangeDocument = {
    channel: "filedrop",
    options: { retainFiles: true },
    linkageTerms: getDefaultLinkageTerms("County Health"),
  };
  const state = loadedInto(INVITER_SCREEN_INITIAL, document);

  test("names no host, so the connection step keeps its empty form", () => {
    expect(state.loadedSftpForm).toBeUndefined();
  });

  test("still fills the file-handling step", () => {
    // Retain mode as the file states it; the two toggles it implies stay unset,
    // so the card leaves their keys off and core applies its own.
    expect(state.exchangeFiles).toEqual({
      ...EXCHANGE_FILES_DEFAULT,
      retainFiles: true,
    });
  });
});

describe("a setting the file omits keeps the authoring default", () => {
  const state = loadedInto(INVITER_SCREEN_INITIAL, {
    channel: "sftp",
    server: { host: "sftp.partner.example" },
    linkageTerms: getDefaultLinkageTerms("County Health"),
  });

  test("both option cards start where a fresh console starts them", () => {
    expect(state.connectionTuning).toEqual(CONNECTION_TUNING_DEFAULT);
    expect(state.exchangeFiles).toEqual(EXCHANGE_FILES_DEFAULT);
  });

  test("receipts stay at no receipt and no note", () => {
    expect(state.receipts).toEqual(RECEIPTS_DEFAULT);
  });

  test("the own-column choice held for the file step is the model's own", () => {
    expect(state.pendingLoadedTerms?.ownColumns).toBe("none");
  });
});

describe("a load that does not proceed changes no step", () => {
  test.each([
    ["a refusal", { kind: "refused", error: "runs over webrtc" }],
    ["an absent mount", { kind: "absent" }],
    ["a read that did not answer", { kind: "unavailable" }],
  ] as ReadonlyArray<[string, MountedConfigurationAnswer]>)(
    "%s leaves every card untouched",
    (_name, answer) => {
      const state = inviterScreenReducer(INVITER_SCREEN_INITIAL, {
        type: "mounted-configuration-read",
        answer,
      });
      expect(state.connectionTuning).toBe(
        INVITER_SCREEN_INITIAL.connectionTuning,
      );
      expect(state.exchangeFiles).toBe(INVITER_SCREEN_INITIAL.exchangeFiles);
      expect(state.receipts).toBe(INVITER_SCREEN_INITIAL.receipts);
      expect(state.loadedSftpForm).toBeUndefined();
      expect(state.pendingLoadedTerms).toBeUndefined();
    },
  );

  test("a webrtc refusal reaches the control as a channel refusal", () => {
    const error =
      "This configuration runs over webrtc. The console conducts sftp and " +
      "shared-folder exchanges only, so it cannot open this one.";
    const state = inviterScreenReducer(INVITER_SCREEN_INITIAL, {
      type: "mounted-configuration-read",
      answer: { kind: "refused", error },
    });
    expect(state.mountedConfiguration).toEqual({ status: "refused", error });
  });
});

describe("the held terms are released once they are applied", () => {
  test("applying them clears the hold and announces the import", () => {
    const loaded = loadedInto(INVITER_SCREEN_INITIAL, sftpDocument());
    const editor = { sealed: false } as never;
    const applied = inviterScreenReducer(loaded, {
      type: "loaded-terms-applied",
      editor,
    });
    expect(applied.pendingLoadedTerms).toBeUndefined();
    expect(applied.editor).toBe(editor);
    expect(applied.editorAnnouncement).toMatch(/matching terms/);
  });
});

// A loaded configuration reaches the run through the console's own composition
// and nothing else: it fills the same drafts the cards fill, and the run reads
// those drafts. `inviterServerJobConfig` is the exported boundary the intent is
// built from (`intentFor` is a pure mapping of it), so equality here is equality
// of the intent the run POSTs -- and with it the same preflight, warnings, and
// refusals.
describe("a run started from a loaded configuration composes what a hand-authored one does", () => {
  const transport: ServerJobExchangeTransport = { channel: "sftp" };

  function driverConfigFor(state: InviterScreenState) {
    const choice = csvDelimiterFromDocument(sftpDocument().csvDelimiter);
    const resolved = resolveCsvDelimiter(choice);
    const options = withConnectionTuning(
      exchangeFilesOptions(state.exchangeFiles, CONFIG_EXCHANGE_FILES),
      state.connectionTuning,
      SFTP_CONNECTION_TUNING,
    );
    return inviterServerJobConfig({
      minted: {
        linkageTerms: getDefaultLinkageTerms("County Health"),
        sharedSecret: "a".repeat(43),
        includeOwnColumns: "all",
      },
      inputSource: { kind: "workFile", name: "cohort.csv" },
      transport,
      ...(resolved.ok ? { csvDelimiter: resolved.delimiter } : {}),
      ...(options !== undefined ? { options } : {}),
      receipts: receiptsIntentFields(state.receipts),
    });
  }

  test("the same values, loaded or typed, compose the same config", () => {
    const loaded = loadedInto(INVITER_SCREEN_INITIAL, sftpDocument());
    let authored = inviterScreenReducer(INVITER_SCREEN_INITIAL, {
      type: "connection-tuning-chosen",
      draft: {
        ...CONNECTION_TUNING_DEFAULT,
        pollInterval: { magnitude: "2", unit: "m" },
        peerTimeout: { magnitude: "1", unit: "h" },
        maxReconnectAttempts: "7",
        connectionPerPoll: true,
      },
    });
    authored = inviterScreenReducer(authored, {
      type: "exchange-files-chosen",
      draft: {
        retainFiles: true,
        timestampInFilename: "on",
        locklessRendezvous: "on",
        peerId: "county",
        unexpectedFiles: "warn",
      },
    });
    authored = inviterScreenReducer(authored, {
      type: "receipts-chosen",
      draft: {
        ...RECEIPTS_DEFAULT,
        mode: "certificate",
        partnerFingerprint: PARTNER_FINGERPRINT,
        retentionDisposition: "Filed with the 2026 cohort, kept seven years.",
      },
    });
    expect(driverConfigFor(loaded)).toEqual(driverConfigFor(authored));
  });
});
