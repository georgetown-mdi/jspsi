/**
 * The pure data model behind the inviter's authoring console, split by concern
 * across five siblings and re-exported here as the console's single import
 * surface. No React, no I/O.
 *
 * - {@link ./advancedInviteTypes} -- the shared draft/seed types and the
 *   {@link OutputDirection} <-> {@link Output} mapping the others build on.
 * - {@link ./advancedInviteDraft} -- draft-editing operations: seeding, metadata
 *   reconciliation, expert key/element authoring, and import-to-draft.
 * - {@link ./advancedInviteTerms} -- the linkage-terms mapping: a draft to the
 *   {@link LinkageTerms} it represents, and the inviter's own exchange spec. The
 *   gated-setting clamp (dedup / fuzzy) lives here.
 * - {@link ./advancedInviteValidation} -- the Generate gate, the import-refusal
 *   messages, and the two notices that refuse nothing: an imported rule-set
 *   citation the rebuild drops, and a declared default value the run will not
 *   substitute.
 * - {@link ./linkageComparison} -- the rule-set membership compares taken over
 *   draft-side values, each pruning the explicitly-`undefined` optional
 *   properties core's strict canonical equality cannot read. A lint ban keeps
 *   the rest of `apps/web/src` off core's own predicates, so these four are the
 *   whole surface for those questions.
 */

export type {
  AdvancedField,
  AdvancedInviteDraft,
  AdvancedInviteSeed,
  AdvancedValidation,
  DraftKey,
  DraftLegalAgreement,
  FuzzyComparison,
  OutputDirection,
} from "./advancedInviteTypes";
export { outputForDirection } from "./advancedInviteTypes";

export {
  addElement,
  addKey,
  dateInputFormatForColumns,
  defaultStandardizationForRows,
  draftFromTerms,
  draftWithFieldAdded,
  draftWithKeyEnabled,
  inferDateInputFormat,
  inviterDefaultStandardization,
  moveElement,
  removeElement,
  removeKey,
  seedAdvancedInvite,
  setDraftMetadata,
  setDraftMetadataKeepingKeys,
  updateElementAt,
  updateKeyAt,
} from "./advancedInviteDraft";

export type {
  ImportedCitationDropCause,
  InviterDataEdits,
} from "./advancedInviteTerms";
export {
  buildAdvancedTerms,
  gradeAuthoredKeys,
  importedCitationDropCause,
  inviterExchangeDataSpec,
  standardizationForTerms,
} from "./advancedInviteTerms";

export {
  gatedActiveSettingMessage,
  importedCitationDropNotice,
  importedConstraintDivergenceMessage,
  inertCoalesceNotice,
  validateAdvancedInvite,
} from "./advancedInviteValidation";

export {
  encodeKeyForComparison,
  isDraftDrawnFromLinkageRuleSet,
  isOptInDraftKey,
  linkageRuleSetReferenceForDraft,
} from "./linkageComparison";
