import { describe, expect, test } from "vitest";

import { authoredLinkageFields } from "@psilink/core";

import { buildAdvancedTerms } from "@psi/advancedInvite";

import {
  answersRows,
  cleaningCoverageProblems,
  editorFromCsv,
  editorWithAlgorithm,
  editorWithAuthoredDraft,
  editorWithColumnDisclosure,
  editorWithColumnType,
  editorWithDeduplicate,
  editorWithFieldAdded,
  editorWithFieldSteps,
  editorWithIdentity,
  editorWithImportedTerms,
  editorWithKeyEnabled,
  editorWithKeyMoved,
  editorWithLegalAgreement,
  editorWithLifetime,
  editorWithLinkageStrategy,
  editorWithOutputDirection,
  editorWithTransport,
  enabledKeys,
  fileCardMeta,
  identifierProblem,
  invitationUsable,
  inviterCleaningAttention,
  inviterLedgerRows,
  inviterRailFacts,
  isCliTransport,
  keySatisfiabilityFor,
  lifetimeLabel,
  resetToRecommended,
  reviewValidation,
  sealEditor,
  spineProblems,
  transportChooserCopy,
  unsealEditor,
} from "@bench/inviterModel";

import type { AcquiredCsv } from "@bench/inviterModel";
import type { FieldValueCoverage } from "@psi/nonEmptyAggregate";

// Headers chosen from inferMetadata's exact-match alias table: four linkage
// types (enough to back several default keys), one _id-suffixed identifier,
// and one unrecognized column, which infers to a sent payload column.
const csv: AcquiredCsv = {
  fileName: "clients.csv",
  sizeBytes: Math.round(8.4 * 1024 ** 2),
  rawRows: [
    {
      client_id: "1",
      first_name: "Ann",
      last_name: "Lee",
      dob: "01/02/1990",
      ssn4: "1234",
      program_code: "A",
    },
  ],
  columns: [
    "client_id",
    "first_name",
    "last_name",
    "dob",
    "ssn4",
    "program_code",
  ],
};

function ledgerValue(editor: ReturnType<typeof editorFromCsv>, label: string) {
  const row = inviterLedgerRows(editor).find((entry) => entry.label === label);
  if (row === undefined) throw new Error(`no ledger row labeled ${label}`);
  return row;
}

describe("spine derivation from the read file", () => {
  test("seeding derives default keys and a disclosed send set", () => {
    const editor = editorFromCsv("Dana Okafor", csv);
    expect(enabledKeys(editor.draft).length).toBeGreaterThan(0);
    expect(editor.draft.identity).toBe("Dana Okafor");

    const send = ledgerValue(editor, "You will send");
    expect(send.value).toBe("program_code");

    const matchedOn = ledgerValue(editor, "Matched on");
    expect(Array.isArray(matchedOn.value)).toBe(true);
    expect((matchedOn.value as ReadonlyArray<string>)[0]).toMatch(/^1\. /);

    expect(ledgerValue(editor, "Expires").value).toBe("1 hour after you share");
    expect(ledgerValue(editor, "Results go to").value).toBe(
      "You and your partner",
    );
    expect(ledgerValue(editor, "Agreement").muted).toBe("None");
    expect(ledgerValue(editor, "Transport").value).toBe("Browser");
  });

  test("an unmatchable file derives zero keys", () => {
    const unmatchable: AcquiredCsv = {
      ...csv,
      columns: ["program_code", "notes"],
      rawRows: [{ program_code: "A", notes: "x" }],
    };
    const editor = editorFromCsv("Dana", unmatchable);
    expect(enabledKeys(editor.draft)).toEqual([]);
    expect(ledgerValue(editor, "Matched on").muted).toBe("No keys");
  });

  test("before a file is read, every ledger row is the placeholder", () => {
    for (const row of inviterLedgerRows(undefined)) {
      expect(row.value).toBeUndefined();
      expect(row.muted).toBeUndefined();
    }
    for (const fact of inviterRailFacts(undefined)) {
      expect(fact.fact).toBeUndefined();
    }
  });

  test("rail facts count the derived cleaning and keys", () => {
    const editor = editorFromCsv("Dana", csv);
    const facts = inviterRailFacts(editor);
    expect(facts[0].label).toBe("Cleaning");
    expect(facts[0].fact).toMatch(/^\d+ fields?$/);
    expect(facts[1].fact).toBe(`${enabledKeys(editor.draft).length} keys`);
    expect(facts[2].fact).toBeUndefined();
  });
});

