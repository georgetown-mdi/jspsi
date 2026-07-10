import { describe, expect, test } from "vitest";

import {
  EMPTY_SAVE_FIELDS,
  endpointRequestFor,
  exchangeFileInputFor,
  exchangeFileName,
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
