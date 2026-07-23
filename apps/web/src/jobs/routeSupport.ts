import { getLogger } from "@psilink/core";

import { MAX_INPUT_CSV_LENGTH } from "./intent";

import {
  JOB_ALLOWED_HOSTS_ENV,
  isJobApiEnabled,
  jobEmptyResponse,
  readJobApiConfig,
} from "./gate";
import { isValidJobId } from "./workdir";
import { useJobManager } from "./index";

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
 * Reject a cross-origin browser request to the job API -- the browser-CSRF
 * defense on the unauthenticated loopback API. A page the operator merely visits
 * while the console runs must not be able to drive the API cross-origin (e.g.
 * make the appliance connect out to an attacker-chosen host), so a request a
 * browser marks as coming from another origin is refused before any side effect.
 * Browsers reliably send `Origin` on state-changing requests and `Sec-Fetch-Site`
 * on every fetch, and page JavaScript cannot forge either (both are forbidden
 * header names), so a visited page cannot bypass this. The console's own UI is
 * served same-origin (its clients fetch relative `/api/...` URLs), so it passes
 * unchanged; a non-browser client on loopback (the operator's curl or CLI) sends
 * neither header and is allowed -- browser CSRF is the threat closed here, a
 * non-browser loopback client the already-accepted model.
 *
 * The expected origin is derived from the `Host` header (the console is served
 * over http on loopback). Returns a `403` {@link Response} to short-circuit, or
 * null to proceed.
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
 * Reject a request whose `Host` is not the appliance's own loopback name -- the
 * DNS-rebinding defense that complements {@link rejectCrossOriginBrowserRequest}.
 * A page the operator visits at `http://attacker.example` whose name the attacker
 * has rebound to `127.0.0.1` reaches the API with an `Origin` and `Host` that
 * both name `attacker.example`, so it is genuinely same-origin and the CSRF check
 * passes; requiring the `Host` to be a loopback hostname (or an operator-listed
 * {@link JobApiConfig.allowedHosts} entry -- the deliberate reverse-proxy or
 * LAN-name escape hatch) is what refuses it. The match is on the hostname only,
 * so any published-port remapping passes; an absent or unparseable `Host` is
 * refused. A rejection is logged, naming the `Host` and the override variable, so
 * a misconfigured operator gets a self-service diagnosis. Returns a `403`
 * {@link Response} to short-circuit, or null to proceed.
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
  log.warn(
    `Refused a job-API request with Host "${host ?? "(absent)"}": not a ` +
      "loopback address. If you deliberately front the console behind a proxy " +
      `or a LAN name, add that hostname to ${JOB_ALLOWED_HOSTS_ENV}.`,
  );
  return jobEmptyResponse(403);
}

/**
 * Gate a job route: read config, enforce the feature gate, resolve the manager,
 * and reject a browser-reachable request. Every job route calls this first,
 * before any filesystem use or spawn. The API is unauthenticated loopback-local
 * (the deployment publishes to host loopback), so there is no per-request auth
 * beyond the feature gate; two complementary browser defenses run after it. The
 * loopback Host-allowlist ({@link rejectDisallowedHost}) refuses a request whose
 * `Host` is not the appliance's own loopback name, closing DNS rebinding; the
 * browser-CSRF check ({@link rejectCrossOriginBrowserRequest}) refuses a request a
 * browser marks as cross-origin. Both run after the feature gate, so a disabled
 * API stays a uniform 404.
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
