import { HOST_KEY_FINGERPRINT_REGEX } from "@psilink/core";

import { sftpConnectionProjectionOf } from "./serverJobExchangeDriver";

import type { AuthoredSftpServerRequest } from "@jobs/sftpServer";
import type { SftpConnectionProjection } from "@jobs/jobManager";

/**
 * The browser-side client for authoring the console appliance's SFTP connection
 * ({@link ../jobs/routes} `PUT`/`DELETE /api/jobs/sftp`) and browsing the mounted
 * secrets directory for a credential file (`GET /api/jobs/mounts/secrets/entries`).
 * Every call is a same-origin fetch to a `gateJobRoute`-protected endpoint; off
 * the console appliance those endpoints answer 404, so a hosted build never
 * reaches them. Responses are validated defensively -- the appliance is trusted,
 * but a malformed body degrades to an honest error state rather than a crash.
 *
 * The authoring body carries a credential source: a file-reference credential (a
 * typed `@path` or a secrets-mount locator the server resolves) by default, or --
 * as a de-emphasized fallback -- a pasted value the server materializes to a file
 * on the appliance. Under the single-party-appliance trust model the value crosses
 * only same-origin loopback on the operator's own machine. The secrets browse
 * reads no file bytes.
 */

/** The authoring request body a `PUT /api/jobs/sftp` carries. Mirrors the server's
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
 * - `ok`: the connection was authored; carries the effective credential-free
 *   projection.
 * - `invalid`: a `400` -- the body failed validation; `message` is the server's
 *   field-path-only reason (no submitted value or secret), safe to surface.
 * - `tooLarge`: a `413` -- the request body exceeded the appliance's size limit,
 *   a distinct cause from an unreachable appliance.
 * - `error`: another non-2xx, a network fault, or a malformed success body.
 */
export type PutSftpConnectionResult =
  | { kind: "ok"; connection: SftpConnectionProjection }
  | { kind: "invalid"; message: string }
  | { kind: "tooLarge" }
  | { kind: "error" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Decode a response body as JSON, or null when it is empty or not JSON. */
async function readJsonOrNull(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

/** Read the field-path-only validation message off a `400` body, or a fixed
 * fallback when the body carries none. The server generates the message from
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
  // Absent `readable` reads as readable: the non-alarming direction.
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
    const listing = secretsEntriesOf(await readJsonOrNull(response));
    return listing ?? { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

/** Author the SFTP connection through `PUT /api/jobs/sftp`. Distinguishes a
 * validation rejection (a surfaceable field message) from a transport/other
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
      await readJsonOrNull(response),
    );
    return connection === null ? { kind: "error" } : { kind: "ok", connection };
  }
  if (response.status === 413) return { kind: "tooLarge" };
  if (response.status === 400)
    return {
      kind: "invalid",
      message: validationMessageOf(await readJsonOrNull(response)),
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
 * - `ok`: the appliance read a host key; carries the observed fingerprint and key
 *   type (both re-validated client-side, defense in depth over the server check).
 * - `invalid`: a `400` -- the host was malformed; `message` is the server's
 *   field-path-only reason, safe to surface.
 * - `busy`: a `409` -- a probe is already running; the operator can retry.
 * - `unreachable` / `timeout`: the probe ran but read no key (the server could not
 *   be reached, or the attempt exceeded the appliance's budget).
 * - `disabled`: a `404` -- the job API is off (a hosted build).
 * - `error`: another non-2xx, a network fault, or a malformed/`error` body.
 */
export type ProbeSftpHostKeyResult =
  | { kind: "ok"; fingerprint: string; keyType: string }
  | { kind: "invalid"; message: string }
  | { kind: "busy" }
  | { kind: "unreachable" }
  | { kind: "timeout" }
  | { kind: "disabled" }
  | { kind: "error" };

/** Read the probe-outcome body defensively: re-check the fingerprint against the
 * canonical regex client-side (the appliance is trusted, but a malformed body
 * degrades to an honest error rather than filling a pin with a bad value) and
 * require a non-empty key type. An unexpected shape is the error state. */
function probeOutcomeOf(body: unknown): ProbeSftpHostKeyResult {
  if (!isRecord(body)) return { kind: "error" };
  const status = body.status;
  if (status === "unreachable" || status === "timeout") return { kind: status };
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
 * a comparison. Carries the host and optional port ONLY; the response is validated
 * defensively (the fingerprint re-checked client-side). Distinguishes an
 * unreachable/timed-out server, a busy appliance, a disabled API, and a bad host
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
      message: probeValidationMessage(await readJsonOrNull(response)),
    };
  if (!response.ok) return { kind: "error" };
  return probeOutcomeOf(await readJsonOrNull(response));
}
