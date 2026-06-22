/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import { InvitationTerms } from "@components/InvitationTerms";

import type { Root } from "react-dom/client";

import type { LinkageTerms } from "@psilink/core";

// Terms that populate every block split across the always-visible core and the
// Details disclosure: a non-standard (transformed) key, a constrained field,
// payload columns, a legal agreement, and a deduplicate setting -- so the test can
// assert which side of the partition each lands on.
const terms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-01",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: true,
  linkageFields: [
    {
      name: "first_name",
      type: "first_name",
      constraints: { allowedCharacters: "A-Z " },
    },
    { name: "dob", type: "date_of_birth" },
  ],
  linkageKeys: [
    {
      name: "FN + DOB",
      elements: [
        {
          field: "first_name",
          transform: [
            { function: "substring", params: { start: 1, length: 1 } },
          ],
        },
        { field: "dob" },
      ],
    },
  ],
  payload: { send: [{ name: "risk_score" }], receive: [] },
  legalAgreement: {
    reference: "MOU-2025-0042",
    purpose: "Audit and evaluation",
    expirationDate: "2027-12-31",
  },
};

let container: HTMLElement | undefined;
let root: Root | undefined;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
});

function renderTerms() {
  root!.render(
    createElement(
      MantineProvider,
      null,
      createElement(InvitationTerms, { linkageTerms: terms }),
    ),
  );
}

// The stable wrapper the toggle's aria-controls points at, resolved the same way
// assistive tech follows the reference. The id lives on this always-mounted
// wrapper (not the Collapse panel) so it never dangles when Mantine unmounts the
// closed panel under a reduced-motion preference.
function detailsPanel(): HTMLElement {
  const toggle = container!.querySelector("[aria-controls]");
  const id = toggle?.getAttribute("aria-controls");
  const panel = id ? document.getElementById(id) : null;
  if (!panel) throw new Error("details panel not found");
  return panel;
}

// The Mantine Collapse panel itself: the wrapper's only child, carrying the
// aria-hidden + inert (and display:none) that hide the collapsed detail from
// assistive tech. Separate from the wrapper because aria-controls resolves to the
// always-mounted wrapper, while these hidden-state attributes sit on the panel
// Mantine mounts inside it.
function collapsePanel(): HTMLElement {
  const panel = detailsPanel().firstElementChild;
  if (!(panel instanceof HTMLElement))
    throw new Error("collapse panel not found");
  return panel;
}

describe("InvitationTerms: always-visible core vs Details disclosure", () => {
  test("keeps the badge and core terms outside the disclosure, details collapsed and hidden from AT", async () => {
    renderTerms();

    // A real disclosure toggle: a button wired to its panel and collapsed to start.
    const toggle = page.getByRole("button", { name: "Details" });
    await expect.element(toggle).toBeInTheDocument();
    expect(toggle.element().getAttribute("aria-expanded")).toBe("false");

    const panel = detailsPanel();
    // Collapsed: Mantine marks the Collapse panel inside the wrapper aria-hidden +
    // inert, so the dense detail is out of the accessibility tree and the tab order
    // until opened. The wrapper that holds aria-controls stays mounted regardless.
    const collapse = collapsePanel();
    expect(collapse.getAttribute("aria-hidden")).toBe("true");
    expect(collapse.hasAttribute("inert")).toBe(true);

    // The always-visible core stays OUTSIDE the disclosure: the non-standard
    // badge -- which must never be hidden in collapsed content -- the matching
    // method, and result sharing are all absent from the panel but present on the
    // screen.
    expect(panel.textContent).not.toContain("Non-standard matching");
    expect(panel.textContent).not.toContain("shared identifiers");
    expect(panel.textContent).not.toContain(
      "You will receive the matched result",
    );
    expect(container!.textContent).toContain("Non-standard matching");
    expect(container!.textContent).toContain("shared identifiers");
    expect(container!.textContent).toContain(
      "You will receive the matched result",
    );
    // The key name is the always-visible anchor for its collapsed detail.
    expect(container!.textContent).toContain("FN + DOB");

    // The dense detail lives INSIDE the disclosure: per-element transforms, field
    // constraints, payload columns, the legal agreement, and the dedup note.
    expect(panel.textContent).toContain("transformed (substring)");
    expect(panel.textContent).toContain("characters limited to A-Z");
    expect(panel.textContent).toContain("risk_score");
    expect(panel.textContent).toContain("MOU-2025-0042");
    expect(panel.textContent).toContain("may match more than one");
  });

  test("opening the disclosure exposes the details to assistive tech", async () => {
    renderTerms();

    const toggle = page.getByRole("button", { name: "Details" });
    await userEvent.click(toggle);

    expect(toggle.element().getAttribute("aria-expanded")).toBe("true");
    const collapse = collapsePanel();
    expect(collapse.getAttribute("aria-hidden")).toBe("false");
    expect(collapse.hasAttribute("inert")).toBe(false);
  });
});

