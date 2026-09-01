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
import { visualOrderWithin } from "./visualOrder";

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

// The linkage columns carry values their type infers from; anything else is a
// placeholder, so an added column infers to the disclosed set.
const SAMPLE_VALUES: Record<string, string> = {
  client_id: "1",
  first_name: "Ann",
  last_name: "Lee",
  dob: "01/02/1990",
};

function csvOf(columns: Array<string>): AcquiredCsv {
  return {
    fileName: "clients.csv",
    sizeBytes: 4096,
    rawRows: [
      Object.fromEntries(
        columns.map((column) => [column, SAMPLE_VALUES[column] ?? "x"]),
      ),
    ],
    columns,
    rowCount: 1,
  };
}

const csv = csvOf(["client_id", "first_name", "last_name", "dob", bidiColumn]);

function mountColumns(columns: Array<string>) {
  const noop = () => undefined;
  app.render(
    createElement(MatchingSharingSection, {
      metadata: editorFromCsv("Dana Okafor", csvOf(columns)).draft.metadata,
      onColumnType: noop,
      onColumnDisclosure: noop,
      announcement: "",
      onContinue: noop,
    }),
  );
}

function mountSection() {
  mountColumns(csv.columns);
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

    // Every name the step shows is a <bdi> the browser actually isolates --
    // asserted through the computed style, so a <bdi> the engine does not
    // isolate fails here rather than passing on the element name alone. In
    // document order: one grid row header per column, then the disclosed
    // column's chip. Each holds the operator's own header verbatim, so what
    // they select and copy is that header and nothing more.
    const isolates = [...app.container.querySelectorAll("bdi")];
    expect(isolates.map((element) => element.textContent)).toEqual([
      ...csv.columns,
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

describe("column-name isolation: what the wrapper does not contain", () => {
  // The isolate class is the isolation's own residual: per UAX #9 BD9/X6a a name
  // carrying an unmatched PDI closes the wrapper's isolate early, and the copy
  // after the break is laid out at the paragraph's level rather than the name's.
  // What that costs is measured here rather than argued from the standard, on both
  // forms the module ships -- the characters a string sink carries, and the <bdi>
  // whose computed `unicode-bidi: isolate` is the markup form.
  //
  // Written as escapes, never as raw bytes, so the source of a test about
  // invisible characters is itself readable.
  const PDI = "\u2069";

  /** A header the wrapper contains: one unclosed override, which the wrapper's
   * own PDI terminates. */
  const containedName = `pre${RLO}evil`;

  /** A header the wrapper does NOT contain: the unmatched PDI closes the isolate
   * after "pre", leaving the override that follows it open over the copy after
   * the wrapper. The string form of this name is
   * FSI + "pre" + PDI + "mid" + RLO + "evil" + PDI. */
  const residualName = `pre${PDI}mid${RLO}evil`;

  /** The visual order of the three names as a string sink lays them out: one
   * comma-joined sentence, each name isolated as characters because no element
   * can carry it there. */
  async function isolatedStringOrder(name: string): Promise<Array<string>> {
    app.render(
      createElement(
        "p",
        null,
        `Columns sent to your partner: ${["one", name, "post"]
          .map(isolatedColumnName)
          .join(", ")}.`,
      ),
    );
    await expect
      .element(
        page.getByText("Columns sent to your partner:", { exact: false }),
      )
      .toBeInTheDocument();
    const paragraph = app.container.querySelector("p") as Element;
    return visualOrderWithin(paragraph, ["one", "evil", "post"]);
  }

  /** The same measurement on the element form: the name in a <bdi> with inline
   * copy on either side, which is the arrangement the shipped sites do not put it
   * in. */
  async function bdiInlineOrder(name: string): Promise<Array<string>> {
    app.render(
      createElement(
        "p",
        null,
        "Columns sent to your partner: one, ",
        createElement("bdi", null, name),
        ", post.",
      ),
    );
    await expect
      .element(
        page.getByText("Columns sent to your partner:", { exact: false }),
      )
      .toBeInTheDocument();
    const paragraph = app.container.querySelector("p") as Element;
    return visualOrderWithin(paragraph, ["one", "evil", "post"]);
  }

  test("the string form contains an override the name leaves open", async () => {
    expect(await isolatedStringOrder(containedName)).toEqual([
      "one",
      "evil",
      "post",
    ]);
  });

  test("the string form does not contain one behind an unmatched PDI", async () => {
    // The residual, driven: the early PDI ends the wrapper, so the override runs
    // on and carries the name's tail past the name listed after it -- the exact
    // reordering the wrapper prevents above.
    expect(await isolatedStringOrder(residualName)).toEqual([
      "one",
      "post",
      "evil",
    ]);
  });

  test("the element form contains an override the name leaves open", async () => {
    expect(await bdiInlineOrder(containedName)).toEqual([
      "one",
      "evil",
      "post",
    ]);
  });

  test("the element form leaks over inline copy behind an unmatched PDI", async () => {
    // Whether the <bdi> shares the string form's hole is a question about the
    // browser's layout, not about UAX #9, so it is measured rather than reasoned:
    // this is that measurement.
    expect(await bdiInlineOrder(residualName)).toEqual(["one", "post", "evil"]);
  });

  test("both shipped sites contain it at the block boundary", async () => {
    // Neither shipped ColumnName site puts inline copy beside the name: the grid
    // row header and the chip are each the whole of their own block, so the leak
    // the check above measures has nothing to run over. That structure is the
    // containment, so it is asserted rather than described -- a separator or a
    // marker added inside either block makes the leak reachable and fails here.
    mountColumns([
      "client_id",
      "first_name",
      "last_name",
      "dob",
      residualName,
      "post",
    ]);
    await expect
      .element(
        page.getByText("you will send your partner these elements", {
          exact: false,
        }),
      )
      .toBeInTheDocument();

    const holders = [...app.container.querySelectorAll("bdi")]
      .filter((element) => element.textContent === residualName)
      .map((element) => element.parentElement as HTMLElement);
    expect(holders.map((element) => element.tagName)).toEqual(["TH", "LI"]);
    for (const holder of holders) {
      expect(holder.textContent).toBe(residualName);
      expect(getComputedStyle(holder).display).not.toBe("inline");
    }

    // And the block after each one keeps its place: the next grid row's header and
    // the next chip, measured at glyph level as everything above is.
    const [rowHeader, chip] = holders;
    expect(
      visualOrderWithin(rowHeader.closest("tbody") as Element, [
        "pre",
        "evil",
        "post",
      ]),
    ).toEqual(["pre", "evil", "post"]);
    expect(
      visualOrderWithin(chip.closest("ul") as Element, ["pre", "evil", "post"]),
    ).toEqual(["pre", "evil", "post"]);
  });
});
