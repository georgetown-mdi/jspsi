import { createFileRoute } from "@tanstack/react-router";

import {
  ExchangeBusyError,
  JobRendezvousUnavailableError,
  SftpUnavailableError,
} from "@jobs/jobManager";
import {
  MAX_JOB_BODY_BYTES,
  gateJobRoute,
  readJobRequestBody,
} from "@jobs/routeSupport";
import { jobEmptyResponse, jobJsonResponse } from "@jobs/gate";
import { JobInputNotFoundError } from "@jobs/workInputs";
import { jobCreateIntentSchema } from "@jobs/intent";

/**
 * `POST /api/jobs` -- create and start an exchange job from a typed intent.
 *
 * Feature-gated. The request body is a JSON {@link JobCreateIntent}, discriminated
 * on `mode` (a missing `mode` defaults to `exchange` for the merged client), then
 * on `channel` (filedrop | sftp): an `exchange` intent carries validated linkage
 * terms, a shared secret, and exactly one input source; a `zeroSetup` intent
 * carries neither terms nor secret (both parties infer terms from their files),
 * only an input source and bounded tuning. The server generates the job id, and for
 * an exchange composes the CLI config and key file (every path a server-chosen name
 * in the workdir; sftp connection material drawn only from the operator-authored
 * connection), while a zero-setup drives the literal positional CLI form with the
 * connection on argv (server URL plus `--server-*` flags) and no config, key, or
 * `--save`. Either way no client string reaches argv or a file path.
 *
 * The console facilitates one exchange at a time: while an exchange occupies the
 * single slot, a second create is an empty-bodied 409 until the current exchange
 * is deleted.
 *
 * The body is read under a byte cap ({@link MAX_JOB_BODY_BYTES}) streamed off the
 * request without trusting `Content-Length`, so an oversized body is a 413 (and
 * an unparseable one a 400) before schema validation runs.
 *
 * The busy and unavailable rejections are EMPTY-bodied: an sftp intent with no
 * connection authored (or a filedrop intent with no rendezvous directory) is 400,
 * and a second concurrent exchange is 409.
 */
export const Route = createFileRoute("/api/jobs/")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const gate = gateJobRoute();
        if (gate.kind === "response") return gate.response;

        const bodyResult = await readJobRequestBody(
          request,
          MAX_JOB_BODY_BYTES,
        );
        if (bodyResult.kind === "too-large") return jobEmptyResponse(413);
        if (bodyResult.kind === "invalid") return jobEmptyResponse(400);

        const parsed = jobCreateIntentSchema.safeParse(bodyResult.value);
        if (!parsed.success) return jobEmptyResponse(400);

        let id: string;
        try {
          id = await gate.manager.createJob(parsed.data);
        } catch (error) {
          if (error instanceof ExchangeBusyError) return jobEmptyResponse(409);
          // A mounted input that names no regular file, a filedrop intent with no
          // rendezvous directory configured, or an sftp intent with no connection
          // authored is a 400 (the manager left no workdir behind).
          if (
            error instanceof JobInputNotFoundError ||
            error instanceof JobRendezvousUnavailableError ||
            error instanceof SftpUnavailableError
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
