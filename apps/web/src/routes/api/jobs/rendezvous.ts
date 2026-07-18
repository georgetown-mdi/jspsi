import { createFileRoute } from "@tanstack/react-router";

import { gateJobRoute } from "@jobs/routeSupport";
import { jobJsonResponse } from "@jobs/gate";
import { useJobRendezvousDir } from "@jobs/jobRendezvous";

/**
 * `GET /api/jobs/rendezvous` -- report the operator-mounted rendezvous directory a
 * filedrop exchange runs against. Shares `gateJobRoute` (404 when the API is
 * disabled, 401 on a bad bearer, no-store, no CORS).
 *
 * The body is `{ configured, path? }`. When `JOB_RENDEZVOUS_DIR` is unset the
 * console disables the filedrop transport. When set, the console mints the
 * directory as the invitation's advisory locator so a partner can confirm the
 * shared folder; the console is operator-local, so surfacing the operator's own
 * mount path here discloses nothing they do not already control.
 */
export const Route = createFileRoute("/api/jobs/rendezvous")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;
        const path = useJobRendezvousDir();
        return jobJsonResponse(
          path === undefined
            ? { configured: false }
            : { configured: true, path },
        );
      },
    },
  },
});
