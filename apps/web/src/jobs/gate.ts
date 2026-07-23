/**
 * The resolved job-API configuration read from the environment. The job API is a
 * console-appliance feature that runs inside one party's trust boundary. It is
 * enabled only in a `console` deployment build with a data root configured; a
 * hosted build serves every job route disabled (404) whatever the data root, so
 * the public deployment can never run the server-side job driver.
 */
export interface JobApiConfig {
  /** The data root under which per-job workdirs are created. Empty means the API
   * is disabled. */
  dataRoot: string;
  /** Whether this deployment build is the console appliance (its
   * `VITE_DEPLOYMENT_PROFILE` is `console`). The job API is enabled only in a
   * console build. */
  consoleProfile: boolean;
  /** Extra request `Host` hostnames the gate accepts beyond the loopback literals
   * -- an operator's escape hatch for a deliberate reverse-proxy or LAN-name
   * front. Lowercased, empties dropped; empty by default. */
  allowedHosts: ReadonlySet<string>;
}

/** The environment variable naming the data root the job API creates workdirs
 * under. */
export const JOB_DATA_ROOT_ENV = "JOB_DATA_ROOT";

/** The environment variable listing extra `Host` hostnames (comma-separated) the
 * job API accepts beyond the loopback literals, for an operator who deliberately
 * fronts the console behind a reverse proxy or reaches it by a LAN name. */
export const JOB_ALLOWED_HOSTS_ENV = "JOB_ALLOWED_HOSTS";

/**
 * The build-time deployment-profile variable, read server-side the same way the
 * client reads it (see utils/clientConfig.ts). The console image sets it to
 * `console` (a `Dockerfile` `ENV`, so it persists to the container runtime); a
 * hosted build leaves it unset. Reading the one signal on both sides keeps the
 * server gate from drifting from the client build -- a second, server-only
 * variable could fall out of sync and is a security hazard.
 */
export const DEPLOYMENT_PROFILE_ENV = "VITE_DEPLOYMENT_PROFILE";

/** The deployment-profile value that identifies the console appliance build. */
export const CONSOLE_PROFILE = "console";

/** Parse a comma-separated `JOB_ALLOWED_HOSTS` value into a lowercased hostname
 * set, trimming each entry and dropping empties. */
function parseAllowedHosts(value: string): ReadonlySet<string> {
  return new Set(
    value
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host.length > 0),
  );
}

/** Read the job-API configuration from an environment map. */
export function readJobApiConfig(
  env: NodeJS.ProcessEnv = process.env,
): JobApiConfig {
  return {
    dataRoot: (env[JOB_DATA_ROOT_ENV] ?? "").trim(),
    consoleProfile:
      (env[DEPLOYMENT_PROFILE_ENV] ?? "").trim() === CONSOLE_PROFILE,
    allowedHosts: parseAllowedHosts(env[JOB_ALLOWED_HOSTS_ENV] ?? ""),
  };
}

/**
 * Whether the job API is enabled: a data root is configured AND this is a console
 * build. A hosted build (any non-`console` profile, unset included) serves every
 * job route disabled (404) regardless of `JOB_DATA_ROOT` -- the app-layer
 * backstop that keeps the unauthenticated server-side driver out of the public
 * deployment. A pure function of its argument (no environment access), so the
 * invariant is unit-testable without env mocking.
 */
export function isJobApiEnabled(config: JobApiConfig): boolean {
  return config.dataRoot.length > 0 && config.consoleProfile;
}

/** A configuration error surfaced at server startup. */
export class JobApiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobApiConfigError";
  }
}

/**
 * The response headers every job-API response carries: `Cache-Control: no-store`
 * so a job status, event stream, or result is never cached, and NO CORS headers
 * (the job API is same-origin appliance-local; a cross-origin caller must not be
 * granted access). The security response headers the server entry already applies
 * globally are additive to these.
 */
export const JOB_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
};

/** Build a JSON job-API response with the no-store header applied. */
export function jobJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...JOB_RESPONSE_HEADERS,
    },
  });
}

/** Build an empty job-API response (for a 204/404) with the no-store header. */
export function jobEmptyResponse(status: number): Response {
  return new Response(null, {
    status,
    headers: { ...JOB_RESPONSE_HEADERS },
  });
}
