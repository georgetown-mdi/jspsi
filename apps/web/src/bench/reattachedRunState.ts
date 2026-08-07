import type { JobRunStatus } from "@psi/serverJobExchangeDriver";
import type { ReattachedRunState } from "./BenchRunSurface";

/**
 * The recovery state a re-attached bench run heads with, shared by both run
 * sections and the strand-recovery panel: a delivered terminal (a run failure, or
 * received outputs) wins, else the busy probe's initial status seeds it so a
 * re-attached terminal run never flashes "still running" before the replay lands.
 * A `stopped` run promises no downloads.
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
