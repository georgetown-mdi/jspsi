import { describe, expect, test } from "vitest";

import {
  decideLinkageTermsVerdict,
  getDefaultLinkageTerms,
  inferMetadata,
} from "@psilink/core";

import { unlinkableFileAlert } from "@components/UnlinkableFileAlert";

import { linkageRefusalFor } from "@psi/linkageRefusal";

import type { LinkageTerms } from "@psilink/core";

// The one reading of core's linkage-terms verdict every console pre-launch seat
// holds, and the copy the seats that render an alert share. The seats' own gates
// are tested where they live (the acceptor's blocked-reason sentence, the mint's
// typed failure, the direct spine's preview); these pin the shared derivation and
// that its copy is total over the shapes a refusal can take.

/** Terms declaring one key over a partner-authored field name, so a refusal that
 * echoed terms content would show it. */
function termsNamed(keyName: string, fieldName: string): LinkageTerms {
  return {
    version: "1.0.0",
    identity: "County Health Department",
    date: "2026-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: true },
    deduplicate: false,
    linkageFields: [{ name: fieldName, type: "first_name" }],
    linkageKeys: [{ name: keyName, elements: [{ field: fieldName }] }],
  };
}

describe("linkageRefusalFor", () => {
  test("a satisfied verdict carries no refusal, so a seat with none does not block", () => {
    const columns = ["first_name"];
    const verdict = decideLinkageTermsVerdict(
      columns,
      termsNamed("k", "first_name"),
    );
    expect(verdict.fullySatisfied).toBe(true);
    expect(
      linkageRefusalFor(verdict, verdict.unsatisfiedFields),
    ).toBeUndefined();
  });

  test("terms narrowed to no key are the no-linkable-key shape, carrying the passed fields", () => {
    // The direct spine and the quick mint narrow the built-in set to the keys their
    // columns support; narrowed to none, the field types a conforming file would
    // carry come from the UNNARROWED set rather than the verdict's own (empty) one.
    const columns = ["notes"];
    const narrowed = getDefaultLinkageTerms("x", inferMetadata(columns));
    expect(narrowed.linkageKeys).toEqual([]);
    const verdict = decideLinkageTermsVerdict(columns, narrowed);
    const missing = decideLinkageTermsVerdict(
      columns,
      getDefaultLinkageTerms("x"),
    ).unsatisfiedFields;
    const refusal = linkageRefusalFor(verdict, missing);
    expect(refusal?.kind).toBe("no-linkable-key");
    if (refusal?.kind !== "no-linkable-key") throw new Error("unreachable");
    expect(refusal.missingFields).toBe(missing);
  });

  test("declared keys the input falls short of are the shortfall shape", () => {
    const verdict = decideLinkageTermsVerdict(
      ["notes"],
      termsNamed("k", "first_name"),
    );
    const refusal = linkageRefusalFor(verdict, verdict.unsatisfiedFields);
    expect(refusal?.kind).toBe("shortfall");
    if (refusal?.kind !== "shortfall") throw new Error("unreachable");
    expect(refusal.verdict).toBe(verdict);
  });
});

describe("unlinkableFileAlert", () => {
  test("the no-key refusal names the missing field types and a remedy the operator owns", () => {
    const columns = ["notes"];
    const alert = unlinkableFileAlert({
      kind: "no-linkable-key",
      missingFields: decideLinkageTermsVerdict(
        columns,
        getDefaultLinkageTerms("x"),
      ).unsatisfiedFields,
    });
    expect(alert.title).toBe("This file cannot be linked");
    expect(alert.message).toContain("cannot satisfy any default linkage key");
    expect(alert.message).toContain("date_of_birth");
    expect(alert.message).toContain("Choose a file");
  });

  test("the shortfall refusal states core's own fragment and no terms content", () => {
    // The fragment is summarizeLinkageShortfall's, so this notice and the
    // run-boundary refusal it precedes cannot describe one fault in two ways -- and
    // it is counts only, so a partner-authored key name has nothing to ride.
    const verdict = decideLinkageTermsVerdict(
      ["notes"],
      termsNamed("partner-key-name", "partner_field_name"),
    );
    const alert = unlinkableFileAlert({ kind: "shortfall", verdict });
    expect(alert.title).toBe("This file cannot satisfy the linkage terms");
    expect(alert.message).toContain(
      "the one linkage key cannot be produced from this input's columns",
    );
    expect(alert.message).toContain(
      "set terms that declare only the keys the files on both sides can supply",
    );
    // The quick mint renders this alert before any invitation exists, so the
    // first-party copy may not address a partner the operator has not got yet --
    // nor may the shared fragment inside it call the keys agreed.
    expect(alert.message).not.toContain("your partner");
    expect(alert.message).not.toContain("agreed linkage key");
    expect(alert.message).not.toContain("partner-key-name");
    // The unsatisfied FIELDS are named, as the missing-types guidance every seat
    // gives -- escaped at this sink, since they are terms content on an accept.
    expect(alert.message).toContain("partner_field_name");
  });

  test("a dead key's shortfall names the cleaning, not the columns", () => {
    const deadTerms: LinkageTerms = {
      ...termsNamed("k", "dob"),
      linkageFields: [{ name: "dob", type: "date_of_birth" }],
      linkageKeys: [
        {
          name: "k",
          elements: [
            {
              field: "dob",
              transform: [
                { function: "parse_date", params: { inputFormat: "MM/DD" } },
              ],
            },
          ],
        },
      ],
    };
    const verdict = decideLinkageTermsVerdict(["date_of_birth"], deadTerms);
    expect(verdict.deadKeys).toHaveLength(1);
    const alert = unlinkableFileAlert({ kind: "shortfall", verdict });
    expect(alert.message).toContain(
      "the cleaning declared for the one linkage key drops every record",
    );
  });
});
