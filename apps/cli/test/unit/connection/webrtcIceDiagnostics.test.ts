import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, test } from "vitest";

import {
  ICE_STATS_TIMEOUT_MS,
  MAX_REPORTED_CANDIDATE_TYPES,
  UNREPORTED_CANDIDATE_TYPE,
  describeIceTransportPolicy,
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
    "local candidates gathered: no relay candidate gathered; 2 (host, srflx)",
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
    "local candidates gathered: relay candidate gathered; 2 (host, relay)",
  );
  expect(withRelay[1]).toBe("remote candidates received: 1 (relay)");
  expect(withRelay[2]).toBe("candidate pairs: 2 tried, none succeeded");
});

test("each policy a connection can take has a line of its own", () => {
  expect(describeIceTransportPolicy("relay")).toBe(
    "ice_transport_policy: relay (relay candidates only)",
  );
  expect(describeIceTransportPolicy("all")).toBe(
    "ice_transport_policy: all (host, server-reflexive and relay candidates)",
  );
  // An unset policy is the transport's default rather than a value the
  // operator wrote, and the line says which of the two it is reporting.
  expect(describeIceTransportPolicy(undefined)).toBe(
    "ice_transport_policy: all by default (host, server-reflexive and relay candidates)",
  );
});

test("a relay-only run that gathered no relay names the policy", () => {
  // Under `relay` the run had no direct path to fall back on, so an empty
  // tally has one reading and the clause states it.
  const [local] = iceFailureDetails(
    readIceCandidateReport(report([])),
    "relay",
  );
  expect(local).toBe(
    "local candidates gathered: no relay candidate gathered under " +
      "ice_transport_policy relay; none",
  );
});

test("the policy clause is confined to the failure it explains", () => {
  const gathered = report([
    localCandidate("L1", "relay"),
    remoteCandidate("R1", "relay"),
  ]);
  // A relay-only run that DID gather one failed for the reason every other
  // run's failure names, so it reports what they report.
  expect(iceFailureDetails(readIceCandidateReport(gathered), "relay")[0]).toBe(
    "local candidates gathered: relay candidate gathered; 1 (relay)",
  );
  // And a run on the default policy names no policy at all.
  expect(
    iceFailureDetails(
      readIceCandidateReport(report([localCandidate("L1", "host")])),
      "all",
    )[0],
  ).toBe("local candidates gathered: no relay candidate gathered; 1 (host)");
});

test("a long local candidate type cannot clip the policy clause away", () => {
  const [local] = iceFailureDetails(
    readIceCandidateReport(report([localCandidate("L1", "x".repeat(4000))])),
    "relay",
  );
  expect(local).toContain("under ice_transport_policy relay");
  expect(local.length).toBeLessThan(300);
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
    "local candidates gathered: no relay candidate gathered; none",
  );
  expect(pairs).toBe("candidate pairs: none formed");
});

test("a long local candidate type cannot clip the relay clause away", () => {
  // The clause leads the link, so what the fitting takes from an anomalous
  // tally is the tally: the two failures the clause separates have different
  // remedies, and losing it is losing the diagnosis.
  const [local] = iceFailureDetails(
    readIceCandidateReport(report([localCandidate("L1", "x".repeat(4000))])),
  );
  expect(local).toContain(
    "local candidates gathered: no relay candidate gathered;",
  );
  expect(local.length).toBeLessThan(300);
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

/** A peer whose stats collection never answers. */
function neverSettlingPeer(): RTCPeerConnection {
  return {
    getStats: () => new Promise<never>(() => {}),
  } as unknown as RTCPeerConnection;
}

test("an interrupt is not made to wait for a stats collection", async () => {
  // The report describes an outcome an interrupt has already decided, so the
  // run stops waiting for it at once rather than at the ceiling.
  const controller = new AbortController();
  const startedAt = Date.now();
  const answered = readIceStats(neverSettlingPeer(), controller.signal);
  controller.abort();
  await expect(answered).resolves.toBeUndefined();
  expect(Date.now() - startedAt).toBeLessThan(ICE_STATS_TIMEOUT_MS);

  await expect(
    readIceStats(neverSettlingPeer(), AbortSignal.abort()),
  ).resolves.toBeUndefined();
});

// Starting the child and transpiling what it imports is not what this case
// asserts, and it is the part that grows with CPU contention: about 0.5s in a
// run on an idle machine, and 6.4 to 7.6s on one saturated by other work, past
// vitest's 5s default. The budget is about four times that loaded measurement,
// so the case reports what the child measured rather than how loaded the
// machine was.
const EXIT_PROBE_TIMEOUT_MS = 30_000;

test(
  "a stats collection that never answers does not hold the process",
  async () => {
    // Measured in a child process, since it is the process exiting that is under
    // test: the ceiling's timer must not be what a finished run waits on. What
    // the child reports is wall-clock, and it stayed in the tens of
    // milliseconds against the 2000ms ceiling at every load level above.
    const probe = fileURLToPath(
      new URL("../../iceStatsExitProbe.ts", import.meta.url),
    );
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--import=tsx", probe],
      { cwd: fileURLToPath(new URL("../../..", import.meta.url)) },
    );
    expect(Number(stdout)).toBeLessThan(ICE_STATS_TIMEOUT_MS);
  },
  EXIT_PROBE_TIMEOUT_MS,
);
