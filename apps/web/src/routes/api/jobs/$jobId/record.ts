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
 * run that disclosed and then terminated, whose record is the
 * disclosure-accounting artifact its operator needs; a failure before the
 * disclosure writes no record and is 404 here on the same rule.
 *
 * A record file this bundle cannot describe -- an `outcome` it does not know, a
 * body it cannot parse, or a missing keys half -- is 404 too rather than served
 * unvalidated, and the status body says so through `recordUnavailableReason`, so
 * the operator learns the file is there and why it is not served.
 *
 * The download name the browser saves is set by the driver's `download` attribute;
 * the Content-Disposition name here is a stable fallback.
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
