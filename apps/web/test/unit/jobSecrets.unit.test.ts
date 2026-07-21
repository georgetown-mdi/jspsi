import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { JOB_SECRETS_DIR_ENV, useJobSecretsDir } from "@jobs/jobSecrets";

// The secrets mount resolver mirrors useJobInputDir/useJobRendezvousDir EXCEPT it
// has no JOB_DATA_ROOT fallback: an unset variable leaves the mount unavailable
// rather than defaulting the secrets surface into the client-writable data root.

afterEach(() => {
  (globalThis as { jobSecretsDirConfig?: unknown }).jobSecretsDirConfig =
    undefined;
});

describe("useJobSecretsDir", () => {
  test("resolves the configured directory to an absolute path", () => {
    expect(useJobSecretsDir({ [JOB_SECRETS_DIR_ENV]: "/run/secrets" })).toBe(
      path.resolve("/run/secrets"),
    );
  });

  test("is undefined when unset -- NO data-root fallback", () => {
    expect(useJobSecretsDir({ JOB_DATA_ROOT: "/srv/data" })).toBeUndefined();
  });

  test("is undefined for a whitespace-only value", () => {
    expect(useJobSecretsDir({ [JOB_SECRETS_DIR_ENV]: "   " })).toBeUndefined();
  });

  test("memoizes the resolution across calls", () => {
    const first = useJobSecretsDir({ [JOB_SECRETS_DIR_ENV]: "/run/secrets" });
    // A later call with a different env still returns the memoized resolution.
    expect(useJobSecretsDir({ [JOB_SECRETS_DIR_ENV]: "/elsewhere" })).toBe(
      first,
    );
  });
});
