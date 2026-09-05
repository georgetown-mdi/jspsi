/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import {
  CONSENT_FACTS,
  DEDUPLICATE_ACCEPTOR_SIDE_NOTE,
  DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT,
  DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT,
  DEFAULT_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  LINKAGE_RULE_SET_VERDICT_COPY,
  MAX_DECLARED_NAMES_SHOWN,
  MAX_NAME_LENGTH,
  MAX_PAYLOAD_ENTRIES,
  UNRECOGNIZED_TRANSFORM_NOTE,
  getDefaultLinkageTerms,
  linkageRuleSetVerdictNote,
  sanitizeForDisplay,
  unshownDeclaredNamesLine,
} from "@psilink/core";

import { InvitationTerms } from "@components/InvitationTerms";

import {
  BEL,
  COUNT_ONLY_PROBE_TERMS,
  ESC,
  HOSTILE_IDENTITY,
  PRINTABLE_ASCII,
  RLO,
  consentRepresentationProbes,
  hostileSource,
  hostileTerms,
  hostileVariants,
} from "@psilink/core/testing";
import { restoreMatchMedia, stubReducedMotion } from "./reducedMotion";
import { createAppMount } from "./renderApp";

import type { ComponentProps } from "react";

import type {
  ConnectionEndpoint,
  LinkageStrategy,
  LinkageTerms,
} from "@psilink/core";

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
    // entry has a "(partial)" marker and the body leads with the slice phrase.
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

// The count-only headline, spelled out as the whole sentence rather than read from
// COUNT_ONLY_DISCLOSURE_STATEMENT. What it SAYS is critical: it is the sentence an
// acceptor could act on -- treating an exchange as safe to run because only a count
// is revealed -- so an edit here must be made on this surface too, not merely
// followed. The CLI accept prompt pins it against the same terms document
// (apps/cli/test/unit/commands/accept.test.ts), so a copy edit on one surface forces the
// same change on the other, rather than a silent divergence.
const COUNT_ONLY_HEADLINE =
  "Only the number of records you have in common is revealed, not which " +
  "records match.";

// The five tier notes rendered beside that headline, read from the shared table.
// All five, so the tier is measured whole rather than sampled: a half of the
// count-only claim reaching an acceptor without the half that bounds it is the error
// the shared table exists to prevent. The headline is not in the list -- it is
// shared wording the two surfaces place differently, so its placement is a
// fact about this screen and is asserted as one.
const COUNT_ONLY_TIER_NOTES = [
  CONSENT_FACTS.countOnlyResult.note,
  CONSENT_FACTS.countOnlyRoundDisclosures.note,
  CONSENT_FACTS.countOnlyReportedCount.note,
  CONSENT_FACTS.countOnlyInputChoice.note,
  CONSENT_FACTS.countOnlyNoPayload.note,
];

// The whole no-payload sentence, spelled out here rather than imported from
// OUTBOUND_SEND_NO_PAYLOAD_SENTENCE, so a copy edit that drops the reason -- or the
// clause ruling the operator's own file out of the answer -- fails these assertions
// instead of silently moving them. It is asserted on both sides of the exchange
// below, which is what pins that ONE string serves both framings: an edit that made
// it read for only one viewer reddens the other side's block.
const NO_PAYLOAD_SENTENCE =
  "Your partner receives no result from this exchange, so no columns are " +
  "sent to them -- whatever your file contains.";

const app = createAppMount();

afterEach(app.unmount);

