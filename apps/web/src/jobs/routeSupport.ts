import { getLogger, redactAndSanitizeForDisplay } from "@psilink/core";

import { readBoundedJsonBody } from "@utils/boundedJsonBody";

import { MAX_INPUT_CSV_LENGTH } from "./intent";

import {
  JOB_ALLOWED_HOSTS_ENV,
  isJobApiEnabled,
  jobEmptyResponse,
  readJobApiConfig,
} from "./gate";
import { isValidJobId } from "./workdir";
import { useJobManager } from "./index";

import type { BoundedJsonBodyResult } from "@utils/boundedJsonBody";
import type { JobApiConfig } from "./gate";
import type { JobManager } from "./jobManager";

const log = getLogger("job-api");

/**
 * The outcome of gating a job route: either a short-circuit {@link Response} the
 * handler returns as-is, or the resolved {@link JobManager} to proceed with. A
 * disabled API yields 404, indistinguishable from an unknown route.
 */
export type GateOutcome =
  | { kind: "response"; response: Response }
  | { kind: "manager"; manager: JobManager };

/**
 * The `Sec-Fetch-Site` values that mark a request as NOT initiated by another
 * origin's page: `same-origin` is the console's own UI, `none` a user-initiated
 * navigation (address bar, bookmark). Any other value (`cross-site`,
 * `same-site`) is a different site's page.
 */
const NON_CROSS_ORIGIN_FETCH_SITES: ReadonlySet<string> = new Set([
  "same-origin",
  "none",
]);

/** Parse a value to its origin (scheme+host+port, default-port-normalized), or
 * null when it is not a parseable absolute URL -- an opaque `"null"` origin among
 * them, so an opaque-origin request is treated as a mismatch. */
function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Reject a cross-origin browser request to the job API: the CSRF defense on
 * the unauthenticated loopback API. `Origin` and `Sec-Fetch-Site` are browser
 * headers page JavaScript cannot forge, so a visited page cannot drive the
 * API cross-origin (e.g. make the console connect out to an attacker-chosen
 * host); the console's same-origin UI and a header-less loopback client both
 * pass unchanged. The expected origin is derived from the `Host` header.
 * Returns a `403` {@link Response} to short-circuit, or null to proceed.
 */
function rejectCrossOriginBrowserRequest(request: Request): Response | null {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && !NON_CROSS_ORIGIN_FETCH_SITES.has(fetchSite))
    return jobEmptyResponse(403);
  const origin = request.headers.get("origin");
  if (origin === null) return null;
  const host = request.headers.get("host");
  const expected = host === null ? null : originOf(`http://${host}`);
  if (expected === null || originOf(origin) !== expected)
    return jobEmptyResponse(403);
  return null;
}

/** The hostnames the console is reached by from the operator's own machine over
 * host loopback -- the only ones the request `Host` may name by default, whatever
 * the port. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
]);

/** Derive the hostname of a `Host` header the way {@link originOf} derives an
 * origin -- parse it as the authority of an http URL, take the port-stripped
 * `hostname`, strip the brackets Node leaves on an IPv6 literal (`[::1]`), and
 * lowercase. Null when the header is absent or unparseable, so the caller fails
 * closed. */
function hostnameOfHostHeader(host: string | null): string | null {
  if (host === null) return null;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
  if (hostname.startsWith("[") && hostname.endsWith("]"))
    hostname = hostname.slice(1, -1);
  return hostname.toLowerCase();
}

/**
 * Reject a request whose `Host` is not the console's own loopback name: the
 * DNS-rebinding defense complementing
 * {@link rejectCrossOriginBrowserRequest}. `Host` must be a loopback hostname
 * or a configured {@link JobApiConfig.allowedHosts} entry, matched on
 * hostname only (a remapped port still passes); an absent, unparseable, or
 * disallowed `Host` is refused and logged. Returns a `403` {@link Response}
 * to short-circuit, or null to proceed.
 */
