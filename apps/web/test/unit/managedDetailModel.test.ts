import { describe, expect, test } from "vitest";
import { getDefaultLinkageTerms } from "@psilink/core";

import {
  SIDE_LABELS,
  connectionRows,
  linkageTermsRows,
  runHistoryEntries,
} from "@bench/managedDetailModel";
import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
} from "@psi/managedExchangeRecord";

import type {
  ManagedExchangeLastRun,
  ManagedExchangeSide,
  NewManagedExchange,
} from "@psi/managedExchangeRecord";
import type { WebRTCExchangeLocator } from "@psilink/core";

// The pure derivation behind the managed exchange detail view, tested in Node: the
// read-only configuration rows (both sides), the run-history entries around the most
// recent run, and their honest disclosure/framing. The copy is the model's; the
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
    // No credential field is representable in the stored document, so none surfaces.
    const rendered = rows.map((row) => row.value).join(" ");
    expect(rendered).not.toContain("username");
    expect(rendered).not.toContain("key");
  });
});

describe("linkageTermsRows renders configuration for both sides", () => {
  test("the inviter's terms render from its own perspective", () => {
    const rows = linkageTermsRows(record("inviter").exchangeFile);
    expect(rows.find((row) => row.label === "Your identity")?.value).toBe(
      "County Health Dept",
    );
    // Every row carries either a value, a values list, or a muted empty state --
    // never a bare undefined.
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
    // No fabricated count or match result -- the bookkeeping carries none.
    expect(entries[0].disclosure).not.toMatch(/\d+ (rows|matches|records)/);
  });

  // The disclosure line is mapped conservatively from where a failure fires in the
  // run lifecycle (input guard -> handshake -> rotation persist -> data exchange). A
  // run that provably stopped before any data left this party asserts nothing was
  // disclosed; a run that failed after the handshake, where the record cannot prove
  // whether payload reached the partner, must not assert either way.
  test.each([
    { outcome: "missed" as const, label: "Missed window" },
    { outcome: "desynced" as const, label: "Out of sync" },
    {
      outcome: "failed" as const,
      failureKind: "input" as const,
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
