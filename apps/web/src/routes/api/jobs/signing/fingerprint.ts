import { createFileRoute } from "@tanstack/react-router";

import { z } from "zod";

import {
  IDENTITY_CONTROL_CHAR_MESSAGE,
  IDENTITY_CONTROL_CHAR_PATTERN,
  MAX_IDENTITY_LENGTH,
} from "@jobs/intentSchemas";

import {
  MAX_SIGNING_FINGERPRINT_BODY_BYTES,
  gateJobRoute,
  readJobRequestBody,
} from "@jobs/routeSupport";
import {
  SIGNING_CERTIFICATE_FILE_NAME,
  SIGNING_IDENTITY_FILE_NAME,
} from "@jobs/signingIdentity";
import { jobEmptyResponse, jobJsonResponse } from "@jobs/gate";
import { SigningFingerprintBusyError } from "@jobs/jobManager";
import { formatFirstIssue } from "@jobs/schemaIssueMessage";

import type { SigningFingerprintResult } from "@jobs/signingIdentity";

/**
 * The strict fingerprint body: an identity label to bind to a NEW identity, and
 * whether to also write the public certificate out. `.strictObject` rejects any
 * unmodeled key, so the request can only ever say WHOSE identity to mint, never
 * where to read or write. The label is held to the shared label contract
 * (`@jobs/intentSchemas`): bounded by {@link MAX_IDENTITY_LENGTH}, refused a
 * leading `-`, and refused any control character -- the last is critical rather
 * than defensive, since the label binds into a long-lived certificate every
 * partner pins, and a NUL would otherwise be caught only incidentally, where the
 * child is spawned.
 */
const fingerprintBodySchema = z.strictObject({
  identity: z
    .string()
    .min(1)
    .max(MAX_IDENTITY_LENGTH)
    .regex(/^[^-]/, "identity must not begin with '-'")
    .refine((label) => !IDENTITY_CONTROL_CHAR_PATTERN.test(label), {
      message: IDENTITY_CONTROL_CHAR_MESSAGE,
    }),
  exportCertificate: z.boolean().optional(),
});

/**
 * The typed 200 envelope for a fingerprint attempt that RAN: a completed attempt
 * is always a 200 with a discriminated body. Success includes the re-validated
 * fingerprint, whether this call created the identity, and the two mount FILE
 * NAMES the console's copy points the operator at -- names, never paths, so no
 * container location crosses the boundary. Anything else is a category
 * (`refused` / `timeout` / `error`), so the client reads the outcome from the
 * body rather than from the status.
 */
function fingerprintEnvelope(
  result: SigningFingerprintResult,
): Record<string, unknown> {
  if (result.kind !== "ok") return { status: result.kind };
  return {
    status: "ok",
    fingerprint: result.fingerprint,
    created: result.created,
    identityFileName: SIGNING_IDENTITY_FILE_NAME,
    ...(result.certificateExported
      ? { certificateFileName: SIGNING_CERTIFICATE_FILE_NAME }
      : {}),
  };
}

/**
 * `POST /api/jobs/signing/fingerprint` -- create-or-reuse this party's signing
 * identity in the console's mounted working directory and return its
 * fingerprint, so the operator can share it out-of-band before a signed exchange.
 *
 * It is the console's whole signing-identity surface, narrow by design: it can
 * create-or-reuse and export the PUBLIC certificate, but cannot regenerate --
 * re-keying invalidates every partner-pinned fingerprint, so that coordinated
 * action stays on the command line (`psilink fingerprint --force`).
 *
 * The request contains an identity label and a boolean ONLY; the response
 * contains a fingerprint, a created flag, and fixed file names ONLY -- never a
 * container path (every path stays with the manager,
 * {@link JobManager.resolveSigningFingerprint}; child stderr is discarded before
 * it reaches this layer). `gateJobRoute` 404s a hosted build or an unset
 * `JOB_DATA_ROOT`; the body is capped at
 * {@link MAX_SIGNING_FINGERPRINT_BODY_BYTES} (413 over, 400 unparseable).
 */
export const Route = createFileRoute("/api/jobs/signing/fingerprint")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;

        const body = await readJobRequestBody(
          request,
          MAX_SIGNING_FINGERPRINT_BODY_BYTES,
        );
        if (body.kind === "too-large") return jobEmptyResponse(413);
        if (body.kind === "invalid") return jobEmptyResponse(400);

        const parsed = fingerprintBodySchema.safeParse(body.value);
        if (!parsed.success)
          return jobJsonResponse(
            { error: formatFirstIssue(parsed.error.issues) },
            400,
          );

        let result: SigningFingerprintResult;
        try {
          result = await gate.manager.resolveSigningFingerprint({
            identityLabel: parsed.data.identity,
            exportCertificate: parsed.data.exportCertificate === true,
          });
        } catch (error) {
          // A request already in flight is a 409 (the busy convention). Anything
          // else is an unexpected internal fault -- no detail crosses the boundary.
          if (error instanceof SigningFingerprintBusyError)
            return jobEmptyResponse(409);
          return jobEmptyResponse(500);
        }
        return jobJsonResponse(fingerprintEnvelope(result));
      },
    },
  },
});
