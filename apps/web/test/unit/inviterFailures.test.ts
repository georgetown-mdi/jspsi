import { describe, expect, test } from "vitest";

import {
  LinkageTermsUnsatisfiableError,
  OperatorConfigError,
  prepareForExchange,
} from "@psilink/core";

import { JobApiRequestError } from "@psi/jobClient/serverJobExchangeDriver";
import { failureFor } from "@exchange/useInviterExchange";

import type { CSVRow, LinkageTerms, Metadata } from "@psilink/core";
import type { JobInputSource } from "@psi/jobClient/serverJobExchangeDriver";

const WORK_FILE: JobInputSource = {
  kind: "workFile",
  name: "clients.csv",
};

// The single-pass ceiling refusal as core raises it: enough declared linkage keys
// and records that their product crosses the per-party value-slot budget. The
// budget itself is core's own constant and not on its public surface, so the
// fixture is sized past it rather than derived from it -- a raised ceiling stops
// the refusal firing and fails below rather than passing quietly.
const CEILING_KEY_COUNT = 30;
const CEILING_ROW_COUNT = 100_001;

const ceilingRefusal = (): unknown => {
  const terms: LinkageTerms = {
    version: "1.0.0",
    identity: "Tester",
    date: "2026-01-01",
    algorithm: "psi",
    linkageStrategy: "single-pass",
    output: { expectsOutput: true, shareWithPartner: true },
    deduplicate: false,
    linkageFields: [
      { name: "first_name", type: "first_name" },
      { name: "last_name", type: "last_name" },
    ],
    linkageKeys: Array.from({ length: CEILING_KEY_COUNT }, (_, index) => ({
      name: `FN_LN_${index}`,
      elements: [{ field: "first_name" }, { field: "last_name" }],
    })),
  };
  const metadata: Metadata = [
    {
      name: "first_name",
      type: "first_name",
      role: "linkage",
      isPayload: false,
    },
    { name: "last_name", type: "last_name", role: "linkage", isPayload: false },
  ];
  const rows = new Array<CSVRow>(CEILING_ROW_COUNT).fill({
    first_name: "Alice",
    last_name: "Smith",
  });
  try {
    prepareForExchange({ linkageTerms: terms, metadata }, "Tester", rows, [
      "first_name",
      "last_name",
    ]);
  } catch (err) {
    return err;
  }
  throw new Error(
    "expected the single-pass ceiling refusal, got a prepared exchange",
  );
};

describe("failureFor", () => {
  test("each category has its alert title", () => {
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

  test("a tagged security error shows its own recovery guidance", () => {
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

  test("the output message forbids the re-run and still holds the cause", () => {
    // The exchange itself completed, so the alert withholds every run-again
    // control -- and says why, rather than leaving the operator to look for the
    // control somewhere else. The local cause stays in the message.
    const failure = failureFor("output", new Error("blob quota exceeded"));
    expect(failure.message).toContain("do not run this exchange again");
    expect(failure.message).toContain("already happened");
    expect(failure.message).toContain(
      "a local write failed: blob quota exceeded",
    );
  });

  test("the exchange message makes no on-device data claim", () => {
    expect(failureFor("exchange", new Error("ICE failed")).message).toBe(
      "The exchange could not be completed - usually a temporary " +
        "connection problem rather than an issue with your data.",
    );
  });

  test("a filedrop exchange failure names the shared folder, not a connection", () => {
    // A filedrop run never opens a connection -- it rendezvouses through a synced
    // folder -- so the copy names the shared-state cause and keeps the retry.
    const failure = failureFor(
      "exchange",
      new Error("no rendezvous"),
      undefined,
      "filedrop",
    );
    expect(failure.title).toBe("Exchange failed");
    expect(failure.message).toContain("shared folder");
    expect(failure.message).toContain("syncing");
    expect(failure.message).toContain("try again");
    expect(failure.message).not.toContain("connection problem");
  });

  test("a filedrop mounted-file 400 names the file as the cause", () => {
    const failure = failureFor(
      "config",
      new JobApiRequestError(400, "POST /api/jobs failed with status 400"),
      WORK_FILE,
      "filedrop",
    );
    expect(failure.title).toBe("The console could not start this exchange");
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
    expect(failure.title).toBe("The console could not start this exchange");
    expect(failure.message).not.toContain("status 400");
    expect(failure.message).toContain("SFTP");
  });

  test("the acceptor mounted-file 400 names its columns-step recovery", () => {
    // The acceptor's only config recovery button returns to its columns step (whose
    // own Back link re-selects the file), not a start-over that reaches the picker, so
    // the copy must name that control rather than the inviter's "Start over".
    const failure = failureFor(
      "config",
      new JobApiRequestError(400, "POST /api/jobs failed with status 400"),
      WORK_FILE,
      "filedrop",
      "acceptor",
    );
    expect(failure.title).toBe("The console could not start this exchange");
    expect(failure.message).toContain("columns");
    expect(failure.message).toContain("choose a different file");
    expect(failure.message).not.toContain("Start over");
    // The inviter path keeps its start-over wording (its start-over reaches the picker).
    const inviter = failureFor(
      "config",
      new JobApiRequestError(400, "POST /api/jobs failed with status 400"),
      WORK_FILE,
      "filedrop",
    );
    expect(inviter.message).toContain("Start over and select it again");
  });

  test("a config fault that is not a mounted-file 400 keeps the generic copy", () => {
    // An inline-source create rejection, and a CLI prepare-time config fault, both
    // show the plain config message -- only the workFile 400 names the file.
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

  test("the prepare-time ceiling refusal reaches the operator with its remedies", () => {
    // core types the single-pass ceiling pre-flight as an OperatorConfigError, so
    // this alert shows the refusal's own text rather than generic exchange copy.
    // Checked against the real text core raises, not a copy that could drift.
    // The other half of the path -- a prepare-phase OperatorConfigError reaching
    // this builder as `config` at all -- is pinned in exchangeLifecycle.test.ts
    // against the same base type.
    const refusal = ceilingRefusal();
    expect(refusal).toBeInstanceOf(OperatorConfigError);
    const failure = failureFor("config", refusal, WORK_FILE);
    expect(failure.category).toBe("config");
    expect(failure.title).toBe("Could not prepare the exchange");
    expect(failure.message).toContain("exceed the single-pass ceiling");
    expect(failure.message).toContain("split the dataset into smaller batches");
  });

  test("a file that cannot supply the agreed keys gets fixed copy and no retry", () => {
    // The refusal's own message enumerates the agreed terms' key and field names,
    // which are partner-authored on every accept path, so the alert states the
    // condition instead of echoing them. Classified `config`, which is the
    // start-over affordance rather than the retryable `exchange` one: the same
    // file refuses identically however many times it runs.
    const failure = failureFor(
      "config",
      new LinkageTermsUnsatisfiableError(
        "this input cannot satisfy every linkage key the agreed terms declare: " +
          "1 of the 2 agreed linkage keys cannot be produced",
      ),
      WORK_FILE,
    );
    expect(failure.category).toBe("config");
    expect(failure.title).toBe(
      "This file cannot supply the linkage keys you agreed to",
    );
    expect(failure.message).not.toContain("agreed linkage keys cannot be");
    expect(failure.message).toContain("nothing left this device");
    expect(failure.message).toContain("settle new terms with your partner");
  });
});
