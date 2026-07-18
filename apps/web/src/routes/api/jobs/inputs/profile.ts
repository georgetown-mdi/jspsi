import { createFileRoute } from "@tanstack/react-router";

import {
  JobInputParseBusyError,
  UnknownJobInputError,
  isAdmissibleInputName,
  profileJobInput,
  useJobInputDir,
  useJobInputParseGate,
} from "@jobs/workInputs";
import { jobEmptyResponse, jobJsonResponse } from "@jobs/gate";
import { gateJobRoute } from "@jobs/routeSupport";

/**
 * `GET /api/jobs/inputs/profile?name=...` -- profile one mounted input CSV in a
 * single streaming, constant-memory pass: columns, row count, inferred date-input
 * format, and the first few non-empty values per column. Shares `gateJobRoute`.
 *
 * The name is validated for shape and then admitted only by exact-string match
 * against the server's own directory listing, opened with `O_NOFOLLOW` and an
 * inode recheck. Failures are empty-bodied and never echo the requested name: an
 * unset directory or an unknown/unreadable name is `404`, an unusable file is
 * `400`, and a request that finds the one-at-a-time parse gate full is `429`.
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
          const profile = await useJobInputParseGate().run(() =>
            profileJobInput(resolvedDir, name),
          );
          return jobJsonResponse(profile);
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
