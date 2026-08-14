import { describe, expect, test } from "vitest";

import {
  assertPayloadSendDisclosed,
  deriveAcceptedLinkageTerms,
} from "@psilink/core";

import {
  acceptorCleaningAttention,
  acceptorColumnsEditorState,
  acceptorColumnsTheInvitationWillNotAccept,
  acceptorDisclosedColumns,
  acceptorHasIdentifierConflict,
  acceptorInitialColumnsState,
  acceptorLaunchBlockedReason,
  acceptorLaunchPayload,
  acceptorUnsatisfiedTypes,
  acceptorVerdict,
} from "@bench/acceptorColumnsModel";

import {
  setColumnDisclosure,
  setColumnTypeForMatching,
} from "@psi/metadataEditing";

import type { CSVRow, LinkageTerms, Metadata } from "@psilink/core";
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
  // The gate IS the reason: `undefined` is the only enabled state, so a test that
  // pins the sentence pins the gate too, and a state that closes the gate without a
  // sentence -- the disabled button a screen-reader operator is told nothing about --
  // cannot be written.
  test("an unsatisfiable file disables launch (satisfiableKeyCount === 0) and says which columns to set", () => {
    const { editorState } = editorFor(["notes"], nameTerms);
    const verdict = acceptorVerdict(["notes"], nameTerms, editorState);
    expect(acceptorLaunchBlockedReason(verdict, editorState, nameTerms)).toBe(
      "Set your columns to the missing field types above before you can start.",
    );
  });

  test("a satisfiable file enables launch", () => {
    const { editorState } = editorFor(["first_name", "last_name"], nameTerms);
    const verdict = acceptorVerdict(
      ["first_name", "last_name"],
      nameTerms,
      editorState,
    );
    expect(
      acceptorLaunchBlockedReason(verdict, editorState, nameTerms),
    ).toBeUndefined();
  });

  test("partial coverage warns but does not disable launch", () => {
    const { editorState } = editorFor(["first_name", "notes"], nameTerms);
    const verdict = acceptorVerdict(
      ["first_name", "notes"],
      nameTerms,
      editorState,
    );
    expect(verdict.kind).toBe("partial");
    expect(
      acceptorLaunchBlockedReason(verdict, editorState, nameTerms),
    ).toBeUndefined();
  });

  test("two identifier columns disable launch even when the keys are satisfiable, naming the identifier rule", () => {
    const columns = ["id", "identifier", "first_name", "last_name"];
    const { editorState } = editorFor(columns, nameTerms);
    // The keys are covered, but the seed carries two identifiers.
    const verdict = acceptorVerdict(columns, nameTerms, editorState);
    expect(verdict.kind).toBe("allClear");
    expect(acceptorHasIdentifierConflict(editorState.metadata)).toBe(true);
    expect(acceptorLaunchBlockedReason(verdict, editorState, nameTerms)).toBe(
      "Choose a single record identifier column above before you can start.",
    );
  });

  test("a mid-edit cleaning step disables launch (standardization invalid) and points at the steps", () => {
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
    expect(
      acceptorLaunchBlockedReason(verdict, withInvalid.editorState, dobTerms),
    ).toBe(
      "Finish or fix the highlighted cleaning steps above before you can start.",
    );
  });

  // The step's own gates, which the model cannot derive: an SFTP accept with no
  // connection authored, and a file-handling combination core refuses.
  const satisfiableColumns = ["first_name", "last_name"];
  const satisfiable = editorFor(satisfiableColumns, nameTerms);
  const satisfiableVerdict = acceptorVerdict(
    satisfiableColumns,
    nameTerms,
    satisfiable.editorState,
  );

  test("an unauthored transport connection disables launch and names the connection card", () => {
    expect(
      acceptorLaunchBlockedReason(
        satisfiableVerdict,
        satisfiable.editorState,
        nameTerms,
        { connectionBlocked: true, exchangeFilesBlocked: false },
      ),
    ).toBe("Set up the SFTP connection above before you can start.");
  });

  test("a refused file-handling combination disables launch and names those settings", () => {
    expect(
      acceptorLaunchBlockedReason(
        satisfiableVerdict,
        satisfiable.editorState,
        nameTerms,
        { connectionBlocked: false, exchangeFilesBlocked: true },
      ),
    ).toBe("Resolve the file-handling settings above before you can start.");
  });

  test("omitting the step's own gates is the same as none of them being set", () => {
    // The default the model tests read, stated once so it is a decision rather than
    // an accident of the signature.
    expect(
      acceptorLaunchBlockedReason(
        satisfiableVerdict,
        satisfiable.editorState,
        nameTerms,
      ),
    ).toBe(
      acceptorLaunchBlockedReason(
        satisfiableVerdict,
        satisfiable.editorState,
        nameTerms,
        { connectionBlocked: false, exchangeFilesBlocked: false },
      ),
    );
  });

  test("with several gates closed the sentence names the topmost surface on the screen", () => {
    // A file that can match nothing AND carries two identifiers AND has no
    // connection authored: the operator is sent to the verdict at the top of the
    // step, not to a gate further down that a fix up there may clear anyway.
    const columns = ["id", "identifier", "notes"];
    const { editorState } = editorFor(columns, nameTerms);
    const verdict = acceptorVerdict(columns, nameTerms, editorState);
    expect(verdict.satisfiableKeyCount).toBe(0);
    expect(acceptorHasIdentifierConflict(editorState.metadata)).toBe(true);
    expect(
      acceptorLaunchBlockedReason(verdict, editorState, nameTerms, {
        connectionBlocked: true,
        exchangeFilesBlocked: true,
      }),
    ).toBe(
      "Set your columns to the missing field types above before you can start.",
    );
  });
});

