/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test, vi } from "vitest";

import { createElement } from "react";

// Load Mantine's stylesheet so the component renders with its real geometry.
import "@mantine/core/styles.css";

import {
  DEFAULT_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  errorWithPartnerCauseLinks,
  joinErrorCauseChain,
  partnerOriginText,
  replaceControlCharactersForDisplay,
} from "@psilink/core";

import {
  FailureAlert,
  FailureMessage,
  REPORTED_CAUSE_LABEL,
} from "@exchange/RunSurface";
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
//
// Which element holds that chain is the category's choice -- the message span
// where the category has no copy of its own, the labeled report block where it
// does -- and a retained stderr tail reaches the operator through either, so
// both are measured.

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

/**
 * A diagnosis of several lines, for the over-budget delivery the fit truncates.
 * Each line is short enough that the wide desktop viewport lays it out on one
 * line box, and each opens on a word of its own, so a line the cut kept whole is
 * told from one the cut landed inside. The last spells the renderer's framing
 * where the child chose it, away from the head of its line.
 */
const TRUNCATED_CHILD_LINES = [
  "alpha: the run stopped in step one",
  "bravo: the key file was unreadable",
  "charlie: the server closed the link",
  "delta: no results were written out",
  "echo: the retry window has expired",
  "foxtrot: caused by: the key refused",
];

/** The line the cut drops, wide enough that the tail runs past the value's
 * budget whatever the padding below adds. */
const DROPPED_CHILD_LINE =
  "the run wrote this line first, and the fit drops it";

/**
 * The room the value's budget leaves its text, once the fit has paid for the
 * truncation notice out of that same budget. The budget is core's default
 * display bound, which the one elimination fits each value to and exports under
 * no name of its own.
 *
 * A cut that fell on either EDGE of a control-character marker fills this room;
 * a cut that fell INSIDE one leaves it short by the marker fragment the fit
 * trimmed off the head of what it kept.
 */
const TRUNCATED_VALUE_ROOM =
  DEFAULT_MAX_DISPLAY_LENGTH - DISPLAY_TRUNCATION_MARKER.length;

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
 * The labeled report block of a mounted failure alert, found by the label ahead
 * of it -- the alert's title is a span of Mantine's own, so the block is reached
 * through the label rather than by position among the alert's elements.
 */
