import { describe, expect, test } from "vitest";

import {
  answersRows,
  editorFromCsv,
  editorWithAuthoredDraft,
  editorWithColumnDisclosure,
  editorWithColumnType,
  editorWithFieldSteps,
  editorWithIdentity,
  editorWithImportedTerms,
  editorWithKeyEnabled,
  editorWithKeyMoved,
  editorWithLegalAgreement,
  editorWithLifetime,
  editorWithLinkageStrategy,
  editorWithOutputDirection,
  enabledKeys,
  fileCardMeta,
  identifierProblem,
  inviterLedgerRows,
  inviterRailFacts,
  keySatisfiabilityFor,
  lifetimeLabel,
  resetToRecommended,
  reviewValidation,
  sealEditor,
  spineProblems,
} from "@bench/inviterModel";

import type { AcquiredCsv } from "@bench/inviterModel";

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
    const forced = editorWithAuthoredDraft(seeded, {
      ...seeded.draft,
      algorithm: "psi-c",
      deduplicate: true,
    });
    const terms = mintedTerms(forced);
    expect(terms.algorithm).toBe("psi");
    expect(terms.deduplicate).toBe(false);
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
