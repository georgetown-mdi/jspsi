import { expect, test } from "vitest";

import {
  deriveAcceptedLinkageTerms,
  validateCompatibility,
} from "../src/linkageTermsNegotiation";
import {
  MAX_TEXT_LENGTH,
  TEXT_CONTROL_CHAR_MESSAGE,
  safeParseLinkageTerms,
} from "../src/config/linkageTermsSchema";
import type { LinkageTerms } from "../src/config/linkageTermsSchema";
import {
  assertPresentedDeduplicateMatchesInvitation,
  InvitationTermDivergenceError,
} from "../src/exchange";
import { UsageError } from "../src/errors";
import {
  DISPLAY_TRUNCATION_MARKER,
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  controlCharacterMarker,
  sanitizeForDisplay,
} from "../src/utils/sanitizeForDisplay";
import { sanitizeErrorForDisplay } from "../src/utils/sanitizeErrorForDisplay";

// --- validateCompatibility ---------------------------------------------------

const sharedFields: LinkageTerms["linkageFields"] = [
  { name: "ssn", type: "ssn" },
];
const sharedKeys: LinkageTerms["linkageKeys"] = [
  { name: "SSN", elements: [{ field: "ssn" }] },
];

const termsA: LinkageTerms = {
  version: "1.0.0",
  identity: "Party A",
  date: "2025-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: sharedFields,
  linkageKeys: sharedKeys,
};

const termsB: LinkageTerms = {
  ...termsA,
  identity: "Party B",
};

test("compatible terms produce no errors or warnings", () => {
  const { errors, warnings } = validateCompatibility(termsA, termsB);
  expect(errors).toHaveLength(0);
  expect(warnings).toHaveLength(0);
});

test("date mismatch produces a warning, not an error", () => {
  const { errors, warnings } = validateCompatibility(termsA, {
    ...termsB,
    date: "2025-06-01",
  });
  expect(errors).toHaveLength(0);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/date mismatch/);
});

test("every value a warning can hold is already escape-stable", () => {
  // The CLI escapes a warning again at its log line and its event stream, so a
  // warning makes two passes on that route (recorded as a limit in
  // CHANNEL_SECURITY.md). That second pass is unobservable only while every
  // value interpolated into a warning is constrained to a shape the escape does
  // not rewrite. This pins that assumption where it actually holds -- the
  // schema -- so a future warning holding free text fails here rather than
  // silently reaching an operator double-escaped.
  const { warnings } = validateCompatibility(termsA, {
    ...termsB,
    date: "2025-06-01",
  });
  expect(warnings).toHaveLength(1);
  for (const warning of warnings) {
    expect(sanitizeForDisplay(warning)).toBe(warning);
  }

  for (const hostile of [
    "2025-01-0\\",
    "2025-01-01\x1b[31m",
    "2025-01-0‮",
    "2025-01-01\n",
  ]) {
    expect(safeParseLinkageTerms({ ...termsA, date: hostile }).success).toBe(
      false,
    );
  }
});

test("version mismatch is an error", () => {
  const { errors } = validateCompatibility(termsA, {
    ...termsB,
    version: "2.0.0",
  });
  expect(errors.some((e) => e.includes("version mismatch"))).toBe(true);
});

test("algorithm mismatch is an error", () => {
  const { errors } = validateCompatibility(termsA, {
    ...termsB,
    algorithm: "psi-c",
  });
  expect(errors.some((e) => e.includes("algorithm mismatch"))).toBe(true);
});

test("linkage strategy mismatch is an error", () => {
  const { errors } = validateCompatibility(
    { ...termsA, linkageStrategy: "single-pass" },
    { ...termsB, linkageStrategy: "cascade" },
  );
  expect(errors.some((e) => e.includes("linkage strategy mismatch"))).toBe(
    true,
  );
});

test("matching single-pass strategies are compatible", () => {
  const { errors } = validateCompatibility(
    { ...termsA, linkageStrategy: "single-pass" },
    { ...termsB, linkageStrategy: "single-pass" },
  );
  expect(errors).toHaveLength(0);
});

test("neither party expects output is an error", () => {
  const noOutput = { expectsOutput: false, shareWithPartner: false };
  const { errors } = validateCompatibility(
    { ...termsA, output: noOutput },
    { ...termsB, output: noOutput },
  );
  expect(errors.some((e) => e.includes("neither party expects output"))).toBe(
    true,
  );
});

test("output cross-check: I will share but partner does not expect is an error", () => {
  const { errors } = validateCompatibility(
    { ...termsA, output: { expectsOutput: false, shareWithPartner: true } },
    { ...termsB, output: { expectsOutput: false, shareWithPartner: false } },
  );
  expect(errors.some((e) => e.includes("output mismatch"))).toBe(true);
});

test("output cross-check: I expect but partner will not share is an error", () => {
  const { errors } = validateCompatibility(
    { ...termsA, output: { expectsOutput: true, shareWithPartner: false } },
    { ...termsB, output: { expectsOutput: false, shareWithPartner: false } },
  );
  expect(errors.some((e) => e.includes("output mismatch"))).toBe(true);
});

