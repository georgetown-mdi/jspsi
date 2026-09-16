import { describe, expect, test } from "vitest";

import { disclosedColumnNames } from "@psilink/core";

import {
  editorFromCsv,
  editorWithColumnDisclosure,
  editorWithIncludeOwnColumns,
  editorWithTransport,
} from "@psi/inviterEditor";
import { reviewValidation } from "@psi/inviterModel";

import { RUN_DIAGNOSTICS_DEFAULT } from "@psi/runDiagnosticsModel";

import {
  INVITER_SCREEN_INITIAL,
  inviterScreenReducer,
  unmatchableFileAlert,
} from "@exchange/inviterScreenModel";

import type {
  InviterScreenAction,
  InviterScreenState,
} from "@exchange/inviterScreenModel";
import type { AcquiredCsv } from "@psi/inviterEditor";
import type { AlertContent } from "@components/csvIntake";
import type { GeneratedInvitation } from "@psi/invitation";
import type { ProfiledJobInput } from "@psi/jobClient/workInputClient";

// Headers chosen from inferMetadata's exact-match alias table, as the inviter
// model's own fixture is: four linkage types, one identifier, and one
// unrecognized column, which infers to a sent payload column.
const csv: AcquiredCsv = {
  fileName: "clients.csv",
  sizeBytes: 4096,
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
  rowCount: 1,
};

const ALERT: AlertContent = { title: "Refused", message: "Pick another file." };
const NOTICE: AlertContent = { title: "Changed", message: "A header moved." };

/** The state a file read has settled into: the file, its draft terms, and the
 * step the operator continues from -- the state every mint transition starts on. */
function withFile(
  name = "Dana Okafor",
  ...actions: Array<InviterScreenAction>
): InviterScreenState {
  const start = inviterScreenReducer(INVITER_SCREEN_INITIAL, {
    type: "file-acquired",
    acquired: csv,
    file: new File(["client_id\n1\n"], csv.fileName, { type: "text/csv" }),
    editor: editorFromCsv(name, csv),
  });
  return actions.reduce(inviterScreenReducer, start);
}

/** A minted invitation, composed from the draft's own validated terms so the
 * fixture declares what the file supports. No secret-shaped value: the reducer
 * holds the mint's result without reading into it. */
function mintedFrom(state: InviterScreenState): GeneratedInvitation {
  if (state.editor === undefined) throw new Error("the fixture read no file");
  const terms = reviewValidation(state.editor).terms;
  if (terms === undefined) throw new Error("the fixture draft has no terms");
  return {
    encoded: "encoded-invitation-placeholder",
    deepLink: "https://example.test/accept#encoded-invitation-placeholder",
    sharedSecret: "not-a-real-secret",
    expires: "2026-01-02T03:04:05.000Z",
    linkageTerms: terms,
    rawRows: csv.rawRows,
    columns: csv.columns,
    disclosedPayloadColumns: ["program_code"],
  };
}

describe("the step the work column shows", () => {
  test("a spine step becomes the step a Customize tab returns to", () => {
    const state = inviterScreenReducer(INVITER_SCREEN_INITIAL, {
      type: "section-shown",
      section: "review",
    });
    expect(state.section).toBe("review");
    expect(state.lastSpineStep).toBe("review");
  });

  test("a Customize tab leaves the spine step it was opened from", () => {
    const state = withFile(
      "Dana Okafor",
      { type: "section-shown", section: "columns" },
      {
        type: "section-shown",
        section: "cleaning",
      },
    );
    expect(state.section).toBe("cleaning");
    expect(state.lastSpineStep).toBe("columns");
  });
});

