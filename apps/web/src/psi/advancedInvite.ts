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

import { APPLIED_SETTINGS } from "./appliedSettings";
import { normalizeForEditor } from "./metadataEditing";

import type {
  Algorithm,
  LinkageKey,
  LinkageKeyElement,
  LinkageTerms,
  Metadata,
  Output,
} from "@psilink/core";

/** The per-element fuzzy-comparison expansion, derived from the core element type
 * (core does not export the bare union). `undefined` means no expansion. */
export type FuzzyComparison = NonNullable<
  LinkageKeyElement["generateFuzzyComparisons"]
>;

/**
 * The pure data model behind the Advanced-options editor: seeding a draft from the
 * inviter's columns, building the {@link LinkageTerms} a draft represents, and
 * validating it. No React, no I/O -- the single tested boundary the editor
 * component drives, so the seed/build/validate contract is checked here rather
 * than through the UI.
 *
 * Scope: the guided editor reviews and reorders the metadata-derived default
 * keys, edits the per-party column metadata (semantic type and disclosure -- see
 * {@link setDraftMetadata}), chooses who receives the matched results (the 3-way
 * output direction -- see {@link OutputDirection}), and attaches identity,
 * lifetime, and an optional legal agreement. An expert tier additionally authors
 * linkage keys element-by-element (a field reference chosen from the declared
 * list, a per-element transform pipeline, and a two-of-N swap -- see
 * {@link addKey}, {@link updateElementAt}, and the sibling helpers) and
 * imports/exports the whole terms document.
 *
 * `algorithm` (psi-c), `deduplicate`, and per-element fuzzy comparisons are GATED:
 * {@link buildAdvancedTerms} clamps them to the applied behavior (`psi` / no-dedup
 * / no-fuzzy) while their {@link APPLIED_SETTINGS} flag is false, the editor
 * controls are disabled to match, and an import that turns one on is refused
 * ({@link gatedActiveSettingMessage}) -- so the editor can never mint an invitation
 * whose headline behavior silently does not happen (psi-c being the privacy
 * footgun). No payload block is authored into the terms. The output direction is
 * settable now that one-sided output is honored end-to-end (the acceptor mirrors
 * the inviter's output and the exchange withholds the result from a non-receiving
 * party). The column METADATA is editable and threaded into the inviter's own
 * `prepareForExchange` (never the token), so its disclosure choices govern what
 * the inviter sends without touching the agreed terms.
 */

/** One linkage key in the editor, paired with whether it is active. Display and
 * match order is the array position (linkage keys are applied most-precise-first,
 * so order is significant); a disabled key is dropped from the built terms. */
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
 * a 3-value choice (rather than two independent booleans) makes the forbidden
 * "neither party receives" combination unrepresentable by construction: there is
 * no draft state that maps to `{ expectsOutput: false, shareWithPartner: false }`,
 * which `validateCompatibility` rejects ("neither party expects output").
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
   * only the count. Gated: {@link buildAdvancedTerms} clamps it to `psi` while
   * {@link APPLIED_SETTINGS}.psiC is false, so the built terms can never carry a
   * count-only setting the run does not yet honor (the editor control is disabled
   * to match). Carried so the control unlocks the moment the flag flips. */
  algorithm: Algorithm;
  /** Whether more than one of the holder's records may match the same partner
   * record -- deduplication of the holder's OWN inputs, which lets multiple of its
   * inputs map to the same matched output (see EXCHANGE_REFERENCE
   * `linkage_terms.deduplicate`). Gated: {@link buildAdvancedTerms} clamps it to
   * `false` while {@link APPLIED_SETTINGS}.deduplicate is false. */
  deduplicate: boolean;
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
      // The default is the symmetric both-receive exchange, matching the quick
      // path and getDefaultLinkageTerms' output.
      outputDirection: "both",
      // Carried from the recommended terms (psi / no-dedup); the gated controls
      // hold these at the safe defaults until APPLIED_SETTINGS flips.
      algorithm: terms.algorithm,
      deduplicate: terms.deduplicate,
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
 * Build the {@link LinkageTerms} a draft represents. `algorithm`, `deduplicate`,
 * `version`, and `date` are carried from the seed unchanged (the editor exposes no
 * control for them, so a draft cannot alter them); `identity`, the `output`
 * direction, and the optional legal agreement come from the draft (free text
 * NFC-normalized and trimmed); linkage keys are the enabled ones in draft order,
 * and linkage fields are filtered to those the enabled keys reference (mirroring
 * `getDefaultLinkageTerms`, so disabling a key drops a now-unreferenced field).
 *
 * Pure: it does not validate. {@link validateAdvancedInvite} runs the result
 * through the core schema, which stays the single validation source.
 */
