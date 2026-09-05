/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test, vi } from "vitest";

import { createElement } from "react";

// Load Mantine's stylesheet so the component renders with its real geometry.
import "@mantine/core/styles.css";

import { joinErrorCauseChain } from "@psilink/core";

import { FailureMessage } from "@exchange/RunSurface";
import { RelayedTerminalError } from "@psi/jobClient/serverJobExchangeDriver";
import { failureFor } from "@exchange/useInviterExchange";

import { createAppMount, flushPendingUpdates } from "./renderApp";

vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

// A terminal error the seat shows is a cause chain, and the only thing
// separating one link from the next is the renderer's own newline. A newline is
// not a line break by default -- `white-space: normal` collapses it to a space,
// which runs the failure and the recovery step together as one sentence that
// reads like neither. What holds the two apart is `pre-line` on the sink both
// failure alerts show a message through, so this measures the LINE BOXES the
// browser lays the message out on rather than the style property that produced
// them.

const REFUSAL = "The appliance refused the run.";
const RECOVERY = "Fix the mounted config, then run it again.";

const app = createAppMount();

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
});

/** The rendered `<span>` the message lands in, once React has mounted it. */
async function mountedMessage(message: string): Promise<HTMLSpanElement> {
  app.render(createElement(FailureMessage, { message }));
  return await vi.waitFor(() => {
    const span = app.container.querySelector("span");
    if (span === null) throw new Error("the failure message is not mounted");
    return span;
  });
}

/**
 * The line boxes a rendered message occupies, by their offset down the page. An
 * inline element yields a client rect per box fragment rather than per line --
 * a broken line leaves a zero-width fragment behind at its end -- so the
 * distinct offsets are what count the lines.
 */
function lineOffsets(span: HTMLSpanElement): Array<number> {
  const tops = [...span.getClientRects()].map((rect) => Math.round(rect.top));
  return [...new Set(tops)].sort((first, second) => first - second);
}

test("a relayed two-link failure lays its links out on separate lines", async () => {
  // Composed the way a console seat composes one: a relayed terminal error,
  // through the seat's own display pass.
  const { message } = failureFor(
    "config",
    new RelayedTerminalError(joinErrorCauseChain([REFUSAL, RECOVERY])),
  );
  // The framing is a raw newline, which is what the layout below has to break
  // on; a message that lost it would pass a line-count assertion vacuously.
  expect(message).toContain("\n");

  const span = await mountedMessage(message);
  expect(span.textContent).toBe(message);

  // Both links are short and the viewport is a wide desktop, so nothing here
  // wraps for width: two lines means the newline broke the line, and the
  // collapsing default would leave one.
  expect(lineOffsets(span)).toHaveLength(2);
});

test("a single-link failure occupies one line", async () => {
  // The control for the measurement above: the same component, a message with
  // no framing in it, and one line box. Without it a component that broke every
  // line would pass the two-line assertion for the wrong reason.
  const { message } = failureFor("config", new RelayedTerminalError(REFUSAL));
  expect(message).not.toContain("\n");

  const span = await mountedMessage(message);
  expect(lineOffsets(span)).toHaveLength(1);
});
