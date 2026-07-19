import { describe, expect, test } from "vitest";

import { DEFAULT_PEER_TIMEOUT_MS } from "@psilink/core";

import {
  SERVER_JOB_PEER_WINDOW_BODY,
  peerWindowDurationPhrase,
} from "@bench/BenchRunSurface";

describe("SERVER_JOB_PEER_WINDOW_BODY", () => {
  test("is composed from DEFAULT_PEER_TIMEOUT_MS, never a hardcoded duration", () => {
    // The body embeds the phrase computed from the core constant, so the console
    // copy tracks the CLI's peer-timeout default rather than restating it.
    expect(SERVER_JOB_PEER_WINDOW_BODY).toContain(
      peerWindowDurationPhrase(DEFAULT_PEER_TIMEOUT_MS),
    );
    expect(SERVER_JOB_PEER_WINDOW_BODY).toBe(
      "Your partner's console must run its half while yours is running. This " +
        `appliance waits about ${peerWindowDurationPhrase(DEFAULT_PEER_TIMEOUT_MS)} ` +
        "for the partner before the exchange stops; if it stops, coordinate a " +
        "time and run it again.",
    );
  });

  test("formats durations, with the one-hour default reading as 'an hour'", () => {
    expect(peerWindowDurationPhrase(3_600_000)).toBe("an hour");
    expect(peerWindowDurationPhrase(2 * 3_600_000)).toBe("2 hours");
    expect(peerWindowDurationPhrase(60_000)).toBe("a minute");
    expect(peerWindowDurationPhrase(30 * 60_000)).toBe("30 minutes");
  });
});