test("linkage fields mismatch is an error", () => {
  const { errors } = validateCompatibility(termsA, {
    ...termsB,
    linkageFields: [{ name: "firstName", type: "first_name" }],
  });
  expect(errors.some((e) => e.includes("linkage fields do not match"))).toBe(
    true,
  );
});

test("linkage fields in different order are still compatible", () => {
  const { errors } = validateCompatibility(
    {
      ...termsA,
      linkageFields: [
        { name: "ssn", type: "ssn" },
        { name: "dob", type: "date_of_birth" },
      ],
      linkageKeys: [
        { name: "SSN+DOB", elements: [{ field: "ssn" }, { field: "dob" }] },
      ],
    },
    {
      ...termsB,
      linkageFields: [
        { name: "dob", type: "date_of_birth" },
        { name: "ssn", type: "ssn" },
      ],
      linkageKeys: [
        { name: "SSN+DOB", elements: [{ field: "ssn" }, { field: "dob" }] },
      ],
    },
  );
  expect(errors.filter((e) => e.includes("linkage fields"))).toHaveLength(0);
});

test("linkage keys mismatch is an error", () => {
  const { errors } = validateCompatibility(termsA, {
    ...termsB,
    linkageKeys: [{ name: "Different", elements: [{ field: "ssn" }] }],
  });
  expect(errors.some((e) => e.includes("linkage keys do not match"))).toBe(
    true,
  );
});

test("a non-canonical linkage-key param is reported, not thrown", () => {
  // transform.params is Record<string, unknown>, so an integer beyond 2^53
  // survives schema parsing but cannot be canonically encoded. The canonical
  // comparison must report that as an error rather than letting the thrown
  // CanonicalEncodingError escape validateCompatibility's {errors,warnings}
  // contract (the callers in protocolSetup abort the exchange on a non-empty
  // errors list; an uncaught throw would crash the process instead).
  const badKeys: LinkageTerms["linkageKeys"] = [
    {
      name: "SSN",
      elements: [
        {
          field: "ssn",
          transform: [{ function: "noop", params: { big: 2 ** 53 } }],
        },
      ],
    },
  ];
  const runLocalBad = () =>
    validateCompatibility({ ...termsA, linkageKeys: badKeys }, termsB);
  expect(runLocalBad).not.toThrow();
  expect(
    runLocalBad().errors.some((e) =>
      e.includes("local linkage keys cannot be canonically encoded"),
    ),
  ).toBe(true);

  // Symmetric: the partner's keys are the un-encodable ones.
  const runPartnerBad = () =>
    validateCompatibility(termsA, { ...termsB, linkageKeys: badKeys });
  expect(runPartnerBad).not.toThrow();
  expect(
    runPartnerBad().errors.some((e) =>
      e.includes("partner linkage keys cannot be canonically encoded"),
    ),
  ).toBe(true);
});

test("a transform.params value difference is an incompatibility", () => {
  // The comparison operates on already-camelCase terms -- every parse path (config
  // load, the post-handshake wire, and the invitation decode chokepoint) normalizes
  // params key casing before terms reach here -- so this checks the substance: a
  // different param VALUE under the same key diverges canonically and is reported.
  const withParams = (
    params: Record<string, unknown>,
  ): LinkageTerms["linkageKeys"] => [
    {
      name: "SSN",
      elements: [
        { field: "ssn", transform: [{ function: "parse_date", params }] },
      ],
    },
  ];
  const a: LinkageTerms = {
    ...termsA,
    linkageKeys: withParams({ inputFormat: "MMDDYYYY" }),
  };
  const b: LinkageTerms = {
    ...termsB,
    linkageKeys: withParams({ inputFormat: "YYYYMMDD" }),
  };
  const { errors } = validateCompatibility(a, b);
  expect(errors.some((e) => e.includes("linkage keys do not match"))).toBe(
    true,
  );
});

test("legal agreement present on one side only is an error", () => {
  const { errors } = validateCompatibility(
    {
      ...termsA,
      legalAgreement: {
        reference: "MOU-001",
        purpose: "Care coordination",
        expirationDate: "2030-01-01",
      },
    },
    termsB,
  );
  expect(errors.some((e) => e.includes("legal agreement"))).toBe(true);
});

test("mismatched legal agreement reference is an error", () => {
  const { errors } = validateCompatibility(
    {
      ...termsA,
      legalAgreement: {
        reference: "MOU-001",
        purpose: "Care coordination",
        expirationDate: "2030-01-01",
      },
    },
    {
      ...termsB,
      legalAgreement: {
        reference: "MOU-002",
        purpose: "Care coordination",
        expirationDate: "2030-01-01",
      },
    },
  );
  expect(
    errors.some((e) => e.includes("legal agreement reference mismatch")),
  ).toBe(true);
});

