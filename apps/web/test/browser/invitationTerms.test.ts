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

// The "Before you consent" presence-hint region (role=group), or null when no hint
// fires and the region is not rendered. Scoping an absence assertion to this region
// avoids false matches against the similarly-worded lines elsewhere on the screen:
// the "You will receive the matched result" line in Result sharing, and the "Your
// partner will send:" / "Your partner requests from you:" detail lines inside "Other
// details". It is the only role=group carrying aria-labelledby on the screen.
function hintGroup(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="group"][aria-labelledby]');
}

// Mantine 9's Collapse keeps a collapsed panel's content mounted inside a React
// Activity (mode="hidden") boundary, which React commits at a DEFERRED priority.
// Under load that commit can lag the always-visible core, so reading a panel
// synchronously races it -- an empty textContent, or a not-yet-present Collapse
// child. Resolve a panel only once its content has committed, so a collapsed-
// content assertion waits the deferral out rather than sampling an empty panel
// (every disclosure here has content, so this always settles). The synchronous
// reads this replaces are why the suite flaked under full-suite CPU contention.
//
// Gating on non-empty (rather than on each asserted substring) suffices because
// React commits the hidden subtree atomically -- empty, then fully populated in
// one pass -- so a non-empty panel is a fully-rendered one; a toContain cannot
// read a torn commit and a not-toContain cannot pass on half-rendered content. A
// disclosure body that nested its own Suspense/Activity/lazy boundary would split
// that commit and need a stricter, substring-specific gate.
async function readyPanel(name: string): Promise<HTMLElement> {
  await expect
    .poll(() => {
      // query(), not element(): a not-yet-present toggle is the expected transient
      // (query returns null), while an unexpected fault -- e.g. a strict-mode
      // multiple match -- still throws out of the poll rather than being swallowed.
      const id = toggle(name).query()?.getAttribute("aria-controls");
      const panel = id ? document.getElementById(id) : null;
      // trim so a whitespace-only intermediate render does not read as settled.
      return panel?.textContent.trim() ?? "";
    })
    .not.toBe("");
  // panelFor re-resolves the same node: the id lives on an always-mounted wrapper
  // the component never unmounts, so it cannot have been swapped since the poll.
  return panelFor(name);
}

