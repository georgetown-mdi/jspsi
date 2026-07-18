/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import {
  CONSOLE_COVERAGE_PENDING_LABEL,
  FieldCoverage,
} from "@components/FieldCoverage";

import { renderApp } from "./renderApp";

import type { Root } from "react-dom/client";

let container: HTMLElement | undefined;
let root: Root | undefined;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("FieldCoverage pending copy", () => {
  test("defaults to the near-instant local check copy", async () => {
    root!.render(
      renderApp(
        createElement(FieldCoverage, { rate: undefined, pending: true }),
      ),
    );
    await expect
      .element(
        page.getByText("Checking how many of your rows produce a value..."),
      )
      .toBeInTheDocument();
  });

  test("the console label says the appliance reads the whole file", async () => {
    // The console sweep is a whole-file streaming pass on the appliance -- honestly
    // seconds -- so the pending copy must not read as an instant local check.
    root!.render(
      renderApp(
        createElement(FieldCoverage, {
          rate: undefined,
          pending: true,
          pendingLabel: CONSOLE_COVERAGE_PENDING_LABEL,
        }),
      ),
    );
    await expect
      .element(
        page.getByText("The appliance reads the whole file", { exact: false }),
      )
      .toBeInTheDocument();
  });
});
