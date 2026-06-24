import { expect } from "vitest";

import { page, userEvent } from "vitest/browser";

/**
 * Expand every collapsible per-field cleaning card currently on screen. Both the
 * inviter's "Clean and bind your fields" workbench and the acceptor's "Clean your
 * data to match" editor render one default-collapsed `CollapsibleFieldCard` per
 * field; their editors (input-column binding, cleaning steps, preview, coverage)
 * are reachable only once expanded.
 *
 * Selects by the card's stable `field-card-toggle` test id rather than each card's
 * semantic-type label, so a test stays correct as fields are added or types are
 * relabelled -- it expands whatever cards render, however many and whatever their
 * headings. Awaits the first toggle so it is robust to a render that commits after
 * the call (assumes at least one card is present); the snapshot is then read once
 * all cards from that commit are mounted.
 */
export async function expandFieldCards(): Promise<void> {
  const toggles = page.getByTestId("field-card-toggle");
  await expect.element(toggles.first()).toBeInTheDocument();
  for (const toggle of toggles.elements()) await userEvent.click(toggle);
}
