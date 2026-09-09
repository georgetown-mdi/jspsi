import {
  MAX_NAME_LENGTH,
  MAX_TRANSFORM_PATTERN_LENGTH,
  MetadataSchema,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@psilink/core";
import { describe, expect, test } from "vitest";

import {
  COVERAGE_UNAVAILABLE_MESSAGE,
  coverageUnavailableMessage,
} from "@components/FieldCoverage";
import {
  JobApiRequestError,
  JobIntentColumnNameError,
} from "@psi/jobClient/serverJobExchangeDriver";
import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  composeManagedExchangeFile,
  safeParseManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import {
  MAX_STANDARDIZATION_STEPS,
  jobCreateIntentSchema,
} from "@jobs/intentSchemas";
import {
  consoleJobColumnRefusalAlert,
  overlongCoverageColumns,
  refusedColumnNames,
  savedExchangeColumnRefusalAlert,
} from "@psi/columnNames";
import { failureFor } from "@exchange/useInviterExchange";

import type {
  Metadata,
  Standardization,
  WebRTCExchangeLocator,
} from "@psilink/core";

/**
 * The three whole-document points that refuse a document over one column name --
 * the recurring-exchange save, the console job create, and the console's cleaning
 * coverage sweep -- asserted through what the operator reads, not through the
 * parse error each raises.
 */

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

const webrtcLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
};

/** RIGHT-TO-LEFT OVERRIDE and the two isolate characters the display cut wraps a
 * name in, written as escapes so a test about invisible characters is readable. */
const RLO = "\u202e";
const FSI = "\u2068";
const PDI = "\u2069";

/** A header past the wire ceiling: what a wide vendor export produces and what
 * every one of these points refuses the whole document over. */
const OVERLONG_NAME = "diagnosis_code_".padEnd(MAX_NAME_LENGTH + 1, "x");

function metadata(overrides: Partial<Metadata[number]> = {}): Metadata {
  return [
    {
      name: "client_id",
      type: "identifier",
      role: "identifier",
      isPayload: false,
    },
    {
      name: "notes",
      type: "other",
      role: "payload",
      isPayload: true,
      ...overrides,
    },
  ];
}

/**
 * A stored record whose metadata holds `columns`, assembled with admissible
 * names and then rewritten -- the only way to produce the document a READ-BACK
 * meets, since every composing path parses and would refuse it at the write.
 */
function storedRecord(columns: Metadata): unknown {
  const exchangeFile = composeManagedExchangeFile({
    connection: webrtcLocator,
    linkageTerms,
    metadata: metadata(),
  });
  return {
    schemaVersion: MANAGED_EXCHANGE_SCHEMA_VERSION,
    id: "3f1a1a2e-0000-4000-8000-000000000001",
    label: "Riverbend quarterly",
    exchangeFile: { ...exchangeFile, metadata: columns },
    side: "inviter",
    sharedSecret: generateSharedSecret(),
  };
}

/** The alert the recurring-exchange save shows for `columns`, or undefined when
 * the record parses. */
function saveAlert(columns: Metadata) {
  const parsed = safeParseManagedExchangeRecord(storedRecord(columns));
  if (parsed.success) return undefined;
  const refused = refusedColumnNames(columns);
  return refused.length === 0
    ? undefined
    : savedExchangeColumnRefusalAlert(refused);
}

