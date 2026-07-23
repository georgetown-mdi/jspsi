import { createFileRoute } from "@tanstack/react-router";

import { gateJobRoute } from "@jobs/routeSupport";
import { jobJsonResponse } from "@jobs/gate";
import { useJobRendezvousDir } from "@jobs/jobRendezvous";

/**
 * `GET /api/jobs/rendezvous` -- report the operator-mounted rendezvous directory a
 * filedrop exchange runs against. Shares `gateJobRoute` (404 when the API is
 * disabled, no-store, no CORS).
 *
 * The body is `{ configured, path? }`. The rendezvous mount defaults to
 * `JOB_DATA_ROOT` when `JOB_RENDEZVOUS_DIR` is unset, so once the job API is enabled
 * the filedrop transport is always available; this returns the resolved mount path,
 * which is operator-facing: the invitation's advisory locator carries only the
 * directory's basename (see `rendezvousLocatorName`), so the partner confirms the
 * shared folder without the token disclosing the appliance's absolute path. The
 * console is operator-local, so surfacing the operator's own mount path here
 * discloses nothing they do not already control.
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