describe("ledger tracks step-2 edits", () => {
  test("undisclosing the sent column empties the send row", () => {
    const seeded = editorFromCsv("Dana", csv);
    const { editor } = editorWithColumnDisclosure(
      seeded,
      csv,
      "program_code",
      "ignored",
    );
    const send = ledgerValue(editor, "You will send");
    expect(send.value).toBeUndefined();
    expect(send.muted).toBe("Nothing - matching only");
  });

  test("retyping a matched column reconciles the key set", () => {
    const seeded = editorFromCsv("Dana", csv);
    const before = enabledKeys(seeded.draft).length;
    const { editor } = editorWithColumnType(seeded, csv, "ssn4", "other");
    const after = enabledKeys(editor.draft).length;
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
    expect(ledgerValue(editor, "Matched on").value).toHaveLength(after);
    expect(inviterRailFacts(editor)[1].fact).toBe(`${after} keys`);
  });

  test("choosing an identifier demotes the previous one and reports it", () => {
    const twoIds: AcquiredCsv = {
      ...csv,
      columns: ["id", "identifier", "last_name", "dob"],
      rawRows: [{ id: "1", identifier: "2", last_name: "Lee", dob: "x" }],
    };
    const seeded = editorFromCsv("Dana", twoIds);
    expect(identifierProblem(seeded.draft)).toBe(true);

    const { editor, demotedIdentifiers } = editorWithColumnDisclosure(
      seeded,
      twoIds,
      "id",
      "identifier",
    );
    expect(demotedIdentifiers).toEqual(["identifier"]);
    expect(identifierProblem(editor.draft)).toBe(false);
  });

  test("a name edit relabels the identity without touching the keys", () => {
    const seeded = editorFromCsv("Dana", csv);
    const renamed = editorWithIdentity(seeded, "Riverbend County");
    expect(renamed.draft.identity).toBe("Riverbend County");
    expect(enabledKeys(renamed.draft)).toEqual(enabledKeys(seeded.draft));
  });
});

describe("display helpers", () => {
  test("lifetimeLabel phrases whole units", () => {
    expect(lifetimeLabel(3600)).toBe("1 hour after you share");
    expect(lifetimeLabel(7200)).toBe("2 hours after you share");
    expect(lifetimeLabel(86400)).toBe("1 day after you share");
    expect(lifetimeLabel(900)).toBe("15 minutes after you share");
  });

  test("fileCardMeta formats rows and size", () => {
    expect(fileCardMeta(12408, Math.round(8.4 * 1024 ** 2))).toBe(
      "12,408 rows - 8.4 MB",
    );
    expect(fileCardMeta(3, 2048)).toBe("3 rows - 2 KB");
  });

  test("invitationUsable is true only before the expiry moment", () => {
    const now = new Date("2026-07-08T19:00:00.000Z");
    expect(invitationUsable("2026-07-08T19:32:00.000Z", now)).toBe(true);
    expect(invitationUsable("2026-07-08T18:32:00.000Z", now)).toBe(false);
  });
});