export function buildAdvancedTerms(draft: AdvancedInviteDraft): LinkageTerms {
  // The recommended terms for the draft's CURRENT metadata, so a column type edit
  // re-derives the offerable fields/keys in lockstep with the grid. The base
  // carries the non-authored shape (version/date/algorithm/deduplicate); the draft
  // overrides identity, the output direction, the enabled keys, and the legal
  // agreement.
  const baseTerms = getDefaultLinkageTerms(draft.identity, draft.metadata);
  // Gate the matching algorithm and per-element fuzzy expansion behind the
  // applied-flags: clamp the built terms so they can NEVER carry a setting the run
  // does not yet honor, regardless of how the draft reached this state (a UI gap,
  // an import). This is the structural guarantee the gating tests pin -- the
  // disabled editor controls and the import refusal are the user-facing half, this
  // is the half that holds even if one of those is bypassed. psi-c is the privacy
  // footgun (a count-only claim while identifiers are revealed); deduplicate's
  // worst case is a silent no-op, but the same clamp applies.
  const algorithm: Algorithm = APPLIED_SETTINGS.psiC ? draft.algorithm : "psi";
  const deduplicate = APPLIED_SETTINGS.deduplicate ? draft.deduplicate : false;
  const enabledKeys = draft.keys
    .filter((entry) => entry.enabled)
    .map((entry) =>
      APPLIED_SETTINGS.fuzzyComparisons ? entry.key : stripFuzzy(entry.key),
    );
  const referenced = new Set(
    enabledKeys.flatMap((key) => key.elements.map((el) => el.field)),
  );
  const linkageFields = baseTerms.linkageFields.filter((field) =>
    referenced.has(field.name),
  );

  const terms: LinkageTerms = {
    ...baseTerms,
    identity: normalizeText(draft.identity),
    algorithm,
    deduplicate,
    // The chosen 3-way output direction; one of the three valid pairs, so it never
    // produces the forbidden "neither receives" combination (see OutputDirection).
    output: outputForDirection(draft.outputDirection),
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

// --- Gated-setting clamp -----------------------------------------------------

/** Drop every element's `generateFuzzyComparisons`, returning the key unchanged
 * when none carries one. The fuzzy half of the {@link buildAdvancedTerms} gating
 * clamp -- the built terms never propose a fuzzy expansion the run does not apply,
 * regardless of how an element acquired one. */
function stripFuzzy(key: LinkageKey): LinkageKey {
  if (key.elements.every((el) => el.generateFuzzyComparisons === undefined))
    return key;
  return {
    ...key,
    elements: key.elements.map((el) => {
      if (el.generateFuzzyComparisons === undefined) return el;
      const next = { ...el };
      delete next.generateFuzzyComparisons;
      return next;
    }),
  };
}

// --- Expert key / element authoring ------------------------------------------
//
// Pure immutable edits over the draft's linkage keys, the tested boundary the
// expert-mode UI drives. Field references are chosen by the caller from the
// declared field list (the metadata-derived offerable set), so a key authored
// through these is referentially valid by construction; the core schema's
// referential-integrity refines remain the single validation source.

/** Replace the linkage key at `keyIndex` by applying `fn` to it. The basis for
 * every expert key edit (rename, swap, and -- via {@link updateElementAt} -- the
 * element edits), so the immutable update lives in one place. */
export function updateKeyAt(
  draft: AdvancedInviteDraft,
  keyIndex: number,
  fn: (key: LinkageKey) => LinkageKey,
): AdvancedInviteDraft {
  return {
    ...draft,
    keys: draft.keys.map((entry, i) =>
      i === keyIndex ? { ...entry, key: fn(entry.key) } : entry,
    ),
  };
}

/** Drop a key's `swap` when either target no longer names one of its element
 * identifiers (`name ?? field`) -- e.g. after the targeted element is removed or
 * its alias/field is edited. Without this an orphaned swap target lingers in the
 * draft and blocks Generate (the schema's swap-target refine rejects it) with a
 * key-list error rather than the swap control simply clearing; pruning keeps the
 * control and the data consistent. Returns the key unchanged when the swap (if
 * any) still resolves, so it never perturbs a valid key's identity. */
function pruneStaleSwap(key: LinkageKey): LinkageKey {
  if (key.swap === undefined) return key;
  const ids = new Set(key.elements.map((el) => el.name ?? el.field));
  if (key.swap.every((target) => ids.has(target))) return key;
  const next = { ...key };
  delete next.swap;
  return next;
}

/** Apply `fn` to one element of one key (field, alias, transform, or fuzzy). A
 * field or alias edit changes the element's identifier, so a now-orphaned swap is
 * pruned (see {@link pruneStaleSwap}). */
export function updateElementAt(
  draft: AdvancedInviteDraft,
  keyIndex: number,
  elementIndex: number,
  fn: (element: LinkageKeyElement) => LinkageKeyElement,
): AdvancedInviteDraft {
  return updateKeyAt(draft, keyIndex, (key) =>
    pruneStaleSwap({
      ...key,
      elements: key.elements.map((el, i) => (i === elementIndex ? fn(el) : el)),
    }),
  );
}

/** Append a new, enabled linkage key with a unique name and a single element
 * referencing `fieldName` (chosen by the caller from the declared fields, so the
 * key is referentially valid and non-empty by construction). */
export function addKey(
  draft: AdvancedInviteDraft,
  fieldName: string,
): AdvancedInviteDraft {
  const name = uniqueKeyName(
    "New key",
    new Set(draft.keys.map((entry) => entry.key.name)),
  );
  const key: LinkageKey = { name, elements: [{ field: fieldName }] };
  return { ...draft, keys: [...draft.keys, { key, enabled: true }] };
}

/** Remove the linkage key at `index`. */
export function removeKey(
  draft: AdvancedInviteDraft,
  index: number,
): AdvancedInviteDraft {
  return { ...draft, keys: draft.keys.filter((_, i) => i !== index) };
}

/** Append an element referencing `fieldName` to the key at `keyIndex`. */
export function addElement(
  draft: AdvancedInviteDraft,
  keyIndex: number,
  fieldName: string,
): AdvancedInviteDraft {
  return updateKeyAt(draft, keyIndex, (key) => ({
    ...key,
    elements: [...key.elements, { field: fieldName }],
  }));
}

/** Remove the element at `elementIndex` from the key at `keyIndex`. A key must
 * keep at least one element (the schema's `.min(1)`); the caller gates the remove
 * control so the last element cannot be removed. */
export function removeElement(
  draft: AdvancedInviteDraft,
  keyIndex: number,
  elementIndex: number,
): AdvancedInviteDraft {
  return updateKeyAt(draft, keyIndex, (key) =>
    pruneStaleSwap({
      ...key,
      elements: key.elements.filter((_, i) => i !== elementIndex),
    }),
  );
}

/** Move an element within its key by one position (-1 earlier, +1 later).
 * Element order is significant -- elements are concatenated and hashed in order --
 * so this is a real matching change, not cosmetic. An out-of-range move is a
 * no-op. */
export function moveElement(
  draft: AdvancedInviteDraft,
  keyIndex: number,
  elementIndex: number,
  direction: -1 | 1,
): AdvancedInviteDraft {
  return updateKeyAt(draft, keyIndex, (key) => {
    const target = elementIndex + direction;
    if (target < 0 || target >= key.elements.length) return key;
    const elements = [...key.elements];
    [elements[elementIndex], elements[target]] = [
      elements[target],
      elements[elementIndex],
    ];
    return { ...key, elements };
  });
}

/** A name not already in `taken`, preferring `base` then `base 2`, `base 3`, ...
 * Keeps authored key names unique (the schema rejects duplicates). Bounded by the
 * taken-set size: among `base` and `base 2..base (size+2)` there are more
 * candidates than taken names, so one is always free within the loop. */
function uniqueKeyName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n <= taken.size + 2; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${taken.size + 3}`;
}

// --- Import ------------------------------------------------------------------

/** Inverse of {@link outputForDirection}: map an {@link Output} pair to the 3-way
 * direction for an imported terms set. The "neither receives"
 * `{ expectsOutput: false, shareWithPartner: false }` pair has no direction; it is
 * NOT rejected by {@link safeParseLinkageTerms} (the schema accepts any two output
 * booleans -- the "neither party expects output" check runs later, in
 * `validateCompatibility` at exchange time), so an imported set could carry it. The
 * final branch maps that (malformed, exchange-rejected) pair to the safe `"both"`
 * default, which the inviter sees selected and reviews before generating, rather
 * than loading a forbidden state silently. */
function directionForOutput(output: Output): OutputDirection {
  if (output.expectsOutput && output.shareWithPartner) return "both";
  if (output.expectsOutput) return "inviter";
  if (output.shareWithPartner) return "partner";
  return "both";
}

/** A message naming any setting an imported terms set turns on that the run does
 * not yet honor (gated by {@link APPLIED_SETTINGS}), or `undefined` when none. The
 * editor refuses such an import rather than load a draft whose headline behavior
 * silently does not happen -- the same gate the disabled GUI controls and the
 * {@link buildAdvancedTerms} clamp enforce, applied at the one door (import) that
 * could otherwise carry a gated setting in from outside. */
export function gatedActiveSettingMessage(
  terms: LinkageTerms,
): string | undefined {
  const blocked: Array<string> = [];
  if (terms.algorithm === "psi-c" && !APPLIED_SETTINGS.psiC)
    blocked.push("count-only matching (psi-c)");
  if (terms.deduplicate && !APPLIED_SETTINGS.deduplicate)
    blocked.push("duplicate matches");
  if (
    !APPLIED_SETTINGS.fuzzyComparisons &&
    terms.linkageKeys.some((key) =>
      key.elements.some((el) => el.generateFuzzyComparisons !== undefined),
    )
  )
    blocked.push("fuzzy comparisons");
  if (blocked.length === 0) return undefined;
  return (
    `These terms turn on ${blocked.join(", ")}, which this version of the ` +
    "exchange does not yet apply. Remove those settings and import again."
  );
}

/** Build an editor draft from imported, validated {@link LinkageTerms}. identity,
 * output direction, algorithm, deduplicate, the optional legal agreement, and
 * every linkage key (all enabled) come from the imported terms; the column
 * metadata stays the inviter's own (`seed.metadata`), since terms carry no
 * per-party column binding, and the lifetime is the caller's (terms do not carry
 * it). Field DEFINITIONS are re-derived from the inviter's columns at build time,
 * so an imported key referencing a field the columns cannot produce surfaces as
 * unsatisfiable rather than silently mis-binding (the deferred multi-field /
 * custom-binding case). The caller refuses a gated-active import first (see
 * {@link gatedActiveSettingMessage}). */
export function draftFromTerms(
  terms: LinkageTerms,
  seed: AdvancedInviteSeed,
  lifetimeSeconds: number = INVITATION_LIFETIME_SECONDS,
): AdvancedInviteDraft {
  return {
    identity: terms.identity,
    lifetimeSeconds,
    outputDirection: directionForOutput(terms.output),
    algorithm: terms.algorithm,
    deduplicate: terms.deduplicate,
    legalAgreement:
      terms.legalAgreement !== undefined
        ? {
            reference: terms.legalAgreement.reference,
            purpose: terms.legalAgreement.purpose,
            expirationDate: terms.legalAgreement.expirationDate,
          }
        : undefined,
    metadata: seed.metadata,
    keys: terms.linkageKeys.map((key) => ({ key, enabled: true })),
  };
}
