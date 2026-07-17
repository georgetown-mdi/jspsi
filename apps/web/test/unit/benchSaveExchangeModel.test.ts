import { describe, expect, test } from "vitest";

import {
  EMPTY_SAVE_FIELDS,
  PRE_RUN_TRUST_FOOTER,
  credentialAlertCopy,
  endpointRequestFor,
  exchangeFileInputFor,
  exchangeFileName,
  liveRunLedgerFooter,
  runCommand,
  saveCapabilityCopy,
  saveExchangeError,
  saveLeadCopy,
  saveTrustFooter,
} from "@bench/saveExchangeModel";

import type { LinkageTerms, Metadata } from "@psilink/core";
import type { GeneratedInvitation } from "@psi/invitation";
import type { SaveExchangeFields } from "@bench/saveExchangeModel";

const terms = {
  identity: "Dana",
  linkageKeys: [{ name: "key 1", elements: [] }],
} as unknown as LinkageTerms;

// Two columns, one disclosed (`program_code`, isPayload) and one match-only
// (`dob`): disclosedColumnNames(metadata) is exactly ["program_code"]. The
// stub's own disclosedPayloadColumns is deliberately a DIFFERENT set
// (["case_number"], not a payload column in this metadata at all) so a test
// asserting against it can only pass on a verbatim pass-through of the
// invitation's field -- a re-derivation via disclosedColumnNames(metadata)
// would produce ["program_code"] instead and fail.
const metadata = [
  { name: "program_code", role: "payload", isPayload: true },
  { name: "dob", role: "match", isPayload: false },
] as unknown as Metadata;

function invitationStub(
  overrides: Partial<GeneratedInvitation> = {},
): GeneratedInvitation {
  return {
    encoded: "ENCODED_TOKEN",
    deepLink: "https://example.org/accept#ENCODED_TOKEN",
    sharedSecret: "secret",
    expires: "2026-07-08T19:32:00.000Z",
    linkageTerms: terms,
    rawRows: [],
    columns: ["program_code", "dob"],
    metadata,
    standardization: undefined,
    disclosedPayloadColumns: ["case_number"],
    ...overrides,
  };
}

const sftpFields: SaveExchangeFields = {
  ...EMPTY_SAVE_FIELDS,
  host: "sftp.riverbend.example.gov",
  remoteDirectory: "/exchanges/psilink",
};

const filedropFields: SaveExchangeFields = {
  ...EMPTY_SAVE_FIELDS,
  sharedDirectory: "/exchanges/psilink",
};

describe("save-surface field validation", () => {
  test("SFTP requires a non-empty host; directory is optional", () => {
    expect(saveExchangeError("sftp", EMPTY_SAVE_FIELDS)?.field).toBe("host");
    expect(
      saveExchangeError("sftp", { ...EMPTY_SAVE_FIELDS, host: "   " })?.field,
    ).toBe("host");
    expect(
      saveExchangeError("sftp", { ...EMPTY_SAVE_FIELDS, host: "sftp.example" }),
    ).toBeUndefined();
    expect(saveExchangeError("sftp", sftpFields)).toBeUndefined();
  });

  test("filedrop requires an absolute shared directory", () => {
    expect(saveExchangeError("filedrop", EMPTY_SAVE_FIELDS)?.field).toBe(
      "sharedDirectory",
    );
    const relative = saveExchangeError("filedrop", {
      ...EMPTY_SAVE_FIELDS,
      sharedDirectory: "exchanges/psilink",
    });
    expect(relative?.field).toBe("sharedDirectory");
    expect(relative?.message).toContain("absolute");
    expect(saveExchangeError("filedrop", filedropFields)).toBeUndefined();
    expect(
      saveExchangeError("filedrop", {
        ...EMPTY_SAVE_FIELDS,
        sharedDirectory: "C:\\exchanges",
      }),
    ).toBeUndefined();
  });
});

describe("filename derivation", () => {
  test("stamps the local calendar day of the mint moment", () => {
    expect(exchangeFileName(new Date(2026, 6, 8, 15, 32))).toBe(
      "psilink-exchange-2026-07-08.yaml",
    );
    expect(exchangeFileName(new Date(2026, 11, 1, 0, 0))).toBe(
      "psilink-exchange-2026-12-01.yaml",
    );
  });
});

