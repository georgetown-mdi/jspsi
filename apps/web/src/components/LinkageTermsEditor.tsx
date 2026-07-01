import { useEffect, useMemo, useRef, useState } from "react";

import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Divider,
  Grid,
  Group,
  Paper,
  Radio,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
  VisuallyHidden,
} from "@mantine/core";
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconArrowDown,
  IconArrowUp,
  IconInfoCircle,
} from "@tabler/icons-react";

import {
  INVITATION_LIFETIME_SECONDS,
  LinkageStrategySchema,
  MAX_NAME_LENGTH,
  MAX_TEXT_LENGTH,
  assessLinkageSatisfiability,
  authoredLinkageFields,
  getDefaultLinkageTerms,
  sanitizeForDisplay,
} from "@psilink/core";

import {
  SEMANTIC_TYPE_LABELS,
  disclosedColumnNames,
  hasMultipleIdentifiers,
} from "@psi/metadataEditing";
import {
  buildAdvancedTerms,
  defaultStandardizationForRows,
  draftFromTerms,
  setDraftMetadata,
  validateAdvancedInvite,
} from "@psi/advancedInvite";
import { APPLIED_SETTINGS } from "@psi/appliedSettings";
import { isSilentEmpty } from "@psi/nonEmptyAggregate";

import { CleaningErrorBoundary } from "@components/CleaningErrorBoundary";
import { DisclosureSection } from "@components/DisclosureSection";
import { ExchangeSummary } from "@components/ExchangeSummary";
import { ExpertKeyEditor } from "@components/ExpertKeyEditor";
import { FieldCoverage } from "@components/FieldCoverage";
import { MetadataGrid } from "@components/MetadataGrid";
import { StandardizationCards } from "@components/StandardizationCards";
import { TermsImportExport } from "@components/TermsImportExport";
import { useDeferredAnnouncement } from "@components/useDeferredAnnouncement";
import { useNonEmptyRates } from "@components/useNonEmptyRates";

import type {
  Algorithm,
  CSVRow,
  LinkageField,
  LinkageTerms,
  Metadata,
  Standardization,
  StandardizationStep,
} from "@psilink/core";

import type {
  AdvancedInviteDraft,
  AdvancedInviteSeed,
  OutputDirection,
} from "@psi/advancedInvite";

/** The two matching-algorithm choices. `psi-c` (count-only) is gated behind
 * {@link APPLIED_SETTINGS}.psiC -- the control is disabled until the run honors
 * it, since a count-only claim the exchange does not apply is a privacy footgun. */
const ALGORITHM_OPTIONS: Array<{ value: Algorithm; label: string }> = [
  { value: "psi", label: "Reveal the matched identifiers (standard)" },
  { value: "psi-c", label: "Reveal only the count (psi-c)" },
];

/** The three output-direction choices, in the order shown. The first
 * ({@link OutputDirection} `"both"`) is the recommended default; the labels are
 * phrased from the inviter's ("you") point of view. */
const OUTPUT_DIRECTION_OPTIONS: Array<{
  value: OutputDirection;
  label: string;
}> = [
  { value: "both", label: "Both you and your partner (recommended)" },
  { value: "inviter", label: "Only you" },
  { value: "partner", label: "Only your partner" },
];

/** Upper bound on the inviter's name, mirroring the quick compose screen's bound
 * (it flows into the token's linkage terms and the deep-link URL). The core schema
 * also bounds it; this keeps the input from accepting an unwieldy value at all. */
const MAX_INVITER_NAME_LENGTH = 200;

/** Selectable invitation lifetimes, all within the core one-year ceiling. The
 * default ({@link INVITATION_LIFETIME_SECONDS}, one hour) is the first option, so
 * an inviter who does not touch this control keeps the quick path's lifetime. */
const LIFETIME_OPTIONS: Array<{ value: string; label: string }> = [
  { value: String(INVITATION_LIFETIME_SECONDS), label: "1 hour (recommended)" },
  { value: String(6 * 3600), label: "6 hours" },
  { value: String(24 * 3600), label: "1 day" },
  { value: String(7 * 24 * 3600), label: "7 days" },
  { value: String(30 * 24 * 3600), label: "30 days" },
  { value: String(365 * 24 * 3600), label: "1 year" },
];

/**
 * The column-aware Advanced-options editor: an edit rail, a live preview rendered
 * by the same {@link InvitationTerms} component the acceptor consent screen uses,
 * and a sticky validation footer. It is seeded from the auto-derived terms for the
 * inviter's columns (never a blank form) and authors only what this iteration
 * supports -- identity, invitation lifetime, an optional legal agreement, which
 * linkage keys are active and in what order, and (under Expert authoring) the
 * linkage strategy.
 *
 * The matching algorithm, deduplication, and fuzzy comparisons are deliberately
 * NOT settable here (see {@link buildAdvancedTerms}): each is a capability not yet
 * honored end-to-end or tracked as its own authoring task, so surfacing it as a
 * control would mint an invitation whose headline behavior silently does not
 * happen. They are visible read-only in the preview (it annotates dedup/fuzzy as
 * proposed-not-applied and states the matching method), so nothing is hidden --
 * only the unselectable controls are absent. The linkage strategy, by contrast, IS
 * settable (it is honored end-to-end), in the expert "Matching settings" block;
 * single-pass is a consented disclosure tradeoff, so the control spells that
 * tradeoff out in plain language at the point of choice. Output sharing IS settable (the 3-way
 * "who receives the matched results" control), and the invitation's payload is now
 * authored too: the send list is derived from each column's disclosure under "Your
 * columns" (so it cannot over-state what transmits), and receive is reconciled from
 * the partner rather than pre-declared -- both honored end-to-end now that output
 * is one-sided-aware and payload reconciliation is lazy.
 *
 * Validation runs through {@link validateAdvancedInvite} (the core schema is the
 * single source); Generate is disabled until the draft parses and at least one key
 * is satisfiable by the inviter's columns, with errors shown inline against the
 * offending control.
 */
