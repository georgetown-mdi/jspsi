import { ZodError } from "zod";
import { expect, test } from "vitest";

import {
  parseExchangeSpec,
  safeParseExchangeSpec,
} from "../../src/config/exchangeSpec";
import {
  METADATA_NAME_SHAPE_MESSAGE,
  safeParseMetadataTheReaderWrote,
} from "../../src/config/metadata";
import { safeParseStandardizationTheReaderWrote } from "../../src/config/standardizationSchema";
import {
  MAX_PAYLOAD_ENTRIES,
  MAX_TEXT_LENGTH,
  MAX_TRANSFORM_PARAM_LENGTH,
  NAME_SHAPE_MESSAGE,
  safeParseLinkageTermsTheReaderWrote,
} from "../../src/config/linkageTermsSchema";
import { reconcileReceivedPayload } from "../../src/payloadExchange";
import { unreadKeyIssues } from "../../src/config/unreadKeys";
import { camelizeKeys } from "../../src/utils/camelizeKeys";

// Minimal valid components used as a base.
const minimalLinkageTerms = {
  version: "1.0.0",
  identity: "Test Party",
  date: "2025-01-01",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};

const minimalConnection = {
  channel: "webrtc",
  server: { host: "api.peerjs.com" },
};

const minimalSpec = {
  linkageTerms: minimalLinkageTerms,
  connection: minimalConnection,
};

// --- Happy path --------------------------------------------------------------

test("parses a minimal valid ExchangeSpec", () => {
  const result = parseExchangeSpec(minimalSpec);
  expect(result.linkageTerms.algorithm).toBe("psi");
  expect(result.connection.channel).toBe("webrtc");
  expect(result.metadata).toBeUndefined();
  expect(result.standardization).toBeUndefined();
});

test("metadata and standardization are optional", () => {
  const result = safeParseExchangeSpec({
    ...minimalSpec,
    metadata: [],
    standardization: [{ output: "last_name", input: "LAST_NAME", steps: [] }],
  });
  expect(result.success).toBe(true);
});

test("expectedPayloadColumns: the local commitment field round-trips, including the empty set", () => {
  // The offline-accept commitment: a top-level, per-party field (camelCase
  // parsed, snake_case on disk). A non-empty list and the empty set are both
  // valid -- the empty set is the strict "receive nothing" commitment -- while
  // the field stays optional (absent = lazy).
  expect(
    parseExchangeSpec({
      ...minimalSpec,
      expected_payload_columns: ["notes", "member_id"],
    }).expectedPayloadColumns,
  ).toEqual(["notes", "member_id"]);
  expect(
    parseExchangeSpec({ ...minimalSpec, expected_payload_columns: [] })
      .expectedPayloadColumns,
  ).toEqual([]);
  expect(parseExchangeSpec(minimalSpec).expectedPayloadColumns).toBeUndefined();
});

test("expectedPartnerDeduplicate: the terms-side commitment round-trips both booleans", () => {
  // The acceptance's terms-side binding: a top-level, per-party field (camelCase
  // parsed, snake_case on disk). `false` is a real declaration -- the one a
  // hostile inviter would widen away from by presenting `true` -- so it must
  // survive the parse as `false` and not collapse into the absent state.
  expect(
    parseExchangeSpec({ ...minimalSpec, expected_partner_deduplicate: true })
      .expectedPartnerDeduplicate,
  ).toBe(true);
  expect(
    parseExchangeSpec({ ...minimalSpec, expected_partner_deduplicate: false })
      .expectedPartnerDeduplicate,
  ).toBe(false);
  // Absent means no invitation binding: the two-config case, unchanged.
  expect(
    parseExchangeSpec(minimalSpec).expectedPartnerDeduplicate,
  ).toBeUndefined();
});

test("expectedPartnerDeduplicate: a non-boolean is rejected", () => {
  // The field decides whether a partner's presented cardinality is refused, so a
  // string a hand-edit or a newer minter wrote must fail the parse rather than
  // reach the comparison as a truthy non-boolean.
  const result = safeParseExchangeSpec({
    ...minimalSpec,
    expected_partner_deduplicate: "false",
  });
  expect(result.success).toBe(false);
});

