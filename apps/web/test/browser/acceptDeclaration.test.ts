/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

// Load Mantine's stylesheet so components render with their real geometry, as the
// other exchange component suites do.
import "@mantine/core/styles.css";

import {
  DEFAULT_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  MAX_DECLARED_NAMES_SHOWN,
  MAX_NAME_LENGTH,
  MAX_PAYLOAD_ENTRIES,
  sanitizeForDisplay,
} from "@psilink/core";

import {
  acceptorColumnsEditorState,
  acceptorInitialColumnsState,
  acceptorVerdict,
} from "@exchange/acceptorColumnsModel";

import { AcceptorColumnsStep } from "@exchange/AcceptorColumnsStep";

// The grid labels its controls through this helper, so a query for one derives the
// expected label from it rather than restating the isolate as literal characters.
import { isolatedColumnName } from "@components/ColumnName";

// applyDisclosure is the call the grid's own "How it is used" control edits
// through, so a test that opens on a column set to something other than "sent"
// reaches that state the way the operator would rather than by hand-writing
// role/isPayload.
import { applyDisclosure } from "@psi/metadataEditing";

import { createAppMount } from "./renderApp";

import type { LinkageTerms } from "@psilink/core";

// The confirm-columns step under an invitation whose declared payload set for this
// party is NON-EMPTY and disagrees with the operator's marks. The empty-declaration
// notice on the same screen has its own coverage in accept.test.ts; what is
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

// Ordinary content rather than an attack, and outside printable ASCII: U+00E9 LATIN
// SMALL LETTER E WITH ACUTE is what a real header and a real declaration both
// contain, which is what makes it the character the two treatments on this screen
// disagree about. Written as an escape for the reason RLO above is.
const NON_ASCII = "\u00E9";

// What the conflict notice may show with the declaration flooded. An absolute
// number, not derived from MAX_DECLARED_NAMES_SHOWN, so removing that cap would
// not also remove this check. It leaves headroom over what the notice measures
// today (roughly 440 characters for a flooded declaration) and bounds only the
// partner-driven list, not the operator's own headers -- staying hundreds of
// times under the megabyte the same declaration would paint uncapped.
const NOTICE_CEILING = 4_000;

// The over-declared half's remedies as the notice states them: the partner's first,
// then the local widening and what it costs. Pinned once, since the two tests that
// read it drive the offer over columns sitting at different uses -- what it costs
// must be one true sentence for both, naming no role.
const WIDENING_OFFER =
  "Ask your partner for an invitation that expects what your file sends." +
  " Where your file does have such a column, you can set it to " +
  '"Sent to your partner" below instead - that discloses more than you ' +
  "have marked so far, and each column has a single use, so sending it " +
  "replaces the use it has now.";

