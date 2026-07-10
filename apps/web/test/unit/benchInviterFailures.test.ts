import { describe, expect, test } from "vitest";

import { failureFor } from "@bench/useInviterExchange";

describe("failureFor", () => {
  test("each category carries its alert title", () => {
    expect(failureFor("output", new Error("x")).title).toBe(
      "Results unavailable",
    );
    expect(failureFor("config", new Error("x")).title).toBe(
      "Could not prepare the exchange",
    );
    expect(failureFor("security", new Error("x")).title).toBe(
      "Could not verify your partner",
    );
    expect(failureFor("exchange", new Error("x")).title).toBe(
      "Exchange failed",
    );
  });

  test("a tagged security error surfaces its own recovery guidance", () => {
    const failure = failureFor(
      "security",
      Object.assign(
        new Error(
          "shared secret expired at 2026-07-08T19:32:00.000Z; obtain a new invitation",
        ),
        { psilinkRecoveryHintEmitted: true },
      ),
    );
    expect(failure.category).toBe("security");
    expect(failure.title).toBe("This invitation can no longer be used");
    expect(failure.message).toContain("expired at 2026-07-08T19:32:00.000Z");
  });

  test("an untagged security error keeps the fixed non-oracular copy", () => {
    const failure = failureFor(
      "security",
      new Error("kex transcript diverged"),
    );
    expect(failure.title).toBe("Could not verify your partner");
    expect(failure.message).not.toContain("kex transcript diverged");
    expect(failure.message).toContain("start over with a fresh invitation");
  });

  test("the exchange message makes no on-device data claim", () => {
    expect(failureFor("exchange", new Error("ICE failed")).message).toBe(
      "The exchange could not be completed - usually a temporary " +
        "connection problem rather than an issue with your data.",
    );
  });
});
