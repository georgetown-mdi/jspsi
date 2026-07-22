import { describe, expect, test } from "vitest";

import { getDefaultLinkageTerms, inferMetadata } from "@psilink/core";

import { disclosedColumnNames } from "@psi/metadataEditing";

import {
  DEFAULT_PREVIEW_IDENTITY,
  DIRECT_STEP_ORDER,
  previewInferredTerms,
} from "@bench/directExchangeModel";

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
    const preview = previewInferredTerms(LINKABLE_COLUMNS, "County Health");
    const core = getDefaultLinkageTerms(
      "County Health",
      inferMetadata(LINKABLE_COLUMNS),
    );

    expect(preview.linkageTerms.linkageKeys).toEqual(core.linkageKeys);
    expect(preview.linkageTerms.linkageFields).toEqual(core.linkageFields);
    expect(preview.linkageTerms.identity).toBe("County Health");
    expect(preview.satisfiableKeyCount).toBeGreaterThan(0);
  });

  test("disclosed columns match core's disclosure predicate and back the display send", () => {
    const preview = previewInferredTerms(
      LINKABLE_COLUMNS,
      DEFAULT_PREVIEW_IDENTITY,
    );
    const disclosed = disclosedColumnNames(inferMetadata(LINKABLE_COLUMNS));

    expect(preview.disclosedPayloadColumns).toEqual(disclosed);
    // An unrecognized column is inferred as disclosed payload, so it leaves the
    // machine and must show in the preview.
    expect(preview.disclosedPayloadColumns).toContain("program_code");
    // payload.send is authored from the disclosed set so the terms panel's "columns
    // sent" display is honest rather than empty (the default terms carry no payload).
    expect(
      preview.linkageTerms.payload?.send?.map((entry) => entry.name),
    ).toEqual(preview.disclosedPayloadColumns);
  });

  test("a file with no matchable columns is unlinkable and names the missing fields", () => {
    const preview = previewInferredTerms(["notes", "comment"], "x");
    expect(preview.satisfiableKeyCount).toBe(0);
    expect(preview.unsatisfied.length).toBeGreaterThan(0);
  });

  test("the spine walks file -> server -> confirm -> run", () => {
    expect(DIRECT_STEP_ORDER).toEqual(["file", "server", "confirm", "run"]);
  });
});
