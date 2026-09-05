import { describe, expect, test } from "vitest";

// Integration coverage for the backend-free rendezvous: these assert at the HTTP
// boundary that the PeerJS signaling server the dev server mounts answers with
// a usable peer id, while the former session-coordination backend (`/api/psi/*`)
// stays gone -- peers now find each other through ids derived from the invitation
// secret. This is Node env, so it checks the routes only, not a peer connection
// (PeerJS itself needs a browser).
//
// The port matches the dev-server globalSetup, which derives it the same way.
const port = parseInt(process.env.PORT ?? "3000", 10);
const base = `http://127.0.0.1:${port}`;

describe("the web server delivers code only: the signaling id route answers, the retired session-coordination routes still 404", () => {
  test("GET /api/peerjs/id returns a peer id", async () => {
    const response = await fetch(`${base}/api/peerjs/id`);
    expect(response.status).toBe(200);
    const id = await response.text();
    expect(id.length).toBeGreaterThan(0);
  });

  // Every former `/api/psi/*` session endpoint now has no route, so it 404s
  // rather than coordinating a rendezvous. The derived-id rendezvous replaces
  // them: peers find each other through ids derived from the invitation secret.
  test("POST /api/psi/create is gone", async () => {
    const response = await fetch(`${base}/api/psi/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initiatedName: "a", invitedName: "b" }),
    });
    expect(response.status).toBe(404);
  });

  test("POST /api/psi/join is gone", async () => {
    const response = await fetch(`${base}/api/psi/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uuid: "whatever" }),
    });
    expect(response.status).toBe(404);
  });

  test("GET /api/psi/:uuid is gone", async () => {
    const response = await fetch(
      `${base}/api/psi/00000000-0000-0000-0000-000000000000`,
    );
    expect(response.status).toBe(404);
  });

  test("GET /api/psi/:uuid/wait (the SSE stream) is gone", async () => {
    const response = await fetch(
      `${base}/api/psi/00000000-0000-0000-0000-000000000000/wait`,
    );
    expect(response.status).toBe(404);
  });
});
