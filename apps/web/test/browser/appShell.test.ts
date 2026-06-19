/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { Container, MantineProvider } from "@mantine/core";

import {
  encodeInvitation,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@psilink/core";

import { AcceptInvitation } from "@components/AcceptInvitation";
import { HomePage } from "@components/HomePage";
import { Shell } from "@components/Shell";
import { mantineTheme } from "@theme";

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
// single banner header and <main> landmark, plus a skip link whose fragment
// resolves to that main landmark.
function expectShell() {
  expect(document.querySelectorAll("header").length).toBe(1);

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
    const main = document.getElementById("main-content");
    expect(document.activeElement).toBe(main);
    // The focused landing has a visible indicator (the .main:focus outline),
    // since main is otherwise outside the tab order.
    expect(main && getComputedStyle(main).outlineWidth).not.toBe("0px");
  });
});

// Mount under the real app theme so the Container size scale (CONTAINER_SIZES)
// resolves to its production widths, the way the running app does.
function mountThemed(node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(createElement(MantineProvider, { theme: mantineTheme }, node));
}

// The resolved width of a rendered Container: the --container-size custom
// property Mantine's theme derives from the named size. The authored inline
// value is read (not getComputedStyle), since this suite does not load Mantine's
// global stylesheet that defines the --mantine-scale the value multiplies by --
// without it the computed value is invalid/empty, but the inline value still
// distinguishes the named widths. Tracks the named scale, not a pixel snapshot.
function containerWidth(el: Element | null | undefined): string {
  const width =
    el instanceof HTMLElement
      ? el.style.getPropertyValue("--container-size").trim()
      : "";
  expect(width).not.toBe("");
  return width;
}

describe("content width seam", () => {
  // The header chrome and the route's content both size to the one width the
  // route declares, so their left/right edges align; a route choosing a
  // different width moves both together. The route-declaration -> resolved-width
  // half is covered in test/unit/contentWidth.test.ts.
  test.each(["lg", "xl"] as const)(
    "sizes chrome and content to the declared %s width",
    async (width) => {
      const other = width === "lg" ? "xl" : "lg";
      mountThemed(
        createElement(
          "div",
          null,
          createElement(Shell, {
            contentWidth: width,
            children: "page content",
          }),
          // Reference containers at each named size, so the assertion ties the
          // seam to the theme's named scale without hard-coding pixel widths.
          createElement(
            "div",
            { "data-testid": "ref-same" },
            createElement(Container, { size: width }),
          ),
          createElement(
            "div",
            { "data-testid": "ref-other" },
            createElement(Container, { size: other }),
          ),
        ),
      );

      // Wait for React to commit the mount before reading the rendered DOM.
      await expect.element(page.getByText("page content")).toBeInTheDocument();

      const header = containerWidth(
        document.querySelector("header")?.firstElementChild,
      );
      const main = containerWidth(
        document.querySelector("main")?.firstElementChild,
      );
      const sameSize = containerWidth(
        document.querySelector('[data-testid="ref-same"]')?.firstElementChild,
      );
      const otherSize = containerWidth(
        document.querySelector('[data-testid="ref-other"]')?.firstElementChild,
      );

      // Chrome and content resolve to one shared width: their edges align.
      expect(header).toBe(main);
      // ...and it is exactly the route's declared named size, not the other one.
      expect(main).toBe(sameSize);
      expect(sameSize).not.toBe(otherSize);
    },
  );
});
