import { describe, expect, test } from "vitest";

import { getDefaultLinkageTerms } from "@psilink/core";

import {
  CONFIGURATION_LOAD_SEALED,
  CONFIGURATION_OPENED,
  CONFIGURATION_OPENED_FOR_REVIEW,
  CONFIGURATION_READ_UNAVAILABLE,
  CONFIGURATION_SAVED,
  CONFIGURATION_SAVE_UNAVAILABLE,
  CONVERT_CONFIGURATION_LABEL,
  MOUNTED_CONFIGURATION_UNREAD,
  NO_CONFIGURATION_IN_FOLDER,
  PENDING_OUTBOUND_CONSENT_WARNING,
  carriedThroughNotice,
  channelNotConductedNotice,
  columnsNotCoveredNotice,
  configurationOpenedMessage,
  configurationSaveShown,
  configurationSaveState,
  connectionSettingsHeldNotice,
  conversionOffered,
  conversionStatement,
  convertedStatement,
  credentialWarningNotice,
  divergedCommitmentNotice,
  divergedCommitmentWarning,
  divergedCommitments,
  mountedConfigurationNotices,
  mountedConfigurationOfferable,
  mountedConfigurationRead,
  runWithheldReason,
  termsNotAppliedNotice,
  unconvertedSigningWithheldReason,
  withConversion,
  withTermsNotApplied,
  withUnavailableTransport,
} from "@console/mountedConfiguration";

import { PREVIOUS_CONFIGURATION_FILE_NAME } from "@jobs/intentSchemas";

import type { DisclosedExchangeDocument } from "@jobs/configLoad";
import type { JobConfigurationHandBack } from "@jobs/intentSchemas";
import type { MountedConfigurationAnswer } from "@psi/jobClient/mountedConfigClient";

// The load offer as a value: which of the three states each answer lands in, and
// the copy beside it. Every notice names SETTINGS ONLY, as the file spells them
// -- a setting's value can be a credential, which is why the console's own route
// names rather than sends both lists -- so the sweep below drives a document whose
// every value is distinctive and refuses to find one in any notice.

/** A hand-back a save sends, for the save states below. */
const HAND_BACK: JobConfigurationHandBack = {
  linkageTerms: getDefaultLinkageTerms("County Health"),
  csvDelimiter: "|",
  signing: { mode: "none" },
};

const FINGERPRINT = "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA";

function document(
  overrides: Partial<DisclosedExchangeDocument> = {},
): DisclosedExchangeDocument {
  return {
    channel: "sftp",
    server: { host: "sftp.partner.example", hostKeyFingerprint: FINGERPRINT },
    linkageTerms: getDefaultLinkageTerms("County Health"),
    ...overrides,
  };
}

function opened(
  overrides: Partial<DisclosedExchangeDocument> = {},
  carriedThrough: Array<string> = [],
  warnings: Array<string> = [],
): MountedConfigurationAnswer {
  return {
    kind: "opened",
    document: document(overrides),
    carriedThrough,
    warnings,
  };
}

