import { createFileRoute } from "@tanstack/react-router";

import {
  JobInputNotFoundError,
  isAdmissibleInputName,
  profileJobInput,
  useJobInputDir,
} from "@jobs/workInputs";
import { jobEmptyResponse, jobJsonResponse } from "@jobs/gate";
import { gateJobRoute } from "@jobs/routeSupport";

/**
 * `GET /api/jobs/inputs/profile?name=...` -- profile one mounted input CSV in a
 * single streaming, constant-memory pass: columns, row count, inferred date-input
 * format, and the first few non-empty values per column. Shares `gateJobRoute`.
 *
 * An unset directory or a name that resolves to no regular file is `404`; any other
 * profiling fault is `400`. The mounted directory is the operator's own data, so the
 * responses are ordinary.
 */
export const Route = createFileRoute("/api/jobs/inputs/profile")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;
        const resolvedDir = useJobInputDir();
        if (resolvedDir === undefined) return jobEmptyResponse(404);

        const name = new URL(request.url).searchParams.get("name");
        if (name === null || !isAdmissibleInputName(name))
          return jobEmptyResponse(404);

        try {
          return jobJsonResponse(await profileJobInput(resolvedDir, name));
        } catch (error) {
          if (error instanceof JobInputNotFoundError)
            return jobEmptyResponse(404);
          return jobEmptyResponse(400);
        }
      },
    },
  },
});