test("mismatched legal agreement purpose is an error", () => {
  const { errors } = validateCompatibility(
    {
      ...termsA,
      legalAgreement: {
        reference: "MOU-001",
        purpose: "Care coordination",
        expirationDate: "2030-01-01",
      },
    },
    {
      ...termsB,
      legalAgreement: {
        reference: "MOU-001",
        purpose: "Program audit and evaluation",
        expirationDate: "2030-01-01",
      },
    },
  );
  expect(
    errors.some((e) => e.includes("legal agreement purpose mismatch")),
  ).toBe(true);
});

test("legal agreement purpose differing only by Unicode normalization is a mismatch", () => {
  // purpose is compared byte-for-byte, so the same text in different Unicode
  // normalization forms (NFC vs NFD) does not match. This pins the byte-exact
  // semantics as a guardrail: a later .normalize() or localeCompare would
  // silently weaken the cross-party check (and split termsHash between the
  // parties, since purpose feeds the canonical encoding the hash covers).
  const nfc = "Care coordination caf\u00e9"; // NFC: e-acute, one code point
  const nfd = "Care coordination cafe\u0301"; // NFD: e + combining acute
  expect(nfc).not.toBe(nfd); // distinct bytes...
  expect(nfc.normalize("NFC")).toBe(nfd.normalize("NFC")); // ...but the same text
  const { errors } = validateCompatibility(
    {
      ...termsA,
      legalAgreement: {
        reference: "MOU-001",
        purpose: nfc,
        expirationDate: "2030-01-01",
      },
    },
    {
      ...termsB,
      legalAgreement: {
        reference: "MOU-001",
        purpose: nfd,
        expirationDate: "2030-01-01",
      },
    },
  );
  expect(
    errors.some((e) => e.includes("legal agreement purpose mismatch")),
  ).toBe(true);
});

test("mismatched legal agreement expiration date is an error", () => {
  const { errors } = validateCompatibility(
    {
      ...termsA,
      legalAgreement: {
        reference: "MOU-001",
        purpose: "Care coordination",
        expirationDate: "2030-01-01",
      },
    },
    {
      ...termsB,
      legalAgreement: {
        reference: "MOU-001",
        purpose: "Care coordination",
        expirationDate: "2031-06-30",
      },
    },
  );
  expect(
    errors.some((e) => e.includes("legal agreement expiration date mismatch")),
  ).toBe(true);
});

test("expired legal agreement is an error", () => {
  const { errors } = validateCompatibility(
    {
      ...termsA,
      legalAgreement: {
        reference: "MOU-001",
        purpose: "Care coordination",
        expirationDate: "2020-01-01",
      },
    },
    {
      ...termsB,
      legalAgreement: {
        reference: "MOU-001",
        purpose: "Care coordination",
        expirationDate: "2020-01-01",
      },
    },
  );
  expect(errors.some((e) => e.includes("expired"))).toBe(true);
});

test("payload send/receive mismatch is an error", () => {
  const { errors } = validateCompatibility(
    {
      ...termsA,
      payload: {
        send: [{ name: "enrollment_date" }],
        receive: [{ name: "case_id" }],
      },
    },
    {
      ...termsB,
      payload: {
        send: [{ name: "case_id" }],
        receive: [{ name: "wrong_column" }],
      },
    },
  );
  expect(errors.some((e) => e.includes("payload mismatch"))).toBe(true);
});

test("matching payload send/receive columns are compatible", () => {
  const { errors } = validateCompatibility(
    {
      ...termsA,
      payload: {
        send: [{ name: "enrollment_date" }],
        receive: [{ name: "case_id" }],
      },
    },
    {
      ...termsB,
      payload: {
        send: [{ name: "case_id" }],
        receive: [{ name: "enrollment_date" }],
      },
    },
  );
  expect(errors.filter((e) => e.includes("payload"))).toHaveLength(0);
});

test("payload is lazy: an unauthored receive accepts any partner send", () => {
  // The invite/accept shape: the inviter authors a send and leaves receive unset
  // (lazy), the acceptor mirrors that send into its own receive. The inviter's lazy
  // direction (its absent receive vs the acceptor's send) is skipped, so the
  // acceptor may disclose columns the inviter never enumerated without aborting.
  const inviter = {
    ...termsA,
    payload: { send: [{ name: "enrollment_date" }] },
  };
  const acceptor = {
    ...termsB,
    payload: {
      send: [{ name: "case_id" }, { name: "extra_col" }],
      receive: [{ name: "enrollment_date" }],
    },
  };
  expect(
    validateCompatibility(inviter, acceptor).errors.filter((e) =>
      e.includes("payload"),
    ),
  ).toHaveLength(0);
  expect(
    validateCompatibility(acceptor, inviter).errors.filter((e) =>
      e.includes("payload"),
    ),
  ).toHaveLength(0);
});

test("payload is lazy on both sides when neither authors a receive (zero-setup)", () => {
  // Neither party declares a receive: each sends its own disclosed columns and
  // takes whatever the other sends, so no payload mismatch can fire even though the
  // two send lists differ.
  const x = { ...termsA, payload: { send: [{ name: "a_col" }] } };
  const y = { ...termsB, payload: { send: [{ name: "b_col" }] } };
  expect(
    validateCompatibility(x, y).errors.filter((e) => e.includes("payload")),
  ).toHaveLength(0);
  expect(
    validateCompatibility(y, x).errors.filter((e) => e.includes("payload")),
  ).toHaveLength(0);
});

