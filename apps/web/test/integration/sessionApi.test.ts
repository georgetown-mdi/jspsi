import { describe, expect, test } from "vitest";

import { EventSource } from "eventsource";

const HOST = "http://127.0.0.1:3000";

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface SessionBody {
  uuid: string;
  timeToLive: string;
}

interface SessionDetails extends SessionBody {
  initiatedName: string;
  invitedName: string;
  description: string;
  invitedPeerId?: string;
}

async function createSession(
  fields: Record<string, unknown> = {},
): Promise<Response> {
  return fetch(`${HOST}/api/psi/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      initiatedName: "Test Initiator",
      invitedName: "Test Invitee",
      description: "integration test",
      ...fields,
    }),
  });
}

async function createSessionOk(): Promise<SessionBody> {
  const response = await createSession();
  if (!response.ok)
    throw new Error(`createSession failed: ${response.status}`);
  return response.json() as Promise<SessionBody>;
}

async function postPeerId(uuid: string, peerId: string): Promise<Response> {
  return fetch(`${HOST}/api/psi/${uuid}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invitedPeerId: peerId }),
  });
}

// ─── POST /api/psi/create ────────────────────────────────────────────────────

describe("POST /api/psi/create", () => {
  test("returns a UUID and timeToLive on success", async () => {
    const response = await createSession();

    expect(response.status).toBe(200);
    const body = (await response.json()) as SessionBody;
    expect(body.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(new Date(body.timeToLive).getTime()).toBeGreaterThan(Date.now());
  });

  test("returns 400 when initiatedName is missing", async () => {
    const response = await createSession({ initiatedName: "" });
    expect(response.status).toBe(400);
  });

  test("returns 400 when invitedName is missing", async () => {
    const response = await createSession({ invitedName: "" });
    expect(response.status).toBe(400);
  });
});

// ─── GET /api/psi/:uuid ──────────────────────────────────────────────────────

describe("GET /api/psi/:uuid", () => {
  test("returns session details for a valid UUID", async () => {
    const { uuid } = await createSessionOk();

    const response = await fetch(`${HOST}/api/psi/${uuid}`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as SessionDetails;
    expect(body.uuid).toBe(uuid);
    expect(body.initiatedName).toBe("Test Initiator");
    expect(body.invitedName).toBe("Test Invitee");
    expect(body.description).toBe("integration test");
    expect(body.invitedPeerId).toBeUndefined();
  });

  test("returns 400 for an unknown UUID", async () => {
    const response = await fetch(
      `${HOST}/api/psi/00000000-0000-0000-0000-000000000000`,
    );
    expect(response.status).toBe(400);
  });
});

// ─── POST /api/psi/:uuid ─────────────────────────────────────────────────────

describe("POST /api/psi/:uuid", () => {
  test("sets invitedPeerId and returns 204", async () => {
    const { uuid } = await createSessionOk();

    const post = await postPeerId(uuid, "peer-xyz");
    expect(post.status).toBe(204);

    const session = (await fetch(`${HOST}/api/psi/${uuid}`).then((r) =>
      r.json(),
    )) as SessionDetails;
    expect(session.invitedPeerId).toBe("peer-xyz");
  });

  test("returns 400 for an unknown UUID", async () => {
    const response = await postPeerId(
      "00000000-0000-0000-0000-000000000000",
      "peer-xyz",
    );
    expect(response.status).toBe(400);
  });

  test("returns 400 when invitedPeerId is absent from body", async () => {
    const { uuid } = await createSessionOk();

    const response = await fetch(`${HOST}/api/psi/${uuid}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });
});

// ─── GET /api/psi/:uuid/wait ─────────────────────────────────────────────────

describe("GET /api/psi/:uuid/wait", () => {
  test("returns 400 for an unknown UUID", async () => {
    const response = await fetch(
      `${HOST}/api/psi/00000000-0000-0000-0000-000000000000/wait`,
    );
    expect(response.status).toBe(400);
  });

  test("delivers the peer ID via SSE once it is posted", async () => {
    const { uuid } = await createSessionOk();

    // Post the peer ID before connecting so the server's first poll delivers
    // it immediately without waiting for the 250 ms polling interval.
    await postPeerId(uuid, "peer-123");

    const message = await new Promise<string>((resolve, reject) => {
      const es = new EventSource(`${HOST}/api/psi/${uuid}/wait`);
      es.addEventListener("message", (e) => {
        es.close();
        resolve(e.data as string);
      });
      es.addEventListener("error", (e) => {
        es.close();
        reject(new Error("SSE connection error: " + JSON.stringify(e)));
      });
    });

    const parsed = JSON.parse(message) as { invitedPeerId: string };
    expect(parsed.invitedPeerId).toBe("peer-123");
  }, 5_000);

  test("delivers the peer ID posted after the SSE connection opens", async () => {
    const { uuid } = await createSessionOk();

    // Schedule the POST well after the test starts so the server's polling
    // loop is running before the peer ID becomes available. The eventsource
    // package does not fire `open` until data arrives, so we use a timer
    // rather than the `open` event to sequence the two requests.
    const timer = setTimeout(() => postPeerId(uuid, "peer-456"), 100);

    try {
      const message = await new Promise<string>((resolve, reject) => {
        const es = new EventSource(`${HOST}/api/psi/${uuid}/wait`);
        es.addEventListener("message", (e) => {
          es.close();
          resolve(e.data as string);
        });
        es.addEventListener("error", (e) => {
          es.close();
          reject(new Error("SSE connection error: " + JSON.stringify(e)));
        });
      });

      const parsed = JSON.parse(message) as { invitedPeerId: string };
      expect(parsed.invitedPeerId).toBe("peer-456");
    } finally {
      clearTimeout(timer);
    }
  }, 5_000);
});
