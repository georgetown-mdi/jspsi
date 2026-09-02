import type {
  Algorithm,
  BuiltInLinkageRuleSet,
  LinkageField,
  LinkageKey,
  LinkageKeyElement,
  LinkageStrategy,
  LinkageTerms,
  Metadata,
  Output,
  Standardization,
} from "@psilink/core";

/**
 * The shared data model of the inviter's authoring bench: the draft the editor
 * holds, the seed it opens from, and the direction/output mapping the two share.
 * No React, no I/O. The draft-editing operations, the terms mapping, and the
 * validation gate each build on these; keeping them here lets those three siblings
 * depend on one leaf rather than each other.
 *
 * Scope: the guided editor reviews and reorders the metadata-derived default
 * keys, edits the per-party column metadata (semantic type and disclosure),
 * chooses who receives the matched results (the 3-way output direction -- see
 * {@link OutputDirection}), and attaches identity, lifetime, and an optional legal
 * agreement. An expert tier additionally authors linkage keys element-by-element
 * (a field reference chosen from the declared list, a per-element transform
 * pipeline, and a two-of-N swap) and imports/exports the whole terms document.
 *
 * Per-element fuzzy comparisons are GATED: the terms mapping clamps them to the
 * applied behavior (no-fuzzy) while their `APPLIED_SETTINGS` flag is false, the
 * editor control is disabled to match, and an import that turns one on is refused
 * -- so the editor can never mint an invitation whose headline behavior silently
 * does not happen. `deduplicate` reads the same flag through the same clamp, which
 * passes it: the exchange applies the setting. A fan-out transform
 * step is held back the same way against core's own list rather than an
 * `APPLIED_SETTINGS` flag: the step editor does not offer the family, and a
 * document that carries one -- in a cleaning step or a linkage-key element
 * transform -- blocks generation and is refused at the mint. That gate is this
 * editor's own and wider than core's refusal by design: core admits a fan-out
 * under single-pass, while this editor authors none at any strategy, having no
 * control on which to weigh a fan-out's consequences for the operator.
 * No payload block is authored into the terms.
 * The output direction is settable now that one-sided output is honored
 * end-to-end (the acceptor mirrors the inviter's output and the exchange withholds
 * the result from a non-receiving party). The column METADATA is editable and
 * threaded into the inviter's own `prepareForExchange` (never the token), so its
 * disclosure choices govern what the inviter sends without touching the agreed
 * terms.
 */

/** The per-element fuzzy-comparison expansion, derived from the core element type
 * (core does not export the bare union). `undefined` means no expansion. */
export type FuzzyComparison = NonNullable<
  LinkageKeyElement["generateFuzzyComparisons"]
>;

/**
 * What an IMPORTED terms document said about the rule set its rules came from:
 * either the set it cited, carried with the rules it cited them over, or the
 * explicit statement that it cited none.
 *
 * The uncited case is a state of its own rather than an absent field because the
 * two answers differ: a document that cites nothing is re-exported citing
 * nothing, while a draft that was never imported is entitled to the built-in
 * citation its own rules earn. Reading absence as "decide it fresh" would hand an
 * uncited import a provenance claim its source declined, and move the terms hash
 * across the round trip.
 *
 * `honoredAtImport` records whether the citation survived the editor's
 * arrival-time narrowing -- whether the terms the draft built the instant it
 * imported still carried it. It is fixed at import and never re-derived, so a
 * later drop is attributed to what caused it: an edit that took honored rules out
 * of the set (the operator's, reversible), rather than a document whose rules
 * could never honor the citation it named (the document's, no edit restores it).
 */
export type ImportedRuleSetCitation =
  | { kind: "cited"; ruleSet: BuiltInLinkageRuleSet; honoredAtImport: boolean }
  | { kind: "uncited" };

/** One linkage key in the editor, paired with whether it is active. Display and
 * match order is the array position (linkage keys are applied most-precise-first,
 * so order is significant); a disabled key is dropped from the built terms.
 *
 * The list holds both what the built-in rule set offers and what
 * `optInLinkageKeys` offers beside it, which is why an entry carries no mark of
 * its own: the two are the same thing to every operation over the list, and a
 * surface that must tell them apart asks `isOptInDraftKey` about the key rather
 * than reading a flag a rename or an import could falsify. */
export interface DraftKey {
  key: LinkageKey;
  enabled: boolean;
}

