/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import { InvitationTerms } from "@components/InvitationTerms";

import type { Root } from "react-dom/client";

import type { LinkageStrategy, LinkageTerms } from "@psilink/core";

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
  linkageStrategy: "cascade",
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

    // The matching list is itself a default-collapsed "Matching strategies"
    // disclosure: it starts collapsed and its per-key disclosures are unreachable
    // until it is opened.
    await expect.element(toggle("Matching strategies")).toBeInTheDocument();
    expect(
      toggle("Matching strategies").element().getAttribute("aria-expanded"),
    ).toBe("false");
    expect(toggle("SSN + FN1").query()).toBeNull();

    // Open it to reach the per-key disclosures nested inside.
    await userEvent.click(toggle("Matching strategies"));

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

    // Each key's header one-liner is the honest anchor: shown beside the key name
    // (not buried in the key's own collapsed rule body). The truncated element
    // carries the "(partial)" breadth marker, the exact key carries none.
    expect(container!.textContent).toContain(
      "Matches on SSN - first name (partial)",
    );
    expect(container!.textContent).toContain(
      "Matches on SSN - last name - date of birth",
    );
    expect(panelFor("SSN + FN1").textContent).not.toContain("(partial)");
  });

  test("the fields matched on are summarized always-visible, outside the collapsed matching list", async () => {
    renderTerms();
    await expect.element(toggle("Matching strategies")).toBeInTheDocument();
    // The matching list is collapsed by default ...
    expect(
      toggle("Matching strategies").element().getAttribute("aria-expanded"),
    ).toBe("false");
    // ... yet the unique fields the keys match on are stated in the always-visible
    // core, so an acceptor sees WHICH data is matched on without expanding (deduped
    // in first-appearance order: ssn, last_name, dob from key 1, then first_name).
    expect(container!.textContent).toContain(
      "Matching on SSN, last name, date of birth, first name.",
    );
    // Structurally outside the disclosure: the summary is not inside the matching
    // panel, which carries the collapsed per-key detail even while hidden.
    expect(panelFor("Matching strategies").textContent).not.toContain(
      "Matching on SSN, last name, date of birth, first name.",
    );
  });

  test("opening one key disclosure exposes its detail to AT and leaves the others collapsed", async () => {
    renderTerms();

    // Open the matching list, then one key inside it.
    await userEvent.click(toggle("Matching strategies"));
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
    // Open the matching list so the per-key disclosure is reachable.
    await userEvent.click(toggle("Matching strategies"));
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
    // Open the matching list so its nested per-key disclosures are mounted and
    // counted alongside the top-level disclosures.
    await userEvent.click(toggle("Matching strategies"));

    const ids = Array.from(container!.querySelectorAll("[aria-controls]")).map(
      (el) => el.getAttribute("aria-controls"),
    );
    // The "Matching strategies" disclosure, its two nested per-key disclosures, and
    // the master "Other details" disclosure.
    expect(ids.length).toBe(4);
    expect(new Set(ids).size).toBe(4);
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

describe("InvitationTerms: a key disclosure stays mounted but hidden under a reduced-motion preference", () => {
  // Since Mantine 9.4 a closed Collapse no longer unmounts its panel for a
  // reduced-motion user: it keeps the panel mounted inside a hidden React Activity
  // boundary and hides it with display:none (rather than the height animation plus
  // aria-hidden + inert it uses with motion). display:none keeps the collapsed
  // detail out of sight, the accessibility tree, and the tab order all the same.
  // Force the reduced-motion configuration -- the OS signal (matchMedia) and the
  // theme switch that honors it -- and assert each disclosure's panel is present,
  // hidden, and its aria-controls still resolves to its wrapper.
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

  test("every disclosure's aria-controls resolves to a present, hidden panel while collapsed under reduced motion", async () => {
    root!.render(
      createElement(
        MantineProvider,
        { theme: { respectReducedMotion: true } },
        createElement(InvitationTerms, { linkageTerms: terms }),
      ),
    );

    // The always-mounted-wrapper design for every disclosure. The top-level ones
    // are the matching list ("Matching strategies") and the master "Other details";
    // the per-key widgets live nested inside "Matching strategies" and are exercised
    // after it is opened. Since Mantine 9.4 a closed Collapse under reduced motion
    // keeps the collapsed detail out of sight one of two ways depending on the
    // environment -- it unmounts the panel, or it keeps it mounted in a hidden
    // React Activity boundary (display:none) -- and both leave the detail out of the
    // accessibility tree and the tab order. The durable invariant across both is
    // that the wrapper holding aria-controls stays a present element, so the
    // reference never dangles (the reason the id lives on the wrapper, not the
    // panel). Assert that, after waiting for the reduced-motion media effect to
    // collapse the panel away.
    async function expectResolvableCollapsedWrapper(name: string) {
      await expect.element(toggle(name)).toBeInTheDocument();
      expect(toggle(name).element().getAttribute("aria-expanded")).toBe(
        "false",
      );
      const id = toggle(name).element().getAttribute("aria-controls");
      expect(id).toBeTruthy();
      // Wait for the post-mount reduced-motion effect to settle: the closed panel
      // is then either gone (unmounted) or hidden (display:none).
      await expect
        .poll(() => {
          const panel = document.getElementById(id!)
            ?.firstElementChild as HTMLElement | null;
          return panel === null || getComputedStyle(panel).display === "none";
        })
        .toBe(true);
      // ... and through it all the wrapper stays present, so aria-controls resolves.
      expect(document.getElementById(id!)).not.toBeNull();
    }

    for (const name of ["Matching strategies", "Other details"])
      await expectResolvableCollapsedWrapper(name);

    // Open the matching list so its per-key disclosures mount, then assert each
    // closed per-key wrapper likewise stays a resolvable target.
    await userEvent.click(toggle("Matching strategies"));
    for (const name of ["SSN + LN + DOB", "SSN + FN1"])
      await expectResolvableCollapsedWrapper(name);
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

describe("InvitationTerms: a declared-empty receive is surfaced, not collapsed with lazy", () => {
  // Mirror of the send-side "(none)" treatment: an authored empty payload.receive
  // is the strict "the acceptor sends nothing" assertion, which the consent screen
  // must show rather than confuse with the lazy (undeclared) case -- the latter
  // accepts whatever the acceptor discloses. Before this, the receive side rendered
  // only a non-empty list, so a declared-empty receive was invisible.
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

  test("a declared-empty receive shows the request as (none) in the detail", async () => {
    render({ ...terms, payload: { receive: [] } });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    const panel = panelFor("Other details");
    expect(panel.textContent).toContain("Your partner requests from you:");
    expect(panel.textContent).toContain("(none)");
  });

  test("a lazy (undeclared) receive renders no request line", async () => {
    // Send is declared so the block still renders, but with no receive line: an
    // absent receive is lazy, not a request, and must not read as "(none)".
    render({ ...terms, payload: { send: [{ name: "risk_score" }] } });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(panelFor("Other details").textContent).not.toContain(
      "requests from you",
    );
  });

  test("the inviter's own preview frames a declared-empty receive as its own request", async () => {
    render({ ...terms, payload: { receive: [] } }, "proposing");
    await expect.element(toggle("Other details")).toBeInTheDocument();
    const panel = panelFor("Other details");
    expect(panel.textContent).toContain("You request from your partner:");
    expect(panel.textContent).toContain("(none)");
  });
});

describe("InvitationTerms: the linkage strategy is surfaced at the consent point", () => {
  // The acceptor adopts the inviter's strategy (mandatory-consistency), and
  // single-pass is disclosure-affecting, so the note lives in the always-visible
  // core -- the acceptor must see the added disclosure before consenting. cascade,
  // the baseline that discloses less, is not flagged.
  function render(
    linkageStrategy: LinkageStrategy,
    perspective?: "review" | "accepted" | "proposing",
  ) {
    root!.render(
      createElement(
        MantineProvider,
        null,
        createElement(InvitationTerms, {
          linkageTerms: { ...terms, linkageStrategy },
          ...(perspective ? { perspective } : {}),
        }),
      ),
    );
  }

  test("single-pass is flagged always-visible, outside the 'Other details' disclosure", async () => {
    render("single-pass");
    await expect.element(toggle("Other details")).toBeInTheDocument();
    // On screen without expanding any disclosure -- the acceptor sees the added
    // disclosure before consenting.
    expect(container!.textContent).toContain(
      "This exchange uses single-pass linkage.",
    );
    // ... and OUTSIDE the "Other details" panel (structure, not styling).
    expect(panelFor("Other details").textContent).not.toContain(
      "This exchange uses single-pass linkage.",
    );
    // Stated viewer-neutrally: the acceptor itself could be the disclosing party.
    expect(container!.textContent).toContain("so it may be you");
  });

  test("cascade (the baseline) surfaces no strategy note", async () => {
    render("cascade");
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(container!.textContent).not.toContain("single-pass linkage");
  });

  test("the note also appears in the inviter's own proposing preview", async () => {
    // The note is viewer-neutral and not perspective-gated, so the inviter's editor
    // preview (proposing) shows the same note the acceptor will read -- the editor's
    // "author against what the partner sees" intent, and consistent with how the
    // egress/legal presence hints also render across perspectives. Pinned so the
    // note is not later narrowed to the acceptor perspectives only.
    render("single-pass", "proposing");
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(container!.textContent).toContain(
      "This exchange uses single-pass linkage.",
    );
  });
});
