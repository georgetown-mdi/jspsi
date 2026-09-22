import { describe, expect, test } from "vitest";

import {
  disclosedColumnNames,
  getDefaultLinkageTerms,
  inferMetadata,
} from "@psilink/core";

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
  CONFIGURATION_LOAD_SEALED,
  MOUNTED_CONFIGURATION_UNREAD,
  PENDING_OUTBOUND_CONSENT_WARNING,
  mountedConfigurationNotices,
  mountedConfigurationOfferable,
} from "@console/mountedConfiguration";
import {
  INITIAL_CSV_DELIMITER_CHOICE,
  resolveCsvDelimiter,
} from "@components/csvDelimiterChoice";
import {
  csvDelimiterFromDocument,
  editorWithLoadedTerms,
} from "@console/loadedConfig";
import {
  editorFromCsv,
  editorWithIncludeOwnColumns,
  editorWithOutputDirection,
} from "@psi/inviterEditor";
import { EMPTY_SFTP_FORM } from "@console/sftpConnectionForm";
import { outputForDirection } from "@psi/authoring/advancedInvite";

import {
  INVITER_SCREEN_INITIAL,
  inviterScreenReducer,
} from "@exchange/inviterScreenModel";

import { composeSftpConfigSpec } from "@jobs/intentConfig";
import { intentFor } from "@psi/jobClient/serverJobExchangeDriver";
import { inviterServerJobConfig } from "@exchange/useInviterExchange";
import { jobCreateIntentSchema } from "@jobs/intentSchemas";

import { testSftpServerEntry } from "../../utils/jobFixtures";

import type { ColumnMetadata, Metadata } from "@psilink/core";
import type {
  JobInputSource,
  ServerJobExchangeTransport,
} from "@psi/jobClient/serverJobExchangeDriver";
import type { AcquiredCsv } from "@psi/inviterEditor";
import type { DisclosedExchangeDocument } from "@jobs/configLoad";
import type { InviterScreenState } from "@exchange/inviterScreenModel";
import type { MountedConfigurationAnswer } from "@psi/jobClient/mountedConfigClient";
import type { OutputDirection } from "@psi/authoring/advancedInvite";
import type { ProfiledJobInput } from "@psi/jobClient/workInputClient";

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

const COLUMNS = ["client_id", "first_name", "last_name", "dob", "program_code"];

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
    columns: COLUMNS,
    rowCount: 1,
  };
}

function profileOf(csv: AcquiredCsv): ProfiledJobInput {
  return {
    name: csv.fileName,
    sizeBytes: csv.sizeBytes,
    modifiedAt: 1_700_000_000_000,
    rowCount: csv.rowCount,
    columns: csv.columns,
    sanitizedColumnPositions: [],
    columnSamples: new Map(),
  };
}

/** The console's commit of a mounted input file: the draft is seeded from the
 * file's own headers, as it is for a console with no configuration open. */
function withFileCommitted(
  state: InviterScreenState,
  csv: AcquiredCsv,
): InviterScreenState {
  return inviterScreenReducer(state, {
    type: "console-file-seeded",
    source: profileOf(csv),
    acquired: csv,
    editor: editorFromCsv("County Health", csv),
  });
}

/** The screen's derivation of the draft from the open configuration and the
 * committed file: the import rebuilds each binding against that file's own
 * columns, and the reducer books what it could not apply. Runs at every commit
 * the configuration is open for, and is a no-op over a file it already
 * reached. */
function withLoadedTermsDerived(state: InviterScreenState): InviterScreenState {
  const open = state.loadedConfiguration;
  const csv = state.acquired;
  if (open === undefined || csv === undefined || state.editor === undefined)
    throw new Error("expected an open configuration over a committed file");
  if (state.loadedTermsFile === csv) return state;
  const applied = editorWithLoadedTerms(
    editorWithIncludeOwnColumns(state.editor, open.ownColumns),
    csv,
    open,
  );
  return inviterScreenReducer(state, {
    type: "loaded-terms-applied",
    file: csv,
    editor: applied.editor,
    notApplied: applied.notApplied,
    notCovered: applied.notCovered,
  });
}

/** A file committed with the open configuration's terms derived over it, the
 * pair the screen runs for every file while a configuration is open. */
