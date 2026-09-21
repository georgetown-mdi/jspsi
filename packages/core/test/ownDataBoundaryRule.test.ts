import { expect, test } from "vitest";

import { prepareForExchange } from "../src/exchange";
import { deriveAcceptedLinkageTerms } from "../src/linkageTermsNegotiation";
import { assertLinkageTermsSatisfiable } from "../src/linkageSatisfiability";
import { LinkageTermsUnsatisfiableError } from "../src/errors";
import type { LinkageTerms } from "../src/config/linkageTermsSchema";
import type { Metadata } from "../src/config/metadata";
import type { CSVRow } from "../src/file";

// A check reading this party's own configuration or data fires where that data
// is first bound, and again at the run, because the binding can be redone
// (docs/spec/PROTOCOL.md, Where each refusal over an invitation's own content
// fires). The three binding points each have their own coverage -- the CLI's
// online acceptance and its offline preflight (apps/cli/test/unit/commands/),
// the web's columns step (apps/web/test/unit/acceptorColumns.test.ts) -- and
// what this file pins is the half none of them can state on its own: a verdict
// taken at a binding point does not decide the run, so the run guard stays the
// binding check.

const inviterTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "Inviting Org",
  date: "2026-01-15",
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

const satisfyingColumns = ["first_name", "last_name"];
const satisfyingRows: Array<CSVRow> = [
  { first_name: "Alice", last_name: "Smith" },
];

// The same party's later file, holding one of the two columns the key needs.
const laterColumns = ["first_name"];
const laterRows: Array<CSVRow> = [{ first_name: "Alice" }];

test("a binding point's verdict does not decide the run's", () => {
  const accepted = deriveAcceptedLinkageTerms(inviterTerms, "Accepting Org");

  // The binding point: this party's own file is bound and graded, and passes.
  expect(() =>
    assertLinkageTermsSatisfiable(satisfyingColumns, accepted),
  ).not.toThrow();
  expect(() =>
    prepareForExchange(
      { linkageTerms: accepted, metadata },
      "Accepting Org",
      satisfyingRows,
      satisfyingColumns,
    ),
  ).not.toThrow();

  // The run, over terms that passed at the binding point and a file bound
  // since: the same check refuses it there, which is what the acceptance's
  // verdict could not have answered.
  expect(() =>
    prepareForExchange(
      { linkageTerms: accepted, metadata },
      "Accepting Org",
      laterRows,
      laterColumns,
    ),
  ).toThrow(LinkageTermsUnsatisfiableError);
});

test("the accept boundary grades no input of its own", () => {
  // The accepting party's data is not invitation content, so the accept
  // boundary neither reads it nor refuses over it: an acceptance taken with no
  // file bound yet still derives, and the refusal waits for the binding.
  expect(() =>
    deriveAcceptedLinkageTerms(inviterTerms, "Accepting Org"),
  ).not.toThrow();
  expect(() =>
    assertLinkageTermsSatisfiable(laterColumns, inviterTerms),
  ).toThrow(LinkageTermsUnsatisfiableError);
});