// The Mantine Collapse element inside a ready panel -- the aria-hidden + inert host
// -- resolved only after its content has committed (see readyPanel).
async function readyCollapse(name: string): Promise<HTMLElement> {
  await readyPanel(name);
  return collapseFor(name);
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
    const collapse = await readyCollapse("SSN + FN1");
    expect(collapse.getAttribute("aria-hidden")).toBe("true");
    expect(collapse.hasAttribute("inert")).toBe(true);

    // The per-element rule detail (the literal slice phrase) lives in the
    // collapsed body, not the always-visible header.
    const truncatedPanel = await readyPanel("SSN + FN1");
    expect(truncatedPanel.textContent).toContain(
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
    expect(truncatedPanel.textContent).not.toContain("(partial)");
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
    expect((await readyPanel("Matching strategies")).textContent).not.toContain(
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
    const opened = await readyCollapse("SSN + FN1");
    expect(opened.getAttribute("aria-hidden")).toBe("false");
    expect(opened.hasAttribute("inert")).toBe(false);

    // Independent disclosure state: the other key stays collapsed.
    expect(
      toggle("SSN + LN + DOB").element().getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      (await readyCollapse("SSN + LN + DOB")).getAttribute("aria-hidden"),
    ).toBe("true");
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

    // The nested per-key toggles mount inside the now-expanded matching panel,
    // whose content React commits at a deferred priority -- wait for all four
    // disclosures to be present before counting them.
    await expect
      .poll(() => container!.querySelectorAll("[aria-controls]").length)
      .toBe(4);
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
    const masterCollapse = await readyCollapse("Other details");
    expect(masterCollapse.getAttribute("aria-hidden")).toBe("true");
    expect(masterCollapse.hasAttribute("inert")).toBe(true);

    // The non-key blocks (field constraints, payload, legal agreement, dedup) are
    // in the master disclosure ...
    const panel = await readyPanel("Other details");
    expect(panel.textContent).toContain(
      "allowed-character pattern (partner-supplied regular expression, not verified by psilink): A-Z",
    );
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
    // exact rendered copy: a presence assertion of the full sentence). The line
    // leads with the actor and direction ("Your partner requests ... from you"), so
    // it is not confusable with the opposite-direction ingress line.
    expect(container!.textContent).toContain(
      "Your partner requests 2 data columns from you.",
    );
    // ... and OUTSIDE the disclosure (structure, not styling): the hint text is
    // not inside the "Other details" panel, which carries the collapsed detail
    // even while hidden.
    const panel = await readyPanel("Other details");
    expect(panel.textContent).not.toContain(
      "Your partner requests 2 data columns from you",
    );
    // The column NAMES themselves stay one expand down in the disclosure -- the
    // hint surfaces only the count, not the detail.
    expect(panel.textContent).toContain("zip_code");
  });

  test("the egress hint reads singular for a single requested column", async () => {
    render({
      ...terms,
      payload: { send: [], receive: [{ name: "ssn" }] },
    });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(container!.textContent).toContain(
      "Your partner requests 1 data column from you.",
    );
  });

  test("the egress hint reads first-person in the inviter's own preview", async () => {
    // Under "proposing" the viewer is the inviter, so the egress reads as its own
    // request of its partner ("You request ... from your partner").
    render(
      {
        ...terms,
        payload: { send: [], receive: [{ name: "ssn" }, { name: "zip_code" }] },
      },
      "proposing",
    );
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(container!.textContent).toContain(
      "You request 2 data columns from your partner.",
    );
  });

  test("no egress hint when the inviter requests no columns from the acceptor", async () => {
    // The module terms request nothing from the acceptor (receive: []), though they
    // do send a column and attach an agreement -- so the hint group renders, without
    // the egress line. Scope the absence to the group so the Details "Your partner
    // requests from you:" line (a declared-empty receive) is not mistaken for it.
    render(terms);
    await expect.element(toggle("Other details")).toBeInTheDocument();
    const group = hintGroup();
    expect(group).not.toBeNull();
    expect(group!.textContent).not.toContain("requests");
  });

  test("the legal-agreement hint surfaces presence in the always-visible core, outside the 'Other details' disclosure", async () => {
    // The module terms attach a legal agreement (the legal hint shows alongside the
    // ingress hint the module's single sent column raises).
    render(terms);
    await expect.element(toggle("Other details")).toBeInTheDocument();

    expect(container!.textContent).toContain(
      "This invitation attaches a legal agreement.",
    );
    // Outside the disclosure, by structure ...
    const panel = await readyPanel("Other details");
    expect(panel.textContent).not.toContain("attaches a legal agreement");
    // ... while the agreement detail (its reference) stays inside it.
    expect(panel.textContent).toContain("MOU-2025-0042");
  });

  test("no legal-agreement hint when the invitation attaches none", async () => {
    render({ ...terms, legalAgreement: undefined });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(container!.textContent).not.toContain("attaches a legal agreement");
  });
});

