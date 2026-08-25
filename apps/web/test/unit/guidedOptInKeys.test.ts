import { describe, expect, test } from "vitest";

import {
  DEFAULT_LINKAGE_RULE_SET,
  canonicalString,
  deriveAcceptedLinkageTerms,
  getDefaultLinkageTerms,
  getDefaultStandardization,
  inferMetadata,
  isOptInLinkageKey,
  prepareForExchange,
  safeParseLinkageTerms,
  summarizeInvitation,
} from "@psilink/core";

import {
  buildAdvancedTerms,
  inviterExchangeDataSpec,
  seedAdvancedInvite,
  setDraftMetadata,
  validateAdvancedInvite,
} from "../../src/psi/advancedInvite.js";
import {
  setColumnType,
  setColumnTypeForMatching,
} from "../../src/psi/metadataEditing.js";

import type { AdvancedInviteDraft } from "../../src/psi/advancedInvite.js";

import type { CSVRow } from "@psilink/core";

/**
 * The guided path's opt-in matchable types: a column of a type no built-in key
 * uses is offered as a key of its own, off, and everything about the emitted
 * terms holds still until the operator turns it on.
 */

// A file carrying the built-in key set's types plus a ZIP and a phone column, so
// the built-in keys seed as they always did AND two of the offered keys appear.
const COLUMNS = ["ssn", "first_name", "last_name", "dob", "zip", "phone"];
const ROWS: Array<CSVRow> = [
  {
    ssn: "900-31-2245",
    first_name: "Maria",
    last_name: "Alvarez",
    dob: "03/07/1988",
    zip: "60614-1234",
    phone: "(312) 555-0142",
  },
];

/** A guided draft over {@link COLUMNS}, as reading the file produces it. */
function guidedDraft(): AdvancedInviteDraft {
  return seedAdvancedInvite("Inviter", COLUMNS, ROWS).draft;
}

/** The draft with the named offered key turned on -- the checkbox in the list. */
function withKeyEnabled(
  draft: AdvancedInviteDraft,
  name: string,
): AdvancedInviteDraft {
  return {
    ...draft,
    keys: draft.keys.map((entry) =>
      entry.key.name === name ? { ...entry, enabled: true } : entry,
    ),
  };
}

const offeredKeys = (draft: AdvancedInviteDraft) =>
  draft.keys.filter((entry) => isOptInLinkageKey(entry.key));

describe("the guided key list offers the non-default matchable types", () => {
  test("offers one key per supplied type, off, after the built-in keys", () => {
    const draft = guidedDraft();
    expect(offeredKeys(draft).map((entry) => entry.key.name)).toEqual([
      "PHONE",
      "ZIP",
    ]);
    expect(offeredKeys(draft).every((entry) => entry.enabled)).toBe(false);
    // Built-in first, offers last: list order is cascade order, so an offer sees
    // only what the built-in keys did not claim.
    const firstOffer = draft.keys.findIndex((entry) =>
      isOptInLinkageKey(entry.key),
    );
    expect(
      draft.keys
        .slice(0, firstOffer)
        .some((entry) => isOptInLinkageKey(entry.key)),
    ).toBe(false);
    expect(
      draft.keys
        .slice(firstOffer)
        .every((entry) => isOptInLinkageKey(entry.key)),
    ).toBe(true);
    // Every built-in key the columns supply still arrives on.
    expect(
      draft.keys
        .filter((entry) => !isOptInLinkageKey(entry.key))
        .every((entry) => entry.enabled),
    ).toBe(true);
  });

  test("offers nothing for a type the file does not supply", () => {
    const draft = seedAdvancedInvite("Inviter", [
      "ssn",
      "first_name",
      "last_name",
      "dob",
    ]).draft;
    expect(offeredKeys(draft)).toEqual([]);
  });

  test("offers nothing on a column of the type the operator took off matching", () => {
    // The satisfiability filter the built-in keys are narrowed by: only a
    // `role: linkage` column supplies a matchable type.
    const draft = guidedDraft();
    const { metadata } = setColumnType(draft.metadata, "zip", "other");
    expect(
      offeredKeys(setDraftMetadata(draft, metadata, ROWS)).map(
        (entry) => entry.key.name,
      ),
    ).toEqual(["PHONE"]);
  });
});

describe("an offer left alone changes nothing", () => {
  test("the emitted terms are what the file's columns emitted before the offer existed", () => {
    // The exact bytes both parties hash. An offer sitting in the list unturned
    // must not move them, or every guided invitation's agreement would shift.
    const terms = buildAdvancedTerms(guidedDraft());
    expect(canonicalString(terms)).toEqual(
      canonicalString({
        ...getDefaultLinkageTerms("Inviter", inferMetadata(COLUMNS)),
        date: terms.date,
      }),
    );
  });

  test("the terms still cite the built-in rule set", () => {
    expect(buildAdvancedTerms(guidedDraft()).linkageRuleSet).toEqual(
      DEFAULT_LINKAGE_RULE_SET.reference,
    );
  });

  test("zero-setup over the same columns declares no offered key or field", () => {
    // `getDefaultLinkageTerms` is the zero-setup emitter; the offer is beside it,
    // never inside it.
    const zeroSetup = getDefaultLinkageTerms("Inviter", inferMetadata(COLUMNS));
    for (const key of zeroSetup.linkageKeys)
      expect(isOptInLinkageKey(key)).toBe(false);
    expect(zeroSetup.linkageFields.map((field) => field.type)).not.toContain(
      "zip_code",
    );
  });
});

