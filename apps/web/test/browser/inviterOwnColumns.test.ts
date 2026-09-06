/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import { inferMetadata } from "@psilink/core";

import {
  OWN_COLUMNS_EMPTY_ALL_NOTICE,
  OWN_COLUMNS_EMPTY_DISCLOSED_NOTICE,
  OWN_COLUMNS_LABELS,
  OWN_COLUMNS_LOCAL_NOTICE,
} from "@psi/ownColumnsModel";
import { MatchingSharingSection } from "@exchange/MatchingSharingSection";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type { Metadata } from "@psilink/core";
import type { OwnColumnsChoice } from "@psi/ownColumnsModel";

// The own-columns control as the operator meets it on step 2: its three states,
// what each says the result file will hold, the statement that the choice is
// local, and its absence where the exchange gives this party no result table.

const app = createAppMount();

// client_id/first_name/last_name/dob infer matching roles; program_code is not
// in the alias map, so it infers a disclosed payload column -- the one column
// separating "the columns I send" from "every column of my file".
const metadata = inferMetadata(
  ["client_id", "first_name", "last_name", "dob", "program_code"],
  [],
);

// A file whose only column is the record identifier: the result already begins
// with it, so `all` selects nothing.
const identifierOnlyMetadata = inferMetadata(["client_id"], []);

// A file of matching columns and nothing else: the columns are there, but they
// are role linkage rather than payload, so `disclosed` selects nothing.
const linkageOnlyMetadata = inferMetadata(
  ["client_id", "first_name", "last_name", "dob"],
  [],
);

async function mount(
  ownColumns: OwnColumnsChoice | undefined,
  columns: Metadata = metadata,
) {
  const chosen: Array<OwnColumnsChoice> = [];
  app.render(
    createElement(MatchingSharingSection, {
      metadata: columns,
      onColumnType: () => undefined,
      onColumnDisclosure: () => undefined,
      ownColumns,
      onOwnColumns: (choice: OwnColumnsChoice) => chosen.push(choice),
      announcement: "",
      onContinue: () => undefined,
    }),
  );
  await flushPendingUpdates();
  return chosen;
}

/** The chip list under the control, in visual order. The step's other list is
 * the send summary above it, so the last one on the screen is this one. */
function keptColumns(): Array<string> {
  const lists = [...app.container.querySelectorAll("ul")];
  const kept = lists.at(-1);
  if (kept === undefined) return [];
  return [...kept.querySelectorAll("li")].map((item) => item.textContent);
}

afterEach(() => {
  app.unmount();
});

describe("the own-columns control's states", () => {
  test("the default state offers all three choices and lists nothing kept", async () => {
    await mount("none");
    const select = page.getByLabelText(
      "What your result file holds beside your partner's values",
    );
    await expect.element(select).toBeInTheDocument();

    expect(
      [
        ...app.container.querySelectorAll<HTMLOptionElement>("select option"),
      ].map((option) => option.textContent),
    ).toEqual(expect.arrayContaining(Object.values(OWN_COLUMNS_LABELS)));

    // With nothing chosen the step names no column of this party's own: the
    // only chip list on the screen is the send summary above the control.
    expect(app.container.textContent).not.toContain(
      "your result file will also hold these columns of your own",
    );
  });

  test("the disclosed state names the columns this party sends", async () => {
    await mount("disclosed");
    expect(keptColumns()).toEqual(["program_code"]);
  });

  test("the all state names every declared column but the identifier", async () => {
    await mount("all");
    // client_id heads every result row already, so writing it again would head
    // one input column twice.
    expect(keptColumns()).toEqual([
      "first_name",
      "last_name",
      "dob",
      "program_code",
    ]);
  });

  test("a change reports the chosen state to the host", async () => {
    const chosen = await mount("none");
    await page
      .getByLabelText(
        "What your result file holds beside your partner's values",
      )
      .selectOptions(OWN_COLUMNS_LABELS.all);
    expect(chosen).toEqual(["all"]);
  });

  test("the control says the choice is local, where it is made", async () => {
    await mount("none");
    expect(app.container.textContent).toContain(OWN_COLUMNS_LOCAL_NOTICE);
  });

  test("`all` over an identifier-only file says the file holds nothing else", async () => {
    await mount("all", identifierOnlyMetadata);
    expect(app.container.textContent).not.toContain(
      "your result file will also hold these columns of your own",
    );
    expect(app.container.textContent).toContain("No column left to add");
    expect(app.container.textContent).toContain(OWN_COLUMNS_EMPTY_ALL_NOTICE);
  });

  test("`disclosed` over a linkage-only file says none is marked as sent", async () => {
    // The file has three columns beside the identifier; matching is what they
    // are for, so none of them is sent and the selection names none.
    await mount("disclosed", linkageOnlyMetadata);
    expect(app.container.textContent).not.toContain(
      "your result file will also hold these columns of your own",
    );
    expect(app.container.textContent).toContain("No column left to add");
    expect(app.container.textContent).toContain(
      OWN_COLUMNS_EMPTY_DISCLOSED_NOTICE,
    );
    expect(app.container.textContent).not.toContain(
      OWN_COLUMNS_EMPTY_ALL_NOTICE,
    );
  });

  test("an exchange with no result table for this party offers no control", async () => {
    await mount(undefined);
    expect(app.container.textContent).not.toContain(
      "Your own columns in the result",
    );
    // The step's own sharing choices are untouched by the control's absence.
    expect(app.container.textContent).toContain("Matching & sharing");
  });
});
