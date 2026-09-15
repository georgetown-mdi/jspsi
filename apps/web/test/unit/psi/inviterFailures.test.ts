import { describe, expect, test } from "vitest";

import {
  LinkageTermsUnsatisfiableError,
  OperatorConfigError,
  prepareForExchange,
  sanitizeForDisplay,
} from "@psilink/core";

import {
  JobApiRequestError,
  RelayedSelfExplainingError,
  RelayedTerminalError,
} from "@psi/jobClient/serverJobExchangeDriver";
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

  test("a relayed refusal that explains itself shows its own cause", () => {
    // The partner certificate that does not match the pin is the case this
    // exists for. The fixed copy below describes a failed check of the
    // invitation's secret and sends the operator to re-invite, which pins
    // nothing new and refuses identically -- so a refusal whose own message
    // names the cause and the step displaces it.
    const failure = failureFor(
      "security",
      new RelayedSelfExplainingError(
        "the partner's signing certificate is not the one pinned in " +
          "signing.partner_fingerprint, so this run cannot finish",
      ),
    );
    expect(failure.category).toBe("security");
    expect(failure.title).toBe("The exchange stopped on a trust check");
    expect(failure.message).toContain("is not the one pinned in");
    // Not the invitation-expiry title, whose copy would misname a certificate
    // refusal even though the tag it reads is the same one.
    expect(failure.title).not.toBe("This invitation can no longer be used");
  });

  test("a relayed failure making no such claim keeps the fixed copy", () => {
    // The marker is an assurance, never a denial: a relayed terminal without it
    // is a failure the CLI said nothing about, and takes the same copy an
    // untagged browser-raised one does.
    const failure = failureFor(
      "security",
      new RelayedTerminalError("kex transcript diverged"),
    );
    expect(failure.title).toBe("Could not verify your partner");
    expect(failure.message).not.toContain("kex transcript diverged");
  });

  test("an untagged security error keeps the fixed non-oracular copy", () => {
    const failure = failureFor(
      "security",
      new Error("kex transcript diverged"),
    );
    expect(failure.title).toBe("Could not verify your partner");
    expect(failure.message).not.toContain("kex transcript diverged");
    expect(failure.message).toContain("start over with a fresh invitation");
    // Withheld outright rather than moved to the reported-cause block: the kex
    // failure's message is non-oracular by design, which a block attributing it
    // to the exchange would publish just as well as the sentence would.
    expect(failure.reportedCause).toBeUndefined();
  });

  test("the output message forbids the re-run and states its own write", () => {
    // The exchange itself completed, so the alert withholds every run-again
    // control -- and says why, rather than leaving the operator to look for the
    // control somewhere else. The build that failed is this browser's own, so
    // its account finishes those sentences: a block would attribute this
    // application's own words to an exchange that reported nothing.
    const failure = failureFor("output", new Error("blob quota exceeded"));
    expect(failure.message).toContain("do not run this exchange again");
    expect(failure.message).toContain("already happened");
    expect(failure.message).toContain(
      "a local write failed: blob quota exceeded",
    );
    expect(failure.reportedCause).toBeUndefined();
  });

  test("the console's report of a lost write stands on the block", () => {
    // A relayed terminal holds the chain the job client rebuilt from the
    // console's own report of a write this browser did not make, so it stands
    // beside the do-not-repeat sentences under the exchange's label instead of
    // running on from them in one voice, and keeps its links.
    const failure = failureFor(
      "output",
      new RelayedTerminalError(
        "the results file could not be written\ncaused by: EACCES",
      ),
    );
    expect(failure.message).toContain("a local write failed.");
    expect(failure.message).not.toContain("EACCES");
    expect(failure.reportedCause).toBe(
      "the results file could not be written\ncaused by: EACCES",
    );
  });

  test("the output message states a rejection of either shape", () => {
    // The copy accounts for nothing beyond a local write, so whatever the build
    // rejected with is the operator's whole account of which write and why. A
    // value thrown bare reads in its own text, an `Error` as its chain, and
    // both are escaped at this boundary like any other operator-facing text.
    expect(
      failureFor("output", "the directory handle went away").message,
    ).toContain("a local write failed: the directory handle went away");
    const hostile = "\u001b[2Jthe directory handle went away";
    expect(failureFor("output", hostile).message).toContain(
      `a local write failed: ${sanitizeForDisplay(hostile)}`,
    );
  });

  test("an output failure with nothing to report ends the sentence", () => {
    // Neither source leaves the operator a promise with nothing behind it: an
    // empty block under a label promising an account is worse than no block,
    // and so is a sentence that opens on a cause and stops.
    const built = failureFor("output", new Error("   "));
    expect(built.message).toContain("a local write failed.");
    expect(built.reportedCause).toBeUndefined();
    expect(failureFor("output", "  ").message).toContain(
      "a local write failed.",
    );
    const relayed = failureFor("output", new RelayedTerminalError("  "));
    expect(relayed.message).toContain("a local write failed.");
    expect(relayed.reportedCause).toBeUndefined();
  });

  test("the exchange message makes no on-device data claim", () => {
    expect(failureFor("exchange", new Error("ICE failed")).message).toBe(
      "The exchange could not be completed - usually a temporary " +
        "connection problem rather than an issue with your data.",
    );
  });

  test("the exchange failure reports its cause outside the fixed copy", () => {
    // The operator of an unattended run gets the cause chain to act on, and it
    // arrives as the exchange's report rather than as this application's
    // guidance: the fixed copy holds none of it, and the chain keeps its links.
    const failure = failureFor(
      "exchange",
      new RelayedTerminalError(
        "the partner closed the connection\ncaused by: read ECONNRESET",
      ),
    );
    expect(failure.title).toBe("Exchange failed");
    expect(failure.message).not.toContain("ECONNRESET");
    expect(failure.reportedCause).toBe(
      "the partner closed the connection\ncaused by: read ECONNRESET",
    );
  });

  test("a browser-raised exchange failure reports its own chain", () => {
    // The public web seat has no console relaying a rendered chain, so its
    // report is the escaped walk of the error raised in this browser.
    const failure = failureFor(
      "exchange",
      new Error("the data channel closed", {
        cause: new Error("ICE failed"),
      }),
    );
    expect(failure.reportedCause).toBe(
      "the data channel closed\ncaused by: ICE failed",
    );
  });

  test("an exchange failure with nothing to report gets no block", () => {
    // The label promises an account of the failure, so a block is offered only
    // where there is text to put in it. An `Error` always renders as something
    // ("Error" for an empty message); a terminal relayed with no message at all,
    // and a bare value thrown in this browser, are what render as nothing.
    expect(
      failureFor("exchange", new RelayedTerminalError("")).reportedCause,
    ).toBeUndefined();
    expect(failureFor("exchange", "  ").reportedCause).toBeUndefined();
  });

  test("a non-Error throw gets no report block, only the fixed message", () => {
    // A thrown non-Error's `String()` reads as `undefined` or
    // `[object Object]`, which would render under a label promising the
    // exchange's own account of the failure. Withheld outright, and the fixed
    // copy still reaches the operator.
    const fixedMessage =
      "The exchange could not be completed - usually a temporary " +
      "connection problem rather than an issue with your data.";
    const undefinedThrow = failureFor("exchange", undefined);
    expect(undefinedThrow.reportedCause).toBeUndefined();
    expect(undefinedThrow.message).toBe(fixedMessage);
    const objectThrow = failureFor("exchange", { code: 7 });
    expect(objectThrow.reportedCause).toBeUndefined();
    expect(objectThrow.message).toBe(fixedMessage);
  });

  test("a reported cause reaches the block escaped", () => {
    // The block is a display boundary like any other, so the escape the seat
    // applies everywhere else applies here: a terminal holding the ESC that
    // drives an ANSI sequence, and a bidi override, reaches the operator with
    // neither. Read off the escaper rather than restated, so a change to the
    // escape's own alphabet cannot leave a stale copy passing.
    const hostile = "\u001b[2J\u202eread ECONNRESET";
    const escaped = failureFor(
      "exchange",
      new RelayedTerminalError(hostile),
    ).reportedCause;
    expect(escaped).toBe(sanitizeForDisplay(hostile));
    expect(escaped).not.toContain("\u001b");
    expect(escaped).not.toContain("\u202e");
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
