import { describe, expect, test } from "vitest";

import {
  MAX_NAME_LENGTH,
  assertDisclosedNamesCarriable,
  assertPayloadSendDisclosed,
  deriveAcceptedLinkageTerms,
  safeParseLinkageTerms,
  sanitizeForDisplay,
} from "@psilink/core";

import {
  acceptorCleaningAttention,
  acceptorColumnsEditorState,
  acceptorDisclosedColumns,
  acceptorHasIdentifierConflict,
  acceptorInitialColumnsState,
  acceptorLaunchBlockedReason,
  acceptorLaunchPayload,
  acceptorOverlongDisclosedColumns,
  acceptorPayloadDeclarationConflict,
  acceptorUnsatisfiedTypes,
  acceptorVerdict,
} from "@exchange/acceptorColumnsModel";

import {
  CONFIG_EXCHANGE_FILES,
  EXCHANGE_FILES_DEFAULT,
  exchangeFilesProblems,
} from "@console/exchangeFilesModel";
import {
  CONNECTION_TUNING_DEFAULT,
  connectionTuningProblems,
} from "@console/connectionTuningModel";
import {
  SPLIT_RENDEZVOUS_RETAIN_REQUIREMENT,
  splitRendezvousRetainProblem,
} from "@console/filedropRendezvousChoice";

import { OFFLINE_EXCHANGE_REASON } from "@psi/offlineExchangeGate";

import {
  setColumnDisclosure,
  setColumnTypeForMatching,
} from "@psi/metadataEditing";

import type { CSVRow, LinkageTerms, Metadata } from "@psilink/core";
import type { AcceptorColumnsState } from "@exchange/acceptorColumnsModel";
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
// matter the data. Core's verdict grades this key dead.
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

