import {
  DISPLAY_TRUNCATION_MARKER,
  HOST_KEY_FINGERPRINT_REGEX,
} from "@psilink/core";

import {
  MAX_JOB_LISTING_RESPONSE_BYTES,
  MAX_JOB_STATUS_RESPONSE_BYTES,
  MAX_SFTP_CONNECTION_RESPONSE_BYTES,
  isRecord,
  readJsonOrNull,
} from "./jobApiBody";
import { sftpConnectionProjectionOf } from "./serverJobExchangeDriver";

import type { AuthoredSftpServerRequest } from "@jobs/sftpServer";
import type { SftpConnectionProjection } from "@jobs/jobManager";

/**
 * The browser-side client for authoring the console's SFTP connection
 * ({@link ../jobs/routes} `PUT`/`DELETE /api/jobs/sftp`) and browsing the mounted
 * secrets directory for a credential file (`GET /api/jobs/mounts/secrets/entries`).
 * Every call is a same-origin fetch to a `gateJobRoute`-protected endpoint; off
 * the console those endpoints answer 404, so a hosted build never reaches
 * them. Responses are validated defensively -- the console is trusted, but a
 * malformed body degrades to a graceful error state rather than a crash.
 *
 * The authoring body holds a credential source: a file-reference credential (a
 * typed `@path` or a secrets-mount locator the server resolves) by default, or --
 * as a de-emphasized fallback -- a pasted value the server materializes to a file
 * on the console. Under the single-operator console trust model the value crosses
 * only same-origin loopback on the operator's own machine. The secrets browse
 * reads no file bytes.
 */

/** The authoring request body a `PUT /api/jobs/sftp` sends. Mirrors the server's
 * wire contract: a file-reference credential or a pasted value the server
 * materializes to a file. */
export type AuthoredSftpConnectionRequest = AuthoredSftpServerRequest;

/** One entry in a secrets-mount listing: an admissible segment name and whether it
 * is a directory (navigable) or a regular file (selectable as a credential). */
export interface MountEntry {
  name: string;
  kind: "dir" | "file";
}

/**
 * The `GET /api/jobs/mounts/secrets/entries` outcome: the listing, a stable
 * `disabled` state (the job API is off -- the gate 404s), or a transient `error`
 * (another non-2xx, a network fault, or a malformed body). `configured` is false
 * when `JOB_SECRETS_DIR` is unset (the mount is unavailable, a named config gap);
 * `readable` is false when the subpath is inadmissible, escapes the mount, or
 * cannot be read. The picker renders these as distinct states.
 */
export type SecretsEntriesResult =
  | {
      kind: "entries";
      configured: boolean;
      readable: boolean;
      entries: Array<MountEntry>;
    }
  | { kind: "disabled" }
  | { kind: "error" };

/**
 * The outcome of a `PUT /api/jobs/sftp` authoring request:
 * - `ok`: the connection was authored; holds the effective credential-free
 *   projection.
 * - `invalid`: a `400` -- the body failed validation; `message` is the server's
 *   field-path-only reason (no submitted value or secret), safe to show.
 * - `tooLarge`: a `413` -- the request body exceeded the console's size limit,
 *   a distinct cause from an unreachable console.
 * - `error`: another non-2xx, a network fault, or a malformed success body.
 */
export type PutSftpConnectionResult =
  | { kind: "ok"; connection: SftpConnectionProjection }
  | { kind: "invalid"; message: string }
  | { kind: "tooLarge" }
  | { kind: "error" };

/** Read the field-path-only validation message off a `400` body, or a fixed
 * fallback when the body holds none. The server generates the message from
 * field paths and fixed reasons (never a submitted value), so it is safe to
 * display. */
function validationMessageOf(body: unknown): string {
  if (isRecord(body) && typeof body.error === "string" && body.error.length > 0)
    return body.error;
  return "The connection could not be saved. Check the fields and try again.";
}

/** Validate a secrets-entries body into the listing, or null when malformed so a
 * bad body degrades to the error state rather than rendering a partial list. */