function withFileRead(
  state: InviterScreenState,
  csv: AcquiredCsv = acquired(),
): InviterScreenState {
  return withLoadedTermsDerived(withFileCommitted(state, csv));
}

/** The inference over this file's headers as a configuration states it: the
 * record identifier held back, the pair `role: identifier` takes in the columns
 * step. Inference itself states that column as sent beside the identifier role
 * ({@link inferMetadata}), the one pair the step cannot hold, which the
 * off-diagonal cases below drive on its own. */
function documentColumns(columns: Array<string> = COLUMNS): Metadata {
  return inferMetadata(columns, []).map((column) =>
    column.role === "identifier" ? { ...column, isPayload: false } : column,
  );
}

/** A document's own `metadata`: every column this file has, with `program_code`
 * stated as one this party keeps to itself where inference would send it. */
function statedColumns(): Metadata {
  return documentColumns().map((column) =>
    column.name === "program_code"
      ? { ...column, role: "ignored" as const, isPayload: false }
      : column,
  );
}

/** The same document stating four of the file's five columns: `program_code`,
 * the one column inference sends to the partner, goes unnamed. */
function fourOfFiveColumns(): Metadata {
  return documentColumns(COLUMNS.slice(0, 4));
}

function columnRole(state: InviterScreenState, name: string) {
  return state.editor?.draft.metadata.find((column) => column.name === name);
}

/** The notices the load control shows for a screen state, read the way the
 * screen reads them: beside the state, the columns the draft would send to the
 * partner and the records the open configuration holds. */
function noticesOf(state: InviterScreenState): Array<string> {
  return mountedConfigurationNotices(
    state.mountedConfiguration,
    state.editor === undefined
      ? undefined
      : {
          disclosedColumns: disclosedColumnNames(state.editor.draft.metadata),
          sharesWithPartner: outputForDirection(
            state.editor.draft.outputDirection,
          ).shareWithPartner,
          records: state.loadedEnforcementRecords,
        },
  );
}

/** The screen with the matched results going where this direction sends them,
 * the choice the review step makes. */
function withOutputDirection(
  state: InviterScreenState,
  direction: OutputDirection,
): InviterScreenState {
  if (state.editor === undefined) throw new Error("expected a seated editor");
  return inviterScreenReducer(state, {
    type: "editor-applied",
    editor: editorWithOutputDirection(state.editor, direction),
  });
}

/** Whether the load control warns that a run started here is refused for a
 * commitment the run's own disclosed set no longer matches. */
