import fsp from "node:fs/promises";

import { createFileRoute } from "@tanstack/react-router";

import { JOB_RESPONSE_HEADERS, jobEmptyResponse } from "@jobs/gate";
import { gateJobRoute, validateJobIdParam } from "@jobs/routeSupport";
import { jobFileExists } from "@jobs/workdir";

/**
 * `GET /api/jobs/:jobId/keys` -- serve the job's private verification keys.
 *
 * A near-exact mirror of the result route: feature-gated, id-validated, and served
 * only after the job succeeded, from the job's server-chosen keys path inside its
 * workdir (never derived from client input). A job that has not succeeded, or
 * whose keys file is missing, is 404. This is PRIVATE material -- a salt plus the
 * record's commitment can open a committed value -- so it is gated and no-store
 * identically to the result route. The download name the browser saves is set by
 * the driver's `download` attribute; the Content-Disposition name here is a
 * stable fallback.
 */
export const Route = createFileRoute("/api/jobs/$jobId/keys")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;
        const jobId = validateJobIdParam(params.jobId);
        if (jobId === null) return jobEmptyResponse(404);

        const view = gate.manager.getJobView(jobId);
        if (view === null) return jobEmptyResponse(404);
        if (view.status !== "succeeded") return jobEmptyResponse(404);
        if (!jobFileExists(view.keysPath)) return jobEmptyResponse(404);

        const body = await fsp.readFile(view.keysPath);
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition":
              'attachment; filename="psilink-record.keys.json"',
            "X-Content-Type-Options": "nosniff",
            ...JOB_RESPONSE_HEADERS,
          },
        });
      },
    },
  },
});
