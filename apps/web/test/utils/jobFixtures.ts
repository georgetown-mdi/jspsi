import { fileURLToPath } from "node:url";
import path from "node:path";

import { getDefaultLinkageTerms } from "@psilink/core";

import type {
  JobFiledropExchangeIntent,
  JobInputFileReference,
  JobSftpExchangeIntent,
} from "@jobs/intent";
import type {
  JobSftpRemoteEntry,
  JobSftpRemotesTable,
} from "@jobs/sftpRemotes";
import type { LinkageTerms } from "@psilink/core";

/** The stub CLI the driver tests point JOB_CLI_BINARY at. */
export const STUB_CLI_PATH = fileURLToPath(
  new URL("./stubCli.mjs", import.meta.url),
);

/** A base64url shared secret matching the CLI key-file shape (43 chars). */
export const VALID_SHARED_SECRET = "A".repeat(42) + "A";

/** A complete, schema-valid linkage-terms document for job intents. */
export function validLinkageTerms(): LinkageTerms {
  return {
    ...getDefaultLinkageTerms("test-org"),
    date: "2026-07-11",
  };
}

/** A valid filedrop job intent; overrides merge over the base. */
export function validIntent(
  overrides: Partial<JobFiledropExchangeIntent> = {},
): JobFiledropExchangeIntent {
  return {
    channel: "filedrop",
    linkageTerms: validLinkageTerms(),
    sharedSecret: VALID_SHARED_SECRET,
    inputCsv: "ssn,last_name,date_of_birth\n111223333,smith,1990-01-01\n",
    ...overrides,
  };
}

/** A static, schema-valid `inputFile` reference for the pure intent-schema tests
 * (no file on disk; the manager tests build a real one). */
export const SAMPLE_INPUT_FILE_REF: JobInputFileReference = {
  name: "input.csv",
  sizeBytes: 42,
  modifiedAt: 1_720_000_000_000,
};

/** A valid filedrop job intent driven by a mounted `inputFile` reference (no inline
 * `inputCsv`); overrides merge over the base. */
export function validInputFileIntent(
  inputFile: JobInputFileReference = SAMPLE_INPUT_FILE_REF,
  overrides: Partial<JobFiledropExchangeIntent> = {},
): JobFiledropExchangeIntent {
  return {
    channel: "filedrop",
    linkageTerms: validLinkageTerms(),
    sharedSecret: VALID_SHARED_SECRET,
    inputFile,
    ...overrides,
  };
}

/** The remote name {@link testSftpRemotesTable} provisions. */
export const TEST_SFTP_REMOTE_NAME = "prod_east";

/** A canonical-format host-key fingerprint (43 standard base64 chars). */
export const TEST_HOST_KEY_FINGERPRINT = `SHA256:${"A".repeat(43)}`;

/** A valid sftp job intent naming the fixture remote; overrides merge over it. */
export function validSftpIntent(
  overrides: Partial<JobSftpExchangeIntent> = {},
): JobSftpExchangeIntent {
  return {
    channel: "sftp",
    remote: TEST_SFTP_REMOTE_NAME,
    linkageTerms: validLinkageTerms(),
    sharedSecret: VALID_SHARED_SECRET,
    inputCsv: "ssn,last_name,date_of_birth\n111223333,smith,1990-01-01\n",
    ...overrides,
  };
}

/** A boot-shape remote entry: @path credential, pinned fingerprint. */
export function testSftpRemoteEntry(): JobSftpRemoteEntry {
  return {
    host: "sftp.example.org",
    port: 2222,
    username: "linkage",
    path: "/exchange",
    password: "@/etc/psilink/prod-east-password",
    hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
  };
}

/** A one-entry remotes table keyed by {@link TEST_SFTP_REMOTE_NAME}. */
export function testSftpRemotesTable(): JobSftpRemotesTable {
  return new Map([[TEST_SFTP_REMOTE_NAME, testSftpRemoteEntry()]]);
}

/** A throwaway data-root directory path unique per call (not created here). */
export function tempDataRoot(label: string): string {
  return path.join(
    process.env.TMPDIR ?? "/tmp",
    `psilink-jobs-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}
