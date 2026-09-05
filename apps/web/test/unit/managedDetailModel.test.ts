import { UNNAMED_PARTY_LABEL, getDefaultLinkageTerms } from "@psilink/core";
import { describe, expect, test } from "vitest";

import {
  SIDE_LABELS,
  completedRunRecorded,
  connectionRows,
  linkageTermsRows,
  runHistoryEntries,
  scheduleView,
} from "@bench/managedDetailModel";
import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
} from "@psi/managedExchangeRecord";
import { managedExchangeLapsed } from "@psi/managedExpiry";

import type {
  ManagedExchangeLastRun,
  ManagedExchangeSchedule,
  ManagedExchangeSide,
  NewManagedExchange,
} from "@psi/managedExchangeRecord";
import type { WebRTCExchangeLocator } from "@psilink/core";

// The pure derivation behind the managed exchange detail view, tested in Node: the
// read-only configuration rows (both sides), the run-history entries around the most
// recent run, and their accurate disclosure/framing. The copy is the model's; the
// components render it.

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

const webrtcLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
  path: "/api/",
};

function exchangeFile() {
  return composeManagedExchangeFile({
    connection: webrtcLocator,
    linkageTerms,
  });
}

function record(
  side: ManagedExchangeSide,
  overrides: Partial<NewManagedExchange> = {},
) {
  return buildManagedExchangeRecord({
    label: "Riverbend quarterly",
    exchangeFile: exchangeFile(),
    side,
    sharedSecret: "A".repeat(43),
    ...overrides,
  });
}

describe("connectionRows", () => {
  test("names the channel and the credential-free rendezvous endpoint", () => {
    const rows = connectionRows(exchangeFile());
    const channel = rows.find((row) => row.label === "Channel");
    const server = rows.find((row) => row.label === "Rendezvous server");
    expect(channel?.value).toBe("Live (browser)");
    expect(server?.value).toBe("signaling.example.org:3000/api/");
    // No credential field is representable in the stored document, so none shows.
    const rendered = rows.map((row) => row.value).join(" ");
    expect(rendered).not.toContain("username");
    expect(rendered).not.toContain("key");
  });
});

// Every value on this view is authored by somebody else -- the partner, through
// the accepted document, or this operator -- and it is the surface a compliance
// user reads to confirm the agreed terms. The class that matters is the one JSX
// escaping does not touch: a bidi override, a zero-width joiner, or a homoglyph
// renders as the term the reader expects while being another string. Escaping is
// pinned here, in the model, rather than in the component.
describe("the configuration rows escape what somebody else authored", () => {
  // Written as escapes rather than literals: a raw bidi override in a source file
  // is itself the hazard these deliveries measure.
  const RLO = "\u202e";
  const ZWJ = "\u200d";

  test("a hostile identity, key name, and legal reference are escaped", () => {
    const hostileTerms = {
      ...linkageTerms,
      identity: `County${RLO} Health`,
      linkageKeys: [
        {
          name: `SSN${ZWJ} + DOB`,
          elements: linkageTerms.linkageKeys[0].elements,
        },
      ],
      legalAgreement: {
        reference: `MOU${RLO}-001`,
        purpose: "Care coordination",
        expirationDate: "2027-01-01",
      },
    };
    const rows = linkageTermsRows(
      composeManagedExchangeFile({
        connection: webrtcLocator,
        linkageTerms: hostileTerms,
      }),
    );
    const rendered = rows
      .flatMap((row) => [row.value ?? "", ...(row.values ?? [])])
      .join(" ");
    expect(rendered).not.toContain(RLO);
    expect(rendered).not.toContain(ZWJ);
    expect(rendered).toContain("\\u202e");
    expect(rendered).toContain("\\u200d");
  });

  test("a hostile rendezvous host and path are escaped, each on its own budget", () => {
    const rows = connectionRows(
      composeManagedExchangeFile({
        connection: {
          ...webrtcLocator,
          host: `signaling${RLO}.example.org`,
          path: `/api${ZWJ}/`,
        },
        linkageTerms,
      }),
    );
    const server = rows.find((row) => row.label === "Rendezvous server");
    expect(server?.value).not.toContain(RLO);
    expect(server?.value).not.toContain(ZWJ);
    // Both halves survive: the path is not what a padded host spends, because
    // each crosses the boundary on a budget of its own before they compose.
    expect(server?.value).toContain("\\u202e");
    expect(server?.value).toContain("\\u200d");
  });
});