describe("turning an offer on", () => {
  const enabled = () => withKeyEnabled(guidedDraft(), "ZIP");

  test("puts the key and its field into the emitted terms", () => {
    const terms = buildAdvancedTerms(enabled());
    expect(terms.linkageKeys.map((key) => key.name)).toContain("ZIP");
    expect(terms.linkageFields).toContainEqual({
      name: "zip_code",
      type: "zip_code",
    });
    expect(safeParseLinkageTerms(terms).success).toBe(true);
  });

  test("costs the terms their citation of the built-in set", () => {
    // The departure the guidance copy states, made legible in the document
    // itself: rules carrying a key the set does not declare are not drawn from
    // it, so they no longer claim it.
    expect(buildAdvancedTerms(enabled()).linkageRuleSet).toBeUndefined();
  });

  test("still generates", () => {
    const { draft, seed } = seedAdvancedInvite("Inviter", COLUMNS, ROWS);
    const validation = validateAdvancedInvite(
      withKeyEnabled(draft, "ZIP"),
      seed,
      new Date("2026-06-20T00:00:00.000Z"),
    );
    expect(validation.errors).toEqual({});
    expect(validation.canGenerate).toBe(true);
  });

  test("matches the column through its default pipeline, not raw", () => {
    // The offered types have settled standardization pipelines even though no
    // built-in key uses them. Were the inviter to leave the column uncleaned it
    // would hash "60614-1234" while a partner deriving cleaning from these same
    // terms hashes "60614", and the key would match nothing.
    const draft = enabled();
    const terms = buildAdvancedTerms(draft);
    const prepared = prepareForExchange(
      inviterExchangeDataSpec(terms, {
        metadata: draft.metadata,
        standardization: draft.standardization,
      }),
      "Inviter",
      ROWS,
      COLUMNS,
    );
    expect(prepared.dataset.getField("zip_code")?.get(0)).toEqual(["60614"]);
  });

  test("cleans it exactly as the accepting party derives from the same terms", () => {
    // The acceptor holds no standardization of its own; it derives one from the
    // accepted terms. Both sides must reach the same pipeline for the key to
    // match at all.
    const draft = enabled();
    const terms = buildAdvancedTerms(draft);
    const committed = inviterExchangeDataSpec(terms, {
      metadata: draft.metadata,
      standardization: draft.standardization,
    }).standardization;
    const partnerSide = getDefaultStandardization(
      inferMetadata(COLUMNS),
      deriveAcceptedLinkageTerms(terms, "Acceptor"),
    );
    const stepsFor = (standardization: typeof committed, output: string) =>
      standardization?.find((t) => t.output === output)?.steps;
    expect(stepsFor(committed, "zip_code")).toEqual(
      stepsFor(partnerSide, "zip_code"),
    );
    expect(stepsFor(committed, "zip_code")).not.toEqual([]);
  });

  test("is surfaced on the acceptor's terms review like any other key", () => {
    // The consent surface reads the terms, so an offered key that reached them is
    // disclosed the way a built-in key is: named among the fields matched on, and
    // listed with the breadth its type carries.
    const summary = summarizeInvitation({
      linkageTerms: buildAdvancedTerms(enabled()),
      connectionEndpoint: {
        channel: "webrtc",
        host: "127.0.0.1",
        port: 3000,
        path: "/api/",
      },
    });
    expect(summary.matchedFields).toContain("ZIP");
    expect(summary.linkageFields.map((field) => field.label)).toContain(
      "ZIP code",
    );
    expect(
      summary.linkageKeys.find((key) => key.name === "ZIP")?.headerFields,
    ).toEqual(["ZIP"]);
  });
});

describe("an offer survives a column edit the way a built-in key does", () => {
  test("keeps the operator's own choice across an unrelated retype", () => {
    const draft = withKeyEnabled(guidedDraft(), "ZIP");
    const { metadata } = setColumnType(draft.metadata, "phone", "other");
    const edited = setDraftMetadata(draft, metadata, ROWS);
    expect(offeredKeys(edited).map((entry) => entry.key.name)).toEqual(["ZIP"]);
    // Chosen ON before the edit, still on after it -- the reconciliation does not
    // reset the choice to the flag a fresh offer arrives at.
    expect(offeredKeys(edited)[0].enabled).toBe(true);
  });

  test("arrives off when a retype makes it offerable for the first time", () => {
    const draft = seedAdvancedInvite(
      "Inviter",
      ["ssn", "first_name", "last_name", "dob", "postal"],
      ROWS,
    ).draft;
    expect(offeredKeys(draft)).toEqual([]);
    // The grid's "use this column for matching" edit: an unrecognized header
    // infers to `payload`, so retyping alone would leave it off matching and the
    // offer correctly unoffered.
    const edited = setDraftMetadata(
      draft,
      setColumnTypeForMatching(draft.metadata, "postal", "zip_code"),
      ROWS,
    );
    expect(offeredKeys(edited).map((entry) => entry.key.name)).toEqual(["ZIP"]);
    expect(offeredKeys(edited)[0].enabled).toBe(false);
    // And the retyped column gains its type's cleaning, so turning the key on
    // matches through the pipeline rather than raw.
    expect(
      edited.standardization.find((t) => t.output === "zip_code")?.input,
    ).toBe("postal");
  });

  test("drops when its column stops supplying the type", () => {
    const draft = withKeyEnabled(guidedDraft(), "ZIP");
    const { metadata } = setColumnType(draft.metadata, "zip", "identifier");
    const edited = setDraftMetadata(draft, metadata, ROWS);
    expect(offeredKeys(edited).map((entry) => entry.key.name)).toEqual([
      "PHONE",
    ]);
    expect(
      buildAdvancedTerms(edited).linkageKeys.map((k) => k.name),
    ).not.toContain("ZIP");
  });
});
