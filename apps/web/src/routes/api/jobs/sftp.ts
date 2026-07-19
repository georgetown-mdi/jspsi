import { createFileRoute } from "@tanstack/react-router";

import { gateJobRoute } from "@jobs/routeSupport";
import { jobJsonResponse } from "@jobs/gate";

/**
 * `GET /api/jobs/sftp` -- report the operator-provisioned SFTP server a client
 * runs an sftp job against. Shares `gateJobRoute` (404 when the API is disabled,
 * no-store, no CORS), the same shape family as `/api/jobs/rendezvous`.
 *
 * The body is `{ configured: false }` or `{ configured: true, host, port?,
 * path? }` -- the manager's explicitly mapped, credential-free projection (no
 * username, no credential reference, no fingerprint). An enabled API with no
 * server provisioned reads as `{ configured: false }`. The console web build
 * uses this to gate the run-SFTP-here behavior and to author an invitation's
 * sftp endpoint from the provisioned locator. The static `sftp` segment can
 * never be captured as a `$jobId` parameter: job ids are validated as v4 UUIDs
 * before any use, which `sftp` is not.
 */
export const Route = createFileRoute("/api/jobs/sftp")({
  server: {
    handlers: {
      GET: () => {
        const gate = gateJobRoute();
        if (gate.kind === "response") return gate.response;
        const connection = gate.manager.sftpProjection();
        return jobJsonResponse(
          connection === null
            ? { configured: false }
            : { configured: true, ...connection },
        );
      },
    },
  },
});
