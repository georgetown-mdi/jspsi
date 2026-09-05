/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import { authoredLinkageFields } from "@psilink/core";

import { seedAdvancedInvite } from "@psi/authoring/advancedInvite";

import { ExpertKeyEditor } from "@components/ExpertKeyEditor";

import { restoreMatchMedia, stubReducedMotion } from "./reducedMotion";
import { createAppMount } from "./renderApp";

import type { KeyVerdict } from "@psi/inviterEditor";

// A file holding every default linkage column, so the seed keeps the full key set
// -- several collapsed key cards, each its own disclosure.
const ALL_COLUMNS = ["ssn", "ssn4", "first_name", "last_name", "dob"];

// The per-key cards in the expert key editor are collapsible disclosures: the
// toggle's aria-controls points at an always-mounted `<div id="key-body-...">`
// wrapper, not the Mantine Collapse panel, so the reference resolves in every state
// however Mantine mounts the closed panel under a reduced-motion preference (the
// same hardening DisclosureSection and InvitationTerms have). This pins that
// invariant against the accessibility tree once respectReducedMotion is on.

const app = createAppMount();

function render() {
  const { draft } = seedAdvancedInvite("County Health Dept", ALL_COLUMNS);
  const declaredFields = authoredLinkageFields(
    draft.metadata,
    draft.standardization,
  );
  app.render(
    createElement(ExpertKeyEditor, {
      draft,
      declaredFields,
      keyVerdict: (): KeyVerdict => "satisfiable",
      fuzzyApplied: false,
      onChange: () => undefined,
      announce: () => undefined,
    }),
  );
}

// The per-key disclosure toggles: their aria-controls ids are the only ones prefixed
// "key-body-", so this selector excludes the comboboxes inside each (collapsed) key
// body, which have their own aria-controls.
function keyToggleIds(): Array<string> {
  return Array.from(
    app.container.querySelectorAll<HTMLElement>('[aria-controls^="key-body-"]'),
  ).map((el) => el.getAttribute("aria-controls")!);
}

afterEach(() => {
  app.unmount();
  restoreMatchMedia();
});

describe("ExpertKeyEditor: per-key disclosures stay resolvable under reduced motion", () => {
  test("every collapsed key toggle's aria-controls resolves to a present, hidden wrapper", async () => {
    stubReducedMotion(true);
    render();

    // The editor renders at least one key card.
    await expect
      .element(page.getByRole("list", { name: "Linkage keys" }))
      .toBeInTheDocument();
    const ids = keyToggleIds();
    expect(ids.length).toBeGreaterThan(0);

    for (const id of ids) {
      const button = app.container.querySelector(`[aria-controls="${id}"]`);
      expect(button?.getAttribute("aria-expanded")).toBe("false");
      // Wait for the post-mount reduced-motion effect to collapse the panel away
      // (unmounted, or kept mounted hidden via React Activity -- both leave the
      // detail out of the accessibility tree).
      await expect
        .poll(() => {
          const panel = document.getElementById(id)
            ?.firstElementChild as HTMLElement | null;
          return panel === null || getComputedStyle(panel).display === "none";
        })
        .toBe(true);
      // ... and the wrapper holding the aria-controls id stays present, so the
      // reference never dangles.
      expect(document.getElementById(id)).not.toBeNull();
    }
  });
});