describe("what the terms declare", () => {
  test("a name edit carries the draft's identity with it", () => {
    const state = withFile("Dana Okafor", {
      type: "name-changed",
      name: "Sam Rivera",
    });
    expect(state.name).toBe("Sam Rivera");
    expect(state.editor?.draft.identity).toBe("Sam Rivera");
  });

  test("a name edit before any file moves the field alone", () => {
    const state = inviterScreenReducer(INVITER_SCREEN_INITIAL, {
      type: "name-changed",
      name: "Sam Rivera",
    });
    expect(state.name).toBe("Sam Rivera");
    expect(state.editor).toBeUndefined();
  });

  test("a column's disclosure choice lands on the draft and announces", () => {
    const seeded = withFile();
    if (seeded.editor === undefined || seeded.acquired === undefined)
      throw new Error("the fixture read no file");
    expect(disclosedColumnNames(seeded.editor.draft.metadata)).toContain(
      "program_code",
    );
    const edited = editorWithColumnDisclosure(
      seeded.editor,
      seeded.acquired,
      "program_code",
      "ignored",
    );
    const state = inviterScreenReducer(seeded, {
      type: "column-edited",
      editor: edited.editor,
      announcement: "Demoted client_id.",
    });
    expect(state.editor).toBe(edited.editor);
    expect(
      disclosedColumnNames(state.editor?.draft.metadata ?? []),
    ).not.toContain("program_code");
    expect(state.announcement).toBe("Demoted client_id.");
  });

  test("an own-columns choice lands through the plain editor edit", () => {
    const seeded = withFile();
    if (seeded.editor === undefined)
      throw new Error("the fixture read no file");
    const state = inviterScreenReducer(seeded, {
      type: "editor-applied",
      editor: editorWithIncludeOwnColumns(seeded.editor, "all"),
    });
    expect(state.editor?.draft.includeOwnColumns).toBe("all");
    expect(state.editorAnnouncement).toBe("");
  });

  test("an announcing edit states what it changed", () => {
    const seeded = withFile();
    if (seeded.editor === undefined)
      throw new Error("the fixture read no file");
    const state = inviterScreenReducer(seeded, {
      type: "editor-replaced",
      editor: seeded.editor,
      announcement: "Reset to the default settings.",
    });
    expect(state.editorAnnouncement).toBe("Reset to the default settings.");
  });

  test("a transport choice re-asks the sweep confirmation", () => {
    const confirmed = withFile("Dana Okafor", {
      type: "run-diagnostics-chosen",
      draft: { ...RUN_DIAGNOSTICS_DEFAULT, sweepConfirmed: true },
    });
    if (confirmed.editor === undefined)
      throw new Error("the fixture read no file");
    const state = inviterScreenReducer(confirmed, {
      type: "transport-chosen",
      editor: editorWithTransport(confirmed.editor, "filedrop"),
    });
    expect(state.editor?.transport).toBe("filedrop");
    expect(state.runDiagnostics.sweepConfirmed).toBe(false);
  });
});

