/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test, vi } from "vitest";

import { createElement } from "react";

// Load Mantine's stylesheet so the component renders with its real geometry.
import "@mantine/core/styles.css";

import {
  errorWithPartnerCauseLinks,
  joinErrorCauseChain,
  partnerOriginText,
  replaceControlCharactersForDisplay,
} from "@psilink/core";

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

// A value composed onto one of those links holds line breaks of its own -- a
// driven CLI child's stderr diagnosis is a rendered cause chain itself -- and
// they arrive replaced by the printable marker rather than as breaks, which is
// what keeps the child from spelling a link boundary of the seat's chain. So the
// seat lays a break in front of each marker, and the measurements below are
// over that: how many line boxes those markers produce, and what opens each of
// them.

const REFUSAL = "The appliance refused the run.";
const RECOVERY = "Fix the mounted config, then run it again.";

/** What the renderer's own framing opens a link's line with. */
const CAUSE_LINK_OPENING = "caused by: ";

/** The marker a break inside a value arrives as, read off the treatment that
 * writes it rather than restated, as the component reads it. */
const VALUE_LINE_BREAK_MARKER = replaceControlCharactersForDisplay("\n");

/** A label of the shape the console's synthesized terminal introduces the
 * child's stderr with. Its wording is not what these measure. */
const STDERR_LABEL = "the CLI last wrote on stderr: ";

/** Two lines of a CLI diagnosis: its own refusal and its own cause chain, which
 * spells the renderer's framing where the child chose it. */
const CHILD_TAIL = "The run stopped.\ncaused by: the server refused the key.";

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

/**
 * The text of each line box, in order down the page: each character's own client
 * rect, grouped by offset, so what a line holds is what the browser laid out
 * rather than what the string is punctuated with. A character the layout gave no
 * width -- a break it collapsed -- sits in no line box and is skipped.
 */
function renderedLines(span: HTMLSpanElement): Array<string> {
  const text = span.firstChild;
  if (!(text instanceof Text))
    throw new Error("the failure message is not a single text node");
  const range = document.createRange();
  const lines: Array<{ top: number; text: string }> = [];
  for (let index = 0; index < text.data.length; index += 1) {
    range.setStart(text, index);
    range.setEnd(text, index + 1);
    const rect = [...range.getClientRects()].find((each) => each.width > 0);
    if (rect === undefined) continue;
    const top = Math.round(rect.top);
    const line = lines.at(-1);
    if (line !== undefined && line.top === top) line.text += text.data[index];
    else lines.push({ top, text: text.data[index] });
  }
  return lines.map((line) => line.text);
}

/**
 * The message a seat renders for a terminal whose stderr link holds `tail`,
 * built through the real composition: the one elimination for partner-origin
 * text labels, redacts and control-replaces the tail, the relay hands the links
 * on, and the seat's display pass escapes each and joins them. `config` is the
 * category that shows the relayed chain with no copy of its own in front of it,
 * so the lines measured are the chain's.
 */
function seatMessageForStderrTail(tail: string): string {
  const error = errorWithPartnerCauseLinks(
    REFUSAL,
    STDERR_LABEL,
    partnerOriginText(tail),
    { keep: "end" },
  );
  const links: Array<string> = [];
  let link: unknown = error;
  while (link instanceof Error) {
    links.push(link.message);
    link = (link as { cause?: unknown }).cause;
  }
  return failureFor(
    "config",
    new RelayedTerminalError(joinErrorCauseChain(links)),
  ).message;
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

test("a stderr link's own breaks lay its diagnosis out on separate lines", async () => {
  const message = seatMessageForStderrTail(CHILD_TAIL);
  // The tail's break arrives as the marker and the chain holds one framing
  // newline, so a message that broke the line by itself would pass the
  // line-count assertion below without the display pass doing anything.
  expect(message).toContain(VALUE_LINE_BREAK_MARKER);
  expect(message.split("\n")).toHaveLength(2);

  const span = await mountedMessage(message);
  // Every line here is short and the viewport is a wide desktop, so nothing
  // wraps for width: the third line is the marker's.
  expect(lineOffsets(span)).toHaveLength(3);
  expect(renderedLines(span)).toEqual([
    REFUSAL,
    `${CAUSE_LINK_OPENING}${STDERR_LABEL}The run stopped.`,
    `${VALUE_LINE_BREAK_MARKER}${CAUSE_LINK_OPENING}the server refused the key.`,
  ]);
});

test("a line a stderr link's own break opened is not a cause-link boundary", async () => {
  const span = await mountedMessage(seatMessageForStderrTail(CHILD_TAIL));
  const lines = renderedLines(span);

  // The child spelled the renderer's framing text in its own diagnosis, and the
  // line it opens leads with the marker, so the one line that opens as a link
  // boundary is the one the renderer framed.
  expect(lines.filter((line) => line.startsWith(CAUSE_LINK_OPENING))).toEqual([
    `${CAUSE_LINK_OPENING}${STDERR_LABEL}The run stopped.`,
  ]);
  expect(
    lines.filter((line) => line.startsWith(VALUE_LINE_BREAK_MARKER)),
  ).toHaveLength(1);
});

test("the seat breaks the line without changing the message it was handed", async () => {
  const message = seatMessageForStderrTail(CHILD_TAIL);
  const span = await mountedMessage(message);
  // Layout alone: the break is inserted in front of the marker, which stands in
  // the text where the escape left it, so taking the inserted breaks back out
  // returns the string the relay handed the seat byte for byte.
  expect(
    span.textContent.replaceAll(
      `\n${VALUE_LINE_BREAK_MARKER}`,
      VALUE_LINE_BREAK_MARKER,
    ),
  ).toBe(message);
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
