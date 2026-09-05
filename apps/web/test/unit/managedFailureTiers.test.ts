import {
  ConnectionError,
  LinkageTermsUnsatisfiableError,
  generateSharedSecret,
  getDefaultLinkageTerms,
  inferMetadata,
} from "@psilink/core";
import { describe, expect, test } from "vitest";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  composeManagedExchangeFile,
} from "@psi/managedExchangeRecord";
import {
  assessManagedInputColumns,
  managedInputFailureKind,
} from "@psi/managedInputGuard";
import {
  deriveManagedFailureTier,
  importedSinceLastSuccess,
} from "@psi/managedFailureTiers";
import { prepareManagedRerunExchange } from "@psi/managedPreparedExchange";
import { rerunFailureLastRun } from "@psi/managedRun";

import type {
  ManagedExchangeLastRun,
  ManagedExchangeRecord,
} from "@psi/managedExchangeRecord";
import type { CSVRow } from "@psilink/core";
import type { ManagedLocalState } from "@psi/managedLocalState";

// The desync-versus-attack tier derivation, tested in Node: each recorded benign state
// resolves to its own tier from the record's OWN structured bookkeeping, and only a
// failed-closed handshake with no benign explanation reaches the unexplained tier. The
// evidence is the record's, never a live error, so an unattended run shows the same
// tier at the next visit as an attended one.

const NOW = Date.parse("2026-07-14T12:00:00.000Z");
const RUN_AT = "2026-07-14T09:00:00.000Z";

function record(
  overrides: Partial<ManagedExchangeRecord> = {},
): ManagedExchangeRecord {
  return {
    schemaVersion: MANAGED_EXCHANGE_SCHEMA_VERSION,
    id: "abc",
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  };
}

function failed(
  failureKind: ManagedExchangeLastRun["failureKind"],
): ManagedExchangeLastRun {
  return { at: RUN_AT, outcome: "failed", failureKind };
}

describe("deriveManagedFailureTier: tier per recorded benign state", () => {
  test("no run yet is none", () => {
    expect(deriveManagedFailureTier(record(), undefined, NOW)).toBe("none");
  });

  test("a succeeded last run is none", () => {
    expect(
      deriveManagedFailureTier(
        record({ lastRun: { at: RUN_AT, outcome: "succeeded" } }),
        undefined,
        NOW,
      ),
    ).toBe("none");
  });

  test("a missed window is its own benign tier", () => {
    expect(
      deriveManagedFailureTier(
        record({ lastRun: { at: RUN_AT, outcome: "missed" } }),
        undefined,
        NOW,
      ),
    ).toBe("missed");
  });

  test("a recorded input failure is the benign input tier", () => {
    expect(
      deriveManagedFailureTier(
        record({ lastRun: failed("input") }),
        undefined,
        NOW,
      ),
    ).toBe("input");
  });

  test("a recorded storage persist failure is the Tier-1 storage state", () => {
    expect(
      deriveManagedFailureTier(
        record({ lastRun: failed("storage") }),
        undefined,
        NOW,
      ),
    ).toBe("storage");
  });

  test("a recorded unreadable custody entry is its own tier, not the storage one", () => {
    // The two are both this device's own storage, and they leave different states
    // behind: the persist failure rotated a secret it could not save, this one
    // refused before the handshake and rotated nothing.
    expect(
      deriveManagedFailureTier(
        record({ lastRun: failed("custody-unreadable") }),
        undefined,
        NOW,
      ),
    ).toBe("custody-unreadable");
  });

  test("a transport drop is the transport (retry) tier, never attack framing", () => {
    expect(
      deriveManagedFailureTier(
        record({ lastRun: failed("transport") }),
        undefined,
        NOW,
      ),
    ).toBe("transport");
  });

  test("a recorded hand-off refusal is its own benign tier, not the attack one", () => {
    // The kind a run stamps when it meets a copy an export gave away. Falling
    // through to the unexplained tier would put the out-of-band attack checklist
    // in front of an operator whose own hand-off is the whole explanation.
    expect(
      deriveManagedFailureTier(
        record({ lastRun: failed("handed-off") }),
        { spent: { spentAt: "2026-07-13T09:00:00.000Z" } },
        NOW,
      ),
    ).toBe("handed-off");
  });

  test("a cancelled run is treated as a retry, not a failure to tier", () => {
    expect(
      deriveManagedFailureTier(
        record({ lastRun: failed("cancelled") }),
        undefined,
        NOW,
      ),
    ).toBe("transport");
  });

  test("a lapsed bound is the expiry tier, whatever the last recorded run was", () => {
    expect(
      deriveManagedFailureTier(
        record({
          expires: "2026-07-01T00:00:00.000Z",
          lastRun: failed("auth"),
        }),
        undefined,
        NOW,
      ),
    ).toBe("expired");
  });
});

