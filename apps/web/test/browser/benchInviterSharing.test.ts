/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

// Load Mantine's stylesheet so the section renders with its real geometry and
// the isolation below is measured on the styles that ship.
import "@mantine/core/styles.css";

import { sanitizeForDisplay } from "@psilink/core";

import { MatchingSharingSection } from "@bench/MatchingSharingSection";
import { editorFromCsv } from "@bench/inviterModel";

// The expectations derive their form from this function, so they pin that the
// section's string sink carries the same form its chips do, not what that form
// is; the literal FSI/PDI expectations live in
// apps/web/test/unit/columnNameDisplay.test.ts.
import { isolatedColumnName } from "@components/ColumnName";

import { createAppMount } from "./renderApp";

import type { AcquiredCsv } from "@bench/inviterModel";

// The inviter's step 2 states what the partner will receive in two voices at
// once -- the chip list a sighted operator reads and the live region a screen
// reader hears -- over the operator's OWN CSV headers. This pins that both
// voices carry the same name, isolated rather than escaped; @components/ColumnName
// carries what the isolation contains and what it does not.

// A right-to-left override (U+202E) and a zero-width joiner (U+200D): the two
// classes that make a header read differently from its bytes. The name is
// unrecognized, so it infers to the disclosed set while the linkage columns
// beside it stay out of it.
const RLO = "\u202E";
const bidiColumn = `notes${RLO}evil\u200D`;

const app = createAppMount();

const csv: AcquiredCsv = {
  fileName: "clients.csv",
  sizeBytes: 4096,
  rawRows: [
    {
      client_id: "1",
      first_name: "Ann",
      last_name: "Lee",
      dob: "01/02/1990",
      [bidiColumn]: "x",
    },
  ],
  columns: ["client_id", "first_name", "last_name", "dob", bidiColumn],
  rowCount: 1,
};

function mountSection() {
  const noop = () => undefined;
  app.render(
    createElement(MatchingSharingSection, {
      metadata: editorFromCsv("Dana Okafor", csv).draft.metadata,
      onColumnType: noop,
      onColumnDisclosure: noop,
      announcement: "",
      onContinue: noop,
    }),
  );
}

/** What the step's polite regions currently say, in document order. */
function liveRegionTexts(): Array<string | null> {
  return [...app.container.querySelectorAll('[role="status"]')].map(
    (element) => element.textContent,
  );
}

afterEach(() => {
  app.unmount();
});

describe("inviter sharing summary: one column name in both voices", () => {
  test("a header carrying a bidi override reads alike in the chips and the announcement", async () => {
    mountSection();
    await expect
      .element(
        page.getByText("you will send your partner these elements", {
          exact: false,
        }),
      )
      .toBeInTheDocument();

    // The chip is a <bdi> the browser actually isolates -- asserted through the
    // computed style, so a <bdi> the engine does not isolate fails here rather
    // than passing on the element name alone -- and it holds the operator's own
    // header verbatim, so what they select and copy is that header and nothing
    // more.
    const isolates = [...app.container.querySelectorAll("bdi")];
    expect(isolates.map((element) => element.textContent)).toEqual([
      bidiColumn,
    ]);
    for (const element of isolates) {
      expect(getComputedStyle(element).unicodeBidi).toBe("isolate");
    }

    // The live region is a string sink, so it carries the isolate as characters
    // instead: the spoken summary names the same set the chips do, and neither
    // form can reorder the copy around it. Debounced, so poll for it.
    await expect
      .poll(() => liveRegionTexts(), { timeout: 3_000 })
      .toContain(
        `Columns sent to your partner: ${isolatedColumnName(bidiColumn)}.`,
      );

    // Nothing on the step shows the escaped form -- the whole step, not one
    // surface, since what holds them together is that none of them escapes: a
    // single site put back on sanitizeForDisplay fails here.
    expect(app.container.textContent).not.toContain(
      sanitizeForDisplay(bidiColumn),
    );
    expect(app.container.textContent).toContain(RLO);
  });
});
