import { createFileRoute } from "@tanstack/react-router";

import { jobEmptyResponse, jobJsonResponse } from "@jobs/gate";
import { gateJobRoute } from "@jobs/routeSupport";
import { jobExchangeIntentSchema } from "@jobs/intent";

/**
 * `POST /api/jobs` -- create and start an exchange job from a typed intent.
 *
 * Auth-gated. The request body is a JSON {@link JobExchangeIntent}: a filedrop
 * exchange with validated linkage terms, a shared secret, and inline CSV content.
 * The server generates the job id, composes the CLI config from the intent
 * (overriding every path to a server-chosen name in the workdir), writes the
 * inputs, and spawns the CLI. No client string reaches argv or a file path.
 */
export const Route = createFileRoute("/api/jobs/")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jobEmptyResponse(400);
        }

        const parsed = jobExchangeIntentSchema.safeParse(body);
        if (!parsed.success) return jobEmptyResponse(400);

        const id = await gate.manager.createJob(parsed.data);
        return jobJsonResponse({ id }, 201);
      },
    },
  },
});
