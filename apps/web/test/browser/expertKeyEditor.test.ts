/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import { authoredLinkageFields } from "@psilink/core";

import { seedAdvancedInvite } from "@psi/advancedInvite";

import { ExpertKeyEditor } from "@components/ExpertKeyEditor";

import type { Root } from "react-dom/client";

// A file carrying every default linkage column, so the seed keeps the full key set
// -- several collapsed key cards, each its own disclosure.
const ALL_COLUMNS = ["ssn", "ssn4", "first_name", "last_name", "dob"];

// The per-key cards in the expert key editor are collapsible disclosures: the
// toggle's aria-controls points at an always-mounted `<div id="key-body-...">`
// wrapper, not the Mantine Collapse panel, so the reference resolves in every state
// however Mantine mounts the closed panel under a reduced-motion preference (the
// same hardening DisclosureSection and InvitationTerms carry). This pins that
// invariant against the accessibility tree once respectReducedMotion is on.

let container: HTMLElement | undefined;
let root: Root | undefined;
let originalMatchMedia: typeof window.matchMedia;

function setReducedMotion(prefersReduced: boolean) {
  window.matchMedia = (query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? prefersReduced : false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  });
}

function render() {
  const { draft } = seedAdvancedInvite("County Health Dept", ALL_COLUMNS);
  const declaredFields = authoredLinkageFields(
    draft.metadata,
    draft.standardization,
  );
  root!.render(
    createElement(
      MantineProvider,
      { theme: { respectReducedMotion: true } },
      createElement(ExpertKeyEditor, {
        draft,
        declaredFields,
        keyIsSatisfiable: () => true,
        fuzzyApplied: false,
        onChange: () => undefined,
        announce: () => undefined,
      }),
    ),
  );
}

// The per-key disclosure toggles: their aria-controls ids are the only ones prefixed
// "key-body-", so this selector excludes the comboboxes inside each (collapsed) key
// body, which carry their own aria-controls.
function keyToggleIds(): Array<string> {
  return Array.from(
    container!.querySelectorAll<HTMLElement>('[aria-controls^="key-body-"]'),
  ).map((el) => el.getAttribute("aria-controls")!);
}

beforeEach(() => {
  originalMatchMedia = window.matchMedia;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  window.matchMedia = originalMatchMedia;
});

describe("ExpertKeyEditor: per-key disclosures stay resolvable under reduced motion", () => {
  test("every collapsed key toggle's aria-controls resolves to a present, hidden wrapper", async () => {
    setReducedMotion(true);
    render();

    // The editor renders at least one key card.
    await expect
      .element(page.getByRole("list", { name: "Linkage keys" }))
      .toBeInTheDocument();
    const ids = keyToggleIds();
    expect(ids.length).toBeGreaterThan(0);

    for (const id of ids) {
      const button = container!.querySelector(`[aria-controls="${id}"]`);
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
