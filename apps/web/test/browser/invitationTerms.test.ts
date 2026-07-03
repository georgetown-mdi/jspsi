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

// A named direction/governance group in the always-visible core. The core is tiered
// into labelled groups (role=group + aria-labelledby) -- "What you disclose", "What
// you receive", "What the exchange produces", and the legal-agreement governance
// group -- so a fact is asserted against the tier it belongs to rather than against
// the whole container. Locating by role+name (not a bare [role=group] querySelector)
// keeps an absence assertion from false-matching the similarly-worded lines elsewhere
// on the screen: the "You will receive the matched result" line in Result sharing,
// and the "Your partner will send:" / "Your partner requests from you:" detail lines
// inside "Other details".
function group(name: string) {
  return page.getByRole("group", { name });
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

    // The non-key blocks (field constraints, payload, dedup) are in the master
    // disclosure ...
    const panel = await readyPanel("Other details");
    expect(panel.textContent).toContain(
      "allowed-character pattern (partner-supplied regular expression, not verified by psilink): A-Z",
    );
    expect(panel.textContent).toContain("risk_score");
    expect(panel.textContent).toContain("may match more than one");
    // ... the legal agreement is NOT among them: it is promoted whole into the
    // always-visible core, so its reference no longer sits in the disclosure ...
    expect(panel.textContent).not.toContain("MOU-2025-0042");
    // ... and the per-key matching detail moved out, into the key's own
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

describe("InvitationTerms: the counterparty identity is flagged unverified at consent", () => {
  // At the pre-consent review screen the displayed "Invitation from <name>" is a
  // free-text field the sender typed, carried in an invitation accepted on a
  // transcription checksum -- so psilink has not authenticated it. A terse marker
  // keeps the acceptor from reading it as a psilink-verified fact; it is a small
  // honesty marker on a self-asserted field, not a directive (parties normally
  // coordinate the first exchange out of band, so they already know the
  // counterparty). Review-only: the note is a pre-consent decision-point marker, so it
  // is dropped on the during-run "accepted" view once consent is committed (the run's
  // handshake authenticates the peer's secret, not that the name is true), and the
  // inviter's "proposing" preview shows its OWN identity (which needs no such note).
  function render(perspective?: "review" | "accepted" | "proposing") {
    root!.render(
      createElement(
        MantineProvider,
        null,
        createElement(InvitationTerms, {
          linkageTerms: terms,
          ...(perspective ? { perspective } : {}),
        }),
      ),
    );
  }

  const noteText =
    "Your partner entered this name; psilink has not verified it.";

  test("the unverified-identity note appears on the acceptor review screen", async () => {
    render("review");
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();
    // The self-asserted name is marked unverified, in the always-visible core ...
    expect(container!.textContent).toContain(noteText);
    // ... not tucked inside the "Other details" disclosure.
    expect((await readyPanel("Other details")).textContent).not.toContain(
      noteText,
    );
  });

  test("the note is associated with the identity heading for assistive tech", async () => {
    // The screen moves focus to the identity heading when the terms appear, and a
    // screen-reader user may also jump straight to it by heading -- so the caveat is
    // wired as the heading's aria-describedby (the same subline-to-target idiom the
    // disclosure toggles use) rather than left as a loose sibling paragraph that the
    // announcement would not carry.
    render("review");
    const heading = page.getByRole("heading", {
      name: "Invitation from County Health Department",
    });
    await expect.element(heading).toBeInTheDocument();
    const describedById = heading.element().getAttribute("aria-describedby");
    expect(describedById).toBeTruthy();
    const note = document.getElementById(describedById!);
    expect(note?.textContent).toContain(noteText);
  });

  test("the note is absent from the inviter's own proposing preview", async () => {
    // Under "proposing" the identity shown is the viewer's own, so a "not verified"
    // caveat would be wrong; the heading is "Exchange proposal", not "Invitation
    // from <self>".
    render("proposing");
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(container!.textContent).not.toContain(noteText);
  });

  test("the note is absent from the during-run accepted view, after consent is committed", async () => {
    // The "accepted" view is the during-run view, after the acceptor has already
    // consented; the note is scoped to the pre-consent decision point, so it is
    // dropped there. Not because the name becomes verified -- the run's handshake
    // authenticates the peer's secret, not that the name is true -- but because the
    // decision the note informs is past.
    render("accepted");
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(container!.textContent).not.toContain(noteText);
    // The note is absent here, so the identity heading must not carry a dangling
    // aria-describedby pointing at a note that no longer renders.
    expect(
      page
        .getByRole("heading", {
          name: "Invitation from County Health Department",
        })
        .element()
        .getAttribute("aria-describedby"),
    ).toBeNull();
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
    // The acceptor's OWN non-receipt is a hard fact -- enforced by this tool, not a
    // matter of trusting the partner -- so its "No" carries the enforced caveat.
    expect(container!.textContent).toContain(
      "Enforced: you are sent no result",
    );
    // The partner receives here (Yes), so no cooperative caveat renders.
    expect(container!.textContent).not.toContain("By agreement, not enforced");
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
    // The PARTNER's non-receipt is cooperative -- it rests on the terms being
    // honored, not a guarantee this side imposes -- so its "No" is marked distinctly
    // from an enforced one, and the acceptor's own "Yes" carries no enforced caveat.
    expect(container!.textContent).toContain("By agreement, not enforced");
    expect(container!.textContent).not.toContain("Enforced: you are sent no");
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
    // The proposer's partner does not receive: a cooperative "No", so it carries the
    // by-agreement caveat and the proposer's own "Yes" carries none.
    expect(container!.textContent).toContain("By agreement, not enforced");
    expect(container!.textContent).not.toContain("Enforced: you are sent no");
  });

  test("a symmetric both-receive exchange qualifies neither result line", async () => {
    // Both parties receive: two "Yes" lines, so neither the enforced nor the
    // cooperative caveat renders -- the registers are marked only on a withholding.
    renderOutput({ expectsOutput: true, shareWithPartner: true });
    await expect.element(page.getByText("Result sharing")).toBeInTheDocument();
    expect(container!.textContent).toContain(
      "You will receive the matched result: Yes",
    );
    expect(container!.textContent).toContain(
      "Your partner (the inviter) will receive the result: Yes",
    );
    expect(container!.textContent).not.toContain("Enforced: you are sent no");
    expect(container!.textContent).not.toContain("By agreement, not enforced");
  });
});

describe("InvitationTerms: always-visible egress and legal-agreement facts, tiered by direction", () => {
  // Render a chosen terms object under the given perspective. These facts live in the
  // always-visible core, each under the direction tier it belongs to; the detail they
  // count stays in the "Other details" disclosure.
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

  test("the egress count lands in the 'What you disclose' tier, outside the 'Other details' disclosure", async () => {
    // Two columns the inviter requests FROM the acceptor: the acceptor's egress -- its
    // own data leaving, so it belongs to the "what you disclose" direction.
    render({
      ...terms,
      payload: { send: [], receive: [{ name: "ssn" }, { name: "zip_code" }] },
    });
    await expect.element(toggle("Other details")).toBeInTheDocument();

    // The count is under the "What you disclose" group (accessibility tree, not
    // styling): the trailing period pins the exact rendered copy, and the line leads
    // with the actor and direction ("Your partner requests ... from you") so it is
    // not confusable with the opposite-direction ingress line.
    const disclose = group("What you disclose");
    await expect.element(disclose).toBeInTheDocument();
    expect(disclose.element().textContent).toContain(
      "Your partner requests 2 data columns from you.",
    );
    // ... and OUTSIDE the disclosure: the count is not inside the "Other details"
    // panel, which carries the collapsed detail even while hidden.
    const panel = await readyPanel("Other details");
    expect(panel.textContent).not.toContain(
      "Your partner requests 2 data columns from you",
    );
    // The column NAMES themselves stay one expand down in the disclosure -- the tier
    // surfaces only the count, not the detail.
    expect(panel.textContent).toContain("zip_code");
  });

  test("the egress count reads singular for a single requested column", async () => {
    render({
      ...terms,
      payload: { send: [], receive: [{ name: "ssn" }] },
    });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(container!.textContent).toContain(
      "Your partner requests 1 data column from you.",
    );
  });

  test("the egress count is the inviter's OWN inbound under 'proposing', so it lands in 'What you receive'", async () => {
    // Under "proposing" the viewer is the inviter: the same request is its own inbound
    // ("You request ... from your partner"), so it belongs to the inviter's "what you
    // receive" direction, not "what you disclose".
    render(
      {
        ...terms,
        payload: { send: [], receive: [{ name: "ssn" }, { name: "zip_code" }] },
      },
      "proposing",
    );
    await expect.element(toggle("Other details")).toBeInTheDocument();
    const receive = group("What you receive");
    await expect.element(receive).toBeInTheDocument();
    expect(receive.element().textContent).toContain(
      "You request 2 data columns from your partner.",
    );
  });

  test("no egress count when the inviter requests no columns from the acceptor", async () => {
    // The module terms request nothing from the acceptor (receive: []), though they
    // do send a column -- so the "What you disclose" tier still renders (the acceptor's
    // own outbound forward-reference), without any egress-request line. Scope the
    // absence to that tier so the Details "Your partner requests from you:" line (a
    // declared-empty receive) is not mistaken for it.
    render(terms);
    await expect.element(toggle("Other details")).toBeInTheDocument();
    const disclose = group("What you disclose");
    await expect.element(disclose).toBeInTheDocument();
    expect(disclose.element().textContent).not.toContain("requests");
  });

  test("the legal agreement is promoted whole into its own governance group, outside the 'Other details' disclosure", async () => {
    // The module terms attach a legal agreement. Its governance-load-bearing substance
    // -- reference, PURPOSE, and expiry -- is surfaced in the core as its own labelled
    // group (named by a short fixed "Legal agreement" aria-label, distinct from its
    // lead sentence so a screen reader does not read that sentence twice), not a bare
    // "attaches an agreement" flag, since the purpose is the field a 164.528 accounting
    // / FERPA exception turns on (docs/COMPLIANCE.md) and must be legible at the
    // consent point.
    render(terms);
    await expect.element(toggle("Other details")).toBeInTheDocument();

    const agreement = group("Legal agreement");
    await expect.element(agreement).toBeInTheDocument();
    const el = agreement.element();
    expect(el.textContent).toContain(
      "This invitation attaches a legal agreement.",
    );
    expect(el.textContent).toContain("Reference: MOU-2025-0042");
    expect(el.textContent).toContain("Stated purpose: Audit and evaluation");
    expect(el.textContent).toContain("Agreement valid through 2027-12-31");

    // The promoted block IS the whole of the agreement: it is not also duplicated
    // inside the "Other details" disclosure (structure, not styling). The reference
    // -- which formerly lived only in that disclosure -- is now absent from it.
    const panel = await readyPanel("Other details");
    expect(panel.textContent).not.toContain("attaches a legal agreement");
    expect(panel.textContent).not.toContain("MOU-2025-0042");
    expect(panel.textContent).not.toContain("Audit and evaluation");
  });

  test("no legal-agreement block when the invitation attaches none", async () => {
    render({ ...terms, legalAgreement: undefined });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    // Neither the flag lead nor any promoted field renders when there is no
    // agreement -- the whole block is gated on its presence.
    expect(container!.textContent).not.toContain("attaches a legal agreement");
    expect(container!.textContent).not.toContain("MOU-2025-0042");
    expect(container!.textContent).not.toContain("Audit and evaluation");
  });
});

describe("InvitationTerms: always-visible ingress count in the 'What you receive' tier", () => {
  // The ingress companion to the egress count: an always-visible count of the
  // columns the invitation will SEND the acceptor for matched records (inbound
  // partner data), surfaced in the "What you receive" tier so the acceptor is on
  // notice before expanding "Other details". Weaker than the egress count -- receiving
  // is not a disclosure by the acceptor -- so it fires only on a non-empty send and
  // never in the inviter's own "proposing" preview (which shows its send as chips in
  // "What you disclose" instead).
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

  test("the ingress count lands in the 'What you receive' tier, outside the 'Other details' disclosure", async () => {
    // Two columns the inviter will send the acceptor for matched records.
    render({
      ...terms,
      payload: {
        send: [{ name: "risk_score" }, { name: "diagnosis" }],
        receive: [],
      },
    });
    await expect.element(toggle("Other details")).toBeInTheDocument();

    // The count is under the "What you receive" group (accessibility tree, not
    // styling): the trailing period pins the exact rendered copy, and it leads with
    // "You will receive ... from your partner", the opposite direction from the egress
    // line, so the two count lines are not confusable.
    const receive = group("What you receive");
    await expect.element(receive).toBeInTheDocument();
    expect(receive.element().textContent).toContain(
      "You will receive 2 data columns from your partner.",
    );
    // ... and OUTSIDE the disclosure: the count is not inside the "Other details"
    // panel, which carries the collapsed detail even while hidden.
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

  test("the declared-empty 'receive nothing' lock-in raises no ingress count and no receive tier", async () => {
    // A carried-but-empty disclosed set is the strict "(none)" lock-in: there is no
    // incoming data to flag, so the count is absent even though the send is DECLARED.
    // With no ingress (and no request under review), the "What you receive" tier does
    // not render at all -- distinct from Result sharing's "You will receive the
    // matched result" line, which lives in the produce tier.
    render(terms, { disclosedPayloadColumns: [] });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(group("What you receive").query()).toBeNull();
    // ... yet the declared-empty send still shows "(none)" in the detail, confirming
    // this is the lock-in case (distinct from lazy, which omits the send line).
    const panel = await readyPanel("Other details");
    expect(panel.textContent).toContain("Your partner will send:");
    expect(panel.textContent).toContain("(none)");
  });

  test("a lazy (undeclared) send raises no ingress count and no receive tier", async () => {
    // No send authored and no disclosed set carried: the inviter sends whatever its
    // own metadata discloses (lazy), nothing declared up front, so nothing to flag and
    // no "What you receive" tier.
    render({ ...terms, payload: { receive: [] } });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(group("What you receive").query()).toBeNull();
  });

  test("the inviter's own proposing preview shows no ingress count (its send is chips in 'What you disclose')", async () => {
    // Receiving-partner framing is acceptor-only. The inviter's preview surfaces its
    // send as chips in "What you disclose" already, so the presence is not hidden in
    // Details and the acceptor-framed "you will receive" line is omitted (it would be
    // wrong for the inviter). The module terms request nothing (receive: []), so the
    // inviter has no inbound either and the "What you receive" tier does not render.
    render(terms, { perspective: "proposing" });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(group("What you receive").query()).toBeNull();
    // The send presence is instead surfaced as the proposing chips, so it is not
    // lost -- just carried under "What you disclose" for the inviter's own view.
    const disclose = group("What you disclose");
    await expect.element(disclose).toBeInTheDocument();
    expect(disclose.element().textContent).toContain(
      "Columns sent to your partner",
    );
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

describe("InvitationTerms: the always-visible facts are tiered into labelled direction groups", () => {
  // The a11y contract for the re-tiered core: each disclosure-relevant fact sits in a
  // labelled group (role=group + aria-labelledby) named for its disclosure direction
  // -- "What you disclose", "What you receive", "What the exchange produces" -- or, for
  // the cross-cutting legal agreement, its own governance group. A screen reader then
  // announces each fact under the tier it belongs to rather than as a flat run of
  // sibling sentences. The "Other details" toggle is separately self-describing (its
  // own summary), asserted below. Pinning the grouping so the core cannot regress to
  // one undifferentiated list.
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

  test("egress, ingress, and legal each land in the correct labelled group", async () => {
    // Egress (the acceptor's own data leaving), ingress (partner data arriving), and
    // the legal agreement all present: each is announced under the tier it belongs to,
    // not one flat "before you consent" list.
    render({
      ...terms,
      payload: { send: [{ name: "risk_score" }], receive: [{ name: "ssn" }] },
    });
    await expect.element(toggle("Other details")).toBeInTheDocument();

    // The egress request is the acceptor's own data leaving -> "What you disclose".
    const disclose = group("What you disclose");
    await expect.element(disclose).toBeInTheDocument();
    expect(disclose.element().textContent).toContain(
      "Your partner requests 1 data column from you.",
    );
    // The ingress is partner data arriving -> "What you receive".
    const receive = group("What you receive");
    await expect.element(receive).toBeInTheDocument();
    expect(receive.element().textContent).toContain(
      "You will receive 1 data column from your partner.",
    );
    // The legal agreement is a governance frame -> its own labelled group ("Legal
    // agreement" aria-label). Its flag lead, reference, and purpose are all under that
    // single accessible name.
    const agreement = group("Legal agreement");
    await expect.element(agreement).toBeInTheDocument();
    expect(agreement.element().textContent).toContain(
      "This invitation attaches a legal agreement.",
    );
    expect(agreement.element().textContent).toContain(
      "Reference: MOU-2025-0042",
    );
    expect(agreement.element().textContent).toContain(
      "Stated purpose: Audit and evaluation",
    );
    // The tiers are distinct groups: the ingress does not bleed into the disclose
    // tier, nor the egress into the receive tier.
    expect(disclose.element().textContent).not.toContain("You will receive");
    expect(receive.element().textContent).not.toContain("requests");
  });

  test("the produce tier groups the matching method and result sharing, and only those", async () => {
    // "What the exchange produces" carries the matching method and result sharing --
    // what is revealed and to whom -- announced as one related set. It is slimmed to
    // that pair: the matching mechanics (the field summary, the "Matching strategies"
    // disclosure) moved to their own "How records are matched" tier, so this group is
    // no longer overloaded with three unlike concerns.
    render(terms);
    await expect.element(toggle("Other details")).toBeInTheDocument();
    const produce = group("What the exchange produces");
    await expect.element(produce).toBeInTheDocument();
    const el = produce.element();
    expect(el.textContent).toContain("shared identifiers");
    expect(el.textContent).toContain("You will receive the matched result:");
    // The matching mechanics are NOT in the produce tier anymore.
    expect(el.textContent).not.toContain("Matching on SSN");
    expect(el.textContent).not.toContain("Matching strategies");
  });

  test("the matching mechanics live in a 'How records are matched' tier", async () => {
    // The field summary and the "Matching strategies" disclosure are split out of the
    // produce tier into their own mechanics tier, kept below the disclosure/result
    // outcome. The always-visible field summary and the disclosure toggle are both
    // under that group.
    render(terms);
    await expect.element(toggle("Other details")).toBeInTheDocument();
    const mechanics = group("How records are matched");
    await expect.element(mechanics).toBeInTheDocument();
    const el = mechanics.element();
    expect(el.textContent).toContain(
      "Matching on SSN, last name, date of birth, first name.",
    );
    expect(el.textContent).toContain("Matching strategies");
  });

  test("each tier caption is a heading, so a screen-reader user can jump between tiers", async () => {
    // The direction/mechanics tier captions are headings (not bold text), so a
    // non-visual user can navigate tier-to-tier by heading on a long consent screen.
    render(terms);
    await expect.element(toggle("Other details")).toBeInTheDocument();
    for (const name of [
      "What you disclose",
      "What the exchange produces",
      "What you receive",
      "How records are matched",
    ])
      await expect
        .element(page.getByRole("heading", { name }))
        .toBeInTheDocument();
  });

  test("the 'Other details' toggle is self-describing: its describedby names the contents", async () => {
    render({
      ...terms,
      payload: { send: [{ name: "risk_score" }], receive: [] },
    });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    const button = toggle("Other details").element();
    const describedById = button.getAttribute("aria-describedby");
    expect(describedById).toBeTruthy();
    const summary = document.getElementById(describedById!);
    // A one-line summary of what expanding reveals -- the personal data, the payload
    // columns (this send is a declared column, so the payload block renders), and the
    // duplicate-match setting -- not the bare "Other details" label.
    expect(summary?.textContent).toBe(
      "Contains the personal data used, the columns exchanged for matched " +
        "records, and the duplicate-match setting.",
    );
  });

  test("the self-describing summary drops the payload phrase when no payload block renders", async () => {
    // No payload declared: "Other details" holds only the personal-data and
    // duplicate-match blocks, so the summary names exactly those two.
    render({ ...terms, payload: undefined });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    const describedById = toggle("Other details")
      .element()
      .getAttribute("aria-describedby");
    const summary = document.getElementById(describedById!);
    expect(summary?.textContent).toBe(
      "Contains the personal data used and the duplicate-match setting.",
    );
  });

  test("the 'Other details' describedby always resolves, even with no payload or legal agreement", async () => {
    // The self-describing summary is always present (Other details always holds the
    // personal-data and duplicate-match blocks), so the describedby never dangles --
    // the invariant that replaced the former "no hint -> no describedby" case.
    render({ ...terms, payload: undefined, legalAgreement: undefined });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    const describedById = toggle("Other details")
      .element()
      .getAttribute("aria-describedby");
    expect(describedById).toBeTruthy();
    expect(document.getElementById(describedById!)).not.toBeNull();
  });

  test("the direction tiers frame the inviter's own proposing preview first-person", async () => {
    // Under "proposing" the viewer is the inviter, so "you" is the inviter: its send
    // is announced under "What you disclose" and its request of the partner under
    // "What you receive" (the same first-person tier labels, now addressing the
    // inviter).
    render(
      {
        ...terms,
        payload: { send: [{ name: "risk_score" }], receive: [{ name: "ssn" }] },
      },
      { perspective: "proposing" },
    );
    await expect.element(toggle("Other details")).toBeInTheDocument();
    const disclose = group("What you disclose");
    await expect.element(disclose).toBeInTheDocument();
    expect(disclose.element().textContent).toContain(
      "Columns sent to your partner",
    );
    const receive = group("What you receive");
    await expect.element(receive).toBeInTheDocument();
    expect(receive.element().textContent).toContain(
      "You request 1 data column from your partner.",
    );
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
    // egress/legal facts also render across perspectives. Pinned so the note is not
    // later narrowed to the acceptor perspectives only.
    render("single-pass", "proposing");
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(container!.textContent).toContain(
      "This exchange uses single-pass linkage.",
    );
  });
});

describe("InvitationTerms: proposed-but-not-applied caveats sit at their headline's visibility level", () => {
  // The consent-integrity invariant this locks in: a "proposed but not yet applied"
  // caveat renders at the SAME visibility level as the headline it contradicts,
  // never one expand down, so a reader can never see a headline setting as in force
  // while its caveat is hidden. Which level that is follows the setting's disclosure
  // weight -- psi-c states a disclosure GUARANTEE (count only, no identifiers), so
  // its headline and caveat are always-visible in the core; deduplicate and fuzzy
  // change match behavior/breadth, not what is disclosed, so their headlines and
  // caveats sit one expand down together. These assert placement against the
  // accessibility tree (which panel the text lives in), not styling.
  function renderCaveatTerms(overrides?: Partial<LinkageTerms>) {
    root!.render(
      createElement(
        MantineProvider,
        null,
        createElement(InvitationTerms, {
          linkageTerms: { ...terms, ...overrides },
        }),
      ),
    );
  }

  // psi-c- and deduplicate-specific caveat tails: both caveats share the "does not
  // yet apply it" lead, so each assertion keys on the distinguishing clause.
  const psiCCaveat = "matched records are still revealed";
  const deduplicateCaveat = "each record still matches at most one";

  test("the psi-c count-only caveat is always-visible in the core, not one expand down", async () => {
    // psi-c proposed, not applied (APPLIED_SETTINGS.psiC is false), so the count-only
    // guarantee carries its caveat. deduplicate is proposed too (the module terms),
    // so BOTH caveats render -- the psi-c one in the core, the deduplicate one in
    // "Other details" -- exactly the differentiated-but-consistent rule.
    renderCaveatTerms({ algorithm: "psi-c" });
    await expect.element(toggle("Other details")).toBeInTheDocument();

    // Both disclosures start collapsed, yet the psi-c caveat is legible: it is in the
    // always-visible core, so the acceptor cannot read the count-only guarantee as in
    // force without also seeing that the run does not yet honor it.
    expect(
      toggle("Other details").element().getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      toggle("Matching strategies").element().getAttribute("aria-expanded"),
    ).toBe("false");
    expect(container!.textContent).toContain(psiCCaveat);

    // Structurally in the core, not inside either disclosure (accessibility tree,
    // not styling): the caveat is within neither the "Other details" panel nor the
    // "Matching strategies" panel, both of which carry their collapsed content even
    // while hidden.
    expect((await readyPanel("Other details")).textContent).not.toContain(
      psiCCaveat,
    );
    expect((await readyPanel("Matching strategies")).textContent).not.toContain(
      psiCCaveat,
    );
  });

  test("the deduplicate caveat sits with its headline inside 'Other details', co-hidden", async () => {
    // deduplicate proposed, not applied (module terms). By the rule it sits one
    // expand down WITH its headline: both are inside the collapsed "Other details"
    // panel, so a reader who does not expand it sees neither -- the headline is never
    // visible as in force while its caveat is hidden.
    renderCaveatTerms();
    await expect.element(toggle("Other details")).toBeInTheDocument();

    // The collapse hides its content from assistive tech while closed ...
    const collapse = await readyCollapse("Other details");
    expect(collapse.getAttribute("aria-hidden")).toBe("true");
    // ... and BOTH the headline and its contradicting caveat live inside it, so
    // neither leaks into the always-visible core ahead of the other.
    expect(collapse.textContent).toContain("may match more than one");
    expect(collapse.textContent).toContain(deduplicateCaveat);
  });

  test("the fuzzy caveat sits with its annotation inside the key's own detail, behind the matching disclosure", async () => {
    // A key element carrying a proposed (not-applied) fuzzy comparison. By the rule
    // the caveat stays in the key's collapsed detail alongside the annotation it
    // qualifies -- the two are one sentence, so they cannot separate -- and the whole
    // key detail is behind the default-collapsed "Matching strategies" disclosure,
    // not in the always-visible core.
    renderCaveatTerms({
      linkageFields: [{ name: "dob", type: "date_of_birth" }],
      linkageKeys: [
        {
          name: "DOB",
          elements: [
            { field: "dob", generateFuzzyComparisons: "adjacent_years" },
          ],
        },
      ],
    });
    await expect.element(toggle("Matching strategies")).toBeInTheDocument();

    // Behind the matching disclosure, not in the core: the caveat is within the
    // collapsed "Matching strategies" panel (which carries the nested key detail even
    // while hidden), so it is never surfaced always-visible like the psi-c caveat.
    expect((await readyPanel("Matching strategies")).textContent).toContain(
      "(proposed; not yet applied)",
    );

    // Open the matching list, then the key: the annotation and its not-yet-applied
    // caveat are together in that key's own detail.
    await userEvent.click(toggle("Matching strategies"));
    const panel = await readyPanel("DOB");
    expect(panel.textContent).toContain("adjacent years");
    expect(panel.textContent).toContain("(proposed; not yet applied)");
  });

  test("a setting that matches the run carries no not-yet-applied caveat", async () => {
    // psi (identifiers revealed -- the run's actual behavior), deduplicate off (the
    // run is one-to-one), and no fuzzy: every displayed setting equals what the run
    // does, so none is flagged. This is the realizable stand-in for the applied case,
    // since the APPLIED_SETTINGS flags are all false today; the flag gating itself is
    // asserted in the summarizeInvitation unit tests.
    renderCaveatTerms({
      algorithm: "psi",
      deduplicate: false,
      linkageFields: [{ name: "dob", type: "date_of_birth" }],
      linkageKeys: [{ name: "DOB", elements: [{ field: "dob" }] }],
    });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    // None of the three caveats renders anywhere on the screen. container includes
    // the collapsed panels' mounted content, so this also covers the detail levels,
    // not just the core.
    expect(container!.textContent).not.toContain("does not yet apply it");
    expect(container!.textContent).not.toContain("(proposed; not yet applied)");
  });
});
