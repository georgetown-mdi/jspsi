import crypto from "node:crypto";

/**
 * The resolved job-API configuration read from the environment. The job API is a
 * console-appliance feature that runs inside one party's trust boundary, gated
 * off by default so a hosted deployment never exposes it.
 */
export interface JobApiConfig {
  /** The data root under which per-job workdirs are created. Empty means the API
   * is disabled. */
  dataRoot: string;
  /** The bearer token; empty means no auth (loopback-only, enforced at startup). */
  token: string;
}

/** The environment variable names the job API reads. */
export const JOB_DATA_ROOT_ENV = "JOB_DATA_ROOT";
export const JOB_API_TOKEN_ENV = "JOB_API_TOKEN";

/** Read the job-API configuration from an environment map. */
export function readJobApiConfig(
  env: NodeJS.ProcessEnv = process.env,
): JobApiConfig {
  return {
    dataRoot: (env[JOB_DATA_ROOT_ENV] ?? "").trim(),
    token: env[JOB_API_TOKEN_ENV] ?? "",
  };
}

/** Whether the job API is enabled (a data root is configured). */
export function isJobApiEnabled(config: JobApiConfig): boolean {
  return config.dataRoot.length > 0;
}

/**
 * The three gate outcomes a job route resolves before doing any work:
 * - `disabled`: the feature gate is off -> the route answers 404 and spawns
 *   nothing (indistinguishable from an unknown route to a hosted probe).
 * - `unauthorized`: the token is required and the request did not present a
 *   matching bearer -> 401.
 * - `allowed`: proceed.
 */
export type GateResult = "disabled" | "unauthorized" | "allowed";

/**
 * Gate a request: enforce the feature gate, then the bearer-token auth when a
 * token is configured. The token comparison is constant-time to avoid leaking the
 * token through response timing. A disabled API reports `disabled` (mapped to
 * 404) without ever consulting the token, so the presence of the API is not
 * observable to an unauthenticated probe.
 */
export function gateRequest(
  config: JobApiConfig,
  authorizationHeader: string | null,
): GateResult {
  if (!isJobApiEnabled(config)) return "disabled";
  if (config.token.length === 0) return "allowed";
  const presented = bearerFromHeader(authorizationHeader);
  if (presented === null) return "unauthorized";
  return constantTimeEquals(presented, config.token)
    ? "allowed"
    : "unauthorized";
}

/** Extract the bearer credential from an `Authorization` header, or null. */
function bearerFromHeader(header: string | null): string | null {
  if (header === null) return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match === null ? null : match[1];
}

/**
 * Constant-time string comparison. `crypto.timingSafeEqual` requires equal-length
 * buffers, so unequal lengths are compared against a fixed-length digest of each
 * side (never short-circuiting on length), keeping the comparison timing
 * independent of where a mismatch falls.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const aDigest = crypto.createHash("sha256").update(a, "utf8").digest();
  const bDigest = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(aDigest, bDigest);
}

/**
 * Whether a bind host is a loopback address. A non-loopback bind with the job API
 * enabled and no token is a fail-closed startup error; a loopback bind without a
 * token is allowed (the appliance case).
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined || host === "") {
    // No explicit host: the server default binds all interfaces, which is not
    // loopback. Fail closed rather than assume loopback.
    return false;
  }
  const normalized = host.trim().toLowerCase();
  if (normalized === "localhost") return true;
  if (normalized === "::1" || normalized === "[::1]") return true;
  if (normalized.startsWith("127.")) return true;
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
 * Fail-closed startup check: if the job API is enabled on a non-loopback bind
 * without a token, refuse to start. A hosted deployment that turns the API on
 * without an auth token would otherwise expose an unauthenticated CLI driver on a
 * public interface. Returns normally when the configuration is safe (disabled,
 * loopback, or token-protected).
 */
export function assertJobApiStartupSafe(
  config: JobApiConfig,
  bindHost: string | undefined,
): void {
  if (!isJobApiEnabled(config)) return;
  if (config.token.length > 0) return;
  if (isLoopbackHost(bindHost)) return;
  throw new JobApiConfigError(
    `${JOB_DATA_ROOT_ENV} enables the job API but ${JOB_API_TOKEN_ENV} is unset ` +
      `and the bind host (${bindHost ?? "all interfaces"}) is not loopback; ` +
      "set a token or bind to loopback. Refusing to start with an " +
      "unauthenticated job API on a non-loopback interface.",
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

/** Build an empty job-API response (for a 204/404/401) with the no-store header. */
export function jobEmptyResponse(status: number): Response {
  return new Response(null, {
    status,
    headers: { ...JOB_RESPONSE_HEADERS },
  });
}
