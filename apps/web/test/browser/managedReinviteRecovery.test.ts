/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  ManagedExchangeLockUnavailableError,
  withManagedExchangeLock,
} from "@psi/managed/managedExchangeLock";
import {
  ManagedReinviteWithheldError,
  clearManagedExchangeStandingCondition,
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
  persistManagedExchangeReinvite,
  recordManagedExchangeCompromiseResponse,
  recordManagedExchangeLastRun,
} from "@psi/managed/managedExchangeStore";
import {
  composeManagedExchangeFile,
  standingCompromiseResponse,
} from "@psi/managed/managedExchangeRecord";
import {
  getManagedLocalState,
  markManagedExchangeImported,
} from "@psi/managed/managedLocalState";
import { failedRun } from "@psi/managed/managedRunRotate";
import { managedRunFailureFromRecord } from "@recurring/managedRunLaunchModel";
import { reinviteManagedExchange } from "@psi/managed/managedReinviteDriver";

import type { NewManagedExchange } from "@psi/managed/managedExchangeRecord";
import type { WebRTCExchangeLocator } from "@psilink/core";

// The fast re-invite recovery, driven against the real store: a re-invite rotates the
// stored secret, drops the consumed failure bookkeeping, clears the restore markers,
// and hands back the rotated record -- so a post-re-invite run derives the rendezvous
// from the fresh secret, and neither the stale benign tier nor a false unexplained tier
// can show after the operator has recovered. Two states refuse the rotation: a standing
// compromise response, which only the operator's acknowledgement lifts, and a run
// holding the record's run+rotate lock, which ends with that run.

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
    // The record has a failed auth run and a standing import marker (a restore).
    await recordManagedExchangeLastRun(
      record.id,
      failedRun(Date.now(), "failed", "auth"),
      Date.now(),
    );
    await markManagedExchangeImported(record.id, new Date().toISOString());

    const rotated = await persistManagedExchangeReinvite(record.id, {
      sharedSecret: generateSharedSecret(),
      expires: null,
    });

    // The failure is consumed and the import marker cleared: the next read tiers as
    // "no failure to show", not the stale benign tier and not a false unexplained.
    expect(rotated.lastRun).toBeUndefined();
    const stored = await getManagedExchange(record.id);
    expect(stored?.lastRun).toBeUndefined();
    const local = await getManagedLocalState(record.id);
    expect(local?.imported).toBeUndefined();
    expect(
      managedRunFailureFromRecord(stored!, local, Date.now()),
    ).toBeUndefined();
  });

  test("a stale auth failure does not reappear as unexplained after re-invite", async () => {
    // Without clearing lastRun, this record -- an auth failure whose import marker the
    // rotation cleared -- would re-derive as the attack (unexplained) tier. It must not.
    const record = await createManagedExchange(newExchange());
    await recordManagedExchangeLastRun(
      record.id,
      failedRun(Date.now(), "failed", "auth"),
      Date.now(),
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

    // The returned record has the fresh secret -- the caller adopts it so any
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

describe("a re-invite while a compromise response stands", () => {
  /** Seed a record whose failed handshake the operator answered "something does
   * not add up", the state in which no fresh invitation may go out on this
   * channel. Returns the record's id. */
  async function answeredExchange(): Promise<string> {
    const record = await createManagedExchange(newExchange());
    const failedAt = Date.now() - 120_000;
    await recordManagedExchangeLastRun(
      record.id,
      failedRun(failedAt, "failed", "auth"),
      failedAt,
    );
    await recordManagedExchangeCompromiseResponse(
      record.id,
      new Date().toISOString(),
    );
    return record.id;
  }

  test("is refused on the stored record, which keeps its secret and its answer", async () => {
    // The refusal is decided inside the write's own transaction, so a page that
    // read the record before the answer was written cannot mint past it.
    const id = await answeredExchange();
    const before = await getManagedExchange(id);

    await expect(
      persistManagedExchangeReinvite(id, {
        sharedSecret: generateSharedSecret(),
        expires: null,
      }),
    ).rejects.toBeInstanceOf(ManagedReinviteWithheldError);

    const stored = await getManagedExchange(id);
    expect(stored?.sharedSecret).toBe(before?.sharedSecret);
    expect(stored?.standingCondition).toEqual(before?.standingCondition);
    expect(standingCompromiseResponse(stored!)).toBeDefined();
  });

  test("goes through once the acknowledgement has cleared the answer", async () => {
    // The ruled order: the clear-and-acknowledge settles the condition and the
    // answer with it, and the mint is on offer after that write and not before.
    const id = await answeredExchange();
    const stale = (await getManagedExchange(id))?.sharedSecret;

    await clearManagedExchangeStandingCondition(id);
    const rotated = await persistManagedExchangeReinvite(id, {
      sharedSecret: generateSharedSecret(),
      expires: null,
    });

    expect(rotated.sharedSecret).not.toBe(stale);
    const stored = await getManagedExchange(id);
    expect(stored?.sharedSecret).toBe(rotated.sharedSecret);
    expect(standingCompromiseResponse(stored!)).toBeUndefined();
  });
});

describe("a re-invite while a run holds the run+rotate lock", () => {
  test("is refused on the lock, leaving the secret the run is connecting on", async () => {
    // Neither rotation write compares against the secret it replaces, so a mint
    // landing beside the run's own rotation would discard one of the two. Excluded
    // on the lock, exactly as the hand-off spend and the re-take are.
    const record = await createManagedExchange(newExchange());
    let granted!: () => void;
    const holding = new Promise<void>((resolve) => {
      granted = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = withManagedExchangeLock(record.id, async () => {
      granted();
      await released;
    });
    await holding;

    try {
      await expect(
        persistManagedExchangeReinvite(record.id, {
          sharedSecret: generateSharedSecret(),
          expires: null,
        }),
      ).rejects.toBeInstanceOf(ManagedExchangeLockUnavailableError);
      expect((await getManagedExchange(record.id))?.sharedSecret).toBe(
        record.sharedSecret,
      );
    } finally {
      // Released even if the assertions throw, so a failing test cannot strand the
      // exclusive lock for the rest of the page's life.
      release();
      await run;
    }

    // The refusal consumed nothing: the same mint goes through once the lock is free.
    const rotated = await persistManagedExchangeReinvite(record.id, {
      sharedSecret: generateSharedSecret(),
      expires: null,
    });
    expect(rotated.sharedSecret).not.toBe(record.sharedSecret);
    expect((await getManagedExchange(record.id))?.sharedSecret).toBe(
      rotated.sharedSecret,
    );
  });
});
