/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import { AcceptUnderConstruction } from "@bench/placeholders";
import { BenchLobby } from "@bench/BenchLobby";
import { InviterBench } from "@bench/InviterBench";
import styles from "@bench/bench.module.css";

import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

// Stub the router seam the bench components touch (the lobby's and the
// placeholders' Links). This suite asserts the bench's structure, landmarks,
// and tokens, not navigation -- the appShell.test.ts pattern. vitest hoists
// the mock above the imports, so the components pick up the stub.
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

const EM_DASH = "\u2014";

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
});

describe("bench lobby", () => {
  test("renders the landing structure with one main and one h1", async () => {
    mount(createElement(BenchLobby));

    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("psilink - private record linkage");

    expect(document.querySelectorAll("main").length).toBe(1);
    expect(document.querySelectorAll("h1").length).toBe(1);

    const cardHeadings = Array.from(document.querySelectorAll("h3")).map(
      (heading) => heading.textContent,
    );
    expect(cardHeadings).toEqual([
      "Set up an exchange",
      "Accept an invitation you were sent",
    ]);

    // The in-browser processing assurance is a preserved invariant of the
    // redesign; assert the exact copy so a rewording is a deliberate act.
    await expect
      .element(
        page.getByText(
          "Your file is processed entirely in your browser and it is never uploaded to our server.",
        ),
      )
      .toBeInTheDocument();

    const setUpLink = Array.from(document.querySelectorAll("a")).find(
      (anchor) => anchor.textContent === "Set up an exchange",
    );
    expect(setUpLink?.getAttribute("href")).toBe("/bench/exchange");

    await expect
      .element(page.getByLabelText("Invitation link or code"))
      .toBeInTheDocument();
  });

  test("applies the bench surface tokens", async () => {
    mount(createElement(BenchLobby));

    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toBeInTheDocument();

    const surface = document.querySelector(`.${styles.page}`);
    expect(surface).not.toBeNull();
    // Light-scheme --bench-surface (#f6f5f1): the warm paper ground. Proves
    // tokens.css is wired through the module, not just present on disk.
    expect(getComputedStyle(surface as Element).backgroundColor).toBe(
      "rgb(246, 245, 241)",
    );
  });
});

describe("inviter bench", () => {
  test("renders the empty spine: landmarks, placeholder ledger, quiet facts", async () => {
    mount(createElement(InviterBench));

    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Your file");

    expect(document.querySelectorAll("main").length).toBe(1);

    const rail = document.querySelector('nav[aria-label="Exchange setup"]');
    expect(rail).not.toBeNull();

    const currentSteps = Array.from(
      (rail as Element).querySelectorAll('[aria-current="step"]'),
    );
    expect(currentSteps.map((step) => step.textContent)).toEqual(["Your file"]);

    // Customize facts with no file yet render the em-dash quiet fact.
    const facts = Array.from(
      (rail as Element).querySelectorAll(`.${styles.val}`),
    );
    expect(facts.map((fact) => fact.textContent)).toEqual([
      EM_DASH,
      EM_DASH,
      EM_DASH,
    ]);

    const ledger = document.querySelector('aside[aria-label="This exchange"]');
    expect(ledger).not.toBeNull();

    const rowLabels = Array.from(
      (ledger as Element).querySelectorAll("dt"),
    ).map((label) => label.childNodes[0].textContent);
    expect(rowLabels).toEqual([
      "You will send",
      "You will receive",
      "Matched on",
      "Expires",
      "Results go to",
      "Agreement",
      "Transport",
    ]);

    // Every undecided ledger value is the muted em-dash mark.
    const values = Array.from((ledger as Element).querySelectorAll("dd")).map(
      (value) => value.textContent,
    );
    expect(values).toEqual(Array.from({ length: 7 }, () => EM_DASH));
  });

  test("derives terms on read and tracks step-2 edits in the ledger", async () => {
    mount(createElement(InviterBench));

    await expect.element(page.getByLabelText("Your name")).toBeInTheDocument();
    await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");

    const fileInput = document.querySelector('input[type="file"]');
    expect(fileInput).not.toBeNull();
    await userEvent.upload(
      page.elementLocator(fileInput as HTMLElement),
      new File(
        [
          "client_id,first_name,last_name,dob,program_code\n" +
            "1,Ann,Lee,01/02/1990,A\n2,Bo,Ray,03/04/1985,B\n",
        ],
        "clients.csv",
        { type: "text/csv" },
      ),
    );

    // The file card and the recommended-terms callout appear on read, and the
    // ledger fills in while still on step 1: derivation happens at read time.
    await expect.element(page.getByText("clients.csv")).toBeInTheDocument();
    await expect
      .element(page.getByText("Recommended terms are ready", { exact: false }))
      .toBeInTheDocument();

    const ledger = () =>
      document.querySelector('aside[aria-label="This exchange"]') as Element;
    const ledgerRow = (label: string) =>
      Array.from(ledger().querySelectorAll(`.${styles.ledgerRow}`)).find(
        (row) => row.querySelector("dt")?.childNodes[0].textContent === label,
      );
    expect(ledgerRow("You will send")?.querySelector("dd")?.textContent).toBe(
      "program_code",
    );
    expect(ledgerRow("Expires")?.querySelector("dd")?.textContent).toBe(
      "1 hour after you share",
    );

    await page
      .getByRole("button", { name: "Continue to matching & sharing" })
      .click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Matching & sharing");

    // Undiscloses the only sent column: the ledger and the empty-state inset
    // track the edit.
    await page
      .getByLabelText("How program_code is used")
      .selectOptions("ignored");
    await expect
      .element(page.getByText("Nothing - matching only"))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText("No values will be sent to your partner", {
          exact: false,
        }),
      )
      .toBeInTheDocument();

    // Retyping the ignored column to the row identifier displaces the inferred
    // one; the displacement is announced.
    await page
      .getByLabelText("Type for program_code")
      .selectOptions("identifier");
    await expect
      .element(
        page.getByText(
          "client_id changed to Ignored - only one column can be the row identifier.",
        ),
      )
      .toBeInTheDocument();

    // The layout holds at 400px: no horizontal document overflow.
    await page.viewport(400, 800);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(400);
  });

  test("collapses to the single-column layout without rail and ledger", async () => {
    mount(createElement(AcceptUnderConstruction));

    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Accept an invitation");

    expect(document.querySelectorAll("main").length).toBe(1);
    expect(document.querySelectorAll("nav").length).toBe(0);
    expect(document.querySelectorAll("aside").length).toBe(0);
    expect(document.querySelector(`.${styles.gridPlain}`)).not.toBeNull();

    const homeLink = Array.from(document.querySelectorAll("a")).find(
      (anchor) => anchor.textContent === "current app",
    );
    expect(homeLink?.getAttribute("href")).toBe("/");
  });
});
