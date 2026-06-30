/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import { INVITATION_LIFETIME_SECONDS } from "@psilink/core";

import { seedAdvancedInvite } from "@psi/advancedInvite";

import { LinkageTermsEditor } from "@components/LinkageTermsEditor";

import type { Root } from "react-dom/client";

import type { LinkageStrategy, LinkageTerms } from "@psilink/core";

import type { AdvancedInviteSeed } from "@psi/advancedInvite";

// A file carrying every default linkage column, so the seed keeps the full key set.
const ALL_COLUMNS = ["ssn", "ssn4", "first_name", "last_name", "dob"];

let container: HTMLElement | undefined;
let root: Root | undefined;
const onGenerate =
  vi.fn<(terms: LinkageTerms, lifetimeSeconds: number) => void>();

function mount(
  initialIdentity = "County Health Dept",
  columns: Array<string> = ALL_COLUMNS,
  rawRows: Array<Record<string, string>> = [],
  // Override the seeded strategy to stand in for an imported single-pass document
  // (draftFromTerms sets the same draft state directly), so a seeded -- not
  // click-driven -- single-pass can be exercised.
  linkageStrategy?: LinkageStrategy,
): AdvancedInviteSeed {
  const base = seedAdvancedInvite(initialIdentity, columns).seed;
  const seed =
    linkageStrategy === undefined
      ? base
      : { ...base, terms: { ...base.terms, linkageStrategy } };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    createElement(
      MantineProvider,
      null,
      createElement(LinkageTermsEditor, {
        seed,
        initialIdentity,
        rawRows,
        onGenerate,
      }),
    ),
  );
  return seed;
}

const nameField = () => page.getByRole("textbox", { name: "Your name" });
const generateButton = () =>
  page.getByRole("button", { name: "Generate invitation" });

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  onGenerate.mockReset();
});