describe("columns the invitation will not accept", () => {
  // A file covering both keys plus one unrecognized column, which infers to role:
  // payload -- so the file discloses exactly one column and every other gate is
  // clear, leaving this comparison as the only thing that can close the launch.
  const columns = ["first_name", "last_name", "notes"];

  /** Every invitation shape this describe drives, named once. The equivalence
   * test below reads this table rather than a copy of it, so a shape added here
   * is checked against core's own enforcement without a second edit. */
  const shapes = {
    acceptsNothingAndTakesTheResult: { payload: { receive: [] } },
    acceptsNothingAndTakesNoResult: {
      output: { expectsOutput: false, shareWithPartner: true },
      payload: { receive: [] },
    },
    declaresNoPayloadAtAll: {},
    declaresOnlyWhatItSends: { payload: { send: [{ name: "risk_score" }] } },
    acceptsTheDisclosedColumn: { payload: { receive: [{ name: "notes" }] } },
    acceptsOnlyAColumnNotDisclosed: {
      payload: { receive: [{ name: "risk_score" }] },
    },
  } satisfies Record<string, Partial<LinkageTerms>>;

  /** The invitation's own perspective, which the columns step holds, carrying the
   * named shape's payload declaration and output entitlement. Taking a name rather
   * than a literal keeps {@link shapes} the only place a shape is written. */
  function invitation(shape: keyof typeof shapes): LinkageTerms {
    return { ...nameTerms, ...shapes[shape] };
  }

  /** Whether core itself refuses to run this pair, driven through the real
   * functions rather than a second model of them: the invitation mirrored onto
   * this party by {@link deriveAcceptedLinkageTerms}, checked by the
   * {@link assertPayloadSendDisclosed} call `prepareForExchange` makes. */
  function coreRefuses(terms: LinkageTerms, metadata: Metadata): boolean {
    const accepted = deriveAcceptedLinkageTerms(terms, "Sam Alvarez");
    try {
      assertPayloadSendDisclosed(accepted.payload, metadata, accepted.output);
      return false;
    } catch {
      return true;
    }
  }

  test("names the disclosed columns when the invitation accepts none and the inviting party receives the result", () => {
    const terms = invitation("acceptsNothingAndTakesTheResult");
    const { editorState } = editorFor(columns, terms);
    expect(acceptorDisclosedColumns(editorState.metadata)).toEqual(["notes"]);
    expect(
      acceptorColumnsTheInvitationWillNotAccept(terms, editorState.metadata),
    ).toEqual(["notes"]);
    // Every other gate is clear, so the conflict alone closes the launch -- and
    // the sentence the button is described by is the conflict's own.
    const verdict = acceptorVerdict(columns, terms, editorState);
    expect(verdict.kind).toBe("allClear");
    expect(acceptorHasIdentifierConflict(editorState.metadata)).toBe(false);
    expect(acceptorLaunchBlockedReason(verdict, editorState, terms)).toBe(
      "Resolve the columns your partner will not accept above before you can start.",
    );
  });

  test("says nothing when the inviting party is entitled to no result", () => {
    // Nothing is transmitted to a party that receives no result, so the run does
    // not refuse this pair -- and the panel beside the grid already states that no
    // column leaves whatever these marks say.
    const terms = invitation("acceptsNothingAndTakesNoResult");
    const { editorState } = editorFor(columns, terms);
    expect(acceptorDisclosedColumns(editorState.metadata)).toEqual(["notes"]);
    expect(
      acceptorColumnsTheInvitationWillNotAccept(terms, editorState.metadata),
    ).toEqual([]);
    const verdict = acceptorVerdict(columns, terms, editorState);
    expect(
      acceptorLaunchBlockedReason(verdict, editorState, terms),
    ).toBeUndefined();
  });

  test("says nothing when the invitation declares no payload set at all", () => {
    // The lazy direction: an absent declaration is reconciled against this party's
    // own disclosure when the exchange runs, not against a set it never named --
    // whether the invitation carries no payload block, or one naming only what it
    // sends.
    for (const terms of [
      invitation("declaresNoPayloadAtAll"),
      invitation("declaresOnlyWhatItSends"),
    ]) {
      const { editorState } = editorFor(columns, terms);
      expect(acceptorDisclosedColumns(editorState.metadata)).toEqual(["notes"]);
      expect(
        acceptorColumnsTheInvitationWillNotAccept(terms, editorState.metadata),
      ).toEqual([]);
      const verdict = acceptorVerdict(columns, terms, editorState);
      expect(
        acceptorLaunchBlockedReason(verdict, editorState, terms),
      ).toBeUndefined();
    }
  });

  test("says nothing about a non-empty declaration, which is a different comparison", () => {
    const terms = invitation("acceptsTheDisclosedColumn");
    const { editorState } = editorFor(columns, terms);
    expect(
      acceptorColumnsTheInvitationWillNotAccept(terms, editorState.metadata),
    ).toEqual([]);
  });

  test("clears as the operator re-marks every disclosed column, re-enabling launch", () => {
    const terms = invitation("acceptsNothingAndTakesTheResult");
    // A matched column additionally marked sent, so the edit that clears the
    // conflict is exercised on both routes off that mark: back to matching for a
    // linkage column, and ignored for the unrecognized one, which cannot match.
    const sentTwice = setColumnDisclosure(
      acceptorInitialColumnsState(columns).metadata,
      "first_name",
      "payload",
    ).metadata;
    const seeded = editorFor(columns, terms, { metadata: sentTwice });
    expect(
      acceptorColumnsTheInvitationWillNotAccept(
        terms,
        seeded.editorState.metadata,
      ),
    ).toEqual(["first_name", "notes"]);

    // One of the two re-marked leaves the conflict standing on the other.
    const partly = setColumnDisclosure(sentTwice, "notes", "ignored").metadata;
    const halfCleared = editorFor(columns, terms, { metadata: partly });
    expect(
      acceptorColumnsTheInvitationWillNotAccept(
        terms,
        halfCleared.editorState.metadata,
      ),
    ).toEqual(["first_name"]);
    expect(
      acceptorLaunchBlockedReason(
        acceptorVerdict(columns, terms, halfCleared.editorState),
        halfCleared.editorState,
        terms,
      ),
    ).toBe(
      "Resolve the columns your partner will not accept above before you can start.",
    );

    const cleared = setColumnDisclosure(partly, "first_name", "match").metadata;
    const edited = editorFor(columns, terms, { metadata: cleared });
    expect(acceptorDisclosedColumns(edited.editorState.metadata)).toEqual([]);
    expect(
      acceptorColumnsTheInvitationWillNotAccept(
        terms,
        edited.editorState.metadata,
      ),
    ).toEqual([]);
    const verdict = acceptorVerdict(columns, terms, edited.editorState);
    expect(verdict.kind).toBe("allClear");
    expect(
      acceptorLaunchBlockedReason(verdict, edited.editorState, terms),
    ).toBeUndefined();
  });

  // The shape the equivalence deliberately excludes, named so that excluding it is
  // an act rather than an omission; the test after the equivalence owns it.
  const scopeLimitShape = "acceptsOnlyAColumnNotDisclosed";

  test("fires exactly when core's own enforcement refuses the pair", () => {
    // The web predicate states in this package a condition core enforces in its
    // own, so a change to core's gate would leave the notice quietly wrong -- the
    // operator told the exchange can start, and refused at launch. Every shape this
    // describe drives, through core's real mirror and real assertion: the notice
    // and the refusal agree, or this fails.
    for (const shape of Object.keys(shapes) as Array<keyof typeof shapes>) {
      if (shape === scopeLimitShape) continue;
      const terms = invitation(shape);
      const { editorState } = editorFor(columns, terms);
      expect(
        acceptorColumnsTheInvitationWillNotAccept(terms, editorState.metadata)
          .length > 0,
        shape,
      ).toBe(coreRefuses(terms, editorState.metadata));
    }
  });

  test("leaves a disagreeing non-empty declaration to core, by design", () => {
    // The equivalence above is scoped to the declaration this notice reads -- the
    // empty one. A non-empty declaration that disagrees with the marks is a
    // different comparison, with a named set and different remedies, and core
    // still refuses it: the notice is silent here by design, and this is what says
    // so rather than the equivalence test quietly excluding the case.
    const terms = invitation(scopeLimitShape);
    const { editorState } = editorFor(columns, terms);
    expect(
      acceptorColumnsTheInvitationWillNotAccept(terms, editorState.metadata),
    ).toEqual([]);
    expect(coreRefuses(terms, editorState.metadata)).toBe(true);
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
      false,
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
      false,
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
      false,
    );
    expect(attention.needsAttention).toBe(true);
    expect(attention.failingFieldCount).toBe(0);
    expect(attention.railValue).toBe("1 key to review");
  });

  test("an unavailable coverage sweep raises attention with a distinct rail value", () => {
    const attention = acceptorCleaningAttention(
      satisfiable.editorState.standardization,
      null,
      0,
      true,
    );
    expect(attention.needsAttention).toBe(true);
    expect(attention.failingFieldCount).toBe(0);
    expect(attention.railValue).toBe("Coverage unavailable");
  });

  test("a dead key outranks an unavailable sweep in the rail value", () => {
    const attention = acceptorCleaningAttention(
      satisfiable.editorState.standardization,
      null,
      1,
      true,
    );
    expect(attention.railValue).toBe("1 key to review");
  });
});

