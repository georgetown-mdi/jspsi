/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import { FieldCoverage } from "@components/FieldCoverage";
import { PrepareData } from "@components/PrepareData";

import { expandFieldCards } from "./fieldCards";

import type { Root } from "react-dom/client";

import type { FieldValueCoverage } from "@psi/nonEmptyAggregate";
import type { LinkageTerms } from "@psilink/core";

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
});

function render(node: ReturnType<typeof createElement>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(createElement(MantineProvider, null, node));
}

function rate(partial: Partial<FieldValueCoverage>): FieldValueCoverage {
  return {
    output: "f",
    input: "c",
    total: 100,
    produced: 87,
    rate: 0.87,
    unavailable: false,
    ...partial,
  };
}

describe("FieldCoverage: the visible value-level defense", () => {
  test("a 0% coverage over a non-empty file raises the silent-empty alarm, as a non-live presentation node", async () => {
    render(
      createElement(FieldCoverage, {
        rate: rate({ total: 100, produced: 0, rate: 0 }),
        pending: false,
      }),
    );
    const alarm = page.getByTestId("coverage-silent-empty");
    await expect.element(alarm).toBeInTheDocument();
    await expect.element(alarm).toHaveTextContent("no row");
    // The per-card alarm is announced once for the whole editor by PrepareData's
    // live region, so this node is presentation-only -- never its own live region.
    const node = alarm.element();
    expect(node.getAttribute("role")).toBe("presentation");
    expect(node.getAttribute("aria-live")).toBeNull();
  });

  test("a healthy rate reports the share of rows that produce a value", async () => {
    render(
      createElement(FieldCoverage, {
        rate: rate({ total: 100, produced: 87, rate: 0.87 }),
        pending: false,
      }),
    );
    await expect
      .element(page.getByTestId("coverage-rate"))
      .toHaveTextContent("87 of 100 rows produce a value (87%)");
    expect(page.getByTestId("coverage-silent-empty").elements()).toHaveLength(
      0,
    );
  });

  test("an all-empty-string field reports full coverage and no alarm (a constant key is benign)", async () => {
    // "" counts as produced (100%), so it is NOT the silent-empty alarm; a constant
    // key is dropped by core's linkage before the PSI round, so it is not flagged.
    render(
      createElement(FieldCoverage, {
        rate: rate({ total: 100, produced: 100, rate: 1 }),
        pending: false,
      }),
    );
    await expect
      .element(page.getByTestId("coverage-rate"))
      .toHaveTextContent("100 of 100 rows produce a value (100%)");
    expect(page.getByTestId("coverage-silent-empty").elements()).toHaveLength(
      0,
    );
  });

  test("a tiny but non-zero rate shows <1%, never a 0% that reads like the alarm", async () => {
    render(
      createElement(FieldCoverage, {
        rate: rate({ total: 100000, produced: 3, rate: 3 / 100000 }),
        pending: false,
      }),
    );
    await expect
      .element(page.getByTestId("coverage-rate"))
      .toHaveTextContent("(<1%)");
    expect(page.getByTestId("coverage-silent-empty").elements()).toHaveLength(
      0,
    );
  });

  test("a near-full rate shows >99%, never a 100% while a row is dropped", async () => {
    render(
      createElement(FieldCoverage, {
        rate: rate({ total: 10000, produced: 9999, rate: 9999 / 10000 }),
        pending: false,
      }),
    );
    await expect
      .element(page.getByTestId("coverage-rate"))
      .toHaveTextContent("9,999 of 10,000 rows produce a value (>99%)");
  });

  test("an empty file (zero rows) renders nothing, never a 0% that reads like the alarm", async () => {
    // Render a sentinel beside it so the absence assertion runs after the commit.
    render(
      createElement(
        "div",
        null,
        createElement(FieldCoverage, {
          rate: rate({ total: 0, produced: 0, rate: 0 }),
          pending: false,
        }),
        createElement("span", { "data-testid": "sentinel" }, "ready"),
      ),
    );
    await expect.element(page.getByTestId("sentinel")).toBeInTheDocument();
    expect(page.getByTestId("coverage-rate").elements()).toHaveLength(0);
    expect(page.getByTestId("coverage-silent-empty").elements()).toHaveLength(
      0,
    );
  });

  test("an unavailable rate (steps mid-edit) renders nothing", async () => {
    // Render a sentinel beside it so the absence assertion runs after the commit,
    // not before it (when everything would be trivially absent).
    render(
      createElement(
        "div",
        null,
        createElement(FieldCoverage, {
          rate: rate({ unavailable: true, produced: 0, rate: 0 }),
          pending: false,
        }),
        createElement("span", { "data-testid": "sentinel" }, "ready"),
      ),
    );
    await expect.element(page.getByTestId("sentinel")).toBeInTheDocument();
    expect(page.getByTestId("coverage-silent-empty").elements()).toHaveLength(
      0,
    );
    expect(page.getByTestId("coverage-rate").elements()).toHaveLength(0);
    expect(page.getByTestId("coverage-pending").elements()).toHaveLength(0);
  });

  test("before the first sweep, a pending check is shown", async () => {
    render(createElement(FieldCoverage, { rate: undefined, pending: true }));
    await expect
      .element(page.getByTestId("coverage-pending"))
      .toBeInTheDocument();
  });
});

