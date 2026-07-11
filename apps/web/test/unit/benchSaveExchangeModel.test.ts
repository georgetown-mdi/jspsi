import { describe, expect, test } from "vitest";

import {
  EMPTY_SAVE_FIELDS,
  credentialAlertCopy,
  endpointRequestFor,
  exchangeFileInputFor,
  exchangeFileName,
  liveRunLedgerFooter,
  runCommand,
  saveCapabilityCopy,
  saveExchangeError,
  saveLeadCopy,
} from "@bench/saveExchangeModel";

import type { LinkageTerms, Metadata } from "@psilink/core";
import type { GeneratedInvitation } from "@psi/invitation";
import type { SaveExchangeFields } from "@bench/saveExchangeModel";

const terms = {
  identity: "Dana",
  linkageKeys: [{ name: "key 1", elements: [] }],
} as unknown as LinkageTerms;

// Two columns, one disclosed (`program_code`, isPayload) and one match-only
// (`dob`): the disclosed set the exchange file's commitment must equal is
// exactly the disclosed subset (see disclosedColumnNames / isDisclosedToPartner).
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
  test("a browser-local run keeps the never-uploaded assurance verbatim", () => {
    expect(liveRunLedgerFooter(false, false)).toBe(
      "Your file stays in this browser. Nothing is uploaded; your partner " +
        "receives only what this ledger names.",
    );
    expect(liveRunLedgerFooter(false, true)).toBe(
      "Your file never left this browser. The results above are all your " +
        "partner received about your data.",
    );
  });

  test("a server-job run drops the never-uploaded claim (the file is sent to the appliance)", () => {
    for (const hasResult of [false, true]) {
      const footer = liveRunLedgerFooter(true, hasResult);
      expect(footer).not.toContain("uploaded");
      expect(footer).not.toContain("never left this browser");
      expect(footer).not.toContain("stays in this browser");
    }
    expect(liveRunLedgerFooter(true, false)).toContain(
      "Your partner receives only what this ledger names",
    );
    expect(liveRunLedgerFooter(true, true)).toContain(
      "all your partner received about your data",
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
    // minted invitation the code came from -- config and token agree.
    expect(input.linkageTerms).toBe(terms);
    expect(input.metadata).toBe(metadata);
    expect(input.disclosedPayloadColumns).toEqual(["program_code"]);
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
