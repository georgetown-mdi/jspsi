/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

// Load Mantine's stylesheet so the section renders with its real geometry and
// the isolation below is measured on the styles that ship.
import "@mantine/core/styles.css";

import { sanitizeForDisplay } from "@psilink/core";

import {
  demotionNotice,
  editorFromCsv,
  editorWithColumnDisclosure,
  editorWithColumnType,
  inviterLedgerRows,
} from "@psi/inviterModel";
import { Ledger } from "@exchange/Ledger";
import { MatchingSharingSection } from "@exchange/MatchingSharingSection";

// The expectations derive their form from this function, so they pin that the
// section's string sink has the same form its chips do, not what that form
// is; the literal FSI/PDI expectations live in
// apps/web/test/unit/columnNameDisplay.test.ts.
import { isolatedColumnName } from "@components/ColumnName";

import { createAppMount } from "./renderApp";
import { visualOrderWithin } from "./visualOrder";

import type { AcquiredCsv } from "@psi/inviterModel";
import type { Metadata } from "@psilink/core";

// The inviter's step 2 states what the partner will receive in two voices at
// once -- the chip list a sighted operator reads and the live region a screen
// reader hears -- over the operator's OWN CSV headers. This pins that both
// voices have the same name, isolated rather than escaped; @components/ColumnName
// states what the isolation contains and what it does not.

// A right-to-left override (U+202E) and a zero-width joiner (U+200D): the two
// classes that make a header read differently from its bytes. The name is
// unrecognized, so it infers to the disclosed set while the linkage columns
// beside it stay out of it.
const RLO = "\u202E";
const bidiColumn = `notes${RLO}evil\u200D`;

const app = createAppMount();

// The linkage columns hold values their type infers from; anything else is a
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

function mountMetadata(metadata: Metadata, announcement: string) {
  const noop = () => undefined;
  app.render(
    createElement(MatchingSharingSection, {
      metadata,
      onColumnType: noop,
      onColumnDisclosure: noop,
      announcement,
      onContinue: noop,
    }),
  );
}

