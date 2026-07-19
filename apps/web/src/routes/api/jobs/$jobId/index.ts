import { createFileRoute } from "@tanstack/react-router";

import { gateJobRoute, validateJobIdParam } from "@jobs/routeSupport";
import { jobEmptyResponse, jobJsonResponse } from "@jobs/gate";

/**
 * `GET /api/jobs/:jobId` -- the job's status and terminal state.
 * `DELETE /api/jobs/:jobId` -- delete the exchange and remove the workdir.
 *
 * Both feature-gated and id-validated. An unknown job (or a malformed id) is 404.
 * GET reports status, the reconciled terminal outcome, whether a result file is
 * available, and whether the exchange-record pair is available (with its
 * `createdAt` when it is). DELETE kills a still-running child, marks the exchange
 * deleted, and removes the disk; for a workdir named by a valid id but orphaned by
 * a server restart it removes the disk-only directory.
 */
export const Route = createFileRoute("/api/jobs/$jobId/")({
  server: {
    handlers: {
      GET: ({ params }) => {
        const gate = gateJobRoute();
        if (gate.kind === "response") return gate.response;
        const jobId = validateJobIdParam(params.jobId);
        if (jobId === null) return jobEmptyResponse(404);

        const view = gate.manager.getJobView(jobId);
        if (view === null) return jobEmptyResponse(404);

        return jobJsonResponse({
          id: view.id,
          status: view.status,
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
