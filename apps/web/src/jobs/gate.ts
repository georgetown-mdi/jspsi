import net from "node:net";

/**
 * The resolved job-API configuration read from the environment. The job API is a
 * console-appliance feature that runs inside one party's trust boundary, gated
 * off by default so a hosted deployment never exposes it.
 */
export interface JobApiConfig {
  /** The data root under which per-job workdirs are created. Empty means the API
   * is disabled. */
  dataRoot: string;
}

/** The environment variable names the job API reads. */
export const JOB_DATA_ROOT_ENV = "JOB_DATA_ROOT";

/** Read the job-API configuration from an environment map. */
export function readJobApiConfig(
  env: NodeJS.ProcessEnv = process.env,
): JobApiConfig {
  return {
    dataRoot: (env[JOB_DATA_ROOT_ENV] ?? "").trim(),
  };
}

/** Whether the job API is enabled (a data root is configured). */
export function isJobApiEnabled(config: JobApiConfig): boolean {
  return config.dataRoot.length > 0;
}

/**
 * Whether a bind host is a loopback address. The job API is unauthenticated by
 * design (a single local operator), so a non-loopback bind with it enabled is a
 * fail-closed startup error and only a loopback bind runs the API.
 *
 * A host is loopback only when it is the literal `localhost` or an IP literal in a
 * loopback range. A `127.`-prefixed value must parse as a real IPv4 literal: a
 * hostname such as `127.example.com` is NOT loopback (it can resolve to a public
 * address), so it must fail closed rather than pass the startup gate on the
 * string prefix alone. Anything that is neither `localhost` nor a recognized IP
 * literal is treated as non-loopback.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined || host === "") {
    // No explicit host: the server default binds all interfaces, which is not
    // loopback. Fail closed rather than assume loopback.
    return false;
  }
  const normalized = host.trim().toLowerCase();
  if (normalized === "localhost") return true;
  const literal =
    normalized.startsWith("[") && normalized.endsWith("]")
      ? normalized.slice(1, -1)
      : normalized;
  if (net.isIPv4(literal)) return literal.startsWith("127.");
  if (net.isIPv6(literal))
    return literal === "::1" || literal === "0:0:0:0:0:0:0:1";
  return false;
}

/** A configuration error surfaced at server startup. */
export class JobApiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobApiConfigError";
  }
}

/**
 * Fail-closed startup check: if the job API is enabled on a non-loopback bind,
 * refuse to start. The API is unauthenticated by design (a single local
 * operator), so a non-loopback bind would expose an unauthenticated CLI driver on
 * a public interface. Returns normally when the configuration is safe (disabled or
 * loopback).
 */
export function assertJobApiStartupSafe(
  config: JobApiConfig,
  bindHost: string | undefined,
): void {
  if (!isJobApiEnabled(config)) return;
  if (isLoopbackHost(bindHost)) return;
  throw new JobApiConfigError(
    `${JOB_DATA_ROOT_ENV} enables the job API but the bind host ` +
      `(${bindHost ?? "all interfaces"}) is not loopback; bind the server to ` +
      "loopback (HOST=127.0.0.1). Refusing to start an unauthenticated job API " +
      "on a non-loopback interface.",
  );
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
