import { describe, expect, test } from "vitest";

import {
  MAX_NAME_LENGTH,
  decideLinkageTermsVerdict,
  getDefaultLinkageTerms,
  inferMetadata,
} from "@psilink/core";

import { disclosedColumnNames } from "@psi/metadataEditing";

import {
  CONNECTION_TUNING_DEFAULT,
  connectionTuningProblems,
} from "@bench/connectionTuningModel";
import {
  DEFAULT_PREVIEW_IDENTITY,
  DIRECT_LINKAGE_STRATEGY_DEFAULT,
  DIRECT_STEP_ORDER,
  directLinkageStrategyIntentFields,
  directServerBlockedReason,
  previewInferredTerms,
} from "@bench/directExchangeModel";
import {
  EXCHANGE_FILES_DEFAULT,
  ZERO_SETUP_EXCHANGE_FILES,
  exchangeFilesProblems,
} from "@bench/exchangeFilesModel";

import type { DirectServerGates } from "@bench/directExchangeModel";

const LINKABLE_COLUMNS = [
  "ssn",
  "first_name",
  "last_name",
  "date_of_birth",
  "program_code",
];

describe("previewInferredTerms", () => {
  test("linkage keys and fields match core inference for the same columns", () => {
    // The preview must be exactly what the CLI infers from the same columns
    // (prepareForExchange with no spec: inferMetadata then getDefaultLinkageTerms),
    // or the operator would confirm terms the run does not honor.
    const preview = previewInferredTerms(
      LINKABLE_COLUMNS,
      "County Health",
      DIRECT_LINKAGE_STRATEGY_DEFAULT,
    );
    const core = getDefaultLinkageTerms(
      "County Health",
      inferMetadata(LINKABLE_COLUMNS),
    );

    expect(preview.linkageTerms.linkageKeys).toEqual(core.linkageKeys);
    expect(preview.linkageTerms.linkageFields).toEqual(core.linkageFields);
    expect(preview.linkageTerms.identity).toBe("County Health");
    expect(preview.refusal).toBeUndefined();
  });

  test("disclosed columns match core's disclosure predicate and back the display send", () => {
    const preview = previewInferredTerms(
      LINKABLE_COLUMNS,
      DEFAULT_PREVIEW_IDENTITY,
      DIRECT_LINKAGE_STRATEGY_DEFAULT,
    );
    const disclosed = disclosedColumnNames(inferMetadata(LINKABLE_COLUMNS));

    expect(preview.disclosedPayloadColumns).toEqual(disclosed);
    // An unrecognized column is inferred as disclosed payload, so it leaves the
    // machine and must show in the preview.
    expect(preview.disclosedPayloadColumns).toContain("program_code");
    // payload.send is authored from the disclosed set so the terms panel's "columns
    // sent" display is accurate rather than empty (the default terms hold no payload).
    expect(
      preview.linkageTerms.payload?.send?.map((entry) => entry.name),
    ).toEqual(preview.disclosedPayloadColumns);
  });

  test("a sent column name past the ceiling is reported so the confirm screen can refuse the run", () => {
    // This spine has no disclosure control -- every non-linkage column is inferred
    // as sent -- so an oversized header would reach prepareForExchange on the
    // console and be refused there, after the operator pressed Run.
    const past = "a".repeat(MAX_NAME_LENGTH + 1);
    const preview = previewInferredTerms(
      [...LINKABLE_COLUMNS, past],
      "x",
      DIRECT_LINKAGE_STRATEGY_DEFAULT,
    );
    expect(preview.overlongDisclosedColumns).toEqual([6]);
    expect(preview.disclosedPayloadColumns).toContain(past);
  });

  test("a sent column name at the ceiling is valid and leaves the run gate open", () => {
    const atCeiling = "a".repeat(MAX_NAME_LENGTH);
    const preview = previewInferredTerms(
      [...LINKABLE_COLUMNS, atCeiling],
      "x",
      DIRECT_LINKAGE_STRATEGY_DEFAULT,
    );
    expect(preview.disclosedPayloadColumns).toContain(atCeiling);
    expect(preview.overlongDisclosedColumns).toEqual([]);
  });

  test("the ceiling counts UTF-16 code units, as the wire and record bounds do", () => {
    // MAX_NAME_LENGTH astral characters: under the ceiling on a code-point count,
    // over it on the count every such bound uses.
    const astral = "\u{1D54F}".repeat(MAX_NAME_LENGTH);
    expect([...astral].length).toBe(MAX_NAME_LENGTH);
    const preview = previewInferredTerms(
      [...LINKABLE_COLUMNS, astral],
      "x",
      DIRECT_LINKAGE_STRATEGY_DEFAULT,
    );
    expect(preview.overlongDisclosedColumns).toEqual([6]);
  });

  test("a file with no matchable columns is unlinkable and names the missing fields", () => {
    // The inference narrows the built-in key set to the keys these columns
    // support, which is none -- so the terms the run would be held to declare no
    // key at all, and the missing field types come from the unnarrowed set.
    const preview = previewInferredTerms(
      ["notes", "comment"],
      "x",
      DIRECT_LINKAGE_STRATEGY_DEFAULT,
    );
    expect(preview.linkageTerms.linkageKeys).toEqual([]);
    expect(preview.refusal?.kind).toBe("no-linkable-key");
    if (preview.refusal?.kind !== "no-linkable-key")
      throw new Error("expected a no-linkable-key refusal");
    expect(preview.refusal.missingFields.length).toBeGreaterThan(0);
  });

  test("the refusal grades the previewed terms, not the unnarrowed default set", () => {
    // A file holding only some of the built-in set's field types satisfies the
    // NARROWED terms it would actually run under, so it is not refused -- grading
    // the full set instead would refuse nearly every real file.
    const preview = previewInferredTerms(
      ["first_name", "last_name", "date_of_birth"],
      "x",
      DIRECT_LINKAGE_STRATEGY_DEFAULT,
    );
    expect(preview.refusal).toBeUndefined();
    expect(
      decideLinkageTermsVerdict(
        ["first_name", "last_name", "date_of_birth"],
        preview.linkageTerms,
        undefined,
        preview.metadata,
      ).fullySatisfied,
    ).toBe(true);
    // The unnarrowed set declares fields this file cannot produce, so a seat
    // grading it would have blocked.
    expect(
      decideLinkageTermsVerdict(
        ["first_name", "last_name", "date_of_birth"],
        getDefaultLinkageTerms("x"),
      ).fullySatisfied,
    ).toBe(false);
  });

  test("the spine walks file -> server -> confirm -> run", () => {
    expect(DIRECT_STEP_ORDER).toEqual(["file", "server", "confirm", "run"]);
  });
});