describe("review and create", () => {
  test("a fresh seed has no problems and can mint", () => {
    const editor = editorFromCsv("Dana", csv);
    expect(spineProblems(editor)).toEqual([]);
    const validation = reviewValidation(editor);
    expect(validation.canGenerate).toBe(true);
    expect(validation.terms).toBeDefined();
  });

  test("an invalid term surfaces a problem that targets its source", () => {
    const seeded = editorFromCsv("Dana", csv);
    // Sending a column to a partner that receives no results is the
    // incoherent pair validateAdvancedInvite refuses; the column table owns
    // the disclosed set, so the problem points at step 2.
    const editor = editorWithOutputDirection(seeded, "inviter");
    const problems = spineProblems(editor);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0].target).toBe("columns");
    expect(reviewValidation(editor).canGenerate).toBe(false);

    const resolved = editorWithOutputDirection(editor, "both");
    expect(spineProblems(resolved)).toEqual([]);
  });

  test("the two-identifier conflict is a problem targeting step 2", () => {
    const twoIds: AcquiredCsv = {
      ...csv,
      columns: ["id", "identifier", "last_name", "dob"],
      rawRows: [{ id: "1", identifier: "2", last_name: "Lee", dob: "x" }],
    };
    const problems = spineProblems(editorFromCsv("Dana", twoIds));
    expect(
      problems.some(
        (problem) =>
          problem.message === "Choose a single row identifier" &&
          problem.target === "columns",
      ),
    ).toBe(true);
  });

  test("terms are immutable after create seals the session", () => {
    const sealedEditor = sealEditor(editorFromCsv("Dana", csv));
    expect(
      editorWithColumnDisclosure(sealedEditor, csv, "program_code", "ignored")
        .editor,
    ).toBe(sealedEditor);
    expect(editorWithColumnType(sealedEditor, csv, "dob", "other").editor).toBe(
      sealedEditor,
    );
    expect(editorWithIdentity(sealedEditor, "Other")).toBe(sealedEditor);
    expect(editorWithLifetime(sealedEditor, 86400)).toBe(sealedEditor);
    expect(editorWithOutputDirection(sealedEditor, "inviter")).toBe(
      sealedEditor,
    );
    expect(resetToRecommended(sealedEditor, csv)).toBe(sealedEditor);
  });

  test("check-your-answers restates the proposal with change targets", () => {
    const editor = editorWithLifetime(editorFromCsv("Dana Okafor", csv), 86400);
    const rows = answersRows(editor, csv);
    const byLabel = new Map(rows.map((row) => [row.label, row]));
    expect(byLabel.get("Your name")?.value).toBe("Dana Okafor");
    expect(byLabel.get("Your name")?.changeTarget).toBe("file");
    expect(byLabel.get("Your file")?.value).toBe("clients.csv - 1 rows");
    expect(byLabel.get("Columns shared")?.value).toBe("program_code");
    expect(byLabel.get("Columns shared")?.changeTarget).toBe("columns");
    expect(byLabel.get("Cleaning")?.value).toMatch(
      /^\d+ fields?, filled in from your file$/,
    );
    expect(byLabel.get("Matching keys")?.value).toMatch(
      /^\d+ keys?, tried in order$/,
    );
    expect(byLabel.get("Invitation lifetime")?.value).toBe("1 day");
    expect(byLabel.get("Invitation lifetime")?.setAbove).toBe(true);
    expect(byLabel.get("Results go to")?.value).toBe("You and your partner");
    expect(byLabel.get("Transport")?.value).toBe("Live, in this browser");
  });

  test("a minted expiry replaces the relative lifetime in the ledger", () => {
    const editor = editorFromCsv("Dana", csv);
    const rows = inviterLedgerRows(editor, "2026-07-08T19:32:00.000Z");
    const expires = rows.find((row) => row.label === "Expires");
    expect(expires?.value).toContain("July 8, 2026");
  });
});