function rejectDisallowedHost(
  request: Request,
  config: JobApiConfig,
): Response | null {
  const host = request.headers.get("host");
  const hostname = hostnameOfHostHeader(host);
  if (
    hostname !== null &&
    (LOOPBACK_HOSTNAMES.has(hostname) || config.allowedHosts.has(hostname))
  )
    return null;
  // The Host header is the request's to choose and is composed ahead of the
  // remedy that follows it, so it crosses the display boundary here rather than
  // reaching the console's log as raw bytes.
  log.warn(
    `Refused a job-API request with Host ` +
      `"${redactAndSanitizeForDisplay(host ?? "(absent)")}": not a ` +
      "loopback address. If you deliberately front the console behind a proxy " +
      `or a LAN name, add that hostname to ${JOB_ALLOWED_HOSTS_ENV}.`,
  );
  return jobEmptyResponse(403);
}

/**
 * Gate a job route: read config, enforce the feature gate, resolve the
 * manager, and reject a browser-reachable request. Every job route calls this
 * first, before any filesystem use or spawn; `scripts/job-route-gate.test.mjs`
 * enforces the call order across the handlers under
 * `apps/web/src/routes/api/jobs`. The API is unauthenticated loopback-local,
 * so the feature gate is the only per-request auth; {@link rejectDisallowedHost}
 * and {@link rejectCrossOriginBrowserRequest} run after it, so a disabled API
 * stays a uniform 404.
 */
export function gateJobRoute(request: Request): GateOutcome {
  const config = readJobApiConfig();
  if (!isJobApiEnabled(config))
    return { kind: "response", response: jobEmptyResponse(404) };
  const manager = useJobManager(config);
  if (manager === null)
    return { kind: "response", response: jobEmptyResponse(404) };
  const rejection =
    rejectDisallowedHost(request, config) ??
    rejectCrossOriginBrowserRequest(request);
  if (rejection !== null) return { kind: "response", response: rejection };
  return { kind: "manager", manager };
}

/**
 * The byte cap on a `POST /api/jobs` body: a memory bound on the streamed
 * read. Sits above the JSON-encoded size of a schema-valid intent (a
 * max-length `inputCsv`, {@link MAX_INPUT_CSV_LENGTH}, plus the other capped
 * fields), so a valid body reaches a clean schema error rather than a `413`;
 * it is not sized to admit a pathological control-character payload, which is
 * not valid CSV. The uncapped standardization `params` is bounded only by
 * this cap.
 */
export const MAX_JOB_BODY_BYTES = 224 * 1024 ** 2;

/**
 * The byte cap on a `PUT /api/jobs/sftp` authoring body: a small memory bound on
 * the streamed read. The body is a handful of connection fields plus a credential
 * -- an `@path` reference, a mount locator, or a pasted value (a password or an
 * SSH private key, both well under this cap) -- so this stays tight; an oversized
 * body is a `413` before any parse.
 */
export const MAX_SFTP_AUTHOR_BODY_BYTES = 64 * 1024;

/**
 * The byte cap on a `POST /api/jobs/sftp/probe` body: a host and an optional port,
 * nothing else. Far tighter than the authoring cap -- no credential is
 * representable -- so an oversized body is a `413` before any parse.
 */
export const MAX_SFTP_PROBE_BODY_BYTES = 4 * 1024;

/**
 * The byte cap on a `POST /api/jobs/signing/fingerprint` body: an identity label
 * and an export toggle, nothing else. Sized like the probe cap -- no path and no
 * credential is representable -- so an oversized body is a `413` before any parse.
 */
export const MAX_SIGNING_FINGERPRINT_BODY_BYTES = 4 * 1024;

/**
 * The outcome of reading a job request body under a byte cap:
 * - `too-large`: the body exceeded the cap (mapped to 413).
 * - `invalid`: the body was absent, was not valid UTF-8, was not valid JSON, or
 *   exceeded the structural bound parseBoundedJson enforces (mapped to 400).
 * - `parsed`: the decoded JSON value.
 */
export type JobRequestBodyResult = BoundedJsonBodyResult;

/**
 * Read a request body as JSON under a hard byte cap, through the app's one
 * byte-capped body read ({@link readBoundedJsonBody}): streamed rather than
 * buffered, `Content-Length` never trusted, and parsed through
 * `parseBoundedJson`. Pure over its arguments, so a test can drive it with any
 * `Request`.
 */
export function readJobRequestBody(
  request: Request,
  maxBytes: number,
): Promise<JobRequestBodyResult> {
  return readBoundedJsonBody(request, maxBytes);
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
