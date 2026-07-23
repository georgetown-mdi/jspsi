import { createFileRoute } from "@tanstack/react-router";

import { gateJobRoute } from "@jobs/routeSupport";
import { jobJsonResponse } from "@jobs/gate";

/**
 * `GET /api/jobs/slot` -- report whether the console's single exchange slot is
 * occupied, and by which job. Shares `gateJobRoute` (404 when the API is disabled,
 * the loopback Host-allowlist, the browser-CSRF check, no-store, no CORS), so it
 * adds no new perimeter.
 *
 * The body is `{ occupied: false }` when the slot is free, else
 * `{ occupied: true, id }` where `id` is the occupying job. The lobby's recovery
 * panel reads this when the browser holds no stored attachment, so a browser that
 * never started the exchange can still see it and re-attach or discard it. It
 * discloses exactly what a busy `POST /api/jobs` 409 already does -- occupied plus
 * the occupant's id, a non-secret v4 UUID reachable only over the loopback-local
 * origin -- and nothing more: no job list (`GET /api/jobs` stays absent) and no
 * run detail. Clearing the slot rides the existing per-id `DELETE /api/jobs/:jobId`
 * through the panel's Discard; this route adds no destructive endpoint.
 *
 * The static `slot` segment can never be captured as a `$jobId` parameter: job ids
 * are validated as canonical v4 UUIDs before any use, which `slot` is not -- the
 * same argument the sibling `sftp` segment rests on.
 */
export const Route = createFileRoute("/api/jobs/slot")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;
        const id = gate.manager.occupiedSlotId();
        return jobJsonResponse(
          id === null ? { occupied: false } : { occupied: true, id },
        );
      },
    },
  },
});