describe("deriveManagedFailureTier: the consent tier, from the real send-side gates", () => {
  // Each gate's REAL refusal is driven through the re-run's prepare, classified by the
  // runner, and tiered from what that classification wrote -- so the whole chain from
  // the pre-connection refusal to the operator-facing tier is pinned, not a
  // hand-built failureKind standing in for it.
  const columns = ["first_name", "last_name", "date_of_birth"];
  const rows: Array<CSVRow> = [
    { first_name: "Ada", last_name: "Lovelace", date_of_birth: "12/10/1815" },
  ];

  function tierOfPrepareRefusal(
    exchangeFile: ManagedExchangeRecord["exchangeFile"],
  ) {
    let thrown: unknown;
    try {
      prepareManagedRerunExchange(exchangeFile, rows, columns);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    const lastRun = rerunFailureLastRun(
      thrown,
      Date.parse(RUN_AT),
      false,
      false,
    );
    expect(lastRun?.failureKind).toBe("consent");
    return deriveManagedFailureTier(record({ lastRun }), undefined, NOW);
  }

  test("an outbound-consent refusal tiers as consent", () => {
    // A stored acceptor document whose confirmed set this run's columns no longer
    // resolve: assertOutboundPayloadConsented refuses before connecting.
    expect(
      tierOfPrepareRefusal(
        composeManagedExchangeFile({
          connection: { channel: "webrtc", host: "signaling.example.org" },
          linkageTerms: getDefaultLinkageTerms("Clinic A"),
          outboundPayloadConsent: {
            status: "confirmed",
            columns: ["consented_column"],
          },
        }),
      ),
    ).toBe("consent");
  });

  test("a disclosure-commitment drift tiers as consent", () => {
    // A stored document committing a column this run's metadata no longer discloses:
    // assertDisclosureMatchesCommitment refuses before connecting.
    expect(
      tierOfPrepareRefusal(
        composeManagedExchangeFile({
          connection: { channel: "webrtc", host: "signaling.example.org" },
          linkageTerms: getDefaultLinkageTerms("Clinic A"),
          disclosedPayloadColumns: ["committed_column"],
        }),
      ),
    ).toBe("consent");
  });

  test("a genuine transport drop still tiers as transport", () => {
    // The refusal's own tier must not swallow the retryable one: a connection drop
    // classified by the same runner still reaches the transport tier.
    const lastRun = rerunFailureLastRun(
      new ConnectionError("data channel dropped", "transport"),
      Date.parse(RUN_AT),
      false,
      false,
    );
    expect(lastRun?.failureKind).toBe("transport");
    expect(deriveManagedFailureTier(record({ lastRun }), undefined, NOW)).toBe(
      "transport",
    );
  });
});

describe("deriveManagedFailureTier: the terms-shortfall tier, from the real refusals", () => {
  // Both refusals are driven for real -- the run-start guard's own grading and
  // core's refusal at the run boundary -- and tiered from what each stamped, so
  // the chain from an input that cannot match on every agreed key to the
  // operator-facing tier is pinned rather than a hand-built failureKind.
  const agreedColumns = ["ssn", "first_name", "last_name", "date_of_birth"];
  const shortColumns = ["first_name", "last_name", "date_of_birth"];
  const shortRows: Array<CSVRow> = [
    { first_name: "Ada", last_name: "Lovelace", date_of_birth: "12/10/1815" },
  ];

  /** A stored document whose standing terms are the defaults over the full agreed
   * column set, so a refresh that dropped one of them falls short of a key. */
  function agreedExchangeFile(): ManagedExchangeRecord["exchangeFile"] {
    return composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: getDefaultLinkageTerms(
        "County Health Dept",
        inferMetadata(agreedColumns),
      ),
    });
  }

  test("the guard's own column rejection tiers as terms-shortfall", () => {
    const rejection = assessManagedInputColumns(
      agreedExchangeFile(),
      shortColumns,
    );
    if (rejection === undefined) throw new Error("expected a rejection");
    const lastRun: ManagedExchangeLastRun = {
      at: RUN_AT,
      outcome: "failed",
      failureKind: managedInputFailureKind(rejection),
    };
    expect(lastRun.failureKind).toBe("terms-shortfall");
    expect(deriveManagedFailureTier(record({ lastRun }), undefined, NOW)).toBe(
      "terms-shortfall",
    );
  });

  test("core's own run-boundary refusal tiers as terms-shortfall", () => {
    let thrown: unknown;
    try {
      prepareManagedRerunExchange(
        agreedExchangeFile(),
        shortRows,
        shortColumns,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LinkageTermsUnsatisfiableError);
    const lastRun = rerunFailureLastRun(
      thrown,
      Date.parse(RUN_AT),
      false,
      false,
    );
    expect(lastRun?.failureKind).toBe("terms-shortfall");
    expect(deriveManagedFailureTier(record({ lastRun }), undefined, NOW)).toBe(
      "terms-shortfall",
    );
  });
});

