/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test, vi } from "vitest";

import { createElement } from "react";

// Load Mantine's stylesheet so the alert renders with its real geometry.
import "@mantine/core/styles.css";

import { FailureAlert, REPORTED_CAUSE_LABEL } from "@exchange/RunSurface";
import { RelayedTerminalError } from "@psi/jobClient/serverJobExchangeDriver";
import { failureFor } from "@exchange/useInviterExchange";

import { createAppMount, flushPendingUpdates } from "./renderApp";

vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

// A retryable exchange failure shows the operator the cause the exchange
// reported, and what keeps that from displaying as this application's own
// guidance is the block it renders in rather than anything the text says. So
// what is measured here is the rendered separation: the report outside the
// element holding the seat's sentence, under a label ahead of it, in the face
// this design reserves for data and protocol state. A structural property, not a
// copy one -- a partner can write whatever it likes inside the block, including
// a sentence in console voice, and the tests below drive exactly that.

/** A relayed terminal in console voice: two links, the second telling the
 * operator the run is safe to repeat -- which on a disclosure it is not. */
const REPORT =
  "the exchange stopped before sending anything\n" +
  "caused by: it is safe to run this again";

const app = createAppMount();

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
});

/** The alert a console or web seat shows for that terminal, mounted. */
async function mountedAlert(): Promise<{
  failure: ReturnType<typeof failureFor>;
  message: HTMLElement;
  label: HTMLElement;
  report: HTMLElement;
}> {
  const failure = failureFor("exchange", new RelayedTerminalError(REPORT));
  // The report has to be there at all, or every separation assertion below
  // passes on an alert that shows nothing.
  expect(failure.reportedCause).toBe(REPORT);
  app.render(createElement(FailureAlert, { failure }));
  return await vi.waitFor(() => {
    const paragraphs = [...app.container.querySelectorAll("p")];
    const label = paragraphs.find(
      (node) => node.textContent === REPORTED_CAUSE_LABEL,
    );
    // The alert's title is a span of Mantine's own, so the seat's sentence is
    // found by its text rather than by being the first span in the alert.
    const message = [...app.container.querySelectorAll("span")].find(
      (node) => node.textContent === failure.message,
    );
    if (label === undefined || message === undefined)
      throw new Error("the failure alert is not mounted");
    const report = label.nextElementSibling;
    if (!(report instanceof HTMLElement))
      throw new Error("the label stands with no report after it");
    return { failure, message, label, report };
  });
}

/**
 * The line boxes a block element's text occupies, by their offset down the page.
 * A block yields one rect of its own whatever its text does, so the text is
 * measured through a range over it, which yields a rect per line box.
 */
function lineCount(node: HTMLElement): number {
  const range = document.createRange();
  range.selectNodeContents(node);
  const tops = [...range.getClientRects()].map((rect) => Math.round(rect.top));
  return new Set(tops).size;
}

test("the reported cause renders outside the seat's own sentence", async () => {
  const { failure, message, label, report } = await mountedAlert();

  // The seat's sentence is whole and holds no byte of the report, so no width or
  // content of the report can displace or extend it.
  expect(message.textContent).toBe(failure.message);
  expect(message.textContent).not.toContain("safe to run this again");
  // The report is a sibling block, not inside that sentence's element.
  expect(message.contains(report)).toBe(false);
  expect(report.textContent).toBe(REPORT);
  // The label is DOM text ahead of the report rather than an accessible name, so
  // a reading of the alert -- visual or flattened to one run -- meets the
  // attribution before the words it attributes.
  expect(
    label.compareDocumentPosition(report) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(label.contains(report)).toBe(false);
});

test("the reported cause is set apart from the alert's own type", async () => {
  const { message, report } = await mountedAlert();

  // Mono for words this application did not write, sans for the ones it did:
  // this sheet's own type discipline, and the check that the block's classes
  // actually reach the rendered element rather than being dropped by a typo.
  const reportFace = getComputedStyle(report).fontFamily;
  expect(reportFace).not.toBe(getComputedStyle(message).fontFamily);
  expect(reportFace.toLowerCase()).toContain("monospace");

  // The report is a rendered cause chain, and the only thing holding one link
  // apart from the next is the renderer's own newline. Without `pre-line` the
  // two links run together as one sentence: two line boxes is that break, and
  // both links are short on a wide desktop viewport, so neither wraps for width.
  expect(lineCount(report)).toBe(2);
});

test("a long report scrolls under a label that stays put", async () => {
  // Long enough, past the renderer's own eight-link cap, to land several
  // kilobytes in the block once escaped -- past what 14rem can show flat.
  const links = Array.from(
    { length: 120 },
    (_, i) => `chain link ${i} ` + "x".repeat(280),
  );
  const failure = failureFor(
    "exchange",
    new RelayedTerminalError(links.join("\ncaused by: ")),
  );
  app.render(createElement(FailureAlert, { failure }));
  const mounted = await vi.waitFor(() => {
    const paragraphs = [...app.container.querySelectorAll("p")];
    const foundLabel = paragraphs.find(
      (node) => node.textContent === REPORTED_CAUSE_LABEL,
    );
    if (foundLabel === undefined)
      throw new Error("the failure alert is not mounted");
    const foundReport = foundLabel.nextElementSibling;
    if (!(foundReport instanceof HTMLElement))
      throw new Error("the label stands with no report after it");
    return { label: foundLabel, report: foundReport };
  });
  const { label, report } = mounted;

  // The text element carries the height bound, not the block it sits in, so
  // scrolling it cannot carry the label -- which stands outside it -- along.
  expect(getComputedStyle(report).overflowY).toBe("auto");
  expect(report.scrollHeight).toBeGreaterThan(report.clientHeight);
  expect(report.contains(label)).toBe(false);
});