describe("InvitationTerms: the disclosure's aria-controls survives a reduced-motion preference", () => {
  // With respectReducedMotion on, Mantine's Collapse unmounts the closed panel for
  // a reduced-motion user -- the configuration that would dangle an aria-controls
  // pointing at the panel itself. Force both halves of it: the OS reduced-motion
  // signal (matchMedia) and the theme switch that honors it.
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
    window.matchMedia = (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    });
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  test("aria-controls resolves to a present element while collapsed under reduced motion", async () => {
    root!.render(
      createElement(
        MantineProvider,
        { theme: { respectReducedMotion: true } },
        createElement(InvitationTerms, { linkageTerms: terms }),
      ),
    );

    const toggle = page.getByRole("button", { name: "Details" });
    await expect.element(toggle).toBeInTheDocument();
    expect(toggle.element().getAttribute("aria-expanded")).toBe("false");

    const id = toggle.element().getAttribute("aria-controls");
    expect(id).toBeTruthy();

    // The reduced-motion media effect resolves after mount and unmounts the closed
    // Collapse panel, emptying the wrapper -- the state in which an id held on the
    // panel itself would dangle. Wait for that unmount so the assertion exercises
    // it rather than the pre-effect mounted-but-hidden panel.
    await expect
      .poll(() => document.getElementById(id!)?.children.length)
      .toBe(0);

    // The stable wrapper holding aria-controls stays mounted, so the reference
    // still resolves to a present element; the unmounted panel keeps the collapsed
    // detail out of the accessibility tree.
    const panel = document.getElementById(id!);
    expect(panel).not.toBeNull();
    expect(panel!.textContent).toBe("");
  });
});

describe("InvitationTerms: result sharing is stated from the viewer's perspective", () => {
  // Render the same terms with a chosen output direction and perspective. The
  // viewer is the inviter under "proposing" (its own preview) and the acceptor
  // under "review"/"accepted"; each must read its OWN outcome first-person, which
  // is the consent-legible form for a one-sided exchange.
  function renderOutput(
    output: { expectsOutput: boolean; shareWithPartner: boolean },
    perspective?: "review" | "accepted" | "proposing",
  ) {
    root!.render(
      createElement(
        MantineProvider,
        null,
        createElement(InvitationTerms, {
          linkageTerms: { ...terms, output },
          ...(perspective ? { perspective } : {}),
        }),
      ),
    );
  }

  test("an acceptor of an inviter-only invitation is told plainly it receives no result", async () => {
    // inviter-only: the inviter receives and does not share, so the acceptor gets
    // nothing -- and must read that first-person, not infer it from the inviter's
    // "shares with you: No".
    renderOutput({ expectsOutput: true, shareWithPartner: false });
    await expect.element(page.getByText("Result sharing")).toBeInTheDocument();
    expect(container!.textContent).toContain(
      "You will receive the matched result: No",
    );
    expect(container!.textContent).toContain(
      "Your partner (the inviter) will receive the result: Yes",
    );
  });

  test("an acceptor of a partner-only invitation is told plainly it receives the result", async () => {
    renderOutput({ expectsOutput: false, shareWithPartner: true });
    await expect.element(page.getByText("Result sharing")).toBeInTheDocument();
    expect(container!.textContent).toContain(
      "You will receive the matched result: Yes",
    );
    expect(container!.textContent).toContain(
      "Your partner (the inviter) will receive the result: No",
    );
  });

  test("the inviter's own preview frames the outcome for the proposer", async () => {
    // proposing: the viewer IS the inviter, so "you" is the inviter and "your
    // partner" the acceptor. inviter-only here: the inviter receives, the partner
    // does not.
    renderOutput({ expectsOutput: true, shareWithPartner: false }, "proposing");
    await expect.element(page.getByText("Result sharing")).toBeInTheDocument();
    expect(container!.textContent).toContain(
      "You will receive the matched result: Yes",
    );
    expect(container!.textContent).toContain(
      "Your partner will receive the result: No",
    );
  });
});
