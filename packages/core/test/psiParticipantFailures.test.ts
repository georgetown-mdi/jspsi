import { describe, expect, test, vi } from "vitest";

import PSI from "@openmined/psi.js";

import { PSIParticipant } from "../src/participant";
import { PassthroughConnection } from "./utils/passthroughConnection";
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

  test("joiner resolves even when the status-completed send fails", async () => {
    // The joiner's three sends are: (1) clientRequest, (2) associationTable,
    // (3) { status: "completed" }. The third is best-effort: participant.ts
    // wraps it in try/catch so a failure does not reject identifyIntersection.
    class FailOnNthSend extends PassthroughConnection {
      private count = 0;
      constructor(private readonly n: number, other?: PassthroughConnection) {
        super(other);
      }
      send(data: unknown): void | Promise<void> {
        this.count++;
        if (this.count === this.n)
          return Promise.reject(new Error("status-completed send failed"));
        return super.send(data);
      }
    }

    const starterConn = new PassthroughConnection();
    const joinerConn = new FailOnNthSend(3, starterConn);
    starterConn.setOther(joinerConn);

    const starter = new PSIParticipant("starter", psiLibrary, {
      role: "starter",
      verbose: 0,
    });
    const joiner = new PSIParticipant("joiner", psiLibrary, {
      role: "joiner",
      verbose: 0,
    });

    const starterPromise = starter.identifyIntersection(
      starterConn as Connection,
      ["a", "b"],
    );
    const joinerResult = await joiner.identifyIntersection(
      joinerConn as Connection,
      ["a", "b"],
    );

    expect(Array.isArray(joinerResult[0])).toBe(true);
    expect(Array.isArray(joinerResult[1])).toBe(true);

    // The starter is now blocked waiting for "status completed" which was never
    // delivered. Emit an error to unblock it so no promise outlives the test.
    starterConn.emit("error", new Error("test cleanup"));
    await expect(starterPromise).rejects.toThrow();
  });
});
