import { createFileRoute } from "@tanstack/react-router";

import { z } from "zod";

import {
  IDENTITY_CONTROL_CHAR_MESSAGE,
  IDENTITY_CONTROL_CHAR_PATTERN,
  IDENTITY_DIRECTION_CHAR_MESSAGE,
  IDENTITY_DIRECTION_CHAR_PATTERN,
  MAX_IDENTITY_LENGTH,
  jobSigningIdentityLocationSchema,
} from "@jobs/intentSchemas";

import {
  MAX_SIGNING_FINGERPRINT_BODY_BYTES,
  gateJobRoute,
  readJobRequestBody,
} from "@jobs/routeSupport";
import {
  SIGNING_CERTIFICATE_FILE_NAME,
  SIGNING_IDENTITY_FILE_NAME,
  SigningIdentityLocationError,
} from "@jobs/signingIdentity";
import { jobEmptyResponse, jobJsonResponse } from "@jobs/gate";
import { SigningFingerprintBusyError } from "@jobs/jobManager";
import { formatFirstIssue } from "@jobs/schemaIssueMessage";

import type { SigningFingerprintResult } from "@jobs/signingIdentity";

/**
 * The strict fingerprint body: an identity label to bind to a NEW identity,
 * whether to also write the public certificate out, and which mount location
 * holds the identity. `.strictObject` rejects any unmodeled key, and
 * `identityLocation` is a mount id plus path segments the SERVER resolves
 * against `JOB_SECRETS_DIR`, so the request still cannot name a path to read
 * or write. The label is held to the shared label contract
 * (`@jobs/intentSchemas`): bounded by {@link MAX_IDENTITY_LENGTH}, refused a
 * leading `-`, and refused any control or text-direction character -- the last
 * two are critical rather than defensive, since the label binds into a
 * long-lived certificate every partner pins and displays, and a NUL would
 * otherwise be caught only incidentally, where the child is spawned.
 */
const fingerprintBodySchema = z.strictObject({
  identity: z
    .string()
    .min(1)
    .max(MAX_IDENTITY_LENGTH)
    .regex(/^[^-]/, "identity must not begin with '-'")
    .refine((label) => !IDENTITY_CONTROL_CHAR_PATTERN.test(label), {
      message: IDENTITY_CONTROL_CHAR_MESSAGE,
    })
    .refine((label) => !IDENTITY_DIRECTION_CHAR_PATTERN.test(label), {
      message: IDENTITY_DIRECTION_CHAR_MESSAGE,
    }),
  exportCertificate: z.boolean().optional(),
  identityLocation: jobSigningIdentityLocationSchema.optional(),
});

/**
 * The typed 200 envelope for a fingerprint attempt that RAN: a completed attempt
 * is always a 200 with a discriminated body. Success includes the re-validated
 * fingerprint, whether this call created the identity, and the two mount FILE
 * NAMES the console's copy points the operator at -- names, never paths, so no
 * container location crosses the boundary. Anything else is a category
 * (`refused` / `absent` / `timeout` / `error`), so the client reads the outcome
 * from the body rather than from the status.
 *
 * The identity's file name is the console's own constant at the default
 * location, and the last segment the request picked at a configured one -- a
 * value the browse already admitted as a single segment, echoed rather than
 * composed, so no container location crosses either way.
 */
function fingerprintEnvelope(
  result: SigningFingerprintResult,
  identityFileName: string,
): Record<string, unknown> {
  if (result.kind !== "ok") return { status: result.kind };
  return {
    status: "ok",
    fingerprint: result.fingerprint,
    created: result.created,
    identityFileName,
    ...(result.certificateExported
      ? { certificateFileName: SIGNING_CERTIFICATE_FILE_NAME }
      : {}),
  };
}

/**
 * The file name the envelope reports: the console's own constant at the default
 * location, and the picked locator's LAST SEGMENT at a configured one. The body
 * schema holds `subPath` to at least one segment, so an empty locator never
 * reaches here.
 */
function pickedFileName(
  location: { subPath: Array<string> } | undefined,
): string {
  if (location === undefined) return SIGNING_IDENTITY_FILE_NAME;
  return location.subPath[location.subPath.length - 1];
}

/**
 * `POST /api/jobs/signing/fingerprint` -- create-or-reuse this party's signing
 * identity at the location the operator configured and return its fingerprint,
 * so they can share it out-of-band before a signed exchange. Create-or-reuse at
 * the console's default location in the mounted working directory; READ ONLY at
 * a location of the operator's own, where nothing there is answered `absent`.
 *
 * It is the console's whole signing-identity surface, narrow by design: it can
 * create-or-reuse and export the PUBLIC certificate, but cannot regenerate --
 * re-keying invalidates every partner-pinned fingerprint, so that coordinated
 * action stays on the command line (`psilink fingerprint --force`).
 *
 * The request contains an identity label, a boolean, and a mount locator ONLY;
 * the response contains a fingerprint, a created flag, and file names ONLY --
 * never a container path (every path stays with the manager,
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

        const { identityLocation } = parsed.data;
        let result: SigningFingerprintResult;
        try {
          result = await gate.manager.resolveSigningFingerprint({
            identityLabel: parsed.data.identity,
            exportCertificate: parsed.data.exportCertificate === true,
            ...(identityLocation !== undefined ? { identityLocation } : {}),
          });
        } catch (error) {
          // A request already in flight is a 409 (the busy convention). A
          // location that names nothing in the secrets mount is a 400 whose
          // message holds a field path and a reason, the shape every authoring
          // rejection takes. Anything else is an unexpected internal fault --
          // no detail crosses the boundary.
          if (error instanceof SigningFingerprintBusyError)
            return jobEmptyResponse(409);
          if (error instanceof SigningIdentityLocationError)
            return jobJsonResponse({ error: error.message }, 400);
          return jobEmptyResponse(500);
        }
        return jobJsonResponse(
          fingerprintEnvelope(result, pickedFileName(identityLocation)),
        );
      },
    },
  },
});