describe("the direct-exchange linkage strategy", () => {
  test("the preview has the selected strategy, not the inferred default", () => {
    // The CLI's zero-setup command applies --linkage-strategy over the terms it
    // inferred, so a preview left on the default would show terms the run does
    // not use -- and would withhold the single-pass disclosure the terms panel
    // raises off this very field.
    expect(
      previewInferredTerms(LINKABLE_COLUMNS, "x", "single-pass").linkageTerms
        .linkageStrategy,
    ).toBe("single-pass");
    expect(
      previewInferredTerms(LINKABLE_COLUMNS, "x", "cascade").linkageTerms
        .linkageStrategy,
    ).toBe("cascade");
  });

  test("the strategy does not disturb the inferred keys, fields, or disclosed set", () => {
    const cascade = previewInferredTerms(LINKABLE_COLUMNS, "x", "cascade");
    const singlePass = previewInferredTerms(
      LINKABLE_COLUMNS,
      "x",
      "single-pass",
    );
    expect(singlePass.linkageTerms.linkageKeys).toEqual(
      cascade.linkageTerms.linkageKeys,
    );
    expect(singlePass.linkageTerms.linkageFields).toEqual(
      cascade.linkageTerms.linkageFields,
    );
    expect(singlePass.disclosedPayloadColumns).toEqual(
      cascade.disclosedPayloadColumns,
    );
  });

  test("only a non-default choice reaches the intent", () => {
    // A zero-setup run loads no configuration for a flag to override, so
    // --linkage-strategy=cascade and no flag select the same strategy; emitting
    // it would lengthen the graduated command line without changing the run.
    expect(
      directLinkageStrategyIntentFields(DIRECT_LINKAGE_STRATEGY_DEFAULT),
    ).toEqual({});
    expect(directLinkageStrategyIntentFields("single-pass")).toEqual({
      linkageStrategy: "single-pass",
    });
  });
});

describe("the agreed-server step's continue gate", () => {
  const gates = (
    overrides: Partial<DirectServerGates> = {},
  ): DirectServerGates => ({
    transport: "sftp",
    transportReady: true,
    exchangeFilesBlocked: false,
    connectionTuningBlocked: false,
    runDiagnosticsBlocked: false,
    splitDirectoryBlocked: false,
    ...overrides,
  });

  test("a step with nothing outstanding names nothing, which is what enables Continue", () => {
    expect(directServerBlockedReason(gates())).toBeUndefined();
  });

  test("an unauthored transport is named first, ahead of the cards below it", () => {
    expect(
      directServerBlockedReason(
        gates({ transportReady: false, exchangeFilesBlocked: true }),
      ),
    ).toBe("Set up the SFTP connection above to continue.");
    expect(
      directServerBlockedReason(
        gates({ transport: "filedrop", transportReady: false }),
      ),
    ).toContain("shared directory");
  });

  test("a refused connection-tuning value names that card rather than the file-handling one", () => {
    // Both cards are collapsed disclosures on this step, so the sentence beside
    // the button is the only cue naming the one to open. Driven through both
    // cards' models as the step drives them, rather than by setting the flags.
    const step = gates({
      exchangeFilesBlocked:
        exchangeFilesProblems(EXCHANGE_FILES_DEFAULT, ZERO_SETUP_EXCHANGE_FILES)
          .length > 0,
      connectionTuningBlocked:
        connectionTuningProblems({
          ...CONNECTION_TUNING_DEFAULT,
          peerTimeout: { magnitude: "soon", unit: "m" },
        }).length > 0,
    });
    expect(step.exchangeFilesBlocked).toBe(false);
    expect(step.connectionTuningBlocked).toBe(true);
    expect(directServerBlockedReason(step)).toBe(
      "Resolve the connection-tuning settings above to continue.",
    );
  });

  test("a refused file-handling combination names its own card", () => {
    expect(
      directServerBlockedReason(gates({ exchangeFilesBlocked: true })),
    ).toBe("Resolve the file-handling settings above to continue.");
  });

  test("the split-directory precondition is named last, where its own alert stands", () => {
    // The remedy in full is in that alert; the sentence beside the button points
    // at it rather than restating a paragraph the operator is already looking at.
    expect(
      directServerBlockedReason(gates({ splitDirectoryBlocked: true })),
    ).toBe("Resolve the retain-mode requirement above to continue.");
  });
});
