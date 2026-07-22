import { createFileRoute } from "@tanstack/react-router";

import { gateJobRoute, validateJobIdParam } from "@jobs/routeSupport";
import { jobEmptyResponse, jobJsonResponse } from "@jobs/gate";

/**
 * `GET /api/jobs/:jobId/handoff` -- the recurring-run hand-off for a job: the
 * portable, secret-free material an operator needs to graduate a prototyped
 * console exchange to a scheduled `psilink` command-line run.
 *
 * Feature-gated and id-validated exactly like the other job routes (404 when the
 * API is off; loopback-only; no-store; no CORS). A malformed, unknown, deleted, or
 * restart-forgotten id is a clean 404, indistinguishable from an unknown route.
 *
 * The response is the manager's {@link JobHandoff}, composed at job creation and
 * held on the record. By construction it carries NO shared secret, NO key-file
 * body, and NO inline credential value, and NO container-internal path: the
 * credential `@path` (sftp) and the filedrop rendezvous directory are shown as
 * fixed placeholders, while the portable host/port/username, host-key fingerprint,
 * and linkage terms are the values that actually ran.
 */
export const Route = createFileRoute("/api/jobs/$jobId/handoff")({
  server: {
    handlers: {
      GET: ({ params }) => {
        const gate = gateJobRoute();
        if (gate.kind === "response") return gate.response;
        const jobId = validateJobIdParam(params.jobId);
        if (jobId === null) return jobEmptyResponse(404);

        const handoff = gate.manager.getJobHandoff(jobId);
        if (handoff === null) return jobEmptyResponse(404);

        return jobJsonResponse(handoff);
      },
    },
  },
});
