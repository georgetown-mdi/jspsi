import { createFileRoute } from "@tanstack/react-router";

import { gateJobRoute, validateJobIdParam } from "@jobs/routeSupport";
import { jobEmptyResponse, jobJsonResponse } from "@jobs/gate";

/**
 * `GET /api/jobs/:jobId` -- the job's status and terminal state.
 * `DELETE /api/jobs/:jobId` -- remove the in-memory record and the workdir.
 *
 * Both feature-gated and id-validated. An unknown or evicted job (or a malformed id)
 * is 404. GET reports status, the reconciled terminal outcome, whether a result
 * file is available, and whether the exchange-record pair is available (with its
 * `createdAt` when it is), plus a `restored` flag: true when the view was
 * reconstructed from disk after a restart (no in-memory record, no event history,
 * always terminal). DELETE kills a still-running child, drops the record, and
 * removes the disk; for a restart-restored job it removes the disk-only workdir.
 */
export const Route = createFileRoute("/api/jobs/$jobId/")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const gate = gateJobRoute();
        if (gate.kind === "response") return gate.response;
        const jobId = validateJobIdParam(params.jobId);
        if (jobId === null) return jobEmptyResponse(404);

        const view = await gate.manager.getJobView(jobId);
        if (view === null) return jobEmptyResponse(404);

        return jobJsonResponse({
          id: view.id,
          status: view.status,
          restored: view.restored,
          terminal: view.terminal,
          terminalEmitted: view.terminalEmitted,
          eventCount: view.eventCount,
          resultAvailable: view.resultAvailable,
          recordAvailable: view.recordAvailable,
          ...(view.recordCreatedAt !== undefined
            ? { recordCreatedAt: view.recordCreatedAt }
            : {}),
        });
      },
      DELETE: async ({ params }) => {
        const gate = gateJobRoute();
        if (gate.kind === "response") return gate.response;
        const jobId = validateJobIdParam(params.jobId);
        if (jobId === null) return jobEmptyResponse(404);

        const removed = await gate.manager.deleteJob(jobId);
        return jobEmptyResponse(removed ? 204 : 404);
      },
    },
  },
});
