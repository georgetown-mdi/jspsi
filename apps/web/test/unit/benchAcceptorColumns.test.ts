import { describe, expect, test } from "vitest";

import {
  acceptorCleaningAttention,
  acceptorColumnsEditorState,
  acceptorHasIdentifierConflict,
  acceptorInitialColumnsState,
  acceptorLaunchDisabled,
  acceptorLaunchPayload,
  acceptorUnsatisfiedTypes,
  acceptorVerdict,
} from "@bench/acceptorColumnsModel";

import { setColumnTypeForMatching } from "@psi/metadataEditing";

import type { CSVRow, LinkageTerms } from "@psilink/core";
import type { AcceptorColumnsState } from "@bench/acceptorColumnsModel";
import type { FieldValueCoverage } from "@psi/nonEmptyAggregate";

// Two single-element keys, one per name field, so a CSV can satisfy both, one, or
// neither -- the three verdict outcomes. Adopted verbatim from the invitation; the
// acceptor cannot edit fields or keys.
const nameTerms: LinkageTerms = {
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

// A single date-of-birth key whose adopted cleaning is self-defeating: the
// parse_date input format omits the year, so the pipeline drops every record no
// matter the data. assessLinkageSatisfiability reports this as a dead key.
const deadDobTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "dob", type: "date_of_birth" }],
  linkageKeys: [
    {
      name: "d",
      elements: [
        {
          field: "dob",
          transform: [
            { function: "parse_date", params: { inputFormat: "MM/DD" } },
          ],
        },
      ],
    },
  ],
};

function rows(columns: Array<string>): Array<CSVRow> {
  return [Object.fromEntries(columns.map((c) => [c, "x"]))];
}

/** The derived editor state (metadata + effective standardization) for a fresh
 * acquire of `columns`, plus any state overrides applied on top. */
function editorFor(
  columns: Array<string>,
  terms: LinkageTerms,
  overrides: Partial<AcceptorColumnsState> = {},
) {
  const state: AcceptorColumnsState = {
    ...acceptorInitialColumnsState(columns),
    ...overrides,
  };
  return {
    state,
    editorState: acceptorColumnsEditorState(state, terms, rows(columns)),
  };
}

describe("acceptor columns editor state", () => {
  test("seeds metadata from the file's columns and starts with empty override layers", () => {
    const state = acceptorInitialColumnsState(["first_name", "last_name"]);
    expect(state.metadata.map((c) => c.name)).toEqual([
      "first_name",
      "last_name",
    ]);
    expect(state.inputOverrides.size).toBe(0);
    expect(state.stepOverrides.size).toBe(0);
  });

  test("the effective standardization has one transformation per satisfiable field", () => {
    const { editorState } = editorFor(["first_name", "last_name"], nameTerms);
    expect(editorState.standardization.map((t) => t.output).sort()).toEqual([
      "firstName",
      "lastName",
    ]);
  });
});

describe("acceptor verdict (re-surfaced, not re-derived)", () => {
  test("a file with no matching columns is blocked with the exact mockup title and a distinct announcement", () => {
    const { editorState } = editorFor(["notes"], nameTerms);
    const verdict = acceptorVerdict(["notes"], nameTerms, editorState);
    expect(verdict.kind).toBe("blocked");
    expect(verdict.title).toBe("This file cannot match yet");
    // The spoken form is worded differently from the visible title.
    expect(verdict.announcement).toBe(
      "No agreed linkage key can be satisfied by your columns yet.",
    );
    expect(verdict.announcement).not.toBe(verdict.title);
  });

  test("a partially-covered file warns with the N-of-M title", () => {
    const { editorState } = editorFor(["first_name", "notes"], nameTerms);
    const verdict = acceptorVerdict(
      ["first_name", "notes"],
      nameTerms,
      editorState,
    );
    expect(verdict.kind).toBe("partial");
    expect(verdict.title).toBe("1 of 2 keys can match");
    expect(verdict.announcement).toBe(
      "1 of 2 linkage keys can be satisfied by your columns.",
    );
  });

  test("a fully-covered file is all-clear", () => {
    const { editorState } = editorFor(["first_name", "last_name"], nameTerms);
    const verdict = acceptorVerdict(
      ["first_name", "last_name"],
      nameTerms,
      editorState,
    );
    expect(verdict.kind).toBe("allClear");
    expect(verdict.title).toBe("All 2 keys can match");
    expect(verdict.announcement).toBe(
      "All 2 linkage keys can be satisfied by your columns.",
    );
  });

  test("a self-defeating adopted rule surfaces a dead-key count without blocking", () => {
    const { editorState } = editorFor(["date_of_birth"], deadDobTerms);
    const verdict = acceptorVerdict(
      ["date_of_birth"],
      deadDobTerms,
      editorState,
    );
    // The columns are present, so the column-shape verdict passes; the dead rule is
    // reported separately as a count, never blocking.
    expect(verdict.kind).toBe("allClear");
    expect(verdict.deadKeyCount).toBe(1);
  });
});

