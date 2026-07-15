import {
  assembleExchangeSpec,
  connectionFromLocator,
  getDefaultLinkageTerms,
} from "@psilink/core";
import { describe, expect, test } from "vitest";

import {
  ManagedInputError,
  assessManagedInputColumns,
} from "@psi/managedInputGuard";

import type { ExchangeSpec, WebRTCExchangeLocator } from "@psilink/core";

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

/** A managed exchange-file document whose standing terms are the metadata-aware
 * defaults for a PII column set, so a conforming input satisfies at least one key
 * and a drifted one satisfies none -- the same document the record persists. */
function standingExchangeFile(): ExchangeSpec {
  return assembleExchangeSpec({
    connection: connectionFromLocator(webrtcLocator),
    linkageTerms: getDefaultLinkageTerms("County Health Dept"),
  });
}

const standingColumns = ["ssn", "first_name", "last_name", "date_of_birth"];

describe("assessManagedInputColumns: the column-shape guard", () => {
  test("accepts columns that satisfy at least one standing linkage key", () => {
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
    // The unproducible standing linkage fields are carried for the caller to name.
    if (rejection?.reason === "columns")
      expect(rejection.unsatisfied.length).toBeGreaterThan(0);
  });

  test("rejects an empty column set (a wrong or headerless refresh)", () => {
    const rejection = assessManagedInputColumns(standingExchangeFile(), []);
    expect(rejection?.reason).toBe("columns");
  });

  test("a partial-but-sufficient column set is accepted (shape, not exact match)", () => {
    // A file missing SSN but carrying name + DOB still satisfies a name-only key,
    // so the shape guard accepts it -- it blocks only the no-key-can-match case.
    expect(
      assessManagedInputColumns(standingExchangeFile(), [
        "first_name",
        "last_name",
        "date_of_birth",
      ]),
    ).toBeUndefined();
  });
});

describe("ManagedInputError", () => {
  test("an acquire rejection carries its cause and a non-sensitive message", () => {
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

  test("a columns rejection carries the unsatisfied fields off the message", () => {
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
      "managed exchange input satisfies no standing linkage keys",
    );
  });
});
