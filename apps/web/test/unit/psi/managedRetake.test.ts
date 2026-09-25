import { describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import { composeManagedCronExport } from "@psi/managed/managedCronExport";
import { decideRetake } from "@psi/managed/managedPairRecognition";
import { retakeManagedExchange } from "@psi/managed/managedRetake";

import type {
  ManagedExchangeSide,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type { ManagedRetakeDeps } from "@psi/managed/managedRetake";
import type { ManagedRetakeOutcome } from "@psi/managed/managedExchangeStore";

// The take-back's file half: it reads the command-line run's alcove.yaml with
// the .alcove.key beside it, a pair it will not take never reaches the store,
// and a pair on other terms or the other side is refused by the store step's
// check. The store step itself -- the locked cross-store transaction, its
// refusal of a pair on other terms or the other side included -- runs against
// real IndexedDB in test/browser/managedExchangeBackup.test.ts, and a pair
// import taken into a hand-off in
// test/browser/managedCommandLinePairImport.test.ts.

const at = "2026-09-01T09:00:00.000Z";

function handedOffRecord(
  side: ManagedExchangeSide = "inviter",
  identity = "County Health Dept",
): RunnableManagedExchangeRecord {
  return runnableManagedExchangeOrRefuse(
    buildManagedExchangeRecord({
      label: "Riverbend quarterly",
      exchangeFile: composeManagedExchangeFile({
        connection: { channel: "webrtc", host: "signaling.example.org" },
        linkageTerms: getDefaultLinkageTerms(identity),
      }),
      side,
      sharedSecret: generateSharedSecret(),
    }),
  );
}

/** The two files the command-line export writes for `record`. */
function filesOf(record: RunnableManagedExchangeRecord): {
  configuration: string;
  key: string;
} {
  const exported = composeManagedCronExport(record);
  return { configuration: exported.config.text, key: exported.key.text };
}

function deps(
  outcome: ManagedRetakeOutcome = { kind: "not-handed-off" },
): ManagedRetakeDeps & { retake: ReturnType<typeof vi.fn> } {
  return {
    retake: vi.fn().mockResolvedValue(outcome),
    now: () => new Date(at),
  };
}

/** A store step deciding on `stored` as the real one does inside its
 * transaction ({@link decideRetake}). */
function storeHolding(
  stored: RunnableManagedExchangeRecord,
): ManagedRetakeDeps {
  return {
    retake: (_id, _at, taken) => {
      const decided = decideRetake(stored, taken);
      return Promise.resolve(
        decided.kind === "mismatch"
          ? decided
          : { kind: "retaken", record: decided.record },
      );
    },
    now: () => new Date(at),
  };
}

describe("files the take-back will not read", () => {
  test("are reported, and the store is never reached", async () => {
    const { configuration } = filesOf(handedOffRecord());
    for (const files of [
      { configuration, key: "not json at all" },
      { configuration: "not: [a configuration", key: "{}" },
    ]) {
      const boundaries = deps();
      await expect(
        retakeManagedExchange("exchange-1", files, boundaries),
      ).resolves.toEqual({ kind: "unreadable-files" });
      expect(boundaries.retake).not.toHaveBeenCalled();
    }
  });
});

describe("a take-back the store accepts", () => {
  test("passes the pair read from both files through, and none where no file was chosen", async () => {
    // No files is the case the operator attests "no run happened since the
    // hand-off": the stored secret is still the partnership's, so the store is
    // asked to clear the spent state and change nothing else.
    const onTheCommandLine = handedOffRecord();
    const boundaries = deps();
    await retakeManagedExchange(
      "exchange-1",
      filesOf(onTheCommandLine),
      boundaries,
    );
    expect(boundaries.retake).toHaveBeenCalledWith(
      "exchange-1",
      at,
      expect.objectContaining({
        sharedSecret: onTheCommandLine.sharedSecret,
        side: onTheCommandLine.side,
        exchangeFile: onTheCommandLine.exchangeFile,
      }),
    );

    const withoutFiles = deps();
    await retakeManagedExchange("exchange-1", undefined, withoutFiles);
    expect(withoutFiles.retake).toHaveBeenCalledWith(
      "exchange-1",
      at,
      undefined,
    );
  });

  test("reports the store's own outcome unchanged", async () => {
    for (const outcome of [
      { kind: "run-in-flight" },
      { kind: "gone" },
      { kind: "not-handed-off" },
      { kind: "mismatch", on: "terms" },
    ] as const)
      await expect(
        retakeManagedExchange("exchange-1", undefined, deps(outcome)),
      ).resolves.toEqual(outcome);
  });
});

describe("the pair is checked against the handed-off record", () => {
  test("the record's own pair after a run there is taken back with its secret", async () => {
    const stored = handedOffRecord();
    const rotated = { ...stored, sharedSecret: generateSharedSecret() };

    const result = await retakeManagedExchange(
      stored.id,
      filesOf(rotated),
      storeHolding(stored),
    );

    expect(result.kind).toBe("retaken");
    if (result.kind === "retaken")
      expect(result.record.sharedSecret).toBe(rotated.sharedSecret);
  });

  test("the partner's pair, on the other side, is refused", async () => {
    const stored = handedOffRecord("inviter");
    const partners = handedOffRecord("acceptor");

    await expect(
      retakeManagedExchange(stored.id, filesOf(partners), storeHolding(stored)),
    ).resolves.toEqual({ kind: "mismatch", on: "side" });
  });

  test("another exchange's pair, on other terms, is refused", async () => {
    const stored = handedOffRecord();
    const other = handedOffRecord("inviter", "Another Dept");
    const otherTerms = {
      ...other,
      exchangeFile: {
        ...other.exchangeFile,
        linkageTerms: {
          ...other.exchangeFile.linkageTerms,
          linkageKeys: other.exchangeFile.linkageTerms.linkageKeys.slice(1),
        },
      },
    };

    await expect(
      retakeManagedExchange(
        stored.id,
        filesOf(otherTerms),
        storeHolding(stored),
      ),
    ).resolves.toEqual({ kind: "mismatch", on: "terms" });
  });
});