describe("linkageTermsRows renders configuration for both sides", () => {
  test("an exchange naming nobody displays as unnamed, not as a blank row", () => {
    // The stored document's `linkage_terms.identity` is optional. The detail
    // screen states every row it renders, so the one naming this party states its
    // absence rather than rendering an empty value.
    const stored = record("inviter");
    const { identity: _unnamed, ...withoutIdentity } =
      stored.exchangeFile.linkageTerms;
    const rows = linkageTermsRows({
      ...stored.exchangeFile,
      linkageTerms: withoutIdentity,
    });
    const identityRow = rows.find((row) => row.label === "Your identity");
    expect(identityRow?.value).toBeUndefined();
    expect(identityRow?.muted).toBe(UNNAMED_PARTY_LABEL);
  });

  test("the inviter's terms render from its own perspective", () => {
    const rows = linkageTermsRows(record("inviter").exchangeFile);
    expect(rows.find((row) => row.label === "Your identity")?.value).toBe(
      "County Health Dept",
    );
    for (const row of rows)
      expect(
        row.value !== undefined ||
          row.values !== undefined ||
          row.muted !== undefined,
      ).toBe(true);
  });

  test("the acceptor's terms render from its own mirrored perspective", () => {
    const inviter = linkageTermsRows(record("inviter").exchangeFile);
    const acceptor = linkageTermsRows(record("acceptor").exchangeFile);
    // Both sides render the same row set (the document shape is symmetric); the
    // config view is derivable for either side.
    expect(acceptor.map((row) => row.label)).toEqual(
      inviter.map((row) => row.label),
    );
  });
});

describe("SIDE_LABELS", () => {
  test("names both sides plainly", () => {
    expect(SIDE_LABELS.inviter).toContain("inviter");
    expect(SIDE_LABELS.acceptor).toContain("acceptor");
  });
});

describe("runHistoryEntries renders around the most recent run", () => {
  test("a never-run exchange has no entries", () => {
    expect(runHistoryEntries(record("inviter"))).toEqual([]);
  });

  test("a succeeded run discloses the agreed terms and names the record file", () => {
    const lastRun: ManagedExchangeLastRun = {
      at: "2026-07-01T09:00:00.000Z",
      outcome: "succeeded",
    };
    const entries = runHistoryEntries(record("inviter", { lastRun }));
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe("Succeeded");
    expect(entries[0].disclosure).toContain("agreed terms");
    // No fabricated count or match result -- the bookkeeping has none.
    expect(entries[0].disclosure).not.toMatch(/\d+ (rows|matches|records)/);
  });

  // The disclosure line is mapped conservatively from where a failure fires in the
  // run lifecycle (input guard -> handshake -> rotation persist -> data exchange). A
  // run that provably stopped before any data left this party asserts nothing was
  // disclosed; a run that failed after the handshake, where the record cannot prove
  // whether payload reached the partner, must not assert either way.
  test.each([
    { outcome: "missed" as const, label: "Partner did not arrive" },
    { outcome: "desynced" as const, label: "Out of sync" },
    {
      outcome: "failed" as const,
      failureKind: "input" as const,
      label: "Failed",
    },
    {
      outcome: "failed" as const,
      failureKind: "terms-shortfall" as const,
      label: "Failed",
    },
    {
      outcome: "failed" as const,
      failureKind: "consent" as const,
      label: "Failed",
    },
    {
      outcome: "failed" as const,
      failureKind: "auth" as const,
      label: "Failed",
    },
    {
      outcome: "failed" as const,
      failureKind: "storage" as const,
      label: "Failed",
    },
  ])(
    "a run that stopped before the data exchange ($outcome/$failureKind) asserts nothing was disclosed",
    ({ outcome, failureKind, label }) => {
      const lastRun: ManagedExchangeLastRun = {
        at: "2026-07-01T09:00:00.000Z",
        outcome,
        ...(failureKind !== undefined ? { failureKind } : {}),
      };
      const entries = runHistoryEntries(record("acceptor", { lastRun }));
      expect(entries[0].outcome).toBe(label);
      expect(entries[0].disclosure).toContain(
        "Nothing was disclosed -- the run stopped before any data was exchanged.",
      );
    },
  );

  // A failure that can postdate the handshake -- a data-exchange drop (transport), a
  // teardown that can land mid-exchange (cancelled), or an unrecorded kind -- cannot
  // prove nothing was disclosed, so the line asserts neither way and points at the
  // record file as the authoritative account.
  test.each([
    { failureKind: "transport" as const },
    { failureKind: "cancelled" as const },
    { failureKind: undefined },
  ])(
    "a run that failed after the handshake ($failureKind) does not assert either way",
    ({ failureKind }) => {
      const lastRun: ManagedExchangeLastRun = {
        at: "2026-07-01T09:00:00.000Z",
        outcome: "failed",
        ...(failureKind !== undefined ? { failureKind } : {}),
      };
      const entries = runHistoryEntries(record("acceptor", { lastRun }));
      expect(entries[0].disclosure).not.toContain("Nothing was disclosed");
      expect(entries[0].disclosure).toContain("did not complete");
      expect(entries[0].disclosure).toContain("authoritative account");
    },
  );
});

