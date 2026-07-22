import { createFileRoute } from "@tanstack/react-router";

import { z } from "zod";

import { isBareSftpHost } from "@psi/sftpHost";

import {
  MAX_SFTP_PROBE_BODY_BYTES,
  gateJobRoute,
  readJobRequestBody,
} from "@jobs/routeSupport";
import { jobEmptyResponse, jobJsonResponse } from "@jobs/gate";
import { SftpProbeBusyError } from "@jobs/jobManager";

import type { SftpProbeResult } from "@jobs/sftpProbe";

/**
 * The strict probe body: a host and an optional port, and NOTHING else. No
 * username, path, or credential field is representable (`.strictObject` rejects
 * any unmodeled key), so the probe can only ever name WHERE to read a host key --
 * it cannot be steered to authenticate, browse, or reach a different resource. The
 * bare-host predicate is applied after the parse so a scheme/userinfo/path-bearing
 * value is refused before it composes a URL.
 */
const probeBodySchema = z.strictObject({
  host: z.string().min(1),
  port: z.int().min(0).max(65535).optional(),
});

/** Format the first zod issue as `<field>: <reason>` -- a field path and a
 * shape reason only, never a submitted value (the `JobApiConfigError` discipline).
 * The probe body carries no secret, but the discipline keeps the surface uniform. */
function formatFirstIssue(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): string {
  // A failed zod parse always carries at least one issue.
  const issue = issues[0];
  const field =
    issue.path.length > 0 ? issue.path.map(String).join(".") : "body";
  return `${field}: ${issue.message}`;
}

/**
 * The typed 200 envelope for a probe attempt that RAN. A completed attempt is
 * always a 200 with a discriminated body -- success carries the re-validated
 * fingerprint and key type; a probe that ran but yielded no key is a category
 * (`unreachable` / `timeout` / `error`). Non-2xx is reserved for HTTP-level
 * conditions (a bad body, a probe already in flight, the gate off, or an
 * unexpected internal fault), so the client reads a probe outcome from the body,
 * never from the status. No banner, no latency, no stderr crosses the boundary.
 */
function probeEnvelope(result: SftpProbeResult): Record<string, unknown> {
  if (result.kind === "ok")
    return {
      status: "ok",
      fingerprint: result.fingerprint,
      keyType: result.keyType,
    };
  return { status: result.kind };
}

/**
 * `POST /api/jobs/sftp/probe` -- read the host-key fingerprint an SFTP server
 * presents, so the console can offer it beside the paste field for a COMPARISON
 * against the value the server operator published. It authors nothing: the probe
 * is stateless (it never touches the authored connection, records nothing) and
 * single-flight (a concurrent probe is a 409).
 *
 * The request carries host + port ONLY; the response carries a fingerprint and a
 * key type ONLY (fingerprint regex-validated, key type charset/length-capped), or
 * a probe-outcome category. No username, path, or credential is representable in;
 * no banner, stderr, latency, or saved-hosts list crosses out. These SSRF bounds
 * are the module contract, pinned by tests.
 *
 * `gateJobRoute` runs first, so a hosted build or an unset `JOB_DATA_ROOT` answers
 * 404. The body is read under a tight byte cap ({@link MAX_SFTP_PROBE_BODY_BYTES})
 * streamed off the request, so an oversized body is a 413 (and an unparseable one
 * a 400) before validation.
 */
export const Route = createFileRoute("/api/jobs/sftp/probe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;

        const body = await readJobRequestBody(
          request,
          MAX_SFTP_PROBE_BODY_BYTES,
        );
        if (body.kind === "too-large") return jobEmptyResponse(413);
        if (body.kind === "invalid") return jobEmptyResponse(400);

        const parsed = probeBodySchema.safeParse(body.value);
        if (!parsed.success)
          return jobJsonResponse(
            { error: formatFirstIssue(parsed.error.issues) },
            400,
          );
        if (!isBareSftpHost(parsed.data.host))
          return jobJsonResponse(
            {
              error:
                "host: must be a bare server address, without a scheme, a " +
                "path, an @, or whitespace",
            },
            400,
          );

        let result: SftpProbeResult;
        try {
          result = await gate.manager.probeSftpHostKey({
            host: parsed.data.host,
            ...(parsed.data.port !== undefined
              ? { port: parsed.data.port }
              : {}),
          });
        } catch (error) {
          // A probe already in flight is a 409 (the busy convention). Anything
          // else is an unexpected internal fault -- no detail crosses the boundary.
          if (error instanceof SftpProbeBusyError) return jobEmptyResponse(409);
          return jobEmptyResponse(500);
        }
        return jobJsonResponse(probeEnvelope(result));
      },
    },
  },
});