describe("LinkageTermsEditor", () => {
  test("renders seeded with a live preview and an enabled Generate", async () => {
    mount();
    await expect.element(nameField()).toHaveValue("County Health Dept");
    // The live preview is the acceptor consent renderer in the proposing view.
    await expect
      .element(page.getByText("Exchange proposal"))
      .toBeInTheDocument();
    await expect.element(generateButton()).toBeEnabled();
  });

  test("Generate yields both-receive psi terms and the chosen lifetime", async () => {
    mount();
    await userEvent.click(generateButton());
    expect(onGenerate).toHaveBeenCalledTimes(1);
    const [terms, lifetime] = onGenerate.mock.calls[0];
    // The controls the editor does not expose stay at their safe defaults.
    expect(terms.output).toEqual({
      expectsOutput: true,
      shareWithPartner: true,
    });
    expect(terms.algorithm).toBe("psi");
    expect(terms.deduplicate).toBe(false);
    expect(lifetime).toBe(INVITATION_LIFETIME_SECONDS);
  });

  test("choosing 'Only your partner' yields partner-only output terms", async () => {
    // The 3-way output control is wired to the built terms: selecting the
    // partner-only direction produces the corresponding one-sided output pair (the
    // editor never offers the forbidden "neither receives" combination).
    mount();
    // Wait for the editor to finish its initial render/hydration before driving
    // the Select, so the click does not race an unmounted control under load.
    await expect.element(generateButton()).toBeEnabled();
    // Mantine's Select input has role=combobox; target it by role+name rather than
    // by label, since the open options listbox shares the same aria label (a
    // getByLabelText would match both). Clicking opens the dropdown.
    await userEvent.click(
      page.getByRole("combobox", { name: "Who receives the matched results" }),
    );
    // Select "Only your partner" (the third option) by keyboard, not by clicking
    // the option: the choice is then independent of the option's pixel position,
    // which the editor's tall edit rail can push out of the fixed test viewport.
    // The open dropdown highlights the current value ("both"), so two ArrowDowns
    // reach "Only your partner".
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    await userEvent.click(generateButton());
    const [terms] = onGenerate.mock.calls[0];
    expect(terms.output).toEqual({
      expectsOutput: false,
      shareWithPartner: true,
    });
  });

  test("Reset to recommended restores the output direction to both-receive", async () => {
    // The output direction is the headline new control, so pin that reset returns
    // it to the symmetric default (asserted via Generate, not the Select display).
    mount();
    await expect.element(generateButton()).toBeEnabled();
    await userEvent.click(
      page.getByRole("combobox", { name: "Who receives the matched results" }),
    );
    // Keyboard-select "Only your partner" (see the partner-only test above for
    // why the option is not clicked by position).
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    await userEvent.click(
      page.getByRole("button", { name: "Reset to recommended" }),
    );
    await userEvent.click(generateButton());
    const [terms] = onGenerate.mock.calls[0];
    expect(terms.output).toEqual({
      expectsOutput: true,
      shareWithPartner: true,
    });
  });

  test("clearing the name disables Generate and shows an inline error", async () => {
    mount();
    await userEvent.clear(nameField());
    await expect.element(generateButton()).toBeDisabled();
    await expect
      .element(page.getByText("Enter a name to identify yourself."))
      .toBeInTheDocument();
  });

  test("two identifier columns gate Generate until one is resolved", async () => {
    // Mirrors the acceptor's two-identifier gate (acceptConsentGate.test.ts): `id`
    // and `identifier` both infer to role:identifier, so the seed carries two. The
    // name + dob columns make the LN+FN+DOB key satisfiable (validation otherwise
    // passes), but the grid flags the ambiguous identifier and Generate stays
    // disabled -- with the footer status consistent with the button -- until the
    // operator picks a single one.
    mount("County Health Dept", [
      "id",
      "identifier",
      "first_name",
      "last_name",
      "dob",
    ]);
    // The VISIBLE error is shown for sighted users (queried by testid -- the
    // announcement carries the same text, so a getByText would be ambiguous).
    await expect
      .element(page.getByTestId("identifier-conflict"))
      .toHaveTextContent(
        "Only one column can be the row identifier. Choose a single identifier.",
      );
    await expect.element(generateButton()).toBeDisabled();
    await expect
      .element(page.getByText("Resolve the highlighted items to continue."))
      .toBeInTheDocument();

    // The block is announced, not a silent visual-only footer swap: the footer
    // status's spoken form sits in a SEPARATE, stable polite live region, so a
    // screen reader hears the gate even when the inviter mounts already blocked.
    const footerAnnouncement = page.getByTestId("generate-status-announcement");
    await expect
      .element(footerAnnouncement)
      .toHaveTextContent("still need to be resolved");
    expect(footerAnnouncement.element().getAttribute("role")).toBe("status");
    expect(footerAnnouncement.element().getAttribute("aria-live")).toBe(
      "polite",
    );
    // The VISIBLE footer text is NOT itself a live region (it would otherwise
    // double-announce and fire against the heading focus on mount) -- the symmetric
    // guard to the acceptor verdict's "visible node is not a live region" check.
    const visibleFooter = page
      .getByText("Resolve the highlighted items to continue.")
      .element();
    expect(visibleFooter.closest('[role="status"]')).toBeNull();
    expect(visibleFooter.closest("[aria-live]")).toBeNull();

    // The grid's identifier-conflict reaches assistive tech through a SEPARATE,
    // stable, always-present polite live region that carries the message with no
    // nested role="alert" (which would fire assertively against the heading focus).
    // The deferred empty -> non-empty timing that makes a present-on-mount conflict
    // announce is the hook's job and is not observable here; this asserts the
    // channel. The visible error carries no role of its own, so it neither
    // announces on mount nor double-announces with this region.
    expect(
      page.getByTestId("identifier-conflict").element().getAttribute("role"),
    ).toBeNull();
    const conflictAnnouncement = page.getByTestId(
      "identifier-conflict-announcement",
    );
    await expect
      .element(conflictAnnouncement)
      .toHaveTextContent(
        "Only one column can be the row identifier. Choose a single identifier.",
      );
    expect(conflictAnnouncement.element().getAttribute("role")).toBe("status");
    expect(conflictAnnouncement.element().getAttribute("aria-live")).toBe(
      "polite",
    );
    expect(
      conflictAnnouncement.element().querySelector('[role="alert"]'),
    ).toBeNull();
    // Capture the announcer node to prove the SAME node survives the swap below (a
    // stable channel), not merely that some announcer exists after the re-render.
    const announcerNode = conflictAnnouncement.element();

    // Demote one identifier to Ignored, leaving a single row identifier: the grid
    // error clears and Generate re-enables. The disclosure dropdown opens
    // highlighting the current "Row identifier - not sent" choice; two steps down
    // reach "Ignored" ("Row identifier - not sent" -> "Sent to your partner" ->
    // "Ignored").
    await userEvent.click(
      page.getByRole("combobox", { name: "How column id is used" }),
    );
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    await expect
      .element(page.getByTestId("identifier-conflict"))
      .not.toBeInTheDocument();
    await expect.element(generateButton()).toBeEnabled();

    // The announcement channel is the SAME always-present node across the swap (not
    // a teardown/remount) and clears to empty -- proof the channel is stable rather
    // than mounted with its content.
    expect(page.getByTestId("identifier-conflict-announcement").element()).toBe(
      announcerNode,
    );
    await expect
      .element(page.getByTestId("identifier-conflict-announcement"))
      .not.toHaveTextContent("Only one column can be the row identifier");
  });

  test("Reset to recommended restores the seeded name after an edit", async () => {
    mount();
    await userEvent.clear(nameField());
    await userEvent.fill(nameField(), "Changed Name");
    await userEvent.click(
      page.getByRole("button", { name: "Reset to recommended" }),
    );
    await expect.element(nameField()).toHaveValue("County Health Dept");
  });

  test("a keyboard move control reorders the linkage keys", async () => {
    const seed = mount();
    const firstName = seed.terms.linkageKeys[0].name;
    // Keyboard-operable reorder (move controls, not drag): send the first key
    // later, then generate and confirm the embedded order changed.
    await userEvent.click(
      page.getByRole("button", { name: `Move ${firstName} later` }),
    );
    await userEvent.click(generateButton());
    const [terms] = onGenerate.mock.calls[0];
    expect(terms.linkageKeys[0].name).not.toBe(firstName);
    expect(terms.linkageKeys[1].name).toBe(firstName);
  });

  test("attaching a legal agreement requires a future-dated, complete block", async () => {
    mount();
    await userEvent.click(page.getByText("Attach a legal agreement"));
    // Incomplete -> Generate blocked.
    await expect.element(generateButton()).toBeDisabled();
    await userEvent.fill(
      page.getByRole("textbox", { name: "Agreement reference" }),
      "MOU-2025-0042",
    );
    await userEvent.fill(
      page.getByRole("textbox", { name: "Purpose of the disclosure" }),
      "Program evaluation",
    );
    await userEvent.fill(page.getByLabelText("Expiration date"), "2099-01-01");
    await expect.element(generateButton()).toBeEnabled();
    await userEvent.click(generateButton());
    const [terms] = onGenerate.mock.calls[0];
    expect(terms.legalAgreement?.reference).toBe("MOU-2025-0042");
  });

  test("Expert authoring reveals key editing with psi-c and deduplicate gated off", async () => {
    mount();
    await userEvent.click(
      page.getByRole("switch", { name: "Expert authoring" }),
    );
    // The gated settings are surfaced as controls but disabled until the run
    // applies them, so a count-only (psi-c) or duplicate-matching setting cannot
    // be authored ahead of engine support. This fails loudly if a control is ever
    // wired active prematurely.
    await expect
      .element(page.getByRole("combobox", { name: "Matching method" }))
      .toBeDisabled();
    await expect
      .element(
        page.getByRole("checkbox", {
          name: "Allow more than one of your records to match the same partner record",
        }),
      )
      .toBeDisabled();
    // The element-by-element authoring surface and the import/export escape hatch
    // are present.
    await expect
      .element(page.getByRole("button", { name: "Add a key" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Download JSON" }))
      .toBeInTheDocument();
  });

  test("linkage strategy renders both options, defaults to cascade, and spells out the tradeoff", async () => {
    mount();
    await userEvent.click(
      page.getByRole("switch", { name: "Expert authoring" }),
    );
    // Both options render and cascade is the default selection (so an unchanged
    // expert draft authors cascade, not single-pass).
    const cascade = page.getByRole("radio", { name: "Cascade (recommended)" });
    const singlePass = page.getByRole("radio", { name: "Single-pass" });
    await expect.element(cascade).toBeChecked();
    await expect.element(singlePass).not.toBeChecked();
    // The single-pass option spells out the disclosure tradeoff in its
    // always-visible description, so it is readable before choosing -- and the
    // consent Alert is NOT shown until single-pass is actually selected.
    await expect
      .element(
        page.getByText("one party discloses its full per-key value structure", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    expect(
      page.getByText("Single-pass widens what one of you can observe").query(),
    ).toBeNull();
    // Generating without touching the control authors cascade.
    await userEvent.click(generateButton());
    expect(onGenerate.mock.calls[0][0].linkageStrategy).toBe("cascade");
  });

  test("selecting single-pass surfaces the consent Alert and authors single-pass", async () => {
    mount();
    await userEvent.click(
      page.getByRole("switch", { name: "Expert authoring" }),
    );
    await userEvent.click(page.getByRole("radio", { name: "Single-pass" }));
    // The consent Alert appears at the moment of choice, reinforcing the disclosure
    // the inviter is agreeing to. Asserted by its "alert" role, not just its text:
    // the announcement to assistive technology is load-bearing for the consent, so
    // the live region is the invariant under test, not merely the visible string.
    await expect
      .element(
        page.getByRole("alert", {
          name: "Single-pass widens what one of you can observe",
        }),
      )
      .toBeInTheDocument();
    await userEvent.click(generateButton());
    expect(onGenerate.mock.calls[0][0].linkageStrategy).toBe("single-pass");
  });

  test("an editor seeded with single-pass shows the consent Alert without a click", async () => {
    // The import path (draftFromTerms) sets draft.linkageStrategy directly, so an
    // imported single-pass document opens with the option already selected. The
    // consent Alert must render from that seeded state on entering expert mode, not
    // only after a Radio interaction.
    mount("County Health Dept", ALL_COLUMNS, [], "single-pass");
    await userEvent.click(
      page.getByRole("switch", { name: "Expert authoring" }),
    );
    await expect
      .element(page.getByRole("radio", { name: "Single-pass" }))
      .toBeChecked();
    await expect
      .element(
        page.getByRole("alert", {
          name: "Single-pass widens what one of you can observe",
        }),
      )
      .toBeInTheDocument();
  });

  test("expert keys start collapsed and reveal their element editor on toggle", async () => {
    mount();
    await userEvent.click(
      page.getByRole("switch", { name: "Expert authoring" }),
    );
    // The key header (its name toggle) is visible, but the element editor is
    // collapsed: no "Add an element" control until the key is expanded.
    const firstKey = page
      .getByRole("button", { name: "SSN + LN + DOB" })
      .first();
    await expect.element(firstKey).toBeInTheDocument();
    expect(
      page.getByRole("button", { name: "Add an element" }).query(),
    ).toBeNull();
    // Expanding the key reveals its element editor.
    await userEvent.click(firstKey);
    await expect
      .element(page.getByRole("button", { name: "Add an element" }).first())
      .toBeInTheDocument();
  });

  test("an expert-authored key survives a metadata edit after expert mode is toggled off", async () => {
    // Regression: authoring a key, turning expert mode OFF, then editing a column
    // must not silently re-derive the key list from the template and drop the
    // authored key (the keys are author-controlled once an expert edit occurs).
    mount();
    await userEvent.click(
      page.getByRole("switch", { name: "Expert authoring" }),
    );
    // Author a new key (appended as "New key"), which marks the key list
    // author-controlled. Locate it by its edit-rail reorder control (unique to the
    // editor; the name also appears in the live preview, so plain text is
    // ambiguous).
    const authoredKeyControl = () =>
      page.getByRole("button", { name: "Move New key earlier" });
    await userEvent.click(page.getByRole("button", { name: "Add a key" }));
    await expect.element(authoredKeyControl()).toBeInTheDocument();
    // Back to the guided view; the authored key is still listed.
    await userEvent.click(
      page.getByRole("switch", { name: "Expert authoring" }),
    );
    await expect.element(authoredKeyControl()).toBeInTheDocument();
    // Edit a column's disclosure (any metadata change drives the reconcile path).
    // first_name opens at "match"; one step down selects "payload".
    await userEvent.click(
      page.getByRole("combobox", { name: "How column first_name is used" }),
    );
    await userEvent.keyboard("{ArrowDown}{Enter}");
    // The authored key is still present -- the metadata edit did not clobber it.
    await expect.element(authoredKeyControl()).toBeInTheDocument();
  });

  test("a column-type change in expert mode still reconciles keys when none were authored", async () => {
    // Opening expert mode does not make the keys author-controlled: they are still
    // the metadata template, so a column-type change must re-derive the offerable
    // key set. If reconciliation were suppressed merely because the expert panel is
    // open, a key would keep referencing the dropped field and block Generate.
    mount();
    await expect.element(generateButton()).toBeEnabled();
    await userEvent.click(
      page.getByRole("switch", { name: "Expert authoring" }),
    );
    // Retype dob to "Other" (four options past Date of birth) without touching any
    // key. The date-of-birth-backed keys must drop; Generate stays valid through the
    // remaining ssn/name keys. Keyboard-select so it is independent of option pixel
    // position in the narrow test viewport.
    await userEvent.click(
      page.getByRole("combobox", { name: "Type for column dob" }),
    );
    await userEvent.keyboard(
      "{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{Enter}",
    );
    await expect.element(generateButton()).toBeEnabled();
  });

  test("adding a second element of the same field aliases it rather than crashing the editor", async () => {
    // Regression: the field picker defaults a new element to the first declared
    // field, so a fresh key's only element and the next added element both took the
    // bare "ssn" identifier -- two elements sharing it. That fed the swap control
    // duplicate option values, which Mantine throws on, tearing the whole editor
    // down to the route error boundary. addElement now aliases the colliding element.
    mount();
    await userEvent.click(
      page.getByRole("switch", { name: "Expert authoring" }),
    );
    // A new key starts with a single element of the first declared field (ssn).
    await userEvent.click(page.getByRole("button", { name: "Add a key" }));
    // Add a second element to that new key (the last key's Add control). Without the
    // fix this re-render throws on the duplicate swap option and never settles.
    await userEvent.click(
      page.getByRole("button", { name: "Add an element" }).last(),
    );
    // The second element is aliased (ssn_2): the key keeps unique identifiers and the
    // editor is still standing (its presence is proof the render did not throw).
    await expect
      .element(page.getByRole("button", { name: "Remove element 2 (ssn_2)" }))
      .toBeInTheDocument();
  });

  test("clearing an alias into a duplicate identifier blocks Generate instead of crashing", async () => {
    // The swap control's options are the element identifiers; two elements sharing
    // one would feed it duplicate option values, which Mantine throws on. addElement
    // avoids creating that, but a hand edit can still reach it -- clearing an alias
    // so it falls back to a field name a sibling already uses. The control must drop
    // the duplicate option, leaving validation to block Generate, not tear the
    // editor down.
    mount();
    await userEvent.click(
      page.getByRole("switch", { name: "Expert authoring" }),
    );
    await userEvent.click(page.getByRole("button", { name: "Add a key" }));
    await userEvent.click(
      page.getByRole("button", { name: "Add an element" }).last(),
    );
    // The new element's alias (ssn_2) is the last alias field on the page; clearing
    // it collides its identifier with the sibling ssn element.
    await userEvent.clear(
      page.getByRole("textbox", { name: "Alias (optional)" }).last(),
    );
    // Still standing (the Add control survives), and Generate is blocked on the now
    // schema-invalid key rather than the page being replaced by the error boundary.
    await expect
      .element(page.getByRole("button", { name: "Add a key" }))
      .toBeInTheDocument();
    await expect.element(generateButton()).toBeDisabled();
  });

  test("removing an element keeps focus on that key's Add control", async () => {
    // The removed element row held focus on its trash button; without a deliberate
    // move, focus would fall to document.body. It must land on the owning key's
    // always-present "Add an element" button. (.first() scopes to the first key,
    // whose element labels also appear under other ssn-leading keys.)
    mount();
    await userEvent.click(
      page.getByRole("switch", { name: "Expert authoring" }),
    );
    // Keys start collapsed; expand the first to reach its elements. Its name toggle
    // is the first match -- the edit rail precedes the live preview, which lists the
    // same key.
    await userEvent.click(
      page.getByRole("button", { name: "SSN + LN + DOB" }).first(),
    );
    const firstAddElement = page
      .getByRole("button", { name: "Add an element" })
      .first();
    await userEvent.click(
      page.getByRole("button", { name: "Remove element 1 (ssn)" }).first(),
    );
    await expect.element(firstAddElement).toHaveFocus();
  });

  test("removing a key keeps focus on the Add a key control", async () => {
    mount();
    await userEvent.click(
      page.getByRole("switch", { name: "Expert authoring" }),
    );
    await userEvent.click(
      page.getByRole("button", { name: /^Remove key / }).first(),
    );
    await expect
      .element(page.getByRole("button", { name: "Add a key" }))
      .toHaveFocus();
  });
});
