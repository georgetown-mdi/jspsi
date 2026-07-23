import { createFileRoute } from "@tanstack/react-router";

import {
  JobInputNotFoundError,
  JobInputProfileError,
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
 * The input directory defaults to `JOB_DATA_ROOT` when `JOB_INPUT_DIR` is unset, so
 * once the job API is enabled a directory is always resolved; a name that resolves to
 * no regular file is `404`. A profiling fault is a `400` whose body carries only a
 * closed error code
 * ({@link JobInputProfileError}) -- never the underlying error, whose message could
 * embed the mounted path or a cell's bytes -- so the browser names the reason. The
 * mounted directory is the operator's own data, so the responses are ordinary.
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
          if (error instanceof JobInputProfileError)
            return jobJsonResponse({ error: error.code }, 400);
          return jobEmptyResponse(400);
        }
      },
    },
  },
});
