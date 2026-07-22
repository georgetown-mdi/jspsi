import { fileURLToPath } from "node:url";
import path from "node:path";

import { getDefaultLinkageTerms } from "@psilink/core";

import type {
  JobFiledropExchangeIntent,
  JobInputFileReference,
  JobSftpExchangeIntent,
  JobZeroSetupFiledropIntent,
  JobZeroSetupSftpIntent,
} from "@jobs/intent";
import type { JobSftpServerEntry } from "@jobs/sftpServer";
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

/** A would-be remote-name string, used only by the tests that assert a sent
 * `remote` field is rejected as an unknown key (the sftp arm carries none). */
export const TEST_SFTP_REMOTE_NAME = "prod_east";

/** A canonical-format host-key fingerprint (43 standard base64 chars). */
export const TEST_HOST_KEY_FINGERPRINT = `SHA256:${"A".repeat(43)}`;

/** A valid sftp job intent (no connection field); overrides merge over it. */
export function validSftpIntent(
  overrides: Partial<JobSftpExchangeIntent> = {},
): JobSftpExchangeIntent {
  return {
    channel: "sftp",
    linkageTerms: validLinkageTerms(),
    sharedSecret: VALID_SHARED_SECRET,
    inputCsv: "ssn,last_name,date_of_birth\n111223333,smith,1990-01-01\n",
    ...overrides,
  };
}

/** A sample SFTP server entry (an @path credential, a pinned fingerprint) for the
 * compose/argv tests that take an entry directly. */
export function testSftpServerEntry(): JobSftpServerEntry {
  return {
    host: "sftp.example.org",
    port: 2222,
    username: "linkage",
    path: "/exchange",
    password: "@/etc/psilink/prod-east-password",
    hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
  };
}

/** A valid filedrop zero-setup intent (no shared secret, no linkage terms);
 * overrides merge over the base. */
export function validZeroSetupIntent(
  overrides: Partial<JobZeroSetupFiledropIntent> = {},
): JobZeroSetupFiledropIntent {
  return {
    mode: "zeroSetup",
    channel: "filedrop",
    inputCsv: "ssn,last_name,date_of_birth\n111223333,smith,1990-01-01\n",
    ...overrides,
  };
}

/** A valid sftp zero-setup intent (no connection field, no secret/terms);
 * overrides merge over it. */
export function validZeroSetupSftpIntent(
  overrides: Partial<JobZeroSetupSftpIntent> = {},
): JobZeroSetupSftpIntent {
  return {
    mode: "zeroSetup",
    channel: "sftp",
    inputCsv: "ssn,last_name,date_of_birth\n111223333,smith,1990-01-01\n",
    ...overrides,
  };
}

/** A throwaway data-root directory path unique per call (not created here). */
export function tempDataRoot(label: string): string {
  return path.join(
    process.env.TMPDIR ?? "/tmp",
    `psilink-jobs-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}