describe("each answer lands the control in one state", () => {
  test("a mount holding no configuration is not a fault", () => {
    const read = mountedConfigurationRead({ kind: "absent" });
    expect(read.state).toEqual({ status: "absent" });
    expect(read.loaded).toBeUndefined();
    expect(NO_CONFIGURATION_IN_FOLDER).toMatch(/authored here/);
  });

  test("a read that did not answer leaves the offer standing", () => {
    const read = mountedConfigurationRead({ kind: "unavailable" });
    expect(read.state).toEqual({ status: "unavailable" });
    expect(read.loaded).toBeUndefined();
    expect(CONFIGURATION_READ_UNAVAILABLE).toMatch(/Nothing below has changed/);
  });

  test("a refusal shows the console's own text and fills nothing", () => {
    // A refusal the route raises reaches the operator whole, and no step is
    // filled from a document the console would not open.
    const error =
      "The psilink.yaml in your working folder is not a valid psilink " +
      "configuration. Fix this setting in the file, then open it again: " +
      "connection.server.port.";
    const read = mountedConfigurationRead({ kind: "refused", error });
    expect(read.state).toEqual({ status: "refused", error });
    expect(read.loaded).toBeUndefined();
  });

  test("an opened configuration reports both lists and the authoring state", () => {
    const read = mountedConfigurationRead(
      opened(
        {},
        ["authentication.token_max_age_days"],
        ["connection.server.password"],
      ),
    );
    expect(read.state).toEqual({
      status: "opened",
      carriedThrough: ["authentication.token_max_age_days"],
      warnings: ["connection.server.password"],
    });
    expect(read.loaded?.channel).toBe("sftp");
    expect(read.loaded?.sftpForm?.host).toBe("sftp.partner.example");
  });
});

describe("an opened configuration's own paths, until converted", () => {
  /** An opened filedrop configuration stating both signing paths and its
   * shared folder, as the load names them. */
  function openedWithPaths(
    signingPathSettings: Array<string> = [
      "signing.identity_file",
      "signing.receipt_output",
    ],
  ) {
    return mountedConfigurationRead({
      kind: "opened",
      document: {
        channel: "filedrop",
        linkageTerms: getDefaultLinkageTerms("County Health"),
      },
      carriedThrough: [],
      warnings: [],
      signingPathSettings,
      folderPathSettings: ["connection.path"],
    }).state;
  }

  test("the read keeps the paths the load named on the state", () => {
    const state = openedWithPaths();
    expect(state).toMatchObject({
      status: "opened",
      signingPaths: ["signing.identity_file", "signing.receipt_output"],
      folderPaths: ["connection.path"],
    });
    if (state.status !== "opened") throw new Error("expected an open state");
    expect(state.converted).toBeUndefined();
  });

  test("a signed run of it is withheld, naming the settings and the conversion", () => {
    const reason = unconvertedSigningWithheldReason(
      openedWithPaths(),
      "certificate",
    );
    expect(reason).toContain("signing.identity_file, signing.receipt_output");
    expect(reason).toContain(CONVERT_CONFIGURATION_LABEL);
    expect(reason).toContain("turn the signed receipt off");
    expect(reason).toContain(
      "this exchange then runs unsigned, and the configuration the console " +
        "gives you to run on a schedule keeps your file's signing settings",
    );
  });

  test("an unsigned run of it is not withheld", () => {
    expect(
      unconvertedSigningWithheldReason(openedWithPaths(), "none"),
    ).toBeUndefined();
  });

  test("a configuration naming only its folder withholds no signed run", () => {
    expect(
      unconvertedSigningWithheldReason(openedWithPaths([]), "certificate"),
    ).toBeUndefined();
  });

  test("the conversion is offered with every setting it replaces stated", () => {
    const state = openedWithPaths();
    expect(conversionOffered(state, false)).toBe(true);
    expect(conversionOffered(state, true)).toBe(false);
    const statement = conversionStatement(state);
    expect(statement).toContain(
      "signing.identity_file, signing.receipt_output, connection.path",
    );
    expect(statement).toContain(
      "A run with a signed receipt waits until you convert",
    );
    expect(statement).toContain(
      "With the signed receipt off, this exchange runs unsigned",
    );
    expect(statement).toContain("keeps your file's signing settings");
    expect(statement).toContain(
      "The run uses the console's mounted folder either way.",
    );
    expect(statement).toContain(
      "a placeholder in place of signing.identity_file, connection.path",
    );
    expect(statement).toContain("names no receipt file");
  });

  test("converting only a folder path changes only the scheduled configuration", () => {
    const statement = conversionStatement(openedWithPaths([]));
    expect(statement).toContain("names a path of its own: connection.path.");
    expect(statement).toContain(
      "The run uses the console's mounted folder either way.",
    );
    expect(statement).toContain("Converting changes only the configuration");
    expect(statement).not.toContain("signed receipt");
    expect(statement).not.toContain("receipt file");
  });

  test("once converted, the run is released and the statement says so", () => {
    const state = withConversion(openedWithPaths());
    expect(unconvertedSigningWithheldReason(state, "certificate")).toBe(
      undefined,
    );
    expect(conversionOffered(state, false)).toBe(false);
    expect(conversionStatement(state)).toBeUndefined();
    expect(convertedStatement(state)).toContain(
      "in place of signing.identity_file, signing.receipt_output, connection.path",
    );
  });

  test("a configuration naming no path of its own has nothing to convert", () => {
    const state = mountedConfigurationRead(opened()).state;
    expect(conversionOffered(state, false)).toBe(false);
    expect(withConversion(state)).toBe(state);
  });
});

