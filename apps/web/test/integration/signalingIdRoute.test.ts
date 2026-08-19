import { describe, expect, test } from "vitest";

// Integration coverage for the backend-free rendezvous: the dev-server
// globalSetup stands up the Vite/TanStack server, and this asserts at the HTTP
// boundary that the PeerJS signaling server it mounts answers with a usable peer
// id. Node env: PeerJS itself needs a browser (the live exchange lives in the
// browser project), so this checks the route, not a peer connection. Peers
// otherwise find each other through ids derived from the invitation secret, so
// this endpoint is the only session coordination the server performs.
//
// The port matches the dev-server globalSetup, which derives it the same way.
const port = parseInt(process.env.PORT ?? "3000", 10);
const base = `http://127.0.0.1:${port}`;

describe("PeerJS signaling server", () => {
  test("GET /api/peerjs/id returns a peer id", async () => {
    const response = await fetch(`${base}/api/peerjs/id`);
    expect(response.status).toBe(200);
    const id = await response.text();
    expect(id.length).toBeGreaterThan(0);
  });
});
