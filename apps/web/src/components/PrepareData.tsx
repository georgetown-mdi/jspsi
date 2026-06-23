import { useEffect, useMemo, useRef, useState } from "react";

import {
  Alert,
  Button,
  Divider,
  Grid,
  Group,
  List,
  Modal,
  Paper,
  Select,
  Stack,
  Switch,
  Text,
  Title,
  VisuallyHidden,
} from "@mantine/core";
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconArrowLeft,
  IconCircleCheck,
} from "@tabler/icons-react";
import { useDisclosure } from "@mantine/hooks";

import { assessLinkageSatisfiability, inferMetadata } from "@psilink/core";

import {
  SEMANTIC_TYPE_LABELS,
  disclosedColumnNames,
  hasMultipleIdentifiers,
  normalizeForEditor,
  setColumnType,
} from "@psi/metadataEditing";

import {
  applyInputOverrides,
  applyStepOverrides,
  isStepValid,
} from "@psi/standardizationAuthoring";

import { defaultStandardizationForRows } from "@psi/advancedInvite";

import { isSilentEmpty } from "@psi/nonEmptyAggregate";

import { FieldCoverage } from "@components/FieldCoverage";
import { InvitationTerms } from "@components/InvitationTerms";
import { MetadataGrid } from "@components/MetadataGrid";
import { StandardizationPreview } from "@components/StandardizationPreview";
import { StandardizationStepEditor } from "@components/StandardizationStepEditor";
import { useNonEmptyRates } from "@components/useNonEmptyRates";

import type {
  LinkageField,
  LinkageTerms,
  Metadata,
  StandardizationStep,
} from "@psilink/core";

import type { AcceptorDataEdits } from "@psi/acceptInvitation";
import type { AlertContent } from "@components/FileAcquire";
import type { FieldStepOverride } from "@psi/standardizationAuthoring";

/**
 * The acceptor "Prepare your data" editor: the surface that turns the old
 * dead-end pre-flight ("this file cannot be linked") into an entry point. It seeds
 * the operator's per-party metadata from {@link inferMetadata} (normalized so the
 * collapsed disclosure control is faithful -- see {@link normalizeForEditor}),
 * shows a live linkage-satisfiability verdict over the EDITED metadata and
 * standardization, and lets the operator remap columns until the file complies.
 *
 * The verdict and the run consume the SAME `{ metadata, standardization }`: the
 * standardization is derived from the current metadata via
 * {@link defaultStandardizationForRows} (so the recommended per-type cleaning is
 * always applied to the current column bindings, with the date-of-birth input
 * format inferred from the operator's own rows), and that exact pair is handed to
 * {@link onLaunch}. So the gate the operator sees and the exchange that runs
 * cannot disagree.
 *
 * Metadata/standardization are LOCAL and per-party: they are never embedded in the
 * token or cross-checked, so editing them changes only this party's match rate and
 * disclosure, never the agreement the consent screen already accepted. The
 * `satisfiableKeyCount === 0` hard block remains -- "Continue" is disabled so a
 * silent-empty exchange is never run -- but the operator fixes the file in place
 * rather than being bounced back to the picker.
 */
