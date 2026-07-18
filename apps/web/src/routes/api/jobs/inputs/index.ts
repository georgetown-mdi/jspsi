import { createFileRoute } from "@tanstack/react-router";

import { listJobInputs, useJobInputDir } from "@jobs/workInputs";
import { gateJobRoute } from "@jobs/routeSupport";
import { jobJsonResponse } from "@jobs/gate";

/**
 * `GET /api/jobs/inputs` -- list the operator-mounted input CSVs the server may
 * read (name, size, and modified time). Shares `gateJobRoute` (404 when the API is
 * disabled, 401 on a bad bearer, no-store, no CORS).
 *
 * The body is `{ configured, totalEntries, truncated, files }`. When
 * `JOB_INPUT_DIR` is unset the listing is `configured: false` with an empty list
 * (reachable only when the job API itself is enabled), so the console UI renders an
 * actionable "set JOB_INPUT_DIR and mount a directory" state rather than a
 * mysteriously empty list. `totalEntries` (the raw readdir count before admission)
 * lets the UI distinguish an empty directory from one whose entries are all
 * inadmissible (dotfiles, directories, symlinks).
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