describe("a configuration on a channel the console does not conduct", () => {
  function openedWebrtc(
    overrides: Partial<DisclosedExchangeDocument> = {},
    carriedThrough: Array<string> = ["authentication.token_max_age_days"],
  ): MountedConfigurationAnswer {
    return {
      kind: "opened",
      document: {
        channel: "webrtc",
        linkageTerms: getDefaultLinkageTerms("County Health"),
        ...overrides,
      },
      carriedThrough,
      warnings: [],
    };
  }

  test("opens with its channel named on the state, and every step seeded", () => {
    const read = mountedConfigurationRead(
      openedWebrtc({ csvDelimiter: "|", retentionDisposition: "Filed." }),
    );
    expect(read.state).toEqual({
      status: "opened",
      carriedThrough: ["authentication.token_max_age_days"],
      warnings: [],
      notConducted: "webrtc",
    });
    expect(read.loaded?.channel).toBe("webrtc");
    expect(read.loaded?.sftpForm).toBeUndefined();
    expect(read.loaded?.csvDelimiter.option).toBe("|");
    expect(read.loaded?.receipts.retentionDisposition).toBe("Filed.");
  });

  test("withholds the run, naming the channel and what the console runs", () => {
    const { state } = mountedConfigurationRead(openedWebrtc());
    const reason = runWithheldReason(state);
    expect(reason).toContain("webrtc");
    expect(reason).toContain("sftp and filedrop");
    expect(reason).toMatch(/psilink on the command line/);
    expect(reason).toMatch(/Save your changes to psilink\.yaml/);
  });

  test("a channel the console conducts withholds nothing", () => {
    expect(runWithheldReason(mountedConfigurationRead(opened()).state)).toBe(
      undefined,
    );
    expect(
      runWithheldReason(
        mountedConfigurationRead(opened({ channel: "filedrop" })).state,
      ),
    ).toBeUndefined();
    expect(runWithheldReason({ status: "unread" })).toBeUndefined();
    expect(
      runWithheldReason({ status: "refused", error: "no" }),
    ).toBeUndefined();
  });

  test("the channel notice stands in place of every notice about a run", () => {
    const { state } = mountedConfigurationRead(
      openedWebrtc({
        outboundPayloadConsent: { status: "pending" },
        disclosedPayloadColumns: ["own_notes"],
      }),
    );
    const notices = mountedConfigurationNotices(state, {
      disclosedColumns: ["own_notes"],
      sharesWithPartner: true,
      records: { disclosedPayloadColumns: ["own_notes"] },
    });
    expect(notices).toEqual([channelNotConductedNotice("webrtc")]);
    expect(notices[0]).toContain("runs over webrtc");
    expect(notices[0]).toMatch(/save them to psilink\.yaml/);
    expect(notices[0]).toMatch(/connection is kept exactly as your file/);
  });

  test("a draft that changes the disclosed columns is reported", () => {
    const records = {
      disclosedPayloadColumns: ["own_notes"],
      outboundPayloadConsent: {
        status: "confirmed" as const,
        columns: ["own_notes"],
      },
    };
    const { state } = mountedConfigurationRead(openedWebrtc(records));
    const edited = {
      disclosedColumns: ["own_notes", "dob"],
      sharesWithPartner: true,
      records,
    };
    expect(divergedCommitments(state, edited)).toEqual([
      "disclosed_payload_columns",
      "outbound_payload_consent",
    ]);
    const notice = divergedCommitmentNotice(state, edited);
    expect(notice).toContain("disclosed_payload_columns");
    expect(notice).toMatch(/psilink on the command line refuses to run/);
    expect(notice).toMatch(/invite your partner again/);
    expect(notice).not.toMatch(/a run started here/);
    expect(mountedConfigurationNotices(state, edited)).toEqual([
      channelNotConductedNotice("webrtc"),
      notice,
    ]);
  });

  test("an unchanged draft reports no diverged commitment", () => {
    const records = { disclosedPayloadColumns: ["own_notes"] };
    const { state } = mountedConfigurationRead(openedWebrtc(records));
    const unchanged = {
      disclosedColumns: ["own_notes"],
      sharesWithPartner: true,
      records,
    };
    expect(divergedCommitments(state, unchanged)).toEqual([]);
    expect(divergedCommitmentNotice(state, unchanged)).toBeUndefined();
  });

  test("a save leaves the state its answer names", () => {
    expect(configurationSaveState({ kind: "written" }, HAND_BACK)).toEqual({
      status: "saved",
      handBack: JSON.stringify(HAND_BACK),
    });
    expect(
      configurationSaveState(
        { kind: "refused", error: "Change them." },
        HAND_BACK,
      ),
    ).toEqual({ status: "failed", message: "Change them." });
    expect(configurationSaveState({ kind: "unavailable" }, HAND_BACK)).toEqual({
      status: "failed",
      message: CONFIGURATION_SAVE_UNAVAILABLE,
    });
  });

  test("a written save is shown while the steps hold what it sent", () => {
    const saved = configurationSaveState({ kind: "written" }, HAND_BACK);
    expect(configurationSaveShown(saved, { ...HAND_BACK })).toEqual(saved);
  });

  test("a written save is not shown once the steps hold anything else", () => {
    const saved = configurationSaveState({ kind: "written" }, HAND_BACK);
    expect(
      configurationSaveShown(saved, { ...HAND_BACK, csvDelimiter: ";" }),
    ).toEqual({ status: "idle" });
    expect(configurationSaveShown(saved, undefined)).toEqual({
      status: "idle",
    });
    const failed = configurationSaveState({ kind: "unavailable" }, HAND_BACK);
    expect(
      configurationSaveShown(failed, { ...HAND_BACK, csvDelimiter: ";" }),
    ).toEqual(failed);
  });

  test("the saved message names the copy of the file kept beside it", () => {
    expect(CONFIGURATION_SAVED).toContain(PREVIOUS_CONFIGURATION_FILE_NAME);
  });

  test("its connection settings are held from the file, with a sentence", () => {
    const notice = connectionSettingsHeldNotice(
      mountedConfigurationRead(openedWebrtc()).state,
    );
    expect(notice).toContain("webrtc connection");
    expect(notice).toMatch(/exactly as your file states it/);
    expect(notice).toMatch(/on the command line/);
  });

  test("a channel the console conducts holds no connection setting", () => {
    expect(
      connectionSettingsHeldNotice(mountedConfigurationRead(opened()).state),
    ).toBeUndefined();
    expect(
      connectionSettingsHeldNotice(
        mountedConfigurationRead(opened({ channel: "filedrop" })).state,
      ),
    ).toBeUndefined();
    expect(connectionSettingsHeldNotice({ status: "unread" })).toBeUndefined();
  });

  test("what the input file cannot supply is still named after it", () => {
    const { state } = mountedConfigurationRead(openedWebrtc());
    const notices = mountedConfigurationNotices(
      withTermsNotApplied(state, ["metadata"], ["metadata"]),
    );
    expect(notices).toHaveLength(3);
    expect(notices[0]).toContain("webrtc");
    expect(notices[1]).toContain("metadata");
  });

  test("the control says the configuration is open for review", () => {
    expect(
      configurationOpenedMessage(
        mountedConfigurationRead(openedWebrtc()).state,
      ),
    ).toBe(CONFIGURATION_OPENED_FOR_REVIEW);
    expect(
      configurationOpenedMessage(mountedConfigurationRead(opened()).state),
    ).toBe(CONFIGURATION_OPENED);
  });
});

