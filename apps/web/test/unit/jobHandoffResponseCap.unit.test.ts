import { describe, expect, test } from "vitest";

import { MAX_NAME_LENGTH, MAX_TEXT_LENGTH } from "@psilink/core";

import {
  MAX_EXPECTED_PAYLOAD_COLUMNS,
  MAX_METADATA_COLUMNS,
  MAX_METADATA_DESCRIPTION_LENGTH,
  MAX_STANDARDIZATION_STEPS,
  MAX_STANDARDIZATION_TRANSFORMATIONS,
} from "@jobs/intent";
import { MAX_JOB_HANDOFF_RESPONSE_BYTES } from "@psi/jobClient/jobApiBody";
import { buildJobHandoff } from "@jobs/handoff";
import { fetchRecurringHandoff } from "@psi/managed/recurringHandoff";
import { jobJsonResponse } from "@jobs/gate";

import { testSftpServerEntry, validSftpIntent } from "../utils/jobFixtures";

import type { Metadata, Standardization } from "@psilink/core";

// The hand-off cap against the intent schema that decides what it must hold. The
// template recomposes the create intent's own blocks, so a create the boundary
// accepts at its schema maxima must still reach the browser: an operator who
// authored a job the console ran must not lose its recurring-run template to a
// cap sized under the schema.

/** The per-entry allowance in the derivation: the YAML keys, indentation, and
 * line folding around one entry's own bounded fields, plus the JSON string
 * escaping the template rides to the browser in. */
const ENTRY_OVERHEAD_BYTES = 128;

/**
 * Steps per transformation in the widest template below. The schema's own step
 * cap is not what decides this: core's compose walks the whole spec under a node
 * budget that bites first, refusing a wider steps block outright (the last case
 * pins that), so the widest template a hand-off can carry is one whose steps
 * that walk admits.
 */
const ADMITTED_STEPS_PER_TRANSFORMATION = 16;

function paddedName(prefix: string, index: number): string {
  const head = `${prefix}${index}_`;
  return head + "x".repeat(MAX_NAME_LENGTH - head.length);
}

/** Metadata at the boundary's maxima: every column name and description at its
 * cap, and as many columns as the schema admits. */
function maxMetadata(): Metadata {
  return Array.from({ length: MAX_METADATA_COLUMNS }, (_unused, index) => ({
    name: paddedName("column", index),
    type: "other" as const,
    role: "identifier" as const,
    isPayload: true,
    description: "d".repeat(MAX_METADATA_DESCRIPTION_LENGTH),
  }));
}

/** Standardization at the boundary's transformation maximum, every output and
 * input at its length cap, each carrying `steps` steps. */
function maxStandardization(steps: number): Standardization {
  return Array.from(
    { length: MAX_STANDARDIZATION_TRANSFORMATIONS },
    (_unused, index) => ({
      output: paddedName("output", index),
      input: paddedName("input", index),
      steps: Array.from({ length: steps }, () => ({ function: "lowercase" })),
    }),
  );
}

/** An sftp exchange intent at every schema maximum the template carries, with
 * `steps` steps on each transformation. */
function widestIntent(steps: number) {
  return validSftpIntent({
    metadata: maxMetadata(),
    standardization: maxStandardization(steps),
    expectedPayloadColumns: Array.from(
      { length: MAX_EXPECTED_PAYLOAD_COLUMNS },
      (_unused, index) => paddedName("received", index),
    ),
    retentionDisposition: "r".repeat(MAX_TEXT_LENGTH),
  });
}

describe("the hand-off cap covers the create intent's schema maxima", () => {
  test("the cap exceeds the sum the intent schema's own caps decide", () => {
    const derived =
      MAX_METADATA_COLUMNS *
        (MAX_NAME_LENGTH +
          MAX_METADATA_DESCRIPTION_LENGTH +
          ENTRY_OVERHEAD_BYTES) +
      MAX_EXPECTED_PAYLOAD_COLUMNS * (MAX_NAME_LENGTH + ENTRY_OVERHEAD_BYTES) +
      MAX_STANDARDIZATION_TRANSFORMATIONS *
        (2 * MAX_NAME_LENGTH + ENTRY_OVERHEAD_BYTES);
    expect(MAX_JOB_HANDOFF_RESPONSE_BYTES).toBeGreaterThan(derived);
  });

  test("the widest template the compose admits reaches the client under the cap", async () => {
    const handoff = buildJobHandoff(
      widestIntent(ADMITTED_STEPS_PER_TRANSFORMATION),
      testSftpServerEntry(),
      { credentialPasted: false, filedropSplit: false },
    );
    const body = JSON.stringify(handoff);
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(
      MAX_JOB_HANDOFF_RESPONSE_BYTES,
    );
    const parsed = await fetchRecurringHandoff("job-1", () =>
      Promise.resolve(jobJsonResponse(handoff)),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.template).toEqual(handoff.template);
  });

  test("a standardization block past the compose's node budget mints no hand-off at all", () => {
    // The steps a schema-valid intent may carry outrun what core's compose
    // walks, so that intent fails at job creation rather than composing a
    // template no cap covers.
    expect(() =>
      buildJobHandoff(
        widestIntent(MAX_STANDARDIZATION_STEPS),
        testSftpServerEntry(),
        { credentialPasted: false, filedropSplit: false },
      ),
    ).toThrow(/node count/);
  });
});
