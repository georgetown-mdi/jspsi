/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import { NotFound } from "@components/NotFound";

import { createAppMount } from "./renderApp";

// NotFound reaches the home route through Mantine's polymorphic `component` prop
// (`<Button component={Link} to="/">`). With the stubbed Link exposing `to` as
// the href, this still exercises the critical MANTINE side: that the
// polymorphic `component` is honoured (so "Start over" renders as an <a>, not
// Mantine's default <button>) and that `to` is forwarded through.
vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

const app = createAppMount();

afterEach(() => {
  app.unmount();
  vi.restoreAllMocks();
});

describe("NotFound", () => {
  test("'Start over' renders as a link to the home route", async () => {
    app.render(createElement(NotFound));

    // role=link (not button) confirms Mantine honoured `component={Link}` rather
    // than falling back to its default <button>; the href confirms `to` was
    // forwarded. A Mantine change that broke component-forwarding would show
    // here as a missing link / a stray <button>.
    const startOver = page.getByRole("link", { name: "Start over" });
    await expect.element(startOver).toBeInTheDocument();
    await expect.element(startOver).toHaveAttribute("href", "/");
  });

  test("'Go back' is a button that calls history.back()", async () => {
    const back = vi
      .spyOn(window.history, "back")
      .mockImplementation(() => undefined);
    app.render(createElement(NotFound));

    const goBack = page.getByRole("button", { name: "Go back" });
    await expect.element(goBack).toBeInTheDocument();
    await userEvent.click(goBack);

    expect(back).toHaveBeenCalledOnce();
  });

  test("shows a default message when given no children", async () => {
    app.render(createElement(NotFound));

    await expect
      .element(page.getByText("The page you are looking for does not exist."))
      .toBeInTheDocument();
  });
});
