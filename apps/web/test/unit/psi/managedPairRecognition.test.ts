import { describe, expect, test } from "vitest";

import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  decideCommandLinePairTarget,
  decideRetake,
  storedCopyState,
} from "@psi/managed/managedPairRecognition";

import type {
  ManagedExchangeRecord,
  ManagedExchangeSide,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type { ManagedSpentState } from "@psi/managed/managedLocalStateShape";
import type { ManagedStoredEntry } from "@psi/managed/managedPairRecognition";

// Where a command-line pair lands once no stored record refuses it by its
// secret, and what a re-take checks the pair it is given against. The store
// makes both decisions inside its transactions; the transactions themselves,
// against real IndexedDB, are the browser suite's.

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

function runnable(
  side: ManagedExchangeSide = "inviter",
  label = "Riverbend quarterly",
): RunnableManagedExchangeRecord {
  return runnableManagedExchangeOrRefuse(
    buildManagedExchangeRecord({
      label,
      exchangeFile: composeManagedExchangeFile({
        connection: { channel: "webrtc", host: "signaling.example.org" },
        linkageTerms,
      }),
      side,
      sharedSecret: generateSharedSecret(),
    }),
  );
}

/** A configuration-only record on the same terms: what an alcove.yaml
 * imported without its key file installs. */
function configurationOnly(
  side: ManagedExchangeSide = "inviter",
): ManagedExchangeRecord {
  const { sharedSecret: _secret, ...rest } = runnable(side, "");
  return rest;
}

/** `record` on other agreed terms. */
function onOtherTerms(record: ManagedExchangeRecord): ManagedExchangeRecord {
  return {
    ...record,
    exchangeFile: {
      ...record.exchangeFile,
      linkageTerms: {
        ...linkageTerms,
        linkageKeys: linkageTerms.linkageKeys.slice(1),
      },
    },
  };
}

const handedOff: ManagedSpentState = {
  spentAt: "2026-07-11T09:00:00.000Z",
  handoff: "command-line",
};
const migrated: ManagedSpentState = { spentAt: "2026-07-11T09:00:00.000Z" };

function entry(
  record: ManagedExchangeRecord,
  spent?: ManagedSpentState,
): ManagedStoredEntry {
  return { record, spent };
}

describe("which stored records a pair can land in", () => {
  test("a hand-off, a migration, and a configuration only; never a live record", () => {
    expect(storedCopyState(entry(runnable(), handedOff))).toBe("handed-off");
    expect(storedCopyState(entry(runnable(), migrated))).toBe(
      "migration-spent",
    );
    expect(storedCopyState(entry(configurationOnly()))).toBe(
      "configuration-only",
    );
    expect(storedCopyState(entry(runnable()))).toBeUndefined();
  });
});

describe("a pair whose secret no stored record holds", () => {
  test("names a hand-off with its terms and side, and writes nothing until answered", () => {
    const stored = runnable();
    const imported = runnable();

    expect(
      decideCommandLinePairTarget(
        [entry(stored, handedOff)],
        imported,
        undefined,
      ),
    ).toEqual({
      kind: "stored-copy",
      copies: [{ id: stored.id, label: stored.label, state: "handed-off" }],
    });
  });

  test("accepted, takes the pair into the hand-off through its re-take", () => {
    const stored = runnable();

    expect(
      decideCommandLinePairTarget(
        [entry(stored, handedOff)],
        runnable(),
        undefined,
        { into: stored.id },
      ),
    ).toEqual({ kind: "retake", id: stored.id });
  });

  test("declined, installs the pair as a new record", () => {
    const stored = runnable();

    expect(
      decideCommandLinePairTarget(
        [entry(stored, handedOff)],
        runnable(),
        undefined,
        { besideIds: [stored.id] },
      ),
    ).toEqual({ kind: "no-match" });
  });

  test("a configuration-only record with equal terms and side is offered, then completed in place", () => {
    const stored = configurationOnly();
    const imported = runnable();

    expect(
      decideCommandLinePairTarget([entry(stored)], imported, undefined),
    ).toEqual({
      kind: "stored-copy",
      copies: [{ id: stored.id, label: "", state: "configuration-only" }],
    });
    expect(
      decideCommandLinePairTarget([entry(stored)], imported, undefined, {
        into: stored.id,
      }),
    ).toEqual({ kind: "complete", into: stored });
  });

  test("a migration-spent record with equal terms and side is offered, then revived", () => {
    const stored = runnable();

    expect(
      decideCommandLinePairTarget(
        [entry(stored, migrated)],
        runnable(),
        undefined,
      ),
    ).toMatchObject({
      kind: "stored-copy",
      copies: [{ id: stored.id, state: "migration-spent" }],
    });
    expect(
      decideCommandLinePairTarget(
        [entry(stored, migrated)],
        runnable(),
        undefined,
        { into: stored.id },
      ),
    ).toEqual({ kind: "revive", into: stored });
  });

  test("unequal terms or side offer nothing, and the pair installs fresh", () => {
    const imported = runnable("inviter");
    for (const stored of [
      entry(runnable("acceptor"), handedOff),
      entry(onOtherTerms(runnable()), handedOff),
      entry(configurationOnly("acceptor")),
      entry(onOtherTerms(configurationOnly())),
      entry(runnable("acceptor"), migrated),
    ])
      expect(
        decideCommandLinePairTarget([stored], imported, undefined),
      ).toEqual({ kind: "no-match" });
  });

  test("a live record with equal terms and side is not offered", () => {
    expect(
      decideCommandLinePairTarget([entry(runnable())], runnable(), undefined),
    ).toEqual({ kind: "no-match" });
  });

  test("names every qualifying record, less those declined", () => {
    const first = runnable();
    const second = configurationOnly();
    const entries = [entry(first, handedOff), entry(second)];

    expect(
      decideCommandLinePairTarget(entries, runnable(), undefined),
    ).toMatchObject({
      kind: "stored-copy",
      copies: [{ id: first.id }, { id: second.id }],
    });
    expect(
      decideCommandLinePairTarget(entries, runnable(), undefined, {
        besideIds: [first.id],
      }),
    ).toMatchObject({ kind: "stored-copy", copies: [{ id: second.id }] });
  });

  test("a chosen record that no longer qualifies is refused rather than installed beside", () => {
    const stored = runnable();

    for (const entries of [
      [],
      [entry(stored)],
      [entry(runnable("acceptor"), handedOff)],
    ])
      expect(
        decideCommandLinePairTarget(entries, runnable(), undefined, {
          into: stored.id,
        }),
      ).toEqual({ kind: "chosen-copy-changed" });
  });
});

describe("a pair whose secret a migration-spent record holds", () => {
  test("revives it where the sides agree", () => {
    const stored = runnable("inviter");
    const imported = {
      ...runnable("inviter"),
      sharedSecret: stored.sharedSecret,
    };

    expect(decideCommandLinePairTarget([], imported, stored)).toEqual({
      kind: "revive",
      into: stored,
    });
  });

  test("refuses, naming the record, where the pair is the other side", () => {
    const stored = runnable("inviter");
    const partners = {
      ...runnable("acceptor"),
      sharedSecret: stored.sharedSecret,
    };

    expect(decideCommandLinePairTarget([], partners, stored)).toEqual({
      kind: "side-mismatch",
      label: stored.label,
    });
  });
});

describe("what a re-take checks and writes", () => {
  test("a pair on the other side or other terms is refused, applying nothing", () => {
    const stored = runnable("inviter");

    expect(decideRetake(stored, runnable("acceptor"))).toEqual({
      kind: "mismatch",
      on: "side",
    });
    expect(
      decideRetake(
        stored,
        runnableManagedExchangeOrRefuse(onOtherTerms(runnable("inviter"))),
      ),
    ).toEqual({ kind: "mismatch", on: "terms" });
  });

  test("the record's own pair applies its rotated secret and bound", () => {
    const stored = runnable();
    const taken = {
      ...runnable(),
      expires: "2026-12-31T00:00:00.000Z",
    };

    const decided = decideRetake(stored, taken);

    expect(decided).toMatchObject({ kind: "retake", advanced: true });
    if (decided.kind !== "retake") return;
    expect(decided.record.sharedSecret).toBe(taken.sharedSecret);
    expect(decided.record.expires).toBe(taken.expires);
    expect(decided.record.label).toBe(stored.label);
  });

  test("no pair, or one holding the stored secret, leaves the record as it was", () => {
    const stored = runnable();

    expect(decideRetake(stored, undefined)).toEqual({
      kind: "retake",
      record: stored,
      advanced: false,
    });
    expect(
      decideRetake(stored, {
        ...runnable(),
        sharedSecret: stored.sharedSecret,
      }),
    ).toEqual({ kind: "retake", record: stored, advanced: false });
  });
});