describe("acceptor verdict (re-shown, not re-derived)", () => {
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

  test("a partially-covered file shows N-of-M and is not fully satisfied", () => {
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
    // The three display kinds show coverage; the launch decision is core's.
    expect(verdict.fullySatisfied).toBe(false);
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

  test("a self-defeating adopted rule shows all-clear on coverage yet is not satisfied", () => {
    const { editorState } = editorFor(["date_of_birth"], deadDobTerms);
    const verdict = acceptorVerdict(
      ["date_of_birth"],
      deadDobTerms,
      editorState,
    );
    // The columns are present, so the coverage reading passes and the dead rule is
    // reported separately as a count -- but the key can never match, so the run
    // decision does not follow the coverage reading.
    expect(verdict.kind).toBe("allClear");
    expect(verdict.deadKeyCount).toBe(1);
    expect(verdict.fullySatisfied).toBe(false);
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

  test("partial coverage disables launch and offers both remedies", () => {
    // An exchange runs every key both parties agreed on, so covering some of them
    // is refused at the run boundary -- and therefore here, where the operator can
    // still remap a column or go back to the partner.
    const { editorState } = editorFor(["first_name", "notes"], nameTerms);
    const verdict = acceptorVerdict(
      ["first_name", "notes"],
      nameTerms,
      editorState,
    );
    expect(verdict.kind).toBe("partial");
    expect(verdict.fullySatisfied).toBe(false);
    expect(acceptorLaunchBlockedReason(verdict, editorState, nameTerms)).toBe(
      "Cover the remaining agreed linkage keys above before you can start, " +
        "or agree terms with your partner over the keys both files can supply.",
    );
  });

  test("a dead key disables launch and sends the operator to the partner", () => {
    // Every element field resolves, so coverage shows all-clear -- but the agreed
    // terms declare cleaning that drops every record, which no edit on this screen
    // clears. The sentence names the one remedy that exists.
    const columns = ["date_of_birth"];
    const { editorState } = editorFor(columns, deadDobTerms);
    const verdict = acceptorVerdict(columns, deadDobTerms, editorState);
    expect(verdict.kind).toBe("allClear");
    expect(verdict.deadKeyCount).toBe(1);
    expect(verdict.fullySatisfied).toBe(false);
    expect(
      acceptorLaunchBlockedReason(verdict, editorState, deadDobTerms),
    ).toBe(
      "Ask your partner for a corrected invitation before you can start: " +
        "cleaning declared in the agreed terms drops every record for a key, " +
        "so it can never match.",
    );
  });

  test("two identifier columns disable launch even when the keys are satisfiable, naming the identifier rule", () => {
    const columns = ["id", "identifier", "first_name", "last_name"];
    const { editorState } = editorFor(columns, nameTerms);
    // The keys are covered, but the seed has two identifiers.
    const verdict = acceptorVerdict(columns, nameTerms, editorState);
    expect(verdict.kind).toBe("allClear");
    expect(acceptorHasIdentifierConflict(editorState.metadata)).toBe(true);
    expect(acceptorLaunchBlockedReason(verdict, editorState, nameTerms)).toBe(
      "Choose a single record identifier column above before you can start.",
    );
  });

  test("a mid-edit cleaning step disables launch (standardization invalid) and points at the steps", () => {
    // A date_of_birth field whose recommended parse_date step is cleared mid-edit:
    // the override layer has an invalid step, so the gate must close.
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
  // connection authored, a file-handling combination core refuses, and a
  // connection-tuning value the run would refuse.
  const satisfiableColumns = ["first_name", "last_name"];
  const satisfiable = editorFor(satisfiableColumns, nameTerms);
  const satisfiableVerdict = acceptorVerdict(
    satisfiableColumns,
    nameTerms,
    satisfiable.editorState,
  );

  test("a device reporting offline disables launch and names the shared reason", () => {
    const blocks = {
      connectionBlocked: false,
      exchangeFilesBlocked: false,
      connectionTuningBlocked: false,
      runDiagnosticsBlocked: false,
      receiptsBlocked: false,
    };
    expect(
      acceptorLaunchBlockedReason(
        satisfiableVerdict,
        satisfiable.editorState,
        nameTerms,
        { ...blocks, offline: true },
      ),
    ).toBe(OFFLINE_EXCHANGE_REASON);
    // Only the offline direction gates: a device reporting a connection is not
    // treated as a promise that the partner is reachable, so it blocks nothing.
    expect(
      acceptorLaunchBlockedReason(
        satisfiableVerdict,
        satisfiable.editorState,
        nameTerms,
        { ...blocks, offline: false },
      ),
    ).toBeUndefined();
  });

  test("offline speaks ahead of the screen's own problems, which no edit here can outrun", () => {
    // A file that can match nothing is a fix the operator makes on this screen;
    // no network is not, so it is the sentence they meet first rather than the
    // one waiting after every column is set.
    const columns = ["id", "identifier", "notes"];
    const { editorState } = editorFor(columns, nameTerms);
    const verdict = acceptorVerdict(columns, nameTerms, editorState);
    expect(verdict.satisfiableKeyCount).toBe(0);
    expect(
      acceptorLaunchBlockedReason(verdict, editorState, nameTerms, {
        offline: true,
        connectionBlocked: false,
        exchangeFilesBlocked: false,
        connectionTuningBlocked: false,
        runDiagnosticsBlocked: false,
        receiptsBlocked: false,
      }),
    ).toBe(OFFLINE_EXCHANGE_REASON);
  });

  test("an unauthored transport connection disables launch and names the connection card", () => {
    expect(
      acceptorLaunchBlockedReason(
        satisfiableVerdict,
        satisfiable.editorState,
        nameTerms,
        {
          offline: false,
          connectionBlocked: true,
          exchangeFilesBlocked: false,
          connectionTuningBlocked: false,
          runDiagnosticsBlocked: false,
          receiptsBlocked: false,
        },
      ),
    ).toBe("Set up the SFTP connection above before you can start.");
  });

  test("a split rendezvous without retain mode disables launch, in the console's words", () => {
    // The acceptor's directories are the console's own mounts, so a split
    // console imposes the retain precondition on every accept it runs -- and
    // the sentence the operator meets is the one naming the control to turn on,
    // taken from the shared predicate rather than restated here.
    expect(
      acceptorLaunchBlockedReason(
        satisfiableVerdict,
        satisfiable.editorState,
        nameTerms,
        {
          offline: false,
          connectionBlocked: false,
          exchangeFilesBlocked: false,
          connectionTuningBlocked: false,
          runDiagnosticsBlocked: false,
          receiptsBlocked: false,
          splitDirectoryProblem: splitRendezvousRetainProblem(
            { configured: true, split: true, locator: "in" },
            false,
          ),
        },
      ),
    ).toBe(SPLIT_RENDEZVOUS_RETAIN_REQUIREMENT);
  });

  test("a refused file-handling combination disables launch and names those settings", () => {
    expect(
      acceptorLaunchBlockedReason(
        satisfiableVerdict,
        satisfiable.editorState,
        nameTerms,
        {
          offline: false,
          connectionBlocked: false,
          exchangeFilesBlocked: true,
          connectionTuningBlocked: false,
          runDiagnosticsBlocked: false,
          receiptsBlocked: false,
        },
      ),
    ).toBe("Resolve the file-handling settings above before you can start.");
  });

  test("a refused connection-tuning value names that card rather than the file-handling one", () => {
    // Both cards sit in the one section below the columns, so a shared flag would
    // send the operator to the wrong one -- and each is a collapsed disclosure
    // whose own problem notice is invisible until it is opened. Driven through
    // both cards' models exactly as the screen drives them, rather than by setting
    // the flags by hand.
    const stepBlocks = {
      offline: false,
      connectionBlocked: false,
      exchangeFilesBlocked:
        exchangeFilesProblems(EXCHANGE_FILES_DEFAULT, CONFIG_EXCHANGE_FILES)
          .length > 0,
      connectionTuningBlocked:
        connectionTuningProblems({
          ...CONNECTION_TUNING_DEFAULT,
          peerTimeout: { magnitude: "soon", unit: "m" },
        }).length > 0,
      runDiagnosticsBlocked: false,
      receiptsBlocked: false,
    };
    expect(stepBlocks.exchangeFilesBlocked).toBe(false);
    expect(stepBlocks.connectionTuningBlocked).toBe(true);
    expect(
      acceptorLaunchBlockedReason(
        satisfiableVerdict,
        satisfiable.editorState,
        nameTerms,
        stepBlocks,
      ),
    ).toBe(
      "Resolve the connection-tuning settings above before you can start.",
    );
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
        {
          offline: false,
          connectionBlocked: false,
          exchangeFilesBlocked: false,
          connectionTuningBlocked: false,
          runDiagnosticsBlocked: false,
          receiptsBlocked: false,
        },
      ),
    );
  });

  test("with several gates closed the sentence names the topmost surface on the screen", () => {
    // A file that can match nothing AND has two identifiers AND has no
    // connection authored: the operator is sent to the verdict at the top of the
    // step, not to a gate further down that a fix up there may clear anyway.
    const columns = ["id", "identifier", "notes"];
    const { editorState } = editorFor(columns, nameTerms);
    const verdict = acceptorVerdict(columns, nameTerms, editorState);
    expect(verdict.satisfiableKeyCount).toBe(0);
    expect(acceptorHasIdentifierConflict(editorState.metadata)).toBe(true);
    expect(
      acceptorLaunchBlockedReason(verdict, editorState, nameTerms, {
        offline: false,
        connectionBlocked: true,
        exchangeFilesBlocked: true,
        connectionTuningBlocked: true,
        runDiagnosticsBlocked: false,
        receiptsBlocked: false,
      }),
    ).toBe(
      "Set your columns to the missing field types above before you can start.",
    );
  });
});

describe("a marked column whose name is too long to include", () => {
  // The gap this closes: the seed metadata comes from inferMetadata over the
  // acceptor's own header, which no schema bounds, so an oversized name is markable
  // here and refused only by the partner's parse of the payload frame -- after the
  // frame is sent.
  const atCeiling = "a".repeat(MAX_NAME_LENGTH);
  const pastCeiling = atCeiling + "a";
  // One code POINT, two UTF-16 code units: MAX_NAME_LENGTH of them is under the
  // ceiling on the count ColumnName's display cut uses and over it on the count
  // every such bound uses.
  const astralPastCeiling = "\u{1D54F}".repeat(MAX_NAME_LENGTH);

  /** The columns step for a file covering both keys plus one payload column of
   * the given name (inferred `other`, so it is marked to send). */
  function stepFor(name: string) {
    const columns = ["first_name", "last_name", name];
    const { editorState } = editorFor(columns, nameTerms);
    return {
      editorState,
      verdict: acceptorVerdict(columns, nameTerms, editorState),
    };
  }

  test("a name at the ceiling is valid and does not block launch", () => {
    const { editorState, verdict } = stepFor(atCeiling);
    expect(acceptorDisclosedColumns(editorState.metadata)).toEqual([atCeiling]);
    expect(
      acceptorOverlongDisclosedColumns(nameTerms, editorState.metadata),
    ).toEqual([]);
    expect(
      acceptorLaunchBlockedReason(verdict, editorState, nameTerms),
    ).toBeUndefined();
  });

  test("one code unit past the ceiling blocks launch, naming the notice above", () => {
    const { editorState, verdict } = stepFor(pastCeiling);
    expect(
      acceptorOverlongDisclosedColumns(nameTerms, editorState.metadata),
    ).toEqual([3]);
    expect(acceptorLaunchBlockedReason(verdict, editorState, nameTerms)).toBe(
      "Resolve the column name that is too long to send above before you can start.",
    );
  });

  test("the bound counts UTF-16 code units, not the code points the display cut counts", () => {
    expect([...astralPastCeiling].length).toBe(MAX_NAME_LENGTH);
    expect(astralPastCeiling.length).toBe(MAX_NAME_LENGTH * 2);
    const { editorState, verdict } = stepFor(astralPastCeiling);
    expect(
      acceptorOverlongDisclosedColumns(nameTerms, editorState.metadata),
    ).toEqual([3]);
    expect(
      acceptorLaunchBlockedReason(verdict, editorState, nameTerms),
    ).toBeDefined();
  });

  test("unmarking the column clears the block -- the file itself is not refused", () => {
    // An oversized name is fully usable for matching and ignoring: the bound is on
    // what is DISCLOSED, so it clears on this screen without another file.
    const { editorState, verdict } = stepFor(pastCeiling);
    const unmarked = {
      ...editorState,
      metadata: setColumnDisclosure(
        editorState.metadata,
        pastCeiling,
        "ignored",
      ).metadata,
    };
    expect(acceptorDisclosedColumns(unmarked.metadata)).toEqual([]);
    expect(
      acceptorOverlongDisclosedColumns(nameTerms, unmarked.metadata),
    ).toEqual([]);
    expect(
      acceptorLaunchBlockedReason(verdict, unmarked, nameTerms),
    ).toBeUndefined();
  });

  test("several offending columns pluralize the sentence", () => {
    const columns = ["first_name", "last_name", pastCeiling, pastCeiling + "b"];
    const { editorState } = editorFor(columns, nameTerms);
    const verdict = acceptorVerdict(columns, nameTerms, editorState);
    expect(
      acceptorOverlongDisclosedColumns(nameTerms, editorState.metadata),
    ).toEqual([3, 4]);
    expect(acceptorLaunchBlockedReason(verdict, editorState, nameTerms)).toBe(
      "Resolve the column names that are too long to send above before you can start.",
    );
  });

  test("says nothing when the inviting party is entitled to no result", () => {
    // Nothing is transmitted to a party that receives no result, so no name is
    // disclosed and the run does not refuse this pair -- and the panel beside the
    // grid already states that no column leaves whatever these marks say.
    const noResultTerms: LinkageTerms = {
      ...nameTerms,
      output: { expectsOutput: false, shareWithPartner: true },
    };
    const columns = ["first_name", "last_name", pastCeiling];
    const { editorState } = editorFor(columns, noResultTerms);
    const verdict = acceptorVerdict(columns, noResultTerms, editorState);
    expect(acceptorDisclosedColumns(editorState.metadata)).toEqual([
      pastCeiling,
    ]);
    expect(
      acceptorOverlongDisclosedColumns(noResultTerms, editorState.metadata),
    ).toEqual([]);
    expect(
      acceptorLaunchBlockedReason(verdict, editorState, noResultTerms),
    ).toBeUndefined();
  });

  test("the gate refuses exactly what core's prepare-time refusal does", () => {
    // Driven through core's own function rather than a second model of it: the
    // screen and the run must not disagree about which names are valid. The
    // acceptor's own output is the invitation's mirrored onto it, which is what
    // core reads.
    const accepted = deriveAcceptedLinkageTerms(nameTerms, "Sam Alvarez");
    for (const name of [atCeiling, pastCeiling, astralPastCeiling]) {
      const { editorState } = stepFor(name);
      let coreRefused = false;
      try {
        assertDisclosedNamesCarriable(editorState.metadata, accepted.output);
      } catch {
        coreRefused = true;
      }
      expect(
        acceptorOverlongDisclosedColumns(nameTerms, editorState.metadata)
          .length > 0,
      ).toBe(coreRefused);
    }
  });
});

describe("the invitation's declared payload set against the marks", () => {
  // A file covering both keys plus one unrecognized column, which infers to role:
  // payload -- so the file discloses exactly one column and every other gate is
  // clear, leaving this comparison as the only thing that can close the launch.
  // `record_id` infers to the identifier role (unsent, unmatched), so marking it
  // adds a disclosure without costing a key -- which lets the conflict sentences be
  // pinned at the gate without the linkage clause above them firing too.
  const columns = ["first_name", "last_name", "notes", "record_id"];

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
    acceptsTheDisclosedColumnAndOneTheFileLacks: {
      payload: { receive: [{ name: "notes" }, { name: "risk_score" }] },
    },
    acceptsTheDisclosedColumnAndOneMarkedForMatching: {
      payload: { receive: [{ name: "notes" }, { name: "first_name" }] },
    },
  } satisfies Record<string, Partial<LinkageTerms>>;

  /** The invitation's own perspective, which the columns step holds, with the
   * named shape's payload declaration and output entitlement. Taking a name rather
   * than a literal keeps {@link shapes} the only place a shape is written. */
  function invitation(shape: keyof typeof shapes): LinkageTerms {
    return { ...nameTerms, ...shapes[shape] };
  }

  const inferredMarks = acceptorInitialColumnsState(columns).metadata;

  /** The mark states every shape is driven in. The inferred marks disclose one
   * column, so a declaration can only omit that one or name others; the second
   * state discloses two, which is what makes a NON-EMPTY declaration able to omit
   * one while naming another -- the under-declared direction the empty declaration
   * cannot produce on this file. */
  const markStates = {
    asInferred: inferredMarks,
    firstNameAlsoSent: setColumnDisclosure(
      inferredMarks,
      "first_name",
      "payload",
    ).metadata,
    recordIdAlsoSent: setColumnDisclosure(inferredMarks, "record_id", "payload")
      .metadata,
  } satisfies Record<string, Metadata>;

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
    const conflict = acceptorPayloadDeclarationConflict(
      terms,
      editorState.metadata,
    );
    expect(conflict?.kind).toBe("acceptsNothing");
    expect(conflict?.sentButNotDeclared).toEqual(["notes"]);
    expect(conflict?.declaredButNotSent).toEqual([]);
    expect(conflict?.title).toBe("Your partner will not accept this column");
    // Every other gate is clear, so the conflict alone closes the launch -- and
    // the sentence the button is described by is the conflict's own.
    const verdict = acceptorVerdict(columns, terms, editorState);
    expect(verdict.kind).toBe("allClear");
    expect(acceptorHasIdentifierConflict(editorState.metadata)).toBe(false);
    expect(acceptorLaunchBlockedReason(verdict, editorState, terms)).toBe(
      conflict?.launchBlockedReason,
    );
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
      acceptorPayloadDeclarationConflict(terms, editorState.metadata),
    ).toBeUndefined();
    const verdict = acceptorVerdict(columns, terms, editorState);
    expect(
      acceptorLaunchBlockedReason(verdict, editorState, terms),
    ).toBeUndefined();
  });

  test("says nothing when the invitation declares no payload set at all", () => {
    // The lazy direction: an absent declaration is reconciled against this party's
    // own disclosure when the exchange runs, not against a set it never named --
    // whether the invitation has no payload block, or one naming only what it
    // sends.
    for (const terms of [
      invitation("declaresNoPayloadAtAll"),
      invitation("declaresOnlyWhatItSends"),
    ]) {
      const { editorState } = editorFor(columns, terms);
      expect(acceptorDisclosedColumns(editorState.metadata)).toEqual(["notes"]);
      expect(
        acceptorPayloadDeclarationConflict(terms, editorState.metadata),
      ).toBeUndefined();
      const verdict = acceptorVerdict(columns, terms, editorState);
      expect(
        acceptorLaunchBlockedReason(verdict, editorState, terms),
      ).toBeUndefined();
    }
  });

  test("says nothing when the declaration names exactly the columns the marks send", () => {
    const terms = invitation("acceptsTheDisclosedColumn");
    const { editorState } = editorFor(columns, terms);
    expect(
      acceptorPayloadDeclarationConflict(terms, editorState.metadata),
    ).toBeUndefined();
  });

  test("clears as the operator re-marks every disclosed column, re-enabling launch", () => {
    const terms = invitation("acceptsNothingAndTakesTheResult");
    // A matched column additionally marked sent, so the edit that clears the
    // conflict is exercised on both routes off that mark: back to matching for a
    // linkage column, and ignored for the unrecognized one, which cannot match.
    const sentTwice = markStates.firstNameAlsoSent;
    const seeded = editorFor(columns, terms, { metadata: sentTwice });
    expect(
      acceptorPayloadDeclarationConflict(terms, seeded.editorState.metadata)
        ?.sentButNotDeclared,
    ).toEqual(["first_name", "notes"]);

    // One of the two re-marked leaves the conflict standing on the other.
    const partly = setColumnDisclosure(sentTwice, "notes", "ignored").metadata;
    const halfCleared = editorFor(columns, terms, { metadata: partly });
    expect(
      acceptorPayloadDeclarationConflict(
        terms,
        halfCleared.editorState.metadata,
      )?.sentButNotDeclared,
    ).toEqual(["first_name"]);
    // Sending a matched column costs the key it matched on, so this state is short
    // of an agreed key as well as over-disclosing -- and the linkage clause is the
    // one the operator meets first, at the top of the screen. The remaining mark is
    // still named by the notice it points at.
    expect(
      acceptorLaunchBlockedReason(
        acceptorVerdict(columns, terms, halfCleared.editorState),
        halfCleared.editorState,
        terms,
      ),
    ).toBe(
      "Cover the remaining agreed linkage keys above before you can start, " +
        "or agree terms with your partner over the keys both files can supply.",
    );

    const cleared = setColumnDisclosure(partly, "first_name", "match").metadata;
    const edited = editorFor(columns, terms, { metadata: cleared });
    expect(acceptorDisclosedColumns(edited.editorState.metadata)).toEqual([]);
    expect(
      acceptorPayloadDeclarationConflict(terms, edited.editorState.metadata),
    ).toBeUndefined();
    const verdict = acceptorVerdict(columns, terms, edited.editorState);
    expect(verdict.kind).toBe("allClear");
    expect(
      acceptorLaunchBlockedReason(verdict, edited.editorState, terms),
    ).toBeUndefined();
  });

  test("a non-empty declaration that omits a marked column names it, and a re-mark here clears it", () => {
    // Under-declaration against a NON-EMPTY declaration: the declaration names one
    // of the two columns the marks send. The remedy is entirely local, so the
    // notice leads with it and the gate re-opens on the edit alone.
    const terms = invitation("acceptsTheDisclosedColumn");
    const marked = editorFor(columns, terms, {
      metadata: markStates.recordIdAlsoSent,
    });
    const conflict = acceptorPayloadDeclarationConflict(
      terms,
      marked.editorState.metadata,
    );
    expect(conflict?.kind).toBe("setMismatch");
    expect(conflict?.sentButNotDeclared).toEqual(["record_id"]);
    expect(conflict?.declaredButNotSent).toEqual([]);
    expect(conflict?.title).toBe("Your partner does not expect this column");
    const verdict = acceptorVerdict(columns, terms, marked.editorState);
    expect(verdict.fullySatisfied).toBe(true);
    expect(
      acceptorLaunchBlockedReason(verdict, marked.editorState, terms),
    ).toBe(
      "Resolve the columns your partner does not expect above before you can start.",
    );

    const reMarked = editorFor(columns, terms, {
      metadata: setColumnDisclosure(
        markStates.recordIdAlsoSent,
        "record_id",
        "identifier",
      ).metadata,
    });
    expect(
      acceptorPayloadDeclarationConflict(terms, reMarked.editorState.metadata),
    ).toBeUndefined();
    expect(
      acceptorLaunchBlockedReason(
        acceptorVerdict(columns, terms, reMarked.editorState),
        reMarked.editorState,
        terms,
      ),
    ).toBeUndefined();
  });

  test("a declared column the file does not have is named as absent, and no local edit is offered", () => {
    // Over-declaration with no local remedy at all: the operator cannot mark a
    // column their file does not have, so the entry says so and the notice's copy
    // leads with the corrected invitation.
    const terms = invitation("acceptsTheDisclosedColumnAndOneTheFileLacks");
    const { editorState } = editorFor(columns, terms);
    const conflict = acceptorPayloadDeclarationConflict(
      terms,
      editorState.metadata,
    );
    expect(conflict?.kind).toBe("setMismatch");
    expect(conflict?.sentButNotDeclared).toEqual([]);
    expect(conflict?.declaredButNotSent).toEqual([
      { displayName: "risk_score", inFile: false },
    ]);
    expect(conflict?.title).toBe(
      "Your partner expects a column you are not sending",
    );
    const verdict = acceptorVerdict(columns, terms, editorState);
    expect(acceptorLaunchBlockedReason(verdict, editorState, terms)).toBe(
      "Resolve the columns your partner expects above before you can start.",
    );
  });

  test("a declared column the file does have is flagged as one the operator could mark, and marking it clears the conflict", () => {
    // The secondary remedy, which exists only here: the column is in the file, so
    // marking it to send is available -- at the cost of disclosing more, which is
    // why it is never the notice's lead.
    const terms = invitation(
      "acceptsTheDisclosedColumnAndOneMarkedForMatching",
    );
    const { editorState } = editorFor(columns, terms);
    expect(
      acceptorPayloadDeclarationConflict(terms, editorState.metadata)
        ?.declaredButNotSent,
    ).toEqual([{ displayName: "first_name", inFile: true }]);

    const widened = editorFor(columns, terms, {
      metadata: markStates.firstNameAlsoSent,
    });
    expect(
      acceptorPayloadDeclarationConflict(terms, widened.editorState.metadata),
    ).toBeUndefined();
    // Widening clears the conflict but does not open the launch here: the column
    // the partner asked for is one this file matches on, so sending it costs the
    // key -- an exchange the run boundary refuses. The gate says so rather than
    // letting the operator launch into that refusal.
    expect(
      acceptorLaunchBlockedReason(
        acceptorVerdict(columns, terms, widened.editorState),
        widened.editorState,
        terms,
      ),
    ).toBe(
      "Cover the remaining agreed linkage keys above before you can start, " +
        "or agree terms with your partner over the keys both files can supply.",
    );
  });

  test("a declared column the file keeps as its record identifier is offered too, at the cost of the identifier", () => {
    // The same offer over a column that is neither matched on nor sent: `record_id`
    // infers to the identifier role, so `inFile` is read from the metadata whatever
    // use the column currently has, and what widening costs here is the one column
    // the file keeps unsent to index its own matched rows -- not matching, which
    // this column does not do.
    const identifierColumns = ["first_name", "last_name", "record_id"];
    const terms: LinkageTerms = {
      ...nameTerms,
      payload: { receive: [{ name: "record_id" }] },
    };
    const { editorState } = editorFor(identifierColumns, terms);
    expect(
      editorState.metadata.find((column) => column.name === "record_id")?.role,
    ).toBe("identifier");
    expect(acceptorDisclosedColumns(editorState.metadata)).toEqual([]);
    expect(
      acceptorPayloadDeclarationConflict(terms, editorState.metadata)
        ?.declaredButNotSent,
    ).toEqual([{ displayName: "record_id", inFile: true }]);

    const widened = setColumnDisclosure(
      editorState.metadata,
      "record_id",
      "payload",
    ).metadata;
    expect(acceptorPayloadDeclarationConflict(terms, widened)).toBeUndefined();
    expect(widened.some((column) => column.role === "identifier")).toBe(false);
  });

  test("both directions at once are stated together, and clearing one leaves the other named", () => {
    // Core reports both directions in one refusal, so both are held in one
    // statement: an operator who clears the marked column must not meet an
    // unmentioned second problem on the next attempt.
    const terms = invitation("acceptsOnlyAColumnNotDisclosed");
    const { editorState } = editorFor(columns, terms);
    const conflict = acceptorPayloadDeclarationConflict(
      terms,
      editorState.metadata,
    );
    expect(conflict?.sentButNotDeclared).toEqual(["notes"]);
    expect(conflict?.declaredButNotSent).toEqual([
      { displayName: "risk_score", inFile: false },
    ]);
    expect(conflict?.title).toBe(
      "Your columns do not match what your partner expects",
    );
    const verdict = acceptorVerdict(columns, terms, editorState);
    expect(acceptorLaunchBlockedReason(verdict, editorState, terms)).toBe(
      "Resolve the columns that do not match what your partner expects above before you can start.",
    );

    // Re-marking the one column the operator controls leaves the launch closed on
    // the direction they cannot fix, which the same statement already named.
    const reMarked = editorFor(columns, terms, {
      metadata: setColumnDisclosure(inferredMarks, "notes", "ignored").metadata,
    });
    const remaining = acceptorPayloadDeclarationConflict(
      terms,
      reMarked.editorState.metadata,
    );
    expect(remaining?.sentButNotDeclared).toEqual([]);
    expect(remaining?.declaredButNotSent).toEqual([
      { displayName: "risk_score", inFile: false },
    ]);
    expect(
      acceptorLaunchBlockedReason(
        acceptorVerdict(columns, terms, reMarked.editorState),
        reMarked.editorState,
        terms,
      ),
    ).toBe(
      "Resolve the columns your partner expects above before you can start.",
    );
  });

  test("a declared name is escaped and the operator's own header is not", () => {
    // The two halves of one statement have different provenance: the declaration
    // is the partner's text, which reaches the operator escaped at this sink; the
    // marked names are the operator's own CSV headers, which the step renders
    // through ColumnName's isolation and so must arrive here verbatim. Applying
    // either treatment to both is the failure this pins.
    // Written as an escape, never as a raw byte, so a test about an invisible
    // character is itself readable: U+202E RIGHT-TO-LEFT OVERRIDE, which reorders
    // the copy around it wherever it is rendered unescaped and uncontained.
    const partnerName = "risk\u202Escore";
    const ownHeader = "notes\u202Eevil";
    const ownColumns = ["first_name", "last_name", ownHeader];
    const terms: LinkageTerms = {
      ...nameTerms,
      payload: { receive: [{ name: partnerName }] },
    };
    const { editorState } = editorFor(ownColumns, terms);
    const conflict = acceptorPayloadDeclarationConflict(
      terms,
      editorState.metadata,
    );
    expect(conflict?.declaredButNotSent).toEqual([
      { displayName: sanitizeForDisplay(partnerName), inFile: false },
    ]);
    expect(conflict?.declaredButNotSent[0].displayName).not.toBe(partnerName);
    expect(conflict?.sentButNotDeclared).toEqual([ownHeader]);
  });

  test("every shape this describe drives is an invitation core would accept", () => {
    // The equivalence below is only worth what its shapes are: a shape core's own
    // schema would refuse at decode can never reach this step, so agreeing with
    // core on it would prove nothing.
    for (const shape of Object.keys(shapes) as Array<keyof typeof shapes>)
      expect(safeParseLinkageTerms(invitation(shape)).success, shape).toBe(
        true,
      );
  });

  test("a non-empty declaration cannot arrive alongside an inviting party entitled to no result", () => {
    // Why the non-empty comparison is ungated in both directions, exactly as core
    // leaves it, without contradicting the panel that says nothing is sent: the
    // pair those two statements would need is not a parseable invitation. Gating
    // the comparison on the output direction as the empty case does would instead
    // silence a refusal that does happen.
    expect(
      safeParseLinkageTerms({
        ...nameTerms,
        output: { expectsOutput: false, shareWithPartner: true },
        payload: { receive: [{ name: "risk_score" }] },
      }).success,
    ).toBe(false);
  });

  test("fires exactly when core's own enforcement refuses the pair", () => {
    // The web predicate states in this package a condition core enforces in its
    // own, so a change to core's gate would leave the notice quietly wrong -- the
    // operator told the exchange can start, and refused at launch. Every shape this
    // describe drives, in every mark state, through core's real mirror and real
    // assertion: the notice and the refusal agree, or this fails.
    for (const shape of Object.keys(shapes) as Array<keyof typeof shapes>)
      for (const marks of Object.keys(markStates) as Array<
        keyof typeof markStates
      >) {
        const terms = invitation(shape);
        const { editorState } = editorFor(columns, terms, {
          metadata: markStates[marks],
        });
        expect(
          acceptorPayloadDeclarationConflict(terms, editorState.metadata) !==
            undefined,
          `${shape} / ${marks}`,
        ).toBe(coreRefuses(terms, editorState.metadata));
      }
  });
});

describe("acceptor launch payload", () => {
  test("has the same metadata and standardization the verdict consumed", () => {
    const { editorState } = editorFor(["first_name", "last_name"], nameTerms);
    const payload = acceptorLaunchPayload(editorState);
    // The gate and the run cannot disagree: identical object references.
    expect(payload.edits.metadata).toBe(editorState.metadata);
    expect(payload.edits.standardization).toBe(editorState.standardization);
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
