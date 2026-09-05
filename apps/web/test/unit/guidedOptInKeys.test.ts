import { describe, expect, test } from "vitest";

import {
  DEFAULT_LINKAGE_RULE_SET,
  canonicalString,
  deriveAcceptedLinkageTerms,
  getDefaultLinkageTerms,
  getDefaultStandardization,
  inferMetadata,
  isDrawnFromLinkageRuleSet,
  isOptInLinkageKey,
  mintExchangeFile,
  prepareForExchange,
  safeParseLinkageTerms,
  summarizeInvitation,
  validateStandardizationAgainstTerms,
} from "@psilink/core";

import {
  EMPTY_SAVE_FIELDS,
  exchangeFileInputFor,
} from "@exchange/saveExchangeModel";
import { composeManagedDocument } from "@exchange/manageOfferModel";
import { inviterServerJobConfig } from "@exchange/useInviterExchange";

import {
  buildAdvancedTerms,
  draftFromTerms,
  draftWithKeyEnabled,
  importedCitationDropCause,
  inviterExchangeDataSpec,
  isDraftDrawnFromLinkageRuleSet,
  isOptInDraftKey,
  linkageRuleSetReferenceForDraft,
  seedAdvancedInvite,
  setDraftMetadata,
  setDraftMetadataKeepingKeys,
  validateAdvancedInvite,
} from "../../src/psi/advancedInvite.js";
import {
  setColumnType,
  setColumnTypeForMatching,
} from "../../src/psi/metadataEditing.js";
import { generateInvitation } from "../../src/psi/invitation.js";
import { prepareManagedRerunExchange } from "../../src/psi/managedPreparedExchange.js";

import type {
  AdvancedInviteDraft,
  AdvancedInviteSeed,
} from "../../src/psi/advancedInvite.js";

import type { CSVRow, LinkageKey, LinkageTerms, Metadata } from "@psilink/core";

/**
 * The guided path's opt-in matchable types: a column of a type no built-in key
 * uses is offered inside a compound key, off, and everything about the emitted
 * terms holds still until the operator turns it on.
 */

// A file holding the built-in key set's types plus a ZIP and a phone column, so
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

/** The draft with the named key's checkbox in the list set to `enabled` -- driven
 * through the control the list actually calls, since turning an offer on is what
 * gives its column the cleaning. */
function withKeyEnabled(
  draft: AdvancedInviteDraft,
  name: string,
  enabled = true,
): AdvancedInviteDraft {
  return draftWithKeyEnabled(
    draft,
    draft.keys.findIndex((entry) => entry.key.name === name),
    enabled,
  );
}

const offeredKeys = (draft: AdvancedInviteDraft) =>
  draft.keys.filter((entry) => isOptInLinkageKey(entry.key));

const PHONE_KEY = "LN + FN + DOB + PHONE";
const ZIP_KEY = "LN + FN + DOB + ZIP";

/** The list positions of the named keys, for the placement assertions. */
const positionOf = (draft: AdvancedInviteDraft, name: string) =>
  draft.keys.findIndex((entry) => entry.key.name === name);

