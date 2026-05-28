import { describe, expect, test, vi } from "vitest";

import PSI from "@openmined/psi.js";

import { PSIParticipant } from "../src/participant";
import { StubConnection } from "./utils/stubConnection";

import type { Connection } from "../src/types";

const psiLibrary = await PSI();

function startStarterExchange(conn: StubConnection): Promise<unknown> {
  const participant = new PSIParticipant("starter", psiLibrary, {
    role: "starter",
    verbose: 0,
  });
  return participant.identifyIntersection(conn as Connection, ["a", "b"]);
}

describe("identifyIntersection failure handling", () => {
  test("rejects when the connection emits an error mid-exchange", async () => {
    const conn = new StubConnection();
    const p = startStarterExchange(conn);

    conn.emit("error", new Error("transport boom"));

    await expect(p).rejects.toThrow("transport boom");
  });

  test("rejects (does not hang) when a send throws synchronously", async () => {
    const conn = new StubConnection();
    conn.sendImpl = () => {
      throw new Error("connection closed");
    };

    const p = startStarterExchange(conn);

    await expect(p).rejects.toThrow("connection closed");
  });

  test("rejects with a transport error buffered before the phase began", async () => {
    const conn = new StubConnection();
    conn.emit("error", new Error("earlier failure")); // no listener yet

    const p = startStarterExchange(conn);

    await expect(p).rejects.toThrow("earlier failure");
  });

  test("rejects after the inactivity timeout when the peer never responds", async () => {
    vi.useFakeTimers();
    try {
      const conn = new StubConnection();
      const p = startStarterExchange(conn);
      p.catch(() => {});

      await vi.advanceTimersByTimeAsync(120_000);

      await expect(p).rejects.toThrow("PSI exchange timed out");
    } finally {
      vi.useRealTimers();
    }
  });
});