describe("InvitationTerms: always-visible ingress presence hint", () => {
  // The ingress companion to the egress hint: an always-visible count of the
  // columns the invitation will SEND the acceptor for matched records (inbound
  // partner data), surfaced in the core so the acceptor is on notice before
  // expanding "Other details". Weaker than the egress hint -- receiving is not a
  // disclosure by the acceptor -- so it fires only on a non-empty send and never in
  // the inviter's own "proposing" preview (which shows its send as chips instead).
  function render(
    linkageTerms: LinkageTerms,
    options?: {
      perspective?: "review" | "accepted" | "proposing";
      disclosedPayloadColumns?: Array<string>;
    },
  ) {
    root!.render(
      createElement(
        MantineProvider,
        null,
        createElement(InvitationTerms, {
          linkageTerms,
          ...(options?.perspective ? { perspective: options.perspective } : {}),
          ...(options?.disclosedPayloadColumns !== undefined
            ? { disclosedPayloadColumns: options.disclosedPayloadColumns }
            : {}),
        }),
      ),
    );
  }

  test("the ingress hint surfaces a column count in the always-visible core, outside the 'Other details' disclosure", async () => {
    // Two columns the inviter will send the acceptor for matched records.
    render({
      ...terms,
      payload: {
        send: [{ name: "risk_score" }, { name: "diagnosis" }],
        receive: [],
      },
    });
    await expect.element(toggle("Other details")).toBeInTheDocument();

    // The presence/count hint is on screen ... (the trailing period pins the exact
    // rendered copy: a presence assertion of the full sentence). It leads with "You
    // will receive ... from your partner", the opposite direction from the egress
    // line, so the two adjacent count lines are not confusable.
    expect(container!.textContent).toContain(
      "You will receive 2 data columns from your partner.",
    );
    // ... and OUTSIDE the disclosure (structure, not styling): the hint text is not
    // inside the "Other details" panel, which carries the collapsed detail even
    // while hidden.
    const panel = await readyPanel("Other details");
    expect(panel.textContent).not.toContain(
      "You will receive 2 data columns from your partner",
    );
    // The column NAMES themselves stay one expand down in the disclosure -- the hint
    // surfaces only the count, not the detail.
    expect(panel.textContent).toContain("diagnosis");
  });

  test("the ingress hint reads singular for a single sent column", async () => {
    // The module terms send a single column (risk_score).
    render(terms);
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(container!.textContent).toContain(
      "You will receive 1 data column from your partner.",
    );
  });

  test("the count derives from the actually-transmitted set carried on the token", async () => {
    // disclosedPayloadColumns is the inviter's own disclosure predicate output --
    // exactly the set that flows -- so the hint counts it, not the authored
    // payload.send (a single column here). Three transmitted columns => count 3.
    render(terms, {
      disclosedPayloadColumns: ["ssn", "zip_code", "phone_number"],
    });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(container!.textContent).toContain(
      "You will receive 3 data columns from your partner.",
    );
  });

  test("the declared-empty 'receive nothing' lock-in raises no ingress hint", async () => {
    // A carried-but-empty disclosed set is the strict "(none)" lock-in: there is no
    // incoming data to flag, so the hint is absent even though the send is DECLARED.
    // Scope the absence to the hint group -- Result sharing's "You will receive the
    // matched result" line would false-match a whole-container search.
    render(terms, { disclosedPayloadColumns: [] });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    const group = hintGroup();
    expect(group).not.toBeNull();
    expect(group!.textContent).not.toContain("You will receive");
    // ... yet the declared-empty send still shows "(none)" in the detail, confirming
    // this is the lock-in case (distinct from lazy, which omits the send line).
    const panel = await readyPanel("Other details");
    expect(panel.textContent).toContain("Your partner will send:");
    expect(panel.textContent).toContain("(none)");
  });

  test("a lazy (undeclared) send raises no ingress hint", async () => {
    // No send authored and no disclosed set carried: the inviter sends whatever its
    // own metadata discloses (lazy), nothing declared up front, so nothing to flag.
    render({ ...terms, payload: { receive: [] } });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    const group = hintGroup();
    expect(group).not.toBeNull();
    expect(group!.textContent).not.toContain("You will receive");
  });

  test("the inviter's own proposing preview shows no ingress hint (its send is already chips)", async () => {
    // Receiving-partner framing is acceptor-only. The inviter's preview surfaces its
    // send as chips in the core already, so the presence is not hidden in Details and
    // the hint is omitted -- an acceptor-framed "you will receive" line would be
    // wrong for the inviter there.
    render(terms, { perspective: "proposing" });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    const group = hintGroup();
    expect(group).not.toBeNull();
    expect(group!.textContent).not.toContain("You will receive");
    // The send presence is instead surfaced as the proposing chips, so it is not
    // lost -- just carried differently for the inviter's own view.
    expect(container!.textContent).toContain("Columns sent to your partner");
  });
});

