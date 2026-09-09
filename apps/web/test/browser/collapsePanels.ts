import { expect } from "vitest";

import { page } from "vitest/browser";

/**
 * Reads of a Mantine Collapse disclosure that wait for its content to commit.
 *
 * Mantine 9's Collapse mounts a collapsed panel's content inside a React
 * Activity (mode="hidden") boundary that commits at a DEFERRED priority, which
 * can lag the always-visible core under load. Reading a panel synchronously can
 * race that commit (an empty textContent, or a not-yet-present Collapse child),
 * the flake that showed up under full-suite CPU contention, so a test reaches a
 * panel through the helpers here instead.
 *
 * Gating on non-empty (rather than on each asserted substring) suffices because
 * React commits the hidden subtree atomically -- empty, then fully populated in
 * one pass -- so a non-empty panel is a fully-rendered one; a toContain cannot
 * read a torn commit and a not-toContain cannot pass on half-rendered content. A
 * disclosure body that nested its own Suspense/Activity/lazy boundary would split
 * that commit and need a stricter, substring-specific gate.
 */

/** A disclosure's toggle button, located by the accessible name it holds. */
export function disclosureToggle(name: string) {
  return page.getByRole("button", { name });
}

// The always-mounted wrapper a toggle's aria-controls points at, resolved the way
// assistive tech follows the reference. The id lives on this wrapper (not the
// Collapse panel) so it never dangles when Mantine unmounts the closed panel under
// a reduced-motion preference.
function panelFor(name: string): HTMLElement {
  const id = disclosureToggle(name).element().getAttribute("aria-controls");
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

/**
 * The disclosure wrapper named `name`, resolved once its content has committed.
 */
export async function readyPanel(name: string): Promise<HTMLElement> {
  await expect
    .poll(() => {
      // query(), not element(): a not-yet-present toggle is the expected transient
      // (query returns null), while an unexpected fault -- e.g. a strict-mode
      // multiple match -- still throws out of the poll rather than being swallowed.
      const id = disclosureToggle(name).query()?.getAttribute("aria-controls");
      const panel = id ? document.getElementById(id) : null;
      // trim so a whitespace-only intermediate render is not treated as settled.
      return panel?.textContent.trim() ?? "";
    })
    .not.toBe("");
  // panelFor re-resolves the same node: the id lives on an always-mounted wrapper
  // the component never unmounts, so it cannot have been swapped since the poll.
  return panelFor(name);
}

/**
 * The Mantine Collapse element inside a ready panel -- the aria-hidden + inert
 * host -- resolved only after its content has committed.
 */
export async function readyCollapse(name: string): Promise<HTMLElement> {
  await readyPanel(name);
  return collapseFor(name);
}

/**
 * A polling read of the mounted `container`'s whole text, for a screen whose
 * asserted line lives in a collapsed panel: the assertion retries until the
 * deferred commit lands instead of reading the container once, before the panel
 * is in the DOM at all. Assertions after the first read of a given state can stay
 * synchronous, the subtree having committed in one pass.
 */
export function expectCommittedText(container: HTMLElement) {
  return expect.poll(() => container.textContent);
}