describe("inviter cleaning attention", () => {
  // A silent-empty rate: the field's transform produced a key for zero rows over
  // a non-empty file (produced 0, total > 0, computable) -- the collapse the
  // full-CSV sweep exists to catch.
  function collapsed(output: string, input: string): FieldValueCoverage {
    return {
      output,
      input,
      total: 10,
      produced: 0,
      rate: 0,
      unavailable: false,
    };
  }
  // A field that produces a value for every row -- no collapse.
  function covered(output: string, input: string): FieldValueCoverage {
    return {
      output,
      input,
      total: 10,
      produced: 10,
      rate: 1,
      unavailable: false,
    };
  }

  test("no file raises no attention and no coverage problems", () => {
    const attention = inviterCleaningAttention(undefined, new Map());
    expect(attention.needsAttention).toBe(false);
    expect(attention.railValue).toBeUndefined();
    expect(cleaningCoverageProblems(undefined, new Map())).toEqual([]);
  });

  test("a null (pending) rate map raises nothing", () => {
    const editor = editorFromCsv("Dana", csv);
    const attention = inviterCleaningAttention(editor, null);
    expect(attention.needsAttention).toBe(false);
    expect(attention.failingFieldCount).toBe(0);
    expect(attention.railValue).toBeUndefined();
    expect(cleaningCoverageProblems(editor, null)).toEqual([]);
  });

  test("fully-covered rates raise nothing", () => {
    const editor = editorFromCsv("Dana", csv);
    const rates = new Map(
      editor.draft.standardization.map((t) => [
        t.output,
        covered(t.output, t.input),
      ]),
    );
    const attention = inviterCleaningAttention(editor, rates);
    expect(attention.needsAttention).toBe(false);
    expect(attention.railValue).toBeUndefined();
    expect(cleaningCoverageProblems(editor, rates)).toEqual([]);
  });

  test("a silent-empty field raises attention with the failing-field count", () => {
    const editor = editorFromCsv("Dana", csv);
    const rates = new Map<string, FieldValueCoverage>([
      ["date_of_birth", collapsed("date_of_birth", "dob")],
    ]);
    const attention = inviterCleaningAttention(editor, rates);
    expect(attention.needsAttention).toBe(true);
    expect(attention.failingFieldCount).toBe(1);
    expect(attention.railValue).toBe("1 field failing");
  });

  test("the coverage problem names the field's safe label and links to cleaning", () => {
    const editor = editorFromCsv("Dana", csv);
    const rates = new Map<string, FieldValueCoverage>([
      ["date_of_birth", collapsed("date_of_birth", "dob")],
    ]);
    const problems = cleaningCoverageProblems(editor, rates);
    expect(problems).toEqual([
      {
        key: "date_of_birth",
        message: 'Cleaning: "Date of birth" produces no value in any row',
        target: "cleaning",
      },
    ]);
  });

  test("every failing field gets its own problem entry", () => {
    const editor = editorFromCsv("Dana", csv);
    const rates = new Map<string, FieldValueCoverage>([
      ["first_name", collapsed("first_name", "first_name")],
      ["last_name", collapsed("last_name", "last_name")],
    ]);
    const attention = inviterCleaningAttention(editor, rates);
    expect(attention.failingFieldCount).toBe(2);
    expect(attention.railValue).toBe("2 fields failing");
    const problems = cleaningCoverageProblems(editor, rates);
    expect(problems.map((problem) => problem.message)).toEqual([
      'Cleaning: "First name" produces no value in any row',
      'Cleaning: "Last name" produces no value in any row',
    ]);
  });

  test("same-typed failing fields each get an entry, told apart by column", () => {
    // Two first_name-typed fields: retype a spare column into matching, then
    // the expert add-field affordance binds the second field to it.
    const nicknamed: AcquiredCsv = {
      ...csv,
      rawRows: [{ ...csv.rawRows[0], nickname: "Annie" }],
      columns: [...csv.columns, "nickname"],
    };
    const retyped = editorWithColumnType(
      editorFromCsv("Dana", nicknamed),
      nicknamed,
      "nickname",
      "first_name",
    ).editor;
    const matched = editorWithColumnDisclosure(
      retyped,
      nicknamed,
      "nickname",
      "match",
    ).editor;
    const editor = editorWithFieldAdded(matched, "first_name");
    expect(
      editor.draft.standardization.some(
        (transformation) => transformation.input === "nickname",
      ),
    ).toBe(true);

    const bothFailing = new Map<string, FieldValueCoverage>([
      ["first_name", collapsed("first_name", "first_name")],
      ["first_name_2", collapsed("first_name_2", "nickname")],
    ]);
    expect(
      inviterCleaningAttention(editor, bothFailing).failingFieldCount,
    ).toBe(2);
    const problems = cleaningCoverageProblems(editor, bothFailing);
    expect(problems.map((problem) => problem.message)).toEqual([
      'Cleaning: "First name" (from first_name) produces no value in any row',
      'Cleaning: "First name" (from nickname) produces no value in any row',
    ]);
    // The render keys stay distinct even if the messages ever collide (two
    // same-typed fields rebound to one column).
    expect(new Set(problems.map((problem) => problem.key)).size).toBe(2);

    // One failing field of a duplicated type still names its column: the
    // ambiguity is about what was authored, not about what failed.
    const oneFailing = new Map<string, FieldValueCoverage>([
      ["first_name_2", collapsed("first_name_2", "nickname")],
    ]);
    expect(
      cleaningCoverageProblems(editor, oneFailing).map(
        (problem) => problem.message,
      ),
    ).toEqual([
      'Cleaning: "First name" (from nickname) produces no value in any row',
    ]);
  });

  test("attention clears when the pipeline recovers", () => {
    const editor = editorFromCsv("Dana", csv);
    const failing = new Map<string, FieldValueCoverage>([
      ["date_of_birth", collapsed("date_of_birth", "dob")],
    ]);
    expect(inviterCleaningAttention(editor, failing).needsAttention).toBe(true);
    const recovered = new Map<string, FieldValueCoverage>([
      ["date_of_birth", covered("date_of_birth", "dob")],
    ]);
    const attention = inviterCleaningAttention(editor, recovered);
    expect(attention.needsAttention).toBe(false);
    expect(attention.railValue).toBeUndefined();
    expect(cleaningCoverageProblems(editor, recovered)).toEqual([]);
  });

  test("the Cleaning rail fact turns amber only while a field is failing", () => {
    const editor = editorFromCsv("Dana", csv);
    const plain = inviterRailFacts(editor)[0];
    expect(plain.label).toBe("Cleaning");
    expect(plain.tone).toBeUndefined();
    expect(plain.fact).toMatch(/^\d+ fields?$/);

    const rates = new Map<string, FieldValueCoverage>([
      ["date_of_birth", collapsed("date_of_birth", "dob")],
    ]);
    const attention = inviterCleaningAttention(editor, rates);
    const amber = inviterRailFacts(editor, attention)[0];
    expect(amber.tone).toBe("attention");
    expect(amber.fact).toBe("1 field failing");
  });
});