function mountStep(
  linkageTerms: LinkageTerms,
  columns: Array<string>,
  // Columns the step opens with set to "Not used", the state a column has to be in
  // to sit in the declared-but-not-sent half while the file still contains it.
  unsent: ReadonlyArray<string> = [],
) {
  const rows = [Object.fromEntries(columns.map((c) => [c, "x"]))];
  const inferred = acceptorInitialColumnsState(columns);
  const columnsState = {
    ...inferred,
    metadata: inferred.metadata.map((column) =>
      unsent.includes(column.name)
        ? applyDisclosure(column, "ignored")
        : column,
    ),
  };
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
      bidiStrippedColumns: [],
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

// The declaration-conflict notice as one element, for an assertion about its whole
// rendered content rather than the page's. The step gives three advisories the
// role -- this one, the dead-key note, and the overlong-name note -- and neither of
// the other two holds in any scenario below, so the count is asserted rather than
// assumed: a second one appearing would otherwise silently redirect the query.
function declarationNotice(): HTMLElement {
  const notices = app.container.querySelectorAll<HTMLElement>('[role="note"]');
  expect(notices).toHaveLength(1);
  return notices[0];
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
    // A column this file does not contain cannot be marked at all, so the entry says
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
    expect(app.container.textContent).toContain(WIDENING_OFFER);
    expect(app.container.textContent).not.toContain(
      "not a column in this file",
    );
  });

  test("offers the same widening, at the same stated cost, for a column the file keeps as its record identifier", async () => {
    // The role the offer's cost must not be written against: `record_id` is this
    // file's record identifier, so it is neither matched on nor sent, and a cost
    // named as matching would be false about the one column the operator keeps
    // unsent to index their own results. The offer is the same one -- the column
    // is in the file -- and what it costs is the use the row below shows.
    const identifierColumns = ["first_name", "last_name", "record_id"];
    mountStep(
      { ...acceptorTerms, payload: { receive: [{ name: "record_id" }] } },
      identifierColumns,
    );
    await expect
      .element(
        page.getByText("Your partner expects a column you are not sending"),
      )
      .toBeInTheDocument();
    expect(app.container.textContent).toContain(WIDENING_OFFER);

    // The use the sentence says sending replaces, as the grid states it: the
    // control the operator is sent to holds one choice, and here it is the
    // identifier -- not matching, which this column does not do. The label contains
    // the isolate as characters (a string sink cannot hold the markup), so the
    // query is built from the same helper the grid labels with.
    const use = app.container.querySelector<HTMLInputElement>(
      `[aria-label="How column ${isolatedColumnName("record_id")} is used"]`,
    );
    expect(use?.value).toBe("Unique record identifier - not sent");
  });

  test("bounds the declared-name list, and counts the rest, when the declaration is flooded", async () => {
    // The declaration at core's own ceiling, every name long enough to spend the
    // whole escaped display allowance: the shape that decides whether the operator
    // can still reach the grid and the launch control below this notice.
    const flooded = Array.from(
      { length: MAX_PAYLOAD_ENTRIES },
      (_, index) => `${index}-${NON_ASCII.repeat(MAX_NAME_LENGTH)}`,
    );
    // The assumption, asserted rather than assumed: each of those names spends the
    // whole per-value allowance at this sink and is cut at it, so what is measured
    // below is the worst case and not a mild one.
    const escaped = sanitizeForDisplay(flooded[0]);
    expect(escaped.endsWith(DISPLAY_TRUNCATION_MARKER)).toBe(true);
    expect(escaped.length).toBeGreaterThan(DEFAULT_MAX_DISPLAY_LENGTH);
    mountStep(
      {
        ...acceptorTerms,
        payload: { receive: flooded.map((name) => ({ name })) },
      },
      // No column of this file is marked to send, so the declared half is the only
      // direction that holds and every list item in the notice is a declared name.
      ["first_name", "last_name"],
    );
    await expect
      .element(
        page.getByText("Your partner expects columns you are not sending"),
      )
      .toBeInTheDocument();

    // What the same declaration would paint uncapped, measured rather than
    // asserted from the constants: the notice's bound is only worth pinning
    // against the size it replaces.
    const uncappedSize = flooded.reduce(
      (total, name) => total + sanitizeForDisplay(name).length,
      0,
    );
    expect(uncappedSize).toBeGreaterThan(1_000_000);

    const notice = declarationNotice();
    expect(notice.querySelectorAll("li")).toHaveLength(
      MAX_DECLARED_NAMES_SHOWN,
    );
    expect(notice.textContent).toContain(
      `and ${MAX_PAYLOAD_ENTRIES - MAX_DECLARED_NAMES_SHOWN} more not shown here.`,
    );
    expect(notice.textContent.length).toBeLessThanOrEqual(NOTICE_CEILING);
  });

  test("escapes a declared name the file also has, while the grid row it points at renders that header verbatim", async () => {
    // The one column two provenances meet on: the invitation declares it and the
    // operator's file has a header of the same bytes. The notice escapes the
    // partner's copy -- it is text this operator cannot inspect -- while the grid
    // row it sends them to renders their own header as itself inside its isolate,
    // so the same name reaches the operator in two forms on one screen.
    const shared = `notes${NON_ASCII}`;
    mountStep(
      { ...acceptorTerms, payload: { receive: [{ name: shared }] } },
      ["first_name", "last_name", shared],
      [shared],
    );
    await expect
      .element(
        page.getByText("Your partner expects a column you are not sending"),
      )
      .toBeInTheDocument();

    const notice = declarationNotice();
    expect(notice.textContent).toContain(sanitizeForDisplay(shared));
    expect(notice.textContent).not.toContain(shared);
    // The column IS in the file, so the notice offers the local widening rather
    // than the absent-column line -- the half of the collision that makes the grid
    // row below a place the operator is actually sent.
    expect(notice.textContent).toContain(WIDENING_OFFER);
    expect(notice.textContent).not.toContain("not a column in this file");

    const rowHeaders = Array.from(
      app.container.querySelectorAll<HTMLElement>('th[scope="row"] bdi'),
    ).map((header) => header.textContent);
    expect(rowHeaders).toContain(shared);
    expect(rowHeaders).not.toContain(sanitizeForDisplay(shared));
  });
});