test("a declared receive still aborts when the partner's send does not satisfy it", () => {
  // Strict mode is preserved: a party that declares a receive (a loaded/recurring
  // config) demands the partner send exactly that, even when the reverse direction
  // is lazy.
  const local = { ...termsA, payload: { receive: [{ name: "needed_col" }] } };
  const partner = {
    ...termsB,
    payload: { send: [{ name: "something_else" }] },
  };
  expect(
    validateCompatibility(local, partner).errors.some((e) =>
      e.includes("payload mismatch"),
    ),
  ).toBe(true);
});

test("an explicit empty receive: [] is strict and aborts a partner that sends columns (local side)", () => {
  // Decision: an explicit `receive: []` is STRICT, not lazy. It asserts "the
  // partner sends nothing" -- distinct from an ABSENT receive (lazy) -- so it
  // takes the present-field branch of the gate and a partner that discloses any
  // column fails the check. This agrees with the received-payload runtime
  // enforcement (an empty committed set is strict) and the web consent
  // display's "(none)" commitment; treating [] as lazy here would admit an
  // exchange that enforcement later aborts.
  const local = { ...termsA, payload: { receive: [] } };
  const partner = {
    ...termsB,
    payload: { send: [{ name: "disclosed_col" }] },
  };
  // The diagnostic names the empty-declaration meaning rather than printing an
  // empty bracket pair, and points the operator at the lazy alternative.
  expect(
    validateCompatibility(local, partner).errors.some(
      (e) =>
        e.includes("payload mismatch") &&
        e.includes("local declared an empty payload.receive") &&
        e.includes("Omit payload.receive"),
    ),
  ).toBe(true);
});

test("an explicit empty receive: [] is strict and aborts a partner that sends columns (partner side)", () => {
  // The symmetric direction: the empty declaration on the PARTNER's receive aborts
  // against the local send, so the two parties (which call this with swapped
  // arguments) reach the same verdict as the local-side case above.
  const local = {
    ...termsA,
    payload: { send: [{ name: "disclosed_col" }] },
  };
  const partner = { ...termsB, payload: { receive: [] } };
  expect(
    validateCompatibility(local, partner).errors.some(
      (e) =>
        e.includes("payload mismatch") &&
        e.includes("partner declared an empty payload.receive"),
    ),
  ).toBe(true);
});

test("an explicit empty receive: [] is satisfied when the partner sends nothing", () => {
  // The strict empty assertion ("the partner sends nothing") is HONORED, not
  // violated, when the partner declares no send -- absent payload or an explicit
  // empty send -- so no payload mismatch fires. This is the case the strict reading
  // is meant to permit.
  const local = { ...termsA, payload: { receive: [] } };
  const partnerNoPayload = { ...termsB };
  const partnerEmptySend = { ...termsB, payload: { send: [] } };
  expect(
    validateCompatibility(local, partnerNoPayload).errors.filter((e) =>
      e.includes("payload"),
    ),
  ).toHaveLength(0);
  expect(
    validateCompatibility(local, partnerEmptySend).errors.filter((e) =>
      e.includes("payload"),
    ),
  ).toHaveLength(0);
});

test("both parties declaring an empty receive is compatible (neither sends)", () => {
  // A coherent shape: both parties strictly declare they receive nothing, and
  // neither sends. Both strict-empty gates compare [] against [] and pass, in
  // either argument order.
  const x = { ...termsA, payload: { receive: [] } };
  const y = { ...termsB, payload: { receive: [] } };
  expect(
    validateCompatibility(x, y).errors.filter((e) => e.includes("payload")),
  ).toHaveLength(0);
  expect(
    validateCompatibility(y, x).errors.filter((e) => e.includes("payload")),
  ).toHaveLength(0);
});

test("payload comparison is element-wise: a comma in a column name does not alias the set", () => {
  // The column-name sets are compared per sorted element, not by a comma-joined
  // string. A partner-controlled name containing the separator must not collapse
  // two distinct sets into an equal join: send ["a,b"] against receive ["a","b"]
  // is a genuine mismatch, not a match.
  const local = {
    ...termsA,
    payload: { send: [{ name: "a,b" }], receive: [{ name: "z" }] },
  };
  const partner = {
    ...termsB,
    payload: { send: [{ name: "z" }], receive: [{ name: "a" }, { name: "b" }] },
  };
  expect(
    validateCompatibility(local, partner).errors.some((e) =>
      e.includes("payload mismatch"),
    ),
  ).toBe(true);
});