describe("transport choice", () => {
  function transportRow<T extends { label: string }>(
    rows: ReadonlyArray<T>,
  ): T {
    const row = rows.find((entry) => entry.label === "Transport");
    if (row === undefined) throw new Error("no Transport row");
    return row;
  }

  test("defaults to browser and reflects in the ledger and answers", () => {
    const editor = editorFromCsv("Dana", csv);
    expect(editor.transport).toBeUndefined();
    expect(isCliTransport(editor.transport ?? "browser")).toBe(false);
    expect(transportRow(inviterLedgerRows(editor)).value).toBe("Browser");
    expect(transportRow(answersRows(editor, csv)).value).toBe(
      "Live, in this browser",
    );
  });

  test("choosing SFTP reflects the CLI transport in both surfaces", () => {
    const editor = editorWithTransport(editorFromCsv("Dana", csv), "sftp");
    expect(editor.transport).toBe("sftp");
    expect(isCliTransport("sftp")).toBe(true);
    expect(transportRow(inviterLedgerRows(editor)).value).toBe(
      "SFTP (command-line tool)",
    );
    expect(transportRow(answersRows(editor, csv)).value).toBe(
      "SFTP (command-line tool)",
    );
  });

  test("choosing a shared directory reflects the CLI transport", () => {
    const editor = editorWithTransport(editorFromCsv("Dana", csv), "filedrop");
    expect(editor.transport).toBe("filedrop");
    expect(isCliTransport("filedrop")).toBe(true);
    expect(transportRow(inviterLedgerRows(editor)).value).toBe(
      "Shared directory (command-line tool)",
    );
    expect(transportRow(answersRows(editor, csv)).value).toBe(
      "Shared directory (command-line tool)",
    );
  });

  test("a sealed session refuses the transport mutator", () => {
    const sealed = sealEditor(editorFromCsv("Dana", csv));
    expect(editorWithTransport(sealed, "sftp")).toBe(sealed);
  });
});

describe("transport chooser copy by deployment", () => {
  test("a hosted build offers to save the shared-directory exchange", () => {
    const copy = transportChooserCopy(false, false);
    expect(copy.filedropLabel).toBe(
      "Over a shared directory, run by the command-line tool",
    );
    expect(copy.filedropDescription).toContain("Saves an exchange file");
    expect(copy.capabilityNote).toBe(
      "This browser runs live exchanges only; SFTP and shared-directory exchanges run in the psilink command-line tool.",
    );
  });

  test("a console build offers to run the shared-directory exchange here", () => {
    const copy = transportChooserCopy(true, false);
    expect(copy.filedropLabel).toBe("Over a shared directory, run here");
    expect(copy.filedropDescription).toContain("Runs the exchange here");
    expect(copy.capabilityNote).toContain(
      "runs live and shared-directory exchanges here",
    );
  });

  test("SFTP stays a command-line save everywhere without provisioned remotes", () => {
    for (const consoleBuild of [false, true]) {
      const copy = transportChooserCopy(consoleBuild, false);
      expect(copy.sftpLabel).toBe(
        "Over SFTP, run by the psilink command-line tool",
      );
      expect(copy.sftpDescription).toContain("Saves an exchange file");
    }
    // The remotes flag means nothing off a console: no job API runs there.
    const hosted = transportChooserCopy(false, true);
    expect(hosted.sftpLabel).toBe(
      "Over SFTP, run by the psilink command-line tool",
    );
    expect(hosted.capabilityNote).toContain("live exchanges only");
  });

  test("a console build with provisioned remotes offers to run SFTP here", () => {
    const copy = transportChooserCopy(true, true);
    expect(copy.sftpLabel).toBe("Over SFTP, run here");
    expect(copy.sftpDescription).toContain(
      "SFTP server provisioned on this appliance",
    );
    expect(copy.capabilityNote).toBe(
      "This deployment runs live, shared-directory, and SFTP exchanges here.",
    );
    // The filedrop card is unchanged by the remotes flag.
    expect(copy.filedropLabel).toBe("Over a shared directory, run here");
  });
});

