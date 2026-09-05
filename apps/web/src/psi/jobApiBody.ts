import { readBoundedJsonBody } from "@utils/boundedJsonBody";

/**
 * Body-shape helpers shared by the same-origin job-API clients: the one bounded
 * read every client answer goes through, the per-endpoint byte caps that read
 * takes, and the narrowing both the work-input and SFTP-authoring clients apply
 * before reading fields off a body.
 *
 * The bound holds what an answer that is not this endpoint's -- a proxy's error
 * page, a truncated stream, a console at a different version -- can cost the
 * operator's tab: a bounded read and the client's own malformed-body state,
 * never an unbounded buffer. `Response.json()` is banned across src/ and
 * server/ so a new client cannot read one unbounded (apps/web/eslint.config.js;
 * scripts/eslint-web-json-parse-ban.test.mjs for its reach). What fixes each cap
 * below: docs/spec/SERVER_JOB_API.md, Size caps.
 */

/**
 * The cap on a fixed-shape status body: `GET /api/jobs/:jobId`, the `{ id }` of
 * a created or busy `POST /api/jobs`, `GET /api/jobs/slot`,
 * `GET /api/jobs/rendezvous`, `POST /api/jobs/signing/fingerprint`,
 * `POST /api/jobs/sftp/probe`, and the `{ error }` body a 400 carries. Every
 * field in these is a boolean, a number, a closed-set member, a job id, a
 * fingerprint, or one bounded path or fixed-text message, so the widest of them
 * is a few hundred bytes; 16 KiB is headroom over that, not a shape check.
 */
export const MAX_JOB_STATUS_RESPONSE_BYTES = 16 * 1024;

/**
 * The cap on the SFTP connection projection (`GET`/`PUT /api/jobs/sftp`). Its
 * host, paths, and credential warnings are echoes of the connection the operator
 * authored, whose request body the route already caps at
 * `MAX_SFTP_AUTHOR_BODY_BYTES` (64 KiB), so the projection cannot outgrow that
 * cap and this one matches it.
 */
export const MAX_SFTP_CONNECTION_RESPONSE_BYTES = 64 * 1024;

/**
 * The cap on the recurring-run hand-off (`GET /api/jobs/:jobId/handoff`), whose
 * `template` is the `psilink.yaml` text or the argv of the command the operator
 * would schedule. Its length follows the create intent's linkage terms and
 * standardization, which the intent schema bounds in element count but not in
 * bytes -- so 1 MiB is headroom over any template that schema admits rather than
 * a figure the code fixes.
 */
export const MAX_JOB_HANDOFF_RESPONSE_BYTES = 1024 ** 2;

/**
 * The cap on the variable-length bodies: the mounted-input listing
 * (`GET /api/jobs/inputs`), the secrets-mount entries
 * (`GET /api/jobs/mounts/secrets/entries`), one file's profile
 * (`GET /api/jobs/inputs/profile`), and the coverage rates
 * (`POST /api/jobs/inputs/coverage`). What decides the length of each is the
 * operator's own mount contents or CSV header, which no code bound fixes, so
 * 8 MiB is headroom -- far above any directory or header a console prototype
 * runs against, and far below what buffering an unbounded stream would cost.
 */
export const MAX_JOB_LISTING_RESPONSE_BYTES = 8 * 1024 ** 2;

/**
 * Thrown by {@link readBoundedJson} when a console answer cannot be read: it
 * exceeded its byte cap, or it was absent, not valid UTF-8, not valid JSON, or
 * past the structural bound `parseBoundedJson` enforces. The message is fixed
 * text holding no body bytes. Most callers catch it into their own
 * "unanswered"/"error" state; the two that let it propagate (`createJob` and
 * `fetchRecordAvailability` in serverJobExchangeDriver) already handle the
 * `SyntaxError` an unreadable body threw before, and classify this the same way.
 */
export class JobApiBodyError extends Error {
  constructor(kind: "too-large" | "invalid") {
    super(
      kind === "too-large"
        ? "The console's answer exceeded the size this request reads"
        : "The console's answer was not readable JSON",
    );
    this.name = "JobApiBodyError";
  }
}

/**
 * Read a console answer's body as JSON under `maxBytes`, the one route every
 * job-API client takes to a decoded body. Throws {@link JobApiBodyError} on an
 * over-cap or unreadable body, where `Response.json()` threw a `SyntaxError`, so
 * a caller's existing catch keeps mapping it to the same state.
 */
export async function readBoundedJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const result = await readBoundedJsonBody(response, maxBytes);
  if (result.kind !== "parsed") throw new JobApiBodyError(result.kind);
  return result.value;
}

/** Narrow a decoded body to a plain object, excluding null and arrays, so a
 * caller can read named fields off it. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Decode a response body as JSON under `maxBytes`, or null when it is empty,
 * over the cap, or not JSON (an error response may have no body). */
export async function readJsonOrNull(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const result = await readBoundedJsonBody(response, maxBytes);
  return result.kind === "parsed" ? result.value : null;
}