describe("a record this flow has no control for opens and is named", () => {
  test.each([
    ["expectedPayloadColumns", "expected_payload_columns", ["program_code"]],
    ["expectedPartnerDeduplicate", "expected_partner_deduplicate", true],
    ["disclosedPayloadColumns", "disclosed_payload_columns", ["program_code"]],
    [
      "outboundPayloadConsent",
      "outbound_payload_consent",
      { status: "confirmed", columns: ["program_code"] },
    ],
  ] as const)(
    "%s is held and named as the file spells it",
    (field, spelling, value) => {
      const read = mountedConfigurationRead(opened({ [field]: value }));
      expect(read.loaded?.records[field]).toEqual(value);
      if (read.state.status !== "opened")
        throw new Error("expected an open configuration");
      expect(read.state.carriedThrough).toContain(spelling);
      const notice = mountedConfigurationNotices(read.state)[0];
      expect(notice).toContain(spelling);
      expect(notice).toContain("keeps it unchanged");
    },
  );

  test("all four are named beside the settings the route itself held", () => {
    const read = mountedConfigurationRead(
      opened(
        {
          expectedPayloadColumns: [],
          expectedPartnerDeduplicate: false,
          disclosedPayloadColumns: [],
          outboundPayloadConsent: { status: "pending" },
        },
        ["authentication.token_max_age_days"],
      ),
    );
    if (read.state.status !== "opened")
      throw new Error("expected an open configuration");
    expect(read.state.carriedThrough).toEqual([
      "authentication.token_max_age_days",
      "disclosed_payload_columns",
      "expected_partner_deduplicate",
      "expected_payload_columns",
      "outbound_payload_consent",
    ]);
  });
});

