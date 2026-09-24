import { createFileRoute } from "@tanstack/react-router";

import {
  ExchangeBusyError,
  JobRendezvousRetainRequiredError,
  JobRendezvousUnavailableError,
  JobSigningIdentityExposedError,
  MountedSigningPathsUnconvertedError,
  SftpUnavailableError,
} from "@jobs/jobManager";
import {
  MAX_JOB_BODY_BYTES,
  gateJobRoute,
  readJobRequestBody,
} from "@jobs/routeSupport";
import {
  MOUNTED_KEY_FILE_ABSENT_REFUSAL,
  MOUNTED_KEY_FILE_INVALID_REFUSAL,
  MOUNTED_SIGNING_PATHS_UNCONVERTED_REFUSAL,
  SFTP_FINGERPRINT_LIST_REFUSAL,
  SIGNING_IDENTITY_IN_RENDEZVOUS_REFUSAL,
} from "@jobs/jobCreateRefusal";
import { jobEmptyResponse, jobJsonResponse } from "@jobs/gate";
import { JobInputNotFoundError } from "@jobs/workInputs";
import { MountedKeyFileRefusedError } from "@jobs/mountedKeyFile";
import { SigningIdentityLocationError } from "@jobs/signingIdentity";
import { ZeroSetupFingerprintListError } from "@jobs/intentArgv";
import { jobCreateIntentSchema } from "@jobs/intentSchemas";

/**
 * `POST /api/jobs` -- create and start an exchange job from a typed intent.
 *
 * Feature-gated. The request body is a JSON {@link JobCreateIntent}, discriminated
 * on `mode` (a missing `mode` defaults to `exchange` for the merged client), then
 * on `channel` (filedrop | sftp): an `exchange` intent contains validated linkage
 * terms, a shared secret, and exactly one input source; a `zeroSetup` intent
 * contains neither terms nor secret (both parties infer terms from their files),
 * only an input source and bounded tuning. The server generates the job id, and for
 * an exchange composes the CLI config and key file (every path a server-chosen name
 * in the workdir; sftp connection material drawn only from the operator-authored
 * connection), while a zero-setup drives the literal positional CLI form with the
 * connection on argv (server URL plus `--server-*` flags) and no config, key, or
 * `--save`. Either way no client string reaches argv or a file path.
 *
 * The console facilitates one exchange at a time: while an exchange occupies the
 * single slot, a second create is a 409 containing `{ id }` -- the occupying
 * exchange's id -- until the current exchange is deleted. The browser re-attaches
 * to that id rather than dead-ending on the "already running" alert.
 *
 * The body is read under a byte cap ({@link MAX_JOB_BODY_BYTES}) streamed off the
 * request without trusting `Content-Length`, so an oversized body is a 413 (and
 * an unparseable one a 400) before schema validation runs.
 *
 * The unavailable rejection is EMPTY-bodied: an sftp intent with no connection
 * authored, a filedrop intent with no rendezvous directory, a filedrop intent
 * a split-provisioned console cannot run without retain mode, and a signing
 * identity location naming nothing in the secrets mount are each 400. The busy
 * rejection is a 409 containing only the occupying exchange's id (nothing else about
 * it), disclosed to the same-origin operator on their own loopback console.
 *
 * Some 400s do hold a body, each a fixed token and nothing else: a filedrop
 * intent refused because a rendezvous directory holds this party's signing
 * identity answers `{ "reason": "signing-identity-in-rendezvous" }`, a
 * zero-setup sftp intent refused because the saved connection pins more than one
 * host-key fingerprint answers `{ "reason": "sftp-fingerprint-list" }`, and a
 * run of the opened configuration refused over the `.psilink.key` beside it
 * answers `{ "reason": "mounted-key-file-absent" }` or
 * `{ "reason": "mounted-key-file-invalid" }`, and a signed run of it naming
 * unconverted signing paths answers
 * `{ "reason": "mounted-signing-paths-unconverted" }`. Each is about console state
 * rather than the intent, so the browser cannot otherwise say what to fix.
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

        const parsed = jobCreateIntentSchema.safeParse(bodyResult.value);
        if (!parsed.success) return jobEmptyResponse(400);

        let id: string;
        try {
          id = await gate.manager.createJob(parsed.data);
        } catch (error) {
          // The single slot is occupied: return its occupant's id (only) so the
          // browser can re-attach to the running exchange.
          if (error instanceof ExchangeBusyError)
            return jobJsonResponse({ id: error.activeJobId }, 409);
          // The refusal the browser cannot diagnose from the intent it sent: it
          // is about the console's mounts. The body names the refusal with a
          // fixed token and nothing else -- no path, no mount name.
          if (error instanceof JobSigningIdentityExposedError)
            return jobJsonResponse(
              { reason: SIGNING_IDENTITY_IN_RENDEZVOUS_REFUSAL },
              400,
            );
          // A direct sftp run cannot pass on the saved connection's several
          // host-key fingerprints; the fix is in the saved connection, which the
          // intent does not state, so the body names the refusal.
          if (error instanceof ZeroSetupFingerprintListError)
            return jobJsonResponse(
              { reason: SFTP_FINGERPRINT_LIST_REFUSAL },
              400,
            );
          // The key file beside the opened configuration is missing or is not
          // a key file. The token says which, and nothing read from the file.
          if (error instanceof MountedKeyFileRefusedError)
            return jobJsonResponse(
              {
                reason:
                  error.fault === "absent"
                    ? MOUNTED_KEY_FILE_ABSENT_REFUSAL
                    : MOUNTED_KEY_FILE_INVALID_REFUSAL,
              },
              400,
            );
          // A signed run of the opened configuration whose own signing paths
          // the operator did not convert to the console's.
          if (error instanceof MountedSigningPathsUnconvertedError)
            return jobJsonResponse(
              { reason: MOUNTED_SIGNING_PATHS_UNCONVERTED_REFUSAL },
              400,
            );
          // A mounted input that names no regular file, a filedrop intent with no
          // rendezvous directory configured, a filedrop intent on a
          // split-provisioned console without retain mode, an sftp intent with
          // no connection authored, or a signing identity location that names
          // nothing in the secrets mount is a 400 (the manager left no workdir
          // behind).
          if (
            error instanceof JobInputNotFoundError ||
            error instanceof JobRendezvousUnavailableError ||
            error instanceof JobRendezvousRetainRequiredError ||
            error instanceof SftpUnavailableError ||
            error instanceof SigningIdentityLocationError
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
