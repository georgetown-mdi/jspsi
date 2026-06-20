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

// The disclosure panel, resolved from the toggle's aria-controls so the test
// follows the same wiring assistive tech does.
function detailsPanel(): HTMLElement {
  const toggle = container!.querySelector("[aria-controls]");
  const id = toggle?.getAttribute("aria-controls");
  const panel = id ? document.getElementById(id) : null;
  if (!panel) throw new Error("details panel not found");
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
    // Collapsed: Mantine marks the panel aria-hidden + inert, so the dense detail
    // is out of the accessibility tree and the tab order until opened.
    expect(panel.getAttribute("aria-hidden")).toBe("true");
    expect(panel.hasAttribute("inert")).toBe(true);

    // The always-visible core stays OUTSIDE the disclosure: the non-standard
    // badge -- which must never be hidden in collapsed content -- the matching
    // method, and result sharing are all absent from the panel but present on the
    // screen.
    expect(panel.textContent).not.toContain("Non-standard matching");
    expect(panel.textContent).not.toContain("shared identifiers");
    expect(panel.textContent).not.toContain("Inviter expects to receive");
    expect(container!.textContent).toContain("Non-standard matching");
    expect(container!.textContent).toContain("shared identifiers");
    expect(container!.textContent).toContain("Inviter expects to receive");
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
    const panel = detailsPanel();
    expect(panel.getAttribute("aria-hidden")).toBe("false");
    expect(panel.hasAttribute("inert")).toBe(false);
  });
});