describe("whether the mint may proceed", () => {
  test("a settled read holds the file the mint binds to", () => {
    const state = withFile();
    expect(state.acquired).toBe(csv);
    expect(state.sourceFile?.name).toBe(csv.fileName);
    expect(state.editor?.draft.keys.length).toBeGreaterThan(0);
    expect(state.savedExchange).toBeUndefined();
  });

  test("a refused read drops the file, the draft, and the sample marker", () => {
    const state = withFile("Dana Okafor", {
      type: "read-discarded",
      alert: ALERT,
      notice: NOTICE,
    });
    expect(state.acquired).toBeUndefined();
    expect(state.consoleSource).toBeUndefined();
    expect(state.sourceFile).toBeUndefined();
    expect(state.sourceHandle).toBeUndefined();
    expect(state.editor).toBeUndefined();
    expect(state.demoActive).toBe(false);
    expect(state.intakeAlert).toBe(ALERT);
    expect(state.sanitizedNotice).toBe(NOTICE);
  });

  test("a sample seed names the party and marks the sample", () => {
    const state = inviterScreenReducer(INVITER_SCREEN_INITIAL, {
      type: "read-started",
      seedName: "Sample County Health Dept",
    });
    expect(state.name).toBe("Sample County Health Dept");
    expect(state.demoActive).toBe(true);
    expect(state.reading).toBe(true);
  });

  test("a real read clears the sample marker and the file step's alerts", () => {
    const seeded = withFile("Sample County Health Dept", {
      type: "read-started",
      seedName: "Sample County Health Dept",
    });
    const state = inviterScreenReducer(seeded, { type: "read-started" });
    expect(state.demoActive).toBe(false);
    expect(state.name).toBe("Sample County Health Dept");
    expect(state.intakeAlert).toBeUndefined();
    expect(state.sanitizedNotice).toBeUndefined();
  });

  test("clearing the sample leaves nothing of the exchange behind", () => {
    const minted = withFile();
    if (minted.editor === undefined)
      throw new Error("the fixture read no file");
    const shared = inviterScreenReducer(minted, {
      type: "invitation-minted",
      editor: minted.editor,
      invitation: mintedFrom(minted),
    });
    const state = inviterScreenReducer(shared, { type: "sample-cleared" });
    expect(state.name).toBe("");
    expect(state.acquired).toBeUndefined();
    expect(state.editor).toBeUndefined();
    expect(state.invitation).toBeUndefined();
    expect(state.acceptKitExchange).toBeUndefined();
    expect(state.manageOffer.status).toBe("idle");
    expect(state.reading).toBe(false);
  });

  test("a mint seals the terms beside the invitation it minted", () => {
    const seeded = withFile();
    if (seeded.editor === undefined)
      throw new Error("the fixture read no file");
    const invitation = mintedFrom(seeded);
    const state = inviterScreenReducer(seeded, {
      type: "invitation-minted",
      editor: seeded.editor,
      invitation,
      acceptKitExchange: {
        endpoint: { channel: "filedrop", path: "psilink" },
        retainFiles: false,
        locklessRendezvous: false,
      },
    });
    expect(state.invitation).toBe(invitation);
    expect(state.editor?.sealed).toBe(true);
    expect(state.acceptKitExchange?.retainFiles).toBe(false);
    expect(state.manageOffer.status).toBe("idle");
  });

  test("an edit during the mint does not reach the sealed terms", () => {
    const seeded = withFile();
    if (seeded.editor === undefined)
      throw new Error("the fixture read no file");
    const bound = seeded.editor;
    const edited = inviterScreenReducer(seeded, {
      type: "editor-applied",
      editor: editorWithIncludeOwnColumns(bound, "all"),
    });
    const state = inviterScreenReducer(edited, {
      type: "invitation-minted",
      editor: bound,
      invitation: mintedFrom(seeded),
    });
    expect(state.editor?.sealed).toBe(true);
    expect(state.editor?.draft.includeOwnColumns).toBe(
      bound.draft.includeOwnColumns,
    );
  });

  test("a save-file route seals the terms and mints nothing", () => {
    const seeded = withFile("Dana Okafor", {
      type: "save-failed",
      alert: ALERT,
    });
    if (seeded.editor === undefined)
      throw new Error("the fixture read no file");
    const state = inviterScreenReducer(seeded, {
      type: "save-routed",
      editor: seeded.editor,
    });
    expect(state.editor?.sealed).toBe(true);
    expect(state.invitation).toBeUndefined();
    expect(state.savedExchange).toBeUndefined();
    expect(state.saveAlert).toBeUndefined();
  });

  test("starting over reopens the terms and discards what was minted", () => {
    const seeded = withFile();
    if (seeded.editor === undefined)
      throw new Error("the fixture read no file");
    const shared = inviterScreenReducer(seeded, {
      type: "invitation-minted",
      editor: seeded.editor,
      invitation: mintedFrom(seeded),
      acceptKitExchange: {
        endpoint: { channel: "filedrop", path: "psilink" },
        retainFiles: true,
        locklessRendezvous: false,
      },
    });
    const state = inviterScreenReducer(shared, { type: "started-over" });
    expect(state.editor?.sealed).toBeUndefined();
    expect(state.invitation).toBeUndefined();
    expect(state.acceptKitExchange).toBeUndefined();
    expect(state.savedExchange).toBeUndefined();
    expect(state.manageOffer.status).toBe("idle");
  });

  test("a mint in flight clears the refusal the last one left", () => {
    const refused = withFile("Dana Okafor", {
      type: "mint-failed",
      alert: ALERT,
    });
    expect(refused.createAlert).toBe(ALERT);
    const minting = inviterScreenReducer(refused, { type: "mint-started" });
    expect(minting.minting).toBe(true);
    expect(minting.createAlert).toBeUndefined();
    expect(
      inviterScreenReducer(minting, { type: "mint-finished" }).minting,
    ).toBe(false);
  });
});

