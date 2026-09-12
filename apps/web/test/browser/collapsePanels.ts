import { expect } from "vitest";

import { page, userEvent } from "vitest/browser";

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

// How long a wait here gives the deferred commit. It lands 50 to 200ms behind
// the core on a machine under four times as many busy processes as cores, and
// was measured past a second on one saturated by other work as well, so
// `expect.poll`'s own 1s default is not a budget these waits can take. The
// browser project bounds a case at 15s, so a wait that overruns this reports
// which panel never committed instead of the case reporting a bare timeout.
const DEFERRED_COMMIT_TIMEOUT_MS = 10_000;

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
    .poll(
      () => {
        // query(), not element(): a not-yet-present toggle is the expected transient
        // (query returns null), while an unexpected fault -- e.g. a strict-mode
        // multiple match -- still throws out of the poll rather than being swallowed.
        const id = disclosureToggle(name)
          .query()
          ?.getAttribute("aria-controls");
        const panel = id ? document.getElementById(id) : null;
        // trim so a whitespace-only intermediate render is not treated as settled.
        return panel?.textContent.trim() ?? "";
      },
      { timeout: DEFERRED_COMMIT_TIMEOUT_MS },
    )
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
 * Resolves once `container` holds a rendered screen and every disclosure on it
 * holds its content.
 *
 * A render reaches the DOM in two commits: the always-visible core, and then
 * each disclosure's content at deferred priority behind it. A whole-container
 * read taken between them sees the screen without its disclosures -- a positive
 * assertion racing the second commit, and a negative one passing on text that
 * had not arrived. An empty container is the state before the first commit, so
 * it does not read as a screen with nothing to wait for; a rendered screen that
 * holds no disclosure resolves at the first read.
 */
export async function readyDisclosures(container: HTMLElement): Promise<void> {
  await expect
    .poll(
      () => {
        // trim so a whitespace-only intermediate render is not treated as settled.
        if (container.textContent.trim() === "") return "";
        const uncommitted = [
          ...container.querySelectorAll("[aria-expanded][aria-controls]"),
        ]
          .filter((toggle) => {
            const id = toggle.getAttribute("aria-controls");
            const panel = id ? document.getElementById(id) : null;
            return (panel?.textContent.trim() ?? "") === "";
          })
          .map((toggle) => toggle.textContent.trim());
        return uncommitted.length === 0
          ? "committed"
          : `awaiting: ${uncommitted.join(", ")}`;
      },
      { timeout: DEFERRED_COMMIT_TIMEOUT_MS },
    )
    .toBe("committed");
}

/**
 * Opens the disclosure named `name` and resolves once it has stopped growing:
 * its content committed, and its panel showing that content whole.
 *
 * Mantine opens a disclosure as a height transition, so for its duration the
 * panel and everything below it are moving. An interaction aimed inside one that
 * is still opening is dispatched at a point its target may already have left,
 * which lands the click on a neighbor and leaves the control untouched -- and
 * the assertion that reads the control's effect then waits out its whole budget
 * on a state nothing produced. The gap between aiming and dispatching widens
 * under CPU contention, which is where that showed up.
 *
 * A panel whose visible height is its whole content's height is one the
 * transition has finished with, under both endings Mantine gives it: the inline
 * height cleared, or pinned to a content height re-measured at the end.
 */
export async function openDisclosure(name: string): Promise<HTMLElement> {
  const panel = await readyPanel(name);
  await userEvent.click(disclosureToggle(name));
  const collapse = collapseFor(name);
  await expect
    .poll(
      () => {
        const shown = collapse.clientHeight;
        const whole = collapse.scrollHeight;
        return shown > 0 && shown === whole
          ? "open"
          : `opening: ${shown} of ${whole}px`;
      },
      { timeout: DEFERRED_COMMIT_TIMEOUT_MS },
    )
    .toBe("open");
  return panel;
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
