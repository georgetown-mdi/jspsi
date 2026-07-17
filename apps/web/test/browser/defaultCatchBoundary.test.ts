/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { DefaultCatchBoundary } from "@components/DefaultCatchBoundary";
import { whenDiagnostic } from "@utils/diagnostics";

import { renderApp } from "./renderApp";

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

// Mock the diagnostic gate so both of its states are testable here: the default
// implementation (set in beforeEach) runs the sink -- the development /
// diagnostics-on case the suite otherwise assumes -- and the gated-off test
// overrides it to a no-op to prove the boundary delegates its console decision to
// the gate. The gate's own env/flag logic is covered by test/unit/diagnostics.test.ts.
vi.mock("@utils/diagnostics", () => ({ whenDiagnostic: vi.fn() }));

let container: HTMLElement | undefined;
let root: Root | undefined;

// Mount under the real app provider config, the way the running app composes it.
function mount(node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(renderApp(node));
}

// DefaultCatchBoundary takes ErrorComponentProps; it reads only `error`, but the
// type requires `reset`, so a no-op stands in for it.
function mountBoundary(error: Error = new Error("boom")) {
  mount(createElement(DefaultCatchBoundary, { error, reset: () => undefined }));
}

// DefaultCatchBoundary routes its caught-error console.error through
// whenDiagnostic (mocked above), so mock console.error to keep that expected
// noise out of the run output; the dev-gating tests below assert against this
// same spy. whenDiagnostic defaults to running its sink (the diagnostics-on
// case); a single test overrides it. Restored by vi.restoreAllMocks().
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.mocked(whenDiagnostic).mockImplementation((emit) => emit());
});

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  routerMock.matchedRouteId = "/some-route";
  vi.restoreAllMocks();
  routerMock.invalidate.mockReset();
  vi.mocked(whenDiagnostic).mockReset();
});

describe("DefaultCatchBoundary", () => {
  test("renders the error component and the retry action", async () => {
    mountBoundary(new Error("boom"));

    // The boundary now hands ErrorComponent a *sanitized* clone of the error;
    // "boom" survives sanitizing unchanged, so the mock (which surfaces
    // error.message) still shows "boom". Asserting the text -- not just the
    // marker's presence -- proves the message is wired through and would catch a
    // dropped error.
    await expect
      .element(page.getByTestId("error-component"))
      .toHaveTextContent("boom");
    await expect
      .element(page.getByRole("button", { name: "Try again" }))
      .toBeInTheDocument();
  });

  test("escapes control characters in the rendered message", async () => {
    // ESC (0x1b) drives ANSI sequences and LF (0x0a) enables log-line spoofing;
    // the boundary must hand ErrorComponent the escaped form (sanitizeForDisplay
    // rewrites each to a visible \xHH), never the raw bytes.
    mountBoundary(new Error("danger\x1b[31m\nhere"));

    await expect
      .element(page.getByTestId("error-component"))
      .toHaveTextContent("danger\\x1b[31m\\x0ahere");
  });

  test("redacts a leaked private-key block before it reaches the DOM", async () => {
    // The key-redaction backstop is the second protection sanitizeErrorForDisplay
    // adds at this sink: an unanticipated path that interpolates key material into
    // an error must not render it. (Live secrets are kept out upstream; this is
    // defense in depth.)
    const pem =
      "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADAN\n-----END PRIVATE KEY-----";
    mountBoundary(new Error(`failed to load key: ${pem}`));

    const errorComponent = page.getByTestId("error-component");
    await expect
      .element(errorComponent)
      .toHaveTextContent("[redacted private key]");
    // Both the markers and the key body must be gone -- the whole block is
    // replaced, so neither the BEGIN line nor the base64 payload survives.
    await expect
      .element(errorComponent)
      .not.toHaveTextContent("BEGIN PRIVATE KEY");
    await expect.element(errorComponent).not.toHaveTextContent("MIIBVgIBADAN");
  });

  test("sanitizes a non-Error thrown value without crashing", async () => {
    // A route error is an arbitrary thrown value at runtime even though the prop
    // is typed Error; this last-resort boundary must survive a raw string (the
    // sanitizer renders any non-Error via its String() form) and still escape it.
    mountBoundary("raw\x1bstring" as unknown as Error);

    await expect
      .element(page.getByTestId("error-component"))
      .toHaveTextContent("raw\\x1bstring");
  });

  test("dev-gates the raw error to the console via whenDiagnostic", async () => {
    const rawError = new Error("boom");
    mountBoundary(rawError);

    // Wait for the render to commit before asserting the synchronous log.
    await expect
      .element(page.getByTestId("error-component"))
      .toBeInTheDocument();
    // whenDiagnostic is mocked to run its sink (the diagnostics-on case), so this
    // asserts the boundary hands the gate the LIVE Error object -- the full
    // structured value, not the sanitized display clone -- so a developer keeps
    // the expandable stack and `.cause` chain. That the boundary delegates to the
    // gate (rather than logging unconditionally) is the next test; the gate's own
    // env/flag suppression is covered by diagnostics.test.ts.
    expect(console.error).toHaveBeenCalledWith(
      "DefaultCatchBoundary Error:",
      rawError,
    );
  });

  test("does not log to the console when the diagnostic gate is closed", async () => {
    // The production / diagnostics-off case: whenDiagnostic runs nothing. The
    // boundary must then put its line on no console -- proof it delegates the
    // decision to the gate rather than calling console.error directly. Without
    // this, a regression to a bare console.error would pass every other test while
    // leaking the raw Error (with .stack) to a production browser console.
    vi.mocked(whenDiagnostic).mockImplementation(() => undefined);
    mountBoundary(new Error("boom"));

    await expect
      .element(page.getByTestId("error-component"))
      .toBeInTheDocument();
    expect(whenDiagnostic).toHaveBeenCalledOnce();
    expect(console.error).not.toHaveBeenCalledWith(
      "DefaultCatchBoundary Error:",
      expect.anything(),
    );
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
