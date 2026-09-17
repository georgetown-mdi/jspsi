import { describe, expect, test, vi } from "vitest";
import { generateSharedSecret } from "@psilink/core";

import {
  parseManagedKeyFile,
  retakeManagedExchange,
} from "@psi/managed/managedRetake";

import type { ManagedRetakeDeps } from "@psi/managed/managedRetake";
import type { ManagedRetakeOutcome } from "@psi/managed/managedExchangeStore";

// The take-back's file half: what it accepts as the command-line run's key file,
// and that a file it will not take never reaches the store. The store step itself
// (the locked cross-store transaction) is exercised against real IndexedDB in
// test/browser/managedExchangeBackup.test.ts.

const secret = generateSharedSecret();

function deps(
  outcome: ManagedRetakeOutcome = { kind: "not-handed-off" },
): ManagedRetakeDeps & { retake: ReturnType<typeof vi.fn> } {
  return { retake: vi.fn().mockResolvedValue(outcome) };
}

describe("the key file the take-back reads", () => {
  test("takes the pair the command-line export writes", () => {
    const expires = "2026-09-01T00:00:00.000Z";
    expect(
      parseManagedKeyFile(JSON.stringify({ sharedSecret: secret })),
    ).toEqual({ sharedSecret: secret });
    expect(
      parseManagedKeyFile(JSON.stringify({ sharedSecret: secret, expires })),
    ).toEqual({ sharedSecret: secret, expires });
  });

  test("refuses a pair holding anything else, rather than dropping it", () => {
    // Reader-rejects-unknown: a file holding a field this build does not know is
    // not a key file this build can act on, and installing the secret out of it
    // would silently discard whatever else it directed.
    expect(() =>
      parseManagedKeyFile(
        JSON.stringify({ sharedSecret: secret, signing: "elsewhere" }),
      ),
    ).toThrow();
    expect(() =>
      parseManagedKeyFile(JSON.stringify({ sharedSecret: "not-a-secret" })),
    ).toThrow();
  });

  test("names the file and nothing the parser read", () => {
    // The file's bytes are the secret, so a failure may name the file only (the
    // sensitive-parse chokepoint's rule), never a span of what it parsed.
    const bytes = `{"sharedSecret": "${secret}"`;
    expect(() => parseManagedKeyFile(bytes)).toThrow(
      /command-line key file could not be parsed as JSON/,
    );
    try {
      parseManagedKeyFile(bytes);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});

describe("a file the take-back will not read", () => {
  test("is reported, and the store is never reached", async () => {
    const boundaries = deps();
    await expect(
      retakeManagedExchange("exchange-1", "not json at all", boundaries),
    ).resolves.toEqual({ kind: "unreadable-key-file" });
    expect(boundaries.retake).not.toHaveBeenCalled();
  });
});

describe("a take-back the store accepts", () => {
  test("passes the parsed pair through, and no pair where no file was chosen", async () => {
    // No file is the case the ruling covers with "no run happened since the
    // hand-off": the stored secret is still the partnership's, so the store is
    // asked to clear the spent state and change nothing else.
    const expires = "2026-09-01T00:00:00.000Z";
    const boundaries = deps();
    await retakeManagedExchange(
      "exchange-1",
      JSON.stringify({ sharedSecret: secret, expires }),
      boundaries,
    );
    expect(boundaries.retake).toHaveBeenCalledWith("exchange-1", {
      sharedSecret: secret,
      expires,
    });

    const withoutFile = deps();
    await retakeManagedExchange("exchange-1", undefined, withoutFile);
    expect(withoutFile.retake).toHaveBeenCalledWith("exchange-1", undefined);
  });

  test("reports the store's own outcome unchanged", async () => {
    for (const outcome of [
      { kind: "run-in-flight" },
      { kind: "gone" },
      { kind: "not-handed-off" },
    ] as const)
      await expect(
        retakeManagedExchange("exchange-1", undefined, deps(outcome)),
      ).resolves.toEqual(outcome);
  });
});