/**
 * Who receives the matched results, from the INVITER's point of view:
 * - `"both"`   -- both parties receive (the default, symmetric exchange).
 * - `"inviter"` -- only the inviter ("me") receives; the partner is the helper.
 * - `"partner"` -- only the partner receives; the inviter is the helper.
 *
 * This is the editor's representation of the {@link Output} pair. Modeling it as
 * a 3-value choice (rather than two independent booleans) is what keeps the
 * forbidden "neither party receives" combination out of a draft: no direction maps
 * to `{ expectsOutput: false, shareWithPartner: false }`, which
 * `validateCompatibility` rejects ("neither party expects output"), and
 * advancedInviteTypes.test.ts drives every direction against that pair.
 */
export type OutputDirection = "both" | "inviter" | "partner";

/** Map an {@link OutputDirection} to the inviter's {@link Output} pair. The three
 * cases are exactly the three valid (non-"neither") combinations, so no choice can
 * yield a forbidden pair. The acceptor derives its own (mirrored) output from
 * these terms at accept time (see `deriveAcceptedLinkageTerms` in core). */
export function outputForDirection(direction: OutputDirection): Output {
  switch (direction) {
    case "both":
      return { expectsOutput: true, shareWithPartner: true };
    case "inviter":
      return { expectsOutput: true, shareWithPartner: false };
    case "partner":
      return { expectsOutput: false, shareWithPartner: true };
  }
}

/** Inverse of {@link outputForDirection}: map an {@link Output} pair to the 3-way
 * direction for an imported terms set. The "neither receives"
 * `{ expectsOutput: false, shareWithPartner: false }` pair has no direction; it is
 * NOT rejected by `safeParseLinkageTerms` (the schema accepts any two output
 * booleans -- the "neither party expects output" check runs later, in
 * `validateCompatibility` at exchange time), so an imported set could carry it. The
 * final branch maps that (malformed, exchange-rejected) pair to the safe `"both"`
 * default, which the inviter sees selected and reviews before generating, rather
 * than loading a forbidden state silently. */
export function directionForOutput(output: Output): OutputDirection {
  if (output.expectsOutput && output.shareWithPartner) return "both";
  if (output.expectsOutput) return "inviter";
  if (output.shareWithPartner) return "partner";
  return "both";
}

/** The optional legal-agreement block, as the editor holds it before validation.
 * Free text is NFC-normalized and trimmed when the terms are built (see
 * {@link buildAdvancedTerms}); the expiry check lives in
 * {@link validateAdvancedInvite}, not the core schema. */
export interface DraftLegalAgreement {
  reference: string;
  purpose: string;
  /** ISO 8601 date (YYYY-MM-DD). */
  expirationDate: string;
}

/** The editor's in-progress state. `identity` and `lifetimeSeconds` and the
 * optional `legalAgreement` are author-controlled; `keys` carries the seed's
 * linkage keys with their enabled flags, reorderable in place. */
