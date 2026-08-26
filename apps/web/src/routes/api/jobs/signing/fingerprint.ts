import { createFileRoute } from "@tanstack/react-router";

import { z } from "zod";

import { MAX_IDENTITY_LENGTH } from "@psi/identityLabel";

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

import type { SigningFingerprintResult } from "@jobs/signingIdentity";

/**
 * The strict fingerprint body: the identity label to bind to a NEW identity, and
 * whether to also write the public certificate out. NOTHING else -- no path, no
 * `--force`, and `.strictObject` rejects any unmodeled key -- so the request can
 * only ever say WHOSE identity to mint, never where to read or write.
 *
 * The label is the operator's own `linkage_terms.identity`, bounded by the shared
 * {@link MAX_IDENTITY_LENGTH} and forbidden a leading `-` on the same terms the
 * zero-setup intent's `identity` is: the driver emits it as a single
 * `--identity=<value>` token, which parses a `-`-leading value verbatim anyway, so
 * this is defense in depth rather than the only guard.
 */
const fingerprintBodySchema = z.strictObject({
  identity: z
    .string()
    .min(1)
    .max(MAX_IDENTITY_LENGTH)
    .regex(/^[^-]/, "identity must not begin with '-'"),
  exportCertificate: z.boolean().optional(),
});

/** Format the first zod issue as `<field>: <reason>` -- a field path and a shape
 * reason only, never a submitted value (the `JobApiConfigError` discipline). */
function formatFirstIssue(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): string {
  const issue = issues[0];
  const field =
    issue.path.length > 0 ? issue.path.map(String).join(".") : "body";
  return `${field}: ${issue.message}`;
}

/**
 * The typed 200 envelope for a fingerprint attempt that RAN. A completed attempt
 * is always a 200 with a discriminated body: success carries the re-validated
 * fingerprint, whether the identity was created by this call, and the two mount
 * FILE NAMES the console's copy points the operator at -- names, never paths, so
 * no container location crosses the boundary. Anything else is a category
 * (`refused` / `timeout` / `error`), so the client reads the outcome from the body
 * rather than from the status.
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
 * identity in the appliance's mounted working directory and return its
 * fingerprint, so the operator can share it out-of-band before a signed exchange
 * (the partner pins it first, which is why the identity must exist before the run
 * rather than during it).
 *
 * It is the console's whole signing-identity surface, and deliberately a narrow
 * one: it can create-or-reuse and it can export the PUBLIC certificate. It cannot
 * regenerate -- there is no `--force` here and no body field that would reach one
 * -- because a re-key invalidates every fingerprint a partner has pinned, and that
 * coordinated action stays on the command line where the flag names what it does.
 * Nothing here refuses the operator anything: `psilink fingerprint --force` is
 * theirs to run against the same mounted file whenever they mean to.
 *
 * The request carries an identity label and a boolean ONLY; the response carries a
 * canonical fingerprint, a created flag, and fixed file names ONLY. Every path is
 * the manager's ({@link JobManager.resolveSigningFingerprint}); child stderr,
 * which names container paths, is discarded before it reaches this layer.
 *
 * `gateJobRoute` runs first, so a hosted build or an unset `JOB_DATA_ROOT` answers
 * 404. The body is read under a tight byte cap
 * ({@link MAX_SIGNING_FINGERPRINT_BODY_BYTES}), so an oversized body is a 413 (and
 * an unparseable one a 400) before validation.
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
