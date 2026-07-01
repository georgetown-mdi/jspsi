import { useEffect, useMemo, useRef, useState } from "react";

import {
  Alert,
  Box,
  Button,
  Divider,
  Grid,
  Group,
  Paper,
  Select,
  Stack,
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

import { assessLinkageSatisfiability, inferMetadata } from "@psilink/core";

import {
  SEMANTIC_TYPE_LABELS,
  disclosedColumnNames,
  hasMultipleIdentifiers,
  normalizeForEditor,
  setColumnTypeForMatching,
} from "@psi/metadataEditing";

import {
  applyInputOverrides,
  applyStepOverrides,
  isStepValid,
} from "@psi/standardizationAuthoring";

import { defaultStandardizationForRows } from "@psi/advancedInvite";

import { isSilentEmpty } from "@psi/nonEmptyAggregate";

import { CleaningErrorBoundary } from "@components/CleaningErrorBoundary";
import { ExchangeSummary } from "@components/ExchangeSummary";
import { FieldCoverage } from "@components/FieldCoverage";
import { MetadataGrid } from "@components/MetadataGrid";
import { StandardizationCards } from "@components/StandardizationCards";
import { useDeferredAnnouncement } from "@components/useDeferredAnnouncement";
import { useNonEmptyRates } from "@components/useNonEmptyRates";

import type {
  CSVRow,
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
 *
 * Laid out as a two-column editor (the shared data-prep layout): a primary column
 * carrying the verdict, the disclosure/quick-fix block, the metadata grid, and the
 * shared {@link StandardizationCards}; a summary column carrying the read-once agreed
 * terms; and a sticky footer for the commit. The cleaning surface and its
 * `FieldCoverage`/preview are the same component the inviter uses.
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
   * read-only via {@link ExchangeSummary}. */
  linkageTerms: LinkageTerms;
  /** The columns the invitation declared the inviter will send (its
   * `disclosedPayloadColumns`), passed through to {@link ExchangeSummary} so the
   * "what you will receive" line matches the review screen. */
  disclosedPayloadColumns?: Array<string>;
  /** The acceptor's own CSV column names, from the parsed file. */
  columns: Array<string>;
  /** The parsed CSV rows, the sample source for the before->after preview. */
  rawRows: Array<CSVRow>;
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

  // A signature of each field's input binding -- the only input to the missing-field
  // invariant the cleaning boundary guards -- so a remap or reset auto-recovers it.
  const cleaningResetKey = useMemo(
    () => standardization.map((t) => `${t.output}=${t.input}`).join(","),
    [standardization],
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
  // The verdict's spoken form for the deferred announcer below. Deliberately worded
  // differently from the visible Alert titles -- a screen reader hears one concise
  // line rather than the alert prose, which also keeps the visible-title test
  // queries unambiguous. Always non-empty (one of the three verdict states always
  // holds), so the region is voiced on mount and on every transition.
  const verdictAnnouncement = blocked
    ? "No agreed linkage key can be satisfied by your columns yet."
    : partial
      ? `${satisfiable} of ${totalKeys} linkage keys can be satisfied by your columns.`
      : `All ${totalKeys} linkage keys can be satisfied by your columns.`;
  const deferredVerdictAnnouncement =
    useDeferredAnnouncement(verdictAnnouncement);
  // Keys whose columns are all present (so the column verdict passes them) yet whose
  // declared cleaning can never produce a value -- a self-defeating parse_date in
  // the partner's adopted terms. Value-independent, so it does not change as the
  // operator edits their columns/standardization (it reads the terms' element
  // transforms, which the acceptor does not edit here); a fixed advisory, not the
  // live verdict. A count, not the partner-controlled key names, matches this
  // panel's convention of never rendering partner field/key text.
  const deadKeyCount = verdict.deadKeys.length;
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

  // Remap: bind a missing field type to a chosen column by setting that column's
  // semantic type AND making it a match column (role: linkage). Forcing the match
  // role is the point of the quick-fix -- the column the operator picks is whatever
  // they have, and an unrecognized column infers to role: payload, so merely setting
  // the type would retype it yet leave it unusable for linkage (see
  // setColumnTypeForMatching). The derived standardization then regenerates the
  // recommended cleaning for the new binding, so a remap both makes the field
  // satisfiable and cleans it.
  const remap = (type: LinkageField["type"], columnName: string) => {
    setMetadata((prev) => setColumnTypeForMatching(prev, columnName, type));
    // Move focus to the verdict before the chosen Select unmounts (it does as
    // soon as the field is satisfied), so a keyboard/screen-reader user lands on
    // the result instead of being dropped to <body>. The verdict node is stable,
    // so focusing it here -- ahead of the re-render -- is safe.
    verdictRef.current?.focus();
  };

  const handleReset = () => {
    setMetadata(initialMetadata);
    setStepOverrides(new Map());
    setInputOverrides(new Map());
  };

  const launch = () => {
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

      <Grid gap="xl" align="flex-start">
        {/* Primary column: verdict, disclosure/quick-fix, columns, cleaning. */}
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Stack>
            {/* The verdict's VISIBLE alerts render immediately, so the colored
                verdict neither flashes nor shifts layout on mount. This wrapper is
                NOT a live region and each inner Alert is role="presentation"
                (Mantine's Alert defaults to assertive "alert"), so nothing here
                announces directly. The spoken verdict is voiced by the deferred
                polite region right after this div -- decoupled so a verdict already
                present on MOUNT (e.g. a file that lands blocked) is announced as an
                empty -> non-empty transition rather than skipped as
                present-on-mount content, while still queuing politely behind the
                heading focus. tabIndex=-1 keeps this the focus target after a
                remap. */}
            <div ref={verdictRef} tabIndex={-1} data-testid="verdict">
              {blocked ? (
                <Alert
                  role="presentation"
                  color="red"
                  icon={<IconAlertCircle aria-hidden />}
                  title="This file cannot match yet"
                >
                  None of the agreed linkage keys can be satisfied by your
                  columns, so no matches are possible. Set the columns below to
                  the missing field types, then this will clear.
                </Alert>
              ) : partial ? (
                <Alert
                  role="presentation"
                  color="yellow"
                  icon={<IconAlertTriangle aria-hidden />}
                  title={`${satisfiable} of ${totalKeys} keys can match`}
                >
                  Some linkage keys cannot be satisfied by your columns and will
                  be inactive for this exchange. The other keys will proceed
                  normally. You can map more columns below to enable additional
                  keys.
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
            {/* The verdict's announcement channel (see the wrapper above): a stable
                polite region whose deferred text reaches assistive tech without
                fighting the heading focus on mount. */}
            <VisuallyHidden
              role="status"
              aria-live="polite"
              aria-atomic="true"
              data-testid="verdict-announcement"
            >
              {deferredVerdictAnnouncement}
            </VisuallyHidden>

            {/* A dead key the column verdict cannot see: the columns are present
                (so the verdict above may read all-clear), but a cleaning rule in
                the partner's terms drops every record, so the key can never match.
                Surfaced as its own advisory -- the column verdict is about the
                file, this is about the agreed terms, and the remedy differs (the
                acceptor cannot fix it by remapping columns; the inviter must
                correct the rule). Static, not a live region: it reads the terms'
                element transforms, which this panel does not edit.

                role="note" (not Mantine's default role="alert") deliberately: the
                condition is fixed at mount and never changes as the operator edits,
                so an assertive on-mount announcement would be jarring for a standing
                advisory -- the same polite-over-assertive reasoning the verdict
                region applies. The title leads with the RULE ("drops every record"),
                not "can(not) match", so it does not read as a contradiction of the
                column verdict's "All N keys can match" heading directly above (that
                verdict is about columns; this is about a terms-level rule -- a
                separate axis, which the off-palette colour also signals). */}
            {deadKeyCount > 0 && (
              <Alert
                role="note"
                color="orange"
                icon={<IconAlertTriangle aria-hidden />}
                title={
                  deadKeyCount === 1
                    ? "A linkage key's rule drops every record"
                    : `${deadKeyCount} linkage keys have a rule that drops every record`
                }
              >
                {deadKeyCount === 1 ? "A key has" : "Some keys have"} a cleaning
                rule in the agreed terms that drops every record (for example a
                date format missing a component), so{" "}
                {deadKeyCount === 1 ? "it" : "they"} would contribute no matches
                no matter what your file contains. Your columns are not the
                problem -- ask your partner for a corrected invitation.
              </Alert>
            )}

            {/* Directly under the verdict, co-located with it because it is what the
                operator acts on next: while a field type is still missing, the
                quick-fix remap (nothing to send yet); once every type is mappable,
                the static "what you'll send" summary. */}
            {unsatisfiedTypes.length > 0 ? (
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
            ) : (
              // A STATIC summary derived synchronously from disclosedColumnNames --
              // NOT a live region; the MetadataGrid's own announcer covers disclosure
              // changes for assistive tech (a second region would double-announce).
              <Paper withBorder p="md">
                <Text size="sm" fw={600} mb={4}>
                  What you will send to your partner
                </Text>
                {disclosed.length === 0 ? (
                  <Text size="xs" c="dimmed">
                    No columns. Only the linkage result (which of your rows
                    matched) is produced.
                  </Text>
                ) : (
                  <Text size="xs">
                    For each matched row: {disclosed.join(", ")}.
                  </Text>
                )}
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
                    Each field is cleaned by an ordered list of steps before
                    matching. Edit the steps and watch the before-and-after on a
                    sample of your rows. Cleaning runs on your device and
                    changes only your own match rate; it is never sent to your
                    partner.
                  </Text>
                  {/* Raw-pattern (regex) steps are available without a gate. This
                      non-blocking note states the consequence; each regex step
                      carries an "advanced" badge and the preview shows its effect. */}
                  <Text size="xs" c="dimmed" mt={4}>
                    Some steps use raw patterns (marked &ldquo;advanced&rdquo;).
                    They change which of your rows match -- check the preview.
                    Patterns over 1000 characters are rejected.
                  </Text>
                </div>
                <CleaningErrorBoundary
                  onReset={handleReset}
                  resetKey={cleaningResetKey}
                >
                  <StandardizationCards
                    standardization={standardization}
                    declaredFields={linkageTerms.linkageFields}
                    metadata={metadata}
                    rawRows={rawRows}
                    onStepsChange={setFieldSteps}
                    onInputColumnChange={setInputColumn}
                    renderCoverage={(output) => (
                      <FieldCoverage
                        rate={nonEmptyRates?.get(output)}
                        pending={ratesPending}
                      />
                    )}
                    isFieldSilentEmpty={(output) => {
                      const rate = nonEmptyRates?.get(output);
                      return rate !== undefined && isSilentEmpty(rate);
                    }}
                    onMissingField="throw"
                  />
                </CleaningErrorBoundary>
                {/* One polite, atomic live region announces a silent-empty collapse
                    for the whole editor (debounced via the recompute), so a
                    screen-reader user hears the alarm without each card firing its
                    own region. The visible per-card alarms are role="presentation". */}
                <VisuallyHidden
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {coverageAnnouncement}
                </VisuallyHidden>
              </Stack>
            )}

            {!standardizationValid && (
              <Text size="xs" c="red" role="alert">
                Finish or fix the highlighted cleaning steps before continuing.
              </Text>
            )}
          </Stack>
        </Grid.Col>

        {/* Summary column: the read-once agreed terms, in the shared ExchangeSummary
            panel used on every screen. Not sticky -- reference material the operator
            reads once, and terms-only is too short to justify pinning. Two columns
            still shorten the primary scroll (terms beside, not atop). The summary
            also surfaces this party's own outbound disclosure (sendColumns) as chips,
            the standing last-look that replaces the removed confirm modal. */}
        <Grid.Col span={{ base: 12, md: 5 }}>
          <ExchangeSummary
            linkageTerms={linkageTerms}
            disclosedPayloadColumns={disclosedPayloadColumns}
            perspective="accepted"
            headingOrder={3}
            sendColumns={disclosed}
          />
        </Grid.Col>
      </Grid>

      {/* Sticky footer for the commit, mirroring the inviter's. Bottom padding on
          the page keeps it from occluding the last card. There is no confirm modal:
          consent is already given on the review screen, and the live "Columns you
          will send" chips in the summary column are the standing last-look. */}
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
        <Group justify="flex-end">
          <Button variant="default" onClick={handleReset}>
            Reset to recommended
          </Button>
          <Button
            onClick={launch}
            disabled={blocked || multipleIdentifiers || !standardizationValid}
          >
            Start exchange
          </Button>
        </Group>
      </Box>
    </Stack>
  );
}
