import {
  ALLOW_MISSING_PREREQUISITES_ENV,
  prerequisitesAreRequired,
} from "@psilink/testkit/prerequisiteGate";
import { loopbackTlsCert } from "@psilink/testkit/loopbackTlsCert";

export { ALLOW_MISSING_PREREQUISITES_ENV, prerequisitesAreRequired };

// A suite that skips when a tool the environment did not supply is missing is
// only accurate while the skip is visible. `apps/web/test/integration/requireProdBuild.ts`
// makes that case loud for an artifact the run itself builds; this is the same
// guard for a prerequisite the ENVIRONMENT supplies, and it is registered at the
// ROOT `test` block of vite.config.ts -- the whole run's config rather than one
// project's -- so every project, including one added later, is gated by it.
//
// Two outcomes, decided by where the run happens. Where nothing promises the
// prerequisite (a workstation without `openssl`), the run continues and names the
// missing prerequisite on the console, so the skip is never silent. Where the
// environment is supposed to supply it -- a CI runner provisioned to a spec --
// the run fails instead of reporting a pass over legs that did not execute.

/** Something a suite needs from its environment, not from this repository. */
export interface TestPrerequisite {
  /** Operator-facing name, e.g. "loopback TLS certificate". */
  name: string;
  /** Whether this environment supplied it. */
  available: boolean;
  /** The coverage the run loses without it. */
  covers: string;
  /** How to supply it. */
  remedy: string;
}

/** The operator-facing description of what is missing and what it costs. */
export function describeMissingPrerequisites(
  missing: ReadonlyArray<TestPrerequisite>,
): string {
  return missing
    .map(
      (prerequisite) =>
        `${prerequisite.name}: ${prerequisite.covers} will not run.\n` +
        `  Supply it with: ${prerequisite.remedy}`,
    )
    .join("\n");
}

/**
 * Report every unavailable prerequisite, and fail the run where this
 * environment was supposed to supply one.
 */
export function requireTestPrerequisites(
  prerequisites: ReadonlyArray<TestPrerequisite>,
  env: NodeJS.ProcessEnv = process.env,
  report: (message: string) => void = console.warn,
): void {
  const missing = prerequisites.filter(
    (prerequisite) => !prerequisite.available,
  );
  if (missing.length === 0) return;

  const detail = describeMissingPrerequisites(missing);
  if (prerequisitesAreRequired(env)) {
    throw new Error(
      `Test prerequisites this environment is supposed to supply are missing, ` +
        `so the suites needing them would skip and the run would report a pass ` +
        `over coverage it never had.\n${detail}\n` +
        `Set ${ALLOW_MISSING_PREREQUISITES_ENV}=1 to skip those legs deliberately.`,
    );
  }
  report(
    `[test-prerequisite] Missing here, so some legs are skipped and this run ` +
      `covers less than the suite does.\n${detail}`,
  );
}

/** What the web suites need from the environment they run in. */
export function webTestPrerequisites(): Array<TestPrerequisite> {
  return [
    {
      name: "loopback TLS certificate",
      available: loopbackTlsCert !== null,
      covers:
        "the signaling suites' HTTPS legs (upgrade hardening and socket guards over TLS)",
      remedy:
        "an `openssl` that mints a self-signed EC certificate (`openssl req -x509 -newkey ec ...`); a LibreSSL build takes those flags differently",
    },
  ];
}

/** The vitest `globalSetup` entry point. */
export default function setup(): void {
  requireTestPrerequisites(webTestPrerequisites());
}