describe("deriveManagedFailureTier: the import/restore tier", () => {
  const imported: ManagedLocalState = {
    imported: { importedAt: "2026-07-13T00:00:00.000Z" },
  };

  test("an auth failure with an import marker is the benign imported tier", () => {
    expect(
      deriveManagedFailureTier(
        record({ lastRun: failed("auth") }),
        imported,
        NOW,
      ),
    ).toBe("imported");
  });

  test("a transport drop with a standing import marker is still the transport tier", () => {
    // The import marker explains only a failed-CLOSED (auth) handshake -- a stale
    // restored secret cannot authenticate. A transport drop is a connection problem the
    // marker does not bear on, so it stays the retryable transport tier, not mis-tiered
    // as "restored from a backup".
    expect(
      deriveManagedFailureTier(
        record({ lastRun: failed("transport") }),
        imported,
        NOW,
      ),
    ).toBe("transport");
  });

  test("importedSinceLastSuccess reads the marker's presence alone", () => {
    // The marker is cleared on the first rotation after an import (a completed
    // handshake proves sync), so its mere presence is the "restored and not yet
    // successfully run since" evidence -- no timestamp comparison.
    expect(importedSinceLastSuccess(imported)).toBe(true);
    expect(importedSinceLastSuccess(undefined)).toBe(false);
    expect(importedSinceLastSuccess({})).toBe(false);
  });
});

describe("deriveManagedFailureTier: the unexplained tier and the secret-farming caveat", () => {
  test("a failed-closed handshake with no benign explanation is unexplained", () => {
    expect(
      deriveManagedFailureTier(
        record({ lastRun: failed("auth") }),
        undefined,
        NOW,
      ),
    ).toBe("unexplained");
  });

  test("a backup marker alone does NOT explain an auth failure (only the import marker does)", () => {
    // A record with a current backup but no import is NOT a restore -- an active
    // impersonator must not be able to farm a benign reading from an unrelated marker.
    const backedUp: ManagedLocalState = {
      backup: { backedUpAt: "2026-07-13T00:00:00.000Z" },
    };
    expect(
      deriveManagedFailureTier(
        record({ lastRun: failed("auth") }),
        backedUp,
        NOW,
      ),
    ).toBe("unexplained");
  });
});
