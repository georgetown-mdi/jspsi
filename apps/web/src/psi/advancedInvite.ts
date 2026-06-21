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

import { normalizeForEditor } from "./metadataEditing";

import type { LinkageKey, LinkageTerms, Metadata } from "@psilink/core";

/**
 * The pure data model behind the Advanced-options editor: seeding a draft from the
 * inviter's columns, building the {@link LinkageTerms} a draft represents, and
 * validating it. No React, no I/O -- the single tested boundary the editor
 * component drives, so the seed/build/validate contract is checked here rather
 * than through the UI.
 *
 * Scope of this iteration (see the board item): the editor reviews and reorders
 * the metadata-derived defaults, edits the per-party column metadata (semantic
 * type and disclosure -- see {@link setDraftMetadata}), and attaches identity,
 * lifetime, and an optional legal agreement. It deliberately exposes NO control
 * for output sharing, `algorithm` (psi-c), `deduplicate`, or fuzzy comparisons:
 * those are carried from the seed unchanged, so a draft's TERMS can only ever
 * emit the default `psi` / both-receive / no-dedup / no-fuzzy shape, and no
 * payload block is authored into the terms. Element, transform, and swap
 * internals are read-only too. Each of those is a capability the engine does not
 * yet honor end-to-end (one-sided output) or is tracked as its own authoring
 * task; surfacing a settable control here would let the editor mint an invitation
 * whose headline behavior silently does not happen. The column METADATA is
 * editable and threaded into the inviter's own `prepareForExchange` (never the
 * token), so its disclosure choices govern what the inviter sends without
 * touching the agreed terms.
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
  legalAgreement?: DraftLegalAgreement;
  /** The inviter's per-party column metadata (semantic type + disclosure role),
   * editable in the grid. Editing a column's type re-derives which keys are
   * offerable (see {@link setDraftMetadata}); the disclosure choice governs what
   * the inviter sends and is threaded into its exchange spec. Seeded from
   * {@link inferMetadata}, normalized so the collapsed disclosure control is
   * faithful. */
  metadata: Metadata;
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
  // Normalized so the collapsed disclosure control opens on a faithful diagonal
  // (an inferred identifier column is not silently disclosed). Normalization only
  // re-derives isPayload from role, so the offerable key set -- which
  // getDefaultLinkageTerms derives from the non-ignored column TYPES -- is
  // unchanged by it.
  const metadata = normalizeForEditor(inferMetadata(columns));
  const terms = getDefaultLinkageTerms(identity, metadata);
  return {
    draft: {
      identity,
      lifetimeSeconds: INVITATION_LIFETIME_SECONDS,
      metadata,
      keys: terms.linkageKeys.map((key) => ({ key, enabled: true })),
    },
    seed: { terms, metadata, columns },
  };
}

/**
 * Re-derive the editor's draft for a new column metadata: editing a column's
 * semantic type changes which linkage keys are offerable ({@link getDefaultLinkageTerms}
 * filters by the non-ignored column types present), so this recomputes the
 * offerable key set and reconciles it with the current draft -- keys still
 * offerable keep their enabled flag and position, newly-offerable keys are
 * appended (enabled), and keys no longer offerable drop. The threaded metadata is
 * what the inviter's exchange binds on, so a remap that makes a key offerable also
 * makes the run actually produce it.
 */
export function setDraftMetadata(
  draft: AdvancedInviteDraft,
  metadata: Metadata,
): AdvancedInviteDraft {
  const offerable = getDefaultLinkageTerms(
    draft.identity,
    metadata,
  ).linkageKeys;
  return { ...draft, metadata, keys: reconcileKeys(draft.keys, offerable) };
}

/** Reconcile the draft's keys against a freshly-derived offerable set: keep the
 * order and enabled flag of keys that remain offerable (replacing the key object
 * with the fresh template), then append any newly-offerable key as enabled. */
