import { createFileRoute } from "@tanstack/react-router";

import {
  MAX_JOB_BODY_BYTES,
  gateJobRoute,
  readJobRequestBody,
} from "@jobs/routeSupport";
import { SftpRemoteBusyError, UnknownSftpRemoteError } from "@jobs/jobManager";
import { jobEmptyResponse, jobJsonResponse } from "@jobs/gate";
import { jobExchangeIntentSchema } from "@jobs/intent";

/**
 * `POST /api/jobs` -- create and start an exchange job from a typed intent.
 *
 * Auth-gated. The request body is a JSON {@link JobExchangeIntent}: a filedrop
 * or sftp exchange with validated linkage terms, a shared secret, and inline CSV
 * content. The server generates the job id, composes the CLI config from the
 * intent (every path a server-chosen name in the workdir; sftp connection
 * material drawn only from the operator-provisioned remotes table), writes the
 * inputs, and spawns the CLI. No client string reaches argv or a file path.
 *
 * The body is read under a byte cap ({@link MAX_JOB_BODY_BYTES}) streamed off the
 * request without trusting `Content-Length`, so an oversized body is a 413 (and
 * an unparseable one a 400) before schema validation runs.
 *
 * The sftp rejections are EMPTY-bodied: an unknown remote is 400 and a busy
 * one 409, and neither response reflects the requested name.
 */
export const Route = createFileRoute("/api/jobs/")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;

        const bodyResult = await readJobRequestBody(
          request,
          MAX_JOB_BODY_BYTES,
        );
        if (bodyResult.kind === "too-large") return jobEmptyResponse(413);
        if (bodyResult.kind === "invalid") return jobEmptyResponse(400);

        const parsed = jobExchangeIntentSchema.safeParse(bodyResult.value);
        if (!parsed.success) return jobEmptyResponse(400);

        let id: string;
        try {
          id = await gate.manager.createJob(parsed.data);
        } catch (error) {
          if (error instanceof UnknownSftpRemoteError)
            return jobEmptyResponse(400);
          if (error instanceof SftpRemoteBusyError)
            return jobEmptyResponse(409);
          // Workdir creation or an input write failed (the manager has already
          // cleaned up); no internal detail crosses the boundary.
          return jobEmptyResponse(500);
        }
        return jobJsonResponse({ id }, 201);
      },
    },
  },
});
