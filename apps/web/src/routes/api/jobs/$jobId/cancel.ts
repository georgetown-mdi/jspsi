import { createFileRoute } from "@tanstack/react-router";

import { gateJobRoute, validateJobIdParam } from "@jobs/routeSupport";
import { jobEmptyResponse } from "@jobs/gate";

/**
 * `POST /api/jobs/:jobId/cancel` -- request cancellation of a running job.
 *
 * Feature-gated and id-validated. Delivers SIGINT, escalating to SIGTERM then
 * SIGKILL after grace periods; the job's final state reflects which signal took
 * effect. A job already terminal is accepted idempotently (202). An unknown job
 * or malformed id is 404.
 */
export const Route = createFileRoute("/api/jobs/$jobId/cancel")({
  server: {
    handlers: {
      POST: ({ params }) => {
        const gate = gateJobRoute();
        if (gate.kind === "response") return gate.response;
        const jobId = validateJobIdParam(params.jobId);
        if (jobId === null) return jobEmptyResponse(404);

        const record = gate.manager.getJob(jobId);
        if (record === undefined) return jobEmptyResponse(404);

        gate.manager.cancelJob(record);
        return jobEmptyResponse(202);
      },
    },
  },
});
