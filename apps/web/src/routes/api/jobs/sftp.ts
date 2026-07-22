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

import type { SftpConnectionProjection } from "@jobs/jobManager";

/**
 * `/api/jobs/sftp` -- the SFTP connection an sftp job runs against. Shares
 * `gateJobRoute` (404 when the API is disabled, no-store, no CORS), the same
 * shape family as `/api/jobs/rendezvous`.
 *
 * - `GET` reports the in-app authored connection as the manager's explicitly
 *   mapped, credential-free projection: `{ configured: false }` or
 *   `{ configured: true, host, port?, path? }` -- no username, credential
 *   reference, or fingerprint. The console web build gates the run-SFTP-here
 *   behavior and authors an invitation endpoint from this locator.
 * - `PUT` authors the connection from a file-reference credential body. A
 *   validation failure is a `400` naming a field path, never a value.
 * - `DELETE` forgets the authored connection (idempotent `204`).
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
        return jobJsonResponse(
          connection === null
            ? { configured: false }
            : { configured: true, ...connection },
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
          // A validation failure names a field path only (never a submitted
          // value), so surfacing the message helps the operator fix the input
          // without leaking a credential reference or secret.
          if (error instanceof JobApiConfigError)
            return jobJsonResponse({ error: error.message }, 400);
          return jobEmptyResponse(400);
        }
        return jobJsonResponse({
          configured: true,
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