test("expectedPayloadColumns: an empty column name is rejected", () => {
  // Names are partner-controlled; the per-entry min(1) floor rejects an empty name,
  // matching the payload/metadata name floors.
  const result = safeParseExchangeSpec({
    ...minimalSpec,
    expected_payload_columns: [""],
  });
  expect(result.success).toBe(false);
});

test("parses an ExchangeSpec with an SFTP connection", () => {
  const result = parseExchangeSpec({
    linkageTerms: minimalLinkageTerms,
    connection: {
      channel: "sftp",
      server: { host: "sftp.example.org", username: "psilink" },
    },
  });
  expect(result.connection.channel).toBe("sftp");
});

// --- retentionDisposition (self-facing audit pointer) ------------------------

test("retentionDisposition: a note up to MAX_TEXT_LENGTH round-trips", () => {
  const note = "x".repeat(MAX_TEXT_LENGTH);
  const result = parseExchangeSpec({
    ...minimalSpec,
    retention_disposition: note,
  });
  expect(result.retentionDisposition).toBe(note);
});

test("retentionDisposition: a note over MAX_TEXT_LENGTH is rejected", () => {
  // The record schema caps this field at MAX_TEXT_LENGTH; the producer schema
  // matches so an over-long note is rejected here at config time rather than
  // passing config validation only to fail the record build and drop the audit
  // record.
  const result = safeParseExchangeSpec({
    ...minimalSpec,
    retention_disposition: "x".repeat(MAX_TEXT_LENGTH + 1),
  });
  expect(result.success).toBe(false);
});

test("retentionDisposition: an empty note is rejected (absence is the omitted key)", () => {
  const result = safeParseExchangeSpec({
    ...minimalSpec,
    retention_disposition: "",
  });
  expect(result.success).toBe(false);
});

// --- Required fields ---------------------------------------------------------

test("missing connection is rejected", () => {
  const result = safeParseExchangeSpec({ linkageTerms: minimalLinkageTerms });
  expect(result.success).toBe(false);
});

test("missing linkageTerms is rejected", () => {
  const result = safeParseExchangeSpec({ connection: minimalConnection });
  expect(result.success).toBe(false);
});

// --- Embedded linkage-terms bounds -------------------------------------------

