import fsp from "node:fs/promises";

import { createFileRoute } from "@tanstack/react-router";

import { JOB_RESPONSE_HEADERS, jobEmptyResponse } from "@jobs/gate";
import { gateJobRoute, validateJobIdParam } from "@jobs/routeSupport";
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

        const body = await fsp.readFile(view.logPath);
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition": `attachment; filename="psilink-run-${view.id}.log"`,
            "X-Content-Type-Options": "nosniff",
            ...JOB_RESPONSE_HEADERS,
          },
        });
      },
    },
  },
});
