/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

// Load Mantine's stylesheet so components render with their real geometry
// (the bench browser suites' shared discipline).
import "@mantine/core/styles.css";

// The REAL router history -- deliberately not mocked here. createBrowserHistory
// is what the app router runs on (router.tsx -> createRouter): it patches
// window.history.pushState/replaceState and classifies every popstate as
// BACK/FORWARD/GO from the __TSR_index delta. This suite pins the bench's
// history writes against that patched implementation; mounting a full
// RouterProvider is not possible in this harness (it trips a duplicate-React
// dispatcher error, the reason the other bench suites stub the router), but the
// history layer is plain JS and carries the whole index contract.
import { createBrowserHistory } from "@tanstack/react-router";

import { InviterBench } from "@bench/InviterBench";

import { renderApp } from "./renderApp";

import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import type { RouterHistory } from "@tanstack/react-router";

// Stub the rendezvous module: importing it runs a top-level config load that
// reads `process` (absent in the browser runner). Nothing in this suite mints
// an invitation, so no listen ever fires (the bench.test.ts pattern).
vi.mock("@psi/rendezvous", () => ({
  dialAsAcceptor: vi.fn(),
  listenAsInviter: vi.fn(),
}));
vi.mock("@psi/exchangeLifecycle", () => ({
  runExchangeLifecycle: () => Promise.resolve(),
}));

let container: HTMLElement | undefined;
let root: Root | undefined;

function mount(content: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(renderApp(content));
}

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
});

function routerIndex(): number {
  return (window.history.state as { __TSR_index: number }).__TSR_index;
}

function routerKey(): string {
  return (window.history.state as { __TSR_key: string }).__TSR_key;
}

describe("bench steps under the router's patched history", () => {
  test("pushes advance the router index and pops classify as BACK/FORWARD, not GO", async () => {
    // Production ordering: the router history exists before the bench mounts,
    // has patched window.history, and has seeded __TSR_index on the current
    // entry. destroy() unpatches, so a failure cannot leak the patch into
    // other tests.
    const routerHistory: RouterHistory = createBrowserHistory();
    const actions: Array<string> = [];
    const unsubscribe = routerHistory.subscribe(({ action }) =>
      actions.push(action.type),
    );
    try {
      mount(createElement(InviterBench));
      await expect
        .element(page.getByLabelText("Your name"))
        .toBeInTheDocument();
      const baseIndex = routerIndex();

      await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
      const fileInput = document.querySelector('input[type="file"]');
      await userEvent.upload(
        page.elementLocator(fileInput as HTMLElement),
        new File(
          [
            "client_id,first_name,last_name,dob,program_code\n" +
              "1,Ann,Lee,01/02/1990,A\n",
          ],
          "clients.csv",
          { type: "text/csv" },
        ),
      );
      await expect.element(page.getByText("clients.csv")).toBeInTheDocument();
      await page
        .getByRole("button", { name: "Continue to matching & sharing" })
        .click();
      const columnsKey = routerKey();
      await page
        .getByRole("button", { name: "Continue to review & create" })
        .click();
      await expect
        .element(page.getByRole("heading", { level: 1 }))
        .toHaveTextContent("Review & create");

      // Each bench push advanced the router's index by one and minted a fresh
      // entry key, exactly as the router's own pushes do, and the router
      // history's tracked location agrees with the browser's.
      expect(routerIndex()).toBe(baseIndex + 2);
      expect(routerKey()).not.toBe(columnsKey);
      expect(routerHistory.location.state.__TSR_index).toBe(baseIndex + 2);

      // Browser Back is classified BACK (delta -1) -- a frozen index would
      // classify it GO(0) and desync the router's position tracking -- and the
      // bench still restores the step in place.
      actions.length = 0;
      window.history.back();
      await expect
        .element(page.getByRole("heading", { level: 1 }))
        .toHaveTextContent("Matching & sharing");
      await vi.waitFor(() => expect(actions).toContain("BACK"));
      expect(actions).not.toContain("GO");
      expect(routerIndex()).toBe(baseIndex + 1);
      expect(routerHistory.location.state.__TSR_index).toBe(baseIndex + 1);

      actions.length = 0;
      window.history.forward();
      await expect
        .element(page.getByRole("heading", { level: 1 }))
        .toHaveTextContent("Review & create");
      await vi.waitFor(() => expect(actions).toContain("FORWARD"));
      expect(actions).not.toContain("GO");
      expect(routerIndex()).toBe(baseIndex + 2);
      expect(routerHistory.location.state.__TSR_index).toBe(baseIndex + 2);
    } finally {
      unsubscribe();
      routerHistory.destroy();
    }
  });
});
