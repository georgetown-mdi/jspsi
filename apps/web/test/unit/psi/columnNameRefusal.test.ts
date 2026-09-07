import {
  MAX_NAME_LENGTH,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@psilink/core";
import { describe, expect, test } from "vitest";

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
  consoleJobColumnRefusalAlert,
  overlongCoverageColumns,
  refusedColumnNames,
  savedExchangeColumnRefusalAlert,
} from "@psi/columnNames";
import { failureFor } from "@exchange/useInviterExchange";
import { jobCreateIntentSchema } from "@jobs/intentSchemas";

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
  const refused = refusedColumnNames(parsed.error, columns);
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
      refusedColumnNames(parsed.error, metadata({ name: OVERLONG_NAME })),
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
    expect(refusedColumnNames(parsed.error, metadata())).toEqual([]);
  });

  test("says nothing about a column when the document declares no metadata", () => {
    const parsed = safeParseManagedExchangeRecord({ schemaVersion: "nope" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(refusedColumnNames(parsed.error, undefined)).toEqual([]);
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
    expect(refusedColumnNames(parsed.error, columns)).toEqual([
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
    );
    expect(failure.title).toBe("The console could not start this exchange");
    expect(failure.message).toContain("Column 2");
    // The file-removed cause the empty-bodied 400 otherwise produces is wrong
    // here: the file is fine and re-choosing it changes nothing.
    expect(failure.message).not.toContain("may have been removed");
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
});

describe("the copy every refusal point shares", () => {
  test("shows the name through the display cut, bounded and isolated", () => {
    const message = consoleJobColumnRefusalAlert([
      { position: 4, name: OVERLONG_NAME, refusal: "too-long" },
    ]).message;
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