test("a transform param over the content bound is rejected through this spec path", () => {
  // The bound on a string-valued transform param lives on LinkageTermsSchema, so
  // the spec path inherits it -- the third of the three paths that parse partner
  // terms, alongside parseLinkageTerms and the invitation-token decode.
  const result = safeParseExchangeSpec({
    ...minimalSpec,
    linkageTerms: {
      ...minimalLinkageTerms,
      linkageKeys: [
        {
          name: "SSN",
          elements: [
            {
              field: "ssn",
              transform: [
                {
                  function: "coalesce",
                  params: {
                    default: "x".repeat(MAX_TRANSFORM_PARAM_LENGTH + 1),
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(
    result.error.issues.some((i) =>
      /transform param must not exceed/.test(i.message),
    ),
  ).toBe(true);
});

test("a name-class control character is rejected through this spec path", () => {
  // The name shape lives on LinkageTermsSchema, so the operator's own config
  // load inherits it: the terms a party keeps on disk are held to the rule a
  // partner's are, and the refusal names the field rather than the value.
  const result = safeParseExchangeSpec({
    ...minimalSpec,
    linkageTerms: {
      ...minimalLinkageTerms,
      payload: { send: [{ name: "risk\u0007score" }] },
    },
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(
    "linkageTerms.payload.send.0.name",
  );
  expect(JSON.stringify(result.error.issues)).toContain(NAME_SHAPE_MESSAGE);
});

test("a control character in a metadata name is rejected through this spec path", () => {
  // The metadata block is the operator's own, but a disclosed column's name
  // reaches the partner in the invitation's payload column list, so the block
  // holds the name shape too. The refusal names the field by path in the
  // spelling a config file writes.
  const result = safeParseExchangeSpec({
    ...minimalSpec,
    metadata: [
      {
        name: "client\u0007id",
        type: "identifier",
        role: "identifier",
        is_payload: true,
      },
    ],
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(
    "metadata.0.name",
  );
  expect(JSON.stringify(result.error.issues)).toContain(
    METADATA_NAME_SHAPE_MESSAGE,
  );
});

test("a name-class character is rejected in every payload column list", () => {
  // The three local enforcement records list column names rather than terms, so
  // each holds the same shape a terms payload name does. expected_payload_columns
  // is written from a partner's invitation and the other two from this party's
  // own metadata, so this is what keeps the class out of the file whichever side
  // authored the name. U+202E RLO, written as an escape.
  const hostile = "risk\u202escore";
  for (const [key, issuePath] of [
    ["expected_payload_columns", "expectedPayloadColumns.0"],
    ["disclosed_payload_columns", "disclosedPayloadColumns.0"],
  ] as const) {
    const result = safeParseExchangeSpec({ ...minimalSpec, [key]: [hostile] });
    expect(result.success).toBe(false);
    if (result.success) continue;
    expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(
      issuePath,
    );
    expect(JSON.stringify(result.error.issues)).toContain(NAME_SHAPE_MESSAGE);
  }

  const consent = safeParseExchangeSpec({
    ...minimalSpec,
    outbound_payload_consent: { status: "confirmed", columns: [hostile] },
  });
  expect(consent.success).toBe(false);
  if (consent.success) return;
  expect(JSON.stringify(consent.error.issues)).toContain(NAME_SHAPE_MESSAGE);
  // The refusal locates the field and reports none of the name.
  expect(JSON.stringify(consent.error.issues)).not.toContain("risk");
});

// --- Payload column-name duplicate normalization -----------------------------
// The two top-level lists and the outbound consent record's own list name each
// column once, the treatment the negotiated payload dictionary already applies.
// All three are hand-authorable in a recurring config, and each is compared
// against a set of columns holding each name once, so a repeat left standing
// refuses the run for the operator's own typo.

test("expectedPayloadColumns: a column named twice parses to one entry", () => {
  expect(
    parseExchangeSpec({
      ...minimalSpec,
      expected_payload_columns: ["notes", "member_id", "notes"],
    }).expectedPayloadColumns,
  ).toEqual(["notes", "member_id"]);
});

test("disclosedPayloadColumns: a column named twice parses to one entry", () => {
  expect(
    parseExchangeSpec({
      ...minimalSpec,
      disclosed_payload_columns: ["diagnosis", "diagnosis", "dose"],
    }).disclosedPayloadColumns,
  ).toEqual(["diagnosis", "dose"]);
});

test("outboundPayloadConsent: a column named twice parses to one entry", () => {
  expect(
    parseExchangeSpec({
      ...minimalSpec,
      outbound_payload_consent: {
        status: "confirmed",
        columns: ["dose", "notes", "dose"],
      },
    }).outboundPayloadConsent,
  ).toEqual({ status: "confirmed", columns: ["dose", "notes"] });
});

test("a payload column list over the maximum count is refused by its authored count, not normalized under it", () => {
  // The count gate stands ahead of the collapse on every list: a list padded
  // with one name repeated is refused for the count it was authored with rather
  // than admitted for the single entry it would collapse to.
  const padded = Array.from({ length: MAX_PAYLOAD_ENTRIES + 1 }, () => "dose");
  for (const fields of [
    { expected_payload_columns: padded },
    { disclosed_payload_columns: padded },
    { outbound_payload_consent: { status: "confirmed", columns: padded } },
  ]) {
    const result = safeParseExchangeSpec({ ...minimalSpec, ...fields });
    expect(result.success).toBe(false);
    if (result.success) continue;
    expect(JSON.stringify(result.error.issues)).toContain("must not exceed");
  }
});

test("expectedPayloadColumns: a repeat does not reach payload reconciliation as a mismatch", () => {
  // The parsed list is what reconcileReceivedPayload compares the partner's
  // transmitted columns against, element-wise over the sorted names. The second
  // assertion is the uncollapsed control: a doubled entry reaching that
  // comparison is a length mismatch, aborting with a protocol error that
  // attributes the operator's own typo to the partner.
  const declared = parseExchangeSpec({
    ...minimalSpec,
    expected_payload_columns: ["notes", "notes"],
  }).expectedPayloadColumns;
  const received = { columns: ["notes"], rowIndices: [0], rows: [["a note"]] };
  expect(() => reconcileReceivedPayload(received, declared)).not.toThrow();
  expect(() => reconcileReceivedPayload(received, ["notes", "notes"])).toThrow(
    /payload disclosure mismatch/,
  );
});

// --- parse vs safeParse ------------------------------------------------------

test("parseExchangeSpec throws ZodError on invalid input", () => {
  expect(() => parseExchangeSpec({})).toThrow(ZodError);
});

test("safeParseExchangeSpec returns success: false on invalid input", () => {
  const result = safeParseExchangeSpec({});
  expect(result.success).toBe(false);
});

// --- camelizeKeys integration ------------------------------------------------

test("parses snake_case top-level keys from disk", () => {
  // camelizeKeys is applied once at the ExchangeSpec level and propagates
  // to nested linkage_terms and connection fields.
  const result = parseExchangeSpec({
    linkage_terms: {
      version: "1.0.0",
      identity: "Test Party",
      date: "2025-01-01",
      algorithm: "psi",
      output: { expects_output: false, share_with_partner: false },
      deduplicate: false,
      linkage_fields: [{ name: "ssn", type: "ssn" }],
      linkage_keys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
    },
    connection: {
      channel: "webrtc",
      server: { host: "api.peerjs.com" },
      role: "inviter",
    },
  });
  expect(result.linkageTerms.output.expectsOutput).toBe(false);
  expect(result.linkageTerms.linkageFields[0].type).toBe("ssn");
  if (result.connection.channel !== "webrtc") return;
  expect(result.connection.role).toBe("inviter");
});

test("parses a top-level authentication block as a sibling of connection", () => {
  // authentication is a top-level ExchangeSpec block (channel-agnostic), not a
  // connection field. Its shared_secret is snake_case on disk and camelized.
  const SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const result = parseExchangeSpec({
    linkage_terms: {
      version: "1.0.0",
      identity: "Test Party",
      date: "2025-01-01",
      algorithm: "psi",
      output: { expects_output: false, share_with_partner: false },
      deduplicate: false,
      linkage_fields: [{ name: "ssn", type: "ssn" }],
      linkage_keys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
    },
    connection: { channel: "filedrop", path: "/mnt/share/drop" },
    authentication: {
      shared_secret: SECRET,
      expires: "2027-01-01T00:00:00Z",
    },
  });
  expect(result.authentication?.sharedSecret).toBe(SECRET);
  expect(result.authentication?.expires).toBe("2027-01-01T00:00:00Z");
});

test("rejects a malformed shared_secret in the top-level authentication block", () => {
  const result = safeParseExchangeSpec({
    linkage_terms: {
      version: "1.0.0",
      identity: "Test Party",
      date: "2025-01-01",
      algorithm: "psi",
      output: { expects_output: false, share_with_partner: false },
      deduplicate: false,
      linkage_fields: [{ name: "ssn", type: "ssn" }],
      linkage_keys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
    },
    connection: { channel: "filedrop", path: "/mnt/share/drop" },
    authentication: { shared_secret: "too-short" },
  });
  expect(result.success).toBe(false);
});

// --- authentication.token_max_age_days (operator policy) ---------------------

test("accepts a positive integer token_max_age_days and camelizes it", () => {
  const result = parseExchangeSpec({
    ...minimalSpec,
    authentication: { token_max_age_days: 30 },
  });
  expect(result.authentication?.tokenMaxAgeDays).toBe(30);
});

test("leaves token_max_age_days undefined when omitted", () => {
  const result = parseExchangeSpec({ ...minimalSpec, authentication: {} });
  expect(result.authentication?.tokenMaxAgeDays).toBeUndefined();
});

test("rejects a non-positive token_max_age_days", () => {
  for (const value of [0, -1]) {
    const result = safeParseExchangeSpec({
      ...minimalSpec,
      authentication: { token_max_age_days: value },
    });
    expect(result.success).toBe(false);
  }
});

test("rejects a non-integer token_max_age_days", () => {
  const result = safeParseExchangeSpec({
    ...minimalSpec,
    authentication: { token_max_age_days: 1.5 },
  });
  expect(result.success).toBe(false);
});

test("accepts token_max_age_days at the 36500-day maximum", () => {
  const result = parseExchangeSpec({
    ...minimalSpec,
    authentication: { token_max_age_days: 36500 },
  });
  expect(result.authentication?.tokenMaxAgeDays).toBe(36500);
});

test("rejects a token_max_age_days above the maximum", () => {
  // An upper bound keeps the rotation-time `now + N days` stamp inside the
  // representable Date range; a value large enough to overflow it must not reach
  // the rotation write path. Just past the ceiling and an overflow-scale value
  // are both rejected at parse.
  expect(
    safeParseExchangeSpec({
      ...minimalSpec,
      authentication: { token_max_age_days: 36501 },
    }).success,
  ).toBe(false);
  expect(
    safeParseExchangeSpec({
      ...minimalSpec,
      authentication: { token_max_age_days: 100_000_000 },
    }).success,
  ).toBe(false);
});

// --- Unrecognized top-level keys (strict) ------------------------------------

test("rejects a misspelled top-level enforcement key rather than dropping it", () => {
  // The three machine-managed enforcement records are optional and their absence
  // is a valid state, so a stripped typo would silently disable the control it
  // names: an unconsented outbound payload, an unenforced receive commitment,
  // or an unchecked disclosure commitment, all with no signal to the operator.
  for (const misspelled of [
    "outbound_payload_consnet",
    "disclosed_payload_column",
    "expected_payload_colums",
  ]) {
    const result = safeParseExchangeSpec({ ...minimalSpec, [misspelled]: [] });
    expect(result.success).toBe(false);
  }
});

test("rejects an unrecognized top-level key from disk in either casing", () => {
  // camelizeKeys runs before the schema, so a snake_case typo on disk and its
  // camelCase form are the same rejection; neither reaches the spec as a
  // silently dropped key.
  for (const key of ["retention_dispositon", "retentionDispositon"])
    expect(
      safeParseExchangeSpec({ ...minimalSpec, [key]: "shredded at 90 days" })
        .success,
    ).toBe(false);
});

test("rejects an unrecognized key in the authentication block (strict)", () => {
  // The authentication block is strictObject: a misspelled policy key is rejected
  // at parse time rather than silently dropped, so a typo cannot disable the
  // max-age control with no signal to the operator.
  const result = safeParseExchangeSpec({
    ...minimalSpec,
    authentication: { token_max_age_dayss: 30 },
  });
  expect(result.success).toBe(false);
});

// --- include_own_columns -----------------------------------------------------

test("includeOwnColumns: both selections parse from the disk spelling, and the key stays optional", () => {
  // A local top-level key, snake_case on disk and camelCase after the parse,
  // like every other per-party field here.
  for (const value of ["disclosed", "all"]) {
    const parsed = parseExchangeSpec({
      ...minimalSpec,
      include_own_columns: value,
    });
    expect(parsed.includeOwnColumns).toBe(value);
  }
  expect(parseExchangeSpec(minimalSpec).includeOwnColumns).toBeUndefined();
});

test("includeOwnColumns: a value outside the two selections is refused", () => {
  // No explicit column list is accepted: the key selects a set, so a column
  // name -- or any other string -- is not a value it takes.
  for (const value of ["", "payload", "pid", true, ["pid"]])
    expect(
      safeParseExchangeSpec({ ...minimalSpec, include_own_columns: value })
        .success,
    ).toBe(false);
});

test("includeOwnColumns: a count-only exchange refuses the key at parse", () => {
  // A psi-c run reports a size and writes no result file, so there is no table
  // for the columns to reach. Refused where the config is read, before any
  // credential, terms, or data moves.
  const countOnly = {
    ...minimalSpec,
    linkageTerms: { ...minimalLinkageTerms, algorithm: "psi-c" },
  };
  // The count-only terms themselves are valid, so a failure below is the key's.
  expect(safeParseExchangeSpec(countOnly).success).toBe(true);
  const result = safeParseExchangeSpec({
    ...countOnly,
    include_own_columns: "all",
  });
  expect(result.success).toBe(false);
  const issue = result.error?.issues[0];
  expect(issue?.message).toContain("include_own_columns");
  expect(issue?.message).toContain("count-only");
  expect(issue?.path).toEqual(["includeOwnColumns"]);
});

// --- Keys the parse does not read --------------------------------------------

// Every consumer of this schema writes its parse result back out, so a key the
// parse drops is a setting the operator wrote and the next file does not hold.
// The top level is strict and refuses one itself; these pin the blocks below it,
// which strip (docs/spec/EXCHANGE_FILE.md, "What a consumer does with a setting
// it cannot honor").

test("a key no block reads is refused, naming it as the file spells it", () => {
  const result = safeParseExchangeSpec({
    ...minimalSpec,
    linkageTerms: { ...minimalLinkageTerms, mystery_setting: "held" },
  });
  expect(result.success).toBe(false);
  const issue = result.error?.issues[0];
  expect(issue?.code).toBe("unrecognized_keys");
  expect(issue?.path).toEqual(["linkageTerms"]);
  expect(issue?.message).toContain("mystery_setting");
  expect(issue?.message).not.toContain("mysterySetting");
});

test("an unread key is named in the spelling the file writes, not snake_case", () => {
  // Both spellings reach the schema, so an operator's own key arrives here as
  // the case conversion left it. Converting that name back to snake_case names
  // a line the file does not hold -- "zz_probe_key" for a camelCase key, and
  // for a key outside either convention a name no writer would recognize.
  for (const key of ["zzProbeKey", "Mystery-Key"]) {
    const result = safeParseExchangeSpec({
      ...minimalSpec,
      linkageTerms: { ...minimalLinkageTerms, [key]: "held" },
    });
    expect(result.success, key).toBe(false);
    expect(result.error?.issues[0]?.message, key).toBe(
      `Unrecognized key: "${key}"`,
    );
  }
});

test("one unread key that begins another is named without swallowing it", () => {
  // Two keys named in one refusal, where the camelized form of the first is the
  // start of the second's: naming them in the order written would rewrite the
  // shorter one inside the longer.
  const result = safeParseExchangeSpec({
    ...minimalSpec,
    linkageTerms: {
      ...minimalLinkageTerms,
      zz_probe: "held",
      zz_probe_key: "held",
    },
  });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.message).toBe(
    'Unrecognized keys: "zz_probe", "zz_probe_key"',
  );
});

test("a strict block names its unrecognized key as the file spells it too", () => {
  // The top level and `authentication` raise their own refusal, worded by Zod
  // over the camelized shape. Naming the same key two ways depending on which
  // block holds it leaves the operator searching for a line that is there.
  const cases: ReadonlyArray<[Record<string, unknown>, Array<string>]> = [
    [{ ...minimalSpec, zz_probe_key: "held" }, []],
    [
      { ...minimalSpec, authentication: { zz_probe_key: "held" } },
      ["authentication"],
    ],
  ];
  for (const [spec, path] of cases) {
    const result = safeParseExchangeSpec(spec);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(path);
    expect(result.error?.issues[0]?.message).toBe(
      'Unrecognized key: "zz_probe_key"',
    );
    expect(() => parseExchangeSpec(spec)).toThrow("zz_probe_key");
  }
});

test("a block read on its own refuses a key no part of it reads", () => {
  // The CLI reads `linkage_terms`, `standardization`, and `metadata` block by
  // block as well as through the whole file, and mints an invitation from what
  // that read returns. A block entry point that stripped what the whole-file
  // read refuses would mint from a document narrowed in silence.
  const blocks: ReadonlyArray<
    [(raw: unknown) => { success: boolean }, unknown]
  > = [
    [
      safeParseLinkageTermsTheReaderWrote,
      { ...minimalLinkageTerms, zz_probe_key: "held" },
    ],
    [
      safeParseStandardizationTheReaderWrote,
      [{ output: "last_name", input: "LAST_NAME", steps: [], zz_probe_key: 1 }],
    ],
    [
      safeParseMetadataTheReaderWrote,
      [
        {
          name: "program",
          type: "other",
          role: "payload",
          is_payload: true,
          zz_probe_key: 1,
        },
      ],
    ],
  ];
  for (const [safeParse, block] of blocks)
    expect(safeParse(block).success).toBe(false);
});

test("no load yields a document with a setting dropped, at any depth", () => {
  // The one chokepoint every reader of an exchange file loads through: the CLI's
  // config load, the web application's command-line import, and whatever the
  // console grows. A document holding a setting no schema block reads has no
  // load result at all, so none of them can run on one.
  const nested: ReadonlyArray<[string, Record<string, unknown>]> = [
    ["connection", { ...minimalConnection, mystery_setting: 1 }],
    [
      "connection.server",
      { ...minimalConnection, server: { host: "api.peerjs.com", extra: 1 } },
    ],
    [
      "linkage_terms.output",
      {
        ...minimalLinkageTerms,
        output: { expectsOutput: true, shareWithPartner: false, extra: 1 },
      },
    ],
  ];
  for (const [where, block] of nested) {
    const spec = where.startsWith("connection")
      ? { ...minimalSpec, connection: block }
      : { ...minimalSpec, linkageTerms: block };
    const result = safeParseExchangeSpec(spec);
    expect(result.success, where).toBe(false);
    expect(result.data, where).toBeUndefined();
    expect(() => parseExchangeSpec(spec), where).toThrow(ZodError);
  }
});

test("a key no block reads is refused inside an array element", () => {
  const result = safeParseExchangeSpec({
    ...minimalSpec,
    metadata: [
      {
        name: "program",
        type: "other",
        role: "payload",
        is_payload: true,
        mystery_setting: "held",
      },
    ],
  });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["metadata", 0]);
  expect(result.error?.issues[0]?.message).toContain("mystery_setting");
});

test("every key of a document that parses survives into the parse result", () => {
  // The rule the refusals above serve: what the parse returns is what the next
  // writer writes, so a document this schema accepts has lost nothing. Walked
  // over a spec holding every block rather than asserted field by field.
  const whole = {
    ...minimalSpec,
    metadata: [
      { name: "program", type: "other", role: "payload", is_payload: true },
    ],
    standardization: [{ output: "last_name", input: "LAST_NAME", steps: [] }],
    retention_disposition: "Filed with the program office for seven years.",
    expected_payload_columns: ["partner_program"],
    disclosed_payload_columns: ["program"],
    expected_partner_deduplicate: true,
    include_own_columns: "all",
    csv_delimiter: "|",
  };
  const parsed = parseExchangeSpec(whole) as Record<string, unknown>;
  const camelized = camelizeKeys(whole) as Record<string, unknown>;
  expect(unreadKeyIssues(camelized, parsed)).toEqual([]);
  for (const key of Object.keys(camelized)) expect(parsed).toHaveProperty(key);
});

const sendingColumns = (send: ReadonlyArray<Record<string, unknown>>) => ({
  ...minimalSpec,
  linkageTerms: { ...minimalLinkageTerms, payload: { send } },
});

test("a repeated payload column that states nothing beyond the entry kept is collapsed", () => {
  // The one normalization that shortens an array: two entries naming one column
  // collapse to the first. The repeat states nothing the survivor does not, so
  // the document a save writes back holds every setting this one states and the
  // collapse stays a normalization rather than becoming a refusal.
  const parsed = parseExchangeSpec(
    sendingColumns([
      { name: "program", description: "the program enrolled in" },
      { name: "program" },
    ]),
  );
  expect(parsed.linkageTerms.payload?.send).toHaveLength(1);
  expect(parsed.linkageTerms.payload?.send?.[0]?.description).toBe(
    "the program enrolled in",
  );
  expect(
    parseExchangeSpec(
      sendingColumns([
        { name: "program", description: "the program enrolled in" },
        { name: "program", description: "the program enrolled in" },
      ]),
    ).linkageTerms.payload?.send,
  ).toHaveLength(1);
});

test("a repeated payload column that states more is refused as a duplicate", () => {
  // The collapse keeps the FIRST entry, so what a later one states beyond it is
  // dropped -- a setting the operator wrote and a save would not write back. The
  // refusal names the entry that is already there, rather than reporting the
  // dropped entry's own keys as keys no block reads: `description` is a payload
  // column key, and telling the operator to remove it names the wrong line.
  for (const send of [
    [{ name: "program" }, { name: "program", description: "held" }],
    [
      { name: "program", description: "first" },
      { name: "program", description: "held" },
    ],
  ]) {
    const result = safeParseExchangeSpec(sendingColumns(send));
    expect(result.success).toBe(false);
    const issue = result.error?.issues[0];
    expect(issue?.path).toEqual(["linkageTerms", "payload", "send", 1]);
    expect(issue?.message).toContain('names the column "program"');
    expect(issue?.message).toContain("entry 0");
    expect(issue?.message).not.toContain("Unrecognized");
    expect(issue?.message).not.toContain("held");
  }
});

test("both spellings of one key are refused, naming each as the file writes it", () => {
  // The camelize pre-pass reads both as one name and keeps one of the two, which
  // the document-against-result comparison cannot see is missing. On a
  // fail-closed record the surviving value would narrow an enforcement the
  // operator wrote (docs/spec/EXCHANGE_FILE.md, "The records that must
  // survive").
  const result = safeParseExchangeSpec({
    ...minimalSpec,
    expected_payload_columns: ["partner_program"],
    expectedPayloadColumns: ["other"],
  });
  expect(result.success).toBe(false);
  const issue = result.error?.issues[0];
  expect(issue?.path).toEqual([]);
  expect(issue?.message).toContain('"expected_payload_columns"');
  expect(issue?.message).toContain('"expectedPayloadColumns"');
  expect(issue?.message).not.toContain("partner_program");
});

test("both spellings of one key are refused inside a block too", () => {
  const result = safeParseExchangeSpec({
    ...minimalSpec,
    linkageTerms: {
      ...minimalLinkageTerms,
      output: {
        expects_output: true,
        expectsOutput: false,
        shareWithPartner: false,
      },
    },
  });
  expect(result.success).toBe(false);
  const issue = result.error?.issues[0];
  expect(issue?.path).toEqual(["linkageTerms", "output"]);
  expect(issue?.message).toContain('"expects_output"');
  expect(issue?.message).toContain('"expectsOutput"');
});

test("provider_options on a channel whose schema has no such field is refused", () => {
  // The opaque subtree is never entered, but the key naming it is read like any
  // other: a filedrop connection declares no provider_options, so a document
  // writing one states a setting the file a save writes back would not hold.
  const result = safeParseExchangeSpec({
    ...minimalSpec,
    connection: {
      channel: "filedrop",
      path: "/mnt/share",
      provider_options: { readyTimeout: 1000 },
    },
  });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.message).toContain("provider_options");
});
