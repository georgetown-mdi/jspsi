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