function secretsEntriesOf(body: unknown): SecretsEntriesResult | null {
  if (!isRecord(body)) return null;
  const { configured, entries } = body;
  if (typeof configured !== "boolean") return null;
  // Absent `readable` is treated as readable: the non-alarming direction.
  const readable = body.readable;
  if (readable !== undefined && typeof readable !== "boolean") return null;
  if (!Array.isArray(entries)) return null;
  const parsed: Array<MountEntry> = [];
  for (const entry of entries) {
    if (!isRecord(entry)) return null;
    const { name, kind } = entry;
    if (typeof name !== "string" || name.length === 0) return null;
    if (kind !== "dir" && kind !== "file") return null;
    parsed.push({ name, kind });
  }
  return {
    kind: "entries",
    configured,
    readable: readable ?? true,
    entries: parsed,
  };
}

/** Build the `?subPath=...&subPath=...` query: one value per path segment, never a
 * single slash-joined string, so a `/` inside a value can never compose a
 * traversal (the server enforces the same). */
function secretsEntriesUrl(subPath: Array<string>): string {
  const params = new URLSearchParams();
  for (const segment of subPath) params.append("subPath", segment);
  const query = params.toString();
  return `/api/jobs/mounts/secrets/entries${query === "" ? "" : `?${query}`}`;
}

/** List one directory of the mounted secrets directory. A 404 is the deliberate
 * API-disabled state; every other non-2xx, a network error, and a malformed body
 * are the transient `error` state. */