export function PrepareData({
  linkageTerms,
  disclosedPayloadColumns,
  columns,
  rawRows,
  onLaunch,
  onBack,
}: {
  /** The adopted (agreed) linkage terms the operator is matching against, shown
   * read-only via {@link InvitationTerms}. */
  linkageTerms: LinkageTerms;
  /** The columns the invitation declared the inviter will send (its
   * `disclosedPayloadColumns`), passed through to {@link InvitationTerms} so the
   * "what you will receive" line matches the review screen. */
  disclosedPayloadColumns?: Array<string>;
  /** The acceptor's own CSV column names, from the parsed file. */
  columns: Array<string>;
  /** The parsed CSV rows, the sample source for the before->after preview. */
  rawRows: Array<Record<string, string>>;
  /** Commit the prepared data and move to the exchange: the edited metadata and
   * standardization, plus an optional partial-coverage advisory to surface through
   * the run. */
  onLaunch: (edits: AcceptorDataEdits, warning?: AlertContent) => void;
  /** Return to the review screen to pick a different file. Consent is preserved
   * (it lives on the container), and this editor unmounts on the way back, so
   * re-acquiring a different file remounts it and reseeds the metadata. */
  onBack: () => void;
}) {
  // Focus the heading on mount so a keyboard/screen-reader user who pressed
  // "Accept and continue" lands on this editor rather than the unmounted button.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  // The verdict is one stable live region (see below); it is also the focus
  // target after a quick-fix remap, whose Select unmounts the moment its field
  // becomes satisfiable -- focus lands on the verdict (the result) rather than
  // falling to <body>.
  const verdictRef = useRef<HTMLDivElement>(null);
  // Seeded once from the file's columns; the operator owns the state from here (no
  // silent re-inference), and Reset returns to exactly this.
  const initialMetadata = useMemo(
    () => normalizeForEditor(inferMetadata(columns)),
    [columns],
  );
  const [metadata, setMetadata] = useState<Metadata>(initialMetadata);

  // The operator's per-field step edits, keyed by linkage-field name (the
  // transformation `output`) and paired with the input column they were authored
  // against. Held as an override LAYER over the derived default rather than as the
  // whole standardization, so the binding (input column, which fields exist) is
  // always re-derived from the current metadata and the verdict stays honest. An
  // empty map means no edits, so the effective standardization equals the derived
  // default -- the acceptor's prior behavior, byte for byte.
  const [stepOverrides, setStepOverrides] = useState<
    Map<string, FieldStepOverride>
  >(new Map());

  // The operator's per-field input-column choices, keyed by field name -- like the
  // step edits, an override LAYER over the derived binding (empty means every field
  // takes its default type-fallback column). This is what lets two fields of one
  // semantic type bind to DISTINCT columns: the default binds every same-typed field
  // to the FIRST column of the type, so an explicit per-field input is the only way
  // to give the second its own column.
  const [inputOverrides, setInputOverrides] = useState<Map<string, string>>(
    new Map(),
  );

  // The recommended per-type cleaning for the default type-fallback binding,
  // re-derived from the current metadata so it tracks a remap. The date-of-birth
  // input format is inferred from the operator's own rows rather than assumed
  // MM/DD/YYYY: this editor always supplies an explicit standardization to the
  // exchange, which then skips its own inference, so an ISO-dated file would
  // otherwise be parsed as US-format and under-match every dob key. Mirrors the
  // inviter advanced path (see defaultStandardizationForRows).
  const baseStandardization = useMemo(
    () => defaultStandardizationForRows(metadata, linkageTerms, rawRows),
    [metadata, linkageTerms, rawRows],
  );

  // Field name -> its declared linkage field, for the per-field card label, the
  // value-level constraint check the preview runs, and the input-column choices
  // below. The field `name` is the transformation `output`.
  const fieldByName = useMemo(
    () =>
      new Map(linkageTerms.linkageFields.map((field) => [field.name, field])),
    [linkageTerms],
  );

  // The operator's `role: linkage` columns of a semantic type, in metadata order
  // -- the columns a field of that type MAY bind to. Only a linkage column
  // participates in matching (core's resolveFieldColumns binds only `role:
  // linkage`), so a column roled identifier/payload/ignored is never offered as a
  // match input the core would refuse. More than one makes the input column a real
  // choice (and lets two same-typed fields each take their own).
  const columnsForType = (type: LinkageField["type"]): Array<string> =>
    metadata
      .filter((column) => column.role === "linkage" && column.type === type)
      .map((column) => column.name);

  // The input-column overrides that still apply: an override is dropped when its
  // chosen column is no longer a `role: linkage` column of the field's type (a
  // metadata remap or re-role can invalidate one), so a stale binding never drives
  // a column the core would refuse -- the field falls back to the default
  // type-fallback binding instead.
  const effectiveInputOverrides = useMemo(() => {
    const valid = new Map<string, string>();
    for (const [output, column] of inputOverrides) {
      const field = fieldByName.get(output);
      if (
        field !== undefined &&
        metadata.some(
          (c) =>
            c.name === column && c.role === "linkage" && c.type === field.type,
        )
      )
        valid.set(output, column);
    }
    return valid;
  }, [inputOverrides, metadata, fieldByName]);

  // The effective standardization the verdict and onLaunch consume: the derived
  // bindings rebound to the operator's chosen input columns, with each field's
  // authored steps layered on where it edited them. The input rebind runs FIRST so a
  // step override authored against the old column is then seen as stale and dropped
  // (applyStepOverrides gates on the current input), never silently cleaning a
  // different column. With no overrides this equals the derived default byte for
  // byte -- the acceptor's prior behavior.
  const standardization = useMemo(
    () =>
      applyStepOverrides(
        applyInputOverrides(baseStandardization, effectiveInputOverrides),
        stepOverrides,
      ),
    [baseStandardization, effectiveInputOverrides, stepOverrides],
  );

  const setFieldSteps = (
    output: string,
    input: string,
    steps: Array<StandardizationStep>,
  ) => setStepOverrides((prev) => new Map(prev).set(output, { input, steps }));

  const setInputColumn = (output: string, column: string) =>
    setInputOverrides((prev) => new Map(prev).set(output, column));

  const verdict = useMemo(
    () =>
      assessLinkageSatisfiability(
        columns,
        linkageTerms,
        standardization,
        metadata,
      ),
    [columns, linkageTerms, standardization, metadata],
  );

  const totalKeys = linkageTerms.linkageKeys.length;
  const satisfiable = verdict.satisfiableKeyCount;
  const blocked = satisfiable === 0;
  const partial = satisfiable > 0 && satisfiable < totalKeys;
  const disclosed = disclosedColumnNames(metadata);
  // Every authored step must be well-formed before launch: a step the operator
  // left mid-edit (e.g. a cleared `substring.start`) carries a param the inline
  // input already flags, but launch is gated on it too so a malformed pipeline --
  // which core would run as a silent full-field exclusion, or throw on at compile
  // -- can never reach the exchange.
  const standardizationValid = useMemo(
    () =>
      standardization.every((transformation) =>
        (transformation.steps ?? []).every(isStepValid),
      ),
    [standardization],
  );
  // A seed can carry more than one identifier (an `id` and an `identifier`
  // column both infer to `role: identifier`); the grid surfaces this as a visible
  // error, and launch is gated on it too so the file cannot run with an ambiguous
  // identifier even when every linkage key is otherwise satisfiable.
  const multipleIdentifiers = hasMultipleIdentifiers(metadata);

  // The silent-empty defense: per-field coverage over the FULL CSV, computed off the
  // main thread above the row threshold (see useNonEmptyRates). The verdict above
  // guards SHAPE; this is the only VALUE-level check that a field's transform has not
  // collapsed every row to null -- a byte-indistinguishable empty intersection. It is
  // surfaced, not gated: the operator sees the collapse before launch and fixes the
  // steps, the same way the partial-coverage advisory informs rather than blocks.
  const { rates: nonEmptyRates, pending: ratesPending } = useNonEmptyRates(
    rawRows,
    standardization,
  );

  // The safe labels of the fields whose transform drops every row, for the single
  // editor-wide coverage announcement below. Built from the field's semantic-type
  // label (the partner-controlled `output` is never announced raw) in standardization
  // order so the read is stable.
  const silentEmptyLabels = useMemo(() => {
    if (nonEmptyRates === null) return [];
    // De-duplicated by label (a Set preserves standardization order): two fields of
    // the same semantic type that both collapse announce the label once, matching
    // how the visible unsatisfied-types fix UI de-dupes by type.
    const labels = new Set<string>();
    for (const transformation of standardization) {
      const rate = nonEmptyRates.get(transformation.output);
      const field = fieldByName.get(transformation.output);
      if (rate !== undefined && field !== undefined && isSilentEmpty(rate))
        labels.add(SEMANTIC_TYPE_LABELS[field.type]);
    }
    return [...labels];
  }, [nonEmptyRates, standardization, fieldByName]);

  // One polite live region for the whole editor announces a collapse (debounced,
  // because `nonEmptyRates` only updates once per recompute, not per keystroke).
  // Empty when nothing collapses -- clearing it is silent, the standard pattern for an
  // error region; the recovery is conveyed by the per-field readout and the
  // satisfiability verdict.
  const coverageAnnouncement =
    silentEmptyLabels.length === 0
      ? ""
      : `Coverage warning: ${silentEmptyLabels.join(", ")} ${
          silentEmptyLabels.length === 1 ? "produces" : "produce"
        } no value for any row and cannot match. Check the cleaning steps.`;

  // The field types the file cannot currently produce, de-duplicated by type for
  // the fix UI (several fields can share a type). `LinkageField["type"]` is a
  // closed semantic-type enum, so its label is safe; the partner-controlled field
  // NAME is never shown here.
  const unsatisfiedTypes = useMemo(() => {
    const seen = new Map<LinkageField["type"], string>();
    for (const field of verdict.unsatisfied)
      seen.set(field.type, SEMANTIC_TYPE_LABELS[field.type]);
    return [...seen.entries()].map(([type, label]) => ({ type, label }));
  }, [verdict.unsatisfied]);

  const [confirmOpen, { open: openConfirm, close: closeConfirm }] =
    useDisclosure(false);

  // The gated expert tier (board item 202533670): off by default, so the standard
  // guided authoring is unchanged unless the operator opts in. When on, the
  // per-field step editors let an operator author and edit raw-pattern (regex)
  // cleaning steps. Editor-wide rather than per-card so the affordance is a single,
  // discoverable switch, not one buried in each field.
  const [expert, setExpert] = useState(false);

  // Remap: bind a field type to a chosen column by setting that column's semantic
  // type. The derived standardization regenerates the recommended cleaning for the
  // new binding, so a remap both makes the field satisfiable and cleans it.
  const remap = (type: LinkageField["type"], columnName: string) => {
    setMetadata((prev) => setColumnType(prev, columnName, type).metadata);
    // Move focus to the verdict before the chosen Select unmounts (it does as
    // soon as the field is satisfied), so a keyboard/screen-reader user lands on
    // the result instead of being dropped to <body>. The verdict node is stable,
    // so focusing it here -- ahead of the re-render -- is safe.
    verdictRef.current?.focus();
  };

  const launch = () => {
    closeConfirm();
    const warning: AlertContent | undefined = partial
      ? {
          title: "Partial coverage",
          message:
            `Only ${satisfiable} of ${totalKeys} linkage keys can match with ` +
            "this file. Keys that need the missing fields will be inactive; the " +
            "others will proceed normally.",
        }
      : undefined;
    onLaunch({ metadata, standardization }, warning);
  };

  return (
    <Stack>
      <Group>
        <Button
          variant="subtle"
          onClick={onBack}
          leftSection={<IconArrowLeft size={16} aria-hidden />}
        >
          Choose a different file
        </Button>
      </Group>
      <Title order={2} ref={headingRef} tabIndex={-1}>
        Prepare your data
      </Title>
      <Text size="sm" c="dimmed">
        Tell us what each column in your file is and what should be done with
        it, then check that your data can match the agreed terms. Nothing here
        is sent to your partner except the columns you mark as shared; these
        settings stay on your device.
      </Text>

      <Paper withBorder p="md">
        <Text size="sm" fw={600} mb="xs">
          The terms you are matching against
        </Text>
        <InvitationTerms
          linkageTerms={linkageTerms}
          disclosedPayloadColumns={disclosedPayloadColumns}
          perspective="accepted"
          headingOrder={3}
        />
      </Paper>

      {/* The verdict lives in ONE stable, polite, atomic live region whose inner
          Alert swaps as the verdict changes. Because the wrapper node persists
          across the swap, a remap that flips blocked->all-clear is announced
          (three separately-mounted Alerts would not reliably announce a
          transition). Kept polite, not assertive: the verdict is a standing
          condition the operator is here to resolve, and an assertive node would
          fire on mount and fight the heading focus. The wrapper owns the
          live-region semantics, so each inner Alert is role="presentation" --
          Mantine's Alert defaults role to "alert" (assertive) when none is set,
          which would otherwise nest an assertive region inside this polite one.
          tabIndex=-1 makes it the programmatic focus target after a remap without
          adding a tab stop; landing focus here re-reads the verdict, a benign
          reinforcement of the polite announcement rather than a separate one. */}
      <div
        ref={verdictRef}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="verdict"
      >
        {blocked ? (
          <Alert
            role="presentation"
            color="red"
            icon={<IconAlertCircle aria-hidden />}
            title="This file cannot match yet"
          >
            None of the agreed linkage keys can be satisfied by your columns, so
            no matches are possible. Set the columns below to the missing field
            types, then this will clear.
          </Alert>
        ) : partial ? (
          <Alert
            role="presentation"
            color="yellow"
            icon={<IconAlertTriangle aria-hidden />}
            title={`${satisfiable} of ${totalKeys} keys can match`}
          >
            Some linkage keys cannot be satisfied by your columns and will be
            inactive for this exchange. The other keys will proceed normally.
            You can map more columns below to enable additional keys.
          </Alert>
        ) : (
          <Alert
            role="presentation"
            color="green"
            icon={<IconCircleCheck aria-hidden />}
            title={`All ${totalKeys} keys can match`}
          >
            Your columns can satisfy every agreed linkage key.
          </Alert>
        )}
      </div>

      {unsatisfiedTypes.length > 0 && (
        <Paper withBorder p="md">
          <Text size="sm" fw={600} mb="xs">
            Map a column to each missing field
          </Text>
          <Stack gap="sm">
            {unsatisfiedTypes.map(({ type, label }) => (
              <Select
                key={type}
                label={label}
                description={`No column is set to ${label.toLowerCase()} yet`}
                placeholder="Choose a column"
                data={columns}
                value={null}
                allowDeselect={false}
                onChange={(columnName) =>
                  columnName !== null && remap(type, columnName)
                }
              />
            ))}
          </Stack>
        </Paper>
      )}

      <MetadataGrid
        metadata={metadata}
        onChange={setMetadata}
        caption="Your columns, their types, and how each is used"
      />

      {standardization.length > 0 && (
        <Stack
          gap="sm"
          component="section"
          aria-label="Clean your data to match"
        >
          <Divider />
          <div>
            <Text size="sm" fw={600}>
              Clean your data to match
            </Text>
            <Text size="xs" c="dimmed">
              Each field is cleaned by an ordered list of steps before matching.
              Edit the steps and watch the before-and-after on a sample of your
              rows. Cleaning runs on your device and changes only your own match
              rate; it is never sent to your partner.
            </Text>
          </div>
          {/* The gated expert affordance. Raw patterns run under a linear-time
              engine (they cannot freeze the tab), but a wrong pattern silently
              changes which of your rows match, so the capability is opt-in and
              never offered as a recommended fix. */}
          <Switch
            checked={expert}
            onChange={(event) => setExpert(event.currentTarget.checked)}
            label="Advanced: author raw patterns"
            description="Add or edit regular-expression cleaning steps. A wrong pattern changes which of your rows match."
            size="sm"
            style={{ alignSelf: "flex-start" }}
          />
          {standardization.map((transformation) => {
            const field = fieldByName.get(transformation.output);
            // Every standardization output is a declared linkage field (both
            // `standardization` and `fieldByName` derive from the same
            // `linkageTerms.linkageFields`), so this never resolves to undefined;
            // assert it as a check rather than silently dropping a field's card if
            // that ever stops holding. The message names no partner-controlled
            // value (the output is a partner-supplied field name).
            if (field === undefined)
              throw new Error(
                "standardization output does not resolve to a declared linkage field",
              );
            const steps = transformation.steps ?? [];
            return (
              <Paper withBorder p="md" key={transformation.output}>
                <Stack gap="sm">
                  <Grid gap="lg" align="flex-start">
                    <Grid.Col span={{ base: 12, md: 7 }}>
                      <StandardizationStepEditor
                        fieldLabel={SEMANTIC_TYPE_LABELS[field.type]}
                        inputColumn={transformation.input}
                        steps={steps}
                        expert={expert}
                        inputColumnOptions={columnsForType(field.type)}
                        onInputColumnChange={(column) =>
                          setInputColumn(transformation.output, column)
                        }
                        onStepsChange={(next) =>
                          setFieldSteps(
                            transformation.output,
                            transformation.input,
                            next,
                          )
                        }
                      />
                    </Grid.Col>
                    <Grid.Col span={{ base: 12, md: 5 }}>
                      <Text size="xs" fw={600} mb="xs">
                        Preview
                      </Text>
                      <StandardizationPreview
                        field={field}
                        inputColumn={transformation.input}
                        steps={steps}
                        rawRows={rawRows}
                      />
                    </Grid.Col>
                  </Grid>
                  {/* Full-CSV coverage for this field: the visible silent-empty
                      defense, distinct from the sample preview above. */}
                  <FieldCoverage
                    rate={nonEmptyRates?.get(transformation.output)}
                    pending={ratesPending}
                  />
                </Stack>
              </Paper>
            );
          })}
          {/* One polite, atomic live region announces a silent-empty collapse for
              the whole editor (debounced via the recompute), so a screen-reader user
              hears the alarm without each card firing its own region. The visible
              per-card alarms are role="presentation". */}
          <VisuallyHidden role="status" aria-live="polite" aria-atomic="true">
            {coverageAnnouncement}
          </VisuallyHidden>
        </Stack>
      )}

      {!standardizationValid && (
        <Text size="sm" c="red" role="alert">
          Finish or fix the highlighted cleaning steps before continuing.
        </Text>
      )}

      <Group justify="space-between">
        <Button
          variant="default"
          onClick={() => {
            setMetadata(initialMetadata);
            setStepOverrides(new Map());
            setInputOverrides(new Map());
            // Reset returns the editor to its seeded state (see initialMetadata),
            // which has the expert tier off, so close the raw-pattern affordance
            // too rather than leaving it on over reset-to-default state.
            setExpert(false);
          }}
        >
          Reset to recommended
        </Button>
        <Button
          onClick={openConfirm}
          disabled={blocked || multipleIdentifiers || !standardizationValid}
        >
          Continue to exchange
        </Button>
      </Group>

      <Modal
        opened={confirmOpen}
        onClose={closeConfirm}
        title="Confirm what you will send"
        centered
      >
        <Stack>
          {disclosed.length === 0 ? (
            <Text size="sm">
              You will <strong>not</strong> send any columns to your partner.
              Only the linkage result (which of your rows matched) is produced.
            </Text>
          ) : (
            <>
              <Text size="sm">
                For each matched row, you will send these columns to your
                partner:
              </Text>
              <List size="sm">
                {disclosed.map((name) => (
                  <List.Item key={name}>{name}</List.Item>
                ))}
              </List>
            </>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={closeConfirm}>
              Go back
            </Button>
            <Button onClick={launch}>Confirm and continue</Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
