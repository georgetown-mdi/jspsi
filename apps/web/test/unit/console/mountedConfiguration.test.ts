import { describe, expect, test } from "vitest";

import { getDefaultLinkageTerms } from "@psilink/core";

import {
  CONFIGURATION_LOAD_SEALED,
  CONFIGURATION_READ_UNAVAILABLE,
  MOUNTED_CONFIGURATION_UNREAD,
  NO_CONFIGURATION_IN_FOLDER,
  carriedThroughNotice,
  credentialWarningNotice,
  mountedConfigurationNotices,
  mountedConfigurationOfferable,
  mountedConfigurationRead,
  termsNotAppliedNotice,
  withTermsNotApplied,
  withUnavailableTransport,
} from "@console/mountedConfiguration";

import type { DisclosedExchangeDocument } from "@jobs/configLoad";
import type { MountedConfigurationAnswer } from "@psi/jobClient/mountedConfigClient";

// The load offer as a value: which of the three states each answer lands in, and
// the copy beside it. Every notice names SETTINGS ONLY, as the file spells them
// -- a setting's value can be a credential, which is why the console's own route
// names rather than sends both lists -- so the sweep below drives a document whose
// every value is distinctive and refuses to find one in any notice.

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
    // The channel refusal the route raises for a webrtc document: it reaches the
    // operator whole, and no step is filled from a document the console will not
    // run.
    const error =
      "This configuration runs over webrtc. The console conducts sftp and " +
      "shared-folder exchanges only, so it cannot open this one. Run it with " +
      "psilink on the command line instead.";
    const read = mountedConfigurationRead({ kind: "refused", error });
    expect(read.state).toEqual({ status: "refused", error });
    expect(read.loaded).toBeUndefined();
  });

  test("an opened configuration reports both lists and the authoring state", () => {
    const read = mountedConfigurationRead(
      opened({}, ["signing.receipt_output"], ["connection.server.password"]),
    );
    expect(read.state).toEqual({
      status: "opened",
      carriedThrough: ["signing.receipt_output"],
      warnings: ["connection.server.password"],
    });
    expect(read.loaded?.channel).toBe("sftp");
    expect(read.loaded?.sftpForm?.host).toBe("sftp.partner.example");
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
        ["signing.receipt_output"],
      ),
    );
    if (read.state.status !== "opened")
      throw new Error("expected an open configuration");
    expect(read.state.carriedThrough).toEqual([
      "disclosed_payload_columns",
      "expected_partner_deduplicate",
      "expected_payload_columns",
      "outbound_payload_consent",
      "signing.receipt_output",
    ]);
  });
});

describe("the notices name the settings and say what happens to them", () => {
  test("one held setting is named, with where it is edited", () => {
    const notice = carriedThroughNotice(["signing.receipt_output"]);
    expect(notice).toContain("signing.receipt_output");
    expect(notice).toContain("keeps it unchanged");
    expect(notice).toMatch(/psilink on the command line/);
  });

  test("several held settings are all named", () => {
    const notice = carriedThroughNotice([
      "connection.path",
      "signing.identity_file",
    ]);
    expect(notice).toContain("connection.path");
    expect(notice).toContain("signing.identity_file");
    expect(notice).toContain("keeps each unchanged");
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
      opened({}, ["signing.receipt_output"], ["connection.server.password"]),
    );
    const notices = mountedConfigurationNotices(read.state);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain("signing.receipt_output");
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

  test("an unrunnable sftp channel points at the same choice", () => {
    const read = mountedConfigurationRead(opened());
    const notices = mountedConfigurationNotices(
      withUnavailableTransport(read.state, "sftp"),
    );
    expect(notices[0]).toContain("over SFTP");
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
      opened({}, ["signing.receipt_output"], ["connection.server.password"]),
    );
    const notices = mountedConfigurationNotices(
      withUnavailableTransport(
        withTermsNotApplied(read.state, ["metadata"]),
        "sftp",
      ),
    );
    expect(notices).toHaveLength(4);
    expect(notices[0]).toContain("over SFTP");
    expect(notices[1]).toContain("signing.receipt_output");
    expect(notices[2]).toContain("connection.server.password");
    expect(notices[3]).toContain("metadata");
  });

  test("a load that opened nothing takes neither added notice", () => {
    expect(withUnavailableTransport({ status: "absent" }, "sftp")).toEqual({
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
        ["signing.receipt_output", "authentication.token_max_age_days"],
        ["connection.server.password"],
      ),
    );
    for (const notice of mountedConfigurationNotices(read.state)) {
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
