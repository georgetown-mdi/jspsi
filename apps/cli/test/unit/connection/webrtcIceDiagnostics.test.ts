import { expect, test } from "vitest";

import {
  MAX_REPORTED_CANDIDATE_TYPES,
  UNREPORTED_CANDIDATE_TYPE,
  describeSelectedCandidatePair,
  iceFailureDetails,
  readIceCandidateReport,
  readIceStats,
} from "../../../src/connection/webrtc/iceDiagnostics";

import type { RTCPeerConnection } from "werift";

/** A stats report in the map shape `getStats()` resolves to. */
function report(
  entries: Array<Record<string, unknown>>,
): ReadonlyMap<string, unknown> {
  return new Map(entries.map((entry) => [String(entry.id), entry]));
}

function localCandidate(id: string, candidateType: unknown) {
  return { type: "local-candidate", id, candidateType };
}

function remoteCandidate(id: string, candidateType: unknown) {
  return { type: "remote-candidate", id, candidateType };
}

function pair(options: {
  id: string;
  localCandidateId: string;
  remoteCandidateId: string;
  state?: string;
  nominated?: boolean;
}) {
  return { type: "candidate-pair", ...options };
}

test("the selected pair names the two candidate types it joined", () => {
  const summary = describeSelectedCandidatePair(
    readIceCandidateReport(
      report([
        localCandidate("L1", "host"),
        localCandidate("L2", "relay"),
        remoteCandidate("R1", "srflx"),
        pair({
          id: "P1",
          localCandidateId: "L1",
          remoteCandidateId: "R1",
          state: "in-progress",
        }),
        pair({
          id: "P2",
          localCandidateId: "L2",
          remoteCandidateId: "R1",
          state: "succeeded",
          nominated: true,
        }),
      ]),
    ),
  );
  expect(summary).toBe("local relay, remote srflx");
});

test("a pair that succeeded before nomination is still named", () => {
  const summary = describeSelectedCandidatePair(
    readIceCandidateReport(
      report([
        localCandidate("L1", "host"),
        remoteCandidate("R1", "host"),
        pair({
          id: "P1",
          localCandidateId: "L1",
          remoteCandidateId: "R1",
          state: "succeeded",
        }),
      ]),
    ),
  );
  expect(summary).toBe("local host, remote host");
});

test("a report with no pair names none", () => {
  expect(
    describeSelectedCandidatePair(
      readIceCandidateReport(report([localCandidate("L1", "host")])),
    ),
  ).toBeUndefined();
});

test("a failure with no relay gathered is distinguishable from one with", () => {
  const withoutRelay = iceFailureDetails(
    readIceCandidateReport(
      report([localCandidate("L1", "host"), localCandidate("L2", "srflx")]),
    ),
  );
  expect(withoutRelay[0]).toBe(
    "local candidates gathered: 2 (host, srflx); no relay candidate gathered",
  );
  expect(withoutRelay[1]).toBe("remote candidates received: none");
  expect(withoutRelay[2]).toBe("candidate pairs: none formed");

  const withRelay = iceFailureDetails(
    readIceCandidateReport(
      report([
        localCandidate("L1", "host"),
        localCandidate("L2", "relay"),
        remoteCandidate("R1", "relay"),
        pair({
          id: "P1",
          localCandidateId: "L1",
          remoteCandidateId: "R1",
          state: "failed",
        }),
        pair({
          id: "P2",
          localCandidateId: "L2",
          remoteCandidateId: "R1",
          state: "failed",
        }),
      ]),
    ),
  );
  expect(withRelay[0]).toBe(
    "local candidates gathered: 2 (host, relay); relay candidate gathered",
  );
  expect(withRelay[1]).toBe("remote candidates received: 1 (relay)");
  expect(withRelay[2]).toBe("candidate pairs: 2 tried, none succeeded");
});

test("a succeeded pair is counted where one exists", () => {
  const details = iceFailureDetails(
    readIceCandidateReport(
      report([
        localCandidate("L1", "host"),
        remoteCandidate("R1", "host"),
        pair({
          id: "P1",
          localCandidateId: "L1",
          remoteCandidateId: "R1",
          state: "succeeded",
        }),
      ]),
    ),
  );
  expect(details[2]).toBe("candidate pairs: 1 tried, 1 succeeded");
});

test("a candidate with no readable type is still counted", () => {
  const summary = readIceCandidateReport(
    report([localCandidate("L1", 7), remoteCandidate("R1", undefined)]),
  );
  expect(summary.local.types).toEqual([UNREPORTED_CANDIDATE_TYPE]);
  expect(summary.remote.types).toEqual([UNREPORTED_CANDIDATE_TYPE]);
});

test("a peer flooding distinct candidate types is listed to a bound", () => {
  const flood = Array.from({ length: 40 }, (_, index) =>
    remoteCandidate(`R${index}`, `type${index}`),
  );
  const summary = readIceCandidateReport(report(flood));
  expect(summary.remote.count).toBe(40);
  expect(summary.remote.types).toHaveLength(MAX_REPORTED_CANDIDATE_TYPES);
  expect(summary.remote.unlistedTypes).toBe(40 - MAX_REPORTED_CANDIDATE_TYPES);
  expect(iceFailureDetails(summary)[1]).toContain(
    `and ${40 - MAX_REPORTED_CANDIDATE_TYPES} more`,
  );
});

test("a hostile remote candidate type cannot spend another link's budget", () => {
  const summary = readIceCandidateReport(
    report([remoteCandidate("R1", "[31m".repeat(4000))]),
  );
  const [local, remote, pairs] = iceFailureDetails(summary);
  expect(remote.length).toBeLessThan(300);
  expect(local).toBe(
    "local candidates gathered: none; no relay candidate gathered",
  );
  expect(pairs).toBe("candidate pairs: none formed");
});

test("stats that cannot be read are reported as none rather than thrown", async () => {
  const noStats = {} as unknown as RTCPeerConnection;
  await expect(readIceStats(noStats)).resolves.toBeUndefined();

  const throwing = {
    getStats: () => {
      throw new Error("torn down");
    },
  } as unknown as RTCPeerConnection;
  await expect(readIceStats(throwing)).resolves.toBeUndefined();

  const wrongShape = {
    getStats: () => Promise.resolve({}),
  } as unknown as RTCPeerConnection;
  await expect(readIceStats(wrongShape)).resolves.toBeUndefined();
});
