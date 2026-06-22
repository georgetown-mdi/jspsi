import { describe, expect, test } from "vitest";

import {
  securityResponseHeaders,
  withSecurityHeaders,
} from "@utils/securityHeaders";

// withSecurityHeaders is the seam the server entry (src/server.ts) wraps every
// response in. The integration suite proves it reaches the wire on real routes;
// these cover the helper in isolation, including the cases a same-process mutate
// would mishandle.
describe("withSecurityHeaders", () => {
  test("sets every declared security header to its value", () => {
    const hardened = withSecurityHeaders(new Response("ok"));
    for (const [name, value] of Object.entries(securityResponseHeaders)) {
      expect(hardened.headers.get(name)).toBe(value);
    }
  });

  test("denies framing and suppresses the referrer", () => {
    const hardened = withSecurityHeaders(new Response("ok"));
    expect(hardened.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(hardened.headers.get("X-Frame-Options")).toBe("DENY");
    expect(hardened.headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors 'none'",
    );
  });

  test("preserves status, statusText, body, and existing headers", async () => {
    const source = new Response("payload", {
      status: 201,
      statusText: "Created",
      headers: { "Content-Type": "text/plain", "X-Custom": "keep" },
    });
    const hardened = withSecurityHeaders(source);
    expect(hardened.status).toBe(201);
    expect(hardened.statusText).toBe("Created");
    expect(hardened.headers.get("X-Custom")).toBe("keep");
    expect(hardened.headers.get("Content-Type")).toBe("text/plain");
    expect(await hardened.text()).toBe("payload");
  });

  test("applies to an immutable redirect response without throwing", () => {
    // Response.redirect yields a response whose headers are immutable: setting a
    // header in place throws. The rebuild path must still carry the headers and
    // keep the redirect's status and Location.
    const redirect = Response.redirect("https://example.test/elsewhere", 302);
    const hardened = withSecurityHeaders(redirect);
    expect(hardened.status).toBe(302);
    expect(hardened.headers.get("Location")).toBe(
      "https://example.test/elsewhere",
    );
    expect(hardened.headers.get("X-Frame-Options")).toBe("DENY");
  });
});