describe("the recurring-exchange save", () => {
  test("names the column and the bound for an oversized DISCLOSED name", () => {
    const alert = saveAlert(metadata({ name: OVERLONG_NAME }));
    expect(alert?.message).toContain("Column 2");
    expect(alert?.message).toContain(
      `has a name longer than ${MAX_NAME_LENGTH} characters`,
    );
    // The generic copy is replaced, not appended to: retrying the same document
    // fails identically, so inviting a retry would be wrong.
    expect(alert?.message).not.toContain("try again");
  });

  test("names the column for an oversized UNDISCLOSED name", () => {
    // The stored document bounds every declared name, disclosed or not, so a
    // column the exchange never sends refuses the save exactly as a sent one
    // does -- and the operator is told which, rather than meeting a bare failure.
    const alert = saveAlert(
      metadata({ name: OVERLONG_NAME, role: "ignored", isPayload: false }),
    );
    expect(alert?.message).toContain("Column 2");
    expect(alert?.message).toContain(
      `has a name longer than ${MAX_NAME_LENGTH} characters`,
    );
  });

  test("names the column on the READ-BACK of an already-stored record", () => {
    // A record written by a build that admitted the name is read by one that
    // does not; the read reports the same column rather than an opaque failure.
    const stored = storedRecord(metadata({ name: OVERLONG_NAME }));
    const parsed = safeParseManagedExchangeRecord(stored);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const alert = savedExchangeColumnRefusalAlert(
      refusedColumnNames(metadata({ name: OVERLONG_NAME })),
    );
    expect(alert.title).toBe("Could not save this recurring exchange");
    expect(alert.message).toContain("Column 2");
  });

  test("names the character class for a control-character name", () => {
    const alert = saveAlert(metadata({ name: `notes${RLO}` }));
    expect(alert?.message).toContain("Column 2");
    expect(alert?.message).toContain(
      "has a name holding an invisible control or text-direction character",
    );
  });

  test("names each repeated column when the block's uniqueness refuses it", () => {
    // The uniqueness rule sits on the whole block, so its own issue names no
    // column; the repeat is resolved against the block the caller tried to write.
    const alert = saveAlert(metadata({ name: "client_id" }));
    expect(alert?.message).toContain("Column 2");
    expect(alert?.message).toContain(
      "repeats a name an earlier column already uses",
    );
  });

  test("leaves the generic copy standing for a failure no column explains", () => {
    const parsed = safeParseManagedExchangeRecord({
      ...(storedRecord(metadata()) as Record<string, unknown>),
      sharedSecret: "not-a-secret",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(refusedColumnNames(metadata())).toEqual([]);
  });

  test("says nothing about a column when the document declares no metadata", () => {
    const parsed = safeParseManagedExchangeRecord({ schemaVersion: "nope" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(refusedColumnNames(undefined)).toEqual([]);
  });
});

describe("the console job create", () => {
  /** The intent the browser composes for a console exchange run, less the
   * metadata each case supplies. */
  function intent(columns: Metadata) {
    return {
      channel: "filedrop" as const,
      side: "inviter" as const,
      linkageTerms,
      sharedSecret: generateSharedSecret(),
      inputFile: { name: "clients.csv" },
      metadata: columns,
      eventStream: true,
    };
  }

  test("locates the column through the create schema's own issue path", () => {
    // The same schema the route parses with, run in the browser that holds the
    // intent: the browser cannot refuse what the console would accept.
    const columns = metadata({ name: OVERLONG_NAME });
    const parsed = jobCreateIntentSchema.safeParse(intent(columns));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(refusedColumnNames(columns)).toEqual([
      { position: 2, name: OVERLONG_NAME, refusal: "too-long" },
    ]);
  });

  test("admits an intent whose column names are all admissible", () => {
    expect(jobCreateIntentSchema.safeParse(intent(metadata())).success).toBe(
      true,
    );
  });

  test("shows the column instead of blaming the mounted file", () => {
    const failure = failureFor(
      "config",
      new JobIntentColumnNameError([
        { position: 2, name: OVERLONG_NAME, refusal: "too-long" },
      ]),
      { kind: "workFile", name: "clients.csv" },
      "filedrop",
      "inviter",
    );
    expect(failure.title).toBe("The console could not start this exchange");
    expect(failure.message).toContain("Column 2");
    // The inviter's start-over reaches the file picker, so its copy names it.
    expect(failure.message).toContain("choose the file again, and start over");
    // The file-removed cause the empty-bodied 400 otherwise produces is wrong
    // here: the file is fine and re-choosing it changes nothing.
    expect(failure.message).not.toContain("may have been removed");
  });

  test("names the way back the acceptor's own alert offers", () => {
    // The acceptor's config-category recovery is "Back to your columns", which
    // keeps every column-step input and re-selects the file from there, so a
    // start-over sentence would name a control that seat never shows.
    const failure = failureFor(
      "config",
      new JobIntentColumnNameError([
        { position: 2, name: OVERLONG_NAME, refusal: "too-long" },
      ]),
      { kind: "workFile", name: "clients.csv" },
      "filedrop",
      "acceptor",
    );
    expect(failure.message).toContain(
      "go back to your columns, and choose the file again",
    );
    expect(failure.message).not.toContain("start over");
  });

  test("keeps the file-removed cause for a 400 no column explains", () => {
    const failure = failureFor(
      "config",
      new JobApiRequestError(400, "POST /api/jobs failed with status 400"),
      { kind: "workFile", name: "clients.csv" },
      "filedrop",
    );
    expect(failure.message).toContain("may have been removed");
  });
});

/**
 * The scan reads the block instead of the parse error, so what keeps the browser
 * from refusing a document core accepts (or passing one it refuses) is that the
 * two agree exactly. Swept over every rule and each rule's boundary, plus the
 * blocks the scenarios above use.
 */
const NAME_SAMPLES: Array<{ label: string; name: string }> = [
  { label: "a plain name", name: "notes" },
  { label: "a name at the length bound", name: "x".repeat(MAX_NAME_LENGTH) },
  {
    label: "a name one past the length bound",
    name: "x".repeat(MAX_NAME_LENGTH + 1),
  },
  {
    label: "an emoji name at the length bound",
    name: "\u{1F600}".repeat(MAX_NAME_LENGTH / 2),
  },
  {
    label: "an emoji name one code point past it",
    name: "\u{1F600}".repeat(MAX_NAME_LENGTH / 2 + 1),
  },
  { label: "an empty name", name: "" },
  { label: "a name holding a text-direction override", name: `notes${RLO}` },
  { label: "a name holding a C0 control character", name: "notes\u0007" },
  { label: "a name holding a C1 control character", name: "notes\u0085" },
  { label: "an accented name", name: "n\u00e9e" },
  { label: "a name holding a space", name: "client notes" },
  { label: "a name the first column already uses", name: "client_id" },
];

const PARITY_BLOCKS: Array<{ label: string; columns: Metadata }> = [
  { label: "an empty block", columns: [] },
  ...NAME_SAMPLES.map(({ label, name }) => ({
    label: `a block whose second column has ${label}`,
    columns: metadata({ name }),
  })),
  ...NAME_SAMPLES.map(({ label, name }) => ({
    label: `a block whose two columns both have ${label}`,
    columns: metadata({ name }).map((column) => ({ ...column, name })),
  })),
  {
    label: "the undisclosed-oversized-name scenario's block",
    columns: metadata({
      name: OVERLONG_NAME,
      role: "ignored",
      isPayload: false,
    }),
  },
  {
    label: "the console job create scenario's block",
    columns: metadata({ name: OVERLONG_NAME }),
  },
];

describe("the scan and core's schema refuse the same blocks", () => {
  test.each(PARITY_BLOCKS)(
    "$label is refused by both or by neither",
    ({ columns }) => {
      expect(MetadataSchema.safeParse(columns).success).toBe(
        refusedColumnNames(columns).length === 0,
      );
    },
  );
});

describe("the console's cleaning coverage sweep", () => {
  const columns = ["client_id", OVERLONG_NAME, "notes"];

  function cleaning(...inputs: Array<string>): Standardization {
    return inputs.map((input, index) => ({
      output: `field_${index}`,
      input,
      steps: [],
    }));
  }

  test("names the input column whose header trips the bound", () => {
    expect(
      overlongCoverageColumns(cleaning("client_id", OVERLONG_NAME), columns),
    ).toEqual([{ position: 2, name: OVERLONG_NAME, refusal: "too-long" }]);
  });

  test("names a column once however many cleaning fields read it", () => {
    expect(
      overlongCoverageColumns(cleaning(OVERLONG_NAME, OVERLONG_NAME), columns),
    ).toHaveLength(1);
  });

  test("names nothing for an input the header does not hold", () => {
    // An input matching no header entry is not a column of this file, so naming
    // a position for it would point the operator at the wrong header cell.
    expect(
      overlongCoverageColumns(cleaning(OVERLONG_NAME), ["client_id", "notes"]),
    ).toEqual([]);
  });

  test("names nothing while every input is within the bound", () => {
    expect(overlongCoverageColumns(cleaning("client_id"), columns)).toEqual([]);
  });

  test("names nothing when the step cap is what settled the sweep", () => {
    // The step cap is not enforced in the editor, so a standardization can trip
    // it while a header is oversized beside it. Shortening that header would not
    // make the sweep run, so the banner keeps its generic copy rather than
    // sending the operator to the header row.
    const overCap: Standardization = [
      { output: "field_0", input: OVERLONG_NAME, steps: [] },
      {
        output: "field_1",
        input: "client_id",
        steps: Array.from({ length: MAX_STANDARDIZATION_STEPS + 1 }, () => ({
          function: "trim",
        })),
      },
    ];
    expect(overlongCoverageColumns(overCap, columns)).toEqual([]);
  });

  test("names nothing when a step's pattern is what settled the sweep", () => {
    const overCap: Standardization = [
      { output: "field_0", input: OVERLONG_NAME, steps: [] },
      {
        output: "field_1",
        input: "client_id",
        steps: [
          {
            function: "replace_regex",
            params: {
              pattern: "a".repeat(MAX_TRANSFORM_PATTERN_LENGTH + 1),
              replacement: "b",
            },
          },
        ],
      },
    ];
    expect(overlongCoverageColumns(overCap, columns)).toEqual([]);
  });

  test("names nothing when an output name is what settled the sweep", () => {
    // An `output` is a linkage field's name, not a column of the file, so no
    // header edit clears it.
    const overCap: Standardization = [
      { output: OVERLONG_NAME, input: "client_id", steps: [] },
      { output: "field_1", input: OVERLONG_NAME, steps: [] },
    ];
    expect(overlongCoverageColumns(overCap, columns)).toEqual([]);
  });
});

describe("the coverage-unavailable copy", () => {
  test("states the generic cause when no column explains the sweep", () => {
    expect(coverageUnavailableMessage([])).toBe(COVERAGE_UNAVAILABLE_MESSAGE);
  });

  test("names one column and asks for the one header", () => {
    const message = coverageUnavailableMessage([
      { position: 2, name: "notes", refusal: "too-long" },
    ]);
    expect(message).toContain("Column 2");
    expect(message).toContain("Shorten the header in your file");
  });

  test("asks for every header when more than one column is named", () => {
    const message = coverageUnavailableMessage([
      { position: 2, name: "notes", refusal: "too-long" },
      { position: 3, name: "codes", refusal: "too-long" },
    ]);
    expect(message).toContain("Column 2");
    expect(message).toContain("Column 3");
    expect(message).toContain("Shorten the headers in your file");
  });
});

describe("the copy every refusal point shares", () => {
  test("shows the name through the display cut, bounded and isolated", () => {
    const message = consoleJobColumnRefusalAlert(
      [{ position: 4, name: OVERLONG_NAME, refusal: "too-long" }],
      "inviter",
    ).message;
    // The cut, not the raw header: the isolate wraps it and the name stops at
    // the ceiling, so an unbounded header cannot paint over the alert.
    expect(message).toContain(FSI);
    expect(message).toContain(PDI);
    expect(message).not.toContain(OVERLONG_NAME);
  });

  test("isolates a text-direction character rather than dropping the name", () => {
    const name = `notes${RLO}records`;
    const message = savedExchangeColumnRefusalAlert([
      { position: 1, name, refusal: "control-character" },
    ]).message;
    expect(message).toContain(`${FSI}${name}${PDI}`);
  });

  test("locates an unnamed column by position, with no empty name clause", () => {
    // The clause that would hold the name renders as nothing between two commas,
    // so the sentence states the position and what was refused, and nothing else.
    const message = savedExchangeColumnRefusalAlert([
      { position: 3, name: "", refusal: "unnamed" },
    ]).message;
    expect(message).toContain("Column 3 has no name.");
    expect(message).not.toContain(", ,");
  });

  test("names every refused column in position order", () => {
    const message = savedExchangeColumnRefusalAlert([
      { position: 1, name: "a", refusal: "unnamed" },
      { position: 3, name: "c", refusal: "repeated" },
    ]).message;
    expect(message.indexOf("Column 1")).toBeLessThan(
      message.indexOf("Column 3"),
    );
  });
});
