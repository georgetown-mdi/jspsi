import { createFileRoute } from "@tanstack/react-router";

import { gateJobRoute } from "@jobs/routeSupport";
import { jobJsonResponse } from "@jobs/gate";

/**
 * `GET /api/jobs/remotes` -- the operator-provisioned SFTP remotes a client may
 * name in an sftp job intent.
 *
 * Auth-gated like every job route (404 when the API is disabled, 401 on a bad
 * bearer). The body is the manager's explicitly mapped projection -- name and
 * locator fields only, never a credential reference or fingerprint -- and an
 * enabled API with no remotes configured serves an empty array. The static
 * `remotes` segment can never be captured as a `$jobId` parameter: job ids are
 * validated as v4 UUIDs before any use, which `remotes` is not.
 */
export const Route = createFileRoute("/api/jobs/remotes")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;
        return jobJsonResponse(gate.manager.listSftpRemotes());
      },
    },
  },
});