function reconcileKeys(
  prevKeys: Array<DraftKey>,
  offerable: Array<LinkageKey>,
): Array<DraftKey> {
  const offerableByName = new Map(offerable.map((key) => [key.name, key]));
  const kept: Array<DraftKey> = [];
  const seen = new Set<string>();
  for (const entry of prevKeys) {
    const fresh = offerableByName.get(entry.key.name);
    if (fresh !== undefined) {
      kept.push({ key: fresh, enabled: entry.enabled });
      seen.add(entry.key.name);
    }
  }
  for (const key of offerable) {
    if (!seen.has(key.name)) kept.push({ key, enabled: true });
  }
  return kept;
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
export function buildAdvancedTerms(draft: AdvancedInviteDraft): LinkageTerms {
  // The recommended terms for the draft's CURRENT metadata, so a column type edit
  // re-derives the offerable fields/keys in lockstep with the grid. The base
  // carries the non-authored shape (version/date/algorithm/output/deduplicate);
  // the draft overrides identity, the enabled keys, and the legal agreement.
  const baseTerms = getDefaultLinkageTerms(draft.identity, draft.metadata);
  const enabledKeys = draft.keys
    .filter((entry) => entry.enabled)
    .map((entry) => entry.key);
  const referenced = new Set(
    enabledKeys.flatMap((key) => key.elements.map((el) => el.field)),
  );
  const linkageFields = baseTerms.linkageFields.filter((field) =>
    referenced.has(field.name),
  );

  const terms: LinkageTerms = {
    ...baseTerms,
    identity: normalizeText(draft.identity),
    linkageFields,
    linkageKeys: enabledKeys,
  };

  if (draft.legalAgreement !== undefined) {
    terms.legalAgreement = {
      reference: normalizeText(draft.legalAgreement.reference),
      purpose: normalizeText(draft.legalAgreement.purpose),
      // The date comes from a date input (YYYY-MM-DD), not free prose, so it is
      // not NFC-normalized; its format is validated by the schema and that it has
      // not already passed by validateAdvancedInvite.
      expirationDate: draft.legalAgreement.expirationDate.trim(),
    };
  }

  return terms;
}

/** Today's date as YYYY-MM-DD, for the legal-agreement expiry check. Matches the
 * slice `validateCompatibility` uses for the same comparison at exchange time
 * (`new Date().toISOString().slice(0, 10)`), and the editor compares it the same
 * way (strictly before today is expired), so the editor refuses exactly the
 * expired dates the exchange would. */
function todayIso(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Validate a draft for the Generate gate. The core schema
 * ({@link safeParseLinkageTerms}) is the single source for everything it covers
 * (identity/legal-text presence, the date format, referential integrity); this
 * adds only the gates the schema does not express: the invitation-lifetime
 * bounds (not part of the terms), a not-yet-passed legal-agreement expiry (the
 * schema checks format, not that the date is still current -- the exchange
 * rejects an already-passed date later, so refuse it up front), at least one
 * column-satisfiable linkage key, and a
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
  const terms = buildAdvancedTerms(draft);
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

  // An already-passed expiry is not a schema rule (it checks only the date
  // format), so add it -- mirroring the exchange, which rejects an expirationDate
  // strictly before today (config/linkageTerms.ts). A same-day expiry is still
  // honored at the exchange, so accept it here too rather than refuse an
  // invitation the exchange would. Apply it only once the date is a well-formed
  // date the schema accepted, so a malformed date shows the format error rather
  // than this one.
  const expiration = draft.legalAgreement?.expirationDate.trim();
  if (
    expiration !== undefined &&
    errors.legalExpiration === undefined &&
    expiration < todayIso(now)
  ) {
    errors.legalExpiration = "The expiration date cannot be in the past.";
  }

  // Satisfiability is over column shape, not the schema: a key all of whose
  // fields the columns can produce is satisfiable. Block when none can (the
  // exchange would emit no key strings and yield a silent empty result), the same
  // gate generateInvitation and the acceptor pre-flight apply.
  if (enabledCount > 0 && errors.keys === undefined) {
    // Assess against the draft's edited metadata, the same binding the inviter's
    // exchange uses (it is threaded into the spec), so a column remap that makes a
    // key offerable is judged satisfiable here exactly when the run can produce it.
    const { satisfiableKeyCount } = assessLinkageSatisfiability(
      seed.columns,
      terms,
      undefined,
      draft.metadata,
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
