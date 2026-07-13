/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

// Load Mantine's stylesheet so components render with their real
// geometry: without it the Stepper's completed-step icon has no size
// bound and blankets the top bar, intercepting unrelated clicks.
import "@mantine/core/styles.css";

import { MantineProvider } from "@mantine/core";

import { encodeInvitation, generateSharedSecret } from "@psilink/core";

import { deepLinkFor, tokenFromInput } from "@psi/invitation";
import { AcceptorBench } from "@bench/AcceptorBench";

import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

import type { InvitationToken, LinkageTerms } from "@psilink/core";

// The router seam AcceptorBench touches. It reads the token from
// window.location.hash and links home; a plain-anchor Link is all this test
// exercises (a real RouterProvider trips a duplicate-React dispatcher error under
// the browser runner, the reason the bench browser suite stubs the router too).
vi.mock("@tanstack/react-router", () => ({
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

// AcceptorBench transitively imports the rendezvous/lifecycle modules, whose
// top-level config load reads `process` (absent in the browser runner). This test
// never launches an exchange (it stops at the decoded review screen), so stub both
// so the modules load without evaluating that config -- the benchAccept.test.ts
// pattern.
vi.mock("@psi/rendezvous", () => ({
  dialAsAcceptor: vi.fn(),
  listenAsInviter: vi.fn(),
}));
vi.mock("@psi/exchangeLifecycle", () => ({
  runExchangeLifecycle: () => Promise.resolve(),
}));

const terms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "lastName", type: "last_name" }],
  linkageKeys: [{ name: "last", elements: [{ field: "lastName" }] }],
};

async function mintInvitation(): Promise<string> {
  const token: InvitationToken = {
    version: "1",
    linkageTerms: terms,
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

function mount(content: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(createElement(MantineProvider, null, content));
}

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  window.location.hash = "";
  vi.restoreAllMocks();
});

// The cutover collapsed the acceptor onto the primary /accept route (ssr: false),
// the path the inviter's deep link points at (ACCEPT_ROUTE_PATH). This pins the
// end-to-end landing: a real minted deep link's fragment, extracted the way a
// pasted link is (tokenFromInput), decodes on the AcceptorBench the /accept route
// mounts. The fragment is the only carrier of the token, so this also proves the
// fragment survives from the minted link to the acceptor's decode.
describe("deep-link landing on the bench acceptor", () => {
  test("a minted deep link's fragment decodes on the acceptor screen", async () => {
    const encoded = await mintInvitation();
    // Build the deep link the inviter shares, then take its fragment exactly as
    // the acceptor peels a pasted link -- the path+fragment contract the /accept
    // route and the redirect both preserve.
    const deepLink = deepLinkFor("https://example.test", encoded);
    expect(deepLink).toBe(`https://example.test/accept#${encoded}`);
    const token = tokenFromInput(deepLink);
    expect(token).toBe(encoded);

    // The /accept route runs client-side and mounts AcceptorBench, which reads the
    // token from the fragment. Set the fragment and mount the same component.
    window.location.hash = token;
    mount(createElement(AcceptorBench));

    // The decoded terms render: the inviter identity heading proves the token rode
    // the fragment through to a successful decode, not a "cannot accept" error.
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();
  });

  test("the fragment is never placed in a query string by the deep link", async () => {
    // The confidential token must ride the fragment, never a query parameter (a
    // query reaches the server and access logs). Guard the mint side of that
    // invariant directly.
    const encoded = await mintInvitation();
    const deepLink = deepLinkFor("https://example.test", encoded);
    const url = new URL(deepLink);
    expect(url.hash).toBe(`#${encoded}`);
    expect(url.search).toBe("");
    expect(url.pathname).toBe("/accept");
  });
});