describe("InvitationTerms: the acceptor's outbound-disclosure forward-reference", () => {
  // On the pre-consent review screen the acceptor's own send list is not yet known
  // (outboundColumns undefined, before a file is chosen), yet what it discloses is
  // its highest-stakes payload fact and consent is given on this screen. A fixed-copy
  // forward-reference stands in the send list's slot until a file is chosen, so the
  // acceptor knows at the decision point that an outbound disclosure is coming and
  // that it confirms the exact columns after choosing its file. It must not co-exist
  // with the actual send list (the acceptor is not told "confirm later" once it has
  // the list), and is absent from the inviter's own preview.
  function render(options?: {
    perspective?: "review" | "accepted" | "proposing";
    outboundColumns?: Array<string>;
  }) {
    root!.render(
      createElement(
        MantineProvider,
        null,
        createElement(InvitationTerms, {
          linkageTerms: terms,
          ...(options?.perspective ? { perspective: options.perspective } : {}),
          ...(options?.outboundColumns !== undefined
            ? { outboundColumns: options.outboundColumns }
            : {}),
        }),
      ),
    );
  }

  // The full fixed sentence, so a copy edit that drops the "confirm ... after
  // choosing your file" forward-reference fails this assertion.
  const forwardReference =
    "After you choose your file, you will confirm exactly which of its columns " +
    "are sent to your partner for matched records.";

  test("appears on the review screen when the outbound columns are not yet known", async () => {
    // perspective review, outboundColumns undefined (no file chosen yet).
    render({ perspective: "review" });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(container!.textContent).toContain(forwardReference);
    // In the always-visible core, not the collapsed detail: it must be legible at
    // the consent point without expanding "Other details". (Its fixed copy naming no
    // count or names is pinned by the exact-sentence match above -- a copy edit that
    // injected either would change the string and fail it.)
    expect((await readyPanel("Other details")).textContent).not.toContain(
      forwardReference,
    );
  });

  test("gives way to the actual send list once the outbound columns are known", async () => {
    // A chosen file supplies outboundColumns: the real send list renders (the
    // acceptor's own header, sanitized as chips) and the forward-reference must not
    // also show.
    render({ perspective: "accepted", outboundColumns: ["risk_score"] });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(container!.textContent).not.toContain(forwardReference);
    expect(container!.textContent).toContain("risk_score");
  });

  test("gives way even to an empty (chosen-file, nothing-sent) send confirmation", async () => {
    // outboundColumns [] is a chosen file that sends nothing: the explicit "no
    // columns are sent" confirmation renders, so the forward-reference must not --
    // the set IS known (to be empty), the decision no longer pending.
    render({ perspective: "accepted", outboundColumns: [] });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(container!.textContent).not.toContain(forwardReference);
    expect(container!.textContent).toContain(
      "No columns are sent to your partner",
    );
  });

  test("is absent under the inviter's own proposing preview", async () => {
    // The inviter's send already renders as chips ("Columns sent to your partner");
    // the acceptor-framed forward-reference would be wrong for it. outboundColumns is
    // undefined here too, so the review-only gate -- not merely the undefined check
    // -- is what suppresses it.
    render({ perspective: "proposing" });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(container!.textContent).not.toContain(forwardReference);
    expect(container!.textContent).toContain("Columns sent to your partner");
  });
});

describe("InvitationTerms: the outbound-send caption does not presuppose a non-empty send", () => {
  // The caption above the acceptor's own outbound disclosure is a topic phrase
  // ("What you will send to your partner"), not the declarative "Columns you will
  // send ..." it replaced: that presupposed a non-empty send, so it contradicted its
  // own empty-send body ("No columns are sent ...") and over-asserted a definite send
  // on the pre-file review screen, where the set is not yet known. These pin that the
  // caption reads truthfully over both branches -- and that the presupposing phrasing
  // does not creep back at either call site.
  function render(options: {
    perspective: "review" | "accepted";
    outboundColumns?: Array<string>;
  }) {
    root!.render(
      createElement(
        MantineProvider,
        null,
        createElement(InvitationTerms, {
          linkageTerms: terms,
          perspective: options.perspective,
          ...(options.outboundColumns !== undefined
            ? { outboundColumns: options.outboundColumns }
            : {}),
        }),
      ),
    );
  }

  const caption = "What you will send to your partner";
  // The declarative phrasing this reword removed. Asserted absent so a revert that
  // reintroduces the presupposition fails, rather than passing on the "send to your
  // partner" tail both phrasings share.
  const presupposingCaption = "Columns you will send to your partner";

  test("reads as a topic phrase, not a definite send, above the empty-send confirmation", async () => {
    // A chosen file that sends nothing (outboundColumns []): the caption sits above
    // the explicit "No columns are sent ..." body. The topic phrasing no longer
    // contradicts that body the way the old declarative caption did.
    render({ perspective: "accepted", outboundColumns: [] });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(container!.textContent).toContain(caption);
    expect(container!.textContent).toContain(
      "No columns are sent to your partner",
    );
    expect(container!.textContent).not.toContain(presupposingCaption);
  });

  test("stays truthful on the pre-file review screen, where the send set is not yet known", async () => {
    // perspective review, outboundColumns undefined: the forward-reference stands in
    // for the not-yet-known send, and the caption above it must not assert a definite
    // send at the consent decision point.
    render({ perspective: "review" });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(container!.textContent).toContain(caption);
    expect(container!.textContent).not.toContain(presupposingCaption);
  });
});

