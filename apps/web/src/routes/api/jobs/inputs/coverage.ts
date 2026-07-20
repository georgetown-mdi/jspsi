import { createFileRoute } from "@tanstack/react-router";

import {
  JobInputCoverageAbortedError,
  JobInputNotFoundError,
  MAX_COVERAGE_BODY_BYTES,
  coverageJobInput,
  coverageRequestSchema,
  isAdmissibleInputName,
  useJobInputDir,
} from "@jobs/workInputs";
import { gateJobRoute, readJobRequestBody } from "@jobs/routeSupport";
import { jobEmptyResponse, jobJsonResponse } from "@jobs/gate";

/**
 * `POST /api/jobs/inputs/coverage` -- compute per-field non-empty coverage over one
 * mounted input CSV under a submitted standardization, in a single streaming pass.
 * Shares `gateJobRoute`.
 *
 * The body `{ name, standardization }` is read under a 1 MiB cap and validated: the
 * standardization goes through the same bounded schema the job intent uses PLUS a
 * route-level per-step pattern-length cap (RE2JS is linear at run time, but its
 * compile cost lands on this event loop). The input directory defaults to
 * `JOB_DATA_ROOT` when `JOB_INPUT_DIR` is unset, so once the job API is enabled a
 * directory is always resolved; a name that resolves to no regular file is `404`, a
 * bad or oversized body is `400`/`413`, and any other sweep fault is `400`.
 *
 * `request.signal` threads into the sweep so a client disconnect stops the whole-file
 * pass rather than scanning a CLI-scale file to completion after the browser has
 * superseded or abandoned the request.
 */
export const Route = createFileRoute("/api/jobs/inputs/coverage")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const gate = gateJobRoute();
        if (gate.kind === "response") return gate.response;
        const resolvedDir = useJobInputDir();
        if (resolvedDir === undefined) return jobEmptyResponse(404);

        const body = await readJobRequestBody(request, MAX_COVERAGE_BODY_BYTES);
        if (body.kind === "too-large") return jobEmptyResponse(413);
        if (body.kind === "invalid") return jobEmptyResponse(400);

        const parsed = coverageRequestSchema.safeParse(body.value);
        if (!parsed.success) return jobEmptyResponse(400);
        const { name, standardization } = parsed.data;
        if (!isAdmissibleInputName(name)) return jobEmptyResponse(404);

        try {
          const rates = await coverageJobInput(
            resolvedDir,
            name,
            standardization,
            request.signal,
          );
          return jobJsonResponse({ rates });
        } catch (error) {
          if (error instanceof JobInputCoverageAbortedError)
            // The client already disconnected or superseded this sweep; nothing reads
            // the response, so answer without spending a status on an aborted pass.
            return jobEmptyResponse(499);
          if (error instanceof JobInputNotFoundError)
            return jobEmptyResponse(404);
          return jobEmptyResponse(400);
        }
      },
    },
  },
});
