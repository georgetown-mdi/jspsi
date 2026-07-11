import fsp from "node:fs/promises";

import { createFileRoute } from "@tanstack/react-router";

import { JOB_RESPONSE_HEADERS, jobEmptyResponse } from "@jobs/gate";
import { gateJobRoute, validateJobIdParam } from "@jobs/routeSupport";
import { resultFileExists } from "@jobs/workdir";

/**
 * `GET /api/jobs/:jobId/result` -- serve the job's matched-result CSV.
 *
 * Auth-gated and id-validated, served only after the job succeeded. The path is
 * the job's server-chosen output file inside its workdir -- never derived from
 * client input. Content-Type and Content-Disposition are set explicitly with a
 * fixed download name, and a nosniff/no-store discipline applies. A job that has
 * not succeeded, or whose result is missing, is 404 rather than leaking whether
 * an unfinished job exists.
 */
export const Route = createFileRoute("/api/jobs/$jobId/result")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;
        const jobId = validateJobIdParam(params.jobId);
        if (jobId === null) return jobEmptyResponse(404);

        const record = gate.manager.getJob(jobId);
        if (record === undefined) return jobEmptyResponse(404);
        if (record.status !== "succeeded") return jobEmptyResponse(404);
        if (!resultFileExists(record.outputPath)) return jobEmptyResponse(404);

        const body = await fsp.readFile(record.outputPath);
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="result-${record.id}.csv"`,
            "X-Content-Type-Options": "nosniff",
            ...JOB_RESPONSE_HEADERS,
          },
        });
      },
    },
  },
});