describe("copy is transport-specific", () => {
  test("lead names the transport and the capability statement is explicit", () => {
    expect(saveLeadCopy("sftp")).toContain("over SFTP");
    expect(saveLeadCopy("filedrop")).toContain("over a shared directory");
    expect(saveCapabilityCopy("sftp")).toContain("psilink command-line tool");
    expect(saveCapabilityCopy("sftp")).toContain("does not run SFTP");
    expect(saveCapabilityCopy("filedrop")).toContain(
      "does not run shared-directory",
    );
  });

  test("the SFTP credential alert names what the operator actually supplies", () => {
    const copy = credentialAlertCopy("sftp");
    expect(copy).toContain("Credentials are never stored in this file");
    expect(copy).toContain("SSH username");
    expect(copy).toContain("@file reference");
    expect(copy).toContain("exchange secret");
    // Truthful about what the psilink key file carries -- no longer claims
    // the CLI supplies SSH credentials from its own key file.
    expect(copy).not.toMatch(/supplies them at run time from its own key/);
  });

  test("the filedrop credential alert is untouched: no credentials at all", () => {
    expect(credentialAlertCopy("filedrop")).toBe(
      "A shared-directory exchange carries no credentials at all. The file " +
        "names only the directory both parties can reach.",
    );
  });
});

describe("live-run ledger footer by driver", () => {
  test("every pre-run surface states the shared assurance verbatim", () => {
    expect(PRE_RUN_TRUST_FOOTER).toBe(
      "PII for linkage is encrypted locally before leaving your machine. Your partner " +
        "receives only the fields listed under 'you will send' (step 2 " +
        "above) and only for clients who are in common.",
    );
    // Browser run, server-driven run, and the SFTP/shared-directory save
    // surface all state the same assurance -- it holds for every way an
    // exchange runs, so the surfaces cannot drift.
    expect(liveRunLedgerFooter(false, false)).toBe(PRE_RUN_TRUST_FOOTER);
    expect(liveRunLedgerFooter(true, false)).toBe(PRE_RUN_TRUST_FOOTER);
    expect(saveTrustFooter()).toBe(PRE_RUN_TRUST_FOOTER);
  });

  test("the settled copy differs only in the literal this-browser claim", () => {
    expect(liveRunLedgerFooter(false, true)).toBe(
      "Your file never left this browser. The results above are all your " +
        "partner received about your data.",
    );
    expect(liveRunLedgerFooter(true, true)).toBe(
      "The results above are all your partner received about your data.",
    );
  });
});

describe("the run command names the minted config file", () => {
  test("interpolates the exact filename with --config-file, ahead of --invitation", () => {
    expect(runCommand("psilink-exchange-2026-07-10.yaml")).toBe(
      "psilink exchange your-data.csv --config-file " +
        "psilink-exchange-2026-07-10.yaml --invitation @invitation-code.txt",
    );
  });

  test("a re-save's new date-derived filename flows straight through", () => {
    expect(runCommand(exchangeFileName(new Date(2026, 11, 25)))).toBe(
      "psilink exchange your-data.csv --config-file " +
        "psilink-exchange-2026-12-25.yaml --invitation @invitation-code.txt",
    );
  });
});

describe("endpoint and config derive from one locator", () => {
  test("SFTP request and config carry the authored host and path", () => {
    const request = endpointRequestFor("sftp", sftpFields);
    expect(request).toEqual({
      channel: "sftp",
      host: "sftp.riverbend.example.gov",
      path: "/exchanges/psilink",
    });
    const input = exchangeFileInputFor("sftp", sftpFields, invitationStub());
    expect(input.connection).toEqual({
      channel: "sftp",
      host: "sftp.riverbend.example.gov",
      path: "/exchanges/psilink",
    });
    // The config's terms, metadata, and disclosed set are read off the same
    // minted invitation the code came from -- config and token agree. The
    // disclosed set equals the STUB's own field (["case_number"]), not
    // disclosedColumnNames(metadata) (["program_code"]): this only holds
    // under a verbatim pass-through of invitation.disclosedPayloadColumns.
    expect(input.linkageTerms).toBe(terms);
    expect(input.metadata).toBe(metadata);
    expect(input.disclosedPayloadColumns).toEqual(["case_number"]);
  });

  test("an empty disclosed set is carried through, not omitted", () => {
    const input = exchangeFileInputFor(
      "sftp",
      sftpFields,
      invitationStub({ disclosedPayloadColumns: [] }),
    );
    expect(input.disclosedPayloadColumns).toEqual([]);
  });

  test("an empty remote directory is omitted, not sent as an empty path", () => {
    const fields = { ...sftpFields, remoteDirectory: "" };
    expect(endpointRequestFor("sftp", fields)).toEqual({
      channel: "sftp",
      host: "sftp.riverbend.example.gov",
    });
    expect(
      exchangeFileInputFor("sftp", fields, invitationStub()).connection,
    ).toEqual({ channel: "sftp", host: "sftp.riverbend.example.gov" });
  });

  test("filedrop request and config carry the shared directory only", () => {
    expect(endpointRequestFor("filedrop", filedropFields)).toEqual({
      channel: "filedrop",
      path: "/exchanges/psilink",
    });
    expect(
      exchangeFileInputFor("filedrop", filedropFields, invitationStub())
        .connection,
    ).toEqual({ channel: "filedrop", path: "/exchanges/psilink" });
  });
});
