import { createFileRoute } from "@tanstack/react-router";

import { listJobInputs, useJobInputDir } from "@jobs/workInputs";
import { gateJobRoute } from "@jobs/routeSupport";
import { jobJsonResponse } from "@jobs/gate";

/**
 * `GET /api/jobs/inputs` -- list the operator-mounted input CSVs the console reads
 * (name, size, modified time). Shares `gateJobRoute` (404 when the API is disabled,
 * no-store, no CORS).
 *
 * The body is `{ configured, readable, files }`. The input directory defaults to
 * `JOB_DATA_ROOT` when `JOB_INPUT_DIR` is unset, so once the job API is enabled the
 * listing is `configured: true` and reads out of the resolved directory; a
 * configured-but-unreadable mount is `readable: false` with an empty list, distinct
 * from an empty-but-readable directory, so the console tells the operator to check the
 * mount rather than to place a file that may already be there.
 */
export const Route = createFileRoute("/api/jobs/inputs/")({
  server: {
    handlers: {
      GET: () => {
        const gate = gateJobRoute();
        if (gate.kind === "response") return gate.response;
        return jobJsonResponse(listJobInputs(useJobInputDir()));
      },
    },
  },
});
