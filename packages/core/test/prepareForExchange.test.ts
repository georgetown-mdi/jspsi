import { expect, test, describe } from "vitest";

import {
  prepareForExchange,
  assertAlgorithmImplemented,
} from "../src/exchange";
import {
  OperatorConfigError,
  StandardizationTermsError,
  UsageError,
} from "../src/errors";

import type { LinkageTerms } from "../src/config/linkageTerms";
import type { Metadata } from "../src/config/metadata";
import type { Standardization } from "../src/config/standardization";
import type { CSVRow } from "../src/file";

// --- Fixtures ----------------------------------------------------------------

// A minimal two-field linkage terms; every fixture below shares it so the only
// variable across the cases is whether (and how) a standardization is authored.
const terms: LinkageTerms = {
  version: "1.0.0",
  identity: "Tester",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "first_name", type: "first_name" },
    { name: "last_name", type: "last_name" },
  ],
  linkageKeys: [
    {
      name: "FN_LN",
      elements: [{ field: "first_name" }, { field: "last_name" }],
    },
  ],
};

const metadata: Metadata = [
  { name: "first_name", type: "first_name", role: "linkage", isPayload: false },
  { name: "last_name", type: "last_name", role: "linkage", isPayload: false },
];

const columns = ["first_name", "last_name"];
const rawRows: Array<CSVRow> = [{ first_name: "Alice", last_name: "Smith" }];

// A standardization every transform of which names a declared linkage field and
// uses a known function -- consistent with `terms`.
const consistentStandardization: Standardization = [
  {
    output: "first_name",
    input: "first_name",
    steps: [{ function: "to_upper_case" }],
  },
  {
    output: "last_name",
    input: "last_name",
    steps: [{ function: "to_upper_case" }],
  },
];

// --- Authoritative config fails closed on an inconsistency -------------------

describe("prepareForExchange: authoritative standardization fails closed", () => {
  test("a standardization output naming no linkage field is rejected", () => {
    const standardization: Standardization = [
      { output: "not_a_field", input: "first_name" },
    ];
    // Today this string was pushed to `warnings` and the exchange proceeded; the
    // authoritative config now breaks on it. The specific type is what lets the web
    // surface this value-free message while keeping the partner-influenceable
    // payload-send UsageError swallowed; assert the subtype, that it stays in the
    // surfaced OperatorConfigError family, and that it remains a UsageError (the
    // CLI's exit-64 gate).
    expect(() =>
      prepareForExchange(
        { linkageTerms: terms, metadata, standardization },
        "Tester",
        rawRows,
        columns,
      ),
    ).toThrow(StandardizationTermsError);
    let thrown: unknown;
    try {
      prepareForExchange(
        { linkageTerms: terms, metadata, standardization },
        "Tester",
        rawRows,
        columns,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(OperatorConfigError);
    expect(thrown).toBeInstanceOf(UsageError);
    // The failure carries the underlying inconsistency through, so an operator
    // can see which output is wrong.
    expect(() =>
      prepareForExchange(
        { linkageTerms: terms, metadata, standardization },
        "Tester",
        rawRows,
        columns,
      ),
    ).toThrow(/not_a_field/);
  });

  test("an unknown standardization function is rejected", () => {
    const standardization: Standardization = [
      {
        output: "first_name",
        input: "first_name",
        steps: [{ function: "does_not_exist" }],
      },
    ];
    expect(() =>
      prepareForExchange(
        { linkageTerms: terms, metadata, standardization },
        "Tester",
        rawRows,
        columns,
      ),
    ).toThrow(StandardizationTermsError);
    expect(() =>
      prepareForExchange(
        { linkageTerms: terms, metadata, standardization },
        "Tester",
        rawRows,
        columns,
      ),
    ).toThrow(/does_not_exist/);
  });
});

// --- Consistent / terms-only configs are unaffected -------------------------

describe("prepareForExchange: consistent and terms-only configs proceed", () => {
  test("a fully consistent authoritative config prepares without error", () => {
    const prepared = prepareForExchange(
      {
        linkageTerms: terms,
        metadata,
        standardization: consistentStandardization,
      },
      "Tester",
      rawRows,
      columns,
    );
    expect(prepared.rowCount).toBe(1);
    expect(prepared.linkageTerms).toBe(terms);
  });

  test("a terms-only spec (no authored standardization) is unaffected", () => {
    // No `standardization`: prepareForExchange reconstructs one via
    // getDefaultStandardization, so this path gains no hard failure from the
    // fail-closed change scoped to the authoritative branch.
    const prepared = prepareForExchange(
      { linkageTerms: terms, metadata },
      "Tester",
      rawRows,
      columns,
    );
    expect(prepared.rowCount).toBe(1);
    expect(prepared.linkageTerms).toBe(terms);
  });
});

// --- Count-only (psi-c) fails closed before connecting -----------------------

describe("prepareForExchange: count-only (psi-c) is refused", () => {
  const psiCTerms: LinkageTerms = { ...terms, algorithm: "psi-c" };

  test("a psi-c algorithm is refused before connecting", () => {
    // No count-only run path exists, so a psi-c run would reveal matched
    // identifiers under a self-attested record asserting only a count. Refuse it
    // before any connection, on every mint/accept path -- not only in the web
    // inviter clamp. It is a UsageError (CLI exit 64) whose message names the
    // fixed enum literal, so an operator sees which value to change.
    expect(() =>
      prepareForExchange(
        { linkageTerms: psiCTerms, metadata },
        "Tester",
        rawRows,
        columns,
      ),
    ).toThrow(UsageError);
    expect(() =>
      prepareForExchange(
        { linkageTerms: psiCTerms, metadata },
        "Tester",
        rawRows,
        columns,
      ),
    ).toThrow(/psi-c/);
  });

  test("a psi algorithm prepares normally", () => {
    // The sibling of the refusal: the implemented algorithm is unaffected.
    const prepared = prepareForExchange(
      { linkageTerms: terms, metadata },
      "Tester",
      rawRows,
      columns,
    );
    expect(prepared.linkageTerms.algorithm).toBe("psi");
  });
});

// --- assertAlgorithmImplemented (the shared guard) ---------------------------

describe("assertAlgorithmImplemented", () => {
  test("refuses psi-c", () => {
    expect(() => assertAlgorithmImplemented("psi-c")).toThrow(UsageError);
  });

  test("passes psi", () => {
    expect(() => assertAlgorithmImplemented("psi")).not.toThrow();
  });
});
