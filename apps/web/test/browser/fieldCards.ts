import { expect } from "vitest";

import { page, userEvent } from "vitest/browser";

/**
 * Expand every collapsible per-field cleaning card currently on screen. Both the
 * inviter's "Clean and bind your fields" workbench and the acceptor's "Clean your
 * data to match" editor render one default-collapsed `CollapsibleFieldCard` per
 * field; their editors (input-column binding, cleaning steps, preview, coverage)
 * are reachable only once expanded.
 *
 * Selects by the `field-card-toggle` test id, not each card's semantic-type
 * label, so it works regardless of field count or heading. Waits for the first
 * toggle to appear (assumes at least one card is present), then clicks every
 * toggle from that render.
 */
export async function expandFieldCards(): Promise<void> {
  const toggles = page.getByTestId("field-card-toggle");
  await expect.element(toggles.first()).toBeInTheDocument();
  for (const toggle of toggles.elements()) await userEvent.click(toggle);
}
