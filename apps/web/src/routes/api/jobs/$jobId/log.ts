import { createFileRoute } from "@tanstack/react-router";

import { gateJobRoute, validateJobIdParam } from "@jobs/routeSupport";
import { jobEmptyResponse } from "@jobs/gate";
import { jobFileDownloadResponse } from "@jobs/jobFileDownload";
import { jobFileExists } from "@jobs/workdir";

/**
 * `GET /api/jobs/:jobId/log` -- serve the diagnostic log a diagnostic run
 * captured.
 *
 * Feature-gated and id-validated like the other artifact routes, but NOT gated on
 * the job having succeeded: the run this log exists for is the one that
 * misbehaved, and a stalled run's log is the diagnostic the operator opened the
 * console for. A job that captured no log -- the default verbosity, which passes
 * no `--log-file` at all -- has no log path, and is `404`.
 *
 * The path is the job's own server-chosen log file inside its workdir, composed
 * from the workdir and a fixed name and confirmed to resolve under it
 * (`resolveWorkdirFile`); no operator-typed or intent-supplied path reaches it.
 *
 * The body is PRIVATE material -- a debug-level log can hold partner identity,
 * linkage keys, and data categories, which is why the CLI creates the file
 * owner-only -- so it is served as a download with the same nosniff and no-store
 * headers as the record and keys, never rendered inline: it also holds text the
 * partner and the transport chose, and an attachment keeps those bytes off the
 * console's own page.
 *
 * The file is streamed rather than read whole, since a debug-level log of a long
 * run has no size bound of its own.
 */
export const Route = createFileRoute("/api/jobs/$jobId/log")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;
        const jobId = validateJobIdParam(params.jobId);
        if (jobId === null) return jobEmptyResponse(404);

        const view = gate.manager.getJobView(jobId);
        if (view === null) return jobEmptyResponse(404);
        if (view.logPath === null) return jobEmptyResponse(404);
        if (!jobFileExists(view.logPath)) return jobEmptyResponse(404);

        try {
          return await jobFileDownloadResponse(view.logPath, {
            contentType: "text/plain; charset=utf-8",
            fileName: `alcove-run-${view.id}.log`,
          });
        } catch {
          return jobEmptyResponse(404);
        }
      },
    },
  },
});