function refusalWarned(state: InviterScreenState): boolean {
  return noticesOf(state).some((text) =>
    text.includes("a run started here is refused"),
  );
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

  test("the terms, own-column choice and transport are held while it is open", () => {
    expect(state.loadedConfiguration).toEqual({
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
    expect(state.loadedConfiguration?.ownColumns).toBe("none");
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
      expect(state.loadedConfiguration).toBeUndefined();
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

// The open configuration is an input to the screen until the operator closes
// it, and the draft is derived from it and whichever file the file step holds.
// A file replaced, or voided by the delimiter change a load itself triggers,
// therefore takes the document's terms again rather than the headers' own
// inference -- the reading that decides what leaves the machine.
describe("the open configuration holds across the files it is derived over", () => {
  const ignoredProgramCode: DisclosedExchangeDocument["metadata"] = [
    { name: "program_code", type: "other", role: "ignored", isPayload: false },
  ];

  test("applying the terms announces the import and books the file", () => {
    const applied = withFileRead(
      loadedInto(INVITER_SCREEN_INITIAL, sftpDocument()),
    );
    expect(applied.loadedConfiguration).toBeDefined();
    expect(applied.loadedTermsFile).toBe(applied.acquired);
    expect(applied.editorAnnouncement).toMatch(/matching terms/);
  });

  test("a voided file and the next one keep the document's own roles", () => {
    // program_code infers as a disclosed payload column, and the file states it
    // as one this party keeps to itself.
    const opened = loadedInto(
      INVITER_SCREEN_INITIAL,
      sftpDocument({ metadata: ignoredProgramCode }),
    );
    const voided = inviterScreenReducer(withFileRead(opened), {
      type: "console-file-voided",
    });
    const again = withFileRead(voided);
    expect(columnRole(again, "program_code")).toMatchObject({
      role: "ignored",
      isPayload: false,
    });
    expect(again.mountedConfiguration.status).toBe("opened");
  });

  test("a re-profile of the same file keeps the terms in force over it", () => {
    // The authored draft stands through a re-profile, so the terms it already
    // holds stand with it and nothing is derived a second time.
    const applied = withFileRead(
      loadedInto(
        INVITER_SCREEN_INITIAL,
        sftpDocument({ metadata: ignoredProgramCode }),
      ),
    );
    const editor = applied.editor;
    if (editor === undefined) throw new Error("expected a draft");
    const csv = acquired();
    const reprofiled = inviterScreenReducer(applied, {
      type: "console-file-reprofiled",
      source: profileOf(csv),
      acquired: csv,
      editor,
      announcement: "Re-profiled with the file's current contents",
    });
    expect(reprofiled.loadedTermsFile).toBe(csv);
    expect(columnRole(reprofiled, "program_code")).toMatchObject({
      role: "ignored",
    });
  });

  test("a draft rebuilt over a file the step no longer holds is not seated", () => {
    const opened = loadedInto(INVITER_SCREEN_INITIAL, sftpDocument());
    const committed = withFileCommitted(opened, acquired());
    const voided = inviterScreenReducer(committed, {
      type: "console-file-voided",
    });
    const late = inviterScreenReducer(voided, {
      type: "loaded-terms-applied",
      file: committed.acquired as AcquiredCsv,
      editor: { sealed: false } as never,
    });
    expect(late).toBe(voided);
    expect(late.editor).toBeUndefined();
  });

  test("closing it leaves the file's own inference and no records", () => {
    const records = { disclosedPayloadColumns: ["program_code"] };
    const applied = withFileRead(
      loadedInto(
        INVITER_SCREEN_INITIAL,
        sftpDocument({ ...records, metadata: ignoredProgramCode }),
      ),
    );
    const csv = applied.acquired as AcquiredCsv;
    const closed = inviterScreenReducer(applied, {
      type: "loaded-configuration-discarded",
      editor: editorFromCsv("County Health", csv),
    });
    expect(columnRole(closed, "program_code")).toMatchObject({
      role: "payload",
      isPayload: true,
    });
    expect(closed.loadedConfiguration).toBeUndefined();
    expect(closed.loadedSftpForm).toBeUndefined();
    expect(closed.loadedEnforcementRecords).toEqual({});
    expect(noticesOf(closed)).toEqual([]);
    expect(
      intentFor(
        inviterServerJobConfig({
          minted: {
            linkageTerms: getDefaultLinkageTerms("County Health"),
            sharedSecret: "a".repeat(43),
          },
          inputSource: { kind: "workFile", name: "cohort.csv" },
          transport: { channel: "sftp" },
          loadedEnforcementRecords: closed.loadedEnforcementRecords,
        }),
      ).disclosedPayloadColumns,
    ).toBeUndefined();
  });
});

// An invitation minted from other terms seals the draft the load would fill, so
// the load has nothing it can do: the control is withheld and the read changes
// nothing.
describe("a sealed draft takes no configuration", () => {
  const sealed: InviterScreenState = {
    ...INVITER_SCREEN_INITIAL,
    editor: { sealed: true } as never,
  };

  test("the read leaves every step where the mint left it", () => {
    const state = inviterScreenReducer(sealed, {
      type: "mounted-configuration-read",
      answer: {
        kind: "opened",
        document: sftpDocument(),
        carriedThrough: [],
        warnings: [],
      },
    });
    expect(state).toBe(sealed);
    expect(state.loadedConfiguration).toBeUndefined();
    expect(state.loadedEnforcementRecords).toEqual({});
    expect(state.loadedSftpForm).toBeUndefined();
  });

  test("a close landing after the mint keeps the records on the run", () => {
    // The records are what put the disclosure commitment back on the intent,
    // so dropping them after the mint would compose a run with nothing left
    // for core to enforce.
    const open = loadedInto(
      INVITER_SCREEN_INITIAL,
      sftpDocument({ disclosedPayloadColumns: ["program_code"] }),
    );
    const minted: InviterScreenState = {
      ...open,
      editor: { sealed: true } as never,
    };
    const closed = inviterScreenReducer(minted, {
      type: "loaded-configuration-discarded",
    });
    expect(closed).toBe(minted);
    expect(closed.loadedEnforcementRecords).toEqual({
      disclosedPayloadColumns: ["program_code"],
    });
    expect(closed.loadedConfiguration).toBeDefined();
  });

  test("the control is withheld, naming where a configuration can be opened", () => {
    expect(
      mountedConfigurationOfferable(MOUNTED_CONFIGURATION_UNREAD, true),
    ).toBe(false);
    expect(
      mountedConfigurationOfferable(MOUNTED_CONFIGURATION_UNREAD, false),
    ).toBe(true);
    expect(CONFIGURATION_LOAD_SEALED).toContain("new exchange");
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

  function driverConfigFor(
    state: InviterScreenState,
    inputSource: JobInputSource = { kind: "workFile", name: "cohort.csv" },
  ) {
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
      inputSource,
      transport,
      ...(resolved.ok ? { csvDelimiter: resolved.delimiter } : {}),
      ...(options !== undefined ? { options } : {}),
      receipts: receiptsIntentFields(state.receipts),
    });
  }

  /** The same settings typed into the cards by hand, so the two starting points
   * differ in nothing but how the values got there. */
  function authoredState(): InviterScreenState {
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
    return inviterScreenReducer(authored, {
      type: "receipts-chosen",
      draft: {
        ...RECEIPTS_DEFAULT,
        mode: "certificate",
        partnerFingerprint: PARTNER_FINGERPRINT,
        retentionDisposition: "Filed with the 2026 cohort, kept seven years.",
      },
    });
  }

  test("the same values, loaded or typed, compose the same config", () => {
    const loaded = loadedInto(INVITER_SCREEN_INITIAL, sftpDocument());
    expect(driverConfigFor(loaded)).toEqual(driverConfigFor(authoredState()));
  });

  // The create route parses the posted intent before anything runs, so a run
  // started over an input file the operator has since voided is refused there.
  // Driving that refusal from both starting points measures what the equality
  // above implies: the same run, and so the same refusal.
  test("a voided input file refuses the run the same way from either", () => {
    function refusalFor(state: InviterScreenState): Array<string> {
      const parsed = jobCreateIntentSchema.safeParse(
        intentFor(driverConfigFor(state, { kind: "workFile", name: "" })),
      );
      if (parsed.success) throw new Error("the create was expected to refuse");
      return parsed.error.issues.map((issue) => issue.message).sort();
    }
    const loaded = refusalFor(
      loadedInto(INVITER_SCREEN_INITIAL, sftpDocument()),
    );
    expect(loaded).toContain(
      "inputFile.name must be a single admissible path segment",
    );
    expect(loaded).toEqual(refusalFor(authoredState()));
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
    const notices = noticesOf(state);
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
    expect(loaded.loadedConfiguration?.transport).toBeUndefined();
    const notices = noticesOf(loaded);
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
        sftpDocument({ metadata: statedColumns() }),
      ),
    );
    expect(columnRole(applied, "program_code")).toMatchObject({
      role: "ignored",
      isPayload: false,
    });
    expect(columnRole(applied, "first_name")?.role).toBe("linkage");
    expect(noticesOf(applied)).toEqual([]);
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

  test("the description the document states rides each column", () => {
    const described = statedColumns().map((column) =>
      column.name === "program_code" || column.name === "dob"
        ? { ...column, description: `what ${column.name} holds` }
        : column,
    );
    const applied = withFileRead(
      loadedInto(INVITER_SCREEN_INITIAL, sftpDocument({ metadata: described })),
    );
    expect(columnRole(applied, "program_code")?.description).toBe(
      "what program_code holds",
    );
    expect(columnRole(applied, "dob")?.description).toBe("what dob holds");
    expect(columnRole(applied, "first_name")?.description).toBeUndefined();
    expect(noticesOf(applied)).toEqual([]);
  });

  test("a second record identifier the columns rule demotes is named", () => {
    // The columns step admits one record identifier, so applying the second
    // sends the first to ignored: the run then diverges from the file it was
    // opened from, which is what the notice reports.
    const applied = withFileRead(
      loadedInto(
        INVITER_SCREEN_INITIAL,
        sftpDocument({
          metadata: [
            {
              name: "client_id",
              type: "identifier",
              role: "identifier",
              isPayload: false,
            },
            {
              name: "program_code",
              type: "identifier",
              role: "identifier",
              isPayload: false,
            },
          ],
        }),
      ),
    );
    expect(columnRole(applied, "client_id")).toMatchObject({ role: "ignored" });
    expect(columnRole(applied, "program_code")).toMatchObject({
      role: "identifier",
    });
    const notice = noticesOf(applied).find((text) =>
      text.includes("cannot supply"),
    );
    expect(notice).toContain("metadata");
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
    const notice = noticesOf(applied).find((text) =>
      text.includes("cannot supply"),
    );
    expect(notice).toContain("metadata, standardization");
    expect(columnRole(applied, "household_id")).toBeUndefined();
  });
});

// core reads a column's transmission from `is_payload` beside its role
// (`isDisclosedToPartner`), not from the role alone, so a configuration can
// state a pair the columns step's single choice cannot hold. What the merge
// keeps is what the document sends; the pair it could not hold whole is named
// beside the load rather than passed over.
describe("a column whose is_payload does not follow its role", () => {
  function mergedOver(column: ColumnMetadata) {
    const metadata: Metadata = statedColumns().map((own) =>
      own.name === column.name ? column : own,
    );
    const applied = withFileRead(
      loadedInto(INVITER_SCREEN_INITIAL, sftpDocument({ metadata })),
    );
    return {
      documentSends: disclosedColumnNames(metadata),
      draftSends: disclosedColumnNames(applied.editor?.draft.metadata ?? []),
      role: (name: string) => columnRole(applied, name)?.role,
      notApplied: noticesOf(applied).find((text) =>
        text.includes("cannot supply"),
      ),
    };
  }

  test("a payload column stated as not sent is not sent from here", () => {
    const merged = mergedOver({
      name: "program_code",
      type: "other",
      role: "payload",
      isPayload: false,
    });
    expect(merged.documentSends).toEqual([]);
    expect(merged.draftSends).toEqual(merged.documentSends);
    expect(merged.notApplied).toContain("metadata");
  });

  test("a record identifier stated as sent is sent, not held as one", () => {
    // Inference states this pair for an `_id` column, so a configuration
    // written from it sends that column on the command line. The step holds
    // either the identifier role or the sending one, and it takes sending, so
    // the run discloses what the file discloses.
    const merged = mergedOver({
      name: "client_id",
      type: "identifier",
      role: "identifier",
      isPayload: true,
    });
    expect(merged.documentSends).toEqual(["client_id"]);
    expect(merged.draftSends).toEqual(merged.documentSends);
    expect(merged.role("client_id")).toBe("payload");
    expect(merged.notApplied).toContain("metadata");
  });

  test("a matching column stated as sent is sent from here", () => {
    const merged = mergedOver({
      name: "dob",
      type: "date_of_birth",
      role: "linkage",
      isPayload: true,
    });
    expect(merged.documentSends).toEqual(["dob"]);
    expect(merged.draftSends).toEqual(merged.documentSends);
    expect(merged.notApplied).toContain("metadata");
  });
});

// A document stating `metadata` states the column set whole, the way the command
// line reads it, so a column of this file the document does not name is held
// back rather than disclosed on inference's default.
describe("a column the configuration does not name is kept back", () => {
  const applied = withFileRead(
    loadedInto(
      INVITER_SCREEN_INITIAL,
      sftpDocument({ metadata: fourOfFiveColumns() }),
    ),
  );

  test("the unnamed column lands ignored rather than sent", () => {
    expect(columnRole(applied, "program_code")).toMatchObject({
      role: "ignored",
      isPayload: false,
    });
  });

  test("the columns the document does name are applied as it states them", () => {
    expect(columnRole(applied, "first_name")?.role).toBe("linkage");
  });

  test("the notice names the setting and says the file holds more", () => {
    const notice = noticesOf(applied).find((text) =>
      text.includes("does not state under"),
    );
    expect(notice).toContain("metadata");
    expect(notice).not.toContain("program_code");
  });

  test("a document naming every column fires no notice", () => {
    const whole = withFileRead(
      loadedInto(
        INVITER_SCREEN_INITIAL,
        sftpDocument({ metadata: statedColumns() }),
      ),
    );
    expect(noticesOf(whole)).toEqual([]);
  });

  test("with no configuration open the same file still infers", () => {
    const own = withFileCommitted(INVITER_SCREEN_INITIAL, acquired());
    expect(columnRole(own, "program_code")).toMatchObject({
      role: "payload",
      isPayload: true,
    });
  });
});

// Closing the configuration drops what it filled in, which is every card it
// seeded: each was derived from the document, so each returns to the default an
// operator who never opened one would author from (docs/CONSOLE.md, "Close it to
// author from scratch").
describe("closing the configuration returns every seeded card to its default", () => {
  const closed = inviterScreenReducer(
    loadedInto(INVITER_SCREEN_INITIAL, sftpDocument()),
    { type: "loaded-configuration-discarded" },
  );

  test("the option cards hold what a fresh console holds", () => {
    expect(closed.connectionTuning).toEqual(CONNECTION_TUNING_DEFAULT);
    expect(closed.exchangeFiles).toEqual(EXCHANGE_FILES_DEFAULT);
  });

  test("receipts hold no signing mode, no partner pin and no note", () => {
    expect(closed.receipts).toEqual(RECEIPTS_DEFAULT);
  });

  test("the delimiter returns to the one an unopened console reads by", () => {
    expect(closed.delimiterChoice).toEqual(INITIAL_CSV_DELIMITER_CHOICE);
  });
});

// The delimiter the document states is one more thing the load fills in, so the
// seal that refuses the read refuses it too: a read resolving after the
// invitation was minted cannot leave this party reading its file by a character
// the sealed terms were never authored over.
describe("the delimiter moves with the read the seal guards", () => {
  test("an open configuration's delimiter reaches the file step", () => {
    const opened = loadedInto(INVITER_SCREEN_INITIAL, sftpDocument());
    const resolved = resolveCsvDelimiter(opened.delimiterChoice);
    expect(resolved.ok && resolved.delimiter).toBe("|");
  });

  test("a read that lands after the mint leaves it where the mint left it", () => {
    const sealed: InviterScreenState = {
      ...INVITER_SCREEN_INITIAL,
      editor: { sealed: true } as never,
    };
    const late = loadedInto(sealed, sftpDocument());
    expect(late.delimiterChoice).toBe(INVITER_SCREEN_INITIAL.delimiterChoice);
  });
});

// A commitment about what this party discloses, held from the file it was opened
// from, is enforced against the run's own disclosed set when the run starts:
// core compares the two sets (`assertDisclosureMatchesCommitment`,
// `assertOutboundPayloadConsented`) and refuses on any difference. The console
// reports that refusal where the sets differ, and stays quiet where a setting
// the file could not supply leaves the disclosed set matching all the same.
describe("a disclosure commitment the run's own columns no longer match", () => {
  const records = {
    disclosedPayloadColumns: ["household_id"],
    outboundPayloadConsent: {
      status: "confirmed" as const,
      columns: ["household_id"],
    },
  };
  const missingColumn: Metadata = [
    ...statedColumns(),
    { name: "household_id", type: "other", role: "payload", isPayload: true },
  ];

  test("the warning names both records and what to do about them", () => {
    const applied = withFileRead(
      loadedInto(
        INVITER_SCREEN_INITIAL,
        sftpDocument({ ...records, metadata: missingColumn }),
      ),
    );
    const warning = noticesOf(applied).find((text) =>
      text.includes("a run started here is refused"),
    );
    expect(warning).toContain("disclosed_payload_columns");
    expect(warning).toContain("outbound_payload_consent");
    expect(warning).toContain("close this configuration");
    expect(warning).not.toContain("household_id");
  });

  test("a commitment holding what the run sends warns about nothing", () => {
    const applied = withFileRead(
      loadedInto(
        INVITER_SCREEN_INITIAL,
        sftpDocument({
          disclosedPayloadColumns: ["program_code"],
          outboundPayloadConsent: {
            status: "confirmed",
            columns: ["program_code"],
          },
          metadata: documentColumns(),
        }),
      ),
    );
    expect(refusalWarned(applied)).toBe(false);
  });

  test("a column the file lacks is not a divergence where it sends none", () => {
    // The document names a column this file does not have and keeps it back,
    // so the run discloses exactly what the commitment holds: core lets it
    // through, and the notice for the setting stands alone.
    const applied = withFileRead(
      loadedInto(
        INVITER_SCREEN_INITIAL,
        sftpDocument({
          disclosedPayloadColumns: ["program_code"],
          metadata: [
            ...documentColumns(),
            {
              name: "household_id",
              type: "other",
              role: "ignored",
              isPayload: false,
            },
          ],
        }),
      ),
    );
    expect(
      noticesOf(applied).find((text) => text.includes("cannot supply")),
    ).toContain("metadata");
    expect(refusalWarned(applied)).toBe(false);
  });

  test("a demoted record identifier sends nothing, so it warns of nothing", () => {
    // The columns rule demotes the first of two record identifiers to ignored,
    // which the load reports; neither column was ever sent, so the disclosed
    // set still matches the commitment.
    const applied = withFileRead(
      loadedInto(
        INVITER_SCREEN_INITIAL,
        sftpDocument({
          disclosedPayloadColumns: [],
          metadata: [
            {
              name: "client_id",
              type: "identifier",
              role: "identifier",
              isPayload: false,
            },
            {
              name: "program_code",
              type: "identifier",
              role: "identifier",
              isPayload: false,
            },
          ],
        }),
      ),
    );
    expect(columnRole(applied, "client_id")).toMatchObject({ role: "ignored" });
    expect(
      noticesOf(applied).find((text) => text.includes("cannot supply")),
    ).toContain("metadata");
    expect(refusalWarned(applied)).toBe(false);
  });
});

// core's consent gate reads the run's output direction: a partner not entitled
// to the matched results receives nothing, so the consent record holds nothing
// and the run is allowed. The commitment beside it is held in either direction.
describe("a run the partner takes no results from", () => {
  const loaded = loadedInto(
    INVITER_SCREEN_INITIAL,
    sftpDocument({
      outboundPayloadConsent: {
        status: "confirmed",
        columns: ["household_id"],
      },
      metadata: statedColumns(),
    }),
  );

  test("warns of the consent record where the partner receives", () => {
    const applied = withOutputDirection(withFileRead(loaded), "both");
    const warning = noticesOf(applied).find((text) =>
      text.includes("a run started here is refused"),
    );
    expect(warning).toContain("outbound_payload_consent");
  });

  test("warns of nothing where only the inviter receives", () => {
    const applied = withOutputDirection(withFileRead(loaded), "inviter");
    expect(refusalWarned(applied)).toBe(false);
  });

  test("still holds the commitment core enforces in either direction", () => {
    const committed = loadedInto(
      INVITER_SCREEN_INITIAL,
      sftpDocument({
        disclosedPayloadColumns: ["household_id"],
        metadata: statedColumns(),
      }),
    );
    const applied = withOutputDirection(withFileRead(committed), "inviter");
    const warning = noticesOf(applied).find((text) =>
      text.includes("a run started here is refused"),
    );
    expect(warning).toContain("disclosed_payload_columns");
    expect(warning).not.toContain("outbound_payload_consent");
  });
});

// A consent record the file leaves pending confirms no column set, so core
// refuses every run that shares results with the partner until the command line
// confirms one. The load says so rather than leaving it to a failed run.
describe("a consent record the configuration leaves pending", () => {
  test("the load warns, and a confirmed record does not", () => {
    const pending = withFileRead(
      loadedInto(
        INVITER_SCREEN_INITIAL,
        sftpDocument({
          outboundPayloadConsent: { status: "pending" },
          metadata: statedColumns(),
        }),
      ),
    );
    expect(noticesOf(pending)).toContain(PENDING_OUTBOUND_CONSENT_WARNING);
    const confirmed = withFileRead(
      loadedInto(
        INVITER_SCREEN_INITIAL,
        sftpDocument({
          outboundPayloadConsent: { status: "confirmed", columns: [] },
          metadata: statedColumns(),
        }),
      ),
    );
    expect(noticesOf(confirmed)).not.toContain(
      PENDING_OUTBOUND_CONSENT_WARNING,
    );
  });
});
