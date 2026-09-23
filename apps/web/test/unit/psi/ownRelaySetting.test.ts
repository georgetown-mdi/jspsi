import { afterEach, describe, expect, test, vi } from "vitest";

import {
  MAX_RELAY_URLS,
  parseRelayUrlLines,
  readOwnRelaySetting,
  relayForRun,
  writeOwnRelaySetting,
} from "@psi/transport/ownRelaySetting";

import type { RelayLocator } from "@psi/transport/rendezvous";

const STORAGE_KEY = "psilink-own-relay";

/** A localStorage stand-in over a Map, returned so a test reads what was
 * written. */
function stubStorage(): Map<string, string> {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  });
  return values;
}

const OWN: RelayLocator = {
  turn: ["turns:relay.example.org:443?transport=tcp"],
  stun: ["stun:stun.example.org:3478"],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the stored own relay", () => {
  test("reads back what was written", () => {
    stubStorage();
    writeOwnRelaySetting(OWN);
    expect(readOwnRelaySetting()).toEqual({ kind: "set", relay: OWN });
  });

  test("stores the urls and nothing else", () => {
    const values = stubStorage();
    writeOwnRelaySetting(OWN);
    expect(JSON.parse(values.get(STORAGE_KEY) ?? "")).toStrictEqual({
      version: 1,
      turn: OWN.turn,
      stun: OWN.stun,
    });
  });

  test("a stored value holding a credential is refused", () => {
    const values = stubStorage();
    values.set(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        turn: OWN.turn,
        stun: [],
        credential: "not-a-real-credential",
      }),
    );
    expect(readOwnRelaySetting()).toEqual({ kind: "unreadable" });
  });

  test("a stored url outside the grammar is refused", () => {
    const values = stubStorage();
    values.set(
      STORAGE_KEY,
      JSON.stringify({ version: 1, turn: ["turn:"], stun: [] }),
    );
    expect(readOwnRelaySetting()).toEqual({ kind: "unreadable" });
  });

  test("writing no url removes the setting", () => {
    const values = stubStorage();
    writeOwnRelaySetting(OWN);
    writeOwnRelaySetting({ turn: [], stun: [] });
    expect(values.has(STORAGE_KEY)).toBe(false);
    expect(readOwnRelaySetting()).toEqual({ kind: "none" });
  });

  test("a url outside the grammar is not written", () => {
    const values = stubStorage();
    expect(() =>
      writeOwnRelaySetting({
        turn: ["turns:relay.example.org:443?transport=udp"],
        stun: [],
      }),
    ).toThrow();
    expect(values.has(STORAGE_KEY)).toBe(false);
  });

  test("no storage reads as no relay", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(readOwnRelaySetting()).toEqual({ kind: "none" });
  });
});

describe("parseRelayUrlLines", () => {
  test("reads one url per line, skipping blank lines and trimming", () => {
    expect(
      parseRelayUrlLines(
        "  turns:relay.example.org:443?transport=tcp\n\nturn:relay.example.org:3478\n",
        "turn",
      ),
    ).toEqual({
      ok: true,
      urls: [
        "turns:relay.example.org:443?transport=tcp",
        "turn:relay.example.org:3478",
      ],
    });
  });

  test("names each refused line with the connection grammar's message", () => {
    const result = parseRelayUrlLines(
      "turn:relay.example.org:3478\nturn:\nstun:relay.example.org",
      "turn",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((problem) => problem.line)).toEqual([2, 3]);
    expect(result.problems[0].message).toMatch(/must name a host/);
  });

  test("holds a stun list to the stun grammar", () => {
    expect(parseRelayUrlLines("turn:relay.example.org", "stun").ok).toBe(false);
  });

  test("refuses more urls than a list holds", () => {
    const lines = Array.from(
      { length: MAX_RELAY_URLS + 1 },
      (_, index) => `stun:stun${index}.example.org`,
    ).join("\n");
    expect(parseRelayUrlLines(lines, "stun").ok).toBe(false);
  });
});

describe("relayForRun", () => {
  const invitation: RelayLocator = {
    turn: ["turns:partner-relay.example.org:443"],
    stun: [],
  };

  test("prefers the invitation's relay over the own setting", () => {
    const named: RelayLocator = {
      turn: ["turns:partner-relay.example.org:443"],
      stun: ["stun:partner-relay.example.org:3478"],
    };
    expect(relayForRun(named, () => ({ kind: "set", relay: OWN }))).toEqual(
      named,
    );
  });

  test("chooses per kind: a kind the invitation leaves unnamed is the own setting's", () => {
    expect(
      relayForRun(invitation, () => ({ kind: "set", relay: OWN })),
    ).toEqual({ turn: invitation.turn, stun: OWN.stun });
    expect(
      relayForRun({ stun: ["stun:partner-relay.example.org:3478"] }, () => ({
        kind: "set",
        relay: OWN,
      })),
    ).toEqual({
      turn: OWN.turn,
      stun: ["stun:partner-relay.example.org:3478"],
    });
  });

  test("uses the invitation's relay alone with no own setting", () => {
    expect(relayForRun(invitation, () => ({ kind: "none" }))).toEqual(
      invitation,
    );
    expect(relayForRun(invitation, () => ({ kind: "unreadable" }))).toEqual(
      invitation,
    );
  });

  test("falls back to the own setting", () => {
    expect(relayForRun(undefined, () => ({ kind: "set", relay: OWN }))).toEqual(
      OWN,
    );
  });

  test("is none with neither", () => {
    expect(relayForRun(undefined, () => ({ kind: "none" }))).toBeUndefined();
    expect(
      relayForRun(undefined, () => ({ kind: "unreadable" })),
    ).toBeUndefined();
  });
});
