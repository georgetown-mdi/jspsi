/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
  persistManagedExchangeReinvite,
  recordManagedExchangeLastRun,
} from "@psi/managedExchangeStore";
import {
  getManagedLocalState,
  markManagedExchangeImported,
} from "@psi/managedLocalState";
import { composeManagedExchangeFile } from "@psi/managedExchangeRecord";
import { failedRun } from "@psi/managedRunRotate";
import { managedRunFailureFromRecord } from "@bench/managedRunLaunchModel";
import { reinviteManagedExchange } from "@psi/managedReinviteDriver";

import type { NewManagedExchange } from "@psi/managedExchangeRecord";
import type { WebRTCExchangeLocator } from "@psilink/core";

// The fast re-invite recovery, driven against the real store: a re-invite rotates the
// stored secret, drops the consumed failure bookkeeping, clears the restore markers,
// and hands back the rotated record -- so a post-re-invite run derives the rendezvous
// from the fresh secret, and neither the stale benign tier nor a false unexplained tier
// can surface after the operator has recovered.

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

const webrtcLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
  path: "/api/",
};

function newExchange(
  overrides: Partial<NewManagedExchange> = {},
): NewManagedExchange {
  return {
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: webrtcLocator,
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  };
}

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  await clearManagedExchanges();
});

describe("persistManagedExchangeReinvite drops the consumed failure", () => {
  test("rotating clears lastRun and the import marker in one transaction", async () => {
    const record = await createManagedExchange(newExchange());
    // The record carries a failed auth run and a standing import marker (a restore).
    await recordManagedExchangeLastRun(
      record.id,
      failedRun(Date.now(), "failed", "auth"),
    );
    await markManagedExchangeImported(record.id, new Date().toISOString());

    const rotated = await persistManagedExchangeReinvite(record.id, {
      sharedSecret: generateSharedSecret(),
      expires: null,
    });

    // The failure is consumed and the import marker cleared: the next read tiers as
    // "no failure to surface", not the stale benign tier and not a false unexplained.
    expect(rotated.lastRun).toBeUndefined();
    const stored = await getManagedExchange(record.id);
    expect(stored?.lastRun).toBeUndefined();
    const local = await getManagedLocalState(record.id);
    expect(local?.imported).toBeUndefined();
    expect(
      managedRunFailureFromRecord(stored!, local, Date.now()),
    ).toBeUndefined();
  });

  test("a stale auth failure does not resurrect as unexplained after re-invite", async () => {
    // Without clearing lastRun, this record -- an auth failure whose import marker the
    // rotation cleared -- would re-derive as the attack (unexplained) tier. It must not.
    const record = await createManagedExchange(newExchange());
    await recordManagedExchangeLastRun(
      record.id,
      failedRun(Date.now(), "failed", "auth"),
    );

    await persistManagedExchangeReinvite(record.id, {
      sharedSecret: generateSharedSecret(),
      expires: null,
    });

    const stored = await getManagedExchange(record.id);
    const local = await getManagedLocalState(record.id);
    const failure = managedRunFailureFromRecord(stored!, local, Date.now());
    expect(failure).toBeUndefined();
  });
});

describe("reinviteManagedExchange rotates the stored secret and returns it", () => {
  test("a post-re-invite run reads the rotated secret, not the stale one", async () => {
    const record = await createManagedExchange(newExchange());
    const stale = record.sharedSecret;

    const result = await reinviteManagedExchange(record);

    // The returned record carries the fresh secret -- the caller adopts it so any
    // subsequent run derives the rendezvous from the rotated secret, matching the
    // fresh invitation the partner now holds.
    expect(result.record.sharedSecret).not.toBe(stale);
    expect(result.record.sharedSecret).toBe(result.reinvite.sharedSecret);
    // And the store holds exactly that rotated secret.
    const stored = await getManagedExchange(record.id);
    expect(stored?.sharedSecret).toBe(result.reinvite.sharedSecret);
    expect(stored?.sharedSecret).not.toBe(stale);
  });
});
