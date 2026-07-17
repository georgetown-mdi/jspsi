/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { NotFound } from "@components/NotFound";

import { renderApp } from "./renderApp";

import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

// NotFound reaches the home route through Mantine's polymorphic `component` prop
// (`<Button component={Link} to="/">`). Stub the router module to render Link as a
// plain <a href={to}>, the same pattern appShell.test.ts uses, since a real
// RouterProvider trips a duplicate-React dispatcher error under the browser
// runner. With Link surfacing `to` as the href, this still exercises the
// load-bearing MANTINE side: that the polymorphic `component` is honoured (so
// "Start over" renders as an <a>, not Mantine's default <button>) and that `to`
// is forwarded through. TanStack's own to->href resolution is its concern, not
// this component's, so stubbing it loses no coverage of our code.
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
}));

let container: HTMLElement | undefined;
let root: Root | undefined;

// Mount under the real app provider config, the way the running app composes it.
function mount(node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(renderApp(node));
}

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

describe("NotFound", () => {
  test("'Start over' renders as a link to the home route", async () => {
    mount(createElement(NotFound));

    // role=link (not button) confirms Mantine honoured `component={Link}` rather
    // than falling back to its default <button>; the href confirms `to` was
    // forwarded. A Mantine change that broke component-forwarding would surface
    // here as a missing link / a stray <button>.
    const startOver = page.getByRole("link", { name: "Start over" });
    await expect.element(startOver).toBeInTheDocument();
    await expect.element(startOver).toHaveAttribute("href", "/");
  });

  test("'Go back' is a button that calls history.back()", async () => {
    const back = vi
      .spyOn(window.history, "back")
      .mockImplementation(() => undefined);
    mount(createElement(NotFound));

    const goBack = page.getByRole("button", { name: "Go back" });
    await expect.element(goBack).toBeInTheDocument();
    await userEvent.click(goBack);

    expect(back).toHaveBeenCalledOnce();
  });

  test("shows a default message when given no children", async () => {
    mount(createElement(NotFound));

    await expect
      .element(page.getByText("The page you are looking for does not exist."))
      .toBeInTheDocument();
  });
});