describe("after the exchange completes", () => {
  function outcomeRow(
    outcome: Parameters<typeof inviterLedgerRows>[2],
    label: string,
  ) {
    const rows = inviterLedgerRows(
      editorFromCsv("Dana", csv),
      "2026-07-08T19:32:00.000Z",
      outcome,
    );
    return rows.find((row) => row.label === label);
  }

  test("the ledger reports the invitation used and the matched count", () => {
    expect(outcomeRow({ matchedRecordCount: 1847 }, "Expires")?.value).toBe(
      "Invitation used",
    );
    expect(
      outcomeRow({ matchedRecordCount: 1847 }, "You will receive")?.value,
    ).toBe("1,847 matched rows + shared columns");
  });

  test("a withheld result states the caveat rather than a count", () => {
    expect(
      outcomeRow({ resultWithheld: true }, "You will receive")?.value,
    ).toBe("No result table - withheld by the agreed terms");
  });

  test("unsealing reopens the session with every input intact", () => {
    const authored = editorWithLegalAgreement(editorFromCsv("Dana", csv), {
      reference: "MOU-1",
      purpose: "Eval",
      expirationDate: "2099-12-31",
    });
    const sealed = sealEditor(authored);
    expect(editorWithLifetime(sealed, 86400)).toBe(sealed);

    const reopened = unsealEditor(sealed);
    expect(reopened.sealed).toBeUndefined();
    expect(reopened.draft).toBe(authored.draft);
    expect(editorWithLifetime(reopened, 86400).draft.lifetimeSeconds).toBe(
      86400,
    );

    expect(unsealEditor(authored)).toBe(authored);
  });
});

function mintedTerms(editor: ReturnType<typeof editorFromCsv>) {
  const validation = reviewValidation(editor);
  if (validation.terms === undefined)
    throw new Error("draft unexpectedly cannot mint");
  return validation.terms;
}