describe("acceptor quick-fix mapper", () => {
  test("appears only when a required field type is missing, one entry per unsatisfied type", () => {
    // Both name types missing -> two mapper entries.
    const blocked = editorFor(["alpha", "beta"], nameTerms);
    const types = acceptorUnsatisfiedTypes(
      ["alpha", "beta"],
      nameTerms,
      blocked.editorState,
    );
    expect(types.map((t) => t.type).sort()).toEqual([
      "first_name",
      "last_name",
    ]);
    expect(types.map((t) => t.label).sort()).toEqual([
      "First name",
      "Last name",
    ]);
  });

  test("is empty once every required type is covered", () => {
    const { editorState } = editorFor(["first_name", "last_name"], nameTerms);
    expect(
      acceptorUnsatisfiedTypes(
        ["first_name", "last_name"],
        nameTerms,
        editorState,
      ),
    ).toEqual([]);
  });

  test("a remap forces role linkage, so it flips the verdict -- a bare retype would not", () => {
    // Both columns infer to role: payload (unrecognized). setColumnTypeForMatching
    // must re-role the chosen column to linkage, not merely retype it.
    const columns = ["alpha", "beta"];
    const seed = acceptorInitialColumnsState(columns);
    // Sanity: a bare retype path is exactly what setColumnTypeForMatching guards
    // against; here we assert the matching helper produces a role: linkage column.
    const remapped = setColumnTypeForMatching(
      seed.metadata,
      "alpha",
      "first_name",
    );
    const alpha = remapped.find((c) => c.name === "alpha");
    expect(alpha?.role).toBe("linkage");
    expect(alpha?.type).toBe("first_name");

    // Driven through the model: after remapping alpha, first is satisfiable ->
    // partial; after remapping beta too, both -> all-clear.
    const afterAlpha = editorFor(columns, nameTerms, {
      metadata: remapped,
    });
    expect(
      acceptorVerdict(columns, nameTerms, afterAlpha.editorState).kind,
    ).toBe("partial");
    const bothRemapped = setColumnTypeForMatching(
      remapped,
      "beta",
      "last_name",
    );
    const afterBoth = editorFor(columns, nameTerms, {
      metadata: bothRemapped,
    });
    expect(
      acceptorVerdict(columns, nameTerms, afterBoth.editorState).kind,
    ).toBe("allClear");
  });
});