describe("InvitationTerms: the presence hints form a labelled, disclosure-linked group", () => {
  // The a11y contract for the presence-hint block: it is one named group (so a
  // screen reader announces the flagged facts as a related set, not disconnected
  // sentences), and the "Other details" toggle is described by it (so a non-visual
  // user reaching that toggle hears what expands there). Pinning both so the block
  // cannot regress to bare, unassociated sibling text.
  function render(
    linkageTerms: LinkageTerms,
    options?: {
      perspective?: "review" | "accepted" | "proposing";
      disclosedPayloadColumns?: Array<string>;
    },
  ) {
    root!.render(
      createElement(
        MantineProvider,
        null,
        createElement(InvitationTerms, {
          linkageTerms,
          ...(options?.perspective ? { perspective: options.perspective } : {}),
          ...(options?.disclosedPayloadColumns !== undefined
            ? { disclosedPayloadColumns: options.disclosedPayloadColumns }
            : {}),
        }),
      ),
    );
  }

  test("the hints are one group named 'Before you consent' carrying all flagged facts", async () => {
    // Egress, ingress, and legal all present: the group holds the three lines under
    // a single accessible name.
    render({
      ...terms,
      payload: { send: [{ name: "risk_score" }], receive: [{ name: "ssn" }] },
    });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    const group = page.getByRole("group", { name: "Before you consent" });
    await expect.element(group).toBeInTheDocument();
    const el = group.element();
    expect(el.textContent).toContain(
      "Your partner requests 1 data column from you.",
    );
    expect(el.textContent).toContain(
      "You will receive 1 data column from your partner.",
    );
    expect(el.textContent).toContain(
      "This invitation attaches a legal agreement.",
    );
  });

  test("the 'Other details' toggle is described by the hint group's caption", async () => {
    render({
      ...terms,
      payload: { send: [{ name: "risk_score" }], receive: [] },
    });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    const button = toggle("Other details").element();
    const describedById = button.getAttribute("aria-describedby");
    expect(describedById).toBeTruthy();
    const region = document.getElementById(describedById!);
    // A concise one-phrase pointer, not a re-read of every hint line onto the
    // toggle: the description is the group's caption alone. Pinning `toBe` guards
    // against the aria-describedby being re-broadened to the whole group.
    expect(region?.textContent).toBe("Before you consent");
  });

  test("the toggle carries no dangling describedby when no hint fires", async () => {
    // No payload and no legal agreement: the group is not rendered, so the toggle
    // must not reference an absent region.
    render({ ...terms, payload: undefined, legalAgreement: undefined });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(hintGroup()).toBeNull();
    expect(
      toggle("Other details").element().getAttribute("aria-describedby"),
    ).toBeNull();
  });

  test("the group caption frames the inviter's own proposing preview", async () => {
    // Under "proposing" the caption addresses the inviter about its partner.
    render(
      { ...terms, payload: { send: [], receive: [{ name: "ssn" }] } },
      { perspective: "proposing" },
    );
    await expect.element(toggle("Other details")).toBeInTheDocument();
    await expect
      .element(
        page.getByRole("group", { name: "Before your partner consents" }),
      )
      .toBeInTheDocument();
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
    const panel = await readyPanel("Other details");
    expect(panel.textContent).toContain("Your partner requests from you:");
    expect(panel.textContent).toContain("(none)");
    // The "(none)" names its strict consequence rather than reading as innocuous.
    expect(panel.textContent).toContain("would abort the exchange");
  });

  test("a lazy (undeclared) receive renders no request line", async () => {
    // Send is declared so the block still renders, but with no receive line: an
    // absent receive is lazy, not a request, and must not read as "(none)".
    render({ ...terms, payload: { send: [{ name: "risk_score" }] } });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect((await readyPanel("Other details")).textContent).not.toContain(
      "requests from you",
    );
  });

  test("the inviter's own preview frames a declared-empty receive as its own request", async () => {
    render({ ...terms, payload: { receive: [] } }, "proposing");
    await expect.element(toggle("Other details")).toBeInTheDocument();
    const panel = await readyPanel("Other details");
    expect(panel.textContent).toContain("You request from your partner:");
    expect(panel.textContent).toContain("(none)");
    expect(panel.textContent).toContain("would abort the exchange");
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
    expect((await readyPanel("Other details")).textContent).not.toContain(
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
