/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import {
  clearAcceptHandoff,
  peekAcceptHandoff,
  stashAcceptHandoff,
} from "@components/acceptHandoff";
import AcceptForm from "@components/AcceptForm";

import type { Root } from "react-dom/client";

// AcceptForm is the home page's accept box. It writes the home-page->accept file
// hand-off (the read side is covered by acceptConsentGate.test.ts) and navigates to
// /accept on submit. Capture the navigation so this suite can mount AcceptForm
// without a RouterProvider (the render-test pattern) and assert where it routes.
const nav = vi.hoisted(() => ({ calls: [] as Array<unknown> }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => (opts: unknown) => {
    nav.calls.push(opts);
  },
}));

function csvFile(content: string): File {
  return new File([content], "data.csv", { type: "text/csv" });
}

let container: HTMLElement | undefined;
let root: Root | undefined;

function mount(files: Array<File>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    createElement(MantineProvider, null, createElement(AcceptForm, { files })),
  );
}

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  nav.calls.length = 0;
  clearAcceptHandoff();
});

describe("AcceptForm", () => {
  test("Review invitation is disabled until the field holds a usable token", async () => {
    mount([]);
    const review = page.getByRole("button", { name: "Review invitation" });
    // Empty field: nothing to review, so the action is withheld.
    await expect.element(review).toBeDisabled();

    await userEvent.fill(page.getByRole("textbox"), "MYTOKEN");
    await expect.element(review).toBeEnabled();

    // Whitespace alone is not a usable token (tokenFromInput trims), so the gate
    // closes again rather than offering an action that would no-op.
    await userEvent.fill(page.getByRole("textbox"), "   ");
    await expect.element(review).toBeDisabled();
  });

  test("stashes the chosen file and routes with the token in the fragment on submit", async () => {
    const file = csvFile("first_name\nAlice\n");
    mount([file]);

    await userEvent.fill(page.getByRole("textbox"), "MYTOKEN");
    await userEvent.click(
      page.getByRole("button", { name: "Review invitation" }),
    );

    // The file rides to /accept via the in-memory hand-off (the SAME File handle,
    // not a copy), and the token rides in the URL fragment, never a search param.
    expect(peekAcceptHandoff()).toBe(file);
    expect(nav.calls).toContainEqual({ to: "/accept", hash: "MYTOKEN" });
  });

  test("clears any stale hand-off when no file is chosen", async () => {
    // A stale stash from an earlier submit, so the clear is observable (not a
    // vacuous pass against an already-empty stash).
    stashAcceptHandoff(csvFile("old\n1\n"));
    expect(peekAcceptHandoff()).toBeDefined();
    mount([]);

    await userEvent.fill(page.getByRole("textbox"), "MYTOKEN");
    await userEvent.click(
      page.getByRole("button", { name: "Review invitation" }),
    );

    // No file selected: the stale stash is cleared so /accept falls back to its own
    // picker rather than resurrecting an unrelated earlier file.
    expect(peekAcceptHandoff()).toBeUndefined();
    expect(nav.calls).toContainEqual({ to: "/accept", hash: "MYTOKEN" });
  });

  test("extracts the token from a pasted deep-link URL fragment", async () => {
    mount([]);
    await userEvent.fill(
      page.getByRole("textbox"),
      "https://example.org/accept#DEEPTOKEN",
    );
    await userEvent.click(
      page.getByRole("button", { name: "Review invitation" }),
    );
    // Everything after the first '#' is the token; the origin/path is dropped.
    expect(nav.calls).toContainEqual({ to: "/accept", hash: "DEEPTOKEN" });
  });
});
