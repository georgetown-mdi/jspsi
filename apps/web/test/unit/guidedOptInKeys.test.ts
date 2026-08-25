import { describe, expect, test } from "vitest";

import {
  DEFAULT_LINKAGE_RULE_SET,
  canonicalString,
  deriveAcceptedLinkageTerms,
  getDefaultLinkageTerms,
  getDefaultStandardization,
  inferMetadata,
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
} from "@bench/saveExchangeModel";
import { composeManagedDocument } from "@bench/manageOfferModel";
import { inviterServerJobConfig } from "@bench/useInviterExchange";

import {
  buildAdvancedTerms,
  draftFromTerms,
  draftWithKeyEnabled,
  inviterExchangeDataSpec,
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

import type { CSVRow, LinkageTerms, Metadata } from "@psilink/core";

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
    // Off, so the retyped column carries no cleaning yet -- the draft holds a
    // pipeline for a field only while its terms declare one.
    expect(edited.standardization.some((t) => t.output === "zip_code")).toBe(
      false,
    );
    // Turning the offer on binds the cleaning to the column the retype supplied,
    // so the key matches through the pipeline rather than raw.
    expect(
      withKeyEnabled(edited, "ZIP").standardization.find(
        (t) => t.output === "zip_code",
      )?.input,
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

describe("turning an offer on and off again", () => {
  test("adds the acceptor's own derivation, then withdraws it", () => {
    const off = guidedDraft();
    // Off, the column supplies nothing: an offer's cleaning is created by turning
    // its key on, not by the file carrying a column of the type. A draft holding
    // one while off would clean a field its own terms declare nothing for.
    expect(off.standardization.some((t) => t.output === "zip_code")).toBe(
      false,
    );

    const on = withKeyEnabled(off, "ZIP");

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
    const back = withKeyEnabled(on, "ZIP", false);
    expect(back.standardization).toEqual(off.standardization);
    expect(canonicalString(buildAdvancedTerms(back))).toEqual(
      canonicalString(buildAdvancedTerms(off)),
    );
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

  /** The invitation the bench mints for a draft, taken over profiled columns (the
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

  test("the console's server-job config carries an undeclared output for nothing", async () => {
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
   * of an offered type, whatever the importing party's own columns carry. */
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
