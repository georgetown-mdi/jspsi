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

import {
  csvDelimiterFromDocument,
  editorWithLoadedTerms,
} from "@console/loadedConfig";
import { editorFromCsv, editorWithIncludeOwnColumns } from "@psi/inviterEditor";
import { EMPTY_SFTP_FORM } from "@console/sftpConnectionForm";
import { mountedConfigurationNotices } from "@console/mountedConfiguration";
import { resolveCsvDelimiter } from "@components/csvDelimiterChoice";

import {
  INVITER_SCREEN_INITIAL,
  inviterScreenReducer,
} from "@exchange/inviterScreenModel";

import { composeSftpConfigSpec } from "@jobs/intentConfig";
import { intentFor } from "@psi/jobClient/serverJobExchangeDriver";
import { inviterServerJobConfig } from "@exchange/useInviterExchange";

import { testSftpServerEntry } from "../../utils/jobFixtures";

import type { AcquiredCsv } from "@psi/inviterEditor";
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
function sftpDocument(
  overrides: Partial<DisclosedExchangeDocument> = {},
): DisclosedExchangeDocument {
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
    ...overrides,
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

  test("the terms, own-column choice and transport wait for the file step", () => {
    expect(state.pendingLoadedTerms).toEqual({
      linkageTerms: sftpDocument().linkageTerms,
      ownColumns: "all",
      transport: "sftp",
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

// The four records whose absence turns an enforcement off. The console has no
// control for any of them, so an opened document's values ride the authoring
// state into the intent the run submits, and the configuration composed for that
// run states each one as the file did.
describe("the records the console cannot edit reach the run unchanged", () => {
  const records = {
    expectedPayloadColumns: ["partner_program"],
    expectedPartnerDeduplicate: false,
    disclosedPayloadColumns: ["program_code"],
    outboundPayloadConsent: {
      status: "confirmed" as const,
      columns: ["program_code"],
    },
  };

  /** The intent a document stating all three submits when it is opened and
   * started with nothing touched. */
  function intentFromUntouchedLoad() {
    const state = loadedInto(INVITER_SCREEN_INITIAL, sftpDocument(records));
    return intentFor(
      inviterServerJobConfig({
        minted: {
          linkageTerms: getDefaultLinkageTerms("County Health"),
          sharedSecret: "a".repeat(43),
        },
        inputSource: { kind: "workFile", name: "cohort.csv" },
        transport: { channel: "sftp" },
        loadedEnforcementRecords: state.loadedEnforcementRecords,
      }),
    );
  }

  test("the intent states all four with the file's values", () => {
    expect(intentFromUntouchedLoad()).toMatchObject(records);
  });

  test("the composed configuration states all four", () => {
    const intent = intentFromUntouchedLoad();
    if (intent.channel !== "sftp") throw new Error("expected an sftp intent");
    const spec = composeSftpConfigSpec(intent, testSftpServerEntry());
    expect(spec.expectedPayloadColumns).toEqual(records.expectedPayloadColumns);
    expect(spec.expectedPartnerDeduplicate).toBe(false);
    expect(spec.disclosedPayloadColumns).toEqual(
      records.disclosedPayloadColumns,
    );
    // The consent record the file confirmed, composed verbatim: the run is held
    // to the set this party already confirmed rather than consenting afresh.
    expect(spec.outboundPayloadConsent).toEqual(records.outboundPayloadConsent);
  });

  test("the notice beside the load names each one", () => {
    const state = loadedInto(INVITER_SCREEN_INITIAL, sftpDocument(records));
    const notices = mountedConfigurationNotices(state.mountedConfiguration);
    expect(notices).toHaveLength(1);
    for (const field of [
      "expected_payload_columns",
      "expected_partner_deduplicate",
      "disclosed_payload_columns",
      "outbound_payload_consent",
    ])
      expect(notices[0]).toContain(field);
  });
});

// The file step reads a file, and the held terms go into the editor against the
// operator's own columns -- the screen's own sequence, as a value: the transport
// the file's channel names selects the review step's tab, and the document's own
// column roles and cleaning replace what the CSV headers alone would infer.
describe("a loaded configuration reaches the editor once a file is read", () => {
  const columns = [
    "client_id",
    "first_name",
    "last_name",
    "dob",
    "program_code",
  ];

  function acquired(): AcquiredCsv {
    return {
      fileName: "clients.csv",
      sizeBytes: 4096,
      rawRows: [
        {
          client_id: "17",
          first_name: "Alice",
          last_name: "Smith",
          dob: "1990-01-02",
          program_code: "A7",
        },
      ],
      columns,
      rowCount: 1,
    };
  }

  /** The screen's own application of the held terms: the import rebuilds the
   * draft against the read file, and the reducer books what it could not
   * apply. */
  function withFileRead(state: InviterScreenState): InviterScreenState {
    const held = state.pendingLoadedTerms;
    if (held === undefined) throw new Error("expected held terms");
    const csv = acquired();
    const applied = editorWithLoadedTerms(
      editorWithIncludeOwnColumns(
        editorFromCsv("County Health", csv),
        held.ownColumns,
      ),
      csv,
      held,
    );
    return inviterScreenReducer(state, {
      type: "loaded-terms-applied",
      editor: applied.editor,
      notApplied: applied.notApplied,
    });
  }

  function columnRole(state: InviterScreenState, name: string) {
    return state.editor?.draft.metadata.find((column) => column.name === name);
  }

  test("an sftp document selects the SFTP transport, not the console default", () => {
    // Nothing is authored on this console and no rendezvous is mounted, so the
    // chooser's own default is the unconfigured SFTP card -- and the loaded
    // channel, not that default, is what the transport reads.
    const applied = withFileRead(
      loadedInto(INVITER_SCREEN_INITIAL, sftpDocument()),
    );
    expect(applied.editor?.transport).toBe("sftp");
  });

  test("a shared-folder document selects filedrop where the mount is there", () => {
    const mounted = inviterScreenReducer(INVITER_SCREEN_INITIAL, {
      type: "console-rendezvous-resolved",
      config: { configured: true },
    });
    const applied = withFileRead(
      loadedInto(mounted, {
        channel: "filedrop",
        linkageTerms: getDefaultLinkageTerms("County Health"),
      }),
    );
    expect(applied.editor?.transport).toBe("filedrop");
  });

  test("a channel this console cannot run selects nothing and says so", () => {
    const loaded = loadedInto(INVITER_SCREEN_INITIAL, {
      channel: "filedrop",
      linkageTerms: getDefaultLinkageTerms("County Health"),
    });
    expect(loaded.pendingLoadedTerms?.transport).toBeUndefined();
    const notices = mountedConfigurationNotices(loaded.mountedConfiguration);
    expect(notices.some((notice) => notice.includes("shared directory"))).toBe(
      true,
    );
    expect(withFileRead(loaded).editor?.transport).toBeUndefined();
  });

  test("the document's column roles replace what the headers infer", () => {
    // program_code infers as a disclosed payload column; the file states it as
    // one this party keeps to itself, and the editor opens on what the file
    // states.
    const applied = withFileRead(
      loadedInto(
        INVITER_SCREEN_INITIAL,
        sftpDocument({
          metadata: [
            {
              name: "program_code",
              type: "other",
              role: "ignored",
              isPayload: false,
            },
          ],
        }),
      ),
    );
    expect(columnRole(applied, "program_code")).toMatchObject({
      role: "ignored",
      isPayload: false,
    });
    expect(columnRole(applied, "first_name")?.role).toBe("linkage");
    expect(mountedConfigurationNotices(applied.mountedConfiguration)).toEqual(
      [],
    );
  });

  test("the document's cleaning steps replace the recommended pipeline", () => {
    const steps = [{ function: "trim_whitespace" }];
    const applied = withFileRead(
      loadedInto(
        INVITER_SCREEN_INITIAL,
        sftpDocument({
          standardization: [
            { output: "first_name", input: "first_name", steps },
          ],
        }),
      ),
    );
    const cleaned = applied.editor?.draft.standardization.find(
      (transformation) => transformation.output === "first_name",
    );
    expect(cleaned?.input).toBe("first_name");
    expect(cleaned?.steps).toEqual(steps);
  });

  test("what this file cannot supply is named beside the load, not dropped", () => {
    const applied = withFileRead(
      loadedInto(
        INVITER_SCREEN_INITIAL,
        sftpDocument({
          metadata: [
            {
              name: "household_id",
              type: "other",
              role: "ignored",
              isPayload: false,
            },
          ],
          standardization: [
            { output: "first_name", input: "household_id", steps: [] },
          ],
        }),
      ),
    );
    const notice = mountedConfigurationNotices(
      applied.mountedConfiguration,
    ).find((text) => text.includes("cannot supply"));
    expect(notice).toContain("metadata, standardization");
    expect(columnRole(applied, "household_id")).toBeUndefined();
  });
});
