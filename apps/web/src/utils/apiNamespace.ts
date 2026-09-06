/**
 * The refusal the server entry (src/server.ts) applies to the `/api` namespace
 * ahead of the router.
 *
 * The app serves two server APIs under `/api`: the console job API
 * (`/api/jobs/...`), enabled only on the console deployment profile, and the
 * peer-coordination broker (`/api/peerjs/...`), served on every profile. On a
 * deployment where the job API is not enabled, a request under `/api` that does
 * not address the broker is answered with the job gate's own empty `404`
 * ({@link jobEmptyResponse}) and never reaches the router, so the router's
 * answers -- the app document, its canonicalizing redirect, the SSR path's JSON
 * refusal -- are not observable there and no job route module runs.
 *
 * What the refusal reaches, and what it leaves: docs/spec/SERVER_JOB_API.md,
 * The `/api` namespace's refusal.
 */

import {
  isJobApiEnabled,
  jobEmptyResponse,
  readJobApiConfig,
} from "@jobs/gate";

/** The path the app's server API routes are served under. */
const API_PATH_ROOT = "/api";

/**
 * The paths under {@link API_PATH_ROOT} a deployment serves whatever its
 * profile, and so the only ones the refusal lets through to the router: the
 * peer-coordination broker's own subtree. The broker attaches its WebSocket
 * upgrade listener on the first `GET` under it (src/peerServer.ts), so refusing
 * it would stop signaling rather than harden it.
 *
 * scripts/api-namespace-allowlist.test.mjs holds this list against the route
 * tree, so a route directory that is neither listed here nor behind the job
 * gate cannot land unnoticed.
 */
export const HOSTED_API_PREFIXES: ReadonlyArray<string> = ["/api/peerjs"];

/** How many times a path is percent-decoded while looking for a fixed point. A
 * path still decoding past this is refused outright when it is under `/api`. */
const MAX_DECODE_ROUNDS = 4;

/** Whether `pathname` is `prefix` itself or a path under it, by whole segments. */
function isUnderPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Percent-decode `pathname` once, leaving any sequence that does not decode as
 * it was written and never throwing, so a malformed sequence cannot carry a
 * path out of the namespace.
 */
function decodeOnce(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname.replace(/%[0-9a-f]{2}/gi, (sequence) => {
      try {
        return decodeURIComponent(sequence);
      } catch {
        return sequence;
      }
    });
  }
}

/**
 * Resolve `pathname` to its segments: empty segments dropped (a doubled or
 * trailing slash), `.` dropped, `..` popping the segment before it.
 */
function withoutDotSegments(pathname: string): string {
  const segments: Array<string> = [];
  for (const segment of pathname.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

/**
 * Every spelling of `pathname` the refusal is decided over: the path as written
 * and its case-folded, dot-resolved, and repeatedly percent-decoded forms.
 * `settled` is false when decoding was still changing the path at
 * {@link MAX_DECODE_ROUNDS}, so where further decoding lands is unknown.
 */
function spellingsOf(pathname: string): {
  spellings: Array<string>;
  settled: boolean;
} {
  const spellings = new Set<string>();
  let current = pathname;
  let settled = false;
  for (let round = 0; round <= MAX_DECODE_ROUNDS; round += 1) {
    for (const spelling of [current, current.toLowerCase()]) {
      spellings.add(spelling);
      spellings.add(withoutDotSegments(spelling));
    }
    const decoded = decodeOnce(current);
    if (decoded === current) {
      settled = true;
      break;
    }
    current = decoded;
  }
  return { spellings: [...spellings], settled };
}

/**
 * Whether the request for `url` is refused: any spelling of its path lands
 * under `/api` outside {@link HOSTED_API_PREFIXES}. Deciding over every
 * spelling rather than one normal form makes the refusal wider than the
 * router's own resolution and never narrower -- a spelling the router resolves
 * to a route under `/api` is refused whether or not this agrees with the router
 * on which route that is. A path still decoding at the round bound is refused
 * on being under `/api` at all.
 */
function isRefusedApiPath(url: string): boolean {
  const { spellings, settled } = spellingsOf(new URL(url).pathname);
  const underApi = spellings.filter((spelling) =>
    isUnderPrefix(spelling, API_PATH_ROOT),
  );
  if (underApi.length === 0) return false;
  if (!settled) return true;
  return underApi.some(
    (spelling) =>
      !HOSTED_API_PREFIXES.some((prefix) => isUnderPrefix(spelling, prefix)),
  );
}

/**
 * Wrap `route` -- the framework's request handler -- in the `/api` refusal: on a
 * deployment where the job API is not enabled, a refused path is answered
 * without calling `route` at all. Enablement is read per request from the same
 * {@link isJobApiEnabled} the per-route job gate reads, so the two cannot
 * disagree about which profile they are on. The path is decided first, so only
 * a request under `/api` pays that read; both tests are free of side effects,
 * so the order changes nothing but the work skipped.
 */
export function withApiGuard(
  route: (request: Request) => Response | Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (isRefusedApiPath(request.url) && !isJobApiEnabled(readJobApiConfig()))
      return jobEmptyResponse(404);
    return route(request);
  };
}
