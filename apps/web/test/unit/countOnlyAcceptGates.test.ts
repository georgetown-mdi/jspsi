import { describe, expect, test } from "vitest";

import {
  acceptorColumnsEditorState,
  acceptorDisclosedColumns,
  acceptorInitialColumnsState,
  acceptorLaunchBlockedReason,
  acceptorVerdict,
} from "@bench/acceptorColumnsModel";
import { importLinkageTerms } from "@psi/linkageTermsIO";

import type { CSVRow, LinkageTerms } from "@psilink/core";

// The count-only shape refusals as the ACCEPTING web operator meets them: an
// out-of-shape document refused as it is read (the import door, sharing core's
// schema with the invitation decode), and this party's own marked columns refused
// at the launch gate, which is the rule no linkage-terms document carries.
//
// Both hold with the real APPLIED_SETTINGS: the rules read the algorithm, not
// whether a count-only run path exists yet. The authoring half runs behind a
// forced flag in countOnlyMintGate.test.ts, since the editor clamps the algorithm
// out of the terms it builds until then.

/** An invitation in exactly the count-only shape the specification admits: one
 * linkage key, cascade, no deduplication, no payload in either direction. */
const countOnlyTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-01",
  algorithm: "psi-c",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "firstName", type: "first_name" }],
  linkageKeys: [{ name: "first", elements: [{ field: "firstName" }] }],
};

function rows(columns: Array<string>): Array<CSVRow> {
  return [Object.fromEntries(columns.map((name) => [name, "value"]))];
}

function editorFor(columns: Array<string>, terms: LinkageTerms) {
  const state = acceptorInitialColumnsState(columns);
  return {
    editorState: acceptorColumnsEditorState(state, terms, rows(columns)),
    verdict: acceptorVerdict(
      columns,
      terms,
      acceptorColumnsEditorState(state, terms, rows(columns)),
    ),
  };
}

describe("the count-only launch gate (the acceptor's own marked columns)", () => {
  test("blocks launch when a marked column would be sent under count-only terms", () => {
    // `notes` is unrecognized, so the acceptor's seeded metadata marks it for
    // transmission -- which a count-only exchange has nowhere to put.
    const columns = ["first_name", "notes"];
    const { editorState, verdict } = editorFor(columns, countOnlyTerms);
    expect(acceptorDisclosedColumns(editorState.metadata)).toEqual(["notes"]);
    expect(verdict.satisfiableKeyCount).toBeGreaterThan(0);
    const reason = acceptorLaunchBlockedReason(
      verdict,
      editorState,
      countOnlyTerms,
    );
    expect(reason).toBe(
      "Unmark the columns you send above before you can start: a count-only exchange sends none.",
    );
  });

  test("the same file under psi terms launches, so the gate is the algorithm's", () => {
    const columns = ["first_name", "notes"];
    const asPsi: LinkageTerms = { ...countOnlyTerms, algorithm: "psi" };
    const { editorState, verdict } = editorFor(columns, asPsi);
    expect(acceptorDisclosedColumns(editorState.metadata)).toEqual(["notes"]);
    expect(
      acceptorLaunchBlockedReason(verdict, editorState, asPsi),
    ).toBeUndefined();
  });

  test("count-only terms over a file that sends nothing launch", () => {
    const columns = ["first_name"];
    const { editorState, verdict } = editorFor(columns, countOnlyTerms);
    expect(acceptorDisclosedColumns(editorState.metadata)).toEqual([]);
    expect(
      acceptorLaunchBlockedReason(verdict, editorState, countOnlyTerms),
    ).toBeUndefined();
  });
});

describe("the import door refuses a count-only document outside the shape", () => {
  // The import door surfaces core's own value-free refine message, so the rules
  // are stated once and this pins that they reach the operator intact.
  test.each([
    {
      rule: "more than one linkage key",
      terms: {
        ...countOnlyTerms,
        linkageFields: [
          ...countOnlyTerms.linkageFields,
          { name: "lastName", type: "last_name" },
        ],
        linkageKeys: [
          ...countOnlyTerms.linkageKeys,
          { name: "last", elements: [{ field: "lastName" }] },
        ],
      },
      expected: /exactly one linkage key/,
    },
    {
      rule: "single-pass",
      terms: { ...countOnlyTerms, linkageStrategy: "single-pass" },
      expected: /linkage strategy to "cascade"/,
    },
    {
      rule: "deduplicate",
      terms: { ...countOnlyTerms, deduplicate: true },
      expected: /set deduplicate to false/,
    },
    {
      rule: "payload",
      terms: { ...countOnlyTerms, payload: { send: [{ name: "notes" }] } },
      expected: /no payload columns in either direction/,
    },
  ])("refuses an imported document declaring $rule", ({ terms, expected }) => {
    const result = importLinkageTerms(JSON.stringify(terms));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(expected);
  });

  test("a document already in the count-only shape imports", () => {
    const result = importLinkageTerms(JSON.stringify(countOnlyTerms));
    expect(result.success).toBe(true);
  });
});