// What the accounting view reads to keep an empty accounting accurate: an accounting
// holding nothing is not evidence that nothing has completed, since the reset
// destroys the entries and leaves the record standing.
describe("completedRunRecorded reads the record's own bookkeeping", () => {
  test("a never-run exchange records no completed run", () => {
    expect(completedRunRecorded(record("inviter"))).toBe(false);
  });

  test("a succeeded run is a completed one", () => {
    const lastRun: ManagedExchangeLastRun = {
      at: "2026-07-01T09:00:00.000Z",
      outcome: "succeeded",
    };
    expect(completedRunRecorded(record("inviter", { lastRun }))).toBe(true);
  });

  // One-way: the record keeps only the most recent run, so a completed run
  // followed by a non-completing one is treated as false. The copy this
  // drives is written to that -- the completed-run reading appears only
  // where the record proves it, and the plain empty state stands everywhere
  // else.
  test.each([
    { outcome: "failed" as const, failureKind: "transport" as const },
    { outcome: "missed" as const, failureKind: undefined },
    { outcome: "desynced" as const, failureKind: undefined },
  ])(
    "a $outcome most-recent run records no completed run",
    ({ outcome, failureKind }) => {
      const lastRun: ManagedExchangeLastRun = {
        at: "2026-07-01T09:00:00.000Z",
        outcome,
        ...(failureKind !== undefined ? { failureKind } : {}),
      };
      expect(completedRunRecorded(record("acceptor", { lastRun }))).toBe(false);
    },
  );
});

