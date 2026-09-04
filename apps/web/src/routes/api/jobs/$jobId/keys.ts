import fsp from "node:fs/promises";

import { createFileRoute } from "@tanstack/react-router";

import { JOB_RESPONSE_HEADERS, jobEmptyResponse } from "@jobs/gate";
import { gateJobRoute, validateJobIdParam } from "@jobs/routeSupport";

/**
 * `GET /api/jobs/:jobId/keys` -- serve the job's private verification keys.
 *
 * Feature-gated, id-validated, and served from the job's server-chosen keys path
 * inside its workdir (never derived from client input). It shares the record
 * route's gate -- the status route's record availability, which is all-or-nothing
 * over the pair -- so the two halves of one artifact are never offered apart. This
 * is PRIVATE material -- a salt plus the record's commitment can open a committed
 * value -- so it is gated and no-store identically to the result route.
 *
 * What the keys are GOOD for varies with the record beside them, and the client
 * states that rather than this route withholding them: a terminated run wrote no
 * result file, and all three of the record's commitments re-supply from one, so
 * nothing can be opened against that run's keys (docs/spec/EXCHANGE_RECORD.md,
 * When a record is owed). The file is the operator's own material, written beside
 * the record it pairs with, so it is served.
 *
 * The download name the browser saves is set by the driver's `download` attribute;
 * the Content-Disposition name here is a stable fallback.
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
        if (!view.recordAvailable) return jobEmptyResponse(404);

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
