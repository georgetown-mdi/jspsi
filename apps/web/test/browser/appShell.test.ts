/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import {
  encodeInvitation,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@psilink/core";

import { AcceptInvitation } from "@components/AcceptInvitation";
import { HomePage } from "@components/HomePage";
import { Shell } from "@components/Shell";

import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

import type { InvitationToken } from "@psilink/core";

// Stub the dialing exchange (it pulls in peerjs and the PSI WASM and sets up a
// rendezvous); this suite only renders the static shell and the routes' initial
// outline. Mirrors acceptConsentGate.test.ts -- vitest hoists vi.mock above the
// imports, so HomePage's InvitePanel and AcceptInvitation pick up the stub.
vi.mock("@components/Exchange", () => ({
  Exchange: () =>
    createElement("div", { "data-testid": "exchange-mounted" }, "exchange"),
}));

// Stub the router seams the shell and the home form touch (the shell's home link
// and the form's navigate). This suite asserts shell structure and the heading
// outline, not navigation, so rendering the routes directly with createRoot --
// the acceptConsentGate pattern -- is simpler and avoids a RouterProvider (which
// trips a duplicate-React dispatcher error under the browser runner).
vi.mock("@tanstack/react-router", () => ({
  // The only router seams the rendered graph touches: the shell's home link and
  // the home form's navigate. NotFound/DefaultCatchBoundary and the route files
  // (the other react-router importers) are not in this test's import graph.
  Link: ({
    to,
    className,
    children,
  }: {
    to?: string;
    className?: string;
    children?: ReactNode;
  }) =>
    createElement(
      "a",
      { href: typeof to === "string" ? to : "#", className },
      children,
    ),
  useNavigate: () => () => undefined,
}));

async function encodeAcceptToken(): Promise<string> {
  const token: InvitationToken = {
    version: "1",
    linkageTerms: getDefaultLinkageTerms("County Health Department"),
    sharedSecret: generateSharedSecret(),
    connectionEndpoint: {
      channel: "webrtc",
      host: "127.0.0.1",
      port: 3000,
      path: "/api/",
    },
  };
  return encodeInvitation(token);
}

let container: HTMLElement | undefined;
let root: Root | undefined;

// Mount a route's page inside the shell the same way the root route composes
// <Shell><Outlet /></Shell>, so the assertions exercise shell + page together.
function mountInShell(content: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    createElement(MantineProvider, null, createElement(Shell, null, content)),
  );
}

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  window.location.hash = "";
});

// The shell's structural guarantees, asserted on whichever route is mounted: a
// single banner header, footer, and <main> landmark, plus a skip link whose
// fragment resolves to that main landmark.
function expectShell() {
  expect(document.querySelectorAll("header").length).toBe(1);
  expect(document.querySelectorAll("footer").length).toBe(1);

  const mains = document.querySelectorAll("main");
  expect(mains.length).toBe(1);
  const main = mains[0];
  expect(main.id).toBe("main-content");

  const skip = skipLink();
  expect(skip).toBeTruthy();
  expect(skip?.getAttribute("href")).toBe(`#${main.id}`);
}

// The skip link located by its accessible name rather than by attribute, so the
// lookup stays unambiguous regardless of any other anchors a page renders.
function skipLink(): HTMLAnchorElement | undefined {
  return Array.from(document.querySelectorAll("a")).find(
    (anchor) => anchor.textContent === "Skip to content",
  );
}

describe("application shell", () => {
  test("home route renders inside the shell with one h1", async () => {
    mountInShell(createElement(HomePage));

    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Start a private data exchange");

    expectShell();
    expect(document.querySelectorAll("h1").length).toBe(1);
    // The page content rendered inside the main landmark, not beside it.
    expect(
      document.querySelector("main")?.contains(document.querySelector("h1")),
    ).toBe(true);
  });

  test("accept route renders inside the shell with one h1", async () => {
    window.location.hash = await encodeAcceptToken();
    mountInShell(createElement(AcceptInvitation));

    // The h1 is present immediately; wait for the decode to reveal the terms so
    // the full ready-state outline (the h1 plus the terms h2) is asserted.
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    expectShell();
    const h1s = document.querySelectorAll("h1");
    expect(h1s.length).toBe(1);
    expect(h1s[0].textContent).toBe("Accept an invitation");
  });

  test("skip link moves focus to main without clobbering the hash", async () => {
    // The accept route carries the invitation token in window.location.hash;
    // activating the skip link must move focus to the main landmark without
    // overwriting that fragment (which would break a reload or a copied link).
    window.location.hash = await encodeAcceptToken();
    mountInShell(createElement(AcceptInvitation));

    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    const hashBefore = window.location.hash;
    // Native click (not a Playwright click): the skip link sits off-screen until
    // focused, and a native dispatch still drives React's onClick, which
    // preventDefaults the fragment navigation.
    skipLink()?.click();

    expect(window.location.hash).toBe(hashBefore);
    expect(document.activeElement).toBe(
      document.getElementById("main-content"),
    );
  });
});