async function mountedReport(
  failure: ReturnType<typeof failureFor>,
): Promise<HTMLElement> {
  app.render(createElement(FailureAlert, { failure }));
  return await vi.waitFor(() => {
    const label = [...app.container.querySelectorAll("p")].find(
      (node) => node.textContent === REPORTED_CAUSE_LABEL,
    );
    const report = label?.nextElementSibling;
    if (!(report instanceof HTMLElement))
      throw new Error("the failure alert shows no reported cause");
    return report;
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
function renderedLines(element: HTMLElement): Array<string> {
  const text = element.firstChild;
  if (!(text instanceof Text))
    throw new Error("the rendered failure text is not a single text node");
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
 * The terminal error a seat is handed for a run whose stderr link holds `tail`,
 * built through the real composition: the one elimination for partner-origin
 * text labels, redacts and control-replaces the tail, and the relay hands the
 * rendered links on as one message.
 */
function relayedTerminalForStderrTail(tail: string): RelayedTerminalError {
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
  return new RelayedTerminalError(joinErrorCauseChain(links));
}

/**
 * The message a seat renders for that terminal, through the seat's own display
 * pass. `config` is the category that shows the relayed chain with no copy of
 * its own in front of it, so the lines measured are the chain's.
 */
function seatMessageForStderrTail(tail: string): string {
  return failureFor("config", relayedTerminalForStderrTail(tail)).message;
}

/**
 * A seat message for a tail too wide for its budget, whose cut fell INSIDE one
 * of the tail's own line-break markers: the fit trims the fragment that leaves
 * behind (`trimPartialControlCharacterMarkerAtStart`), so the child's next line
 * opens what the cut kept with nothing marking its head.
 *
 * Reached by composing rather than by arithmetic over the budgets. The fit keeps
 * the END of the value, so what a marker's distance from the cut depends on is
 * the text AFTER it: one padding character on the tail's last line moves the cut
 * one place, and a short search over that padding reaches every offset the cut
 * can take inside a marker. The kept text being short of
 * {@link TRUNCATED_VALUE_ROOM} is what tells such a cut from one that fell on
 * the marker's edge, which keeps the same line whole and trims nothing.
 */
function messageCutInsideAValueLineBreak(): {
  message: string;
  firstKeptLine: string;
  kept: string;
} {
  for (let padding = 0; padding <= 64; padding += 1) {
    const message = seatMessageForStderrTail(
      [
        DROPPED_CHILD_LINE,
        ...TRUNCATED_CHILD_LINES.slice(0, -1),
        `${TRUNCATED_CHILD_LINES.at(-1)}${".".repeat(padding)}`,
      ].join("\n"),
    );
    const truncatedAt = message.indexOf(DISPLAY_TRUNCATION_MARKER);
    if (truncatedAt === -1) continue;
    const kept = message.slice(truncatedAt + DISPLAY_TRUNCATION_MARKER.length);
    const firstKeptLine = TRUNCATED_CHILD_LINES.find((line) =>
      kept.startsWith(line),
    );
    if (firstKeptLine !== undefined && kept.length < TRUNCATED_VALUE_ROOM)
      return { message, firstKeptLine, kept };
  }
  throw new Error("no padding length cut the tail inside a line-break marker");
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

test("the reported cause block lays the same diagnosis out on those lines", async () => {
  // The route a retained tail takes on a dropped exchange: the generic failure
  // states fixed copy of its own, so the relayed chain renders in the labeled
  // block instead of the message span (`failureFor` in
  // `@exchange/useInviterExchange`).
  const failure = failureFor(
    "exchange",
    relayedTerminalForStderrTail(CHILD_TAIL),
  );
  const reportedCause = failure.reportedCause;
  if (reportedCause === undefined)
    throw new Error("the exchange failure reports no cause");
  expect(reportedCause).toContain(VALUE_LINE_BREAK_MARKER);
  // The seat's sentence is fixed copy with no marker in it, so the lines below
  // are the report's own and the sentence is left as the seat wrote it.
  expect(failure.message).not.toContain(VALUE_LINE_BREAK_MARKER);

  const report = await mountedReport(failure);
  expect(renderedLines(report)).toEqual([
    REFUSAL,
    `${CAUSE_LINK_OPENING}${STDERR_LABEL}The run stopped.`,
    `${VALUE_LINE_BREAK_MARKER}${CAUSE_LINK_OPENING}the server refused the key.`,
  ]);
  // Layout alone here as in the span: taking the inserted breaks back out
  // returns the report the seat was handed byte for byte.
  expect(
    report.textContent.replaceAll(
      `\n${VALUE_LINE_BREAK_MARKER}`,
      VALUE_LINE_BREAK_MARKER,
    ),
  ).toBe(reportedCause);
});

test("a chain composed into a seat's own sentence breaks on those lines too", async () => {
  // The lost-local-write copy composes the chain onto the end of its own
  // sentence, so the message span holds both voices. The sentence wraps for
  // width at this viewport, so what is measured is the line the marker opened
  // rather than the whole layout.
  const { message } = failureFor(
    "output",
    relayedTerminalForStderrTail(CHILD_TAIL),
  );
  expect(message).toContain(VALUE_LINE_BREAK_MARKER);

  const span = await mountedMessage(message);
  expect(
    renderedLines(span).filter((line) =>
      line.startsWith(VALUE_LINE_BREAK_MARKER),
    ),
  ).toEqual([
    `${VALUE_LINE_BREAK_MARKER}${CAUSE_LINK_OPENING}the server refused the key.`,
  ]);
});

test("a truncated delivery opens no line on the child's own text", async () => {
  const { message, firstKeptLine, kept } = messageCutInsideAValueLineBreak();
  // The cut fell inside the marker in front of this line: the line arrives
  // whole, the marker is gone, and what the trimmed fragment cost is what the
  // kept text is short by.
  expect(message).toContain(`${DISPLAY_TRUNCATION_MARKER}${firstKeptLine}`);
  expect(kept.length).toBeLessThan(TRUNCATED_VALUE_ROOM);

  const span = await mountedMessage(message);
  const lines = renderedLines(span);
  expect(lines[0]).toBe(REFUSAL);
  // The kept text continues the line the label and the truncation notice
  // opened rather than opening one of its own, which is the case no marker
  // stands in front of.
  expect(lines[1]).toBe(
    `${CAUSE_LINK_OPENING}${STDERR_LABEL}${DISPLAY_TRUNCATION_MARKER}${firstKeptLine}`,
  );
  expect(lines.filter((line) => line.startsWith(firstKeptLine))).toEqual([]);
  // Every other line is one of the tail's own breaks, with the marker at its
  // head, so no line the child's text opened reads as a link boundary -- the
  // last of them spells `caused by: ` behind that marker.
  expect(
    lines.slice(2).filter((line) => !line.startsWith(VALUE_LINE_BREAK_MARKER)),
  ).toEqual([]);
  // One line per break the tail holds, plus the two the renderer framed: a line
  // that wrapped for width would leave a line more than the breaks account for.
  expect(lines).toHaveLength(
    message.split(VALUE_LINE_BREAK_MARKER).length - 1 + 2,
  );
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
