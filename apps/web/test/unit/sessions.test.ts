import { afterEach, describe, expect, test } from "vitest";

import { useSessionManager } from "../../src/utils/sessions.js";

const TTL = () => new Date(Date.now() + 60_000);

const defaults = {
  initiatedName: "Alice",
  invitedName: "Bob",
  description: "unit test session",
};

describe("SessionManagerFactory", () => {
  const created: Array<string> = [];

  afterEach(async () => {
    const mgr = await useSessionManager();
    for (const uuid of created.splice(0)) {
      if (mgr.has({ uuid })) mgr.remove({ uuid });
    }
  });

  test("set() creates a session and returns it with a UUID", async () => {
    const mgr = await useSessionManager();
    const session = mgr.set({ ...defaults, timeToLive: TTL() });
    created.push(session.uuid);

    expect(session.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(session.initiatedName).toBe("Alice");
    expect(session.invitedName).toBe("Bob");
    expect(session.description).toBe("unit test session");
  });

  test("has() returns true for an existing session", async () => {
    const mgr = await useSessionManager();
    const { uuid } = mgr.set({ ...defaults, timeToLive: TTL() });
    created.push(uuid);

    expect(mgr.has({ uuid })).toBe(true);
  });

  test("has() returns false for an unknown UUID", async () => {
    const mgr = await useSessionManager();
    expect(mgr.has({ uuid: "00000000-0000-0000-0000-000000000000" })).toBe(
      false,
    );
  });

  test("get() returns the stored session", async () => {
    const mgr = await useSessionManager();
    const session = mgr.set({ ...defaults, timeToLive: TTL() });
    created.push(session.uuid);

    expect(mgr.get({ uuid: session.uuid })).toBe(session);
  });

  test("remove() deletes the session", async () => {
    const mgr = await useSessionManager();
    const { uuid } = mgr.set({ ...defaults, timeToLive: TTL() });

    mgr.remove({ uuid });

    expect(mgr.has({ uuid })).toBe(false);
  });

  test("set() throws when timeToLive is already in the past", async () => {
    const mgr = await useSessionManager();
    expect(() =>
      mgr.set({ ...defaults, timeToLive: new Date(Date.now() - 1) }),
    ).toThrow("cannot create session");
  });

  test("invitedPeerId can be mutated on the returned session object", async () => {
    const mgr = await useSessionManager();
    const session = mgr.set({ ...defaults, timeToLive: TTL() });
    created.push(session.uuid);

    expect(session.invitedPeerId).toBeUndefined();

    session.invitedPeerId = "peer-abc";

    expect(mgr.get({ uuid: session.uuid }).invitedPeerId).toBe("peer-abc");
  });

  test("session expires via timeout (short TTL)", async () => {
    const mgr = await useSessionManager();
    const { uuid } = mgr.set({
      ...defaults,
      timeToLive: new Date(Date.now() + 50),
    });

    expect(mgr.has({ uuid })).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(mgr.has({ uuid })).toBe(false);
  });
});