describe("acceptor launch gates", () => {
  test("an unsatisfiable file disables launch (satisfiableKeyCount === 0)", () => {
    const { editorState } = editorFor(["notes"], nameTerms);
    const verdict = acceptorVerdict(["notes"], nameTerms, editorState);
    expect(acceptorLaunchDisabled(verdict, editorState)).toBe(true);
  });

  test("a satisfiable file enables launch", () => {
    const { editorState } = editorFor(["first_name", "last_name"], nameTerms);
    const verdict = acceptorVerdict(
      ["first_name", "last_name"],
      nameTerms,
      editorState,
    );
    expect(acceptorLaunchDisabled(verdict, editorState)).toBe(false);
  });

  test("partial coverage warns but does not disable launch", () => {
    const { editorState } = editorFor(["first_name", "notes"], nameTerms);
    const verdict = acceptorVerdict(
      ["first_name", "notes"],
      nameTerms,
      editorState,
    );
    expect(verdict.kind).toBe("partial");
    expect(acceptorLaunchDisabled(verdict, editorState)).toBe(false);
  });

  test("two identifier columns disable launch even when the keys are satisfiable", () => {
    const columns = ["id", "identifier", "first_name", "last_name"];
    const { editorState } = editorFor(columns, nameTerms);
    // The keys are covered, but the seed carries two identifiers.
    const verdict = acceptorVerdict(columns, nameTerms, editorState);
    expect(verdict.kind).toBe("allClear");
    expect(acceptorHasIdentifierConflict(editorState.metadata)).toBe(true);
    expect(acceptorLaunchDisabled(verdict, editorState)).toBe(true);
  });

  test("a mid-edit cleaning step disables launch (standardization invalid)", () => {
    // A date_of_birth field whose recommended parse_date step is cleared mid-edit:
    // the override layer carries an invalid step, so the gate must close.
    const dobTerms: LinkageTerms = {
      ...nameTerms,
      linkageFields: [{ name: "dob", type: "date_of_birth" }],
      linkageKeys: [{ name: "d", elements: [{ field: "dob" }] }],
    };
    const columns = ["date_of_birth"];
    const seed = acceptorInitialColumnsState(columns);
    const base = acceptorColumnsEditorState(seed, dobTerms, rows(columns));
    const dobTransform = base.standardization[0];
    // Author an invalid parse_date (empty inputFormat) against the same input.
    const invalidSteps = [
      { function: "parse_date", params: { inputFormat: "" } },
    ];
    const withInvalid = editorFor(columns, dobTerms, {
      stepOverrides: new Map([
        [
          dobTransform.output,
          { input: dobTransform.input, steps: invalidSteps },
        ],
      ]),
    });
    const verdict = acceptorVerdict(columns, dobTerms, withInvalid.editorState);
    expect(acceptorLaunchDisabled(verdict, withInvalid.editorState)).toBe(true);
  });
});

describe("acceptor launch payload", () => {
  test("carries the same metadata and standardization the verdict consumed", () => {
    const { editorState } = editorFor(["first_name", "last_name"], nameTerms);
    const verdict = acceptorVerdict(
      ["first_name", "last_name"],
      nameTerms,
      editorState,
    );
    const payload = acceptorLaunchPayload(verdict, editorState);
    // The gate and the run cannot disagree: identical object references.
    expect(payload.edits.metadata).toBe(editorState.metadata);
    expect(payload.edits.standardization).toBe(editorState.standardization);
    // A fully-satisfiable file carries no partial-coverage advisory.
    expect(payload.warning).toBeUndefined();
  });

  test("threads a partial-coverage advisory when only some keys match", () => {
    const { editorState } = editorFor(["first_name", "notes"], nameTerms);
    const verdict = acceptorVerdict(
      ["first_name", "notes"],
      nameTerms,
      editorState,
    );
    const payload = acceptorLaunchPayload(verdict, editorState);
    expect(payload.warning?.title).toBe("Partial coverage");
    expect(payload.warning?.message).toContain("1 of 2 linkage keys can match");
  });
});

describe("acceptor cleaning attention", () => {
  const satisfiable = editorFor(["first_name", "last_name"], nameTerms);

  test("no reason to review -> no attention, an em-dash rail value", () => {
    const attention = acceptorCleaningAttention(
      satisfiable.editorState.standardization,
      new Map(),
      0,
    );
    expect(attention.needsAttention).toBe(false);
    expect(attention.railValue).toBeUndefined();
  });

  test("a silent-empty field raises attention with the failing-field count", () => {
    const transformation = satisfiable.editorState.standardization[0];
    const output = transformation.output;
    const collapsed: FieldValueCoverage = {
      output,
      input: transformation.input,
      total: 10,
      produced: 0,
      rate: 0,
      unavailable: false,
    };
    const rates = new Map<string, FieldValueCoverage>([[output, collapsed]]);
    const attention = acceptorCleaningAttention(
      satisfiable.editorState.standardization,
      rates,
      0,
    );
    expect(attention.needsAttention).toBe(true);
    expect(attention.failingFieldCount).toBe(1);
    expect(attention.railValue).toBe("1 field failing");
  });

  test("a dead key alone raises attention without a failing-field count", () => {
    const attention = acceptorCleaningAttention(
      satisfiable.editorState.standardization,
      new Map(),
      1,
    );
    expect(attention.needsAttention).toBe(true);
    expect(attention.failingFieldCount).toBe(0);
    expect(attention.railValue).toBe("1 key to review");
  });
});
