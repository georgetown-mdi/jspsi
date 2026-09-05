import type { JobRunStatus } from "@psi/jobClient/serverJobExchangeDriver";
import type { ReattachedRunState } from "./RunSurface";

/**
 * The state a re-attached console run starts in, used by both run sections and the
 * strand-recovery panel: a delivered terminal result (a run failure, or received
 * outputs) wins; otherwise the busy probe's initial status decides, so a
 * re-attached terminal run never shows "still running" before the replay
 * arrives. A `stopped` run has no downloads.
 */
export function reattachedRunState(args: {
  failed: boolean;
  hasOutputs: boolean;
  status: JobRunStatus;
}): ReattachedRunState {
  const { failed, hasOutputs, status } = args;
  if (
    failed ||
    (!hasOutputs && (status === "failed" || status === "cancelled"))
  )
    return "stopped";
  if (hasOutputs || status === "succeeded") return "finished";
  return "running";
}