describe("customize tabs", () => {
  test("reordering keys changes key order in minted terms", () => {
    const editor = editorFromCsv("Dana", csv);
    const before = mintedTerms(editor).linkageKeys.map((key) => key.name);
    expect(before.length).toBeGreaterThan(1);

    const moved = editorWithKeyMoved(editor, 0, 1);
    const after = mintedTerms(moved).linkageKeys.map((key) => key.name);
    expect(after[0]).toBe(before[1]);
    expect(after[1]).toBe(before[0]);
    expect(after.slice(2)).toEqual(before.slice(2));
  });

  test("gated settings cannot alter minted terms", () => {
    const seeded = editorFromCsv("Dana", csv);
    const forced = editorWithDeduplicate(
      editorWithAlgorithm(seeded, "psi-c"),
      true,
    );
    expect(forced.draft.algorithm).toBe("psi-c");
    expect(forced.draft.deduplicate).toBe(true);
    const terms = mintedTerms(forced);
    expect(terms.algorithm).toBe("psi");
    expect(terms.deduplicate).toBe(false);
  });

  test("adding a same-typed field binds the free column uniquely", () => {
    const seeded = editorFromCsv("Dana", csv);
    // Retype the payload column to a second first_name, then bind it: the new
    // field takes the type's recommended pipeline under a unique name.
    const { editor: retypedOnly } = editorWithColumnType(
      seeded,
      csv,
      "program_code",
      "first_name",
    );
    // A retype preserves the sent disclosure, so the column must also be set
    // to match before it is a bindable linkage column.
    const { editor: retyped } = editorWithColumnDisclosure(
      retypedOnly,
      csv,
      "program_code",
      "match",
    );
    const added = editorWithFieldAdded(retyped, "first_name");
    const grown = added.draft.standardization.length;
    expect(grown).toBe(retyped.draft.standardization.length + 1);
    const appended = added.draft.standardization[grown - 1];
    expect(appended.input).toBe("program_code");
    expect(appended.output).toMatch(/_2$/);

    // No free column of the type: the draft is untouched.
    const noop = editorWithFieldAdded(seeded, "zip_code");
    expect(noop.draft).toBe(seeded.draft);
  });

  test("importing terms with an unsupplyable field degrades gracefully", () => {
    const donor = editorFromCsv("Dana", {
      ...csv,
      columns: ["ssn", "first_name", "last_name", "dob"],
      rawRows: [
        {
          ssn: "123456789",
          first_name: "Ann",
          last_name: "Lee",
          dob: "01/02/1990",
        },
      ],
    });
    const donorTerms = mintedTerms(donor);

    // The receiving file has ssn4, not ssn: every donor key referencing the
    // full-ssn field arrives disabled with its unsatisfiable badge, and the
    // satisfiable subset still mints.
    const editor = editorFromCsv("Dana", csv);
    const imported = editorWithImportedTerms(editor, csv, donorTerms);
    expect(imported.keysAuthored).toBe(true);
    const disabled = imported.draft.keys.filter((entry) => !entry.enabled);
    expect(disabled.length).toBeGreaterThan(0);
    const satisfiable = keySatisfiabilityFor(imported);
    expect(
      imported.draft.keys.some((_entry, index) => !satisfiable(index)),
    ).toBe(true);
    expect(reviewValidation(imported).canGenerate).toBe(true);
  });

  test("terms export/import round-trips the minted terms", () => {
    const editor = editorWithLegalAgreement(
      editorWithKeyMoved(editorFromCsv("Dana", csv), 0, 1),
      {
        reference: "MOU-1",
        purpose: "Eval",
        expirationDate: "2099-12-31",
      },
    );
    const exported = mintedTerms(editor);
    const reimported = editorWithImportedTerms(editor, csv, exported);
    expect(mintedTerms(reimported)).toEqual(exported);
  });

  test("column edits preserve authored keys", () => {
    const seeded = editorFromCsv("Dana", csv);
    const keyNames = (candidate: typeof seeded) =>
      candidate.draft.keys.map((entry) => entry.key.name);

    const { editor: reconciled } = editorWithColumnType(
      seeded,
      csv,
      "ssn4",
      "other",
    );
    expect(keyNames(reconciled).length).toBeLessThan(keyNames(seeded).length);

    const authored = editorWithAuthoredDraft(seeded, seeded.draft);
    const { editor: preserved } = editorWithColumnType(
      authored,
      csv,
      "ssn4",
      "other",
    );
    expect(keyNames(preserved)).toEqual(keyNames(seeded));
  });

  test("agreement fields flow into the minted terms and the ledger", () => {
    const editor = editorWithLegalAgreement(editorFromCsv("Dana", csv), {
      reference: "MOU-2025-0042",
      purpose: "Program evaluation",
      expirationDate: "2099-12-31",
    });
    const terms = mintedTerms(editor);
    expect(terms.legalAgreement?.reference).toBe("MOU-2025-0042");
    expect(inviterRailFacts(editor)[2].fact).toBe("MOU-2025-0042");
    expect(ledgerValue(editor, "Agreement").value).toBe("MOU-2025-0042");
  });

  test("sealed sessions refuse the tab mutators", () => {
    const donorTerms = mintedTerms(editorFromCsv("Dana", csv));
    const sealed = sealEditor(editorFromCsv("Dana", csv));
    expect(editorWithKeyMoved(sealed, 0, 1)).toBe(sealed);
    expect(editorWithKeyEnabled(sealed, 0, false)).toBe(sealed);
    expect(editorWithLinkageStrategy(sealed, "single-pass")).toBe(sealed);
    expect(
      editorWithLegalAgreement(sealed, {
        reference: "x",
        purpose: "y",
        expirationDate: "2099-01-01",
      }),
    ).toBe(sealed);
    expect(editorWithFieldSteps(sealed, "name", [])).toBe(sealed);
    expect(editorWithAuthoredDraft(sealed, sealed.draft)).toBe(sealed);
    expect(editorWithImportedTerms(sealed, csv, donorTerms)).toBe(sealed);
  });
});