// --- validateCompatibility: partner-string sanitization ----------------------
// A mismatch echoes a partner-supplied value into operator-facing output; these
// pin that every such value is neutralized (control/ANSI and deceptive Unicode
// escaped, over-long values truncated) while ordinary values and the mismatch
// detection itself are unaffected.
//
// Asserted at the RENDERED boundary, never on the raw error string: an error is
// composed from raw fragments and escaped once where it is shown, so a raw
// assertion would pin the wrong altitude -- it would pass just as well on a value
// that reaches the operator escaped twice, which is the defect this convention
// exists to catch.
const rendered = (message: string): string =>
  sanitizeErrorForDisplay(new Error(message));

const withAgreement = (
  terms: LinkageTerms,
  reference: string,
  purpose: string,
): LinkageTerms => ({
  ...terms,
  legalAgreement: { reference, purpose, expirationDate: "2030-01-01" },
});

test("a partner reference with an ANSI/control sequence is neutralized", () => {
  const { errors } = validateCompatibility(
    withAgreement(termsA, "MOU-001", "Care coordination"),
    withAgreement(termsB, "MOU-\x1b[31m002\x1b[0m", "Care coordination"),
  );
  const msg = errors.find((e) =>
    e.includes("legal agreement reference mismatch"),
  );
  expect(msg).toBeDefined();
  // The raw ESC is gone (no terminal injection); it survives as the display
  // boundary's own visible marker rather than as the escape's `\xHH`, which is
  // what a control character psilink itself composed renders to.
  expect(rendered(msg!)).not.toContain("\x1b");
  expect(rendered(msg!)).not.toContain("\\x1b");
  expect(rendered(msg!)).toContain(controlCharacterMarker(0x1b));
  // The trusted local value is intact and the mismatch is still reported.
  expect(rendered(msg!)).toContain('"MOU-001"');
});

test("a partner value with bidi-override / zero-width characters is neutralized", () => {
  const { errors } = validateCompatibility(
    withAgreement(termsA, "MOU-001", "Care coordination"),
    withAgreement(termsB, "MOU-001", "Care\u200b coordination\u202eEVIL"),
  );
  const msg = errors.find((e) =>
    e.includes("legal agreement purpose mismatch"),
  );
  expect(msg).toBeDefined();
  expect(rendered(msg!)).not.toContain("\u200b");
  expect(rendered(msg!)).not.toContain("\u202e");
  expect(rendered(msg!)).toContain("\\u200b");
  expect(rendered(msg!)).toContain("\\u202e");
});

test("an over-long partner value is truncated with the marker", () => {
  // Sized past the budget the RENDERER charges a composed message, which is
  // where this value meets a cap: the composition site interpolates it raw and
  // the display boundary escapes and caps the whole link once.
  const hostile = "B".repeat(COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH + 100);
  const { errors } = validateCompatibility(
    withAgreement(termsA, "MOU-001", "Care coordination"),
    withAgreement(termsB, hostile, "Care coordination"),
  );
  const msg = errors.find((e) =>
    e.includes("legal agreement reference mismatch"),
  );
  expect(msg).toBeDefined();
  expect(rendered(msg!)).not.toContain(hostile);
  expect(rendered(msg!)).toContain(DISPLAY_TRUNCATION_MARKER);
});

test("an ordinary partner value passes through the error unchanged", () => {
  const { errors } = validateCompatibility(
    withAgreement(termsA, "MOU-001", "Care coordination"),
    withAgreement(termsB, "MOU-9999", "Care coordination"),
  );
  const msg = errors.find((e) =>
    e.includes("legal agreement reference mismatch"),
  );
  expect(msg).toBeDefined();
  expect(msg).toContain('"MOU-9999"');
});

test("a partner payload column name with a control sequence is neutralized", () => {
  const { errors } = validateCompatibility(
    {
      ...termsA,
      payload: { send: [{ name: "case_id" }], receive: [{ name: "x" }] },
    },
    {
      ...termsB,
      payload: {
        send: [{ name: "x" }],
        receive: [{ name: "case_id\x1b[31m" }],
      },
    },
  );
  const msg = errors.find((e) => e.includes("payload mismatch"));
  expect(msg).toBeDefined();
  expect(rendered(msg!)).not.toContain("\x1b");
  expect(rendered(msg!)).not.toContain("\\x1b");
  expect(rendered(msg!)).toContain(controlCharacterMarker(0x1b));
});

test("the empty-receive diagnostic neutralizes a partner-supplied send column name", () => {
  // The empty-receive branch is a DIFFERENT code path from the non-empty mismatch
  // above and embeds the SENDER's column names in the message. When local strictly
  // declares receive:[] and the partner's advertised send names hold a control
  // sequence, those partner-controlled names must still be sanitized in the
  // operator-facing diagnostic -- the non-empty test above does not reach this
  // branch.
  const { errors } = validateCompatibility(
    { ...termsA, payload: { receive: [] } },
    { ...termsB, payload: { send: [{ name: "case_id\x1b[31m" }] } },
  );
  const msg = errors.find((e) => e.includes("payload mismatch"));
  expect(msg).toBeDefined();
  expect(msg).toContain("local declared an empty payload.receive");
  expect(rendered(msg!)).not.toContain("\x1b");
  expect(rendered(msg!)).not.toContain("\\x1b");
  expect(rendered(msg!)).toContain(controlCharacterMarker(0x1b));
});

