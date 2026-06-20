import {
  CanonicalEncodingError,
  INVITATION_LIFETIME_SECONDS,
  MAX_INVITATION_LIFETIME_SECONDS,
  assessLinkageSatisfiability,
  canonicalString,
  getDefaultLinkageTerms,
  inferMetadata,
  safeParseLinkageTerms,
} from "@psilink/core";

import type { LinkageKey, LinkageTerms } from "@psilink/core";

/**
 * The pure data model behind the Advanced-options editor: seeding a draft from the
 * inviter's columns, building the {@link LinkageTerms} a draft represents, and
 * validating it. No React, no I/O -- the single tested boundary the editor
 * component drives, so the seed/build/validate contract is checked here rather
 * than through the UI.
 *
 * Scope of this iteration (see the board item): the editor reviews and reorders
 * the metadata-derived defaults and attaches identity, lifetime, and an optional
 * legal agreement. It deliberately exposes NO control for output sharing,
 * `algorithm` (psi-c), `deduplicate`, fuzzy comparisons, or payload columns:
 * those are carried from the seed unchanged, so a draft can only ever emit the
 * default `psi` / both-receive / no-dedup / no-fuzzy / no-payload shape. Element,
 * transform, and swap internals are read-only too. Each of those is a capability
 * the engine does not yet honor end-to-end (one-sided output and payload
 * transmission) or is tracked as its own authoring task; surfacing a settable
 * control here would let the editor mint an invitation whose headline behavior
 * silently does not happen.
 */

/** One linkage key in the editor, paired with whether it is active. Display and
 * match order is the array position (linkage keys are applied most-precise-first,
 * so order is significant); a disabled key is dropped from the built terms. */
export interface DraftKey {
  key: LinkageKey;
  enabled: boolean;
}

/** The optional legal-agreement block, as the editor holds it before validation.
 * Free text is NFC-normalized and trimmed when the terms are built (see
 * {@link buildAdvancedTerms}); the future-date check lives in
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
  legalAgreement?: DraftLegalAgreement;
  keys: Array<DraftKey>;
}

/** The fixed starting point for an editor session: the auto-derived terms the
 * draft seeds from, plus the columns those terms were derived from (kept for the
 * live satisfiability check, which is over column shape). */
export interface AdvancedInviteSeed {
  /** The metadata-aware auto-derived terms ({@link getDefaultLinkageTerms} over
   * the file's inferred metadata) -- the same terms the quick path would embed for
   * these columns, so the editor opens on a known-good valid state. */
  terms: LinkageTerms;
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
  | "keys";

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

/**
 * Seed an editor session from the inviter's identity and CSV columns. The terms
 * are the metadata-aware defaults ({@link getDefaultLinkageTerms} over
 * {@link inferMetadata}), so only keys the columns can satisfy are present and the
 * editor never opens on a blank form. Calling this again is exactly the
 * "Reset to recommended" action.
 */
export function seedAdvancedInvite(
  identity: string,
  columns: Array<string>,
): { draft: AdvancedInviteDraft; seed: AdvancedInviteSeed } {
  const metadata = inferMetadata(columns);
  const terms = getDefaultLinkageTerms(identity, metadata);
  return {
    draft: {
      identity,
      lifetimeSeconds: INVITATION_LIFETIME_SECONDS,
      keys: terms.linkageKeys.map((key) => ({ key, enabled: true })),
    },
    seed: { terms, columns },
  };
}

/** NFC-normalize and trim a free-text value. NFC is the cross-party canonical
 * form linkage-terms free text is compared in (see the board item's
 * implementation notes); trimming drops incidental surrounding whitespace so a
 * space-only value reads as empty to the schema's `.min(1)`. */
function normalizeText(value: string): string {
  return value.normalize("NFC").trim();
}

/**
 * Build the {@link LinkageTerms} a draft represents. Output sharing, `algorithm`,
 * `deduplicate`, `version`, and `date` are carried from the seed unchanged (the
 * editor exposes no control for them, so a draft cannot alter them); `identity`
 * and the optional legal agreement come from the draft (free text NFC-normalized
 * and trimmed); linkage keys are the enabled ones in draft order, and linkage
 * fields are filtered to those the enabled keys reference (mirroring
 * `getDefaultLinkageTerms`, so disabling a key drops a now-unreferenced field).
 *
 * Pure: it does not validate. {@link validateAdvancedInvite} runs the result
 * through the core schema, which stays the single validation source.
 */
export function buildAdvancedTerms(
  draft: AdvancedInviteDraft,
  seed: AdvancedInviteSeed,
): LinkageTerms {
  const enabledKeys = draft.keys
    .filter((entry) => entry.enabled)
    .map((entry) => entry.key);
  const referenced = new Set(
    enabledKeys.flatMap((key) => key.elements.map((el) => el.field)),
  );
  const linkageFields = seed.terms.linkageFields.filter((field) =>
    referenced.has(field.name),
  );

  const terms: LinkageTerms = {
    ...seed.terms,
    identity: normalizeText(draft.identity),
    linkageFields,
    linkageKeys: enabledKeys,
  };

  if (draft.legalAgreement !== undefined) {
    terms.legalAgreement = {
      reference: normalizeText(draft.legalAgreement.reference),
      purpose: normalizeText(draft.legalAgreement.purpose),
      // The date comes from a date input (YYYY-MM-DD), not free prose, so it is
      // not NFC-normalized; its format is validated by the schema and its
      // future-ness by validateAdvancedInvite.
      expirationDate: draft.legalAgreement.expirationDate.trim(),
    };
  }

  return terms;
}

/** Today's date as YYYY-MM-DD, for the legal-agreement future-date check. Matches
 * the slice `validateCompatibility` uses for the same comparison at exchange time
 * (`new Date().toISOString().slice(0, 10)`), so the editor refuses exactly the
 * expired dates the exchange would. */
function todayIso(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Validate a draft for the Generate gate. The core schema
 * ({@link safeParseLinkageTerms}) is the single source for everything it covers
 * (identity/legal-text presence, the date format, referential integrity); this
 * adds only the gates the schema does not express: the invitation-lifetime
 * bounds (not part of the terms), a future legal-agreement expiry (the schema
 * checks format, not that the date is ahead -- the exchange enforces that later,
 * so refuse it up front), at least one column-satisfiable linkage key, and a
 * canonical-encode dry run (the byte form both parties hash; refuse a value that
 * cannot encode rather than fail cross-party).
 *
 * Schema errors are mapped back to the offending control by their issue path --
 * the editor re-derives the control because the referential-integrity refines
 * report at the array path by design, echoing no value.
 */
export function validateAdvancedInvite(
  draft: AdvancedInviteDraft,
  seed: AdvancedInviteSeed,
  now: Date = new Date(),
): AdvancedValidation {
  const terms = buildAdvancedTerms(draft, seed);
  const errors: Partial<Record<AdvancedField, string>> = {};

  // Lifetime is a generateInvitation parameter, not part of the terms, so it is
  // not covered by the schema. Mirror generateInvitation's own bounds.
  if (
    !Number.isFinite(draft.lifetimeSeconds) ||
    draft.lifetimeSeconds <= 0 ||
    draft.lifetimeSeconds > MAX_INVITATION_LIFETIME_SECONDS
  ) {
    errors.lifetime =
      "Choose an invitation lifetime between 1 second and one year.";
  }

  // At least one key must be active. The schema's linkageKeys .min(1) also
  // catches this, but a dedicated message reads better against the key list.
  const enabledCount = draft.keys.filter((entry) => entry.enabled).length;
  if (enabledCount === 0) {
    errors.keys = "Enable at least one linkage key.";
  }

  const parsed = safeParseLinkageTerms(terms);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = fieldForIssuePath(issue.path);
      // Keep the first message per control; the schema reports the most specific
      // issue first, and stacking several on one input is noise.
      if (errors[field] === undefined) errors[field] = messageForField(field);
    }
  }