describe("a column retype reconciles standardization even with authored keys", () => {
  // The reviewer's exact repro seed: retyping first_name -> last_name once expert
  // mode or an import has marked the key set author-controlled must still drop the
  // stale first_name cleaning, so no first_name-named field typed last_name reaches
  // the committed terms. Both name types share the name pipeline, so a step
  // comparison would miss the change -- reconcileStandardization judges the column
  // by its type across the edit.
  const retypeCsv: AcquiredCsv = {
    fileName: "seed.csv",
    sizeBytes: 1024,
    rawRows: [
      {
        first_name: "Ann",
        last_name: "Lee",
        dob: "01/02/1990",
        extra: "x",
      },
    ],
    columns: ["first_name", "last_name", "dob", "extra"],
  };

  function retypeFirstNameToLastName(editor: ReturnType<typeof editorFromCsv>) {
    return editorWithColumnType(editor, retypeCsv, "first_name", "last_name")
      .editor;
  }

  test("expert mode (editorWithAuthoredDraft) mints no mismatched field", () => {
    const seeded = editorFromCsv("Org", retypeCsv);
    // Enter expert mode: the current draft becomes author-controlled, so the
    // template key reconciliation stops running -- but the standardization must
    // still reconcile on a retype.
    const authored = editorWithAuthoredDraft(seeded, seeded.draft);
    const retyped = retypeFirstNameToLastName(authored);

    // The stale first_name-named transformation on the retyped column is gone.
    expect(
      retyped.draft.standardization.some(
        (t) => t.output === "first_name" && t.input === "first_name",
      ),
    ).toBe(false);

    // No name/type-mismatched field reaches buildAdvancedTerms, and no
    // first_name-named field survives at all (last_name is already covered).
    const terms = buildAdvancedTerms(retyped.draft);
    expect(
      terms.linkageFields.some(
        (f) => f.name === "first_name" && f.type === "last_name",
      ),
    ).toBe(false);
    expect(terms.linkageFields.some((f) => f.name === "first_name")).toBe(
      false,
    );

    // The re-derived last_name cleaning is present and the retyped column no longer
    // carries a stale first_name binding: every remaining transformation resolves to
    // a field typed to match its column.
    const fields = authoredLinkageFields(
      retyped.draft.metadata,
      retyped.draft.standardization,
    );
    expect(fields.some((f) => f.type === "last_name")).toBe(true);
    expect(fields.some((f) => f.type === "first_name")).toBe(false);
  });

  test("imported-draft path (editorWithImportedTerms) mints no mismatched field", () => {
    // Import a valid terms document so keysAuthored is set via the import path,
    // then retype through editorWithColumnType.
    const donor = editorFromCsv("Org", retypeCsv);
    const donorTerms = buildAdvancedTerms(donor.draft);
    const imported = editorWithImportedTerms(donor, retypeCsv, donorTerms);
    expect(imported.keysAuthored).toBe(true);

    const retyped = retypeFirstNameToLastName(imported);

    expect(
      retyped.draft.standardization.some(
        (t) => t.output === "first_name" && t.input === "first_name",
      ),
    ).toBe(false);
    const terms = buildAdvancedTerms(retyped.draft);
    expect(
      terms.linkageFields.some(
        (f) => f.name === "first_name" && f.type === "last_name",
      ),
    ).toBe(false);
  });

  test("authored keys survive the retype untouched", () => {
    // The keysAuthored protection is not weakened: reconciling the standardization
    // must not touch the author-controlled key set. The seeded keys carry a
    // first_name element; author them, retype, and confirm the key NAMES and order
    // are byte-identical (reconcileKeys, which would drop the now-unofferable
    // first_name key, must stay off the authored set).
    const seeded = editorFromCsv("Org", retypeCsv);
    const keyNames = (candidate: ReturnType<typeof editorFromCsv>) =>
      candidate.draft.keys.map((entry) => entry.key.name);
    const authored = editorWithAuthoredDraft(seeded, seeded.draft);

    const retyped = retypeFirstNameToLastName(authored);
    expect(keyNames(retyped)).toEqual(keyNames(seeded));
    expect(retyped.keysAuthored).toBe(true);

    // The guided path, by contrast, DOES reconcile the keys away, so the two paths
    // are demonstrably distinct.
    const guided = retypeFirstNameToLastName(seeded);
    expect(keyNames(guided)).not.toEqual(keyNames(seeded));
  });
});
