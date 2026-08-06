import { createFileRoute } from "@tanstack/react-router";

import { gateJobRoute } from "@jobs/routeSupport";
import { jobJsonResponse } from "@jobs/gate";
import {
  resolveJobRendezvousLocator,
  useJobRendezvousDir,
  useJobRendezvousFolderName,
} from "@jobs/jobRendezvous";

/**
 * `GET /api/jobs/rendezvous` -- report whether a filedrop exchange can run here and
 * how the invitation it mints may name the shared folder. Shares `gateJobRoute`
 * (404 when the API is disabled, no-store, no CORS).
 *
 * The body is `{ configured, locator?, folderName? }`. `configured` reports the
 * mount alone, as it always has: the rendezvous mount defaults to `JOB_DATA_ROOT`
 * when `JOB_RENDEZVOUS_DIR` is unset, so once the job API is enabled the filedrop
 * transport is available.
 *
 * `locator` is the advisory locator the invitation carries and `folderName` the
 * shared folder's own name, present only where the console can name it (see
 * `resolveJobRendezvousFolderName`). The resolved mount path itself is deliberately
 * NOT in the body: nothing in the browser needs it, and leaving it out keeps the
 * appliance's absolute path on the server side of the API rather than relying on
 * every consumer to reduce it before minting.
 */
export const Route = createFileRoute("/api/jobs/rendezvous")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;
        const rendezvousDir = useJobRendezvousDir();
        if (rendezvousDir === undefined)
          return jobJsonResponse({ configured: false });
        const folderName = useJobRendezvousFolderName();
        const locator = resolveJobRendezvousLocator(rendezvousDir, folderName);
        return jobJsonResponse({
          configured: true,
          ...(locator === undefined ? {} : { locator }),
          ...(folderName === undefined ? {} : { folderName }),
        });
      },
    },
  },
});
