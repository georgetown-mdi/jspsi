/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

// Load Mantine's stylesheet so components render with their real geometry, as the
// other bench component suites do.
import "@mantine/core/styles.css";

import { sanitizeForDisplay } from "@psilink/core";

import {
  acceptorColumnsEditorState,
  acceptorInitialColumnsState,
  acceptorVerdict,
} from "@bench/acceptorColumnsModel";
import { AcceptorColumnsStep } from "@bench/AcceptorColumnsStep";

import { createAppMount } from "./renderApp";

import type { LinkageTerms } from "@psilink/core";

// The confirm-columns step under an invitation whose declared payload set for this
// party is NON-EMPTY and disagrees with the operator's marks. The empty-declaration
// notice on the same screen has its own coverage in benchAccept.test.ts; what is
// asserted here is the half that only rendering can show -- that both directions
// reach the operator in one statement, and that the two provenances of the names in
// it are treated differently at this sink.
const app = createAppMount();

afterEach(() => {
  app.unmount();
});

// Two single-element keys, one per name field, so the file below satisfies both and
// the declaration conflict is the only thing that can close the launch.
const acceptorTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "firstName", type: "first_name" },
    { name: "lastName", type: "last_name" },
  ],
  linkageKeys: [
    { name: "first", elements: [{ field: "firstName" }] },
    { name: "last", elements: [{ field: "lastName" }] },
  ],
};

// Written as an escape, never as a raw byte, so a test about an invisible character
// is itself readable: U+202E RIGHT-TO-LEFT OVERRIDE reorders the copy around it
// wherever it is rendered unescaped and uncontained.
const RLO = "\u202E";

function mountStep(linkageTerms: LinkageTerms, columns: Array<string>) {
  const rows = [Object.fromEntries(columns.map((c) => [c, "x"]))];
  const columnsState = acceptorInitialColumnsState(columns);
  const editorState = acceptorColumnsEditorState(
    columnsState,
    linkageTerms,
    rows,
  );
  const noop = () => undefined;
  app.render(
    createElement(AcceptorColumnsStep, {
      linkageTerms,
      columns,
      columnsState,
      editorState,
      verdict: acceptorVerdict(columns, linkageTerms, editorState),
      onMetadataChange: noop,
      onRemap: noop,
      onReset: noop,
      onLaunch: noop,
      onBack: noop,
    }),
  );
}

describe("acceptor columns step: a disagreeing non-empty declaration", () => {
  test("states both directions at once, escaping the declared name and isolating the operator's own", async () => {
    // The declaration names a column this file does not send, while the file sends
    // one the declaration does not name: core refuses that pair in a single
    // message, so the screen must state both halves at once rather than reveal the
    // second after the first is cleared.
    const declaredName = `risk${RLO}score`;
    const ownHeader = `notes${RLO}evil`;
    mountStep(
      { ...acceptorTerms, payload: { receive: [{ name: declaredName }] } },
      ["first_name", "last_name", ownHeader],
    );

    await expect
      .element(
        page.getByText("Your columns do not match what your partner expects"),
      )
      .toBeInTheDocument();

    // The operator's OWN header, named as the grid row they have to change names
    // it: isolated, never escaped.
    const marked = app.container.querySelector<HTMLElement>("li bdi");
    expect(marked?.textContent).toBe(ownHeader);
    expect(app.container.textContent).not.toContain(
      sanitizeForDisplay(ownHeader),
    );

    // The declared name is the partner's text on this path, so it reaches the
    // operator escaped -- the opposite treatment, in the same notice.
    expect(app.container.textContent).toContain(
      sanitizeForDisplay(declaredName),
    );
    expect(app.container.textContent).not.toContain(declaredName);

    // The gate, and what a keyboard/screen-reader user at the button hears: the
    // sentence names the disagreement the notice above is titled with.
    const start = page.getByRole("button", { name: "Start the exchange" });
    await expect.element(start).toBeDisabled();
    const reasonId = start.element().getAttribute("aria-describedby");
    expect(reasonId).toBeTruthy();
    expect(document.getElementById(reasonId!)?.textContent).toBe(
      "Resolve the columns that do not match what your partner expects above before you can start.",
    );
  });

  // The file the two tests below both use: it satisfies every key and discloses
  // exactly one column, so the declaration is the only thing closing the launch.
  const columns = ["first_name", "last_name", "notes"];

  test("says a declared column is absent from the file, and offers no local edit for it", async () => {
    // A column this file does not carry cannot be marked at all, so the entry says
    // so and the remedies stay the partner's or a different file's.
    mountStep(
      {
        ...acceptorTerms,
        payload: { receive: [{ name: "notes" }, { name: "risk_score" }] },
      },
      columns,
    );
    await expect
      .element(
        page.getByText("Your partner expects a column you are not sending"),
      )
      .toBeInTheDocument();
    expect(app.container.textContent).toContain(
      "risk_score - not a column in this file",
    );
    expect(app.container.textContent).toContain(
      "or choose a file that has that column",
    );
    expect(app.container.textContent).not.toContain(
      "Where your file does have such a column",
    );
  });

  test("offers marking a declared column the file does have, after the partner's remedy and with its cost", async () => {
    // The same direction where the secondary remedy exists: the declared column is
    // in this file (currently used for matching). It is offered only after the
    // corrected invitation, and never without what it costs.
    mountStep(
      {
        ...acceptorTerms,
        payload: { receive: [{ name: "notes" }, { name: "first_name" }] },
      },
      columns,
    );
    await expect
      .element(
        page.getByText("Your partner expects a column you are not sending"),
      )
      .toBeInTheDocument();
    expect(app.container.textContent).toContain(
      "Ask your partner for an invitation that expects what your file sends." +
        " Where your file does have such a column, you can set it to " +
        '"Sent to your partner" below instead - that discloses more than you ' +
        "have marked so far, and takes the column out of matching.",
    );
    expect(app.container.textContent).not.toContain(
      "not a column in this file",
    );
  });
});