export function LinkageTermsEditor({
  seed,
  initialIdentity,
  onGenerate,
  rawRows,
  generating = false,
}: {
  /** The starting point: the auto-derived terms for the inviter's columns, plus
   * the columns (for the live satisfiability check). */
  seed: AdvancedInviteSeed;
  /** The name to prefill the identity field with (carried from the compose
   * screen). Falls back to the seed terms' identity. */
  initialIdentity?: string;
  /** Called with the validated terms, chosen lifetime, and edited column metadata
   * when the inviter presses Generate. The terms are embedded verbatim by
   * `generateInvitation`; the metadata is threaded into the inviter's exchange
   * spec (per-party, never embedded in the token), so its disclosure choices
   * govern what the inviter sends and its bindings match the run. */
  onGenerate: (
    terms: LinkageTerms,
    lifetimeSeconds: number,
    metadata: Metadata,
    standardization: Standardization,
  ) => void;
  /** The parsed rows, for the data-prep workbench's before/after preview. */
  rawRows: Array<CSVRow>;
  /** Holds Generate disabled while an invitation is being generated. */
  generating?: boolean;
}) {
  // The recommended starting draft: the seed's metadata-derived terms restated as
  // an editable draft (every key enabled, the default lifetime, the prefilled
  // name). "Reset to recommended" re-runs this. Built from seed.terms rather than
  // re-deriving via seedAdvancedInvite -- the seed already holds that derivation,
  // so this stays a cheap restatement, not a second metadata inference.
  const freshDraft = (): AdvancedInviteDraft => ({
    identity: initialIdentity ?? seed.terms.identity,
    lifetimeSeconds: INVITATION_LIFETIME_SECONDS,
    // The recommended default is the symmetric both-receive exchange.
    outputDirection: "both",
    // The recommended psi / no-dedup settings; the gated controls hold these here
    // until APPLIED_SETTINGS flips (buildAdvancedTerms clamps them regardless).
    algorithm: seed.terms.algorithm,
    deduplicate: seed.terms.deduplicate,
    // Carried from the recommended terms like algorithm/deduplicate above
    // (currently `cascade`, the schema default). Ungated. "Reset to recommended"
    // re-runs freshDraft, so it restores whatever the recommended strategy is --
    // clearing a single-pass selection back to the default.
    linkageStrategy: seed.terms.linkageStrategy,
    metadata: seed.metadata,
    // The recommended per-type cleaning, with the dob format inferred from the
    // rows; authoredLinkageFields over it reproduces the default field set, so the
    // restated draft's terms equal the seed's.
    standardization: defaultStandardizationForRows(
      seed.metadata,
      seed.terms,
      rawRows,
    ),
    keys: seed.terms.linkageKeys.map((key) => ({ key, enabled: true })),
  });
  const [draft, setDraft] = useState<AdvancedInviteDraft>(freshDraft);

  // Expert authoring discloses direct key/element/transform/swap editing, the
  // gated matching settings, and the import/export escape hatch on the same draft;
  // the guided controls stay for the common path. A UI disclosure level, not a
  // data mode -- both views edit the same draft.keys.
  const [expertMode, setExpertMode] = useState(false);

  // Set once the key list becomes author-controlled (an expert key edit or an
  // import), and never cleared except by Reset. It, not the transient expertMode
  // toggle, governs whether a metadata edit reconciles the keys (see
  // updateMetadata): without it, authoring keys then toggling expert mode off would
  // let the next metadata edit silently re-derive the key list and drop the
  // authored keys.
  const [keysAuthored, setKeysAuthored] = useState(false);

  // A polite live region for validation and reorder announcements, kept in a
  // stable wrapper so assistive tech announces updates (the Status component uses
  // the same idiom). Reorder sets a specific message; it is cleared by the next
  // interaction so it does not linger.
  const [announcement, setAnnouncement] = useState("");

  // The cleaning section is now always shown (no longer gated behind expert mode) and
  // open by default since it is first-class, but collapsible so the rail can be tamed.
  const [cleaningOpen, setCleaningOpen] = useState(true);

  // Focus the editor heading once on mount so a keyboard/screen-reader user who
  // arrived from the compose screen lands on the editor, not the unmounted link.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const validation = useMemo(
    () => validateAdvancedInvite(draft, seed),
    [draft, seed],
  );
  const previewTerms = useMemo(() => buildAdvancedTerms(draft), [draft]);

  // The single-identifier gate, mirroring the acceptor (PrepareData's
  // `multipleIdentifiers`): `inferMetadata` can SEED two row-identifier columns
  // (an `id` and an `identifier` both infer to `role: identifier`), which the
  // grid surfaces as its red "Only one column can be the row identifier" error.
  // Fold it into a single `canGenerate` used uniformly by the footer status, the
  // Generate button, and `handleGenerate`, so the three stay consistent and an
  // invitation cannot be minted while the metadata is in that known-invalid state.
  // `validateAdvancedInvite` is metadata-disclosure-agnostic by design, so this
  // stays a component gate over the same predicate the acceptor uses rather than a
  // new validation rule.
  const canGenerate =
    validation.canGenerate && !hasMultipleIdentifiers(draft.metadata);

  // The footer status's spoken form for the deferred announcer below. Worded
  // differently from the visible footer text on purpose (one concise spoken line),
  // which also keeps the visible-text test query unambiguous. Deferred so the
  // blocked state present on MOUNT (e.g. a two-identifier seed) is announced as an
  // empty -> non-empty transition rather than skipped as present-on-mount content,
  // while still queuing politely behind the heading focus.
  const footerStatusAnnouncement = canGenerate
    ? "The invitation is ready to generate."
    : "Some highlighted items still need to be resolved before you can generate the invitation.";
  const deferredFooterAnnouncement = useDeferredAnnouncement(
    footerStatusAnnouncement,
  );

  // Per-key satisfiability badge, derived from the draft's CURRENT metadata AND
  // authored standardization so it tracks both column-type edits and per-field
  // column bindings. A field is producible when the shared resolution binds it to a
  // present column; deriving the field universe from authoredLinkageFields (not the
  // one-field-per-type default) and resolving through draft.standardization -- the
  // same inputs the Generate gate and the declared-field list use -- is what lets an
  // authored same-typed second field (e.g. first_name_2) read as satisfiable. With
  // the bare default field set and no standardization, such a field is absent from
  // the universe and its key would wrongly badge unsatisfiable while it generates
  // and produces at the exchange.
  const producibleFieldNames = useMemo(() => {
    // identity is deliberately NOT a dependency: getDefaultLinkageTerms uses it
    // only to populate terms.identity, never to derive the field or key set, so
    // it cannot change which fields are producible. Pass a constant so a keystroke
    // in the name field does not recompute this (and the real input sensitivity --
    // the column metadata and standardization -- stays legible in the dependency
    // array). The probe restates the authored fields onto default terms; only its
    // linkageFields are read (resolveFieldColumns ignores linkageKeys), so the
    // default keys are inert.
    const fields = authoredLinkageFields(draft.metadata, draft.standardization);
    const probe: LinkageTerms = {
      ...getDefaultLinkageTerms("", draft.metadata),
      linkageFields: fields,
    };
    const { unsatisfied } = assessLinkageSatisfiability(
      seed.columns,
      probe,
      draft.standardization,
      draft.metadata,
    );
    const unsatisfiedNames = new Set(unsatisfied.map((f) => f.name));
    return new Set(
      fields.map((f) => f.name).filter((name) => !unsatisfiedNames.has(name)),
    );
  }, [draft.metadata, draft.standardization, seed.columns]);
  const keyIsSatisfiable = (index: number): boolean =>
    draft.keys[index].key.elements.every((el) =>
      producibleFieldNames.has(el.field),
    );

  // The fields a key element may reference, metadata-derived (one per `role: linkage`
  // typed column). The expert field-pickers offer exactly these, so a key authored
  // in the editor can only reference a declared field.
  // The fields a key element may reference: derived from the authored standardization
  // (not the one-field-per-type default), so when the operator binds two transformations
  // of one semantic type to distinct columns the expert key editor offers BOTH fields.
  // With no authored cleaning this equals the default per-type field set (the seed's
  // standardization reproduces it), so the guided path is unchanged.
  const declaredFields = useMemo(
    () => authoredLinkageFields(draft.metadata, draft.standardization),
    [draft.metadata, draft.standardization],
  );

  // Per-party full-CSV coverage for the inviter's OWN cleaning -- parity with the
  // acceptor, which the inviter previously lacked: an inviter could silently collapse
  // a field (under-matching its own rows) with no warning. The visible per-field
  // FieldCoverage is rendered inside StandardizationCards; this hook feeds it and the
  // editor-wide announcer below.
  const { rates: nonEmptyRates, pending: ratesPending } = useNonEmptyRates(
    rawRows,
    draft.standardization,
  );
  const fieldByName = useMemo(
    () => new Map(declaredFields.map((field) => [field.name, field])),
    [declaredFields],
  );
  // The safe semantic-type labels of fields whose transform drops every row, for the
  // single editor-wide announcement (the partner-controlled `output` is never
  // announced raw). Empty until the first sweep settles, so nothing announces on mount.
  const silentEmptyLabels = useMemo(() => {
    if (nonEmptyRates === null) return [];
    const labels = new Set<string>();
    for (const transformation of draft.standardization) {
      const rate = nonEmptyRates.get(transformation.output);
      const field = fieldByName.get(transformation.output);
      if (rate !== undefined && field !== undefined && isSilentEmpty(rate))
        labels.add(SEMANTIC_TYPE_LABELS[field.type]);
    }
    return [...labels];
  }, [nonEmptyRates, draft.standardization, fieldByName]);
  const coverageAnnouncement =
    silentEmptyLabels.length === 0
      ? ""
      : `Coverage warning: ${silentEmptyLabels.join(", ")} ${
          silentEmptyLabels.length === 1 ? "produces" : "produce"
        } no value for any row and cannot match. Check the cleaning steps.`;

  // The inviter's `role: linkage` columns of a semantic type, in metadata order --
  // the columns a same-typed field MAY bind to. Drives the add-field free-column
  // search below (StandardizationCards computes its own copy for the affordance).
  const columnsForType = (
    metadata: Metadata,
    type: LinkageField["type"],
  ): Array<string> =>
    metadata
      .filter((column) => column.role === "linkage" && column.type === type)
      .map((column) => column.name);

  // A signature of each field's input binding for the cleaning error boundary's
  // auto-recovery (see CleaningErrorBoundary); a reset or remap changes it.
  const cleaningResetKey = useMemo(
    () => draft.standardization.map((t) => `${t.output}=${t.input}`).join(","),
    [draft.standardization],
  );

  // Per-field standardization edits on the inviter's source-of-truth array (its
  // direct-mutation model, vs the acceptor's override layer). The shared
  // StandardizationCards emits granular intents; the inviter ignores the echoed
  // `input` (it matches on `output`).
  const setFieldSteps = (
    output: string,
    _input: string,
    steps: Array<StandardizationStep>,
  ) =>
    setDraft((prev) => ({
      ...prev,
      standardization: prev.standardization.map((t) =>
        t.output === output ? { ...t, steps } : t,
      ),
    }));
  const setFieldInput = (output: string, column: string) =>
    setDraft((prev) => ({
      ...prev,
      standardization: prev.standardization.map((t) =>
        t.output === output ? { ...t, input: column } : t,
      ),
    }));
  const removeField = (output: string) =>
    setDraft((prev) => ({
      ...prev,
      standardization: prev.standardization.filter((t) => t.output !== output),
    }));
  // Append a same-typed field bound to its first free column, named uniquely off the
  // type's first field and seeded with its steps (so the second field starts from the
  // same recommended pipeline). Migrated from the deleted StandardizationWorkbench;
  // it reads the host's authoritative array via the functional updater, so the
  // affordance the component gates on `addableTypes` and this free-column search stay
  // consistent (the early return never fires while the component shows the button).
  const addFieldForType = (type: LinkageField["type"]) =>
    setDraft((prev) => {
      const bound = new Set(prev.standardization.map((t) => t.input));
      const freeColumn = columnsForType(prev.metadata, type).find(
        (c) => !bound.has(c),
      );
      if (freeColumn === undefined) return prev;
      const typeByOutput = new Map(
        authoredLinkageFields(prev.metadata, prev.standardization).map((f) => [
          f.name,
          f.type,
        ]),
      );
      const sibling = prev.standardization.find(
        (t) => typeByOutput.get(t.output) === type,
      );
      const base = sibling?.output ?? type;
      const taken = new Set(prev.standardization.map((t) => t.output));
      let n = 2;
      let output = `${base}_${n}`;
      while (taken.has(output)) output = `${base}_${++n}`;
      return {
        ...prev,
        standardization: [
          ...prev.standardization,
          { output, input: freeColumn, steps: sibling?.steps ?? [] },
        ],
      };
    });

  const updateDraft = (next: Partial<AdvancedInviteDraft>) => {
    setAnnouncement("");
    setDraft((prev) => ({ ...prev, ...next }));
  };

  // A column-metadata edit re-derives the offerable key set (a type change adds or
  // drops keys) and reconciles the enabled/order state -- see setDraftMetadata.
  // Once the keys are author-controlled (keysAuthored: an expert edit or an
  // import), reconciliation (which is template-driven) would drop authored keys, so
  // the edit then updates only the metadata and the satisfiability badges
  // re-evaluate against it. The decision keys off keysAuthored ALONE, not the
  // expertMode toggle: merely opening expert mode (no edits yet) leaves the keys as
  // the metadata template, so a type change there must still reconcile -- and after
  // Reset (keysAuthored cleared) reconciliation resumes even while expert mode
  // stays open.
  const updateMetadata = (metadata: Metadata) => {
    setAnnouncement("");
    // Decide whether to reconcile at event time (reading the current keysAuthored),
    // not inside the functional updater -- the updater stays a pure function of
    // `prev` (the latest draft), which is all it needs `prev` for: to compose with a
    // batched key edit.
    const reconcile = !keysAuthored;
    setDraft((prev) =>
      reconcile
        ? setDraftMetadata(prev, metadata, rawRows)
        : { ...prev, metadata },
    );
  };

  const toggleKey = (index: number, enabled: boolean) => {
    updateDraft({
      keys: draft.keys.map((entry, i) =>
        i === index ? { ...entry, enabled } : entry,
      ),
    });
  };

  const moveKey = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= draft.keys.length) return;
    const keys = [...draft.keys];
    [keys[index], keys[target]] = [keys[target], keys[index]];
    setDraft((prev) => ({ ...prev, keys }));
    setAnnouncement(
      `Moved ${sanitizeForDisplay(keys[target].key.name)} to position ${target + 1} of ${keys.length}. ` +
        "Keys earlier in the list match first.",
    );
  };

  const setLegalEnabled = (enabled: boolean) => {
    updateDraft({
      legalAgreement: enabled
        ? { reference: "", purpose: "", expirationDate: "" }
        : undefined,
    });
  };
  const updateLegal = (
    next: Partial<NonNullable<AdvancedInviteDraft["legalAgreement"]>>,
  ) => {
    // Merge inside the functional updater (reading `prev`, not the render
    // closure), so two legal-field updates in one batch cannot clobber each
    // other -- matching updateDraft's own batching protection. No-op when the
    // block is closed (legalAgreement undefined, only reachable if a field update
    // were batched after a disclosure-toggle off): spreading undefined would
    // silently build a partial block rather than throw, so guard it instead.
    setAnnouncement("");
    setDraft((prev) =>
      prev.legalAgreement === undefined
        ? prev
        : { ...prev, legalAgreement: { ...prev.legalAgreement, ...next } },
    );
  };

  const handleReset = () => {
    setDraft(freshDraft());
    // Reset returns to the guided, metadata-derived key set, so metadata edits
    // reconcile again.
    setKeysAuthored(false);
    setAnnouncement("Reset to the recommended settings.");
  };

  // Load an imported, validated terms set into the draft (the import panel has
  // already refused any gated-active setting). The metadata stays the inviter's
  // own columns -- terms carry no per-party binding -- and draftFromTerms
  // reconstructs the local standardization from the imported field declarations:
  // a multi-field document's distinct same-typed bindings are restored when the
  // columns can supply them, and a key the columns cannot satisfy shows as
  // not-satisfiable rather than silently breaking.
  const handleImport = (terms: LinkageTerms) => {
    setDraft(draftFromTerms(terms, seed, draft.lifetimeSeconds, rawRows));
    // The imported keys are author-controlled (not the metadata template), so a
    // later metadata edit must not reconcile them away.
    setKeysAuthored(true);
    setAnnouncement(
      "Loaded the imported terms. Review them, then generate the invitation.",
    );
  };

  const handleGenerate = () => {
    if (!canGenerate || validation.terms === undefined) return;
    onGenerate(
      validation.terms,
      draft.lifetimeSeconds,
      draft.metadata,
      draft.standardization,
    );
  };

  // Focus the first legal-agreement field when the block is disclosed, so a
  // keyboard user is taken into it rather than left on the checkbox.
  const legalRefInput = useRef<HTMLInputElement>(null);
  const legalOpen = draft.legalAgreement !== undefined;
  const wasLegalOpen = useRef(legalOpen);
  useEffect(() => {
    if (legalOpen && !wasLegalOpen.current) legalRefInput.current?.focus();
    wasLegalOpen.current = legalOpen;
  }, [legalOpen]);

  const { errors } = validation;

  // The columns this party will send as payload, derived from the grid's disclosure
  // choices (the same isDisclosedToPartner predicate buildAdvancedTerms authors
  // terms.payload.send from), so this summary cannot drift from what the invitation
  // declares or what actually transmits. `receive` is not authored here: the inviter
  // takes whatever the partner discloses (see buildAdvancedTerms / the lazy
  // validateCompatibility). The inviter receives payload only when it receives a
  // result at all (output direction is not "only your partner").
  const sentColumns = disclosedColumnNames(draft.metadata);
  const inviterReceivesResult = draft.outputDirection !== "partner";

  return (
    <Stack>
      <Grid gap="xl" align="flex-start">
        {/* Edit rail */}
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Stack component="section" aria-label="Invitation settings" gap="lg">
            <Title order={2} size="h2" ref={headingRef} tabIndex={-1}>
              Customize your invitation
            </Title>
            <Text size="sm" c="dimmed">
              These settings are filled in from your file. Review and adjust
              them, then generate the invitation. Choose Reset to recommended to
              return to the defaults at any time.
            </Text>

            <Switch
              checked={expertMode}
              onChange={(e) => setExpertMode(e.currentTarget.checked)}
              label="Expert authoring"
              description="Build linkage keys element by element, edit transforms and swaps, and import or export the terms as JSON or YAML."
            />

            <TextInput
              value={draft.identity}
              onChange={(e) => updateDraft({ identity: e.target.value })}
              maxLength={MAX_INVITER_NAME_LENGTH}
              withAsterisk
              required
              label="Your name"
              description="Recorded in the invitation's linkage terms so your partner can identify you"
              placeholder="Your name"
              error={errors.identity}
              errorProps={{ role: "alert" }}
            />

            <Select
              label="Invitation lifetime"
              description="How long this invitation can be accepted before it expires"
              data={LIFETIME_OPTIONS}
              value={String(draft.lifetimeSeconds)}
              allowDeselect={false}
              onChange={(value) =>
                value !== null &&
                updateDraft({ lifetimeSeconds: Number(value) })
              }
              error={errors.lifetime}
              errorProps={{ role: "alert" }}
            />

            <Select
              label="Who receives the matched results"
              description="Both parties, only you, or only your partner. The party that receives nothing still contributes its records to find the match."
              data={OUTPUT_DIRECTION_OPTIONS}
              value={draft.outputDirection}
              allowDeselect={false}
              // The three options are the only valid output pairs, so a choice can
              // never yield the forbidden "neither party receives" combination
              // (buildAdvancedTerms maps each via outputForDirection). Mantine
              // infers the value type from the typed data, so `value` is already an
              // OutputDirection after the null guard.
              onChange={(value) =>
                value !== null && updateDraft({ outputDirection: value })
              }
            />

            <Stack gap="xs">
              <Text size="sm" fw={600}>
                Your columns
              </Text>
              <Text size="xs" c="dimmed">
                Set what each column is and whether it is sent to your partner.
                Changing a column&apos;s type updates which matching rules below
                you can use.
              </Text>
              <MetadataGrid
                metadata={draft.metadata}
                onChange={updateMetadata}
                caption="Your columns, their types, and how each is used"
              />
            </Stack>

            {/* Payload control. Send is authored through the grid's per-column
                disclosure above (this summarizes the result); receive is not
                author-time: the inviter does not have the partner's schema, so it
                takes whatever the partner discloses. The coherence rule (no sending
                to a partner that receives no result) is enforced live via
                errors.payload. */}
            <Stack gap="xs">
              <Text size="sm" fw={600}>
                Extra data for matched records
              </Text>
              {sentColumns.length > 0 ? (
                <Text size="xs">
                  <Text span fw={600}>
                    You will send:
                  </Text>{" "}
                  {sentColumns.join(", ")}. Choose which columns are sent by
                  setting them to &ldquo;Sent to your partner&rdquo; under Your
                  columns above.
                </Text>
              ) : (
                <Text size="xs" c="dimmed">
                  You are not sending any extra columns. Set a column to
                  &ldquo;Sent to your partner&rdquo; under Your columns above to
                  include it.
                </Text>
              )}
              {inviterReceivesResult ? (
                <Text size="xs">
                  <Text span fw={600}>
                    You will receive:
                  </Text>{" "}
                  whatever extra columns your partner chooses to send. You
                  don&apos;t pick these in advance &mdash; your partner sets
                  them from their own file, and you receive them for your
                  matched records.
                </Text>
              ) : (
                <Text size="xs" c="dimmed">
                  You receive no result, so your partner sends you no extra
                  columns.
                </Text>
              )}
              {errors.payload && (
                // The payload control can carry two distinct problems at once (a
                // schema/column error and the send-direction conflict), joined with
                // a newline by validateAdvancedInvite; pre-line renders them as
                // separate lines rather than one run-on paragraph.
                <Text
                  size="xs"
                  c="red"
                  role="alert"
                  style={{ whiteSpace: "pre-line" }}
                >
                  {errors.payload}
                </Text>
              )}
            </Stack>

            {/* The per-party data-prep cleaning: now ALWAYS shown (no longer gated
                behind expert mode), open by default since it is first-class, in a
                collapsible section so the rail stays tame. Per-party and local --
                never embedded in the token. Adding/removing same-typed fields stays
                an expert affordance (it is a key-authoring decision); the cleaning
                STEPS, including raw patterns, are available to everyone. */}
            <DisclosureSection
              label="Clean and bind your fields"
              open={cleaningOpen}
              onToggle={setCleaningOpen}
              headingOrder={3}
            >
              <Stack gap="xs" mt="xs">
                <Text size="xs" c="dimmed">
                  Each field is read from one of your columns and cleaned by an
                  ordered list of steps before matching. Cleaning runs on your
                  device and changes only your own match rate; it is never sent
                  to your partner.
                </Text>
                {/* Raw-pattern (regex) steps are available without a gate. This
                    non-blocking note states the consequence; each regex step carries
                    an "advanced" badge and the preview shows its effect. */}
                <Text size="xs" c="dimmed">
                  Some steps use raw patterns (marked &ldquo;advanced&rdquo;).
                  They change which of your rows match -- check the preview.
                  Patterns over 1000 characters are rejected.
                </Text>
                <CleaningErrorBoundary
                  onReset={handleReset}
                  resetKey={cleaningResetKey}
                >
                  <StandardizationCards
                    standardization={draft.standardization}
                    declaredFields={declaredFields}
                    metadata={draft.metadata}
                    rawRows={rawRows}
                    onStepsChange={setFieldSteps}
                    onInputColumnChange={setFieldInput}
                    // Add/remove same-typed fields is an expert affordance; an omitted
                    // callback removes it. Cleaning steps stay available regardless.
                    onAddField={expertMode ? addFieldForType : undefined}
                    onRemoveField={expertMode ? removeField : undefined}
                    renderCoverage={(output) => (
                      <FieldCoverage
                        rate={nonEmptyRates?.get(output)}
                        // Suppress the first-paint "Checking..." placeholders (the
                        // inviter never had coverage before): show nothing until the
                        // first sweep settles, then the rate.
                        pending={nonEmptyRates !== null && ratesPending}
                      />
                    )}
                    isFieldSilentEmpty={(output) => {
                      const rate = nonEmptyRates?.get(output);
                      return rate !== undefined && isSilentEmpty(rate);
                    }}
                    onMissingField="skip"
                  />
                </CleaningErrorBoundary>
                {/* One polite, atomic editor-wide live region for a silent-empty
                    collapse (per-card FieldCoverage alarms are role="presentation"). */}
                <VisuallyHidden
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {coverageAnnouncement}
                </VisuallyHidden>
              </Stack>
            </DisclosureSection>

            {/* The cleaning launch gate (errors.standardization), shown OUTSIDE the
                collapsible section so a blocking malformed step surfaces even when
                cleaning is collapsed. Parallel to the acceptor's standardizationValid
                message. */}
            {errors.standardization && (
              <Text size="xs" c="red" role="alert">
                {errors.standardization}
              </Text>
            )}

            <Stack gap="xs">
              <Text size="sm" fw={600}>
                Records are matched on
              </Text>
              <Text size="xs" c="dimmed" id="key-order-help">
                {expertMode
                  ? "Build each key from elements that reference your declared fields. Earlier keys match first, so order the most precise keys first."
                  : "Each enabled key is tried in order; earlier keys match first, so order the most precise keys first. Turn off a key to exclude it."}
              </Text>
              {errors.keys && (
                <Text size="xs" c="red" role="alert">
                  {errors.keys}
                </Text>
              )}
              {expertMode ? (
                <ExpertKeyEditor
                  draft={draft}
                  declaredFields={declaredFields}
                  keyIsSatisfiable={keyIsSatisfiable}
                  fuzzyApplied={APPLIED_SETTINGS.fuzzyComparisons}
                  onChange={(next) => {
                    setAnnouncement("");
                    // The keys are now author-controlled; suppress metadata-driven
                    // reconciliation from here on (even after expert mode is off).
                    setKeysAuthored(true);
                    setDraft(next);
                  }}
                  announce={setAnnouncement}
                />
              ) : (
                <Stack
                  gap="xs"
                  component="ul"
                  aria-describedby="key-order-help"
                  style={{ listStyle: "none", padding: 0, margin: 0 }}
                >
                  {draft.keys.map((entry, index) => {
                    const satisfiable = keyIsSatisfiable(index);
                    // The key name is operator-authored but can be self-imported from
                    // a JSON/YAML document, so sanitize it for display and in
                    // accessible names -- the same discipline ExpertKeyEditor applies
                    // -- rather than rendering partner-influenceable text raw.
                    const keyLabel = sanitizeForDisplay(entry.key.name);
                    return (
                      <Paper
                        key={entry.key.name}
                        withBorder
                        p="xs"
                        component="li"
                      >
                        <Group justify="space-between" wrap="nowrap">
                          <Checkbox
                            checked={entry.enabled}
                            onChange={(e) =>
                              toggleKey(index, e.currentTarget.checked)
                            }
                            label={
                              <Group gap="xs" wrap="nowrap">
                                <Text size="sm">{keyLabel}</Text>
                                <Badge
                                  size="xs"
                                  variant="light"
                                  color={satisfiable ? "green" : "red"}
                                  role="img"
                                  aria-label={
                                    satisfiable
                                      ? "Your columns can satisfy this key"
                                      : "Your columns cannot satisfy this key"
                                  }
                                >
                                  {satisfiable
                                    ? "satisfiable"
                                    : "not satisfiable"}
                                </Badge>
                              </Group>
                            }
                          />
                          <Group gap={4} wrap="nowrap">
                            <ActionIcon
                              variant="subtle"
                              disabled={index === 0}
                              onClick={() => moveKey(index, -1)}
                              aria-label={`Move ${keyLabel} earlier`}
                            >
                              <IconArrowUp size={16} />
                            </ActionIcon>
                            <ActionIcon
                              variant="subtle"
                              disabled={index === draft.keys.length - 1}
                              onClick={() => moveKey(index, 1)}
                              aria-label={`Move ${keyLabel} later`}
                            >
                              <IconArrowDown size={16} />
                            </ActionIcon>
                          </Group>
                        </Group>
                      </Paper>
                    );
                  })}
                </Stack>
              )}
            </Stack>

            <Divider />

            <Stack gap="xs">
              <Checkbox
                checked={legalOpen}
                onChange={(e) => setLegalEnabled(e.currentTarget.checked)}
                label="Attach a legal agreement"
                description="Reference, purpose, and expiry your partner must enter identically"
              />
              {/* The `!== undefined` is load-bearing for type narrowing (it is
                  what lets the fields below read draft.legalAgreement.*), not a
                  duplicate of legalOpen. */}
              {draft.legalAgreement !== undefined && (
                <Stack gap="sm" pl="md">
                  <Alert
                    variant="light"
                    color="blue"
                    icon={<IconInfoCircle aria-hidden />}
                  >
                    Your partner must enter the reference, purpose, and
                    expiration date exactly as written here, or the exchange
                    will be refused.
                  </Alert>
                  <TextInput
                    ref={legalRefInput}
                    value={draft.legalAgreement.reference}
                    onChange={(e) => updateLegal({ reference: e.target.value })}
                    maxLength={MAX_NAME_LENGTH}
                    label="Agreement reference"
                    placeholder="MOU-2025-0042"
                    error={errors.legalReference}
                    errorProps={{ role: "alert" }}
                  />
                  <TextInput
                    value={draft.legalAgreement.purpose}
                    onChange={(e) => updateLegal({ purpose: e.target.value })}
                    maxLength={MAX_TEXT_LENGTH}
                    label="Purpose of the disclosure"
                    placeholder="Program evaluation"
                    error={errors.legalPurpose}
                    errorProps={{ role: "alert" }}
                  />
                  <TextInput
                    type="date"
                    value={draft.legalAgreement.expirationDate}
                    onChange={(e) =>
                      updateLegal({ expirationDate: e.target.value })
                    }
                    label="Expiration date"
                    error={errors.legalExpiration}
                    errorProps={{ role: "alert" }}
                  />
                </Stack>
              )}
            </Stack>

            {expertMode ? (
              <>
                <Divider />
                <Stack gap="xs">
                  <Text size="sm" fw={600}>
                    Matching settings
                  </Text>
                  {/* Linkage strategy leads the section and, unlike the two controls
                      below it, is NOT disabled: single-pass is honored end-to-end, so
                      the one live control here should not read as bracketed by the
                      disabled-until-applied psi-c/dedup ones. single-pass is a
                      consented disclosure tradeoff, not a free speed-up, so the option
                      states the tradeoff plainly at the point of choice and an Alert
                      reinforces it once selected -- holding the app's bar of making
                      disclosure consent visible. */}
                  <Radio.Group
                    label="Linkage strategy"
                    description="How the agreed keys are exchanged. Both produce the same matched result; they differ in the number of network round trips and in what one party discloses to the other."
                    value={draft.linkageStrategy}
                    onChange={(value) =>
                      // The radio values are exactly the LinkageStrategy union, so the
                      // schema parse narrows Mantine's string with no cast -- and would
                      // throw loudly if an option ever drifted from the enum.
                      updateDraft({
                        linkageStrategy: LinkageStrategySchema.parse(value),
                      })
                    }
                  >
                    <Stack gap="xs" mt="xs">
                      <Radio
                        value="cascade"
                        label="Cascade (recommended)"
                        description="Default. Matches the keys one at a time -- more network round trips, but less is observed along the way."
                      />
                      <Radio
                        value="single-pass"
                        label="Single-pass"
                        description="Batches every key into one exchange, so the number of round trips stays constant no matter how many keys -- which makes a multi-key linkage practical over a high-latency file-drop or SFTP channel. In exchange, one party discloses its full per-key value structure to the other, who then sees matches on less precise keys that cascade would have filtered out first. The matched result is identical either way."
                      />
                    </Stack>
                  </Radio.Group>
                  {draft.linkageStrategy === "single-pass" && (
                    // role="alert" is Mantine's default for Alert, but it is set
                    // explicitly here because the announcement is load-bearing: this
                    // is the consent reinforcement an assistive-technology user hears
                    // on selecting single-pass, so it must stay an (assertive) live
                    // region regardless of any future default change.
                    <Alert
                      variant="light"
                      color="yellow"
                      role="alert"
                      icon={<IconAlertTriangle aria-hidden />}
                      title="Single-pass widens what one of you can observe"
                    >
                      Both parties must agree to single-pass, and one of you
                      will hand the other its full per-key value structure --
                      which party is settled at exchange time, so it may be you.
                      The records you match are unchanged -- only what is
                      observed along the way.
                    </Alert>
                  )}
                  {/* psi-c and deduplicate are surfaced disabled until the run
                      applies them (APPLIED_SETTINGS), so the capability is
                      discoverable but cannot mint an invitation whose headline
                      behavior silently does not happen. buildAdvancedTerms clamps
                      them regardless, so a disabled control can never leak through. */}
                  <Select
                    label="Matching method"
                    data={ALGORITHM_OPTIONS}
                    value={draft.algorithm}
                    allowDeselect={false}
                    disabled={!APPLIED_SETTINGS.psiC}
                    description={
                      APPLIED_SETTINGS.psiC
                        ? "Reveal the matched identifiers, or only the count."
                        : "Count-only (psi-c) is not available yet: this version of the exchange reveals the matched identifiers regardless."
                    }
                    onChange={(value) =>
                      // Mantine infers the value type from the typed data, so it is
                      // already an Algorithm after the null guard.
                      value !== null && updateDraft({ algorithm: value })
                    }
                  />
                  <Checkbox
                    label="Allow more than one of your records to match the same partner record"
                    checked={draft.deduplicate}
                    disabled={!APPLIED_SETTINGS.deduplicate}
                    description={
                      APPLIED_SETTINGS.deduplicate
                        ? undefined
                        : "Not available yet: each record matches at most one regardless."
                    }
                    onChange={(e) =>
                      updateDraft({ deduplicate: e.currentTarget.checked })
                    }
                  />
                </Stack>
                <Divider />
                <TermsImportExport
                  currentTerms={previewTerms}
                  seed={seed}
                  rawRows={rawRows}
                  onImport={handleImport}
                />
              </>
            ) : (
              <Alert
                variant="light"
                color="gray"
                icon={<IconInfoCircle aria-hidden />}
                title="Fixed in this version"
              >
                Matched identifiers are revealed (not just a count), and each
                record matches at most one of your partner&apos;s. These are not
                adjustable yet. Who receives the matched results is set above;
                which of your columns are sent to your partner is set per column
                under Your columns above. Turn on Expert authoring to build keys
                directly or import and export the terms.
              </Alert>
            )}
          </Stack>
        </Grid.Col>

        {/* Live preview */}
        <Grid.Col span={{ base: 12, md: 5 }}>
          <Stack
            component="section"
            aria-label="Live preview of your invitation"
            gap="sm"
            // Sticky: the inviter's preview genuinely updates as the rail is edited,
            // so keeping it in view is worth the pinned column (the acceptor's
            // read-once terms are not sticky). No header to clear, so a spacing offset.
            style={{ position: "sticky", top: "var(--mantine-spacing-md)" }}
          >
            <ExchangeSummary
              linkageTerms={previewTerms}
              perspective="proposing"
              headingOrder={3}
            />
          </Stack>
        </Grid.Col>
      </Grid>

      {/* Sticky validation footer */}
      <Box
        style={{
          position: "sticky",
          bottom: 0,
          background: "var(--mantine-color-body)",
          borderTop: "1px solid var(--mantine-color-default-border)",
          paddingTop: "var(--mantine-spacing-sm)",
          paddingBottom: "var(--mantine-spacing-sm)",
          zIndex: 1,
        }}
      >
        <Group justify="space-between">
          {/* The VISIBLE footer status renders immediately and is NOT a live
              region: the spoken Ready <-> Resolve status is voiced by the deferred
              polite region below (the same decoupled idiom as PrepareData's
              verdict). Decoupling lets the blocked state present on MOUNT (the
              inviter seeded with two identifiers) announce as an empty ->
              non-empty transition rather than be skipped as present-on-mount
              content, while still queuing politely behind the heading focus. */}
          <div>
            {canGenerate ? (
              <Text size="sm" c="dimmed">
                Ready to generate.
              </Text>
            ) : (
              <Text size="sm" c="red">
                <IconAlertCircle
                  size={16}
                  aria-hidden
                  style={{ verticalAlign: "text-bottom", marginRight: 4 }}
                />
                Resolve the highlighted items to continue.
              </Text>
            )}
          </div>
          <Group gap="sm">
            <Button variant="default" onClick={handleReset}>
              Reset to recommended
            </Button>
            <Button
              onClick={handleGenerate}
              disabled={!canGenerate || generating}
              loading={generating}
            >
              Generate invitation
            </Button>
          </Group>
        </Group>
      </Box>

      {/* Polite live region for validation/reorder announcements. */}
      <VisuallyHidden role="status" aria-live="polite">
        {announcement}
      </VisuallyHidden>
      {/* The footer status's announcement channel (see the footer wrapper above):
          a stable polite region whose deferred text voices the Ready <-> Resolve
          status to assistive tech without fighting the heading focus on mount. */}
      <VisuallyHidden
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="generate-status-announcement"
      >
        {deferredFooterAnnouncement}
      </VisuallyHidden>
    </Stack>
  );
}
