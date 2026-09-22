import { createFileRoute } from "@tanstack/react-router";

import {
  ConfigurationLoadRefusedError,
  loadMountedConfiguration,
} from "@jobs/configLoad";
import { jobJsonResponse, readJobApiConfig } from "@jobs/gate";
import { gateJobRoute } from "@jobs/routeSupport";

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
 * A file the console cannot open is a `400 { error }` naming the settings to fix
 * as the FILE spells them. The static `config` segment cannot be captured as a
 * job id: ids are validated as canonical v4 UUIDs before any use, which `config`
 * is not.
 */
export const Route = createFileRoute("/api/jobs/config")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;
        try {
          return jobJsonResponse(
            loadMountedConfiguration(readJobApiConfig().dataRoot),
          );
        } catch (error) {
          if (error instanceof ConfigurationLoadRefusedError)
            return jobJsonResponse({ error: error.message }, 400);
          throw error;
        }
      },
    },
  },
});
