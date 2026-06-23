/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import { InvitationTerms } from "@components/InvitationTerms";

import type { Root } from "react-dom/client";

import type { LinkageTerms } from "@psilink/core";

// Terms with two linkage keys whose breadth differs -- an exact key and a
// first-initial-truncated one -- plus a constrained field, payload columns, and a
// legal agreement, so the test can assert where each lands: the per-key matching
// detail in that key's own disclosure, and the non-key blocks in the master "Other
// details" disclosure.
const terms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-01",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: true,
  linkageFields: [
    { name: "ssn", type: "ssn" },
    {
      name: "first_name",
      type: "first_name",
      constraints: { allowedCharacters: "A-Z " },
    },
    { name: "last_name", type: "last_name" },
    { name: "dob", type: "date_of_birth" },
  ],
  linkageKeys: [
    // Exact: no breadth marker in its header one-liner.
    {
      name: "SSN + LN + DOB",
      elements: [{ field: "ssn" }, { field: "last_name" }, { field: "dob" }],
    },
    // Truncated: the first-initial substring loosens the match, so the first-name
    // entry carries a "(partial)" marker and the body leads with the slice phrase.
    {
      name: "SSN + FN1",
      elements: [
        { field: "ssn" },
        {
          field: "first_name",
          transform: [
            { function: "substring", params: { start: 1, length: 1 } },
          ],
        },
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

// A disclosure toggle by its accessible name (a key name, or "Other details").
function toggle(name: string) {
  return page.getByRole("button", { name });
}

// The always-mounted wrapper a toggle's aria-controls points at, resolved the way
// assistive tech follows the reference. The id lives on this wrapper (not the
// Collapse panel) so it never dangles when Mantine unmounts the closed panel under
// a reduced-motion preference.
function panelFor(name: string): HTMLElement {
  const id = toggle(name).element().getAttribute("aria-controls");
  const panel = id ? document.getElementById(id) : null;
  if (!panel) throw new Error(`disclosure panel not found for ${name}`);
  return panel;
}

// The Mantine Collapse panel inside the wrapper, carrying the aria-hidden + inert
// (and display:none) that hide the collapsed detail from assistive tech.
function collapseFor(name: string): HTMLElement {
  const panel = panelFor(name).firstElementChild;
  if (!(panel instanceof HTMLElement))
    throw new Error(`collapse panel not found for ${name}`);
  return panel;
}

describe("InvitationTerms: per-key matching disclosures", () => {
  test("each key is its own disclosure, the rule detail collapsed and hidden from AT while the header stays visible", async () => {
    renderTerms();

    // Each key is a disclosure button, collapsed to start.
    const exact = toggle("SSN + LN + DOB");
    const truncated = toggle("SSN + FN1");
    await expect.element(exact).toBeInTheDocument();
    await expect.element(truncated).toBeInTheDocument();
    expect(exact.element().getAttribute("aria-expanded")).toBe("false");
    expect(truncated.element().getAttribute("aria-expanded")).toBe("false");

    // The truncated key's collapsed body is out of the accessibility tree and the
    // tab order until opened.
    const collapse = collapseFor("SSN + FN1");
    expect(collapse.getAttribute("aria-hidden")).toBe("true");
    expect(collapse.hasAttribute("inert")).toBe(true);

    // The per-element rule detail (the literal slice phrase) lives in the
    // collapsed body, not the always-visible header.
    expect(panelFor("SSN + FN1").textContent).toContain(
      "Matches on the first character",
    );

    // The always-visible header one-liner is the honest anchor: the truncated
    // element carries the "(partial)" breadth marker, the exact key carries none.
    // The marker is always-visible (a top-level signal), not buried in the
    // collapsed body.
    expect(container!.textContent).toContain(
      "Matches on SSN - first name (partial)",
    );
    expect(container!.textContent).toContain(
      "Matches on SSN - last name - date of birth",
    );
    expect(panelFor("SSN + FN1").textContent).not.toContain("(partial)");
  });

  test("opening one key disclosure exposes its detail to AT and leaves the others collapsed", async () => {
    renderTerms();

    await userEvent.click(toggle("SSN + FN1"));

    expect(toggle("SSN + FN1").element().getAttribute("aria-expanded")).toBe(
      "true",
    );
    const opened = collapseFor("SSN + FN1");
    expect(opened.getAttribute("aria-hidden")).toBe("false");
    expect(opened.hasAttribute("inert")).toBe(false);

    // Independent disclosure state: the other key stays collapsed.
    expect(
      toggle("SSN + LN + DOB").element().getAttribute("aria-expanded"),
    ).toBe("false");
    expect(collapseFor("SSN + LN + DOB").getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  test("the toggle's accessible name is the key name; the field one-liner is its description", async () => {
    renderTerms();
    await expect.element(toggle("SSN + FN1")).toBeInTheDocument();

    // getByRole resolving on the exact key name already proves the name is the
    // key name alone (the field one-liner is not folded into it).
    const button = toggle("SSN + FN1").element();
    expect(button.textContent).not.toContain("Matches on");

    // The field one-liner is associated as the toggle's description.
    const describedById = button.getAttribute("aria-describedby");
    expect(describedById).toBeTruthy();
    const subline = document.getElementById(describedById!);
    expect(subline?.textContent).toContain(
      "Matches on SSN - first name (partial)",
    );
  });

  test("every disclosure on the screen has a distinct aria-controls id", async () => {
    renderTerms();
    await expect.element(toggle("Other details")).toBeInTheDocument();

    const ids = Array.from(container!.querySelectorAll("[aria-controls]")).map(
      (el) => el.getAttribute("aria-controls"),
    );
    // Two per-key disclosures plus the master "Other details" disclosure.
    expect(ids.length).toBe(3);
    expect(new Set(ids).size).toBe(3);
  });

  test("the master 'Other details' disclosure holds the non-key blocks, not the per-key matching detail", async () => {
    renderTerms();

    const other = toggle("Other details");
    await expect.element(other).toBeInTheDocument();

    // The master collapse is hidden from AT + the tab order while closed, like
    // each per-key disclosure (so its dense legal/payload detail cannot leak into
    // the tab order or accessibility tree while visually hidden).
    const masterCollapse = collapseFor("Other details");
    expect(masterCollapse.getAttribute("aria-hidden")).toBe("true");
    expect(masterCollapse.hasAttribute("inert")).toBe(true);

    // The non-key blocks (field constraints, payload, legal agreement, dedup) are
    // in the master disclosure ...
    const panel = panelFor("Other details");
    expect(panel.textContent).toContain("characters limited to A-Z");
    expect(panel.textContent).toContain("risk_score");
    expect(panel.textContent).toContain("MOU-2025-0042");
    expect(panel.textContent).toContain("may match more than one");
    // ... but the per-key matching detail moved out, into the key's own
    // disclosure.
    expect(panel.textContent).not.toContain("Matches on the first character");
  });
});

describe("InvitationTerms: a key disclosure's aria-controls survives a reduced-motion preference", () => {
  // With respectReducedMotion on, Mantine's Collapse unmounts each closed panel
  // for a reduced-motion user -- the configuration that would dangle an
  // aria-controls pointing at the panel itself. Force both halves of it: the OS
  // reduced-motion signal (matchMedia) and the theme switch that honors it.
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

  test("every disclosure's aria-controls resolves to a present wrapper while collapsed under reduced motion", async () => {
    root!.render(
      createElement(
        MantineProvider,
        { theme: { respectReducedMotion: true } },
        createElement(InvitationTerms, { linkageTerms: terms }),
      ),
    );

    // Every disclosure on the screen -- both per-key widgets AND the master "Other
    // details" -- relies on the always-mounted-wrapper design, so assert the
    // unmount for all of them, not just one key.
    const names = ["SSN + LN + DOB", "SSN + FN1", "Other details"];
    for (const name of names) {
      await expect.element(toggle(name)).toBeInTheDocument();
      expect(toggle(name).element().getAttribute("aria-expanded")).toBe(
        "false",
      );
    }
    const ids = names.map((name) =>
      toggle(name).element().getAttribute("aria-controls"),
    );
    ids.forEach((id) => expect(id).toBeTruthy());

    // The reduced-motion media effect resolves after mount and unmounts each closed
    // Collapse panel, emptying its wrapper -- the state in which an id held on the
    // panel itself would dangle. Wait for that unmount so the assertion exercises
    // it rather than the pre-effect mounted-but-hidden panel.
    for (const id of ids) {
      await expect
        .poll(() => document.getElementById(id!)?.children.length)
        .toBe(0);
      // The stable wrapper holding aria-controls stays mounted, so the reference
      // still resolves to a present element; the unmounted panel keeps the
      // collapsed detail out of the accessibility tree.
      const panel = document.getElementById(id!);
      expect(panel).not.toBeNull();
      expect(panel!.textContent).toBe("");
    }
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

describe("InvitationTerms: always-visible egress and legal-agreement presence hints", () => {
  // Render a chosen terms object under the given perspective. The presence hints
  // live in the always-visible core; the detail they point at stays in the "Other
  // details" disclosure.
  function render(
    linkageTerms: LinkageTerms,
    perspective?: "review" | "accepted" | "proposing",
  ) {
    root!.render(
      createElement(
        MantineProvider,
        null,
        createElement(InvitationTerms, {
          linkageTerms,
          ...(perspective ? { perspective } : {}),
        }),
      ),
    );
  }

  test("the egress hint surfaces a column count in the always-visible core, outside the 'Other details' disclosure", async () => {
    // Two columns the inviter requests FROM the acceptor: the acceptor's egress.
    render({
      ...terms,
      payload: { send: [], receive: [{ name: "ssn" }, { name: "zip_code" }] },
    });
    await expect.element(toggle("Other details")).toBeInTheDocument();

    // The presence/count hint is on screen ... (the trailing period pins the
    // exact rendered copy: a presence assertion of the full sentence).
    expect(container!.textContent).toContain(
      "This invitation requests 2 additional data columns from you.",
    );
    // ... and OUTSIDE the disclosure (structure, not styling): the hint text is
    // not inside the "Other details" panel, which carries the collapsed detail
    // even while hidden.
    expect(panelFor("Other details").textContent).not.toContain(
      "This invitation requests 2 additional data columns from you",
    );
    // The column NAMES themselves stay one expand down in the disclosure -- the
    // hint surfaces only the count, not the detail.
    expect(panelFor("Other details").textContent).toContain("zip_code");
  });

  test("the egress hint reads singular for a single requested column", async () => {
    render({
      ...terms,
      payload: { send: [], receive: [{ name: "ssn" }] },
    });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(container!.textContent).toContain(
      "This invitation requests 1 additional data column from you.",
    );
  });

  test("the egress hint reads 'from your partner' in the inviter's own preview", async () => {
    render(
      {
        ...terms,
        payload: { send: [], receive: [{ name: "ssn" }, { name: "zip_code" }] },
      },
      "proposing",
    );
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(container!.textContent).toContain(
      "This invitation requests 2 additional data columns from your partner.",
    );
  });

  test("no egress hint when the inviter requests no columns from the acceptor", async () => {
    // The module terms request nothing from the acceptor (receive: []).
    render(terms);
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(container!.textContent).not.toContain("additional data column");
  });

  test("the legal-agreement hint surfaces presence in the always-visible core, outside the 'Other details' disclosure", async () => {
    // The module terms attach a legal agreement (receive stays empty, so only the
    // legal hint shows).
    render(terms);
    await expect.element(toggle("Other details")).toBeInTheDocument();

    expect(container!.textContent).toContain(
      "This invitation attaches a legal agreement.",
    );
    // Outside the disclosure, by structure ...
    expect(panelFor("Other details").textContent).not.toContain(
      "attaches a legal agreement",
    );
    // ... while the agreement detail (its reference) stays inside it.
    expect(panelFor("Other details").textContent).toContain("MOU-2025-0042");
  });

  test("no legal-agreement hint when the invitation attaches none", async () => {
    render({ ...terms, legalAgreement: undefined });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(container!.textContent).not.toContain("attaches a legal agreement");
  });
});
