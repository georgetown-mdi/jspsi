/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import {
  CONSOLE_COVERAGE_PENDING_LABEL,
  FieldCoverage,
} from "@components/FieldCoverage";

import { createAppMount } from "./renderApp";

const app = createAppMount();

afterEach(app.unmount);

describe("FieldCoverage pending copy", () => {
  test("defaults to the near-instant local check copy", async () => {
    app.render(
      createElement(FieldCoverage, { rate: undefined, pending: true }),
    );
    await expect
      .element(
        page.getByText("Checking how many of your rows produce a value..."),
      )
      .toBeInTheDocument();
  });

  test("the console label says it reads the whole file", async () => {
    // The console sweep is a whole-file streaming pass -- seconds, not instant --
    // so the pending copy must not be treated as an instant local check.
    app.render(
      createElement(FieldCoverage, {
        rate: undefined,
        pending: true,
        pendingLabel: CONSOLE_COVERAGE_PENDING_LABEL,
      }),
    );
    await expect
      .element(
        page.getByText("The console reads the whole file", { exact: false }),
      )
      .toBeInTheDocument();
  });
});
