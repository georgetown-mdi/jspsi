import { createFileRoute } from "@tanstack/react-router";

import {
  JobInputDriftError,
  JobInputInsufficientSpaceError,
  UnknownJobInputError,
} from "@jobs/workInputs";
import {
  MAX_JOB_BODY_BYTES,
  gateJobRoute,
  readJobRequestBody,
} from "@jobs/routeSupport";
import { SftpRemoteBusyError, UnknownSftpRemoteError } from "@jobs/jobManager";
import { jobEmptyResponse, jobJsonResponse } from "@jobs/gate";
import { jobExchangeIntentSchema } from "@jobs/intent";

/**
 * `GET /api/jobs` -- list every job the manager knows: live in-memory records
 * plus restart-restored jobs re-discovered from their on-disk artifacts, deduped
 * by id. Auth-gated.
 *
 * `POST /api/jobs` -- create and start an exchange job from a typed intent.
 *
 * Auth-gated. The request body is a JSON {@link JobExchangeIntent}: a filedrop
 * or sftp exchange with validated linkage terms, a shared secret, and exactly one
 * input source -- inline CSV content or a reference to an operator-mounted file
 * (re-admitted against the server's own directory enumeration and snapshot-copied
 * into the workdir). The server generates the job id, composes the CLI config from
 * the intent (every path a server-chosen name in the workdir; sftp connection
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
      GET: async ({ request }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;
        return jobJsonResponse({ jobs: await gate.manager.listJobs() });
      },
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
          // An unknown/vanished mounted input, a freshness drift, or insufficient
          // space is an empty-bodied 400 that never echoes the name -- the
          // unknown-remote posture (the manager left no workdir behind).
          if (
            error instanceof UnknownJobInputError ||
            error instanceof JobInputDriftError ||
            error instanceof JobInputInsufficientSpaceError
          )
            return jobEmptyResponse(400);
          // Workdir creation or an input write failed (the manager has already
          // cleaned up); no internal detail crosses the boundary.
          return jobEmptyResponse(500);
        }
        return jobJsonResponse({ id }, 201);
      },
    },
  },
});