describe("the console's mounted-file commit", () => {
  const PROFILE: ProfiledJobInput = {
    name: csv.fileName,
    sizeBytes: csv.sizeBytes,
    modifiedAt: 1_700_000_000_000,
    rowCount: csv.rowCount,
    columns: csv.columns,
    sanitizedColumnPositions: [],
    columnSamples: new Map(),
  };

  test("two consecutive refusals do not share an alert reference", () => {
    expect(unmatchableFileAlert()).not.toBe(unmatchableFileAlert());
    const first = inviterScreenReducer(INVITER_SCREEN_INITIAL, {
      type: "console-file-seeded",
      source: PROFILE,
      acquired: csv,
      editor: editorFromCsv("Dana Okafor", csv),
      alert: unmatchableFileAlert(),
    });
    const second = inviterScreenReducer(first, {
      type: "console-file-seeded",
      source: PROFILE,
      acquired: csv,
      editor: editorFromCsv("Dana Okafor", csv),
      alert: unmatchableFileAlert(),
    });
    expect(first.intakeAlert).toEqual(second.intakeAlert);
    expect(first.intakeAlert).not.toBe(second.intakeAlert);
  });
});

describe("the console's own rendezvous", () => {
  test("an authored connection drops the save-a-file preference", () => {
    const preferred = inviterScreenReducer(INVITER_SCREEN_INITIAL, {
      type: "sftp-save-file-preferred",
      preferred: true,
    });
    const state = inviterScreenReducer(preferred, {
      type: "sftp-connection-authored",
      connection: { host: "sftp.example.test", path: "/exchange" },
    });
    expect(state.sftpInfo?.connection).toEqual({
      host: "sftp.example.test",
      path: "/exchange",
    });
    expect(state.sftpSaveFilePreferred).toBe(false);
    expect(state.runDiagnostics.sweepConfirmed).toBe(false);
  });

  test("clearing the connection reports none rather than an unresolved fetch", () => {
    const state = inviterScreenReducer(INVITER_SCREEN_INITIAL, {
      type: "sftp-connection-cleared",
    });
    expect(state.sftpInfo).toEqual({ connection: null });
  });
});

describe("the managed-exchange offer", () => {
  test("a failed deposit holds the refusal beside the error", () => {
    const depositing = inviterScreenReducer(INVITER_SCREEN_INITIAL, {
      type: "manage-offer-started",
    });
    expect(depositing.manageOffer.status).toBe("depositing");
    const state = inviterScreenReducer(depositing, {
      type: "manage-offer-failed",
      refusal: ALERT,
    });
    expect(state.manageOffer).toEqual({ status: "error", refusal: ALERT });
  });

  test("a failure no column explains leaves the generic copy standing", () => {
    const state = inviterScreenReducer(INVITER_SCREEN_INITIAL, {
      type: "manage-offer-failed",
    });
    expect(state.manageOffer).toEqual({ status: "error" });
  });
});
