/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import { DefaultExchangeColumns } from "@components/DefaultExchangeColumns";

import type { Root } from "react-dom/client";

// DefaultExchangeColumns reads the chosen file's header (real loadCSVColumns runs in
// the browser project) and surfaces the columns the quick invite path would send,
// derived from the same predicate the wire transmits on. This suite drives the
// component through a tiny stateful harness whose buttons swap the selected file, so
// the disclosure's appear/withdraw transitions can be awaited rather than raced.

const DISCLOSING = ["first_name,record_id,notes\n", "Alice,1,vip\n"];
const ALL_LINKAGE = ["first_name,ssn\n", "Alice,123-45-6789\n"];

function Harness() {
  const [files, setFiles] = useState<Array<File>>([]);
  return createElement(
    "div",
    null,
    createElement(
      "button",
      {
        "data-testid": "disclosing",
        onClick: () => setFiles([new File(DISCLOSING, "data.csv")]),
      },
      "disclosing",
    ),
    createElement(
      "button",
      {
        "data-testid": "linkage",
        onClick: () => setFiles([new File(ALL_LINKAGE, "data.csv")]),
      },
      "linkage",
    ),
    createElement(DefaultExchangeColumns, { files }),
  );
}

let container: HTMLElement | undefined;
let root: Root | undefined;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(createElement(MantineProvider, null, createElement(Harness)));
}

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("DefaultExchangeColumns", () => {
  test("with no file chosen, nothing is shown", () => {
    mount();
    // No async read runs for an empty selection, so a synchronous check is safe.
    expect(page.getByText("Default exchange columns").query()).toBeNull();
  });

  test("surfaces exactly the columns the quick path would send, as a chip list", async () => {
    mount();
    await userEvent.click(page.getByTestId("disclosing"));

    await expect
      .element(page.getByText("Default exchange columns"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(/you will send your partner these elements/))
      .toBeInTheDocument();
    // The disclosed set, derived from the same predicate the wire uses -- the
    // inferred row identifier and the other column, never the linkage one -- as
    // chips.
    await expect.element(page.getByText("record_id")).toBeInTheDocument();
    await expect.element(page.getByText("notes")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("first_name");
    // The changeability cue accompanies a non-empty chip list, pointing at the
    // invite panel's Advanced Options without adding a control here.
    await expect
      .element(page.getByText(/change what you send in Advanced Options/))
      .toBeInTheDocument();
  });

  test("affirms that nothing is sent when the quick path would send no columns", async () => {
    mount();
    // Start with a disclosing file so the chip list is present...
    await userEvent.click(page.getByTestId("disclosing"));
    await expect
      .element(page.getByText(/you will send your partner these elements/))
      .toBeInTheDocument();

    // ...then a file whose columns are all linkage types: nothing is disclosed, so
    // the chip list gives way to a short positive affirmation (not an empty render),
    // keyed on the same derived array being empty.
    await userEvent.click(page.getByTestId("linkage"));
    await expect
      .element(
        page.getByText("No values will be sent to your partner.", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    // The chip sentence and cue are gone in the empty state.
    await expect
      .element(page.getByText(/you will send your partner these elements/))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByText(/change what you send in Advanced Options/))
      .not.toBeInTheDocument();
  });
});
