/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test, vi } from "vitest";

import { createElement } from "react";

import "@mantine/core/styles.css";

import { SINGLE_PASS_STAGE_IDS } from "@alcove/core";

import {
  initialRun,
  runWithCompletion,
  runWithPsiProgress,
  runWithStage,
} from "@exchange/exchangeRun";
import { StatusPanel } from "@exchange/StatusPanel";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type { ExchangeRun } from "@exchange/exchangeRun";

// What the operator reads while a PSI operation runs. The figures are derived
// against the clock rather than stored, so what this measures is the rendered
// text: that the line is there at all, that it advances between reports, that
// it is gone whenever no operation runs, and that it sits outside the region a
// screen reader announces -- a line restating itself every second inside that
// region would talk over everything else the screen says.

const app = createAppMount();

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
});

/** A run whose PSI operation started `secondsAgo` seconds before now. */
function runningFor(secondsAgo: number): ExchangeRun {
  const opened = runWithStage(
    initialRun(),
    SINGLE_PASS_STAGE_IDS.encryptingOwnData,
    new Date(),
  );
  return runWithPsiProgress(
    opened,
    { operation: "createServerSetup", elements: 1204, state: "started" },
    new Date(Date.now() - secondsAgo * 1000),
  );
}

/** The mounted panel's whole text, once React has painted it. */
async function mountedText(
  run: ExchangeRun,
  flags: { done: boolean; halted: boolean } = { done: false, halted: false },
): Promise<string> {
  app.render(createElement(StatusPanel, { run, ...flags }));
  return await vi.waitFor(() => {
    const text = app.container.textContent;
    if (text === "") throw new Error("the status panel is not mounted");
    return text;
  });
}

test("a running operation states its count and elapsed time", async () => {
  expect(await mountedText(runningFor(4))).toContain(
    "1,204 values, 4s elapsed",
  );
});

test("the stage label alone stands where no operation runs", async () => {
  // The fallback: a console-conducted run reports no progress at all, and every
  // run has gaps between operations.
  const text = await mountedText(
    runWithStage(
      initialRun(),
      SINGLE_PASS_STAGE_IDS.encryptingOwnData,
      new Date(),
    ),
  );

  expect(text).toContain("Encrypting your data");
  expect(text).not.toContain("elapsed");
});

test("the elapsed figure advances without a second report", async () => {
  await mountedText(runningFor(7));

  await vi.waitFor(
    () => {
      expect(app.container.textContent).toContain("8s elapsed");
    },
    { timeout: 4000, interval: 100 },
  );
});

test("the line is gone once the run completes", async () => {
  const finished = runWithCompletion(runningFor(4), new Date());

  const text = await mountedText(finished, { done: true, halted: false });

  expect(text).not.toContain("elapsed");
});

test("the figures sit outside the announced region", async () => {
  await mountedText(runningFor(4));

  const announced = app.container.querySelector("[aria-live]");
  expect(announced?.textContent).toBe("Encrypting your data");
});
