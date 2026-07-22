import { MAX_INPUT_CSV_LENGTH } from "./intent";

import { isJobApiEnabled, jobEmptyResponse, readJobApiConfig } from "./gate";
import { isValidJobId } from "./workdir";
import { useJobManager } from "./index";

import type { JobManager } from "./jobManager";

/**
 * The outcome of gating a job route: either a short-circuit {@link Response} the
 * handler returns as-is, or the resolved {@link JobManager} to proceed with. A
 * disabled API yields 404, indistinguishable from an unknown route.
 */
export type GateOutcome =
  | { kind: "response"; response: Response }
  | { kind: "manager"; manager: JobManager };

/**
 * Gate a job route: read config, enforce the feature gate, and resolve the
 * manager. Every job route calls this first, before any filesystem use or spawn.
 * The API is reached only from the operator's own machine (the deployment
 * publishes to host loopback), so there is no per-request auth beyond the
 * feature gate.
 */
export function gateJobRoute(): GateOutcome {
  const config = readJobApiConfig();
  if (!isJobApiEnabled(config))
    return { kind: "response", response: jobEmptyResponse(404) };
  const manager = useJobManager(config);
  if (manager === null)
    return { kind: "response", response: jobEmptyResponse(404) };
  return { kind: "manager", manager };
}

/**
 * The boundary byte cap on a `POST /api/jobs` body: a memory bound on the
 * streamed read. It sits well above the JSON-encoded size of a realistic
 * schema-valid intent -- real CSV text barely grows under JSON string escaping,
 * so a max-length `inputCsv` ({@link MAX_INPUT_CSV_LENGTH}) plus the other
 * capped fields stays comfortably under this cap and reaches a clean schema
 * error rather than a `413`. It is NOT sized to clear a pathological payload of
 * control characters that each escape to a 6-byte `\uXXXX` sequence: such input
 * is not valid CSV, and bounding it here is the memory guard doing its job. The
 * uncapped standardization `params` is likewise bounded only by this cap.
 */
export const MAX_JOB_BODY_BYTES = 224 * 1024 ** 2;

/**
 * The byte cap on a `PUT /api/jobs/sftp` authoring body: a small memory bound on
 * the streamed read. The body is a handful of connection fields plus an `@path`
 * credential reference -- no file content ever rides it -- so this stays tight;
 * an oversized body is a `413` before any parse.
 */
export const MAX_SFTP_AUTHOR_BODY_BYTES = 64 * 1024;

/**
 * The outcome of reading a job request body under a byte cap:
 * - `too-large`: the body exceeded the cap (mapped to 413).
 * - `invalid`: the body was absent or was not valid JSON (mapped to 400).
 * - `parsed`: the decoded JSON value.
 */
export type JobRequestBodyResult =
  | { kind: "too-large" }
  | { kind: "invalid" }
  | { kind: "parsed"; value: unknown };

/**
 * Read a request body as JSON under a hard byte cap, without trusting
 * `Content-Length` (absent or understated on a chunked request). The body is
 * streamed through {@link ReadableStream.getReader}; each chunk's `byteLength`
 * adds to a running total, and the read aborts the moment the total EXCEEDS
 * `maxBytes` -- the whole body is never buffered first. On abort the reader is
 * cancelled to free the connection. The accumulated bytes are decoded and parsed
 * here (the stream is consumed, so `request.json()` is no longer available).
 *
 * Pure over its arguments (no global fetch), so a test can drive it with any
 * `Request` and a small `maxBytes` to exercise the boundary.
 */
export async function readJobRequestBody(
  request: Request,
  maxBytes: number,
): Promise<JobRequestBodyResult> {
  const body = request.body;
  if (body === null) return { kind: "invalid" };
  const reader = body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { kind: "too-large" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(merged));
  } catch {
    return { kind: "invalid" };
  }
  return { kind: "parsed", value };
}

/**
 * Validate a route's job-id parameter. Returns null when the id is malformed, so
 * the caller answers 404 without touching the filesystem. Validating the id
 * shape on every route before any filesystem use is the traversal guard.
 */
export function validateJobIdParam(jobId: unknown): string | null {
  if (typeof jobId !== "string" || !isValidJobId(jobId)) return null;
  return jobId;
}