describe("the notices name the settings and say what happens to them", () => {
  test("one held setting is named, with where it is edited", () => {
    const notice = carriedThroughNotice(["authentication.token_max_age_days"]);
    expect(notice).toContain("authentication.token_max_age_days");
    expect(notice).toContain("keeps it unchanged");
    expect(notice).toMatch(/psilink on the command line/);
  });

  test("a held setting the run does not apply says so", () => {
    const notice = carriedThroughNotice(["authentication.token_max_age_days"]);
    expect(notice).toContain("The run started here does not apply it");
    expect(notice).toContain("hands back states it as your file does");
  });

  test("a record the run states is not named as unapplied", () => {
    const notice = carriedThroughNotice([
      "expected_payload_columns",
      "outbound_payload_consent",
    ]);
    expect(notice).toContain("keeps each unchanged");
    expect(notice).not.toContain("does not apply");
  });

  test("several held settings are all named", () => {
    const notice = carriedThroughNotice([
      "authentication.token_max_age_days",
      "expected_payload_columns",
    ]);
    expect(notice).toContain("authentication.token_max_age_days");
    expect(notice).toContain("expected_payload_columns");
    expect(notice).toContain("keeps each unchanged");
    expect(notice).toContain(
      "does not apply authentication.token_max_age_days",
    );
  });

  test("no held setting draws no notice", () => {
    expect(carriedThroughNotice([])).toBeUndefined();
  });

  test("one credential field is named, with where to supply it", () => {
    const notice = credentialWarningNotice(["connection.server.password"]);
    expect(notice).toContain("connection.server.password");
    expect(notice).toMatch(/connection step/);
    expect(notice).toMatch(/folder you mounted/);
  });

  test("several credential fields are all named", () => {
    const notice = credentialWarningNotice([
      "connection.server.private_key",
      "connection.server.private_key_passphrase",
    ]);
    expect(notice).toContain("connection.server.private_key,");
    expect(notice).toContain("connection.server.private_key_passphrase");
    expect(notice).toContain("Supply each again");
  });

  test("no credential field draws no notice", () => {
    expect(credentialWarningNotice([])).toBeUndefined();
  });

  test("the held settings are stated before the credential to supply", () => {
    const read = mountedConfigurationRead(
      opened(
        {},
        ["authentication.token_max_age_days"],
        ["connection.server.password"],
      ),
    );
    const notices = mountedConfigurationNotices(read.state);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain("authentication.token_max_age_days");
    expect(notices[1]).toContain("connection.server.password");
  });

  test("a channel this console cannot run says so and what to do", () => {
    const read = mountedConfigurationRead(opened({ channel: "filedrop" }));
    const notices = mountedConfigurationNotices(
      withUnavailableTransport(read.state, "filedrop"),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("shared directory");
    expect(notices[0]).toContain("JOB_RENDEZVOUS_DIR");
    expect(notices[0]).toMatch(/review step/);
  });

  test("a setting the input file cannot supply is named, not dropped", () => {
    const notice = termsNotAppliedNotice(["metadata", "standardization"]);
    expect(notice).toContain("metadata, standardization");
    expect(notice).toMatch(/psilink on the command line/);
    expect(termsNotAppliedNotice([])).toBeUndefined();
  });

  test("what the file could not supply is stated last", () => {
    const read = mountedConfigurationRead(
      opened(
        { channel: "filedrop" },
        ["signing.receipt_output"],
        ["connection.server.password"],
      ),
    );
    const notices = mountedConfigurationNotices(
      withUnavailableTransport(
        withTermsNotApplied(read.state, ["metadata"]),
        "filedrop",
      ),
    );
    expect(notices).toHaveLength(4);
    expect(notices[0]).toContain("shared directory");
    expect(notices[1]).toContain("signing.receipt_output");
    expect(notices[2]).toContain("connection.server.password");
    expect(notices[3]).toContain("metadata");
  });

  test("a load that opened nothing takes neither added notice", () => {
    expect(withUnavailableTransport({ status: "absent" }, "filedrop")).toEqual({
      status: "absent",
    });
    expect(withTermsNotApplied({ status: "absent" }, ["metadata"])).toEqual({
      status: "absent",
    });
  });

  test("a file that supplies everything clears what an earlier one could not", () => {
    // The notice is about the file the terms reached last, so the next file
    // supplying the whole document leaves nothing named.
    const read = mountedConfigurationRead(opened());
    const named = withTermsNotApplied(read.state, ["metadata"]);
    const cleared = withTermsNotApplied(named, []);
    expect(mountedConfigurationNotices(named)).toHaveLength(1);
    expect(mountedConfigurationNotices(cleared)).toEqual([]);
  });

  test("a state that opened nothing renders no notice", () => {
    expect(mountedConfigurationNotices({ status: "absent" })).toEqual([]);
    expect(mountedConfigurationNotices({ status: "unread" })).toEqual([]);
    expect(
      mountedConfigurationNotices({ status: "refused", error: "no" }),
    ).toEqual([]);
  });
});

describe("no value of the document reaches a notice", () => {
  test("names only, over a document whose every value is distinctive", () => {
    const secret = "correct-horse-battery-staple";
    const read = mountedConfigurationRead(
      opened(
        {
          server: {
            host: `host-${secret}`,
            username: `user-${secret}`,
            hostKeyFingerprint: FINGERPRINT,
          },
          csvDelimiter: "|",
          retentionDisposition: `note-${secret}`,
          signing: { mode: "certificate", partnerFingerprint: FINGERPRINT },
        },
        ["authentication.token_max_age_days"],
        ["connection.server.password"],
      ),
    );
    const named = withTermsNotApplied(read.state, ["metadata"], ["metadata"]);
    for (const notice of mountedConfigurationNotices(named)) {
      expect(notice).not.toContain(secret);
      expect(notice).not.toContain(FINGERPRINT);
    }
  });
});

describe("the offer stands only while the steps it fills are editable", () => {
  test("an unread offer is made, and withheld once an invitation is minted", () => {
    expect(
      mountedConfigurationOfferable(MOUNTED_CONFIGURATION_UNREAD, false),
    ).toBe(true);
    expect(
      mountedConfigurationOfferable(MOUNTED_CONFIGURATION_UNREAD, true),
    ).toBe(false);
    expect(CONFIGURATION_LOAD_SEALED).toContain("Start a new exchange");
  });

  test("a read that did not answer can be retried, an open one cannot be reopened", () => {
    expect(
      mountedConfigurationOfferable({ status: "unavailable" }, false),
    ).toBe(true);
    expect(
      mountedConfigurationOfferable(
        mountedConfigurationRead(opened()).state,
        false,
      ),
    ).toBe(false);
  });
});

// A document stating `metadata` states the whole column set, so a column this
// party's file has and that set does not name is held back. The notice says the
// file holds more than the configuration states -- the opposite direction from
// the one beside it -- and names the setting only.
describe("columns the configuration does not state", () => {
  test("the notice names the setting and what happens to the columns", () => {
    const notice = columnsNotCoveredNotice(["metadata"]);
    expect(notice).toContain("metadata");
    expect(notice).toMatch(/keep those columns back/);
    expect(columnsNotCoveredNotice([])).toBeUndefined();
  });

  test("it stands beside what the file could not supply, after it", () => {
    const read = mountedConfigurationRead(opened());
    const notices = mountedConfigurationNotices(
      withTermsNotApplied(read.state, ["standardization"], ["metadata"]),
    );
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain("standardization");
    expect(notices[1]).toContain("does not state under metadata");
  });
});

// A consent record the file states as pending confirms no set, so core refuses
// every run that shares results with the partner until it is confirmed. The
// operator meets that beside the load rather than as a failed run.
describe("a consent record the configuration leaves pending", () => {
  test("the control warns, naming the setting and where to confirm it", () => {
    const read = mountedConfigurationRead(
      opened({ outboundPayloadConsent: { status: "pending" } }),
    );
    expect(mountedConfigurationNotices(read.state)).toContain(
      PENDING_OUTBOUND_CONSENT_WARNING,
    );
    expect(PENDING_OUTBOUND_CONSENT_WARNING).toContain(
      "outbound_payload_consent",
    );
    expect(PENDING_OUTBOUND_CONSENT_WARNING).toMatch(/pending/);
    expect(PENDING_OUTBOUND_CONSENT_WARNING).toMatch(/command line/);
  });

  test("a confirmed record, and no record at all, warn about nothing", () => {
    const confirmed = mountedConfigurationRead(
      opened({
        outboundPayloadConsent: { status: "confirmed", columns: ["dob"] },
      }),
    );
    const none = mountedConfigurationRead(opened());
    for (const read of [confirmed, none])
      expect(
        mountedConfigurationNotices(read.state).includes(
          PENDING_OUTBOUND_CONSENT_WARNING,
        ),
      ).toBe(false);
  });
});

// A commitment the file states about what this party discloses is enforced when
// the run starts, against the set the run would disclose: core compares the two
// sets and refuses on any difference. The warning reports exactly that refusal,
// so it stands where the sets differ and nowhere else.
describe("a disclosure commitment the run's own columns no longer match", () => {
  const read = mountedConfigurationRead(
    opened({
      disclosedPayloadColumns: ["program_code"],
      outboundPayloadConsent: {
        status: "confirmed",
        columns: ["program_code"],
      },
    }),
  );
  const records = {
    disclosedPayloadColumns: ["program_code"],
    outboundPayloadConsent: {
      status: "confirmed" as const,
      columns: ["program_code"],
    },
  };

  test("the warning names the records and both ways out", () => {
    const warning = divergedCommitmentWarning([
      "disclosed_payload_columns",
      "outbound_payload_consent",
    ]);
    expect(warning).toContain("disclosed_payload_columns");
    expect(warning).toContain("outbound_payload_consent");
    expect(warning).toMatch(/next step/);
    expect(warning).toMatch(/close this configuration/);
    expect(divergedCommitmentWarning([])).toBeUndefined();
  });

  test("the set the run discloses matching the commitment raises nothing", () => {
    expect(
      divergedCommitments(read.state, {
        disclosedColumns: ["program_code"],
        sharesWithPartner: true,
        records,
      }),
    ).toEqual([]);
  });

  test("order and repetition are not a difference of sets", () => {
    expect(
      divergedCommitments(read.state, {
        disclosedColumns: ["program_code", "program_code"],
        sharesWithPartner: true,
        records: { disclosedPayloadColumns: ["program_code"] },
      }),
    ).toEqual([]);
  });

  test("a column dropped from the set, and one added to it, each raise it", () => {
    expect(
      divergedCommitments(read.state, {
        disclosedColumns: [],
        sharesWithPartner: true,
        records,
      }),
    ).toEqual(["disclosed_payload_columns", "outbound_payload_consent"]);
    expect(
      divergedCommitments(read.state, {
        disclosedColumns: ["program_code", "dob"],
        sharesWithPartner: true,
        records,
      }),
    ).toEqual(["disclosed_payload_columns", "outbound_payload_consent"]);
  });

  test("a consent record confirming no set has none to differ from", () => {
    expect(
      divergedCommitments(read.state, {
        disclosedColumns: ["dob"],
        sharesWithPartner: true,
        records: { outboundPayloadConsent: { status: "pending" } },
      }),
    ).toEqual([]);
  });

  test("a document stating no commitment raises nothing", () => {
    const plain = mountedConfigurationRead(opened());
    expect(
      divergedCommitments(plain.state, {
        disclosedColumns: ["dob"],
        sharesWithPartner: true,
        records: {},
      }),
    ).toEqual([]);
  });

  test("no file read yet settles no disclosed set, so nothing is said", () => {
    expect(divergedCommitments(read.state, undefined)).toEqual([]);
    expect(
      mountedConfigurationNotices(read.state).some((text) =>
        text.includes("a run started here is refused"),
      ),
    ).toBe(false);
  });

  test("a partner taking no results is past core's consent gate", () => {
    // core's `assessOutboundPayloadConsent` answers not-required where
    // `output.shareWithPartner` is false: the run sends nothing, so the consent
    // record has nothing to hold. The commitment beside it has no such gate.
    expect(
      divergedCommitments(read.state, {
        disclosedColumns: ["dob"],
        sharesWithPartner: false,
        records,
      }),
    ).toEqual(["disclosed_payload_columns"]);
    expect(
      divergedCommitments(read.state, {
        disclosedColumns: ["dob"],
        sharesWithPartner: true,
        records,
      }),
    ).toEqual(["disclosed_payload_columns", "outbound_payload_consent"]);
  });

  test("it is the last thing said beside the control", () => {
    const notices = mountedConfigurationNotices(
      withTermsNotApplied(read.state, ["metadata"]),
      { disclosedColumns: [], sharesWithPartner: true, records },
    );
    expect(notices.at(-1)).toContain("a run started here is refused");
  });
});
