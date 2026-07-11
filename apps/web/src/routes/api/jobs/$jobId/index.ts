import { createFileRoute } from "@tanstack/react-router";

import { gateJobRoute, validateJobIdParam } from "@jobs/routeSupport";
import { jobEmptyResponse, jobJsonResponse } from "@jobs/gate";

/**
 * `GET /api/jobs/:jobId` -- the job's status and terminal state.
 * `DELETE /api/jobs/:jobId` -- remove the in-memory record and the workdir.
 *
 * Both auth-gated and id-validated. An unknown or evicted job (or a malformed id)
 * is 404. GET reports status, the reconciled terminal outcome, and whether a
 * result file is available. DELETE kills a still-running child, drops the record,
 * and removes the disk.
 */
export const Route = createFileRoute("/api/jobs/$jobId/")({
  server: {
    handlers: {
      GET: ({ request, params }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;
        const jobId = validateJobIdParam(params.jobId);
        if (jobId === null) return jobEmptyResponse(404);

        const record = gate.manager.getJob(jobId);
        if (record === undefined) return jobEmptyResponse(404);

        return jobJsonResponse({
          id: record.id,
          status: record.status,
          terminal: record.terminal,
          terminalEmitted: record.terminalEmitted,
          eventCount: record.events.length,
          resultAvailable: record.status === "succeeded",
        });
      },
      DELETE: async ({ request, params }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;
        const jobId = validateJobIdParam(params.jobId);
        if (jobId === null) return jobEmptyResponse(404);

        const removed = await gate.manager.deleteJob(jobId);
        return jobEmptyResponse(removed ? 204 : 404);
      },
    },
  },
});