// --- deduplicate: no cross-party consistency check ---------------------------
// Each party independently decides whether to deduplicate its own inputs.
// The only related cross-party constraint is that a deduplicating party must
// receive output, which is already enforced by the output cross-check.

test("mismatched deduplicate values are not an error", () => {
  const { errors } = validateCompatibility(
    {
      ...termsA,
      deduplicate: true,
      output: { expectsOutput: true, shareWithPartner: true },
    },
    {
      ...termsB,
      deduplicate: false,
      output: { expectsOutput: true, shareWithPartner: true },
    },
  );
  expect(errors).toHaveLength(0);
});

test("both parties deduplicating is compatible when both expect output", () => {
  const { errors } = validateCompatibility(
    {
      ...termsA,
      deduplicate: true,
      output: { expectsOutput: true, shareWithPartner: true },
    },
    {
      ...termsB,
      deduplicate: true,
      output: { expectsOutput: true, shareWithPartner: true },
    },
  );
  expect(errors).toHaveLength(0);
});

// --- Acceptor term derivation (output mirror) --------------------------------

// The acceptor adopts the inviter's agreed fields/keys but mirrors the output
// direction and substitutes its identity (deriveAcceptedLinkageTerms). These pin
// that the derived terms are the MIRROR of the inviter's, not a verbatim copy, and
// that they pass validateCompatibility for each of the three output directions --
// the property the editor's 3-way control relies on.
const inviterBase: LinkageTerms = {
  version: "1.0.0",
  identity: "Inviting Org",
  date: "2025-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};

test.each([
  {
    direction: "both",
    inviter: { expectsOutput: true, shareWithPartner: true },
    acceptor: { expectsOutput: true, shareWithPartner: true },
  },
  {
    direction: "inviter-only",
    inviter: { expectsOutput: true, shareWithPartner: false },
    acceptor: { expectsOutput: false, shareWithPartner: true },
  },
  {
    direction: "partner-only",
    inviter: { expectsOutput: false, shareWithPartner: true },
    acceptor: { expectsOutput: true, shareWithPartner: false },
  },
])(
  "deriveAcceptedLinkageTerms mirrors the output for the $direction case and passes validateCompatibility",
  ({ inviter, acceptor }) => {
    const inviterTerms: LinkageTerms = { ...inviterBase, output: inviter };
    const derived = deriveAcceptedLinkageTerms(inviterTerms, "Accepting Org");

    // Output is the mirror, not a copy: the acceptor's expectsOutput is the
    // inviter's shareWithPartner and vice versa.
    expect(derived.output).toStrictEqual(acceptor);
    // Identity is the acceptor's; the inviter's does not leak in.
    expect(derived.identity).toBe("Accepting Org");
    // The agreed fields/keys are adopted verbatim.
    expect(derived.linkageFields).toEqual(inviterTerms.linkageFields);
    expect(derived.linkageKeys).toEqual(inviterTerms.linkageKeys);

    // The mirror is exactly what validateCompatibility (run by both parties)
    // requires: no output mismatch, from either side's point of view.
    expect(validateCompatibility(inviterTerms, derived).errors).toEqual([]);
    expect(validateCompatibility(derived, inviterTerms).errors).toEqual([]);
  },
);

test("deriveAcceptedLinkageTerms does not mutate the inviter's terms", () => {
  const inviterTerms: LinkageTerms = {
    ...inviterBase,
    output: { expectsOutput: true, shareWithPartner: false },
  };
  deriveAcceptedLinkageTerms(inviterTerms, "Accepting Org");
  // The substitution and mirror are a copy: the source is untouched.
  expect(inviterTerms.identity).toBe("Inviting Org");
  expect(inviterTerms.output).toStrictEqual({
    expectsOutput: true,
    shareWithPartner: false,
  });
});

test("a verbatim copy of one-sided inviter output would FAIL the mirror (why mirror, not copy)", () => {
  const inviterTerms: LinkageTerms = {
    ...inviterBase,
    output: { expectsOutput: true, shareWithPartner: false },
  };
  const verbatim: LinkageTerms = {
    ...inviterTerms,
    identity: "Accepting Org",
    // No mirror: copy the inviter's output as-is.
    output: { ...inviterTerms.output },
  };
  expect(
    validateCompatibility(inviterTerms, verbatim).errors.length,
  ).toBeGreaterThan(0);
});

test.each([
  {
    direction: "both-receive",
    output: { expectsOutput: true, shareWithPartner: true },
  },
  {
    direction: "sole-receiver",
    output: { expectsOutput: true, shareWithPartner: false },
  },
])(
  "deriveAcceptedLinkageTerms derives the acceptor's deduplicate as false ($direction)",
  ({ output }) => {
    // The acceptor's own side of the cardinality is never the inviter's to set, so
    // it is derived rather than read off the invitation, for either output shape and
    // for either value the invitation holds. That is what closes the flip: a
    // hostile inviter declaring `true` and then presenting `false` at the terms
    // exchange cannot make this party the "many" side, because this party's value
    // was never the invitation's.
    for (const declared of [false, true]) {
      const inviterTerms: LinkageTerms = {
        ...inviterBase,
        deduplicate: declared,
        output,
      };
      const derived = deriveAcceptedLinkageTerms(inviterTerms, "Accepting Org");
      expect(derived.deduplicate).toBe(false);
      // Derived, not refused: the rest of the terms come through, and the pair the
      // two documents make is the runnable one-sided one rather than an abort.
      expect(derived.identity).toBe("Accepting Org");
      expect(derived.linkageKeys).toEqual(inviterTerms.linkageKeys);
      // `deduplicate` holds no cross-party consistency rule -- the differing
      // pair IS the one-sided run -- so it passes compatibility from both sides.
      // What binds the inviter's side is not an equality rule here but the
      // invitation's own declaration, held at the run boundary
      // (assertPresentedDeduplicateMatchesInvitation).
      expect(validateCompatibility(inviterTerms, derived).errors).toEqual([]);
      expect(validateCompatibility(derived, inviterTerms).errors).toEqual([]);
      expect(() =>
        assertPresentedDeduplicateMatchesInvitation(declared, declared),
      ).not.toThrow();
      expect(() =>
        assertPresentedDeduplicateMatchesInvitation(declared, !declared),
      ).toThrow(InvitationTermDivergenceError);
    }
  },
);

test("nothing binds a deduplicate pair authored from two configuration files", () => {
  // The scope of the binding above: it is the INVITATION's declaration this
  // party consented to, not a cross-party equality rule. Two parties that
  // authored their own documents have no such declaration between them, and the
  // difference is what makes one of them the "many" side -- so the pair runs.
  const many: LinkageTerms = { ...inviterBase, deduplicate: true };
  const one: LinkageTerms = { ...inviterBase, identity: "Other Org" };
  expect(validateCompatibility(many, one).errors).toEqual([]);
  expect(validateCompatibility(one, many).errors).toEqual([]);
  for (const presented of [false, true])
    expect(() =>
      assertPresentedDeduplicateMatchesInvitation(undefined, presented),
    ).not.toThrow();
});

test("deriveAcceptedLinkageTerms fails closed when the mirror is incoherent (payload.send to a non-receiving partner)", () => {
  // Same shape via payload, but through the MIRROR: an inviter that is the sole
  // receiver (shareWithPartner: false) yet declares a payload.send is asking the
  // partner to send columns for matched records the partner never receives. The
  // acceptor mirrors that send into its own receive while mirroring to
  // expectsOutput: false, which the schema forbids -- so the derivation throws
  // rather than produce an invalid, never-re-validated config. (This is the case
  // the web editor blocks live: see the advanced-invite coherence rule.)
  const inviterTerms: LinkageTerms = {
    ...inviterBase,
    output: { expectsOutput: true, shareWithPartner: false },
    payload: { send: [{ name: "dose" }] },
  };
  let thrown: unknown;
  try {
    deriveAcceptedLinkageTerms(inviterTerms, "Accepting Org");
  } catch (e) {
    thrown = e;
  }
  // An acceptor identity the free-text rule admits leaves the mirror as the
  // thing refused, so the account stays the invitation's.
  expect((thrown as Error).message).toContain("cannot be accepted unchanged");
  expect((thrown as Error).message).not.toContain(TEXT_CONTROL_CHAR_MESSAGE);
});

test("deriveAcceptedLinkageTerms refuses a control character in the ACCEPTOR's own identity", () => {
  // The acceptor's identity is operator-supplied free text -- the CLI trims a
  // flag or prompt value, the browser field passes one through -- so a control
  // character in it reaches the mirror. Substituted unchecked it would fail the
  // re-check at the end of the derivation, whose account is the invitation's:
  // the operator would be sent to its partner over a name it typed itself.
  let thrown: unknown;
  try {
    deriveAcceptedLinkageTerms(inviterBase, "Agency\tA of quarantined-county");
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(UsageError);
  const { message } = thrown as Error;
  expect(message).toContain(TEXT_CONTROL_CHAR_MESSAGE);
  expect(message).not.toContain("cannot be accepted unchanged");
  // Fixed prose, naming the local input rather than quoting it: no byte of the
  // submitted identity is echoed back, the discipline the schema's own message
  // for this rule follows.
  expect(message).not.toContain("quarantined-county");
  expect(message).not.toContain("\t");
});

test.each([
  ["an empty", ""],
  ["an over-length", "A".repeat(MAX_TEXT_LENGTH + 1)],
])(
  "deriveAcceptedLinkageTerms refuses %s ACCEPTOR identity as a local input",
  (_label, identity) => {
    // The schema's own floor and ceiling on a party identity, applied where the
    // control-character rule already is. Substituted unchecked, either value fails
    // the re-check at the end of the derivation instead, whose account is the
    // invitation's -- so the operator would be told psilink cannot accept its
    // partner's invitation over a name it supplied itself.
    let thrown: unknown;
    try {
      deriveAcceptedLinkageTerms(inviterBase, identity);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UsageError);
    const { message } = thrown as Error;
    expect(message).toContain("the identity supplied for this party");
    expect(message).not.toContain("cannot be accepted unchanged");
  },
);

test("deriveAcceptedLinkageTerms accepts an acceptor identity at the length ceiling", () => {
  // The ceiling is the schema's own, so the longest identity the document admits
  // is not refused by the entry check drawn beside it.
  const identity = "A".repeat(MAX_TEXT_LENGTH);
  expect(deriveAcceptedLinkageTerms(inviterBase, identity).identity).toBe(
    identity,
  );
});

test("deriveAcceptedLinkageTerms mirrors payload send/receive (asymmetric invite/accept shape)", () => {
  // The common invite/accept shape: the inviter authors a payload.send (columns it
  // will give the partner) and leaves receive unauthored (lazy -- it takes whatever
  // the partner discloses). The acceptor's payload is the MIRROR: receive becomes
  // the inviter's send (so it validates exactly what it gets) and send comes out
  // absent (the inviter's absent receive), keeping the acceptor lazy on that
  // direction. Both sides pass validateCompatibility.
  const inviterTerms: LinkageTerms = {
    ...inviterBase,
    output: { expectsOutput: true, shareWithPartner: true },
    payload: {
      send: [{ name: "enrollment_date", description: "Date enrolled" }],
    },
  };
  const derived = deriveAcceptedLinkageTerms(inviterTerms, "Accepting Org");
  expect(derived.payload).toStrictEqual({
    receive: [{ name: "enrollment_date", description: "Date enrolled" }],
  });
  expect(derived.payload?.send).toBeUndefined();
  expect(validateCompatibility(inviterTerms, derived).errors).toEqual([]);
  expect(validateCompatibility(derived, inviterTerms).errors).toEqual([]);
});

test("deriveAcceptedLinkageTerms mirrors an explicit empty inviter receive to an explicit empty acceptor send", () => {
  // Decision: an explicit `receive: []` is strict. The acceptor mirror passes
  // it through as an explicit empty `send: []` -- present, not absent -- so the
  // inviter's strict "send me nothing" becomes the acceptor's strict "I send
  // nothing." (An ABSENT inviter receive instead yields an absent acceptor
  // send, the lazy case the asymmetric-shape test above covers.) The mirror stays
  // coherent: both directions pass validateCompatibility.
  const inviterTerms: LinkageTerms = {
    ...inviterBase,
    output: { expectsOutput: true, shareWithPartner: true },
    payload: { receive: [] },
  };
  const derived = deriveAcceptedLinkageTerms(inviterTerms, "Accepting Org");
  expect(derived.payload).toStrictEqual({ send: [] });
  expect(derived.payload?.receive).toBeUndefined();
  expect(validateCompatibility(inviterTerms, derived).errors).toEqual([]);
  expect(validateCompatibility(derived, inviterTerms).errors).toEqual([]);
});

test("deriveAcceptedLinkageTerms mirrors an explicit empty inviter send to an explicit empty acceptor receive", () => {
  // The opposite-direction mirror of the case above: an inviter that declares an
  // explicit empty `payload.send` must produce an acceptor with an explicit empty
  // `receive` -- present, not absent -- preserving the strict reading on that
  // direction (a future `?.length > 0` mirror guard would silently make the
  // acceptor lazy here). The mirror stays coherent: both directions pass
  // validateCompatibility.
  const inviterTerms: LinkageTerms = {
    ...inviterBase,
    output: { expectsOutput: true, shareWithPartner: true },
    payload: { send: [] },
  };
  const derived = deriveAcceptedLinkageTerms(inviterTerms, "Accepting Org");
  expect(derived.payload).toStrictEqual({ receive: [] });
  expect(derived.payload?.send).toBeUndefined();
  expect(validateCompatibility(inviterTerms, derived).errors).toEqual([]);
  expect(validateCompatibility(derived, inviterTerms).errors).toEqual([]);
});

test("deriveAcceptedLinkageTerms accepts a sole-receiver inviter that REQUESTS payload (mirror is coherent)", () => {
  // An inviter sole-receiver (shareWithPartner: false) may validly REQUEST payload
  // (payload.receive): it receives output, so it can attach what it receives. The
  // mirror turns that into the acceptor SENDING (payload.send) while it receives no
  // output -- which is coherent (sending needs no output) -- so the derivation must
  // NOT throw, and the acceptor's receive stays absent (lazy).
  const inviterTerms: LinkageTerms = {
    ...inviterBase,
    output: { expectsOutput: true, shareWithPartner: false },
    payload: { receive: [{ name: "dob" }] },
  };
  const derived = deriveAcceptedLinkageTerms(inviterTerms, "Accepting Org");
  expect(derived.payload).toStrictEqual({ send: [{ name: "dob" }] });
  expect(derived.payload?.receive).toBeUndefined();
  expect(validateCompatibility(inviterTerms, derived).errors).toEqual([]);
  expect(validateCompatibility(derived, inviterTerms).errors).toEqual([]);
});
