import { describe, expect, test } from "vitest";

// These assert at the HTTP boundary that the defense-in-depth response headers reach
// the wire on both an SSR document route and an API route -- the two response kinds
// that flow through the server-entry chokepoint (src/server.ts). Values are pinned
// here as the observable contract, not imported from the source that sets them,
// since the integration project resolves no `@utils` alias and a black-box check
// should not read the value it verifies.
//
// The port matches the dev-server globalSetup, which derives it the same way.
const port = parseInt(process.env.PORT ?? "3000", 10);
const base = `http://127.0.0.1:${port}`;

const expectedHeaders: Record<string, string> = {
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
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
  test("an SSR document route includes them", async () => {
    await expectSecurityHeaders("/");
  });

  test("an API route includes them", async () => {
    await expectSecurityHeaders("/api/peerjs/id");
  });
});
