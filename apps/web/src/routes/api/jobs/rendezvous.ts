import { createFileRoute } from "@tanstack/react-router";

import { gateJobRoute } from "@jobs/routeSupport";
import { jobJsonResponse } from "@jobs/gate";
import { useJobRendezvousProvisioning } from "@jobs/jobRendezvous";

/**
 * `GET /api/jobs/rendezvous` -- report whether a filedrop exchange can run here, how
 * the invitation it mints may name each shared folder, and whether this appliance
 * rendezvouses over one folder or a split inbound/outbound pair. Shares
 * `gateJobRoute` (404 when the API is disabled, no-store, no CORS).
 *
 * The body is `{ configured, split?, locator?, folderName?, outboundLocator?,
 * outboundFolderName?, problem? }`. `configured` reports the mount alone, as it
 * always has: the rendezvous mount defaults to `JOB_DATA_ROOT` when
 * `JOB_RENDEZVOUS_DIR` is unset, so once the job API is enabled the filedrop
 * transport is available.
 *
 * `locator` is the advisory locator the invitation carries and `folderName` the
 * shared folder's own name, present only where the console can name it (see
 * `resolveJobRendezvousFolderName`); `outboundLocator` and `outboundFolderName` are
 * their counterparts for the outbound leg of a split appliance, which reports
 * `split: true`.
 *
 * `problem` is why a filedrop exchange cannot run as provisioned. It rides a
 * `configured: false` body, because the appliance genuinely cannot run one: it is
 * what turns "no shared directory is mounted" into the variable the operator must
 * set. The resolved mount paths themselves are deliberately NOT in the body:
 * nothing in the browser needs them, and leaving them out keeps the appliance's
 * absolute paths on the server side of the API rather than relying on every
 * consumer to reduce them before minting.
 */
export const Route = createFileRoute("/api/jobs/rendezvous")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;
        const rendezvous = useJobRendezvousProvisioning();
        if (rendezvous.problem !== undefined)
          return jobJsonResponse({
            configured: false,
            problem: rendezvous.problem,
          });
        if (rendezvous.dir === undefined)
          return jobJsonResponse({ configured: false });
        const { folderName, locator, outboundFolderName, outboundLocator } =
          rendezvous;
        return jobJsonResponse({
          configured: true,
          ...(rendezvous.outboundDir === undefined ? {} : { split: true }),
          ...(locator === undefined ? {} : { locator }),
          ...(folderName === undefined ? {} : { folderName }),
          ...(outboundLocator === undefined ? {} : { outboundLocator }),
          ...(outboundFolderName === undefined ? {} : { outboundFolderName }),
        });
      },
    },
  },
});
