import { createFileRoute } from "@tanstack/react-router";

import { listJobInputs, useJobInputDir } from "@jobs/workInputs";
import { gateJobRoute } from "@jobs/routeSupport";
import { jobJsonResponse } from "@jobs/gate";

/**
 * `GET /api/jobs/inputs` -- list the operator-mounted input CSVs the console reads
 * (name, size, modified time). Shares `gateJobRoute` (404 when the API is disabled,
 * 401 on a bad bearer, no-store, no CORS).
 *
 * The body is `{ configured, files }`. When `JOB_INPUT_DIR` is unset the listing is
 * `configured: false` with an empty list, so the console renders its no-directory
 * state rather than a mysteriously empty list.
 */
export const Route = createFileRoute("/api/jobs/inputs/")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;
        return jobJsonResponse(listJobInputs(useJobInputDir()));
      },
    },
  },
});