// One date_of_birth key, so the default standardization derives a parse_date
// pipeline for the column bound to it.
const dobTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-01",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "dob", type: "date_of_birth" }],
  linkageKeys: [{ name: "birth", elements: [{ field: "dob" }] }],
};

describe("PrepareData surfaces a silent-empty collapse before launch", () => {
  test("a shape-satisfiable file whose dates the transform drops shows the alarm and announces it", async () => {
    // The column infers to date_of_birth, so the verdict (SHAPE) is satisfiable --
    // yet these values parse as a date in no candidate format, so format inference
    // finds no signal, the dob pipeline falls back to MM/DD/YYYY, and every value
    // drops to null. This is the exact hazard the aggregate guards: shape passes,
    // value collapses. Two rows keep the sweep inline (below the worker threshold),
    // so no worker is spawned and the result is deterministic.
    render(
      createElement(PrepareData, {
        linkageTerms: dobTerms,
        columns: ["dob"],
        rawRows: [{ dob: "unknown" }, { dob: "unknown" }],
        onLaunch: vi.fn(),
        onBack: vi.fn(),
      }),
    );

    // Shape is satisfiable: the verdict does not block.
    await expect
      .element(page.getByText("All 1 keys can match"))
      .toBeInTheDocument();

    // The field card starts collapsed, so the silent-empty collapse surfaces in the
    // always-visible card header (its body alarm is one expand down). The header
    // marker appears after the debounced sweep settles.
    await expect
      .element(page.getByTestId("field-card-coverage-warning"))
      .toBeInTheDocument();

    // The full body alarm stays hidden inside the collapsed card -- the header marker
    // is the always-visible signal until the field is expanded.
    await expect
      .element(page.getByTestId("coverage-silent-empty"))
      .not.toBeVisible();

    // Expanding the field reveals the full value-level alarm in the card body.
    await expandFieldCards();
    await expect
      .element(page.getByTestId("coverage-silent-empty"))
      .toBeInTheDocument();

    // The collapse is announced through a polite live region (named by the safe
    // semantic-type label, never the partner-controlled field name).
    await expect
      .poll(() =>
        [
          ...container!.querySelectorAll('[role="status"][aria-live="polite"]'),
        ].some((node) =>
          node.textContent.includes(
            "Coverage warning: Date of birth produces no value",
          ),
        ),
      )
      .toBe(true);
  });

  test("an ISO-dated file produces full coverage: the acceptor infers the date format from its own rows", async () => {
    // The acceptor editor always supplies an explicit standardization, so the
    // exchange skips its own inference -- the editor must infer the date layout
    // itself or an ISO file would be parsed as MM/DD/YYYY and drop every dob value.
    // A day past 12 makes YYYY-MM-DD the only candidate, so the inference is
    // unambiguous; with it the dob pipeline parses all rows and coverage is full
    // (no silent-empty alarm). Two rows keep the sweep inline and deterministic.
    render(
      createElement(PrepareData, {
        linkageTerms: dobTerms,
        columns: ["dob"],
        rawRows: [{ dob: "1990-01-31" }, { dob: "1985-12-25" }],
        onLaunch: vi.fn(),
        onBack: vi.fn(),
      }),
    );

    // The card starts collapsed; expand it to read the per-field coverage rate.
    await expandFieldCards();
    await expect
      .element(page.getByTestId("coverage-rate"))
      .toHaveTextContent("2 of 2 rows produce a value (100%)");
    // Full coverage raises neither the body alarm nor the always-visible header
    // warning.
    expect(page.getByTestId("coverage-silent-empty").elements()).toHaveLength(
      0,
    );
    expect(
      page.getByTestId("field-card-coverage-warning").elements(),
    ).toHaveLength(0);
  });
});