function mountColumns(columns: Array<string>) {
  mountMetadata(
    editorFromCsv("Dana Okafor", csvOf(columns)).draft.metadata,
    "",
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
  test("a header containing a bidi override reads alike in the chips and the announcement", async () => {
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

    // The live region is a string sink, so it holds the isolate as characters
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
  // holding an unmatched PDI closes the wrapper's isolate early, and the copy
  // after the break is laid out at the paragraph's level rather than the name's.
  // What that costs is measured here rather than argued from the standard, on both
  // forms the module ships -- the characters a string sink holds, and the <bdi>
  // whose computed `unicode-bidi: isolate` is the markup form.
  //
  // Guard versus document: every "does not contain" case here is a measurement
  // and passes with or without the wrapper, since the residual survives it. What
  // guards the isolation is the form assertions -- the toContain of the wrapped
  // name here and in the ledger case below, plus exchange.test.ts's rendered-notice
  // expectation -- each of which fails on a sink composing raw names.
  //
  // Three further sinks put literal copy in one text block with a wrapped name
  // and stay undriven here, the same limit class as the two below, measured
  // 2026-09-01: the check-your-answers "Columns shared" row, the acceptor
  // ledger's send row, and the visually-hidden live regions on both steps.
  //
  // Four more sinks of the same string-composition shape stay undriven here
  // too, measured 2026-09-01: the accessible-name compositions at
  // MatchingSharingSection.tsx:117 and :133 ("Type for <name>", "How <name>
  // is used") and MetadataGrid.tsx:225 and :244 ("Type for column <name>",
  // "How column <name> is used"). They fall outside the "one text block"
  // wording above because they compose an attribute string, not element
  // copy, but the residual reaches them the same way.
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
   * can hold it there. */
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
   * copy on either side. */
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
    // on and moves the name's tail past the name listed after it -- the exact
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

  test("the demotion notice names every column the rule displaces at once", async () => {
    // Why the notice is a site where the residual can reach something: two
    // alias-inferred identifiers are displaced together when a third column takes
    // the role, so the notice sets separators between the names and its sentence
    // after them. Driven through the editing path the step's selects call, so the
    // shape asserted here is the shape the rule produces.
    const acquired = csvOf(["id", "identifier", "first_name", "post_id"]);
    const { editor, demotedIdentifiers } = editorWithColumnDisclosure(
      editorFromCsv("Dana Okafor", acquired),
      acquired,
      "post_id",
      "identifier",
    );
    expect(demotedIdentifiers).toEqual(["id", "identifier"]);

    const notice = demotionNotice(demotedIdentifiers);
    expect(notice).toContain(
      `${isolatedColumnName("id")}, ${isolatedColumnName("identifier")} changed`,
    );
    mountMetadata(editor.draft.metadata, notice);
    await expect
      .element(page.getByText("changed to Ignored", { exact: false }))
      .toHaveTextContent(notice);
  });

  test("the demotion notice does not contain one behind an unmatched PDI", async () => {
    // The same measurement as the string form above, at the shipped sink: the
    // notice's own trailing copy is what the override runs over. Driven through
    // the editing path the selects call -- retype the residual header to the
    // identifier type, mark it the record identifier (displacing the seeded
    // post_id), then hand the role back to post_id -- so the name in the notice
    // is the one the rule displaced rather than a prop the test chose.
    const acquired = csvOf([
      "first_name",
      "last_name",
      residualName,
      "post_id",
    ]);
    const typed = editorWithColumnType(
      editorFromCsv("Dana Okafor", acquired),
      acquired,
      residualName,
      "identifier",
    );
    const claimed = editorWithColumnDisclosure(
      typed.editor,
      acquired,
      residualName,
      "identifier",
    );
    const { editor, demotedIdentifiers } = editorWithColumnDisclosure(
      claimed.editor,
      acquired,
      "post_id",
      "identifier",
    );
    expect(demotedIdentifiers).toEqual([residualName]);

    mountMetadata(editor.draft.metadata, demotionNotice(demotedIdentifiers));
    await expect
      .element(page.getByText("changed to Ignored", { exact: false }))
      .toBeInTheDocument();
    const notice = page
      .getByText("changed to Ignored", { exact: false })
      .element();
    expect(visualOrderWithin(notice, ["pre", "evil", "changed to"])).toEqual([
      "pre",
      "changed to",
      "evil",
    ]);
  });

  test("the ledger's send row does not contain one behind an unmatched PDI", async () => {
    // The standing ledger's "You will send" row joins the disclosed names with
    // literal separators into one string value, so it is a sink of the shape the
    // residual reaches. Driven through the shipped composer and the shipped
    // Ledger rather than a hand-built row, so what is measured is what the screen
    // renders beside step 2.
    const acquired = csvOf([
      "client_id",
      "first_name",
      "last_name",
      "dob",
      residualName,
      "post",
    ]);
    app.render(
      createElement(Ledger, {
        rows: inviterLedgerRows(editorFromCsv("Dana Okafor", acquired)),
      }),
    );
    await expect
      .element(page.getByText("You will send", { exact: false }))
      .toBeInTheDocument();

    const sendRow = [...app.container.querySelectorAll("dl > div")].find(
      (row) => row.querySelector("dt")?.textContent.startsWith("You will send"),
    );
    const value = sendRow?.querySelector("dd") as HTMLElement;

    // The wrapped form, so a row put back on raw names fails here: this half is
    // the isolation's guard, the order below is the residual's measurement.
    expect(value.textContent).toContain(isolatedColumnName(residualName));
    expect(visualOrderWithin(value, ["pre", "evil", "post"])).toEqual([
      "pre",
      "post",
      "evil",
    ]);
  });

  test("both element sites on the step contain it at the block boundary", async () => {
    // Neither ColumnName element site here puts inline copy beside the name: the
    // grid row header and the chip are each the whole of their own block, so the
    // leak the check above measures has nothing to run over. That structure is the
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
