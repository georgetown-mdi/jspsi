import fsp from "node:fs/promises";

import { createFileRoute } from "@tanstack/react-router";

import { JOB_RESPONSE_HEADERS, jobEmptyResponse } from "@jobs/gate";
import { gateJobRoute, validateJobIdParam } from "@jobs/routeSupport";
import { jobFileExists } from "@jobs/workdir";

/**
 * `GET /api/jobs/:jobId/receipt` -- serve the job's dual-signed receipt.
 *
 * A near-exact mirror of the record route: feature-gated, id-validated, and served
 * from the job's server-chosen receipt path inside its workdir (never derived from
 * client input). A run that asked for no signed receipt has a null receipt path
 * and is 404, as is one whose receipt is missing.
 *
 * Unlike the record, this is NOT gated on the job having succeeded. The receipt is
 * written from the mutually-verifiable facts once the signature swap completes,
 * independently of the local record build and of the run's exit code -- a
 * persistence-loss exit (73) is a completed exchange whose receipt survived.
 */
export const Route = createFileRoute("/api/jobs/$jobId/receipt")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;
        const jobId = validateJobIdParam(params.jobId);
        if (jobId === null) return jobEmptyResponse(404);

        const view = gate.manager.getJobView(jobId);
        if (view === null) return jobEmptyResponse(404);
        if (view.receiptPath === null) return jobEmptyResponse(404);
        if (!jobFileExists(view.receiptPath)) return jobEmptyResponse(404);

        const body = await fsp.readFile(view.receiptPath);
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition":
              'attachment; filename="psilink-receipt.json"',
            "X-Content-Type-Options": "nosniff",
            ...JOB_RESPONSE_HEADERS,
          },
        });
      },
    },
  },
});
