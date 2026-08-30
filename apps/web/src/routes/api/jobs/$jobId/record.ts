import fsp from "node:fs/promises";

import { createFileRoute } from "@tanstack/react-router";

import { JOB_RESPONSE_HEADERS, jobEmptyResponse } from "@jobs/gate";
import { gateJobRoute, validateJobIdParam } from "@jobs/routeSupport";

/**
 * `GET /api/jobs/:jobId/record` -- serve the job's self-attested exchange record.
 *
 * Feature-gated, id-validated, and served from the job's server-chosen record path
 * inside its workdir (never derived from client input). The gate is the status
 * route's own record availability, so the two cannot disagree about what is
 * offered: the run has settled and the readable pair is on disk. That includes a
 * run that disclosed and then terminated, whose record is precisely the
 * disclosure-accounting artifact its operator needs; a failure before the
 * disclosure owes no record, writes none, and is 404 here on the same rule. The
 * download name the browser saves is set by the driver's `download` attribute; the
 * Content-Disposition name here is a stable fallback.
 */
export const Route = createFileRoute("/api/jobs/$jobId/record")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;
        const jobId = validateJobIdParam(params.jobId);
        if (jobId === null) return jobEmptyResponse(404);

        const view = gate.manager.getJobView(jobId);
        if (view === null) return jobEmptyResponse(404);
        if (!view.recordAvailable) return jobEmptyResponse(404);

        const body = await fsp.readFile(view.recordPath);
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": 'attachment; filename="psilink-record.json"',
            "X-Content-Type-Options": "nosniff",
            ...JOB_RESPONSE_HEADERS,
          },
        });
      },
    },
  },
});
