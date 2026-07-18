import { createFileRoute } from "@tanstack/react-router";

import {
  JobInputParseBusyError,
  MAX_COVERAGE_BODY_BYTES,
  UnknownJobInputError,
  coverageJobInput,
  coverageRequestSchema,
  isAdmissibleInputName,
  useJobInputDir,
  useJobInputParseGate,
} from "@jobs/workInputs";
import { gateJobRoute, readJobRequestBody } from "@jobs/routeSupport";
import { jobEmptyResponse, jobJsonResponse } from "@jobs/gate";

/**
 * `POST /api/jobs/inputs/coverage` -- compute per-field non-empty coverage over one
 * mounted input CSV under a submitted standardization, in a single streaming pass.
 * Shares `gateJobRoute`.
 *
 * The body `{ name, sizeBytes, modifiedAt, standardization }` is read under a
 * 1 MiB cap and validated: the standardization goes through the same bounded schema
 * the job intent uses PLUS a route-level per-step pattern-length cap (RE2JS is
 * linear at run time, but its compile cost lands on this event loop). The file is
 * admitted exactly as the profile route admits it, and its open-time size/mtime
 * must equal the submitted profiled pair or the coverage is refused as drifted.
 * Failures are empty-bodied and never echo the name: `404` for an unset directory
 * or unknown file, `400` for a bad body, schema failure, or drift, `413` for an
 * oversized body, and `429` when the one-at-a-time parse gate is full.
 */
export const Route = createFileRoute("/api/jobs/inputs/coverage")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;
        const resolvedDir = useJobInputDir();
        if (resolvedDir === undefined) return jobEmptyResponse(404);

        const body = await readJobRequestBody(request, MAX_COVERAGE_BODY_BYTES);
        if (body.kind === "too-large") return jobEmptyResponse(413);
        if (body.kind === "invalid") return jobEmptyResponse(400);

        const parsed = coverageRequestSchema.safeParse(body.value);
        if (!parsed.success) return jobEmptyResponse(400);
        const { name, sizeBytes, modifiedAt, standardization } = parsed.data;
        if (!isAdmissibleInputName(name)) return jobEmptyResponse(404);

        try {
          const rates = await useJobInputParseGate().run(() =>
            coverageJobInput(
              resolvedDir,
              name,
              sizeBytes,
              modifiedAt,
              standardization,
            ),
          );
          return jobJsonResponse({ rates });
        } catch (error) {
          if (error instanceof JobInputParseBusyError)
            return jobEmptyResponse(429);
          if (error instanceof UnknownJobInputError)
            return jobEmptyResponse(404);
          return jobEmptyResponse(400);
        }
      },
    },
  },
});