// The detail view's read-only run-schedule section: the cadence, where the
// recurrence stands at the instant read, and the states this runtime owes the
// operator accurately around it -- including whether an unattended run happens here
// at all, which is a different fact in an installed app and in an ordinary tab.
describe("scheduleView", () => {
  const NOW = Date.parse("2026-07-14T12:00:00.000Z");

  /** A daily cadence whose window opened an hour before NOW and closes two hours
   * after it, so NOW sits inside a window. */
  const daily: ManagedExchangeSchedule = {
    anchor: "2026-07-14T11:00:00.000Z",
    intervalDays: 1,
    windowSeconds: 10_800,
    nextWindow: "2026-07-14T11:00:00.000Z",
    consecutiveMisses: 0,
  };

  test("a record with no agreed schedule has no section at all", () => {
    // An attended-only exchange, which is what an operator who entered no cadence
    // has; the entry form beside this section is where one is set, so an empty
    // state here would duplicate it.
    expect(scheduleView(record("inviter"), true, false, NOW)).toBeUndefined();
  });

  test("the section names the cadence and where the recurrence stands", () => {
    const view = scheduleView(
      record("inviter", { schedule: daily }),
      true,
      false,
      NOW,
    );
    expect(view?.cadence).toBe(
      "A run window opens every day and stays open 3 hours.",
    );
    expect(view?.dueLine).toMatch(/^Run window open now, until /);
  });

  test("an ordinary tab's note promises no run while this browser is closed", () => {
    const view = scheduleView(
      record("inviter", { schedule: daily }),
      true,
      false,
      NOW,
    );
    expect(view?.attendanceNote).toMatch(/passes without a run/i);
    expect(view?.attendanceNote).toMatch(
      /never runs this exchange on its own/i,
    );
  });

  test("an installed runtime's note says this app meets the windows itself", () => {
    // The runner starts only in an installed runtime, so the accurate copy differs
    // by which one the operator is looking at rather than hedging across both.
    const view = scheduleView(
      record("inviter", { schedule: daily }),
      true,
      true,
      NOW,
    );
    expect(view?.attendanceNote).toMatch(/installed/i);
    expect(view?.attendanceNote).toMatch(/nobody present/i);
  });

  test("holding a usable input handle raises no re-selection note", () => {
    expect(
      scheduleView(record("inviter", { schedule: daily }), true, false, NOW)
        ?.inputReselectionNote,
    ).toBeUndefined();
  });

  test("holding no input handle states that nothing can run with nobody present", () => {
    const view = scheduleView(
      record("inviter", { schedule: daily }),
      false,
      false,
      NOW,
    );
    expect(view?.inputReselectionNote).toMatch(/nobody present/i);
    // It points at the attended path -- choosing the file at the run itself --
    // rather than at a re-pointing control this surface does not have.
    expect(view?.inputReselectionNote).toMatch(/choose it here when you run/i);
  });

  test("an installed runtime holding no input handle still states the standing bar", () => {
    // The two readings compose rather than replacing each other: an installed app
    // meets the windows, and a record it cannot read the input for is one it
    // cannot meet them for.
    const view = scheduleView(
      record("inviter", { schedule: daily }),
      false,
      true,
      NOW,
    );
    expect(view?.attendanceNote).toMatch(/installed/i);
    expect(view?.inputReselectionNote).toMatch(/nobody present/i);
  });

  test("a lapsed stored secret keeps the schedule section standing", () => {
    // The lapse and the schedule compose: a re-invite recovers the secret and the
    // partnership goes on meeting at the cadence it agreed, so the section states
    // where that cadence stands rather than disappearing with the secret.
    const lapsed = record("inviter", {
      schedule: daily,
      expires: "2026-07-01T00:00:00.000Z",
    });
    expect(managedExchangeLapsed(lapsed, NOW)).toBe(true);
    const view = scheduleView(lapsed, true, false, NOW);
    expect(view?.dueLine).toMatch(/^Run window open now, until /);
    expect(view?.cadence).toMatch(/^A run window opens every day/);
  });

  test("one miss raises no prompt; the second raises the coordination prompt", () => {
    const once = scheduleView(
      record("inviter", { schedule: { ...daily, consecutiveMisses: 1 } }),
      true,
      false,
      NOW,
    );
    expect(once?.coordination).toBeUndefined();

    const twice = scheduleView(
      record("inviter", { schedule: { ...daily, consecutiveMisses: 2 } }),
      true,
      false,
      NOW,
    );
    expect(twice?.coordination?.misses).toBe(2);
    // Both checks, and no pause taken on the operator's behalf.
    expect(twice?.coordination?.prompt).toMatch(/partner/i);
    expect(twice?.coordination?.prompt).toMatch(/this device's clock/i);
    expect(twice?.coordination?.prompt).toMatch(/the schedule stands/i);
  });
});
