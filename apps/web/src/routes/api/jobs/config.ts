import { createFileRoute } from "@tanstack/react-router";

import {
  ConfigurationHandBackRefusedError,
  handBackMountedConfiguration,
} from "@jobs/configHandBack";
import {
  MAX_CONFIG_HAND_BACK_BODY_BYTES,
  gateJobRoute,
  readJobRequestBody,
} from "@jobs/routeSupport";
import {
  jobEmptyResponse,
  jobJsonResponse,
  readJobApiConfig,
} from "@jobs/gate";
import { ConfigurationLoadRefusedError } from "@jobs/configLoad";
import { formatFirstIssue } from "@jobs/schemaIssueMessage";
import { jobConfigurationHandBackSchema } from "@jobs/intentSchemas";

/**
 * `GET /api/jobs/config` -- the command-line configuration the operator mounted
 * at `<JOB_DATA_ROOT>/psilink.yaml`, as the settings the console's authoring
 * forms edit. Shares `gateJobRoute` (404 when the API is disabled, no-store, no
 * CORS), and the `{ configured, ... }` shape family of `GET /api/jobs/inputs`
 * and `GET /api/jobs/rendezvous`.
 *
 * The body is `{ configured, present, document?, carriedThrough, warnings }`.
 * An absent file is `present: false` with no error -- a console whose operator
 * has authored nothing yet is the ordinary first run, not a fault.
 *
 * `document` is an explicit projection, never the parsed file: no credential,
 * no passphrase, no `@path` reference value, no shared secret, and no container
 * path. `carriedThrough` names the settings the console holds without an editor
 * and `warnings` the credential fields it cannot pre-fill -- names only in both,
 * since a setting's value is what can be the credential.
 *
 * The configuration as this read found it is what a run of the opened
 * configuration composes its recurring-run hand-off from, so a file changed
 * between this read and the run is reported on the run rather than exported.
 *
 * A file the console cannot open is a `400 { error }` naming the settings to fix
 * as the FILE spells them. The static `config` segment cannot be captured as a
 * job id: ids are validated as canonical v4 UUIDs before any use, which `config`
 * is not.
 *
 * `PUT /api/jobs/config` hands the operator's edits back into that file, for a
 * configuration on a channel the console does not conduct: the body is a
 * {@link jobConfigurationHandBackSchema} hand-back, the file's `connection` and
 * every setting no step edits are kept from the file itself, and the answer is
 * `{ written: true }` -- nothing of the document crosses back. A hand-back the
 * file or the settings refuse is a `400 { error }`.
 */
export const Route = createFileRoute("/api/jobs/config")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;
        try {
          return jobJsonResponse(gate.manager.openMountedConfiguration());
        } catch (error) {
          if (error instanceof ConfigurationLoadRefusedError)
            return jobJsonResponse({ error: error.message }, 400);
          throw error;
        }
      },
      PUT: async ({ request }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;

        const body = await readJobRequestBody(
          request,
          MAX_CONFIG_HAND_BACK_BODY_BYTES,
        );
        if (body.kind === "too-large") return jobEmptyResponse(413);
        if (body.kind === "invalid") return jobEmptyResponse(400);

        const parsed = jobConfigurationHandBackSchema.safeParse(body.value);
        if (!parsed.success)
          return jobJsonResponse(
            { error: formatFirstIssue(parsed.error.issues) },
            400,
          );
        try {
          handBackMountedConfiguration(
            readJobApiConfig().dataRoot,
            parsed.data,
          );
        } catch (error) {
          if (
            error instanceof ConfigurationLoadRefusedError ||
            error instanceof ConfigurationHandBackRefusedError
          )
            return jobJsonResponse({ error: error.message }, 400);
          throw error;
        }
        return jobJsonResponse({ written: true });
      },
    },
  },
});