  // A future expiry is not a schema rule (it checks only the date format), so
  // add it -- but only once the date is a well-formed date the schema accepted,
  // so a malformed date shows the format error rather than this one.
  const expiration = draft.legalAgreement?.expirationDate.trim();
  if (
    expiration !== undefined &&
    errors.legalExpiration === undefined &&
    expiration <= todayIso(now)
  ) {
    errors.legalExpiration = "The expiration date must be in the future.";
  }

  // Satisfiability is over column shape, not the schema: a key all of whose
  // fields the columns can produce is satisfiable. Block when none can (the
  // exchange would emit no key strings and yield a silent empty result), the same
  // gate generateInvitation and the acceptor pre-flight apply.
  if (enabledCount > 0 && errors.keys === undefined) {
    const { satisfiableKeyCount } = assessLinkageSatisfiability(
      seed.columns,
      terms,
    );
    if (satisfiableKeyCount === 0) {
      errors.keys =
        "None of the enabled keys can be satisfied by your file's columns.";
    }
  }

  // Canonical-encode dry run: the terms are hashed into the cross-party agreement
  // in this byte form, and a value outside the reproducible domain throws here
  // rather than desyncing two parties. The editor authors no transform params (the
  // only partner-reachable un-encodable value), so this is defense-in-depth.
  let encodable = true;
  try {
    canonicalString(terms);
  } catch (err) {
    if (err instanceof CanonicalEncodingError) {
      encodable = false;
      if (errors.keys === undefined)
        errors.keys = "These terms cannot be encoded; reset to recommended.";
    } else {
      throw err;
    }
  }

  const canGenerate =
    parsed.success && encodable && Object.keys(errors).length === 0;
  return {
    canGenerate,
    terms: canGenerate ? terms : undefined,
    errors,
  };
}

/** Map a Zod issue path to the editor control it belongs to. The schema's
 * referential-integrity refines report at the array path (`["linkageKeys"]`),
 * which collapses to the key list here. */
function fieldForIssuePath(path: ReadonlyArray<PropertyKey>): AdvancedField {
  const head = path[0];
  if (head === "identity") return "identity";
  if (head === "legalAgreement") {
    const sub = path[1];
    if (sub === "reference") return "legalReference";
    if (sub === "purpose") return "legalPurpose";
    if (sub === "expirationDate") return "legalExpiration";
  }
  // linkageKeys, linkageFields, and anything else the editor can influence
  // surface against the key list (the only structural control it offers).
  return "keys";
}

/** A clear, control-specific message for a schema failure on that control. The
 * raw Zod message is not echoed: it is technical, and the offending value is
 * never partner-safe to surface here. */
function messageForField(field: AdvancedField): string {
  switch (field) {
    case "identity":
      return "Enter a name to identify yourself.";
    case "legalReference":
      return "Enter the agreement reference.";
    case "legalPurpose":
      return "Enter the purpose of the disclosure.";
    case "legalExpiration":
      return "Enter a valid date (YYYY-MM-DD).";
    case "lifetime":
      return "Choose an invitation lifetime between 1 second and one year.";
    case "keys":
      return "Enable at least one linkage key.";
  }
}
