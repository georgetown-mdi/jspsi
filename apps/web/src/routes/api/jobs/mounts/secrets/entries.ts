import { createFileRoute } from "@tanstack/react-router";

import { gateJobRoute } from "@jobs/routeSupport";
import { jobJsonResponse } from "@jobs/gate";
import { listMountEntries } from "@jobs/mountBrowse";
import { useJobSecretsDir } from "@jobs/jobSecrets";

/**
 * `GET /api/jobs/mounts/secrets/entries?subPath=...&subPath=...` -- list the
 * operator-mounted secrets directory the console browses to pick an SFTP
 * connection's file-reference credential. Shares `gateJobRoute` (404 when the API
 * is disabled, no-store, no CORS).
 *
 * `subPath` is a REPEATED query parameter -- one value per path segment, never a
 * single slash-joined string -- so a `/` inside a value can never compose a
 * traversal. Each segment is admitted by the browse contract's single-segment
 * shape rule (which permits a leading dot, so `.ssh` is navigable) and the
 * resolved directory is re-confined to the mount by realpath before any read.
 *
 * The body is `{ configured, readable, entries }`, mirroring the input listing's
 * unconfigured shape family: when `JOB_SECRETS_DIR` is unset the mount is
 * unavailable (no data-root fallback) and the response is
 * `{ configured: false, readable: true, entries: [] }`; an inadmissible,
 * escaping, or unreadable subpath under a configured mount is
 * `{ configured: true, readable: false, entries: [] }`. No file bytes are read;
 * entry kinds come from `stat` only.
 */
export const Route = createFileRoute("/api/jobs/mounts/secrets/entries")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;
        const mountRoot = useJobSecretsDir();
        if (mountRoot === undefined)
          return jobJsonResponse({
            configured: false,
            readable: true,
            entries: [],
          });
        const subPath = new URL(request.url).searchParams.getAll("subPath");
        return jobJsonResponse({
          configured: true,
          ...listMountEntries(mountRoot, subPath),
        });
      },
    },
  },
});
