import {
  assembleExchangeSpec,
  connectionFromLocator,
  getDefaultLinkageTerms,
  inferMetadata,
} from "@alcove/core";
import { describe, expect, test } from "vitest";

import {
  ManagedInputError,
  assessManagedInputColumns,
  managedInputFailureKind,
  managedInputLastRun,
} from "@psi/managed/managedInputGuard";
import { lastRunSchema } from "@psi/managed/managedExchangeRecord";

import type { ExchangeSpec, WebRTCExchangeLocator } from "@alcove/core";

// The pure, platform-free half of the run-start input guard, tested in Node
// without a file handle, a permission prompt, or a database: the column-shape
// verdict over a record's standing terms and the benign input-rejection
// classification. The platform reads (getFile through the handle, the permission
// layer, and the composed run-start acquisition) are the platform half, tested
// against real Chromium in test/browser/managedInputHandle.test.ts.

const webrtcLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
  path: "/api/",
};

const standingColumns = ["ssn", "first_name", "last_name", "date_of_birth"];

/** A managed exchange-file document whose standing terms are the metadata-aware
 * defaults for {@link standingColumns} -- the terms an exchange over that file
 * agreed -- so a conforming input satisfies every declared key and a drifted one
 * falls short of at least one. The same document the record persists. */
function standingExchangeFile(): ExchangeSpec {
  return assembleExchangeSpec({
    connection: connectionFromLocator(webrtcLocator),
    linkageTerms: getDefaultLinkageTerms(
      "County Health Dept",
      inferMetadata(standingColumns, []),
    ),
  });
}

describe("assessManagedInputColumns: the standing-terms guard", () => {
  test("accepts columns that satisfy every standing linkage key", () => {
    expect(
      assessManagedInputColumns(standingExchangeFile(), standingColumns),
    ).toBeUndefined();
  });

  test("rejects columns that satisfy no standing linkage key", () => {
    const rejection = assessManagedInputColumns(standingExchangeFile(), [
      "unrelated_a",
      "unrelated_b",
    ]);
    expect(rejection?.reason).toBe("columns");
    // The unproducible standing linkage fields are held for the caller to name.
    if (rejection?.reason === "columns")
      expect(rejection.unsatisfied.length).toBeGreaterThan(0);
  });

  test("rejects an empty column set (a wrong or headerless refresh)", () => {
    const rejection = assessManagedInputColumns(standingExchangeFile(), []);
    expect(rejection?.reason).toBe("columns");
  });

  test("reports the one-column reading a wrong delimiter produces", () => {
    // A stored record reads its input by the delimiter it was set up with, so an
    // extract separated another way arrives as one mashed column. The rejection
    // includes that reading for the launch surface to state the delimiter remedy on,
    // instead of sending the operator to renegotiate terms with their partner.
    const mashed = assessManagedInputColumns(standingExchangeFile(), [
      standingColumns.join("\t"),
    ]);
    expect(mashed?.reason).toBe("columns");
    if (mashed?.reason === "columns") expect(mashed.singleColumn).toBe(true);
    const shortfall = assessManagedInputColumns(
      standingExchangeFile(),
      standingColumns.slice(1),
    );
    expect(shortfall?.reason).toBe("columns");
    if (shortfall?.reason === "columns")
      expect(shortfall.singleColumn).toBe(false);
  });

  test("rejects a file short of one agreed key, not only the no-key case", () => {
    // A file that dropped its SSN column still satisfies the name-and-DOB keys, and
    // the run boundary refuses it all the same: an exchange runs every key both
    // parties agreed on. The guard holds that rule rather than a looser one it
    // would then be overruled on, before any connection.
    const rejection = assessManagedInputColumns(standingExchangeFile(), [
      "first_name",
      "last_name",
      "date_of_birth",
    ]);
    expect(rejection?.reason).toBe("columns");
    if (rejection?.reason === "columns")
      expect(rejection.unsatisfied.map((field) => field.type)).toContain("ssn");
  });
});

