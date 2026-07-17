import { createFileRoute } from "@tanstack/react-router";

import { JOB_RESPONSE_HEADERS, jobEmptyResponse } from "@jobs/gate";
import { gateJobRoute, validateJobIdParam } from "@jobs/routeSupport";
import { renderSseFrame, resumeOffsetFrom } from "@jobs/sse";

/**
 * `GET /api/jobs/:jobId/events` -- the job's event stream over SSE.
 *
 * Auth-gated and id-validated. Every connect replays the job's complete event
 * history from the start with monotonic ids; a `Last-Event-ID` header (or a
 * `?lastEventId=` query fallback) resumes from that offset. The stream closes
 * after the terminal event is delivered. Since a job's full history is retained
 * in memory for its lifetime, a reconnect resumes losslessly.
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

        const afterId = resumeOffsetFrom(request);
        const manager = gate.manager;

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            // Already aborted between the request and this callback: the later
            // addEventListener would never fire post-abort, so the subscription
            // would leak into the record. Close without subscribing.
            if (request.signal.aborted) {
              controller.close();
              return;
            }

            const encoder = new TextEncoder();
            const push = (id: number, event: unknown): void => {
              controller.enqueue(encoder.encode(renderSseFrame(id, event)));
            };

            const { replay, unsubscribe } = manager.subscribe(
              record,
              afterId,
              (entry) => {
                push(entry.id, entry.event);
                if (
                  entry.event.type === "result" ||
                  entry.event.type === "error"
                ) {
                  unsubscribe();
                  controller.close();
                }
              },
            );

            for (const entry of replay) push(entry.id, entry.event);

            // When the terminal event is already in the replay, the job is done;
            // close the stream rather than hold an idle connection open.
            if (record.terminalEmitted) {
              controller.close();
              return;
            }

            // Release the subscription if the client disconnects mid-stream.
            request.signal.addEventListener("abort", () => {
              unsubscribe();
              try {
                controller.close();
              } catch {
                // Already closed; nothing to do.
              }
            });
          },
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