describe("acceptor columns editor state: input-override layer", () => {
  // A single firstName field with two candidate columns of that same type, so the
  // default binding (the FIRST column of the type -- resolveFieldColumns) and an
  // explicit input override (the SECOND column) are observably different. Only
  // given_name starts role: linkage; nickname is remapped to it in the tests below
  // via setColumnTypeForMatching, exactly as the columns-step quick-fix mapper does.
  const oneFieldTerms: LinkageTerms = {
    version: "1.0.0",
    identity: "County Health Department",
    date: "2026-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: true },
    deduplicate: false,
    linkageFields: [{ name: "firstName", type: "first_name" }],
    linkageKeys: [{ name: "first", elements: [{ field: "firstName" }] }],
  };
  const columns = ["given_name", "nickname"];

  test("a live input override rebinds the field to the target column", () => {
    const seed = acceptorInitialColumnsState(columns);
    const bothLinkage = setColumnTypeForMatching(
      setColumnTypeForMatching(seed.metadata, "given_name", "first_name"),
      "nickname",
      "first_name",
    );
    const withoutOverride = editorFor(columns, oneFieldTerms, {
      metadata: bothLinkage,
    });
    // With no override, the default binding is the first role: linkage column of
    // the type.
    expect(withoutOverride.editorState.standardization[0].input).toBe(
      "given_name",
    );

    const withOverride = editorFor(columns, oneFieldTerms, {
      metadata: bothLinkage,
      inputOverrides: new Map([["firstName", "nickname"]]),
    });
    expect(withOverride.editorState.standardization[0].input).toBe("nickname");
  });

  test("a stale input override (target no longer role: linkage of that type) is dropped", () => {
    const seed = acceptorInitialColumnsState(columns);
    // Only given_name is role: linkage; nickname is left at its inferred role
    // (payload, an unrecognized header), so an override pointing at it is stale.
    const onlyGivenNameLinkage = setColumnTypeForMatching(
      seed.metadata,
      "given_name",
      "first_name",
    );
    const { editorState } = editorFor(columns, oneFieldTerms, {
      metadata: onlyGivenNameLinkage,
      inputOverrides: new Map([["firstName", "nickname"]]),
    });
    // The stale override is dropped; the derived default (given_name) returns
    // rather than binding a column the core would refuse.
    expect(editorState.standardization[0].input).toBe("given_name");
  });

  test("layering order: an input rebind stales a step override authored against the old input", () => {
    const seed = acceptorInitialColumnsState(columns);
    const bothLinkage = setColumnTypeForMatching(
      setColumnTypeForMatching(seed.metadata, "given_name", "first_name"),
      "nickname",
      "first_name",
    );
    // Author a step override against the ORIGINAL input (given_name).
    const stepOverrides = new Map([
      [
        "firstName",
        { input: "given_name", steps: [{ function: "to_upper_case" }] },
      ],
    ]);
    const beforeRebind = editorFor(columns, oneFieldTerms, {
      metadata: bothLinkage,
      stepOverrides,
    });
    // The step override applies while the field is still bound to given_name.
    expect(beforeRebind.editorState.standardization[0].input).toBe(
      "given_name",
    );
    expect(beforeRebind.editorState.standardization[0].steps).toEqual([
      { function: "to_upper_case" },
    ]);

    // Now rebind the input to nickname AND keep the same (now-stale) step
    // override. applyInputOverrides runs before applyStepOverrides, so the step
    // override's `input: "given_name"` no longer matches the rebound
    // transformation's input and is dropped, rather than silently cleaning the
    // new column with steps authored for the old one.
    const afterRebind = editorFor(columns, oneFieldTerms, {
      metadata: bothLinkage,
      inputOverrides: new Map([["firstName", "nickname"]]),
      stepOverrides,
    });
    expect(afterRebind.editorState.standardization[0].input).toBe("nickname");
    expect(afterRebind.editorState.standardization[0].steps).not.toEqual([
      { function: "to_upper_case" },
    ]);
  });
});
