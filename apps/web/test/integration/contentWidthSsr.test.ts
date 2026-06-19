import { describe, expect, test } from "vitest";

// The content-width seam exercised end to end through the real router, at the
// SSR boundary: a route declares its width in staticData, the root route
// resolves it (useMatches -> resolveContentWidth), and the shell sizes both its
// header chrome and the content container to that one value. The unit test
// covers the resolver and the browser test covers the shell with a mocked
// router; only this test drives the real router -> RootComponent -> staticData
// -> shell path. It needs no browser: the shell is server-rendered, so the
// declared width is already in the HTML. The accept route is ssr:false for its
// component, but the shell still server-renders, so its width appears too.
//
// The port matches the dev-server globalSetup, which derives it the same way.
const port = parseInt(process.env.PORT ?? "3000", 10);
const base = `http://127.0.0.1:${port}`;

// Each Mantine Container the shell renders carries an inline --container-size;
// pull every value out of the server-rendered HTML.
function containerWidths(html: string): Array<string> {
  return [...html.matchAll(/--container-size:\s*([^;"}]+)/g)].map((match) =>
    match[1].trim(),
  );
}

// The rem magnitude inside a value (e.g. "calc(87.5rem * ...)" -> 87.5), so two
// named widths compare without pinning the exact pixel scale.
function remMagnitude(value: string): number {
  const match = value.match(/([\d.]+)rem/);
  if (match === null) throw new Error(`no rem magnitude in "${value}"`);
  return Number(match[1]);
}

async function shellContainerWidths(path: string): Promise<Array<string>> {
  const response = await fetch(`${base}${path}`);
  expect(response.status).toBe(200);
  return containerWidths(await response.text());
}

describe("content width seam (SSR, real router)", () => {
  test("chrome and content render at the route's one declared width", async () => {
    const home = await shellContainerWidths("/");
    const accept = await shellContainerWidths("/accept");

    // The header chrome and the content container, both server-rendered.
    expect(home.length).toBeGreaterThanOrEqual(2);
    expect(accept.length).toBeGreaterThanOrEqual(2);

    // Within a route every container resolves to one shared width, so the chrome
    // and content edges align.
    expect(new Set(home).size).toBe(1);
    expect(new Set(accept).size).toBe(1);

    // The seam is per-route, not a fixed width: the accept route opts into the
    // widest named width so its dense linkage terms stay legible -- wider than the
    // home page, which keeps the default. (This is what keeps the seam exercised
    // by a real route: a route declaring a non-default width.)
    expect(remMagnitude(accept[0])).toBeGreaterThan(remMagnitude(home[0]));
  });
});
