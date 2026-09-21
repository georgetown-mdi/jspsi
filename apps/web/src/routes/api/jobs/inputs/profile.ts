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
import { jobCsvDelimiterSchema } from "@jobs/intentSchemas";

/**
 * `GET /api/jobs/inputs/profile?name=...` -- profile one mounted input CSV in a
 * single streaming, constant-memory pass: columns, row count, inferred date-input
 * format, and the first few non-empty values per column. Shares `gateJobRoute`.
 *
 * The optional `delimiter` parameter is the operator's own field-delimiter choice,
 * graded by the job intent's own rule; absent, the pass reads commas. A value the
 * grade refuses is a bare `400` rather than a read by a delimiter nobody chose.
 *
 * The input directory defaults to `JOB_DATA_ROOT` when `JOB_INPUT_DIR` is unset, so
 * once the job API is enabled a directory is always resolved; a name that resolves to
 * no regular file is `404`. A profiling fault is a `400` whose body holds only a
 * closed error code ({@link JobInputProfileError}) -- never the underlying error,
 * whose message could embed the mounted path or a cell's bytes -- so the browser
 * names the reason itself. The mounted directory is the operator's own data, so
 * the responses need no further redaction.
 */
export const Route = createFileRoute("/api/jobs/inputs/profile")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;
        const resolvedDir = useJobInputDir();
        if (resolvedDir === undefined) return jobEmptyResponse(404);

        const parameters = new URL(request.url).searchParams;
        const name = parameters.get("name");
        if (name === null || !isAdmissibleInputName(name))
          return jobEmptyResponse(404);

        const requested = parameters.get("delimiter");
        const delimiter =
          requested === null
            ? undefined
            : jobCsvDelimiterSchema.safeParse(requested);
        if (delimiter !== undefined && !delimiter.success)
          return jobEmptyResponse(400);

        try {
          return jobJsonResponse(
            await profileJobInput(resolvedDir, name, delimiter?.data),
          );
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