export async function fetchSecretsEntries(
  subPath: Array<string>,
  fetchImpl: typeof fetch = fetch,
): Promise<SecretsEntriesResult> {
  try {
    const response = await fetchImpl(secretsEntriesUrl(subPath), {
      method: "GET",
    });
    if (response.status === 404) return { kind: "disabled" };
    if (!response.ok) return { kind: "error" };
    const listing = secretsEntriesOf(
      await readJsonOrNull(response, MAX_JOB_LISTING_RESPONSE_BYTES),
    );
    return listing ?? { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

/** Author the SFTP connection through `PUT /api/jobs/sftp`. Distinguishes a
 * validation rejection (a showable field message) from a transport/other
 * error, so the form can name what to fix. */
export async function putSftpConnection(
  body: AuthoredSftpConnectionRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<PutSftpConnectionResult> {
  let response: Response;
  try {
    response = await fetchImpl("/api/jobs/sftp", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: "error" };
  }
  if (response.ok) {
    const connection = sftpConnectionProjectionOf(
      await readJsonOrNull(response, MAX_SFTP_CONNECTION_RESPONSE_BYTES),
    );
    return connection === null ? { kind: "error" } : { kind: "ok", connection };
  }
  if (response.status === 413) return { kind: "tooLarge" };
  if (response.status === 400)
    return {
      kind: "invalid",
      message: validationMessageOf(
        await readJsonOrNull(response, MAX_JOB_STATUS_RESPONSE_BYTES),
      ),
    };
  return { kind: "error" };
}

/** Clear the in-app authored connection through `DELETE /api/jobs/sftp`. The
 * caller treats any resolution as done: a re-fetch reconciles the effective
 * connection. */
export async function deleteSftpConnection(
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    await fetchImpl("/api/jobs/sftp", { method: "DELETE" });
  } catch {
    // Best-effort: the caller re-fetches the effective connection afterward.
  }
}

/**
 * The outcome of a `POST /api/jobs/sftp/probe` host-key read:
 * - `ok`: the console read a host key; holds the observed fingerprint and key
 *   type (both re-validated client-side, defense in depth over the server check).
 * - `invalid`: a `400` -- the host was malformed; `message` is the server's
 *   field-path-only reason, safe to show.
 * - `busy`: a `409` -- a probe is already running; the operator can retry.
 * - `unreachable` / `timeout`: the probe ran but read no key (the server could not
 *   be reached, or the attempt exceeded the console's budget). An `unreachable`
 *   may hold the console's {@link ProbePeerAnswer} of what answered the port.
 * - `disabled`: a `404` -- the job API is off (a hosted build).
 * - `error`: another non-2xx, a network fault, or a malformed/`error` body.
 */
export type ProbeSftpHostKeyResult =
  | { kind: "ok"; fingerprint: string; keyType: string }
  | { kind: "invalid"; message: string }
  | { kind: "busy" }
  | { kind: "unreachable"; peerAnswer?: ProbePeerAnswer }
  | { kind: "timeout" }
  | { kind: "disabled" }
  | { kind: "error" };

/** The shapes the console reports a non-SSH answer as. */
export type ProbePeerAnswerShape = "http" | "tls-alert" | "unrecognized";

/**
 * What answered the port on a probe that reached it and read no host key: the
 * peer sent bytes that are not an SSH identification string (with the shape and
 * an excerpt of what it sent), or it accepted the connection and closed it
 * having sent nothing.
 *
 * `excerpt` is a fragment somebody else chose. It arrives already escaped by the
 * console -- the display sink for those bytes is on the server side of this
 * boundary -- so it is rendered verbatim and never escaped a second time. Its
 * length is bounded again on the way in, and its characters are checked against
 * what that escape can emit, like every other field this body holds.
 */
export type ProbePeerAnswer =
  | { kind: "nonSsh"; shape: ProbePeerAnswerShape; excerpt: string }
  | { kind: "closedUnanswered" };

/** Read the probe-outcome body defensively: re-check the fingerprint against the
 * canonical regex client-side (the console is trusted, but a malformed body
 * degrades to a graceful error rather than filling a pin with a bad value) and
 * require a non-empty key type. An unexpected shape is the error state. */
function probeOutcomeOf(body: unknown): ProbeSftpHostKeyResult {
  if (!isRecord(body)) return { kind: "error" };
  const status = body.status;
  if (status === "unreachable") {
    const peerAnswer = probePeerAnswerOf(body);
    return peerAnswer === undefined
      ? { kind: "unreachable" }
      : { kind: "unreachable", peerAnswer };
  }
  if (status === "timeout") return { kind: "timeout" };
  if (status === "ok") {
    const { fingerprint, keyType } = body;
    if (
      typeof fingerprint !== "string" ||
      !HOST_KEY_FINGERPRINT_REGEX.test(fingerprint)
    )
      return { kind: "error" };
    if (typeof keyType !== "string" || keyType.length === 0)
      return { kind: "error" };
    return { kind: "ok", fingerprint, keyType };
  }
  // A `status: "error"` category, or anything unmodeled, is the error state.
  return { kind: "error" };
}

const PROBE_PEER_ANSWER_SHAPES: ReadonlySet<string> = new Set([
  "http",
  "tls-alert",
  "unrecognized",
]);

/**
 * The cap on the excerpt, in UTF-16 code units: the same bound the console
 * applies when it escapes the peer's bytes (`PROBE_EXCERPT_MAX_DISPLAY_LENGTH`
 * in jobs/sftpProbe.ts), re-applied here so a malformed body degrades to a
 * bounded value rather than reaching the alert copy at whatever length it
 * arrived with.
 *
 * Mirrored rather than imported: the server module it lives in is not client
 * code, and re-validation here has to check what this side is willing to
 * render, independent of the producer.
 */
const PROBE_EXCERPT_MAX_LENGTH = 512;

/**
 * Every character the console's display escape can emit: printable ASCII and
 * nothing else. `sanitizeForDisplay` passes U+0020 through U+007E and rewrites
 * every other code point as a `\xHH` / `\uHHHH` escape built from those same
 * characters, and its truncation marker is plain ASCII too.
 */
const ESCAPED_EXCERPT_CHARACTERS = /^[\x20-\x7e]*$/;

/**
 * Read the peer-answer diagnosis off an `unreachable` body, or undefined when
 * it holds none or one outside the closed vocabulary; an unrecognized value
 * degrades to the bare category rather than to an error.
 *
 * The excerpt is bounded rather than dropped: an over-long one is the
 * malformed-body case this module's other checks cover, not a reason to lose
 * the diagnosis. The bound is applied the way the console applies its own --
 * the kept prefix plus the truncation marker -- so an excerpt the console
 * already truncated passes through unchanged.
 *
 * A character the escape cannot emit drops the diagnosis instead: the alert
 * renders these bytes verbatim, so a value holding a line break, a control
 * character, or a bidi override never went through the console's escape, and
 * there is no shortening that makes it renderable.
 */
function probePeerAnswerOf(
  body: Record<string, unknown>,
): ProbePeerAnswer | undefined {
  const peerAnswer = body.peerAnswer;
  if (peerAnswer === "closedUnanswered") return { kind: "closedUnanswered" };
  if (peerAnswer !== "nonSsh") return undefined;
  const shape = body.peerAnswerShape;
  const excerpt = body.peerAnswerExcerpt;
  if (typeof shape !== "string" || !PROBE_PEER_ANSWER_SHAPES.has(shape))
    return undefined;
  if (typeof excerpt !== "string") return undefined;
  if (!ESCAPED_EXCERPT_CHARACTERS.test(excerpt)) return undefined;
  return {
    kind: "nonSsh",
    shape: shape as ProbePeerAnswerShape,
    excerpt: boundedExcerpt(excerpt),
  };
}

/** The excerpt clipped to {@link PROBE_EXCERPT_MAX_LENGTH} characters, with
 * {@link DISPLAY_TRUNCATION_MARKER} appended -- on top of the cap, as the
 * console's own escape appends it -- when anything was dropped. Escaping is
 * the console's, since doing it again here would double every backslash it
 * wrote, so this only shortens.
 *
 * Measured limit: a console escape that stopped at an escape boundary below
 * the cap still arrives past it with the marker attached, and the clip then
 * lands inside that marker and appends a second one, ending the excerpt
 * `......[truncated]`. Cosmetic, and out of a conforming CLI's reach, whose
 * 128-byte excerpt escapes to at most the 512 characters the console caps
 * at, so the console never truncates one. */
function boundedExcerpt(excerpt: string): string {
  return excerpt.length <= PROBE_EXCERPT_MAX_LENGTH
    ? excerpt
    : excerpt.slice(0, PROBE_EXCERPT_MAX_LENGTH) + DISPLAY_TRUNCATION_MARKER;
}

/** Read the field-path-only message off a probe `400` body, or a fixed fallback.
 * The message is generated from field paths and fixed reasons (never a value), so
 * it is safe to display. */
function probeValidationMessage(body: unknown): string {
  if (isRecord(body) && typeof body.error === "string" && body.error.length > 0)
    return body.error;
  return "The server address could not be read. Check it and try again.";
}

/**
 * Read the host-key fingerprint an SFTP server presents through
 * `POST /api/jobs/sftp/probe`, so the form can offer it beside the paste field for
 * a comparison. Sends the host and optional port only; the response is validated
 * defensively (the fingerprint re-checked client-side). Distinguishes an
 * unreachable/timed-out server, a busy console, a disabled API, and a bad host
 * from a generic error so the form can name each.
 */
export async function probeSftpHostKey(
  host: string,
  port?: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeSftpHostKeyResult> {
  let response: Response;
  try {
    response = await fetchImpl("/api/jobs/sftp/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(port !== undefined ? { host, port } : { host }),
    });
  } catch {
    return { kind: "error" };
  }
  if (response.status === 404) return { kind: "disabled" };
  if (response.status === 409) return { kind: "busy" };
  if (response.status === 400)
    return {
      kind: "invalid",
      message: probeValidationMessage(
        await readJsonOrNull(response, MAX_JOB_STATUS_RESPONSE_BYTES),
      ),
    };
  if (!response.ok) return { kind: "error" };
  return probeOutcomeOf(
    await readJsonOrNull(response, MAX_JOB_STATUS_RESPONSE_BYTES),
  );
}