// The single render entry point for every describe block: render InvitationTerms
// under the app provider config with the given terms and any optional props. Each
// block wraps this thinly for the one or two params it varies. Only props explicitly
// set are forwarded, so the component sees each optional prop absent (not undefined)
// exactly as before -- the difference the perspective/outbound gates turn on.
function renderTerms(
  linkageTerms: LinkageTerms = terms,
  options?: {
    perspective?: "review" | "proposing";
    disclosedPayloadColumns?: Array<string>;
    inviterRetainsFiles?: boolean;
    connectionEndpoint?: ConnectionEndpoint;
    outboundColumns?: Array<string>;
    headingOrder?: 1 | 2 | 3;
  },
) {
  app.render(
    createElement(InvitationTerms, {
      linkageTerms,
      ...(options?.perspective ? { perspective: options.perspective } : {}),
      ...(options?.inviterRetainsFiles !== undefined
        ? { inviterRetainsFiles: options.inviterRetainsFiles }
        : {}),
      ...(options?.connectionEndpoint !== undefined
        ? { connectionEndpoint: options.connectionEndpoint }
        : {}),
      ...(options?.headingOrder !== undefined
        ? { headingOrder: options.headingOrder }
        : {}),
      ...(options?.disclosedPayloadColumns !== undefined
        ? { disclosedPayloadColumns: options.disclosedPayloadColumns }
        : {}),
      ...(options?.outboundColumns !== undefined
        ? { outboundColumns: options.outboundColumns }
        : {}),
    }),
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

// The Mantine Collapse panel inside the wrapper, with the aria-hidden + inert
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

// Mantine 9's Collapse mounts a collapsed panel's content inside a React Activity
// (mode="hidden") boundary that commits at a DEFERRED priority, which can lag the
// always-visible core under load. Reading a panel synchronously can race that
// commit (an empty textContent, or a not-yet-present Collapse child), so this
// resolves a panel only once its content has committed -- the flake this fixed
// showed up under full-suite CPU contention.
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
      // trim so a whitespace-only intermediate render is not treated as settled.
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

    // Each key's header one-liner is the accurate anchor: shown beside the key name
    // (not buried in the key's own collapsed rule body). The truncated element
    // has the "(partial)" breadth marker, the exact key has none.
    expect(app.container.textContent).toContain(
      "Matches on SSN - first name (partial)",
    );
    expect(app.container.textContent).toContain(
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
    expect(app.container.textContent).toContain(
      "Matching on SSN, last name, date of birth, first name.",
    );
    // Structurally outside the disclosure: the summary is not inside the matching
    // panel, which holds the collapsed per-key detail even while hidden.
    expect((await readyPanel("Matching strategies")).textContent).not.toContain(
      "Matching on SSN, last name, date of birth, first name.",
    );
  });

  // Terms citing a rule set, rendered under each perspective below so the three
  // cases differ at the perspective alone. The two halves reach DIFFERENT
  // verdicts against this build, which is what the citation's independent halves
  // are for: `baseline-pii 1.0.0` is a set this build ships, and the fields above
  // are not it (no constraints on `ssn`, a field named `dob`), while
  // `hmis-keys 2.3.0` is a version it does not ship at all.
  const citingTerms: LinkageTerms = {
    ...terms,
    linkageRuleSet: {
      fieldSet: { name: "baseline-pii", version: "1.0.0" },
      keySet: { name: "hmis-keys", version: "2.3.0" },
    },
  };

  test("the rule-set citation is always-visible, each half holding this build's verdict, and absent when none is cited", async () => {
    // The citation names the rules the collapsed list below enumerates, so it
    // stays outside the disclosure: an acceptor reads which set was cited, and
    // what psilink found about it, without expanding. A disproved half must not
    // be reachable only by opening the matching panel.
    renderTerms(citingTerms, { perspective: "review" });
    await expect.element(toggle("Matching strategies")).toBeInTheDocument();
    expect(app.container.textContent).toContain("Linkage rule set");
    expect(app.container.textContent).toContain('"hmis-keys" 2.3.0');
    expect(app.container.textContent).toContain('"baseline-pii" 1.0.0');
    expect(app.container.textContent).toContain(
      `Keys (${LINKAGE_RULE_SET_VERDICT_COPY.unchecked.marker}):`,
    );
    expect(app.container.textContent).toContain(
      `Fields (${LINKAGE_RULE_SET_VERDICT_COPY.contradicted.marker}):`,
    );
    // Both halves' caveats, and the disproved one first.
    expect(app.container.textContent).toContain(
      LINKAGE_RULE_SET_VERDICT_COPY.contradicted.note,
    );
    expect(app.container.textContent).toContain(
      LINKAGE_RULE_SET_VERDICT_COPY.unchecked.note,
    );
    const text = app.container.textContent;
    expect(
      text.indexOf(LINKAGE_RULE_SET_VERDICT_COPY.contradicted.note),
    ).toBeLessThan(text.indexOf(LINKAGE_RULE_SET_VERDICT_COPY.unchecked.note));
    const panel = (await readyPanel("Matching strategies")).textContent;
    expect(panel).not.toContain("hmis-keys");
    expect(panel).not.toContain(
      LINKAGE_RULE_SET_VERDICT_COPY.contradicted.note,
    );
  });

  test("a truthful citation says so rather than being treated as unchecked", async () => {
    // The other side of the same block: rules genuinely drawn from the shipped
    // sets get a `consistent` verdict on both halves, so the absence of a warning
    // is never all an acceptor has to go on.
    const drawnFromDefaults = getDefaultLinkageTerms(
      "County Health Department",
    );
    renderTerms(drawnFromDefaults, { perspective: "review" });
    await expect.element(toggle("Matching strategies")).toBeInTheDocument();
    expect(app.container.textContent).toContain(
      `Keys (${LINKAGE_RULE_SET_VERDICT_COPY.consistent.marker}):`,
    );
    expect(app.container.textContent).toContain(
      `Fields (${LINKAGE_RULE_SET_VERDICT_COPY.consistent.marker}):`,
    );
    expect(app.container.textContent).toContain(
      LINKAGE_RULE_SET_VERDICT_COPY.consistent.note,
    );
    expect(app.container.textContent).not.toContain(
      LINKAGE_RULE_SET_VERDICT_COPY.contradicted.note,
    );
  });

  test("a set name containing a version-shaped token stays delimited from the version", async () => {
    // The name is partner-controlled free text and the version beside it is not,
    // so the quoting is what keeps the boundary between them readable: a name
    // ending in a version-shaped token must not be treated as the version this
    // block reports.
    renderTerms(
      {
        ...citingTerms,
        linkageRuleSet: {
          fieldSet: { name: "baseline-pii", version: "1.0.0" },
          keySet: { name: "hmis-keys 9.9.9", version: "2.3.0" },
        },
      },
      { perspective: "review" },
    );
    await expect.element(toggle("Matching strategies")).toBeInTheDocument();
    expect(app.container.textContent).toContain('"hmis-keys 9.9.9" 2.3.0');
  });

  test("a cited set name cannot render another citation's value", async () => {
    // The name is delimited through core's `quoteTermsValue`, which doubles a
    // delimiter inside a run, so a name containing one cannot end its own value:
    // what an acceptor reads is the whole name, never the value a citation of a
    // shorter name at another version renders. Asserted on each half's own
    // element rather than on the screen's concatenated text, so what is measured
    // is the run the name occupies, not a substring of the page.
    //
    // Neither citation below names a set this build ships -- the first pair by
    // version, the second by name -- so all four halves render under one marker
    // and the two renderings differ in nothing but how the name is rendered.
    const imitated = {
      keys: '"hmis-keys" 9.9.9',
      fields: '"baseline-pii" 9.9.9',
    };
    renderTerms(
      {
        ...citingTerms,
        linkageRuleSet: {
          fieldSet: { name: "baseline-pii", version: "9.9.9" },
          keySet: { name: "hmis-keys", version: "9.9.9" },
        },
      },
      { perspective: "review" },
    );
    for (const value of [imitated.keys, imitated.fields])
      await expect
        .element(page.getByText(value, { exact: true }))
        .toBeInTheDocument();

    renderTerms(
      {
        ...citingTerms,
        linkageRuleSet: {
          fieldSet: { name: 'baseline-pii" 9.9.9', version: "1.0.0" },
          keySet: { name: 'hmis-keys" 9.9.9', version: "1.0.0" },
        },
      },
      { perspective: "review" },
    );
    for (const value of [
      '"hmis-keys"" 9.9.9" 1.0.0',
      '"baseline-pii"" 9.9.9" 1.0.0',
    ])
      await expect
        .element(page.getByText(value, { exact: true }))
        .toBeInTheDocument();
    expect(app.container.textContent).not.toContain(imitated.keys);
    expect(app.container.textContent).not.toContain(imitated.fields);
  });

  test("a version outside the bare shape is treated as a delimited run, not as prose", async () => {
    // The version renders undelimited on the strength of the shape the terms
    // schema holds it to, and `bareTermsValue` re-checks that shape on the value
    // in hand: one outside it takes the delimited run rather than standing in
    // the citation unattributed.
    renderTerms(
      {
        ...citingTerms,
        linkageRuleSet: {
          fieldSet: { name: "baseline-pii", version: "1.0.0" },
          keySet: { name: "hmis-keys", version: '1.0.0" 9.9.9' },
        },
      },
      { perspective: "review" },
    );
    await expect
      .element(page.getByText('"hmis-keys" "1.0.0"" 9.9.9"', { exact: true }))
      .toBeInTheDocument();
  });

  test("the viewer's own proposing preview cites the set without attributing it to a partner, and states a disproved half as theirs to correct", async () => {
    // Under "proposing" the terms are the viewer's own -- the console's direct
    // exchange states outright that there is no invitation for a partner to
    // review -- so the citation is the operator's own word. The names, versions,
    // and verdicts still render (they are true of these terms whoever authored
    // them); the caveat that a PARTNER cites them does not. The disproved half's
    // warning is not attribution -- it is this build's finding about the document
    // on screen -- so it renders here too, in the reading that fits this reader:
    // the remedy is the one they can act on, not the recipient's "settle it with
    // the other party" over a document they cannot edit.
    renderTerms(citingTerms, { perspective: "proposing" });
    await expect.element(toggle("Matching strategies")).toBeInTheDocument();
    expect(app.container.textContent).toContain("Linkage rule set");
    expect(app.container.textContent).toContain('"hmis-keys" 2.3.0');
    expect(app.container.textContent).toContain('"baseline-pii" 1.0.0');
    expect(app.container.textContent).toContain(
      linkageRuleSetVerdictNote("contradicted", "citing-party"),
    );
    expect(app.container.textContent).not.toContain(
      LINKAGE_RULE_SET_VERDICT_COPY.contradicted.note,
    );
    expect(app.container.textContent).not.toContain(
      LINKAGE_RULE_SET_VERDICT_COPY.unchecked.note,
    );
  });

  test("terms citing no rule set render no citation at all", async () => {
    // Hand-authored rules have no citation, and inventing one would attribute
    // them -- so the block is absent rather than empty or hedged, and there is no
    // verdict to state about a claim nobody made.
    renderTerms({ ...terms, linkageRuleSet: undefined });
    await expect.element(toggle("Matching strategies")).toBeInTheDocument();
    expect(app.container.textContent).not.toContain("Linkage rule set");
    for (const verdict of ["consistent", "contradicted", "unchecked"] as const)
      expect(app.container.textContent).not.toContain(
        LINKAGE_RULE_SET_VERDICT_COPY[verdict].note,
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

  test("reordering the keys moves each key's expanded/collapsed state with it, not with its position", async () => {
    renderTerms();
    await userEvent.click(toggle("Matching strategies"));

    // Expand the first key ("SSN + LN + DOB") only.
    await userEvent.click(toggle("SSN + LN + DOB"));
    expect(
      toggle("SSN + LN + DOB").element().getAttribute("aria-expanded"),
    ).toBe("true");
    expect(toggle("SSN + FN1").element().getAttribute("aria-expanded")).toBe(
      "false",
    );

    // Re-render with the same two keys swapped, as a reorder in the live preview
    // would produce (moveKey swaps array positions in place). "SSN + FN1" is now
    // first, "SSN + LN + DOB" second.
    renderTerms({
      ...terms,
      linkageKeys: [terms.linkageKeys[1], terms.linkageKeys[0]],
    });

    // Wait for the reordered list to commit (its own header text moves first).
    await expect
      .poll(() => page.getByRole("list").element().textContent)
      .toMatch(/SSN \+ FN1.*SSN \+ LN \+ DOB/s);

    // The expanded state follows "SSN + LN + DOB" to its new (second) slot,
    // rather than staying pinned to the first slot it used to occupy.
    expect(
      toggle("SSN + LN + DOB").element().getAttribute("aria-expanded"),
    ).toBe("true");
    expect(toggle("SSN + FN1").element().getAttribute("aria-expanded")).toBe(
      "false",
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

  test("a transform this version cannot explain is marked unrecognized, not stated as applied", async () => {
    // The function name is partner free text, so a lead composed around it states
    // an effect on matching this version cannot know and does not perform -- and a
    // name chosen to look like an effect is then indistinguishable from one. The
    // shared note is what stands in the consequence's place, read from core so
    // this screen and the CLI accept prompt cannot drift on what an unexplained
    // rule is called; the name still renders, as technical identity beneath it.
    const unrecognized = "org_internal_rule";
    renderTerms({
      ...terms,
      linkageKeys: [
        {
          name: "SSN + FN1",
          elements: [
            { field: "ssn" },
            {
              field: "first_name",
              transform: [{ function: unrecognized }],
            },
          ],
        },
      ],
    });

    await userEvent.click(toggle("Matching strategies"));
    const panel = await readyPanel("SSN + FN1");
    expect(panel.textContent).toContain(UNRECOGNIZED_TRANSFORM_NOTE);
    expect(panel.textContent).toContain(unrecognized);
    // The wording that looked like an effect the run performs.
    expect(panel.textContent).not.toContain(`Applies ${unrecognized}`);

    // A recognized function keeps its plain-language consequence and has no
    // marker, so the note tells the two apart rather than decorating both.
    app.unmount();
    renderTerms();
    await userEvent.click(toggle("Matching strategies"));
    const recognized = await readyPanel("SSN + FN1");
    expect(recognized.textContent).toContain("Matches on the first character");
    expect(recognized.textContent).not.toContain(UNRECOGNIZED_TRANSFORM_NOTE);
  });

  // The matching-keys list is a NAMED region: its role="list" derives its accessible
  // name from the visible "Matching strategies" caption via aria-labelledby, not a
  // second, separately-authored aria-label that could drift from it -- the same
  // single-source-of-name idiom the send-columns chip lists use (see the send-columns
  // describe block below). Keeping the list named is the consent-surface decision on
  // this file's three disclosure lists: a named list is announced by its name at its
  // boundary, so it stays discoverable when a screen-reader user lands on it out of
  // linear order -- reaching it by expanding this default-collapsed disclosure and
  // moving into the freshly-revealed content, without the caption fresh in earshot --
  // at the accepted cost of a second utterance of the short caption in strict linear
  // reading. This pins that decision (all three lists named, not unnamed) so a later
  // change cannot silently drop the name.
  test("the matching-keys list is named by its visible caption via aria-labelledby, not a duplicate aria-label", async () => {
    renderTerms();
    // Default-collapsed: the list is out of the accessibility tree until the
    // "Matching strategies" disclosure is opened, so expand it before resolving the
    // list by role + accessible name.
    await userEvent.click(toggle("Matching strategies"));

    const list = page.getByRole("list", { name: "Matching strategies" });
    await expect.element(list).toBeInTheDocument();
    const el = list.element();
    // The name is sourced from the visible caption, not duplicated onto the list.
    expect(el.getAttribute("aria-label")).toBeNull();
    // Named via the visible caption instead: aria-labelledby -> the caption node,
    // whose text is exactly the caption the list's accessible name derives from.
    const labelledBy = el.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe(
      "Matching strategies",
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
      .poll(() => app.container.querySelectorAll("[aria-controls]").length)
      .toBe(4);
    const ids = Array.from(
      app.container.querySelectorAll("[aria-controls]"),
    ).map((el) => el.getAttribute("aria-controls"));
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

    // The non-key blocks (personal-data labels, payload, dedup) are in the master
    // disclosure ...
    const panel = await readyPanel("Other details");
    expect(panel.textContent).toContain("Personal data used");
    expect(panel.textContent).toContain("risk_score");
    expect(panel.textContent).toContain(
      "More than one of the inviting party's records",
    );
    // ... the partner-authored allowed-character class is NOT among them: it is
    // promoted whole into the always-visible core (its own constraints group) ...
    expect(panel.textContent).not.toContain("A-Z");
    // ... the legal agreement is NOT among them either: it is promoted whole into
    // the always-visible core ...
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
  beforeEach(() => {
    stubReducedMotion(true);
  });

  afterEach(restoreMatchMedia);

  test("every disclosure's aria-controls resolves to a present, hidden panel while collapsed under reduced motion", async () => {
    app.render(createElement(InvitationTerms, { linkageTerms: terms }));

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
  // free-text field the sender typed, included in an invitation accepted on a
  // transcription checksum -- so psilink has not authenticated it. A terse marker
  // keeps the acceptor from treating it as a psilink-verified fact; it is a small
  // marker that does not overstate a self-asserted field, not a directive (parties
  // normally coordinate the first exchange out of band, so they already know the
  // counterparty). The inviter's "proposing" preview shows its OWN identity,
  // which needs no such note.
  function render(perspective?: "review" | "proposing") {
    renderTerms(terms, perspective ? { perspective } : undefined);
  }

  // Read from core rather than transcribed: the note is the consent fact's own
  // copy, and a literal here would let the screen drift from it while this
  // suite stayed green.
  const noteText = CONSENT_FACTS.invitingParty.note;

  test("the unverified-identity note appears on the acceptor review screen", async () => {
    render("review");
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();
    // The self-asserted name is marked unverified, in the always-visible core ...
    expect(app.container.textContent).toContain(noteText);
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
    // announcement would not convey.
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
    expect(app.container.textContent).not.toContain(noteText);
  });
});

describe("InvitationTerms: result sharing is stated from the viewer's perspective", () => {
  // Render the same terms with a chosen output direction and perspective. The
  // viewer is the inviter under "proposing" (its own preview) and the acceptor
  // under "review"; each must read its OWN outcome first-person, which
  // is the form clear enough to consent on for a one-sided exchange.
  function renderOutput(
    output: { expectsOutput: boolean; shareWithPartner: boolean },
    perspective?: "review" | "proposing",
  ) {
    renderTerms(
      { ...terms, output },
      perspective ? { perspective } : undefined,
    );
  }

  test("an acceptor of an inviter-only invitation is told plainly it receives no result", async () => {
    // inviter-only: the inviter receives and does not share, so the acceptor gets
    // nothing -- and must read that first-person, not infer it from the inviter's
    // "shares with you: No".
    renderOutput({ expectsOutput: true, shareWithPartner: false });
    await expect.element(page.getByText("Result sharing")).toBeInTheDocument();
    expect(app.container.textContent).toContain(
      "You will receive the matched result: No",
    );
    expect(app.container.textContent).toContain(
      "Your partner (the inviter) will receive the result: Yes",
    );
    // The acceptor's OWN non-receipt is a hard fact -- enforced by this tool, not a
    // matter of trusting the partner -- so its "No" has the enforced caveat.
    expect(app.container.textContent).toContain(
      "Enforced: you are sent no result",
    );
    // The partner receives here (Yes): no cooperative caveat, but the partner "Yes"
    // is the accountable disclosure, so it has the brief governance pointer.
    expect(app.container.textContent).not.toContain(
      "By agreement, not enforced",
    );
    expect(app.container.textContent).toContain(
      "Once received, its use is governed by your agreement, not this tool.",
    );
    // The partner receives the result here, so the honest-helper membership line
    // does not apply -- it is scoped to the "partner does not receive" case.
    expect(app.container.textContent).not.toContain(
      "learns which of its own records are in your data",
    );
  });

  test("an acceptor of a partner-only invitation is told plainly it receives the result", async () => {
    renderOutput({ expectsOutput: false, shareWithPartner: true });
    await expect.element(page.getByText("Result sharing")).toBeInTheDocument();
    expect(app.container.textContent).toContain(
      "You will receive the matched result: Yes",
    );
    expect(app.container.textContent).toContain(
      "Your partner (the inviter) will receive the result: No",
    );
    // The PARTNER's non-receipt is cooperative -- it rests on the terms being
    // honored, not a guarantee this side imposes -- so its "No" is marked distinctly
    // from an enforced one, and the acceptor's own "Yes" has no enforced caveat.
    expect(app.container.textContent).toContain("By agreement, not enforced");
    expect(app.container.textContent).not.toContain(
      "Enforced: you are sent no",
    );
    // Partner does not receive: the honest-helper membership line appears, DISTINCT
    // from the cooperative caveat above (it is about what an honest partner learns,
    // not about a dishonest one keeping the table), and lands in the "What the
    // exchange produces" tier where result sharing lives -- not merely somewhere in
    // the panel.
    expect(app.container.textContent).toContain(
      "learns which of its own records are in your data",
    );
    await expect
      .element(group("What the exchange produces"))
      .toHaveTextContent("learns which of its own records are in your data");
  });

  test("a one-sided count-only invitation states no membership disclosure", async () => {
    // The membership fact is scoped by the ALGORITHM: by the role rule a count-only
    // run's non-receiving party is the SENDER, which computes nothing from the round
    // and is sent no count-report frame (docs/spec/PROTOCOL.md, PSI-C). The same
    // output pair as the test above, so the difference measured is the algorithm's
    // alone.
    renderTerms({
      ...COUNT_ONLY_PROBE_TERMS,
      output: { expectsOutput: false, shareWithPartner: true },
    });
    await expect.element(page.getByText("Result sharing")).toBeInTheDocument();
    // The screen states the count-only headline for any psi-c invitation, so the
    // membership line would contradict it in the same tier.
    expect(app.container.textContent).toContain(
      "Only the number of records you have in common is revealed",
    );
    expect(app.container.textContent).not.toContain(
      "learns which of its own records are in your data",
    );
    // Not the whole branch going missing: the cooperative caveat the membership line
    // sits beneath is still rendered.
    expect(app.container.textContent).toContain("By agreement, not enforced");
  });

  test("the inviter's own preview frames the outcome for the proposer", async () => {
    // proposing: the viewer IS the inviter, so "you" is the inviter and "your
    // partner" the acceptor. inviter-only here: the inviter receives, the partner
    // does not.
    renderOutput({ expectsOutput: true, shareWithPartner: false }, "proposing");
    await expect.element(page.getByText("Result sharing")).toBeInTheDocument();
    expect(app.container.textContent).toContain(
      "You will receive the matched result: Yes",
    );
    expect(app.container.textContent).toContain(
      "Your partner will receive the result: No",
    );
    // The proposer's partner does not receive: a cooperative "No", so it has the
    // by-agreement caveat and the proposer's own "Yes" has none.
    expect(app.container.textContent).toContain("By agreement, not enforced");
    expect(app.container.textContent).not.toContain(
      "Enforced: you are sent no",
    );
    // The honest-helper membership line is viewer-relative like the rest of Result
    // sharing: under "proposing" it reads against the inviter's own data, so the
    // proposer sees that its (non-receiving) partner still learns which of its own
    // records are in the proposer's data.
    expect(app.container.textContent).toContain(
      "learns which of its own records are in your data",
    );
  });

  test("a symmetric both-receive exchange marks only the partner's disclosure", async () => {
    // Both parties receive: no withholding, so neither the enforced nor the
    // cooperative caveat renders. The viewer's own "Yes" (receiving your own result)
    // stays unqualified; the partner's "Yes" has the brief governance pointer,
    // since it is the accountable disclosure of your result to them.
    renderOutput({ expectsOutput: true, shareWithPartner: true });
    await expect.element(page.getByText("Result sharing")).toBeInTheDocument();
    expect(app.container.textContent).toContain(
      "You will receive the matched result: Yes",
    );
    expect(app.container.textContent).toContain(
      "Your partner (the inviter) will receive the result: Yes",
    );
    expect(app.container.textContent).not.toContain(
      "Enforced: you are sent no",
    );
    expect(app.container.textContent).not.toContain(
      "By agreement, not enforced",
    );
    // Exactly one governance pointer -- on the partner's "Yes", not the viewer's own.
    expect(
      (
        app.container.textContent.match(
          /its use is governed by your agreement/g,
        ) ?? []
      ).length,
    ).toBe(1);
  });
});

describe("InvitationTerms: the exchange's retained files", () => {
  const PRODUCES = "What the exchange produces";
  const RETAIN_LINE =
    "Kept as a permanent transcript, not deleted after the run.";
  const SPLIT_ENDPOINT: ConnectionEndpoint = {
    channel: "filedrop",
    inboundPath: "/mnt/share/in",
    outboundPath: "/mnt/share/out",
  };

  test("a declared retain mode is stated in the produces tier, always-visible", async () => {
    // The fact that outlives the run, and the one an acceptor can least undo
    // after consenting, so it is always-visible with the other produce facts
    // rather than an expand down in "Other details".
    renderTerms(terms, { inviterRetainsFiles: true });
    await expect.element(group(PRODUCES)).toBeInTheDocument();
    expect(group(PRODUCES).element().textContent).toContain("Exchange files");
    expect(group(PRODUCES).element().textContent).toContain(RETAIN_LINE);
    // The caveat is core's, verbatim, so this screen and the CLI accept prompt
    // cannot word one disclosure two ways.
    expect(group(PRODUCES).element().textContent).toContain(
      CONSENT_FACTS.retainedFiles.note,
    );
  });

  test("a split-directory endpoint states it with no declaration", async () => {
    // The seeded sub-case: an acceptor taking a split inbound/outbound endpoint
    // is put in retain mode by its shape, whatever the token declares, so a
    // screen reading only the declaration would take consent to a permanent
    // transcript in silence. Same fixed copy as the declared case -- a split
    // rendezvous runs in retain mode on both sides or not at all.
    renderTerms(terms, { connectionEndpoint: SPLIT_ENDPOINT });
    await expect.element(group(PRODUCES)).toBeInTheDocument();
    expect(group(PRODUCES).element().textContent).toContain("Exchange files");
    expect(group(PRODUCES).element().textContent).toContain(RETAIN_LINE);
    expect(group(PRODUCES).element().textContent).toContain(
      CONSENT_FACTS.retainedFiles.note,
    );
  });

  // An invitation that declares delete mode and one that declares nothing render
  // alike, by design: neither is a promise that the exchange cleans up
  // after itself (a run killed outright, or one that fails after the handshake,
  // leaves files behind in either mode), so the screen states nothing for both.
  // A shared-directory endpoint joins them: it seeds no mode onto the acceptor,
  // which sets its own, so the shape test does not widen to "has an endpoint".
  test.each([
    { label: "an explicit false", options: { inviterRetainsFiles: false } },
    { label: "no declaration at all", options: undefined },
    {
      label: "a shared-directory endpoint",
      options: {
        connectionEndpoint: {
          channel: "filedrop",
          path: "/mnt/share",
        } as ConnectionEndpoint,
      },
    },
  ])("nothing is stated for $label", async ({ options }) => {
    renderTerms(terms, options);
    await expect.element(group(PRODUCES)).toBeInTheDocument();
    expect(app.container.textContent).not.toContain("Exchange files");
    expect(app.container.textContent).not.toContain(RETAIN_LINE);
    expect(app.container.textContent).not.toContain(
      CONSENT_FACTS.retainedFiles.note,
    );
  });
});

describe("InvitationTerms: always-visible egress and legal-agreement facts, tiered by direction", () => {
  // Render a chosen terms object under the given perspective. These facts live in the
  // always-visible core, each under the direction tier it belongs to; the detail they
  // count stays in the "Other details" disclosure.
  function render(
    linkageTerms: LinkageTerms,
    perspective?: "review" | "proposing",
  ) {
    renderTerms(linkageTerms, perspective ? { perspective } : undefined);
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
    // panel, which holds the collapsed detail even while hidden.
    const panel = await readyPanel("Other details");
    expect(panel.textContent).not.toContain(
      "Your partner requests 2 data columns from you",
    );
    // The column NAMES themselves stay one expand down in the disclosure -- the tier
    // shows only the count, not the detail.
    expect(panel.textContent).toContain("zip_code");
  });

  test("the egress count is singular for a single requested column", async () => {
    render({
      ...terms,
      payload: { send: [], receive: [{ name: "ssn" }] },
    });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(app.container.textContent).toContain(
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
    // The module terms attach a legal agreement. Its governance-critical substance
    // -- reference, PURPOSE, and expiry -- is shown in the core as its own labelled
    // group (named by a short fixed "Legal agreement" aria-label, distinct from its
    // lead sentence so a screen reader does not read that sentence twice), not a bare
    // "attaches an agreement" flag, since the purpose is the field a 164.528 accounting
    // / FERPA exception turns on (docs/COMPLIANCE.md) and must be clear at the
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
    // inside the "Other details" disclosure (structure, not styling).
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
    expect(app.container.textContent).not.toContain(
      "attaches a legal agreement",
    );
    expect(app.container.textContent).not.toContain("MOU-2025-0042");
    expect(app.container.textContent).not.toContain("Audit and evaluation");
  });
});

describe("InvitationTerms: a partner-authored allowed-character constraint is on notice at consent", () => {
  // A partner-defined allowedCharacters class is a rule on a linkage field the
  // acceptor consents to. It must be clear at the consent point -- not dimmed
  // inside the collapsed "Other details" disclosure -- so a partner-defined
  // character-class constraint is on notice before consenting. Promoted into its
  // own always-visible labelled group, with the raw partner-controlled class bound
  // in its OWN bounded element (never joined into a sentence a partner could
  // impersonate) under a fixed "unverified" system label.
  const GROUP = "Partner-defined character constraints";
  function render(
    linkageTerms: LinkageTerms,
    perspective?: "review" | "proposing",
  ) {
    renderTerms(linkageTerms, perspective ? { perspective } : undefined);
  }

  test("the constraint is shown always-visible, outside the 'Other details' disclosure", async () => {
    // The module terms have a first_name field with allowedCharacters "A-Z ".
    render(terms);
    await expect.element(toggle("Other details")).toBeInTheDocument();

    // Its own always-visible labelled group: an acceptor sees a partner-defined
    // constraint applies without expanding any disclosure.
    const constraints = group(GROUP);
    await expect.element(constraints).toBeInTheDocument();
    expect(constraints.element().textContent).toContain("First name");
    expect(constraints.element().textContent).toContain("A-Z ");

    // ... and OUTSIDE the "Other details" panel, which holds its collapsed content
    // even while hidden: the class is not also dimmed there.
    const panel = await readyPanel("Other details");
    expect(panel.textContent).not.toContain("A-Z");
  });

  test("the constraint is not de-emphasized relative to the always-visible terms core", async () => {
    // Assert the raw class node resolves to the SAME color as a core body-weight
    // line elsewhere on the screen (the always-visible matching summary, a plain
    // size="sm" Text), rather than the muted --mantine-color-dimmed -- so it is not
    // rendered less prominently than the always-visible terms core.
    render(terms);
    const constraints = group(GROUP);
    await expect.element(constraints).toBeInTheDocument();
    const classNode = Array.from(
      constraints.element().querySelectorAll("*"),
    ).find((el) => el.children.length === 0 && el.textContent.trim() === "A-Z");
    expect(classNode).toBeTruthy();
    // A known non-dimmed core line: the always-visible "Matching on ..." summary is
    // a plain size="sm" Text in the core, so its resolved color is the body text
    // color the class must share (not the muted dimmed token).
    const coreLine = page.getByText(
      "Matching on SSN, last name, date of birth, first name.",
    );
    await expect.element(coreLine).toBeInTheDocument();
    expect(getComputedStyle(classNode!).color).toBe(
      getComputedStyle(coreLine.element()).color,
    );
  });

  test("the raw partner class occupies its OWN element, not folded into a joined sentence", async () => {
    // The security-critical property: the raw partner-controlled class is bound
    // in its own bounded element between the fixed system label and the field
    // label, NOT concatenated into one string a crafted value could impersonate as
    // system chrome. Assert a leaf element holds the class verbatim and alone (its
    // trimmed text is exactly the class), so the fixed label does not share the
    // element with the partner value.
    render({
      ...terms,
      linkageFields: [
        {
          name: "first_name",
          type: "first_name",
          constraints: { allowedCharacters: "^A-Z" },
        },
        { name: "last_name", type: "last_name" },
      ],
      linkageKeys: [{ name: "FN", elements: [{ field: "first_name" }] }],
    });
    const constraints = group(GROUP);
    await expect.element(constraints).toBeInTheDocument();
    // The raw class stands alone in its own leaf node -- the fixed "unverified"
    // label is a separate sibling, never joined into the same string.
    const classNode = Array.from(
      constraints.element().querySelectorAll("*"),
    ).find(
      (el) => el.children.length === 0 && el.textContent.trim() === "^A-Z",
    );
    expect(classNode).toBeTruthy();
    // The fixed system label marking the class partner-supplied and unverified is
    // present as its own text, not folded into the class node.
    expect(constraints.element().textContent).toContain(
      "partner-supplied, unverified",
    );
    expect(classNode!.textContent).not.toContain("unverified");
    // The class is not dressed up as a plain-language "limited to" guarantee.
    expect(constraints.element().textContent).not.toContain("limited to");
  });

  test("no constraints group when no field declares an allowed-character class", async () => {
    // Strip the only constrained field's class: the whole group is gated on at
    // least one field holding one, so it does not render (and no stray heading is
    // left behind).
    render({
      ...terms,
      linkageFields: [
        { name: "ssn", type: "ssn" },
        { name: "first_name", type: "first_name" },
        { name: "last_name", type: "last_name" },
        { name: "dob", type: "date_of_birth" },
      ],
    });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(group(GROUP).query()).toBeNull();
    expect(app.container.textContent).not.toContain(GROUP);
  });

  test("the group caption is a heading, so a screen-reader user can jump to it", async () => {
    render(terms);
    await expect
      .element(page.getByRole("heading", { name: GROUP }))
      .toBeInTheDocument();
  });
});

describe("InvitationTerms: always-visible ingress count in the 'What you receive' tier", () => {
  // The ingress companion to the egress count: an always-visible count of the
  // columns the invitation will SEND the acceptor for matched records (inbound
  // partner data), shown in the "What you receive" tier so the acceptor is on
  // notice before expanding "Other details". Weaker than the egress count -- receiving
  // is not a disclosure by the acceptor -- so it fires only on a non-empty send and
  // never in the inviter's own "proposing" preview (which shows its send as chips in
  // "What you disclose" instead).
  function render(
    linkageTerms: LinkageTerms,
    options?: {
      perspective?: "review" | "proposing";
      disclosedPayloadColumns?: Array<string>;
    },
  ) {
    renderTerms(linkageTerms, options);
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
    // panel, which holds the collapsed detail even while hidden.
    const panel = await readyPanel("Other details");
    expect(panel.textContent).not.toContain(
      "You will receive 2 data columns from your partner",
    );
    // The column NAMES themselves stay one expand down in the disclosure -- the hint
    // shows only the count, not the detail.
    expect(panel.textContent).toContain("diagnosis");
  });

  test("the ingress hint is singular for a single sent column", async () => {
    // The module terms send a single column (risk_score).
    render(terms);
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(app.container.textContent).toContain(
      "You will receive 1 data column from your partner.",
    );
  });

  test("the count derives from the actually-transmitted set held on the token", async () => {
    // disclosedPayloadColumns is the inviter's own disclosure predicate output --
    // exactly the set that flows -- so the hint counts it, not the authored
    // payload.send (a single column here). Three transmitted columns => count 3.
    render(terms, {
      disclosedPayloadColumns: ["ssn", "zip_code", "phone_number"],
    });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(app.container.textContent).toContain(
      "You will receive 3 data columns from your partner.",
    );
  });

  test("the declared-empty 'receive nothing' commitment raises no ingress count and no receive tier", async () => {
    // A present-but-empty disclosed set is the strict "(none)" commitment: there is
    // no incoming data to flag, so the count is absent even though the send is
    // DECLARED.
    // With no ingress (and no request under review), the "What you receive" tier does
    // not render at all -- distinct from Result sharing's "You will receive the
    // matched result" line, which lives in the produce tier.
    render(terms, { disclosedPayloadColumns: [] });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(group("What you receive").query()).toBeNull();
    // ... yet the declared-empty send still shows a bare "(none)" in the detail,
    // confirming this is the declared case (distinct from lazy, which omits the
    // send line).
    const panel = await readyPanel("Other details");
    expect(panel.textContent).toContain("Your partner will send:");
    expect(panel.textContent).toContain("(none)");
    expect(panel.textContent).not.toContain("abort");
  });

  test("a lazy (undeclared) send raises no ingress count and no receive tier", async () => {
    // No send authored and no disclosed set present: the inviter sends whatever its
    // own metadata discloses (lazy), nothing declared up front, so nothing to flag and
    // no "What you receive" tier.
    render({ ...terms, payload: { receive: [] } });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(group("What you receive").query()).toBeNull();
  });

  test("the inviter's own proposing preview shows no ingress count (its send is chips in 'What you disclose')", async () => {
    // Receiving-partner framing is acceptor-only. The inviter's preview shows its
    // send as chips in "What you disclose" already, so the presence is not hidden in
    // Details and the acceptor-framed "you will receive" line is omitted (it would be
    // wrong for the inviter). The module terms request nothing (receive: []), so the
    // inviter has no inbound either and the "What you receive" tier does not render.
    render(terms, { perspective: "proposing" });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(group("What you receive").query()).toBeNull();
    // The send presence is instead shown as the proposing chips, so it is not
    // lost -- just listed under "What you disclose" for the inviter's own view.
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
    perspective?: "review" | "proposing";
    outboundColumns?: Array<string>;
  }) {
    renderTerms(terms, options);
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
    expect(app.container.textContent).toContain(forwardReference);
    // In the always-visible core, not the collapsed detail: it must be clear at
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
    render({ perspective: "review", outboundColumns: ["risk_score"] });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(app.container.textContent).not.toContain(forwardReference);
    expect(app.container.textContent).toContain("risk_score");
  });

  test("gives way even to an empty (chosen-file, nothing-sent) send confirmation", async () => {
    // outboundColumns [] is a chosen file that sends nothing: the explicit "no
    // columns are sent" confirmation renders, so the forward-reference must not --
    // the set IS known (to be empty), the decision no longer pending.
    render({ perspective: "review", outboundColumns: [] });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(app.container.textContent).not.toContain(forwardReference);
    expect(app.container.textContent).toContain(
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
    expect(app.container.textContent).not.toContain(forwardReference);
    expect(app.container.textContent).toContain("Columns sent to your partner");
  });
});

describe("InvitationTerms: the acceptor's outbound send is gated on the inviting party receiving a result", () => {
  // An invitation that gives the inviting party no result transmits no payload at
  // all: the payload step puts an empty message on the wire for a partner not
  // entitled to the result, so no column leaves whatever the acceptor's file holds.
  // A listed set would name a disclosure that does not happen, at the one point the
  // acceptor consents to it. So the direction answers this block for every value of
  // the acceptor's own set -- the chips do not render, the pre-file
  // forward-reference does not stand in (the file it points at cannot change the
  // answer), and the empty-set confirmation gives way to the reason that holds
  // however the operator's file changes. That is the precedence the CLI accept
  // prompt applies (apps/cli/test/unit/commands/accept.test.ts pins it there), so the pair
  // resolves an overlapping case one way rather than two.
  const oneSided: LinkageTerms = {
    ...terms,
    output: { expectsOutput: false, shareWithPartner: true },
  };

  function render(
    linkageTerms: LinkageTerms,
    options: {
      perspective: "review" | "proposing";
      outboundColumns?: Array<string>;
    },
  ) {
    renderTerms(linkageTerms, options);
  }

  // The two lines this one takes precedence over, each asserted absent as its whole
  // sentence so the assertion cannot pass on a shared opening clause.
  const emptySendLine =
    "No columns are sent to your partner; only the linkage result (which of " +
    "your rows matched) is produced.";
  const forwardReference =
    "After you choose your file, you will confirm exactly which of its columns " +
    "are sent to your partner for matched records.";

  test("a chosen file's columns are not listed, and the line states why", async () => {
    render(oneSided, {
      perspective: "review",
      outboundColumns: ["risk_score", "diagnosis"],
    });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    // In the acceptor's own disclosure tier, under the same caption the send list
    // takes, so the fact occupies the slot rather than vanishing from the screen.
    const disclose = group("What you disclose");
    await expect.element(disclose).toBeInTheDocument();
    expect(disclose.element().textContent).toContain(
      "What you will send to your partner",
    );
    expect(disclose.element().textContent).toContain(NO_PAYLOAD_SENTENCE);
    // Neither column name reaches the screen at all: "risk_score" is the module
    // terms' inviter-side send, which renders in Details as what the acceptor
    // RECEIVES, so the acceptor's own set is pinned by the name only it holds.
    expect(app.container.textContent).not.toContain("diagnosis");
    expect(
      page
        .getByRole("list", { name: "What you will send to your partner" })
        .query(),
    ).toBeNull();
  });

  test("wins over the pre-file forward-reference on the review screen", async () => {
    // No file chosen (outboundColumns undefined) on the pre-consent screen: the
    // forward-reference would send the acceptor to look at a file that cannot
    // change this answer.
    render(oneSided, { perspective: "review" });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(app.container.textContent).toContain(NO_PAYLOAD_SENTENCE);
    expect(app.container.textContent).not.toContain(forwardReference);
  });

  test("wins over the empty-set confirmation", async () => {
    // A chosen file that discloses nothing: both statements are true, and the one
    // that survives the operator changing their input file is the one shown.
    render(oneSided, { perspective: "review", outboundColumns: [] });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(app.container.textContent).toContain(NO_PAYLOAD_SENTENCE);
    expect(app.container.textContent).not.toContain(emptySendLine);
  });

  test("does not fire when the inviting party does receive the result", async () => {
    // The direction is the whole of the gate: the same acceptor set renders as
    // chips under the two-sided module terms.
    render(terms, {
      perspective: "review",
      outboundColumns: ["risk_score", "diagnosis"],
    });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(app.container.textContent).not.toContain(NO_PAYLOAD_SENTENCE);
    await expect
      .element(
        page.getByRole("list", { name: "What you will send to your partner" }),
      )
      .toHaveTextContent("diagnosis");
  });

  test("does not fire on the inviter's own preview of these same terms", async () => {
    // The direction control for the mirror. Under THESE terms the acceptor is the
    // party that receives, so the inviter's payload does move and its declared send
    // must still be listed. A preview gated on the acceptor's own fact
    // (inviterReceivesOutput) rather than the inviter's (inviterSharesResult) fails
    // here, which is the one way to get this wrong that suppresses a real
    // disclosure.
    render(oneSided, { perspective: "proposing" });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(app.container.textContent).not.toContain(NO_PAYLOAD_SENTENCE);
    await expect
      .element(page.getByRole("list", { name: "Columns sent to your partner" }))
      .toHaveTextContent("risk_score");
  });
});

describe("InvitationTerms: the inviter's own send is gated on the accepting party receiving a result", () => {
  // The mirror of the block above, and the same run gate: the payload step transmits
  // only to a partner entitled to the result. On the inviter's own preview that
  // partner is the ACCEPTOR, which receives when the invitation shares its result --
  // so the fact is shareWithPartner (summary.inviterSharesResult), not the
  // expectsOutput the acceptor's block reads. Chips naming the inviter's declared
  // send would name columns that never move, on the surface where the inviter is
  // authoring exactly that declaration.
  //
  // The console's direct-exchange framing pairs this same "proposing" perspective
  // with a heading/intro override and nothing else, so it inherits this block; the
  // sentence is viewer-relative ("your partner", "your file"), which is what lets it
  // read correctly there and on the invitation-authoring preview alike.
  const acceptorGetsNothing: LinkageTerms = {
    ...terms,
    output: { expectsOutput: true, shareWithPartner: false },
  };

  test("the declared send is not listed, and the slot states why", async () => {
    renderTerms(acceptorGetsNothing, { perspective: "proposing" });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    // In the inviter's own disclosure tier, under the caption its chips take, so the
    // fact occupies the slot rather than dropping off the screen.
    const disclose = group("What you disclose");
    await expect.element(disclose).toBeInTheDocument();
    expect(disclose.element().textContent).toContain(
      "Columns sent to your partner",
    );
    expect(disclose.element().textContent).toContain(NO_PAYLOAD_SENTENCE);
    // The declared column itself reaches no part of the screen: under "proposing"
    // the send has no "Other details" entry either, so its name is absent outright.
    expect(app.container.textContent).not.toContain("risk_score");
    expect(
      page.getByRole("list", { name: "Columns sent to your partner" }).query(),
    ).toBeNull();
  });

  test("the empty-send confirmation gives way to it", async () => {
    // An inviter declaring no send: both statements are true, and the one shown is
    // the one that holds however the inviter edits its declaration, matching the
    // precedence the acceptor's block applies to its own empty set.
    renderTerms(
      { ...acceptorGetsNothing, payload: { send: [], receive: [] } },
      { perspective: "proposing" },
    );
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(app.container.textContent).toContain(NO_PAYLOAD_SENTENCE);
    expect(app.container.textContent).not.toContain(
      "No columns are sent to your partner; your file is used only to find matches.",
    );
  });

  test("a two-sided invitation still lists the declared send", async () => {
    // The direction is the whole of the gate: the module terms share the result both
    // ways, so the chips render in full.
    renderTerms(terms, { perspective: "proposing" });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(app.container.textContent).not.toContain(NO_PAYLOAD_SENTENCE);
    await expect
      .element(page.getByRole("list", { name: "Columns sent to your partner" }))
      .toHaveTextContent("risk_score");
  });

  test("the acceptor's screens show the mirror of these same terms", async () => {
    // The direction control facing the other way: under terms that give the ACCEPTOR
    // nothing, the acceptor still sends -- the inviting party receives -- so its own
    // outbound list must stand. An acceptor block gated on the inviter's fact fails
    // here.
    renderTerms(acceptorGetsNothing, {
      perspective: "review",
      outboundColumns: ["diagnosis"],
    });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(app.container.textContent).not.toContain(NO_PAYLOAD_SENTENCE);
    await expect
      .element(
        page.getByRole("list", { name: "What you will send to your partner" }),
      )
      .toHaveTextContent("diagnosis");
  });
});

describe("InvitationTerms: the outbound-send caption does not presuppose a non-empty send", () => {
  // The caption above the acceptor's own outbound disclosure is a topic phrase
  // ("What you will send to your partner"), not a declarative "Columns you will
  // send ...": a declarative caption presupposes a non-empty send, so it contradicts
  // its own empty-send body ("No columns are sent ...") and over-asserts a definite
  // send on the pre-file review screen, where the set is not yet known. These pin
  // that the caption is accurate over both branches -- and that the presupposing
  // phrasing does not creep back at either call site.
  function render(options: {
    perspective: "review";
    outboundColumns?: Array<string>;
  }) {
    renderTerms(terms, options);
  }

  const caption = "What you will send to your partner";
  // The declarative phrasing. Asserted absent so a revert that reintroduces the
  // presupposition fails, rather than passing on the "send to your partner" tail
  // both phrasings share.
  const presupposingCaption = "Columns you will send to your partner";

  test("displays as a topic phrase, not a definite send, above the empty-send confirmation", async () => {
    // A chosen file that sends nothing (outboundColumns []): the caption sits above
    // the explicit "No columns are sent ..." body.
    render({ perspective: "review", outboundColumns: [] });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(app.container.textContent).toContain(caption);
    expect(app.container.textContent).toContain(
      "No columns are sent to your partner",
    );
    expect(app.container.textContent).not.toContain(presupposingCaption);
  });

  test("stays truthful on the pre-file review screen, where the send set is not yet known", async () => {
    // perspective review, outboundColumns undefined: the forward-reference stands in
    // for the not-yet-known send, and the caption above it must not assert a definite
    // send at the consent decision point.
    render({ perspective: "review" });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(app.container.textContent).toContain(caption);
    expect(app.container.textContent).not.toContain(presupposingCaption);
  });
});

describe("InvitationTerms: the outbound send states its count before the column names", () => {
  // The send is the reader's own data leaving, and a row of chips leaves the
  // magnitude of it to be totted up. A count line above the chips gives the "how
  // much" first -- visibly, and in DOM order, so a screen reader hears it before it
  // reaches the named list. The line must be truthful in every branch of the slot, so
  // it renders only over a set that is both KNOWN and NON-EMPTY: the empty send, the
  // pre-file review screen, and the no-payload direction each keep their own copy
  // with no count asserted over them.
  const acceptorCaption = "What you will send to your partner";
  const inviterCaption = "Columns sent to your partner";
  // An invitation that gives the inviting party no result: nothing is sent at all, so
  // there is no magnitude to state.
  const oneSided: LinkageTerms = {
    ...terms,
    output: { expectsOutput: false, shareWithPartner: true },
  };

  // The count element itself -- the deepest node whose whole text is the sentence --
  // so the ordering assertion compares that line against the chips rather than an
  // ancestor that contains both.
  function lineWithText(sentence: string): HTMLElement {
    const match = Array.from(app.container.querySelectorAll("*")).find(
      (element) =>
        element.children.length === 0 &&
        element.textContent.trim() === sentence,
    );
    if (!(match instanceof HTMLElement))
      throw new Error(`no element holds exactly: ${sentence}`);
    return match;
  }

  // The count line is present, in the viewer's own disclosure tier, and precedes the
  // chip list it counts.
  async function expectCountLeadsChips(sentence: string, caption: string) {
    const disclose = group("What you disclose");
    await expect.element(disclose).toBeInTheDocument();
    expect(disclose.element().textContent).toContain(sentence);
    const chips = page.getByRole("list", { name: caption });
    await expect.element(chips).toBeInTheDocument();
    expect(
      lineWithText(sentence).compareDocumentPosition(chips.element()) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  }

  test("the acceptor's own send leads with the count of the columns it sends", async () => {
    // A chosen file supplies three columns: the magnitude is stated as a sentence
    // above the three chips, not left to be counted off them.
    renderTerms(terms, {
      perspective: "review",
      outboundColumns: ["risk_score", "diagnosis", "zip"],
    });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    await expectCountLeadsChips(
      "You will send 3 data columns to your partner.",
      acceptorCaption,
    );
  });

  test("a single column is stated in the singular", async () => {
    renderTerms(terms, {
      perspective: "review",
      outboundColumns: ["risk_score"],
    });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    await expectCountLeadsChips(
      "You will send 1 data column to your partner.",
      acceptorCaption,
    );
    // The plural form of the same sentence is not also on screen: a count of one
    // reading "1 data columns" would be the tell of a bare template.
    expect(app.container.textContent).not.toContain("1 data columns");
  });

  test("the inviter's own declared send leads with its count too", async () => {
    // The same slot under "proposing" (the module terms declare one send column), so
    // the two blocks that can hold a column list state their magnitude alike.
    renderTerms(terms, { perspective: "proposing" });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    await expectCountLeadsChips(
      "You will send 1 data column to your partner.",
      inviterCaption,
    );
  });

  test("no count is asserted over an empty send", async () => {
    // A chosen file that sends nothing: the explicit "No columns are sent ..."
    // confirmation stands alone. A count line here would state a send in the same
    // breath as its own denial.
    renderTerms(terms, { perspective: "review", outboundColumns: [] });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(app.container.textContent).toContain(
      "No columns are sent to your partner",
    );
    expect(app.container.textContent).not.toContain("You will send");
  });

  test("no count is asserted on the pre-file review screen, where the set is not known", async () => {
    // outboundColumns undefined at the consent decision point: the forward-reference
    // says the columns are confirmed after a file is chosen, and a count above it
    // would claim a magnitude nothing has determined yet.
    renderTerms(terms, { perspective: "review" });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(app.container.textContent).toContain("After you choose your file");
    expect(app.container.textContent).not.toContain("You will send");
  });

  test("no count is asserted when the partner receives no result", async () => {
    // The direction answers the slot ahead of the acceptor's own set: no column
    // leaves whatever the file holds, so the count of that file's columns would name
    // a send that does not happen.
    renderTerms(oneSided, {
      perspective: "review",
      outboundColumns: ["risk_score", "diagnosis"],
    });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(app.container.textContent).toContain(NO_PAYLOAD_SENTENCE);
    expect(app.container.textContent).not.toContain("You will send");
  });
});

describe("InvitationTerms: every labelled tier is announced through one shared block", () => {
  // The tiers are authored once rather than per tier: each is a role="group" whose
  // FIRST child is the heading that names it, at one level below the terms heading.
  // Pinning that shared structure -- not merely that each caption is a heading --
  // is what makes a tier added later with hand-rolled markup fail here rather than
  // announce differently from its siblings.
  const namedByOwnHeading = [
    "What you disclose",
    "What the exchange produces",
    "What you receive",
    "How records are matched",
    "Partner-defined character constraints",
  ];

  // Terms that bring every tier on screen at once: a two-way payload (so both
  // direction tiers render), the module fixture's constrained field, and its legal
  // agreement.
  const everyTier: LinkageTerms = {
    ...terms,
    payload: { send: [{ name: "risk_score" }], receive: [{ name: "ssn" }] },
  };

  test("each tier is a group named by its own leading heading", async () => {
    renderTerms(everyTier);
    await expect.element(toggle("Other details")).toBeInTheDocument();
    for (const name of namedByOwnHeading) {
      const tier = group(name);
      await expect.element(tier).toBeInTheDocument();
      const element = tier.element();
      // Named from the one visible caption, never a second aria-label that could
      // drift from it.
      expect(element.getAttribute("aria-label")).toBeNull();
      const labelledBy = element.getAttribute("aria-labelledby");
      expect(labelledBy).toBeTruthy();
      const heading = document.getElementById(labelledBy!);
      expect(heading?.textContent).toBe(name);
      // The caption leads its tier, so a reader jumping by heading lands above every
      // fact it names rather than in the middle of them.
      expect(element.firstElementChild).toBe(heading);
      // One level below the terms heading, which defaults to h2 here.
      expect(heading?.tagName).toBe("H3");
    }
  });

  test("the legal agreement takes the same block under a fixed short name", async () => {
    // Its visible heading is a whole sentence, so the group has a short noun
    // phrase as its name instead -- a screen reader would otherwise announce the
    // sentence as the name and then read it again as the heading. The block around it
    // is the same one: a leading heading at the tier level.
    renderTerms(everyTier);
    await expect.element(toggle("Other details")).toBeInTheDocument();
    const legal = group("Legal agreement").element();
    expect(legal.getAttribute("aria-label")).toBe("Legal agreement");
    expect(legal.getAttribute("aria-labelledby")).toBeNull();
    const heading = legal.firstElementChild;
    expect(heading?.tagName).toBe("H3");
    expect(heading?.textContent).toBe(
      "This invitation attaches a legal agreement.",
    );
  });

  test("every tier caption follows the terms heading level together", async () => {
    // headingOrder 1 is the review step, where the terms heading is the page's
    // own h1: every tier caption moves with it, so the outline nests rather than
    // skipping a level -- and moves together, since one component sets them all.
    renderTerms(everyTier, { headingOrder: 1 });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    for (const name of namedByOwnHeading)
      await expect
        .element(page.getByRole("heading", { name, level: 2 }))
        .toBeInTheDocument();
    await expect
      .element(
        page.getByRole("heading", {
          name: "This invitation attaches a legal agreement.",
          level: 2,
        }),
      )
      .toBeInTheDocument();
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
      perspective?: "review" | "proposing";
      disclosedPayloadColumns?: Array<string>;
    },
  ) {
    renderTerms(linkageTerms, options);
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
    // "What the exchange produces" contains the matching method and result sharing --
    // what is revealed and to whom -- announced as one related set, and only that
    // pair: the matching mechanics (the field summary, the "Matching strategies"
    // disclosure) live in their own "How records are matched" tier.
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
    // The field summary and the "Matching strategies" disclosure live in their own
    // mechanics tier, kept below the disclosure/result outcome. The always-visible
    // field summary and the disclosure toggle are both under that group.
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
    // personal-data and duplicate-match blocks), so the describedby never dangles.
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

describe("InvitationTerms: a declared-empty receive is shown, not collapsed with lazy", () => {
  // Mirror of the send-side "(none)" treatment: an authored empty payload.receive
  // is the strict "the acceptor sends nothing" assertion, which the consent screen
  // must show rather than confuse with the lazy (undeclared) case -- the latter
  // accepts whatever the acceptor discloses.
  function render(
    linkageTerms: LinkageTerms,
    perspective?: "review" | "proposing",
  ) {
    renderTerms(linkageTerms, perspective ? { perspective } : undefined);
  }

  test("a declared-empty receive shows the request as (none) in the detail", async () => {
    render({ ...terms, payload: { receive: [] } });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    const panel = await readyPanel("Other details");
    expect(panel.textContent).toContain("Your partner requests from you:");
    expect(panel.textContent).toContain("(none)");
    // The "(none)" is bare: the line renders only for a declared direction (the
    // lazy case below shows none at all), so it is already treated as an explicit
    // declaration, and what a violated declaration costs is docs/CLI.md's to say.
    expect(panel.textContent).not.toContain("abort");
  });

  test("a lazy (undeclared) receive renders no request line", async () => {
    // Send is declared so the block still renders, but with no receive line: an
    // absent receive is lazy, not a request, and must not be treated as "(none)".
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
    expect(panel.textContent).not.toContain("abort");
  });
});

describe("InvitationTerms: the declared payload lists are bounded by count", () => {
  // Both declared directions are the inviter's own text, bounded only by core's
  // MAX_PAYLOAD_ENTRIES and by what each name escapes to at this sink. Painted one
  // item per entry, that is roughly a megabyte of text behind the details disclosure
  // on the one screen holding the consent decision -- usability denial rather than
  // injection, the names being escaped -- so each list paints a fixed number of them
  // and counts the rest.

  // Ordinary content rather than an attack, and outside printable ASCII: U+00E9
  // LATIN SMALL LETTER E WITH ACUTE is what a real declaration holds, and it
  // escapes at this sink, so a name of them spends the whole display allowance.
  // Written as an escape, never a raw byte, so a test about an invisible expansion
  // is itself readable.
  const NON_ASCII = "\u00E9";

  // What the "Other details" panel may paint with both declarations flooded. An
  // ABSOLUTE number, not derived from MAX_DECLARED_NAMES_SHOWN: a ceiling that
  // scaled with the cap would hold even with the cap raised or removed, defeating
  // the check. It leaves roughly 1400 characters of headroom over both directions
  // flooded, so a copy edit does not trip it, while staying far under the megabyte
  // the same declaration paints uncapped -- the gap between a scrollable disclosure
  // and an unreadable one.
  const PANEL_CEILING = 8_000;

  // The declaration at core's own ceiling, every name long enough to spend the whole
  // escaped display allowance: the shape that decides whether the acceptor can still
  // read the terms it is consenting to.
  function flooded(prefix: string): Array<string> {
    return Array.from(
      { length: MAX_PAYLOAD_ENTRIES },
      (_, index) => `${prefix}${index}-${NON_ASCII.repeat(MAX_NAME_LENGTH)}`,
    );
  }

  // Plain fields with no declared constraints, so every <li> inside the panel
  // comes from a payload list: the personal-data block renders a constrained field's
  // constraints as their own bulleted list, which would otherwise be counted in.
  const unconstrainedTerms: LinkageTerms = {
    ...terms,
    linkageFields: terms.linkageFields.map(({ name, type }) => ({
      name,
      type,
    })),
  };

  // The first-party line each direction's block opens with, under the acceptor
  // perspective these tests render.
  const SEND_LABEL = "Your partner will send:";
  const RECEIVE_LABEL = "Your partner requests from you:";

  // One direction's block: the label, the list container holding the painted names,
  // and the unshown-count line when the declaration overran the cap. Located by the
  // first-party label it opens with, so an assertion scoped to one direction cannot
  // read the other's list or the other's count line.
  function directionBlock(panel: HTMLElement, label: string): HTMLElement {
    const blocks = Array.from(panel.querySelectorAll("ul"))
      .map((list) => list.parentElement)
      .filter(
        (block): block is HTMLElement =>
          block !== null && block.textContent.startsWith(label),
      );
    if (blocks.length !== 1)
      throw new Error(
        `expected one declared list labelled "${label}", found ${blocks.length}`,
      );
    return blocks[0];
  }

  // The container a declared name is painted inside, as opposed to the block around
  // it: the two together are what tells an entry from the copy stating what the
  // entries left out.
  function listIn(block: HTMLElement): HTMLElement {
    const list = block.querySelector("ul");
    if (!list) throw new Error("declared list container not found");
    return list;
  }

  // What the block paints outside that container: the label, and the count line when
  // the declaration overran the cap.
  function textOutsideList(block: HTMLElement): string {
    return Array.from(block.children)
      .filter((child) => child.tagName !== "UL")
      .map((child) => child.textContent)
      .join("");
  }

  test("paints at most MAX_DECLARED_NAMES_SHOWN names per direction and counts the rest", async () => {
    const send = flooded("send");
    const receive = flooded("receive");
    // The worst case is checked, not assumed: each of those names spends the whole
    // per-value allowance at this sink and is cut at it, so what is measured below
    // is the worst case and not a mild one.
    const escaped = sanitizeForDisplay(send[0]);
    expect(escaped.endsWith(DISPLAY_TRUNCATION_MARKER)).toBe(true);
    expect(escaped.length).toBeGreaterThan(DEFAULT_MAX_DISPLAY_LENGTH);

    renderTerms({
      ...unconstrainedTerms,
      payload: {
        send: send.map((name) => ({ name })),
        receive: receive.map((name) => ({ name })),
      },
    });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    const panel = await readyPanel("Other details");

    // What the same declaration would paint uncapped, measured rather than asserted
    // from the constants: the bound is only worth pinning against the size it
    // replaces.
    const uncappedSize = [...send, ...receive].reduce(
      (total, name) => total + sanitizeForDisplay(name).length,
      0,
    );
    expect(uncappedSize).toBeGreaterThan(1_000_000);

    // Per list, not in total: each direction gets its own cap, so one flooded
    // declaration cannot spend the other's allowance.
    expect(panel.querySelectorAll("li")).toHaveLength(
      2 * MAX_DECLARED_NAMES_SHOWN,
    );
    // Once per bounded direction, stating that direction's whole remainder, so
    // neither list drops its tail silently. Counted inside the direction's own block
    // and outside its list container rather than across the panel: the sentence is
    // first-party copy about one list, and a panel-wide count would also read the
    // partner text painted inside both.
    const countLine = unshownDeclaredNamesLine(
      MAX_PAYLOAD_ENTRIES - MAX_DECLARED_NAMES_SHOWN,
    );
    for (const label of [SEND_LABEL, RECEIVE_LABEL]) {
      const block = directionBlock(panel, label);
      expect(textOutsideList(block).split(countLine)).toHaveLength(2);
      expect(listIn(block).textContent).not.toContain(countLine);
    }
    expect(panel.textContent.length).toBeLessThanOrEqual(PANEL_CEILING);
  });

  test("states the whole declared magnitude in the core while the lists are bounded", async () => {
    // What the cap costs is legibility of the tail, never the accuracy of what the
    // acceptor is told: the always-visible direction counts are derived from the
    // whole declared set, so a bounded list cannot understate an invitation.
    renderTerms({
      ...unconstrainedTerms,
      payload: {
        send: flooded("send").map((name) => ({ name })),
        receive: flooded("receive").map((name) => ({ name })),
      },
    });
    const disclose = group("What you disclose");
    await expect.element(disclose).toBeInTheDocument();
    expect(disclose.element().textContent).toContain(
      `Your partner requests ${MAX_PAYLOAD_ENTRIES} data columns from you.`,
    );
    const receive = group("What you receive");
    await expect.element(receive).toBeInTheDocument();
    expect(receive.element().textContent).toContain(
      `You will receive ${MAX_PAYLOAD_ENTRIES} data columns from your partner.`,
    );
  });

  test("a declaration under the cap is painted entire, with no count line", async () => {
    // The realistic shape the cap is sized for: a handful of columns, shown whole.
    renderTerms({
      ...unconstrainedTerms,
      payload: {
        send: [{ name: "risk_score" }, { name: "cohort" }],
        receive: [{ name: "site_id" }],
      },
    });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    const panel = await readyPanel("Other details");
    expect(panel.querySelectorAll("li")).toHaveLength(3);
    expect(panel.textContent).not.toContain("more not shown here");
  });

  test("a name containing list separators or the count line's own words is still one item inside the list", async () => {
    // The escape neutralizes control, bidi, and non-ASCII code points and leaves
    // printable ASCII alone, so a declared name may contain a comma or a semicolon --
    // list separators, were the list one line -- or match exactly the first-party
    // sentence stating how many names were not painted. What tells a partner name
    // from that sentence is where it is painted: an entry is a bulleted item inside
    // the direction's list container, and the count line sits outside it.
    const countLine = unshownDeclaredNamesLine(
      MAX_PAYLOAD_ENTRIES - MAX_DECLARED_NAMES_SHOWN,
    );
    // At the head of the declaration, so all three fall inside the painted slice: a
    // name past the cut is not painted at all and would measure nothing.
    const HOSTILE_NAMES = [countLine, "site, cohort", "risk; score"];

    // Flooded to core's ceiling like the checks above, so the count line the
    // declaration produces is the sentence the mimic is written as, but with short
    // filler names: what this measures is placement, not rendered size.
    function ledByHostileNames(prefix: string): Array<string> {
      return Array.from({ length: MAX_PAYLOAD_ENTRIES }, (_, index) =>
        index < HOSTILE_NAMES.length
          ? HOSTILE_NAMES[index]
          : `${prefix}${index}`,
      );
    }

    renderTerms({
      ...unconstrainedTerms,
      payload: {
        send: ledByHostileNames("send").map((name) => ({ name })),
        receive: ledByHostileNames("receive").map((name) => ({ name })),
      },
    });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    const panel = await readyPanel("Other details");

    for (const [label, prefix] of [
      [SEND_LABEL, "send"],
      [RECEIVE_LABEL, "receive"],
    ] as const) {
      const block = directionBlock(panel, label);
      const list = listIn(block);
      // One item per declared name and in the declared order: a name containing a
      // separator is a single entry, never two, and the mimic is an entry rather
      // than the line it appears to be.
      expect(
        Array.from(list.querySelectorAll("li"), (item) => item.textContent),
      ).toEqual(
        ledByHostileNames(prefix)
          .slice(0, MAX_DECLARED_NAMES_SHOWN)
          .map((name) => sanitizeForDisplay(name)),
      );
      // The sentence twice over the direction's block, once on each side of the
      // container: the mimic inside it, the genuine line outside, so the collision
      // is one of content and the placement still separates them.
      expect(list.textContent.split(countLine)).toHaveLength(2);
      expect(textOutsideList(block).split(countLine)).toHaveLength(2);
    }
  });
});

describe("InvitationTerms: the linkage strategy is shown at the consent point", () => {
  // The acceptor adopts the inviter's strategy (mandatory-consistency), and
  // single-pass is disclosure-affecting, so the note lives in the always-visible
  // core -- the acceptor must see the added disclosure before consenting. cascade,
  // the baseline that discloses less, is not flagged.
  function render(
    linkageStrategy: LinkageStrategy,
    perspective?: "review" | "proposing",
  ) {
    renderTerms(
      { ...terms, linkageStrategy },
      perspective ? { perspective } : undefined,
    );
  }

  test("single-pass is flagged always-visible, outside the 'Other details' disclosure", async () => {
    render("single-pass");
    await expect.element(toggle("Other details")).toBeInTheDocument();
    // On screen without expanding any disclosure -- the acceptor sees the added
    // disclosure before consenting.
    expect(app.container.textContent).toContain(
      "This exchange matches in a single pass.",
    );
    // ... and OUTSIDE the "Other details" panel (structure, not styling).
    expect((await readyPanel("Other details")).textContent).not.toContain(
      "This exchange matches in a single pass.",
    );
    // Stated viewer-neutrally: the acceptor itself could be the disclosing party.
    expect(app.container.textContent).toContain("so it may be you");
  });

  test("cascade (the baseline) shows no strategy note", async () => {
    render("cascade");
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(app.container.textContent).not.toContain("matches in a single pass");
  });

  test("the note also appears in the inviter's own proposing preview", async () => {
    // The note is viewer-neutral and not perspective-gated, so the inviter's editor
    // preview (proposing) shows the same note the acceptor will read -- the editor's
    // "author against what the partner sees" intent, and consistent with how the
    // egress/legal facts also render across perspectives. Pinned so the note is not
    // later narrowed to the acceptor perspectives only.
    render("single-pass", "proposing");
    await expect.element(toggle("Other details")).toBeInTheDocument();
    expect(app.container.textContent).toContain(
      "This exchange matches in a single pass.",
    );
  });
});

describe("InvitationTerms: matching on several values per record", () => {
  // A key element that splits its value is matched on each candidate, which
  // widens what meets and adds a disclosure -- so, like the strategy it is
  // coupled to, its consequence is always-visible rather than an expand down.
  // The copy is read from CONSENT_FACTS, the same table the CLI accept prompt
  // renders, so this asserts the shared sentence rather than a second one.
  const fanOutTerms = (linkageStrategy: LinkageStrategy): LinkageTerms => ({
    ...terms,
    linkageStrategy,
    linkageKeys: [
      {
        name: "LN",
        elements: [
          {
            field: "last_name",
            transform: [{ function: "split_on", params: { delimiter: " " } }],
          },
        ],
      },
    ],
  });

  test("states what a splitting key does where the strategy matches candidates", async () => {
    renderTerms(fanOutTerms("single-pass"));
    await expect.element(toggle("Other details")).toBeInTheDocument();
    const panel = await readyPanel("Other details");
    expect(app.container.textContent).toContain(
      CONSENT_FACTS.fanOutCandidates.note,
    );
    expect(panel.textContent).not.toContain(
      CONSENT_FACTS.fanOutCandidates.note,
    );
  });

  test("states the refusal where the strategy matches one value per record", async () => {
    renderTerms(fanOutTerms("cascade"));
    await expect.element(toggle("Other details")).toBeInTheDocument();
    await readyPanel("Other details");
    expect(app.container.textContent).toContain(
      CONSENT_FACTS.fanOutRefused.note,
    );
    expect(app.container.textContent).not.toContain(
      CONSENT_FACTS.fanOutCandidates.note,
    );
  });

  test("says nothing about candidates for terms that declare no split", async () => {
    renderTerms(terms);
    await expect.element(toggle("Other details")).toBeInTheDocument();
    await readyPanel("Other details");
    expect(app.container.textContent).not.toContain(
      CONSENT_FACTS.fanOutCandidates.note,
    );
    expect(app.container.textContent).not.toContain(
      CONSENT_FACTS.fanOutRefused.note,
    );
  });
});

describe("InvitationTerms: a qualifying sentence sits at its headline's visibility level", () => {
  // The consent-integrity invariant this locks in: a sentence that qualifies a
  // headline renders at the SAME visibility level as that headline, never one expand
  // down, so a reader can never see a headline as in force while what qualifies it
  // is hidden. Which level that is follows the HEADLINE's disclosure weight --
  // psi-c's headline states a disclosure GUARANTEE (count only, no identifiers), so
  // it and the tier bounding it are always-visible in the core; the deduplicate and
  // fuzzy headlines state match behavior/breadth, so they and their qualifying
  // sentences sit one expand down together. These assert placement against the
  // accessibility tree (which panel the text lives in), not styling.
  function renderCaveatTerms(overrides?: Partial<LinkageTerms>) {
    renderTerms({ ...terms, ...overrides });
  }

  test("the count-only tier states the disclosure, in the words the CLI accept prompt shows", async () => {
    // A count-only run reveals no identifier, so the psi consequence must not reach
    // this screen; what does is the headline plus every sentence that bounds it.
    //
    // Rendered from core's shared consent probe -- the same terms document the CLI's
    // pin uses -- so the two pins measure one set of sentences against one input.
    renderTerms(COUNT_ONLY_PROBE_TERMS);
    await expect
      .element(group("What the exchange produces"))
      .toBeInTheDocument();
    expect(app.container.textContent).not.toContain(
      "records you have in common are revealed to whoever receives the result",
    );
    // Spelled out because it is shared wording the two surfaces place differently --
    // this screen renders it as its matching-method headline, the CLI accept prompt
    // beneath the algorithm it names -- so its presence here is a fact about this
    // screen and is asserted as one.
    expect(app.container.textContent).toContain(COUNT_ONLY_HEADLINE);
    // Every sentence of the tier, which IS the cross-surface invariant -- the CLI's
    // pin asserts the same five against its own prompt.
    for (const copy of COUNT_ONLY_TIER_NOTES)
      expect(app.container.textContent).toContain(copy);
  });

  test("the count-only tier is always-visible in the core, not one expand down", async () => {
    // psi-c states a disclosure guarantee, so the sentences that bound it sit in the
    // always-visible core; the module terms' deduplicate caveat sits one expand down
    // in "Other details" -- exactly the differentiated-but-consistent rule. The
    // count-only document has deduplicate false, so the pair is measured across
    // the two renders rather than one.
    renderTerms(COUNT_ONLY_PROBE_TERMS);
    await expect.element(toggle("Other details")).toBeInTheDocument();

    // Both disclosures start collapsed, yet the bound is clear: it is in the
    // always-visible core, so the acceptor cannot treat the count-only guarantee as
    // unqualified without also meeting what it does not cover.
    expect(
      toggle("Other details").element().getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      toggle("Matching strategies").element().getAttribute("aria-expanded"),
    ).toBe("false");
    expect(app.container.textContent).toContain(
      CONSENT_FACTS.countOnlyInputChoice.note,
    );

    // Structurally in the core, not inside either disclosure (accessibility tree,
    // not styling): the sentence is within neither the "Other details" panel nor the
    // "Matching strategies" panel, both of which hold their collapsed content even
    // while hidden.
    expect((await readyPanel("Other details")).textContent).not.toContain(
      CONSENT_FACTS.countOnlyInputChoice.note,
    );
    expect((await readyPanel("Matching strategies")).textContent).not.toContain(
      CONSENT_FACTS.countOnlyInputChoice.note,
    );
  });

  test("the deduplicate disclosure statement sits with its headline inside 'Other details', co-hidden", async () => {
    // deduplicate on (module terms). By the rule the statement sits one expand down
    // WITH the headline it qualifies: both are inside the collapsed "Other details"
    // panel, so a reader who does not expand it sees neither -- the headline is
    // never visible as in force while what it costs is hidden. It is the same
    // sentence the CLI accept prompt prints, read from core.
    renderCaveatTerms();
    await expect.element(toggle("Other details")).toBeInTheDocument();

    // The collapse hides its content from assistive tech while closed ...
    const collapse = await readyCollapse("Other details");
    expect(collapse.getAttribute("aria-hidden")).toBe("true");
    // ... and BOTH the headline and the sentence qualifying it live inside it, so
    // neither leaks into the always-visible core ahead of the other.
    expect(collapse.textContent).toContain(
      "More than one of the inviting party's records",
    );
    expect(collapse.textContent).toContain(
      DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT,
    );
    // The direction note keeps that level too: the disclosure this headline makes
    // and whose records are grouped to make it are one reading, so neither may sit
    // an expand away from the other.
    expect(collapse.textContent).toContain(DEDUPLICATE_ACCEPTOR_SIDE_NOTE);
    // This shape presents the accepting party the grouping, so the sole
    // receiver's display limit has nothing to qualify and must not appear.
    expect(app.container.textContent).not.toContain(
      CONSENT_FACTS.duplicateGroupingDisplayLimit.note,
    );
  });

  test("a sole-receiver deduplicating invitation states psilink presents the acceptor no grouping when the inviter alone receives", async () => {
    // The other output shape a deduplicating invitation can take. This party is
    // sent no result, so it is presented no grouping: the shared-result sentence
    // would state a disclosure this client does not make, and the sole-receiver
    // one states what it does. The direction note stays under both shapes, its
    // widening reaching this party either way.
    renderCaveatTerms({
      output: { expectsOutput: true, shareWithPartner: false },
      payload: { send: [], receive: [] },
    });
    await expect.element(toggle("Other details")).toBeInTheDocument();

    const collapse = await readyCollapse("Other details");
    expect(collapse.textContent).toContain(
      DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT,
    );
    // The limit on that withholding keeps the same level as the statement it
    // qualifies, and is read from the shared table with its own basis rather
    // than written into either surface's copy.
    expect(collapse.textContent).toContain(
      CONSENT_FACTS.duplicateGroupingDisplayLimit.note,
    );
    expect(collapse.textContent).toContain(DEDUPLICATE_ACCEPTOR_SIDE_NOTE);
    expect(app.container.textContent).not.toContain(
      DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT,
    );
  });

  // The other half of the cross-surface pin: core's consent classification names
  // the sentence a surface MUST render for a term whose variant turns on a
  // disclosure, and the CLI accept prompt's coverage test is held to the same
  // strings. Driving this screen from the same list is what stops either surface
  // dropping one while still moving its output enough to pass the representation
  // check.
  const pinnedDisclosureProbes = consentRepresentationProbes().filter(
    (probe) =>
      probe.requiredVariantCopy !== undefined &&
      probe.unrepresented.web === undefined,
  );

  test("the consent-coverage check pins at least one disclosure sentence", () => {
    // Without this a filter that matched nothing would leave the per-probe test
    // below green by vacuity.
    expect(pinnedDisclosureProbes.length).toBeGreaterThan(0);
  });

  test.each(pinnedDisclosureProbes)(
    "renders every pinned disclosure sentence for $label",
    async (probe) => {
      renderTerms(probe.variant);
      await expect.element(toggle("Other details")).toBeInTheDocument();
      // Every required and forbidden copy here belongs to the deduplicate term,
      // which sits inside "Other details" (see the co-hidden test above), so
      // waiting for that panel's content to commit is enough to read the whole
      // container safely.
      await readyPanel("Other details");
      // Per probe, not only over the set: an entry with an empty list would
      // otherwise pass by rendering nothing at all.
      const copies = probe.requiredVariantCopy ?? [];
      expect(copies.length).toBeGreaterThan(0);
      for (const copy of copies)
        expect(app.container.textContent).toContain(copy);
      // And the sentence another document shape owes stays off this one, so a
      // screen rendering one sentence for every shape cannot satisfy the pin
      // above while stating a disclosure this shape's run does not make.
      for (const copy of probe.forbiddenVariantCopy ?? [])
        expect(app.container.textContent).not.toContain(copy);
    },
  );

  test("the coverage check measures at least one term under shapes owing different sentences", () => {
    // Without this the forbidden-copy half of the per-probe test above would pass
    // by matching nothing.
    expect(
      pinnedDisclosureProbes.filter(
        (probe) => (probe.forbiddenVariantCopy ?? []).length > 0,
      ).length,
    ).toBeGreaterThan(0);
  });

  test("a deduplicating invitation states its grouping disclosure under either strategy", async () => {
    // The screen withholds what a deduplicating run discloses where the strategy
    // cannot match one, since stating it would describe a run acceptance refuses
    // (assertDeduplicateImplemented). It reads that verdict from core rather than
    // from the strategy's name, and both strategies this build ships match one --
    // so an invitation naming the other still states the disclosure. That the
    // withholding follows a `false` verdict is driven over the whole verdict
    // table in core's invitationSummary.test.ts, which can flip one.
    renderCaveatTerms({ linkageStrategy: "single-pass" });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    const collapse = await readyCollapse("Other details");
    expect(collapse.textContent).toContain(
      "More than one of the inviting party's records",
    );
    expect(collapse.textContent).toContain(
      DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT,
    );
    expect(collapse.textContent).toContain(DEDUPLICATE_ACCEPTOR_SIDE_NOTE);
    expect(app.container.textContent).not.toContain(
      DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT,
    );
  });

  test("a one-to-one invitation states no grouping disclosure at all", async () => {
    // Non-vacuous the other way: the sentences are the setting's doing rather than
    // a fixture of the screen, and a one-to-one exchange discloses no grouping to
    // state and groups neither party's records.
    renderCaveatTerms({ deduplicate: false });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    await readyPanel("Other details");
    expect(app.container.textContent).not.toContain(
      DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT,
    );
    expect(app.container.textContent).not.toContain(
      DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT,
    );
    expect(app.container.textContent).not.toContain(
      DEDUPLICATE_ACCEPTOR_SIDE_NOTE,
    );
  });

  test("the fuzzy caveat sits with its annotation inside the key's own detail, behind the matching disclosure", async () => {
    // A key element with a proposed (not-applied) fuzzy comparison. By the rule
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
    // collapsed "Matching strategies" panel (which holds the nested key detail even
    // while hidden), so it is never shown always-visible like the psi-c caveat.
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

  test("a setting that matches the run has no not-yet-applied caveat", async () => {
    // psi (identifiers revealed -- the run's actual behavior), deduplicate off, and
    // no fuzzy: every displayed setting equals what the run does, so none is
    // flagged. The flag gating itself is asserted in the summarizeInvitation unit
    // tests.
    renderCaveatTerms({
      algorithm: "psi",
      deduplicate: false,
      linkageFields: [{ name: "dob", type: "date_of_birth" }],
      linkageKeys: [{ name: "DOB", elements: [{ field: "dob" }] }],
    });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    // The caveat renders nowhere on the screen. container includes the collapsed
    // panels' mounted content, so this also covers the detail levels, not just the
    // core.
    expect(app.container.textContent).not.toContain(
      "(proposed; not yet applied)",
    );
  });
});

describe("InvitationTerms: the send-columns chip list is named by its visible caption, not a duplicate aria-label", () => {
  // The always-visible send-columns disclosure renders a visible bold caption (the
  // Term) above a ColumnChips list. The list derives its accessible name from that
  // caption via aria-labelledby rather than having a second, separately-authored
  // aria-label with the same text -- so the visible caption is the single source of
  // the list's name and the two cannot drift. (This does not change how often a screen
  // reader speaks the caption: a named list is still announced by name at its boundary,
  // as any labelled region is.) Both same-string call sites are pinned -- the inviter's
  // "proposing" send and the acceptor's own outbound send -- so a fix cannot correct
  // one and leave the twin on a duplicate aria-label.
  function render(options: {
    perspective?: "review" | "proposing";
    outboundColumns?: Array<string>;
  }) {
    renderTerms(terms, options);
  }

  // The list resolves by role + accessible name (so the caption still names it), AND
  // has no aria-label of its own (the name is not duplicated) but an
  // aria-labelledby resolving to the visible caption text (its single source).
  async function expectNamedByVisibleCaptionOnly(caption: string) {
    const list = page.getByRole("list", { name: caption });
    await expect.element(list).toBeInTheDocument();
    const el = list.element();
    // No second, identical name present on the list itself.
    expect(el.getAttribute("aria-label")).toBeNull();
    // Named via the visible caption instead: aria-labelledby -> the caption node,
    // whose text is exactly the caption the list's accessible name derives from.
    const labelledBy = el.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe(caption);
  }

  test("the inviter's proposing send list is named by its visible caption, not a duplicate aria-label", async () => {
    // proposing + a non-empty send (the module terms send risk_score): the chips
    // render under the "Columns sent to your partner" caption.
    render({ perspective: "proposing" });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    await expectNamedByVisibleCaptionOnly("Columns sent to your partner");
  });

  test("the acceptor's outbound send list is named by its visible caption, not a duplicate aria-label", async () => {
    // A chosen file supplies outboundColumns: the acceptor's own send renders as
    // chips under the "What you will send to your partner" caption.
    render({ perspective: "review", outboundColumns: ["risk_score"] });
    await expect.element(toggle("Other details")).toBeInTheDocument();
    await expectNamedByVisibleCaptionOnly("What you will send to your partner");
  });
});

describe("InvitationTerms: no partner-controlled byte reaches the screen", () => {
  // The render half of the display-escaping property core's unit suite asserts
  // by walking the whole summarizeInvitation return value
  // (invitationSummaryBrand, alongside the summarizer it walks). That walk
  // exempts exactly one position,
  // InvitationKeySummary.id -- the raw partner key name, left unsanitized as the
  // stable identity per-key UI state is keyed by. The exemption is sound only
  // while the id reaches no rendered text or attribute, so that is checked here
  // rather than asserted in prose: the same hostile fixture is mounted whole,
  // and every string the screen presents must be printable ASCII, which the raw
  // id (containing a BEL) is not.
  //
  // The mounted tree, not the summary: a component that interpolated a raw
  // linkage-terms value of its own -- past the summary boundary entirely -- is
  // caught here too.

  // Attributes a user reads or hears, as opposed to the structural ones (class,
  // id, aria-controls) that hold no partner text and are not presented.
  const TEXT_ATTRIBUTES = [
    "aria-label",
    "aria-placeholder",
    "aria-valuetext",
    "alt",
    "placeholder",
    "title",
  ];

  // The one code point outside printable ASCII the component's OWN fixed copy
  // puts on the screen: the apostrophe in its swap notes ("...applied to Last
  // name&rsquo;s value"). Allowed by name, and only this one, so the walk below
  // still fails on every other non-ASCII byte -- sanitizeForDisplay escapes
  // U+2019 like any other non-ASCII code point, so no partner string can reach
  // the DOM containing one.
  const FIRST_PARTY_APOSTROPHE = /\u2019/g;

  // Every string the mounted tree presents: each text node, plus the readable
  // attributes above, tagged with where it sits so a failure names the node. A
  // <style> or <script> element's text is program text the browser consumes, not
  // rendered text, so its content is not walked (its readable attributes, of
  // which it has none, would be).
  function presentedStrings(
    node: Node,
    found: Array<{ where: string; text: string }> = [],
  ): Array<{ where: string; text: string }> {
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement?.tagName.toLowerCase() ?? "detached";
      found.push({ where: `${parent} text`, text: node.textContent ?? "" });
      return found;
    }
    if (!(node instanceof Element)) return found;
    const tag = node.tagName.toLowerCase();
    for (const attribute of TEXT_ATTRIBUTES) {
      const value = node.getAttribute(attribute);
      if (value !== null)
        found.push({ where: `${tag}[${attribute}]`, text: value });
    }
    if (tag === "style" || tag === "script") return found;
    for (const child of Array.from(node.childNodes))
      presentedStrings(child, found);
    return found;
  }

  // Open every disclosure so the collapsed detail is on screen and walked. Two
  // passes at least: the per-key disclosures mount only once the matching list
  // above them is open, so they are not present to click in the first.
  async function openEveryDisclosure() {
    for (let pass = 0; pass < 3; pass += 1)
      for (const collapsed of Array.from(
        app.container.querySelectorAll('[aria-expanded="false"]'),
      ))
        await userEvent.click(collapsed);
    await expect
      .poll(
        () => app.container.querySelectorAll('[aria-expanded="false"]').length,
      )
      .toBe(0);
  }

  /**
   * Mount the hostile fixture with the given props, open every disclosure, and
   * require that every string the screen presents is printable ASCII (bar the
   * first-party apostrophe above). `reachedScreen` names raw partner strings
   * whose escaped form must be on screen, so the walk cannot pass over a render
   * that never included the fixture's partner text -- the vacuity guard, with no
   * per-field enumeration behind it.
   */
  async function expectEveryPresentedStringEscaped(
    props: ComponentProps<typeof InvitationTerms>,
    reachedScreen: Array<string>,
  ) {
    app.render(createElement(InvitationTerms, props));
    await expect.element(toggle("Matching strategies")).toBeInTheDocument();
    await openEveryDisclosure();

    for (const raw of reachedScreen)
      await expect
        .poll(() => app.container.textContent)
        .toContain(sanitizeForDisplay(raw));

    const presented = presentedStrings(app.container);
    expect(
      presented.filter(
        (entry) =>
          !PRINTABLE_ASCII.test(entry.text.replace(FIRST_PARTY_APOSTROPHE, "")),
      ),
    ).toEqual([]);
    // The property the allowance above may never soften: not one of the
    // fixture's hostile code points is on the screen, raw.
    for (const hostile of [ESC, RLO, BEL])
      expect(presented.filter((entry) => entry.text.includes(hostile))).toEqual(
        [],
      );
  }

  /**
   * The partner-controlled strings a variant's terms must put on screen for its
   * walk to mean anything: every key's name, shown by its own disclosure
   * toggle, and every declared transform function name -- the deepest per-key
   * detail, which the body renders either as its lead or as the technical line
   * under a plainer one. Read off the terms rather than listed per variant, so a
   * variant added to reach a summary position gets its vacuity guard for free.
   */
  function partnerStringsOnScreen(linkageTerms: LinkageTerms): Array<string> {
    return [
      ...linkageTerms.linkageKeys.map((key) => key.name),
      ...linkageTerms.linkageKeys.flatMap((key) =>
        key.elements.flatMap((element) =>
          (element.transform ?? []).map((step) => step.function),
        ),
      ),
    ];
  }

  // Every variant the unit walk summarizes is mounted here, so the two halves
  // stay agreed on what "escaped" means over the same fixtures rather than only
  // over the one that happened to be shared.
  test.each(hostileVariants)(
    "every string the screen presents is escaped, so the raw key id never reaches the DOM ($name)",
    async ({ source }) => {
      await expectEveryPresentedStringEscaped(
        { linkageTerms: source.linkageTerms },
        partnerStringsOnScreen(source.linkageTerms),
      );
    },
  );

  test("the same holds on the acceptor's review screen, over the columns and expiry the token includes", async () => {
    // The props the accept screen supplies alongside the terms: the
    // disclosed-columns subset the partner's token holds, the acceptor's own file
    // header, and the token's expiry instant -- each reaching the screen through
    // the same display boundary.
    await expectEveryPresentedStringEscaped(
      {
        linkageTerms: hostileTerms,
        perspective: "review",
        disclosedPayloadColumns: [`disclo${RLO}sed`],
        outboundColumns: [`hea${BEL}der`],
        expires: hostileSource.expires,
      },
      [HOSTILE_IDENTITY, `disclo${RLO}sed`, `hea${BEL}der`],
    );
  });
});
