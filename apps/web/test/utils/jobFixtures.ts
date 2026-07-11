import { fileURLToPath } from "node:url";
import path from "node:path";

import { getDefaultLinkageTerms } from "@psilink/core";

import type { JobExchangeIntent } from "@jobs/intent";
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

/** A valid job intent; overrides merge over the base. */
export function validIntent(
  overrides: Partial<JobExchangeIntent> = {},
): JobExchangeIntent {
  return {
    channel: "filedrop",
    linkageTerms: validLinkageTerms(),
    sharedSecret: VALID_SHARED_SECRET,
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
