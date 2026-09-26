import { createFileRoute } from "@tanstack/react-router";

import { gateJobRoute, validateJobIdParam } from "@jobs/routeSupport";
import { jobEmptyResponse } from "@jobs/gate";
import { jobFileDownloadResponse } from "@jobs/jobFileDownload";
import { resultFileExists } from "@jobs/workdir";

/**
 * `GET /api/jobs/:jobId/result` -- serve the job's matched-result CSV.
 *
 * Feature-gated and id-validated, served only after the job succeeded. The path is
 * the job's server-chosen output file inside its workdir -- never derived from
 * client input. Content-Type and Content-Disposition are set explicitly with a
 * fixed download name, and the nosniff and no-store headers are set. A job that
 * has not succeeded, or whose result is missing, is 404 rather than leaking
 * whether an unfinished job exists.
 */
export const Route = createFileRoute("/api/jobs/$jobId/result")({
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
        if (!resultFileExists(view.outputPath)) return jobEmptyResponse(404);

        return jobFileDownloadResponse(view.outputPath, {
          contentType: "text/csv; charset=utf-8",
          fileName: `result-${view.id}.csv`,
        });
      },
    },
  },
});
