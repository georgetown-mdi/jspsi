import { createFileRoute } from "@tanstack/react-router";

import {
  JobApiConfigError,
  jobEmptyResponse,
  jobJsonResponse,
} from "@jobs/gate";
import {
  MAX_SFTP_AUTHOR_BODY_BYTES,
  gateJobRoute,
  readJobRequestBody,
} from "@jobs/routeSupport";
import { SftpServerBootPinnedError } from "@jobs/jobManager";

import type { SftpConnectionProjection } from "@jobs/jobManager";

/**
 * `/api/jobs/sftp` -- the SFTP connection an sftp job runs against. Shares
 * `gateJobRoute` (404 when the API is disabled, no-store, no CORS), the same
 * shape family as `/api/jobs/rendezvous`.
 *
 * - `GET` reports the effective connection (a boot `JOB_SFTP_SERVER` if set, else
 *   the in-app authored connection) as the manager's explicitly mapped,
 *   credential-free projection: `{ configured: false, bootPinned }` or
 *   `{ configured: true, bootPinned, host, port?, path? }` -- no username,
 *   credential reference, or fingerprint. `bootPinned` is true only for a boot
 *   `JOB_SFTP_SERVER` (a `PUT` would 409), so the console shows it read-only and
 *   offers in-app authoring/clear only for an authored (or absent) connection.
 *   The console web build gates the run-SFTP-here behavior and authors an
 *   invitation endpoint from this locator.
 * - `PUT` authors the connection from a file-reference credential body, validated
 *   through the same chain the boot loader uses. A boot server wins: authoring
 *   over one is refused (`409`). A validation failure is a `400` naming a field
 *   path, never a value.
 * - `DELETE` forgets the authored connection (idempotent `204`); a boot server is
 *   unaffected.
 *
 * The static `sftp` segment can never be captured as a `$jobId` parameter: job
 * ids are validated as v4 UUIDs before any use, which `sftp` is not. `POST` stays
 * closed on `/api/jobs` -- all authored connection material flows through this
 * endpoint, so the job-create intent gains no connection field.
 */
export const Route = createFileRoute("/api/jobs/sftp")({
  server: {
    handlers: {
      GET: () => {
        const gate = gateJobRoute();
        if (gate.kind === "response") return gate.response;
        const connection = gate.manager.sftpProjection();
        const bootPinned = gate.manager.hasBootSftpServer();
        return jobJsonResponse(
          connection === null
            ? { configured: false, bootPinned }
            : { configured: true, bootPinned, ...connection },
        );
      },
      PUT: async ({ request }) => {
        const gate = gateJobRoute();
        if (gate.kind === "response") return gate.response;

        const body = await readJobRequestBody(
          request,
          MAX_SFTP_AUTHOR_BODY_BYTES,
        );
        if (body.kind === "too-large") return jobEmptyResponse(413);
        if (body.kind === "invalid") return jobEmptyResponse(400);

        let connection: SftpConnectionProjection;
        try {
          connection = gate.manager.authorSftpServer(body.value);
        } catch (error) {
          if (error instanceof SftpServerBootPinnedError)
            return jobJsonResponse({ error: error.message }, 409);
          // A validation failure names a field path only (never a submitted
          // value), so surfacing the message helps the operator fix the input
          // without leaking a credential reference or secret.
          if (error instanceof JobApiConfigError)
            return jobJsonResponse({ error: error.message }, 400);
          return jobEmptyResponse(400);
        }
        // A PUT succeeds only when no boot server is pinned (else 409 above), so
        // the authored connection is never boot-pinned.
        return jobJsonResponse({
          configured: true,
          bootPinned: false,
          ...connection,
        });
      },
      DELETE: () => {
        const gate = gateJobRoute();
        if (gate.kind === "response") return gate.response;
        gate.manager.clearAuthoredSftpServer();
        return jobEmptyResponse(204);
      },
    },
  },
});
