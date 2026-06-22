/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import { DefaultCatchBoundary } from "@components/DefaultCatchBoundary";
import { mantineTheme } from "@theme";

import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

// Stub the router seams DefaultCatchBoundary touches, the same pattern
// notFound.test.ts / appShell.test.ts use, since a real RouterProvider trips a
// duplicate-React dispatcher error under the browser runner. The mock surfaces:
//   - Link as a plain <a href={to}>, so the polymorphic `component={Link}` Home
//     button is exercised on the Mantine side (the `to` is forwarded as href);
//   - useRouter().invalidate as a spy, so the retry action's call is observable;
//   - rootRouteId plus a useMatch that runs the component's real `select` over a
//     test-controlled route id, so toggling `routerMock.matchedRouteId` drives
//     the isRoot branch (Home when root, Go back otherwise) through the same
//     comparison the component makes;
//   - ErrorComponent as a marker, since rendering the real one is out of scope.
// Hoisted so the vi.mock factory (lifted above all top-level declarations) can
// read it. `rootId` is shared between the mocked rootRouteId and the test bodies
// that flip `matchedRouteId` to it to take the root branch.
const routerMock = vi.hoisted(() => ({
  invalidate: vi.fn(),
  rootId: "__root__",
  // Default to a non-root match; root-branch tests set this to rootId.
  matchedRouteId: "/some-route",
}));

vi.mock("@tanstack/react-router", () => ({
  rootRouteId: routerMock.rootId,
  useRouter: () => ({ invalidate: routerMock.invalidate }),
  useMatch: ({ select }: { select: (state: { id: string }) => unknown }) =>
    select({ id: routerMock.matchedRouteId }),
  ErrorComponent: ({ error }: { error: unknown }) =>
    createElement(
      "div",
      { "data-testid": "error-component" },
      error instanceof Error ? error.message : String(error),
    ),
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
}));

let container: HTMLElement | undefined;
let root: Root | undefined;

// Mount under the real app theme, the way the running app composes it.
function mount(node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(createElement(MantineProvider, { theme: mantineTheme }, node));
}

// DefaultCatchBoundary takes ErrorComponentProps; it reads only `error`, but the
// type requires `reset`, so a no-op stands in for it.
function mountBoundary(error: Error = new Error("boom")) {
  mount(createElement(DefaultCatchBoundary, { error, reset: () => undefined }));
}

// DefaultCatchBoundary logs every caught error via console.error by design (out
// of scope here); silence that expected noise so the suite output stays clean.
// Restored by vi.restoreAllMocks() in afterEach.
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  routerMock.matchedRouteId = "/some-route";
  vi.restoreAllMocks();
  routerMock.invalidate.mockReset();
});

describe("DefaultCatchBoundary", () => {
  test("renders the error component and the retry action", async () => {
    mountBoundary(new Error("boom"));

    await expect
      .element(page.getByTestId("error-component"))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Try again" }))
      .toBeInTheDocument();
  });

  test("'Try again' invalidates the router", async () => {
    mountBoundary();

    const tryAgain = page.getByRole("button", { name: "Try again" });
    await expect.element(tryAgain).toBeInTheDocument();
    await userEvent.click(tryAgain);

    expect(routerMock.invalidate).toHaveBeenCalledOnce();
  });

  describe("root branch", () => {
    test("shows 'Home' as a link to the home route, not 'Go back'", async () => {
      routerMock.matchedRouteId = routerMock.rootId;
      mountBoundary();

      // role=link (not button) confirms Mantine honoured `component={Link}`; the
      // href confirms `to` was forwarded. The back action is absent on root.
      const home = page.getByRole("link", { name: "Home" });
      await expect.element(home).toBeInTheDocument();
      await expect.element(home).toHaveAttribute("href", "/");

      await expect
        .element(page.getByRole("button", { name: "Go back" }))
        .not.toBeInTheDocument();
    });
  });

  describe("non-root branch", () => {
    test("shows 'Go back' which calls history.back(), not 'Home'", async () => {
      const back = vi
        .spyOn(window.history, "back")
        .mockImplementation(() => undefined);
      // matchedRouteId defaults to the non-root "/some-route" (set in the hoisted
      // holder and restored by afterEach), so the non-root branch needs no setup.
      mountBoundary();

      const goBack = page.getByRole("button", { name: "Go back" });
      await expect.element(goBack).toBeInTheDocument();
      await userEvent.click(goBack);

      expect(back).toHaveBeenCalledOnce();
      await expect
        .element(page.getByRole("link", { name: "Home" }))
        .not.toBeInTheDocument();
    });
  });
});
