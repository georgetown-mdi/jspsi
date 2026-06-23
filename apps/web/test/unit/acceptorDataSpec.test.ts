import { describe, expect, test } from "vitest";

import {
  assessLinkageSatisfiability,
  computeTermsHash,
  getDefaultStandardization,
  inferMetadata,
  prepareForExchange,
  validateCompatibility,
} from "@psilink/core";

import {
  disclosedColumnNames,
  normalizeForEditor,
  setColumnDisclosure,
  setColumnType,
} from "../../src/psi/metadataEditing.js";
import { acceptorExchangeDataSpec } from "../../src/psi/acceptInvitation.js";

import type { ExchangeDataSpec, LinkageTerms, Metadata } from "@psilink/core";

// Two single-field keys, so the acceptor's columns can satisfy both, one, or
// neither depending on how the metadata binds them.
const terms: LinkageTerms = {
  version: "1.0.0",
  identity: "Inviter",
  date: "2026-01-01",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "firstName", type: "first_name" },
    { name: "lastName", type: "last_name" },
  ],
  linkageKeys: [
    { name: "first", elements: [{ field: "firstName" }] },
    { name: "last", elements: [{ field: "lastName" }] },
  ],
};

// Columns whose names do NOT infer to the linkage types, so the operator must
// remap them in the editor for the file to comply.
const columns = ["a", "b", "extra"];
const rawRows = [{ a: "Alice", b: "Smith", extra: "secret" }];

/** Pull the (always-present) linkage terms off a spec, narrowing the optional. */
function termsOf(spec: ExchangeDataSpec): LinkageTerms {
  if (spec.linkageTerms === undefined)
    throw new Error("spec unexpectedly has no linkageTerms");
  return spec.linkageTerms;
}

/** The editor's edited metadata that makes both keys satisfiable: bind `a` to
 * first_name and `b` to last_name, then roll both for matching. A type change
 * alone keeps the inferred `payload` disclosure (a sent column stays sent), and a
 * payload column does not participate in matching, so the explicit `match`
 * (role: linkage) is what makes the keys satisfiable. */
function remappedMetadata(): Metadata {
  let md = normalizeForEditor(inferMetadata(columns));
  md = setColumnType(md, "a", "first_name").metadata;
  md = setColumnType(md, "b", "last_name").metadata;
  md = setColumnDisclosure(md, "a", "match").metadata;
  md = setColumnDisclosure(md, "b", "match").metadata;
  return md;
}

describe("acceptorExchangeDataSpec", () => {
  test("substitutes the acceptor identity and omits edits when not prepared", () => {
    const spec = acceptorExchangeDataSpec(terms, "Acceptor");
    expect(termsOf(spec).identity).toBe("Acceptor");
    expect(spec.metadata).toBeUndefined();
    expect(spec.standardization).toBeUndefined();
  });

  test("carries the edited metadata and standardization when prepared", () => {
    const md = remappedMetadata();
    const std = getDefaultStandardization(md, terms);
    const spec = acceptorExchangeDataSpec(terms, "Acceptor", {
      metadata: md,
      standardization: std,
    });
    expect(spec.metadata).toEqual(md);
    expect(spec.standardization).toEqual(std);
  });

  test("mirrors the inviter's payload: an asymmetric send becomes the acceptor's receive", () => {
    // The common invite/accept shape: the inviter authors a send and leaves receive
    // unset. The acceptor's derived terms mirror it -- receive = the inviter's send
    // (so it validates exactly what it gets) -- while its own send stays open (it
    // takes its disclosure from its metadata; the inviter is lazy on receive).
    const inviterTerms: LinkageTerms = {
      ...terms,
      payload: { send: [{ name: "enrollment_date" }] },
    };
    const accepted = termsOf(
      acceptorExchangeDataSpec(inviterTerms, "Acceptor"),
    );
    expect(accepted.payload).toStrictEqual({
      receive: [{ name: "enrollment_date" }],
    });
    expect(accepted.payload?.send).toBeUndefined();
    expect(validateCompatibility(inviterTerms, accepted).errors).toEqual([]);
    expect(validateCompatibility(accepted, inviterTerms).errors).toEqual([]);
  });
});

describe("editing metadata changes the verdict and reaches the run", () => {
  test("an inferred-metadata verdict blocks; the remap makes it satisfiable", () => {
    const inferred = inferMetadata(columns);
    expect(
      assessLinkageSatisfiability(columns, terms, undefined, inferred)
        .satisfiableKeyCount,
    ).toBe(0);

    const md = remappedMetadata();
    const std = getDefaultStandardization(md, terms);
    // The editor computes the verdict from the SAME { metadata, standardization }
    // it threads into the spec.
    expect(
      assessLinkageSatisfiability(columns, terms, std, md).satisfiableKeyCount,
    ).toBe(2);
  });

  test("prepareForExchange consumes the edited spec, not CSV inference", () => {
    const md = remappedMetadata();
    const std = getDefaultStandardization(md, terms);
    const spec = acceptorExchangeDataSpec(terms, "Acceptor", {
      metadata: md,
      standardization: std,
    });
    const prepared = prepareForExchange(spec, "Acceptor", rawRows, columns);
    // The edited metadata is used verbatim (not re-inferred), and the explicit
    // standardization validates cleanly (its outputs are declared linkage fields).
    expect(prepared.metadata).toEqual(md);
    expect(prepared.warnings).toEqual([]);
  });
});

describe("cross-party-hash invariance under acceptor edits", () => {
  test("metadata/standardization edits leave the agreement hash and compat verdict unchanged", async () => {
    const partner = terms; // the inviter's terms the acceptor adopted
    const md = remappedMetadata();
    const std = getDefaultStandardization(md, terms);

    const baseline = acceptorExchangeDataSpec(terms, "Acceptor");
    const edited = acceptorExchangeDataSpec(terms, "Acceptor", {
      metadata: md,
      standardization: std,
    });
    // A genuine disclosure change: mark `extra` as sent to the partner.
    const disclosedMd = setColumnDisclosure(md, "extra", "payload").metadata;
    expect(disclosedColumnNames(disclosedMd)).toContain("extra");
    const disclosed = acceptorExchangeDataSpec(terms, "Acceptor", {
      metadata: disclosedMd,
      standardization: std,
    });

    // The agreed terms in the spec are byte-identical regardless of the edits --
    // metadata/standardization live outside LinkageTerms.
    expect(termsOf(edited)).toEqual(termsOf(baseline));
    expect(termsOf(disclosed)).toEqual(termsOf(baseline));

    const hashBaseline = await computeTermsHash(termsOf(baseline), partner);
    const hashEdited = await computeTermsHash(termsOf(edited), partner);
    const hashDisclosed = await computeTermsHash(termsOf(disclosed), partner);
    expect(hashEdited).toBe(hashBaseline);
    // Even a disclosure change does not move the cross-party agreement hash.
    expect(hashDisclosed).toBe(hashBaseline);

    expect(validateCompatibility(termsOf(edited), partner)).toEqual(
      validateCompatibility(termsOf(baseline), partner),
    );
    expect(validateCompatibility(termsOf(disclosed), partner)).toEqual(
      validateCompatibility(termsOf(baseline), partner),
    );
  });
});
