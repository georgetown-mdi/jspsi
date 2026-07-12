import { createFileRoute } from "@tanstack/react-router";

import { gateJobRoute, validateJobIdParam } from "@jobs/routeSupport";
import { jobEmptyResponse, jobJsonResponse } from "@jobs/gate";
import { jobFileExists, readRecordCreatedAt } from "@jobs/workdir";

import type { JobRecord } from "@jobs/jobManager";

/**
 * The record pair's availability, offered all-or-nothing (matching the
 * in-browser `outputs.record` shape): available only when the job succeeded,
 * both the record and keys files exist, and the record's `createdAt` parses to a
 * non-empty string. The stamp for the download filename is derived from that
 * `createdAt`, so a record whose timestamp cannot be read is treated as
 * unavailable rather than served with a wrong name.
 */
function recordAvailability(
  record: JobRecord,
):
  | { recordAvailable: false }
  | { recordAvailable: true; recordCreatedAt: string } {
  if (record.status !== "succeeded") return { recordAvailable: false };
  if (!jobFileExists(record.recordPath) || !jobFileExists(record.keysPath))
    return { recordAvailable: false };
  const recordCreatedAt = readRecordCreatedAt(record.recordPath);
  if (recordCreatedAt === null) return { recordAvailable: false };
  return { recordAvailable: true, recordCreatedAt };
}

/**
 * `GET /api/jobs/:jobId` -- the job's status and terminal state.
 * `DELETE /api/jobs/:jobId` -- remove the in-memory record and the workdir.
 *
 * Both auth-gated and id-validated. An unknown or evicted job (or a malformed id)
 * is 404. GET reports status, the reconciled terminal outcome, whether a result
 * file is available, and whether the exchange-record pair is available (with its
 * `createdAt` when it is). DELETE kills a still-running child, drops the record,
 * and removes the disk.
 */
export const Route = createFileRoute("/api/jobs/$jobId/")({
  server: {
    handlers: {
      GET: ({ request, params }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;
        const jobId = validateJobIdParam(params.jobId);
        if (jobId === null) return jobEmptyResponse(404);

        const record = gate.manager.getJob(jobId);
        if (record === undefined) return jobEmptyResponse(404);

        return jobJsonResponse({
          id: record.id,
          status: record.status,
          terminal: record.terminal,
          terminalEmitted: record.terminalEmitted,
          eventCount: record.events.length,
          resultAvailable: record.status === "succeeded",
          ...recordAvailability(record),
        });
      },
      DELETE: async ({ request, params }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;
        const jobId = validateJobIdParam(params.jobId);
        if (jobId === null) return jobEmptyResponse(404);

        const removed = await gate.manager.deleteJob(jobId);
        return jobEmptyResponse(removed ? 204 : 404);
      },
    },
  },
});