describe("ManagedInputError", () => {
  test("an acquire rejection has its cause and a non-sensitive message", () => {
    const cause = new Error("NotFoundError: the entry was not found");
    const error = new ManagedInputError({ reason: "acquire", cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ManagedInputError");
    expect(error.rejection.reason).toBe("acquire");
    expect(error.cause).toBe(cause);
    // The base message is a fixed summary, not the partner- or file-influenced
    // detail (which rides the rejection for the caller to sanitize).
    expect(error.message).not.toContain("NotFound");
  });

  test("a columns rejection holds the unsatisfied fields off the message", () => {
    const rejection = assessManagedInputColumns(standingExchangeFile(), [
      "nope",
    ]);
    if (rejection === undefined) throw new Error("expected a rejection");
    const error = new ManagedInputError(rejection);
    expect(error.rejection.reason).toBe("columns");
    if (error.rejection.reason === "columns")
      expect(error.rejection.unsatisfied.length).toBeGreaterThan(0);
    // The message names no field, so a partner-influenced field name cannot leak
    // through a generic error surface.
    expect(error.message).toBe(
      "managed exchange input cannot satisfy the standing linkage terms",
    );
  });
});

describe("managedInputFailureKind: the recorded kind for each rejection", () => {
  test("an acquire rejection is the retryable input kind", () => {
    expect(
      managedInputFailureKind({ reason: "acquire", cause: new Error("gone") }),
    ).toBe("input");
  });

  test("a columns rejection is the terms-shortfall kind, not the input kind", () => {
    // The two remedies differ: the acquisition failure is cleared by putting the
    // file back, the shortfall only by a conforming file or re-agreed terms. A
    // record stamping one kind for both would offer the wrong one at the next
    // visit, which is exactly what an unattended run leaves behind.
    const rejection = assessManagedInputColumns(standingExchangeFile(), [
      "nope",
    ]);
    if (rejection === undefined) throw new Error("expected a rejection");
    expect(managedInputFailureKind(rejection)).toBe("terms-shortfall");
  });
});

describe("managedInputLastRun: the bookkeeping a rejection records", () => {
  const at = Date.parse("2026-07-14T09:00:00.000Z");

  /** The rejection a file separated by something other than this record's
   * delimiter produces: the whole header arrives as one mashed column. */
  function mashedRejection() {
    const rejection = assessManagedInputColumns(standingExchangeFile(), [
      standingColumns.join("\t"),
    ]);
    if (rejection === undefined) throw new Error("expected a rejection");
    return rejection;
  }

  test("stamps the one-column reading on a mashed shortfall", () => {
    // The launch error holding the reading is gone by the next visit, so the
    // entry is the only place the delimiter remedy can be read back from.
    expect(managedInputLastRun(mashedRejection(), at)).toStrictEqual({
      at: "2026-07-14T09:00:00.000Z",
      outcome: "failed",
      failureKind: "terms-shortfall",
      singleColumnInput: true,
    });
  });

  test("omits the reading on a shortfall of the agreed keys", () => {
    // Absence is what keeps the agreed-keys copy: a file that dropped one column
    // is a real shortfall, and naming a delimiter would misdirect the operator.
    const rejection = assessManagedInputColumns(
      standingExchangeFile(),
      standingColumns.slice(1),
    );
    if (rejection === undefined) throw new Error("expected a rejection");
    const lastRun = managedInputLastRun(rejection, at);
    expect(lastRun.failureKind).toBe("terms-shortfall");
    expect(lastRun).not.toHaveProperty("singleColumnInput");
  });

  test("omits the reading on an acquire rejection", () => {
    const lastRun = managedInputLastRun(
      { reason: "acquire", cause: new Error("gone") },
      at,
    );
    expect(lastRun.failureKind).toBe("input");
    expect(lastRun).not.toHaveProperty("singleColumnInput");
  });

  test("the stamped entry is one the record validator admits", () => {
    expect(
      lastRunSchema.parse(managedInputLastRun(mashedRejection(), at)),
    ).toStrictEqual(managedInputLastRun(mashedRejection(), at));
    // Admitted only as `true`, so the field cannot hold a reading its own
    // absence already states.
    expect(() =>
      lastRunSchema.parse({
        ...managedInputLastRun(mashedRejection(), at),
        singleColumnInput: false,
      }),
    ).toThrow();
  });
});