describe("the guided key list offers the non-default matchable types", () => {
  test("offers one compound key per supplied type, off", () => {
    const draft = guidedDraft();
    expect(offeredKeys(draft).map((entry) => entry.key.name)).toEqual([
      PHONE_KEY,
      ZIP_KEY,
    ]);
    expect(offeredKeys(draft).every((entry) => entry.enabled)).toBe(false);
    // Each holds its type inside a compound key: a key over one identifier
    // alone would both over-match and answer a membership question.
    for (const entry of offeredKeys(draft))
      expect(entry.key.elements.length).toBeGreaterThanOrEqual(2);
    // Every built-in key the columns supply still arrives on.
    expect(
      draft.keys
        .filter((entry) => !isOptInLinkageKey(entry.key))
        .every((entry) => entry.enabled),
    ).toBe(true);
  });

  test("places each offer above the built-in key it refines", () => {
    // List order is cascade order and a round claims what it matches, so an offer
    // sitting below the key whose elements it extends is left only the records
    // that key could not attribute -- the precision the extra element buys spent
    // on records already taken.
    const draft = guidedDraft();
    const coarser = positionOf(draft, "LN + FN + DOB");
    expect(coarser).toBeGreaterThan(-1);
    expect(positionOf(draft, PHONE_KEY)).toBeLessThan(coarser);
    expect(positionOf(draft, ZIP_KEY)).toBeLessThan(coarser);
    // Nothing else moves: the built-in keys hold the order the set declares them
    // in.
    expect(
      draft.keys
        .filter((entry) => !isOptInLinkageKey(entry.key))
        .map((entry) => entry.key.name),
    ).toEqual(
      getDefaultLinkageTerms("Inviter", inferMetadata(COLUMNS)).linkageKeys.map(
        (key) => key.name,
      ),
    );
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

  test("offers nothing when the file cannot supply the whole compound", () => {
    // Satisfiability runs over every element of the offer, so a file with a ZIP
    // column and no date of birth is offered no ZIP key rather than a thinner one.
    const draft = seedAdvancedInvite(
      "Inviter",
      ["ssn", "first_name", "last_name", "zip"],
      [{ ssn: "900-31-2245", first_name: "M", last_name: "A", zip: "60614" }],
    ).draft;
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
    ).toEqual([PHONE_KEY]);
  });

  test("drops both offers when a column the backbone needs stops matching", () => {
    const draft = guidedDraft();
    const { metadata } = setColumnType(draft.metadata, "dob", "other");
    expect(offeredKeys(setDraftMetadata(draft, metadata, ROWS))).toEqual([]);
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
  const enabled = () => withKeyEnabled(guidedDraft(), ZIP_KEY);

  test("puts the key and its field into the emitted terms", () => {
    const terms = buildAdvancedTerms(enabled());
    expect(terms.linkageKeys.map((key) => key.name)).toContain(ZIP_KEY);
    expect(terms.linkageFields).toContainEqual({
      name: "zip_code",
      type: "zip_code",
    });
    expect(safeParseLinkageTerms(terms).success).toBe(true);
  });

  test("costs the terms their citation of the built-in set", () => {
    // The departure the guidance copy states, made clear in the document
    // itself: rules containing a key the set does not declare are not drawn from
    // it, so they no longer claim it.
    expect(buildAdvancedTerms(enabled()).linkageRuleSet).toBeUndefined();
  });

  test("still generates", () => {
    const { draft, seed } = seedAdvancedInvite("Inviter", COLUMNS, ROWS);
    const validation = validateAdvancedInvite(
      withKeyEnabled(draft, ZIP_KEY),
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

  test("shows up on the acceptor's terms review like any other key", () => {
    // The consent surface reads the terms, so an offered key that reached them is
    // disclosed the way a built-in key is: named among the fields matched on, and
    // listed with the breadth its type holds.
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
    const key = summary.linkageKeys.find((entry) => entry.name === ZIP_KEY);
    expect(key?.headerFields).toContain("ZIP");
    // Every element of the compound is disclosed, not the added one alone.
    expect(key?.headerFields).toHaveLength(4);
  });
});

describe("an offer survives a column edit the way a built-in key does", () => {
  test("keeps the operator's own choice across an unrelated retype", () => {
    const draft = withKeyEnabled(guidedDraft(), ZIP_KEY);
    const { metadata } = setColumnType(draft.metadata, "phone", "other");
    const edited = setDraftMetadata(draft, metadata, ROWS);
    expect(offeredKeys(edited).map((entry) => entry.key.name)).toEqual([
      ZIP_KEY,
    ]);
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
    expect(offeredKeys(edited).map((entry) => entry.key.name)).toEqual([
      ZIP_KEY,
    ]);
    expect(offeredKeys(edited)[0].enabled).toBe(false);
    // And at the position the offer places it, not appended below the key it
    // refines, where turning it on would buy nothing.
    expect(positionOf(edited, ZIP_KEY)).toBeLessThan(
      positionOf(edited, "LN + FN + DOB"),
    );
    // Off, so the retyped column has no cleaning yet -- the draft holds a
    // pipeline for a field only while its terms declare one.
    expect(edited.standardization.some((t) => t.output === "zip_code")).toBe(
      false,
    );
    // Turning the offer on binds the cleaning to the column the retype supplied,
    // so the key matches through the pipeline rather than raw.
    expect(
      withKeyEnabled(edited, ZIP_KEY).standardization.find(
        (t) => t.output === "zip_code",
      )?.input,
    ).toBe("postal");
  });

  test("drops when its column stops supplying the type", () => {
    const draft = withKeyEnabled(guidedDraft(), ZIP_KEY);
    const { metadata } = setColumnType(draft.metadata, "zip", "identifier");
    const edited = setDraftMetadata(draft, metadata, ROWS);
    expect(offeredKeys(edited).map((entry) => entry.key.name)).toEqual([
      PHONE_KEY,
    ]);
    expect(
      buildAdvancedTerms(edited).linkageKeys.map((k) => k.name),
    ).not.toContain(ZIP_KEY);
  });

  test("takes its cleaning with it when a backbone edit drops it", () => {
    // The offer is satisfiable only while every element's column supplies its
    // type, so an edit to a BACKBONE column drops an enabled offer with the
    // offered type's own column untouched. The cleaning goes with the key, exactly
    // as turning the key off by hand withdraws it -- otherwise the data-prep
    // workbench keeps a card for a column no key matches on, over a pipeline the
    // draft's own terms declare no field for.
    const on = withKeyEnabled(guidedDraft(), ZIP_KEY);
    expect(on.standardization.some((t) => t.output === "zip_code")).toBe(true);

    const { metadata } = setColumnType(on.metadata, "dob", "other");
    const edited = setDraftMetadata(on, metadata, ROWS);
    expect(offeredKeys(edited)).toEqual([]);
    expect(edited.standardization.some((t) => t.output === "zip_code")).toBe(
      false,
    );
    expect(edited.standardization.some((t) => t.input === "zip")).toBe(false);
  });
});

describe("a key that only borrows an offer's name is not the offer", () => {
  test("its enabled flag does not transfer onto the offered shape", () => {
    // Reconciliation matches a draft key to an offer through the canonical
    // encoding, the equality the two parties' terms are compared under, not by
    // name. Under name equality this single-element key -- enabled, and named
    // exactly as the offer is -- would hand its flag to the full four-element
    // offered key, turning on an addition the operator never chose and costing
    // the emitted terms their citation of the built-in set.
    const draft = guidedDraft();
    const forged: AdvancedInviteDraft = {
      ...draft,
      keys: draft.keys.map((entry) =>
        entry.key.name === ZIP_KEY
          ? {
              key: { name: ZIP_KEY, elements: [{ field: "zip_code" }] },
              enabled: true,
            }
          : entry,
      ),
    };

    const { metadata } = setColumnType(forged.metadata, "phone", "other");
    const edited = setDraftMetadata(forged, metadata, ROWS);
    const zip = edited.keys.filter((entry) => entry.key.name === ZIP_KEY);
    expect(zip).toHaveLength(1);
    expect(zip[0].key.elements).toHaveLength(4);
    expect(zip[0].enabled).toBe(false);

    const terms = buildAdvancedTerms(edited);
    expect(terms.linkageKeys.map((key) => key.name)).not.toContain(ZIP_KEY);
    expect(terms.linkageRuleSet).toEqual(DEFAULT_LINKAGE_RULE_SET.reference);
  });

  test("a key that cannot be canonically encoded matches no offer", () => {
    // An element transform param outside the canonical domain leaves the key
    // incomparable, which core's own offer comparison answers `false` for. It
    // must not fall back to the name: an unmatchable key is simply no longer
    // offered, and the genuine offer arrives fresh at the flag the offer gives it.
    const draft = guidedDraft();
    const unencodable: AdvancedInviteDraft = {
      ...draft,
      keys: draft.keys.map((entry) =>
        entry.key.name === ZIP_KEY
          ? {
              key: {
                name: ZIP_KEY,
                elements: entry.key.elements.map((element) =>
                  element.field === "zip_code"
                    ? {
                        ...element,
                        transform: [
                          {
                            function: "substring" as const,
                            params: { start: 1, length: 2 ** 53 },
                          },
                        ],
                      }
                    : element,
                ),
              },
              enabled: true,
            }
          : entry,
      ),
    };
    // The assumption: this key is outside the canonical domain, so the
    // reconciliation is reaching its incomparable branch rather than agreeing
    // with the offer by accident.
    expect(() =>
      canonicalString(
        unencodable.keys.find((entry) => entry.key.name === ZIP_KEY)?.key,
      ),
    ).toThrow();

    const edited = setDraftMetadata(unencodable, unencodable.metadata, ROWS);
    const zip = edited.keys.filter((entry) => entry.key.name === ZIP_KEY);
    expect(zip).toHaveLength(1);
    expect(zip[0].enabled).toBe(false);
    expect(zip[0].key.elements.every((el) => el.transform === undefined)).toBe(
      true,
    );
  });
});

describe("an offer re-added over a key of its own name arrives off", () => {
  // The encoding match drops a draft key whose shape no offer holds, and the
  // offer it left unmatched is re-added. A built-in key is offered ON, so a draft
  // holding an older shape under its name -- one stored before the shape changed
  // -- would have that key silently arrive enabled, matching on a rule the
  // operator did not turn on.
  const BACKBONE_KEY = "LN + FN + DOB";
  const SWAPPED_KEY = "swap(LN, FN) + DOB";

  /** `draft` with the named key's elements permuted: the offer's own name over a
   * shape the offer does not match, since element order is cascade-visible and
   * part of the canonical encoding. */
  function withPermutedKey(
    draft: AdvancedInviteDraft,
    name: string,
    enabled: boolean,
  ): AdvancedInviteDraft {
    return {
      ...draft,
      keys: draft.keys.map((entry) =>
        entry.key.name === name
          ? {
              key: {
                ...entry.key,
                elements: [...entry.key.elements].reverse(),
              },
              enabled,
            }
          : entry,
      ),
    };
  }

  /** `draft` with the named key lifted out of the list and re-inserted directly
   * below `below` -- for an offer that refines that key, a position the offer's
   * own placement rule would never choose. */
  function withKeyBelow(
    draft: AdvancedInviteDraft,
    name: string,
    below: string,
  ): AdvancedInviteDraft {
    const rest = draft.keys.filter((entry) => entry.key.name !== name);
    const moved = draft.keys.filter((entry) => entry.key.name === name);
    const at = rest.findIndex((entry) => entry.key.name === below);
    return {
      ...draft,
      keys: [...rest.slice(0, at + 1), ...moved, ...rest.slice(at + 1)],
    };
  }

  /** The offered shape of the named built-in key over {@link COLUMNS}. */
  const offeredShape = (name: string) =>
    getDefaultLinkageTerms("Inviter", inferMetadata(COLUMNS)).linkageKeys.find(
      (key) => key.name === name,
    )?.elements;

  test("a key the operator turned off does not come back on under its name", () => {
    const stale = withPermutedKey(guidedDraft(), BACKBONE_KEY, false);
    const { metadata } = setColumnType(stale.metadata, "phone", "other");
    const edited = setDraftMetadata(stale, metadata, ROWS);

    const arrived = edited.keys.filter(
      (entry) => entry.key.name === BACKBONE_KEY,
    );
    expect(arrived).toHaveLength(1);
    // The offer's shape, not the stale one -- the draft key is dropped.
    expect(arrived[0].key.elements).toEqual(offeredShape(BACKBONE_KEY));
    expect(arrived[0].enabled).toBe(false);
    expect(
      buildAdvancedTerms(edited).linkageKeys.map((key) => key.name),
    ).not.toContain(BACKBONE_KEY);
    // And in the dropped key's own place: cascade order is what each key is left
    // to claim, so a re-offer appended below the keys it outranks would change
    // what the operator's other choices match once this one is turned on.
    expect(positionOf(edited, BACKBONE_KEY)).toBe(
      positionOf(edited, SWAPPED_KEY) - 1,
    );
    expect(edited.keys.map((entry) => entry.key.name)).toEqual(
      setDraftMetadata(guidedDraft(), metadata, ROWS).keys.map(
        (entry) => entry.key.name,
      ),
    );
  });

  test("a key the operator had on arrives off as well", () => {
    // The flag is consent to the key the operator was shown. A shape holding that
    // name is a different matching rule, so the choice does not port onto it --
    // the operator turns the offered rule on themselves.
    const stale = withPermutedKey(guidedDraft(), BACKBONE_KEY, true);
    const { metadata } = setColumnType(stale.metadata, "phone", "other");
    const edited = setDraftMetadata(stale, metadata, ROWS);

    const arrived = edited.keys.filter(
      (entry) => entry.key.name === BACKBONE_KEY,
    );
    expect(arrived).toHaveLength(1);
    expect(arrived[0].key.elements).toEqual(offeredShape(BACKBONE_KEY));
    expect(arrived[0].enabled).toBe(false);
    // And in the dropped key's own place, exactly as for a key the operator had
    // already turned off: the flag is what the shape change costs, never the
    // position, so what the keys below this one are left to claim is unchanged.
    expect(positionOf(edited, BACKBONE_KEY)).toBe(
      positionOf(edited, SWAPPED_KEY) - 1,
    );
    expect(edited.keys.map((entry) => entry.key.name)).toEqual(
      setDraftMetadata(guidedDraft(), metadata, ROWS).keys.map(
        (entry) => entry.key.name,
      ),
    );
  });

  test("an opt-in offer re-added over its own name keeps that key's place", () => {
    // Position is decided by whether the list already held a key of that name,
    // not by which set the offer comes from: the offer's placement rule chooses
    // for a key the list did not hold, and a key it did hold sits where the
    // operator's list puts it. Pinned from BELOW the key it refines -- the one
    // place a fresh offer is never put -- so a re-offer taking the offer's own
    // position would move it.
    const stale = withKeyBelow(
      withPermutedKey(guidedDraft(), ZIP_KEY, false),
      ZIP_KEY,
      BACKBONE_KEY,
    );
    expect(positionOf(guidedDraft(), ZIP_KEY)).toBeLessThan(
      positionOf(guidedDraft(), BACKBONE_KEY),
    );
    expect(positionOf(stale, ZIP_KEY)).toBe(
      positionOf(stale, BACKBONE_KEY) + 1,
    );

    const { metadata } = setColumnType(stale.metadata, "phone", "other");
    const edited = setDraftMetadata(stale, metadata, ROWS);

    const arrived = edited.keys.filter((entry) => entry.key.name === ZIP_KEY);
    expect(arrived).toHaveLength(1);
    // Re-offered, not matched: the offer's own shape, and off as an offer is.
    expect(arrived[0].key.elements).toEqual(
      guidedDraft().keys.find((entry) => entry.key.name === ZIP_KEY)?.key
        .elements,
    );
    expect(arrived[0].enabled).toBe(false);
    expect(positionOf(edited, ZIP_KEY)).toBe(
      positionOf(edited, BACKBONE_KEY) + 1,
    );
  });

  test("a built-in key no dropped entry names still arrives on", () => {
    // The other side of the rule: an offer the edit makes offerable for the first
    // time is not a re-offer, so it arrives at the flag the offer gives it -- the
    // guided path's built-in keys are on, and a retype that supplies a new type
    // must not leave the keys it enables silently unmatched.
    const draft = seedAdvancedInvite(
      "Inviter",
      ["first_name", "last_name", "dob", "taxpayer_id"],
      ROWS,
    ).draft;
    const ssnKeys = (keys: AdvancedInviteDraft["keys"]) =>
      keys.filter((entry) =>
        entry.key.elements.some((element) => element.field === "ssn"),
      );
    expect(ssnKeys(draft.keys)).toEqual([]);

    const edited = setDraftMetadata(
      draft,
      setColumnTypeForMatching(draft.metadata, "taxpayer_id", "ssn"),
      ROWS,
    );
    expect(ssnKeys(edited.keys).length).toBeGreaterThan(0);
    expect(ssnKeys(edited.keys).every((entry) => entry.enabled)).toBe(true);
  });
});

describe("a key stating its optional properties as undefined is the same key", () => {
  /** `draft` with every key's `swap` and every element's `transform` stated
   * explicitly as `undefined` -- what a spread of a property that is not set
   * produces. The key says exactly what the offer says and reads the same on the
   * list, while sitting outside the canonical domain, which rejects an explicit
   * `undefined` where it accepts an absent property. */
  function withUndefinedOptionals(
    draft: AdvancedInviteDraft,
  ): AdvancedInviteDraft {
    return {
      ...draft,
      keys: draft.keys.map((entry) => ({
        ...entry,
        key: {
          ...entry.key,
          swap: entry.key.swap,
          elements: entry.key.elements.map((element) => ({
            ...element,
            transform: element.transform,
          })),
        },
      })),
    };
  }

  test("it reconciles as the key without the properties does", () => {
    const on = withKeyEnabled(guidedDraft(), ZIP_KEY);
    const spread = withUndefinedOptionals(on);
    // The assumption: these keys are outside the canonical domain, so the
    // reconciliation is reaching its incomparable branch rather than agreeing
    // with the offer by accident.
    expect(() => canonicalString(spread.keys[0].key)).toThrow();

    const { metadata } = setColumnType(on.metadata, "phone", "other");
    const reconciled = setDraftMetadata(spread, metadata, ROWS);
    expect(reconciled.keys).toStrictEqual(
      setDraftMetadata(on, metadata, ROWS).keys,
    );
    // The failure this closes: an incomparable key matches no offer, so a draft
    // whose keys ALL have the property arrives entirely off -- the built-in set
    // the operator never touched and the offer they turned on together.
    expect(reconciled.keys.some((entry) => entry.enabled)).toBe(true);
    expect(
      reconciled.keys.find((entry) => entry.key.name === ZIP_KEY)?.enabled,
    ).toBe(true);
  });

  test("a defined optional property is still a difference from the offer", () => {
    // Only the explicit `undefined` is treated as the absent property. An element
    // alias the offer does not hold is a real departure from the offered rule,
    // so the key is still no offer's: it drops and is re-offered off rather than
    // handing the operator's flag to a shape they did not choose.
    const on = withKeyEnabled(guidedDraft(), ZIP_KEY);
    const aliased: AdvancedInviteDraft = {
      ...on,
      keys: on.keys.map((entry) =>
        entry.key.name === ZIP_KEY
          ? {
              ...entry,
              key: {
                ...entry.key,
                elements: entry.key.elements.map((element, at) =>
                  at === 0 ? { ...element, name: "surname" } : element,
                ),
              },
            }
          : entry,
      ),
    };

    const { metadata } = setColumnType(on.metadata, "phone", "other");
    const edited = setDraftMetadata(
      withUndefinedOptionals(aliased),
      metadata,
      ROWS,
    );
    const zip = edited.keys.filter((entry) => entry.key.name === ZIP_KEY);
    expect(zip).toHaveLength(1);
    expect(zip[0].enabled).toBe(false);
    expect(zip[0].key.elements.every((el) => el.name === undefined)).toBe(true);
  });

  test("the offers in the list keep their marker, with no edit in between", () => {
    const spread = withUndefinedOptionals(
      withKeyEnabled(guidedDraft(), ZIP_KEY),
    );
    // The assumption: core's compare -- byte equality under the canonical encoding,
    // which the explicit `undefined` puts the key outside of -- answers `false`
    // for every one of these, so the marker the list renders is the prune's
    // answer rather than one it would have reached anyway.
    expect(spread.keys.some((entry) => isOptInLinkageKey(entry.key))).toBe(
      false,
    );
    expect(
      spread.keys
        .filter((entry) => isOptInDraftKey(entry.key))
        .map((entry) => entry.key.name),
    ).toEqual([PHONE_KEY, ZIP_KEY]);
  });

  test("the built terms keep the citation, with no edit in between", () => {
    // The provenance claim the partner reads: a draft that departed from the
    // built-in set in nothing but the spread still cites it.
    const built = buildAdvancedTerms(withUndefinedOptionals(guidedDraft()));
    expect(isDrawnFromLinkageRuleSet(DEFAULT_LINKAGE_RULE_SET, built)).toBe(
      false,
    );
    expect(built.linkageRuleSet).toEqual(DEFAULT_LINKAGE_RULE_SET.reference);
  });

  test("an imported document's citation is re-emitted over the same rules", () => {
    // The imported branch decides the citation against the set the DOCUMENT
    // cited, so it is its own compare and answers for its own draft.
    const metadata = inferMetadata(COLUMNS);
    const seed: AdvancedInviteSeed = {
      terms: getDefaultLinkageTerms("Inviter", metadata),
      metadata,
      columns: COLUMNS,
    };
    const document = getDefaultLinkageTerms("Author", metadata);
    expect(document.linkageRuleSet).toBeDefined();

    const imported = withUndefinedOptionals(
      draftFromTerms(document, seed, 3600, ROWS),
    );
    expect(buildAdvancedTerms(imported).linkageRuleSet).toEqual(
      document.linkageRuleSet,
    );
    // And the editor names no drop cause, so the notice beside the list agrees
    // with the document it would emit.
    expect(importedCitationDropCause(imported)).toBeUndefined();
  });

  test("a key the prune cannot read is answered, not thrown on", () => {
    // The prune reads every enumerable property, so a getter that throws reaches
    // it before the encoder's own boundary guard -- and the list asks this while
    // rendering. The key is judged as core judges one it cannot encode.
    const key: LinkageKey = {
      name: ZIP_KEY,
      elements: [{ field: "zip_code" }],
    };
    Object.defineProperty(key, "swap", {
      enumerable: true,
      get() {
        throw new Error("unreadable");
      },
    });
    expect(isOptInDraftKey(key)).toBe(false);
  });

  test("a value the prune cannot read leaves every rule beside it pruned", () => {
    // The rule-set compares are handed a whole terms document, so a value the
    // prune cannot read can sit outside the rules they compare. Read as one
    // structure, that value would cost every key in the document its prune and
    // the document its citation -- over a property the compare never asks about.
    const built = buildAdvancedTerms(withUndefinedOptionals(guidedDraft()));
    Object.defineProperty(built, "identity", {
      enumerable: true,
      get() {
        throw new Error("unreadable");
      },
    });
    // The assumptions: the document cannot be read as a whole, and core's compare
    // answers `false` for its keys, so the citation here is the prune's answer
    // rather than one reached without it.
    expect(() => Object.entries(built)).toThrow();
    expect(isDrawnFromLinkageRuleSet(DEFAULT_LINKAGE_RULE_SET, built)).toBe(
      false,
    );

    expect(
      isDraftDrawnFromLinkageRuleSet(DEFAULT_LINKAGE_RULE_SET, built),
    ).toBe(true);
    expect(linkageRuleSetReferenceForDraft(built)).toEqual(
      DEFAULT_LINKAGE_RULE_SET.reference,
    );
  });

  test("a key the prune cannot read is answered for the document, not thrown on", () => {
    // The other half: the unreadable rule is compared as it stands, and core
    // answers a document holding one exactly as it answers rules it cannot
    // encode -- not drawn from the set, entitled to no citation.
    const built = buildAdvancedTerms(withUndefinedOptionals(guidedDraft()));
    Object.defineProperty(built.linkageKeys[0], "swap", {
      enumerable: true,
      get() {
        throw new Error("unreadable");
      },
    });
    expect(
      isDraftDrawnFromLinkageRuleSet(DEFAULT_LINKAGE_RULE_SET, built),
    ).toBe(false);
    expect(linkageRuleSetReferenceForDraft(built)).toBeUndefined();
  });
});

describe("turning an offer on and off again", () => {
  test("adds the acceptor's own derivation, then withdraws it", () => {
    const off = guidedDraft();
    // Off, the column supplies nothing: an offer's cleaning is created by turning
    // its key on, not by the file holding a column of the type. A draft holding
    // one while off would clean a field its own terms declare nothing for.
    expect(off.standardization.some((t) => t.output === "zip_code")).toBe(
      false,
    );

    const on = withKeyEnabled(off, ZIP_KEY);

    // On: the cleaning the accepting party derives from these same terms, so the
    // two sides hash the same value.
    const stepsFor = (draft: AdvancedInviteDraft) =>
      draft.standardization.find((t) => t.output === "zip_code")?.steps;
    const terms = buildAdvancedTerms(on);
    expect(stepsFor(on)).toEqual(
      getDefaultStandardization(
        inferMetadata(COLUMNS),
        deriveAcceptedLinkageTerms(terms, "Acceptor"),
      ).find((t) => t.output === "zip_code")?.steps,
    );
    expect(stepsFor(on)).not.toEqual([]);

    // Off again: the cleaning goes with the key, so the draft is back to what the
    // file seeded -- including the terms every guided invitation over these
    // columns emitted before the offer existed.
    const back = withKeyEnabled(on, ZIP_KEY, false);
    expect(back.standardization).toEqual(off.standardization);
    expect(canonicalString(buildAdvancedTerms(back))).toEqual(
      canonicalString(buildAdvancedTerms(off)),
    );
  });

  test("cleaning the operator customized is re-derived across a withdraw and a restore", () => {
    // A BACKBONE column leaving the offered type behind takes the whole offer with
    // it, custom steps and all, and restoring that column brings the offer back.
    // What comes back is the RECOMMENDED pipeline: the accepting party derives the
    // same terms into the same steps, so a step only one side runs matches nothing
    // and re-deriving is what keeps the two hashing one value.
    const on = withKeyEnabled(guidedDraft(), ZIP_KEY);
    const custom: AdvancedInviteDraft = {
      ...on,
      standardization: on.standardization.map((transformation) =>
        transformation.output === "zip_code"
          ? { ...transformation, steps: [{ function: "trim_whitespace" }] }
          : transformation,
      ),
    };

    const withdrawn = setDraftMetadata(
      custom,
      setColumnType(custom.metadata, "dob", "other").metadata,
      ROWS,
    );
    expect(withdrawn.standardization.some((t) => t.output === "zip_code")).toBe(
      false,
    );

    const restored = setDraftMetadata(
      withdrawn,
      setColumnType(withdrawn.metadata, "dob", "date_of_birth").metadata,
      ROWS,
    );
    // The offer is on the list again; its cleaning follows its key, so this asks
    // for the key rather than assuming which flag it arrived at.
    const back = withKeyEnabled(restored, ZIP_KEY);
    const steps = back.standardization.find(
      (t) => t.output === "zip_code",
    )?.steps;
    expect(steps).toEqual(
      getDefaultStandardization(
        inferMetadata(COLUMNS),
        deriveAcceptedLinkageTerms(buildAdvancedTerms(back), "Acceptor"),
      ).find((t) => t.output === "zip_code")?.steps,
    );
    expect(steps).not.toEqual([{ function: "trim_whitespace" }]);
    expect(steps).not.toEqual([]);
  });
});

describe("what a mint over an offered column hands the surfaces that keep it", () => {
  // Three surfaces persist a mint and later hand their standardization straight
  // to prepareForExchange: the managed record a scheduled re-run replays, the CLI
  // exchange file the save path writes, and the console's server-job config. A
  // transform output naming no declared linkage field is refused there -- for the
  // recurring exchange, unattended, on every run.
  const LOCATION = {
    origin: "https://example.org",
    hostname: "example.org",
    port: "",
  };

  /** The invitation the screen mints for a draft, taken over profiled columns (the
   * console's mint source) so no CSV file is parsed here. */
  function mintFor(draft: AdvancedInviteDraft) {
    return generateInvitation({
      inviterName: draft.identity,
      profiledColumns: COLUMNS,
      location: LOCATION,
      lifetimeSeconds: draft.lifetimeSeconds,
      linkageTerms: buildAdvancedTerms(draft),
      metadata: draft.metadata,
      standardization: draft.standardization,
    });
  }

  test("a managed record deposited with every offer off re-runs", async () => {
    const minted = await mintFor(guidedDraft());
    expect(
      validateStandardizationAgainstTerms(
        minted.standardization ?? [],
        minted.linkageTerms,
      ),
    ).toEqual([]);

    const document = composeManagedDocument(
      {
        side: "inviter",
        linkageTerms: minted.linkageTerms,
        metadata: minted.metadata,
        standardization: minted.standardization,
        disclosedPayloadColumns: minted.disclosedPayloadColumns,
      },
      { channel: "webrtc", host: "example.org", port: 3000, path: "/api/" },
    );
    expect(() =>
      prepareManagedRerunExchange(document, ROWS, COLUMNS),
    ).not.toThrow();
  });

  test("the saved CLI exchange file runs as written", async () => {
    const minted = await mintFor(guidedDraft());
    const input = exchangeFileInputFor(
      "filedrop",
      { ...EMPTY_SAVE_FIELDS, sharedDirectory: "/srv/psilink" },
      minted,
    );
    expect(
      validateStandardizationAgainstTerms(
        input.standardization ?? [],
        input.linkageTerms,
      ),
    ).toEqual([]);
    // The YAML is a serialization of exactly this spec, so minting it proves the
    // schema accepts it and preparing the spec is what the CLI does once it has
    // loaded the file.
    expect(() => mintExchangeFile(input)).not.toThrow();
    expect(() =>
      prepareForExchange(
        {
          linkageTerms: input.linkageTerms,
          metadata: input.metadata,
          standardization: input.standardization,
        },
        input.linkageTerms.identity,
        ROWS,
        COLUMNS,
      ),
    ).not.toThrow();
  });

  test("the console's server-job config holds an undeclared output for nothing", async () => {
    const minted = await mintFor(guidedDraft());
    const config = inviterServerJobConfig({
      minted,
      inputSource: { kind: "inline", csv: "zip\n60614\n" },
      transport: { channel: "filedrop" },
    });
    expect(
      validateStandardizationAgainstTerms(
        config.standardization ?? [],
        config.linkageTerms,
      ),
    ).toEqual([]);
  });
});

describe("a metadata edit on an imported draft grows no cleaning of its own", () => {
  /** `role: linkage` columns of the given names and types. */
  function linkageColumns(
    columns: Array<[string, Metadata[number]["type"]]>,
  ): Metadata {
    return columns.map(([name, type]) => ({
      name,
      type,
      role: "linkage",
      isPayload: false,
    }));
  }

  /** A document declaring one `last_name` field and the one key over it -- nothing
   * of an offered type, whatever the importing party's own columns contain. */
  function lastNameDocument(): LinkageTerms {
    const authorMetadata = linkageColumns([["author_surname", "last_name"]]);
    return buildAdvancedTerms({
      identity: "Author",
      lifetimeSeconds: 3600,
      outputDirection: "both",
      algorithm: "psi",
      deduplicate: false,
      linkageStrategy: "cascade",
      metadata: authorMetadata,
      standardization: [
        { output: "last_name", input: "author_surname", steps: [] },
      ],
      keys: [
        {
          key: { name: "NAME", elements: [{ field: "last_name" }] },
          enabled: true,
        },
      ],
    });
  }

  test("a routine column retype declares nothing the document did not", () => {
    // The importing inviter has a ZIP column the document says nothing about, and
    // retypes an unrelated column. Widening the cleaning on the strength of that
    // column would put a `zip_code` transformation into a draft whose terms declare
    // no such field -- inert here, and refused wherever this draft is persisted.
    const metadata: Metadata = [
      ...linkageColumns([
        ["last_col", "last_name"],
        ["zip_col", "zip_code"],
      ]),
      { name: "birthday", type: "other", role: "ignored", isPayload: false },
    ];
    const seed: AdvancedInviteSeed = {
      terms: getDefaultLinkageTerms("Inviter", metadata),
      metadata,
      columns: metadata.map((column) => column.name),
    };
    const imported = draftFromTerms(lastNameDocument(), seed, 3600, []);
    expect(imported.standardization.some((t) => t.output === "zip_code")).toBe(
      false,
    );

    const edited = setDraftMetadataKeepingKeys(
      imported,
      setColumnType(imported.metadata, "birthday", "date_of_birth").metadata,
      [],
    );
    expect(edited.standardization.some((t) => t.output === "zip_code")).toBe(
      false,
    );
    expect(
      validateStandardizationAgainstTerms(
        edited.standardization,
        buildAdvancedTerms(edited),
      ),
    ).toEqual([]);
  });
});
