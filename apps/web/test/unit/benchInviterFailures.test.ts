import { describe, expect, test } from "vitest";

import { JobApiRequestError } from "@psi/serverJobExchangeDriver";
import { failureFor } from "@bench/useInviterExchange";

import type { JobInputSource } from "@psi/serverJobExchangeDriver";

const WORK_FILE: JobInputSource = {
  kind: "workFile",
  name: "clients.csv",
};

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

  test("a filedrop mounted-file 400 names the file as the cause", () => {
    const failure = failureFor(
      "config",
      new JobApiRequestError(400, "POST /api/jobs failed with status 400"),
      WORK_FILE,
      "filedrop",
    );
    expect(failure.title).toBe("The appliance could not start this exchange");
    expect(failure.message).not.toContain("status 400");
    expect(failure.message).toContain("file");
    expect(failure.message).not.toContain("SFTP");
  });

  test("an sftp mounted-file 400 names both the file and the destination", () => {
    // The server returns the identical empty-bodied 400 for a vanished SFTP remote,
    // so on the sftp channel the copy names both causes.
    const failure = failureFor(
      "config",
      new JobApiRequestError(400, "POST /api/jobs failed with status 400"),
      WORK_FILE,
      "sftp",
    );
    expect(failure.title).toBe("The appliance could not start this exchange");
    expect(failure.message).not.toContain("status 400");
    expect(failure.message).toContain("SFTP");
  });

  test("a config fault that is not a mounted-file 400 keeps the generic copy", () => {
    // An inline-source create rejection, and a CLI prepare-time config fault, both
    // surface the plain config message -- only the workFile 400 names the file.
    expect(
      failureFor("config", new JobApiRequestError(400, "x"), {
        kind: "inline",
        csv: "a,b",
      }).title,
    ).toBe("Could not prepare the exchange");
    expect(
      failureFor("config", new JobApiRequestError(500, "x"), WORK_FILE).title,
    ).toBe("Could not prepare the exchange");
  });
});