export interface AdvancedInviteDraft {
  identity: string;
  /** Invitation lifetime in seconds; threaded into `generateInvitation`, not the
   * linkage terms. Bounded in {@link validateAdvancedInvite}. */
  lifetimeSeconds: number;
  /** Who receives the matched results (see {@link OutputDirection}); applied to
   * the built terms' `output` by {@link buildAdvancedTerms}. Defaults to `"both"`
   * (the symmetric exchange). The forbidden "neither receives" pair is
   * unrepresentable -- it has no `OutputDirection`. */
  outputDirection: OutputDirection;
  /** The matching algorithm. `psi` reveals matched identifiers; `psi-c` reveals
   * only the count. Ungated -- the exchange honors both -- so
   * {@link buildAdvancedTerms} writes it straight through with no clamp; a
   * count-only draft outside the shape the specification admits is refused by the
   * count-only rules at validation instead. */
  algorithm: Algorithm;
  /** Whether more than one of the holder's records may match the same partner
   * record -- deduplication of the holder's OWN inputs, which lets multiple of its
   * inputs map to the same matched output (see EXCHANGE_REFERENCE
   * `linkage_terms.deduplicate`). {@link buildAdvancedTerms} clamps it to `false`
   * only while `APPLIED_SETTINGS`.deduplicate is false, and passes it otherwise. */
  deduplicate: boolean;
  /** How the agreed linkage keys are exchanged (see {@link LinkageStrategy}).
   * `cascade` (the default) matches keys one round at a time; `single-pass`
   * batches them into one exchange for a round-trip count constant in the number
   * of keys, at the cost of disclosing the sender's full per-key value structure
   * to the receiver. Like {@link AdvancedInviteDraft.algorithm} it is NOT gated --
   * single-pass is honored end-to-end -- so {@link buildAdvancedTerms} writes it
   * straight through with no clamp; the
   * consent tradeoff is surfaced at the control. Seeded from the default terms
   * (`cascade`) and reflected from an imported document. */
  linkageStrategy: LinkageStrategy;
  legalAgreement?: DraftLegalAgreement;
  /** The inviter's per-party column metadata (semantic type + disclosure role),
   * editable in the grid. Editing a column's type re-derives which keys are
   * offerable (see {@link setDraftMetadata}); the disclosure choice governs what
   * the inviter sends and is threaded into its exchange spec. Seeded from
   * {@link inferMetadata}, normalized so the collapsed disclosure control is
   * faithful. */
  metadata: Metadata;
  /**
   * The inviter's per-party standardization: the ordered cleaning steps and the
   * input-column binding for each field. Seeded from `inviterDefaultStandardization`
   * (so the editor opens on the recommended cleaning for every matchable column the
   * file carries, and -- with no edits -- `authoredLinkageFields` over it declares
   * the same fields it declares over the metadata alone, keeping the cross-party
   * terms byte-identical). The data-prep workbench
   * edits it; {@link buildAdvancedTerms} derives the linkage FIELDS from it via
   * `authoredLinkageFields`, which is what lets two transformations of one
   * semantic type bind to distinct columns and declare two fields. Threaded into the
   * inviter's own `prepareForExchange` (never the token), so the cleaning it authors
   * is the cleaning the run applies. Reconciled against a metadata edit by
   * {@link setDraftMetadata}. */
  standardization: Standardization;
  keys: Array<DraftKey>;
  /**
   * The `linkageFields` declaration of an IMPORTED terms document, carried verbatim
   * for round-trip fidelity. Set only by {@link draftFromTerms}; absent for the seed,
   * guided, and expert paths. When present, {@link buildAdvancedTerms} governs how
   * the rebuild reconciles it.
   */
  importedLinkageFields?: Array<LinkageField>;
  /**
   * An IMPORTED terms document's rule-set citation state, carried so
   * {@link buildAdvancedTerms} re-emits what the document claimed instead of
   * re-deciding it -- the round-trip fidelity {@link importedLinkageFields} gives
   * the field declaration, extended to the provenance claim over it. Set by
   * {@link draftFromTerms} on every import, cited or not; absent for the seed,
   * guided, and expert paths, which earn the built-in citation on content.
   *
   * A cited import carries the rules it cited along with the reference, because
   * the citation is not re-emitted unconditionally: an import narrowed by
   * disabling keys still builds rules drawn from the imported document, while one
   * whose keys were edited, reordered, or added to does not, and a citation over
   * those would claim a provenance they no longer have.
   */
  importedRuleSetCitation?: ImportedRuleSetCitation;
}

/** The fixed starting point for an editor session: the auto-derived terms the
 * draft seeds from, plus the columns those terms were derived from (kept for the
 * live satisfiability check, which is over column shape). */
export interface AdvancedInviteSeed {
  /** The metadata-aware auto-derived terms (`getDefaultLinkageTerms` over
   * the file's inferred metadata) -- the same terms the quick path would embed for
   * these columns, so the editor opens on a known-good valid state. */
  terms: LinkageTerms;
  /** The inferred, normalized starting metadata -- the reset anchor for the grid
   * (the draft's `metadata` opens equal to this). */
  metadata: Metadata;
  /** The inviter's CSV column names. */
  columns: Array<string>;
}

/** A control an editor error attaches to, so the component can render the message
 * inline beside the offending input rather than as a page-level alert. */
export type AdvancedField =
  | "identity"
  | "lifetime"
  | "legalReference"
  | "legalPurpose"
  | "legalExpiration"
  | "output"
  | "payload"
  | "keys"
  | "standardization";

/** The result of validating a draft: whether Generate may proceed, the built
 * terms when they parse cleanly, and per-control error messages. */
export interface AdvancedValidation {
  /** True only when the draft parses through the core schema, every non-schema
   * gate (lifetime bounds, a future legal-agreement expiry, at least one
   * column-satisfiable key) passes, and the terms canonically encode. */
  canGenerate: boolean;
  /** The terms the draft represents, present only when {@link canGenerate}. The
   * component passes these to `generateInvitation` verbatim. */
  terms?: LinkageTerms;
  /** Per-control error messages; an absent field has no error. */
  errors: Partial<Record<AdvancedField, string>>;
}
