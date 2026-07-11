import { gateRequest, jobEmptyResponse, readJobApiConfig } from "./gate";
import { isValidJobId } from "./workdir";
import { useJobManager } from "./index";

import type { GateResult } from "./gate";
import type { JobManager } from "./jobManager";

/**
 * The outcome of gating a job route: either a short-circuit {@link Response} the
 * handler returns as-is, or the resolved {@link JobManager} to proceed with. A
 * disabled API yields 404 (indistinguishable from an unknown route); a failed
 * auth yields 401.
 */
export type GateOutcome =
  | { kind: "response"; response: Response }
  | { kind: "manager"; manager: JobManager };

/**
 * Gate a job route: read config, enforce the feature gate and bearer auth, and
 * resolve the manager. Every job route calls this first, before any filesystem
 * use or spawn.
 */
export function gateJobRoute(request: Request): GateOutcome {
  const config = readJobApiConfig();
  const result: GateResult = gateRequest(
    config,
    request.headers.get("authorization"),
  );
  if (result === "disabled")
    return { kind: "response", response: jobEmptyResponse(404) };
  if (result === "unauthorized")
    return { kind: "response", response: jobEmptyResponse(401) };
  const manager = useJobManager(config);
  if (manager === null)
    return { kind: "response", response: jobEmptyResponse(404) };
  return { kind: "manager", manager };
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
