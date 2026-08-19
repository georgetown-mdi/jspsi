import { createFileRoute } from "@tanstack/react-router";

import { JOB_RESPONSE_HEADERS, jobEmptyResponse } from "@jobs/gate";
import { createJobEventStream, resumeOffsetFrom } from "@jobs/sse";
import { gateJobRoute, validateJobIdParam } from "@jobs/routeSupport";

/**
 * `GET /api/jobs/:jobId/events` -- the job's event stream over SSE.
 *
 * Feature-gated and id-validated. Every connect replays the job's complete event
 * history from the start with monotonic ids; a `Last-Event-ID` header (or a
 * `?lastEventId=` query fallback) resumes from that offset. An idle stream writes
 * a keepalive frame so an intermediary's idle window does not cut the operator's
 * view of a waiting run. The stream closes after the terminal event is delivered.
 * Since a job's full history is retained in memory for its lifetime, a reconnect
 * resumes losslessly.
 */
export const Route = createFileRoute("/api/jobs/$jobId/events")({
  server: {
    handlers: {
      GET: ({ request, params }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;
        const jobId = validateJobIdParam(params.jobId);
        if (jobId === null) return jobEmptyResponse(404);

        const record = gate.manager.getJob(jobId);
        if (record === undefined) return jobEmptyResponse(404);

        const stream = createJobEventStream({
          manager: gate.manager,
          record,
          afterId: resumeOffsetFrom(request),
          signal: request.signal,
        });

        return new Response(stream, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            Connection: "keep-alive",
            ...JOB_RESPONSE_HEADERS,
          },
        });
      },
    },
  },
});
