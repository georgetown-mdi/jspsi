import { describe, expect, test } from "vitest";

// The dev-server globalSetup stands up the Vite/TanStack server; these assert at
// the HTTP boundary that the defense-in-depth response headers reach the wire on
// both an SSR document route and an API route -- the two response kinds that flow
// through the server-entry chokepoint, not one page. The
// server entry (src/server.ts) is the single fetch chokepoint every response
// flows through in dev, preview, and the built Nitro server, so covering one of
// each route kind exercises the seam end to end. Values are pinned here as the
// observable contract rather than imported from the source the seam sets them
// from (the integration project resolves no `@utils` alias, and a black-box
// check should not read the value it verifies).
//
// The port matches the dev-server globalSetup, which derives it the same way.
const port = parseInt(process.env.PORT ?? "3000", 10);
const base = `http://127.0.0.1:${port}`;

const expectedHeaders: Record<string, string> = {
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
};

async function expectSecurityHeaders(path: string): Promise<void> {
  const response = await fetch(`${base}${path}`);
  // Release the socket: only the headers matter here.
  await response.body?.cancel();
  for (const [name, value] of Object.entries(expectedHeaders)) {
    expect(response.headers.get(name), `${name} on ${path}`).toBe(value);
  }
}

describe("security response headers (app-wide, at the HTTP boundary)", () => {
  test("an SSR document route carries them", async () => {
    await expectSecurityHeaders("/");
  });

  test("an API route carries them", async () => {
    await expectSecurityHeaders("/api/peerjs/id");
  });
});
