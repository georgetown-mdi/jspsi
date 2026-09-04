import { useState } from "react";

import {
  Alert,
  Button,
  Checkbox,
  Loader,
  Modal,
  NumberInput,
  TextInput,
} from "@mantine/core";
import { Link } from "@tanstack/react-router";

import { DisclosureSection } from "@components/DisclosureSection";
import { isInstalledRuntime } from "@utils/installedRuntime";
import { storedInputHandleUsable } from "@psi/managedInputHandle";
import { triggerBlobDownload } from "@components/blobDownload";

import {
  DISCLOSURE_EXPORT_MIME,
  DISCLOSURE_STORED_EXPORT_MIME,
  disclosureAccountingCsv,
  disclosureAccountingFileName,
  disclosureEntries,
  storedDisclosureAccountingDocument,
  storedDisclosureAccountingFileName,
} from "./disclosureAccountingModel";
import {
  LABEL_GUIDANCE,
  MAX_LABEL_LENGTH,
  MAX_TOKEN_MAX_AGE_DAYS,
  labelWithinCap,
  maxAgeCadenceNote,
  maxAgeDaysError,
} from "./manageOfferModel";
import {
  MAX_SCHEDULE_INTERVAL_DAYS,
  MAX_SCHEDULE_WINDOW_HOURS,
  MIN_SCHEDULE_WINDOW_HOURS,
  buildScheduleFromEntry,
  cadenceAgainstTokenBound,
  defaultScheduleEntryFields,
  resolvedFirstWindowLabel,
  scheduleEntryErrors,
  scheduleEntryFieldsFrom,
  scheduleEntryUnchanged,
  scheduleEntryUsable,
} from "./scheduleEntryModel";
import {
  SIDE_LABELS,
  completedRunRecorded,
  connectionRows,
  linkageTermsRows,
  runHistoryEntries,
  scheduleView,
} from "./managedDetailModel";
import { REPEATED_MISS_TITLE } from "./scheduleSurfacingModel";
import { dateLabel } from "./inviterModel";
import styles from "./bench.module.css";

import type {
  ManagedExchangeLocalEdits,
  ManagedExchangeRecord,
  ManagedExchangeSchedule,
} from "@psi/managedExchangeRecord";
import type { ConfigRow } from "./managedDetailModel";
import type { DisclosureAccountingRead } from "@psi/disclosureAccountingStore";
import type { DisclosureFact } from "./disclosureAccountingModel";
import type { ScheduleEntryFields } from "./scheduleEntryModel";
import type { StoredDisclosureAccounting } from "@psi/disclosureAccounting";

/**
 * The managed exchange detail sections composed onto the per-partnership home at
 * `/saved/$id` (below the run affordance in {@link ./ManagedRunSurface.tsx}): the
 * read-only configuration, the local-fields editor, the agreed run schedule
 * where one exists, the run history, and the accounting of disclosures.
 * Derivations and copy come from {@link ./managedDetailModel.ts} and
 * {@link ./disclosureAccountingModel.ts}.
 *
 * The agreed terms are read-only here and fixed for this partnership; changing
 * them means a new exchange, not an in-place edit ({@link ConfigurationView}
 * offers a re-invite on the same terms instead). The local fields edit in place
 * without touching the partnership ({@link LocalFieldsEditor}). The accounting
 * is self-attested and links to the verify page; it is never a signed receipt.
 */
export function ManagedExchangeDetail({
  record,
  accountingRead,
  onResetAccounting,
  onRetryAccountingRead,
  onSaveLocalFields,
  onReinviteToChangeTerms,
  canReinvite,
  reinviting,
  reinviteFailed,
}: {
  record: ManagedExchangeRecord;
  /** How reading this exchange's accounting of disclosures turned out;
   * `undefined` while the read is in flight. One classified outcome rather than an
   * accounting beside flags, so a failed read can never render as "nothing was
   * disclosed" and a store that did not answer can never render as a value this
   * build refused. */
  accountingRead: DisclosureAccountingRead | undefined;
  /** Destroy the stored accounting so the exchange can file disclosures again,
   * leaving the exchange itself untouched. Offered only from the unreadable state,
   * behind an explicit confirm, and after the export. Rejects on a store failure;
   * the confirm shows the failure and stays open. */
  onResetAccounting: () => Promise<void>;
  /** Read the accounting again, for a read that never reached the store. */
  onRetryAccountingRead: () => void;
  /** Persist an in-place edit to the local fields (label, max-token-age policy).
   * Rejects on a store failure; the editor shows the failure and keeps the
   * form. */
  onSaveLocalFields: (edits: ManagedExchangeLocalEdits) => Promise<void>;
  /** Enter the fast re-invite flow -- refresh the partnership with a new secret on
   * the SAME terms (it does not change them; a terms change is a new exchange). The
   * inviter mints a fresh invitation; the acceptor's affordance names asking the
   * partner instead (the caller routes by {@link canReinvite}). */
  onReinviteToChangeTerms: () => void;
  /** Whether this party can mint a re-invite (inviter-only); drives the terms
   * re-invite affordance's copy. */
  canReinvite: boolean;
  /** Whether a re-invite is in flight, so the terms button shows loading. Shared
   * with the run surface's own re-invite state (see {@link ./ManagedRunSurface.tsx}),
   * so an in-flight re-invite displays the same on a healthy exchange as on a failed one. */
  reinviting: boolean;
  /** Whether the last re-invite attempt failed, so the terms button shows the
   * failure beside it. Shared with the run surface's re-invite state. */
  reinviteFailed: boolean;
}) {
  return (
    <>
      <ConfigurationView
        record={record}
        onReinviteToChangeTerms={onReinviteToChangeTerms}
        canReinvite={canReinvite}
        reinviting={reinviting}
        reinviteFailed={reinviteFailed}
      />
      <LocalFieldsEditor record={record} onSave={onSaveLocalFields} />
      <RunSchedule record={record} />
      <RunHistory record={record} />
      <DisclosureAccountingView
        read={accountingRead}
        completedRunOnRecord={completedRunRecorded(record)}
        onReset={onResetAccounting}
        onRetryRead={onRetryAccountingRead}
      />
    </>
  );
}

/**
 * Renders one read-only configuration row: a term and its value, its value
 * list, or its muted empty state.
 *
 * A value list renders one entry per item, never joined, since a partner- or
 * operator-authored name could contain the separator. Keyed by index because a
 * name is not unique across entries.
 *
 * A caveat (`row.note`) renders below the value, on its own line: it is this
 * app's own fixed copy, not a value the partner or operator chose (those reach
 * the row through `row.value` / `row.values` / `row.muted` instead).
 */
function ConfigRowItem({ row }: { row: ConfigRow }) {
  return (
    <div className={styles.dlRow}>
      <span className={styles.dlLabel}>{row.label}</span>
      {row.values !== undefined ? (
        <ul className={styles.dlValueList}>
          {row.values.map((entry, index) => (
            <li key={index}>{entry}</li>
          ))}
        </ul>
      ) : row.muted !== undefined ? (
        <span className={styles.sub}>{row.muted}</span>
      ) : (
        <span>{row.value}</span>
      )}
      {row.note !== undefined && (
        <span className={`${styles.dlNote} ${styles.small} ${styles.sub}`}>
          {row.note}
        </span>
      )}
    </div>
  );
}

/**
 * The read-only configuration view: this party's side, the channel and partner
 * endpoint, and the agreed linkage terms. The agreed terms are the persisted
 * exchange-file document, fixed for this partnership -- a change to them is a
 * new exchange, not an in-place edit (see docs/spec/MANAGED_EXCHANGE_RECORD.md,
 * the `exchangeFile` row). The re-invite affordance refreshes the partnership
 * with a new secret on the SAME terms: the inviter mints a fresh invitation; the
 * acceptor is told the terms cannot change by re-invite, and that different
 * terms mean a new exchange from the partner.
 */
function ConfigurationView({
  record,
  onReinviteToChangeTerms,
  canReinvite,
  reinviting,
  reinviteFailed,
}: {
  record: ManagedExchangeRecord;
  onReinviteToChangeTerms: () => void;
  canReinvite: boolean;
  reinviting: boolean;
  reinviteFailed: boolean;
}) {
  return (
    <div className={styles.callout}>
      <h2 className={styles.eyebrow}>Configuration</h2>
      <div className={styles.dlRow}>
        <span className={styles.dlLabel}>Your side</span>
        <span>{SIDE_LABELS[record.side]}</span>
      </div>
      {connectionRows(record.exchangeFile).map((row) => (
        <ConfigRowItem key={row.label} row={row} />
      ))}
      {linkageTermsRows(record.exchangeFile).map((row) => (
        <ConfigRowItem key={row.label} row={row} />
      ))}
      <p className={`${styles.small} ${styles.sub}`}>
        These agreed terms are fixed for this partnership. Re-inviting refreshes
        the partnership with a new secret on these same terms; it does not
        change them. To exchange on different terms, set up a{" "}
        <Link to="/exchange">new exchange</Link> and delete this one if you no
        longer want it.
      </p>
      {canReinvite ? (
        <>
          {reinviteFailed && (
            <Alert
              color="red"
              title="Could not create a fresh invitation"
              mb="sm"
            >
              Nothing changed here; try again.
            </Alert>
          )}
          <Button
            variant="default"
            onClick={onReinviteToChangeTerms}
            loading={reinviting}
          >
            Re-invite with the same terms
          </Button>
        </>
      ) : (
        <p className={styles.small}>
          These agreed terms are fixed for this partnership; your partner cannot
          re-invite you onto different ones. To exchange on different terms,
          your partner sets up a new exchange with those terms and sends you its
          invitation -- accept it and you can save it as a new recurring
          exchange, then delete this one if you no longer want it.
        </p>
      )}
    </div>
  );
}

/**
 * The local-fields editor: the label, the agreed run schedule, and the
 * max-token-age policy edit in place, without touching the partnership (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md -- a reschedule or a label change is
 * neither a terms change nor a credential). Editing the max-age policy
 * re-derives `expires` conservatively at the store boundary (an edit never
 * extends the stored credential's life without a rotation); this form only
 * collects the policy, not the derivation.
 *
 * The schedule and the max-age policy share one form because they constrain
 * each other: a cadence that opens its next window past the bound lapses the
 * stored secret between runs, and the operator needs both values in front of
 * them to weigh that (see {@link cadenceAgainstTokenBound}). One Save writes
 * both through the store's single local-fields edit.
 */
function LocalFieldsEditor({
  record,
  onSave,
}: {
  record: ManagedExchangeRecord;
  onSave: (edits: ManagedExchangeLocalEdits) => Promise<void>;
}) {
  const [label, setLabel] = useState(record.label);
  const [maxAgeEnabled, setMaxAgeEnabled] = useState(
    record.tokenMaxAgeDays !== undefined,
  );
  // Held as the NumberInput reports it (a string when cleared or mid-edit), so an
  // invalid state is representable and blocks the save rather than being coerced to
  // a sentinel that silently drops the opted-in bound.
  const [maxAgeDays, setMaxAgeDays] = useState<number | string>(
    record.tokenMaxAgeDays ?? 90,
  );
  const [scheduleEnabled, setScheduleEnabled] = useState(
    record.schedule !== undefined,
  );
  // Seeded from the stored schedule where there is one, so re-opening the form
  // shows the cadence the operator agreed on their own clock rather than the UTC
  // instant it was resolved to.
  const [schedule, setSchedule] = useState<ScheduleEntryFields>(() =>
    record.schedule !== undefined
      ? scheduleEntryFieldsFrom(record.schedule)
      : defaultScheduleEntryFields(Date.now()),
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);

  const maxAgeError = maxAgeEnabled ? maxAgeDaysError(maxAgeDays) : undefined;
  const tokenMaxAgeDays =
    maxAgeEnabled && maxAgeError === undefined && typeof maxAgeDays === "number"
      ? maxAgeDays
      : undefined;
  const cadenceNote = maxAgeCadenceNote(tokenMaxAgeDays);
  const scheduleErrors = scheduleEnabled
    ? scheduleEntryErrors(schedule, record.schedule)
    : {};
  const scheduleValid =
    !scheduleEnabled || scheduleEntryUsable(schedule, record.schedule);
  const cadenceProblem = scheduleEnabled
    ? cadenceAgainstTokenBound(schedule.intervalDays, tokenMaxAgeDays)
    : undefined;
  const labelValid = labelWithinCap(label);
  const canSave =
    labelValid &&
    scheduleValid &&
    !saving &&
    (!maxAgeEnabled || maxAgeError === undefined);

  function editSchedule(fields: Partial<ScheduleEntryFields>) {
    setSchedule((current) => ({ ...current, ...fields }));
    setSaved(false);
  }

  /**
   * What this save does to the stored schedule: the resolved cadence to write,
   * `null` to drop it, or `undefined` to leave the stored object alone.
   *
   * A cadence the operator did not touch is OMITTED rather than written back:
   * the schedule object also holds bookkeeping the unattended runner advances
   * under an open page -- `nextWindow` and `consecutiveMisses` (see
   * docs/spec/MANAGED_EXCHANGE_RECORD.md, "The schedule object") -- and writing
   * back the object as the page mounted it would rewind that advance to a
   * window the runner has already accounted for.
   *
   * A cadence the operator DID edit is resolved afresh against the stored
   * schedule: fields the edit did not touch are copied from it verbatim rather
   * than re-derived from what they display, so editing one field rewrites no
   * other (see {@link scheduleEntryUnchanged}).
   */
  function scheduleEdit(): ManagedExchangeSchedule | null | undefined {
    if (!scheduleEnabled)
      return record.schedule !== undefined ? null : undefined;
    if (record.schedule === undefined)
      return buildScheduleFromEntry(schedule, Date.now());
    return scheduleEntryUnchanged(schedule, record.schedule)
      ? undefined
      : buildScheduleFromEntry(schedule, Date.now(), record.schedule);
  }

  function save() {
    if (!canSave) return;
    setSaving(true);
    setSaved(false);
    setFailed(false);
    // The max-age opt-in is a three-way edit: enabled with a valid value sets it,
    // disabled clears it (null), so an off checkbox drops what is stored rather
    // than leaving it untouched. The schedule takes the same shape for a toggle
    // the operator moved, and no edit at all otherwise.
    const scheduleChange = scheduleEdit();
    const edits: ManagedExchangeLocalEdits = {
      label,
      tokenMaxAgeDays: maxAgeEnabled ? (tokenMaxAgeDays ?? null) : null,
      ...(scheduleChange !== undefined ? { schedule: scheduleChange } : {}),
    };
    void onSave(edits)
      .then(() => setSaved(true))
      .catch(() => setFailed(true))
      .finally(() => setSaving(false));
  }

  return (
    <div className={styles.callout}>
      <h2 className={styles.eyebrow}>Local settings</h2>
      <p className={styles.small}>
        These settings live only in this browser and edit in place, without
        re-inviting your partner or changing the agreed terms.
      </p>
      <TextInput
        label="Label"
        description={LABEL_GUIDANCE}
        value={label}
        maxLength={MAX_LABEL_LENGTH}
        error={
          labelValid
            ? undefined
            : `Keep the label to ${MAX_LABEL_LENGTH} characters or fewer.`
        }
        onChange={(event) => {
          setLabel(event.currentTarget.value);
          setSaved(false);
        }}
        mt="sm"
      />
      <Checkbox
        label="Run this exchange on an agreed schedule"
        description="Off by default. Enter the cadence and window you agreed with your partner; each of you enters it on your own machine, and nothing about it is sent anywhere."
        checked={scheduleEnabled}
        onChange={(event) => {
          setScheduleEnabled(event.currentTarget.checked);
          setSaved(false);
        }}
        mt="sm"
      />
      {scheduleEnabled && (
        <ScheduleEntryFieldset
          fields={schedule}
          errors={scheduleErrors}
          onEdit={editSchedule}
        />
      )}
      <Checkbox
        label="Set a maximum age for the stored secret"
        description="Off by default. When set, the stored secret lapses if the exchange is not run or renewed within the age you choose."
        checked={maxAgeEnabled}
        onChange={(event) => {
          setMaxAgeEnabled(event.currentTarget.checked);
          setSaved(false);
        }}
        mt="sm"
      />
      {maxAgeEnabled && (
        <NumberInput
          label="Maximum age in days"
          value={maxAgeDays}
          min={1}
          max={MAX_TOKEN_MAX_AGE_DAYS}
          step={1}
          allowDecimal={false}
          error={maxAgeError}
          onChange={(value) => {
            setMaxAgeDays(value);
            setSaved(false);
          }}
          mt="xs"
        />
      )}
      {cadenceNote !== undefined && (
        <p className={`${styles.small} ${styles.sub}`}>{cadenceNote}</p>
      )}
      {cadenceProblem !== undefined && (
        <Alert
          color="yellow"
          title="This cadence outruns the maximum age"
          mt="sm"
          mb="sm"
        >
          {cadenceProblem}
        </Alert>
      )}
      <p className={`${styles.small} ${styles.sub}`}>
        Shortening the maximum age applies now. Turning the bound off applies
        now too and removes the age lapse entirely, so the stored secret no
        longer lapses by age. A longer maximum age takes effect the next time
        this exchange runs, so an edit never extends the stored secret&apos;s
        life on its own.
      </p>
      <p className={`${styles.small} ${styles.sub}`}>
        {record.expires !== undefined
          ? `Stored secret lapses ${dateLabel(new Date(record.expires))}.`
          : "No age bound is set; the stored secret does not lapse by age."}
      </p>
      {failed && (
        <Alert color="red" title="That could not be saved" mt="sm" mb="sm">
          These settings were not saved. Nothing changed; try again.
        </Alert>
      )}
      {saved && !failed && (
        <p className={`${styles.small} ${styles.statusLineOk}`}>
          Settings saved.
        </p>
      )}
      <Button mt="sm" onClick={save} loading={saving} disabled={!canSave}>
        Save settings
      </Button>
    </div>
  );
}

/**
 * The cadence fields of {@link LocalFieldsEditor}, shown once the operator opts
 * the exchange into a schedule. The entered wall-clock time is echoed back as
 * the instant it resolves to: a time the operator's zone skips or repeats
 * across a daylight-saving transition names a different instant than the wall
 * clock reads, and the instant is what both runners meet at (see
 * {@link ./scheduleEntryModel.ts}).
 *
 * The date and time are native inputs rather than a date picker: the value is a
 * cadence agreed with a partner and read off a message, and typing it back is
 * the shortest path from that message to the field.
 */
function ScheduleEntryFieldset({
  fields,
  errors,
  onEdit,
}: {
  fields: ScheduleEntryFields;
  errors: ReturnType<typeof scheduleEntryErrors>;
  onEdit: (edits: Partial<ScheduleEntryFields>) => void;
}) {
  const resolved = resolvedFirstWindowLabel(fields);
  // NumberInput rounds what it displays and clamps an out-of-range value to
  // bounds on blur when decimals are off; on a stored width finer than whole
  // hours or below the entry floor (an import, a hand-edited record), a bare
  // focus and blur would silently write that rounded, clamped number into the
  // save. Decimals are opened exactly where the stored value needs them and
  // the clamp is off entirely; scheduleEntryErrors still enforces the bounds
  // at the field.
  const widthNeedsDecimals = !Number.isInteger(fields.windowHours);
  return (
    <>
      <TextInput
        label="First agreed run window (date)"
        description="The date of the first window you and your partner agreed, on your own calendar."
        type="date"
        value={fields.firstWindowDate}
        error={errors.firstWindowDate}
        onChange={(event) =>
          onEdit({ firstWindowDate: event.currentTarget.value })
        }
        mt="xs"
      />
      <TextInput
        label="Time the window opens"
        description="On your own clock. It is stored as the exact moment it names, so the window does not move when the clocks change."
        type="time"
        value={fields.firstWindowTime}
        error={errors.firstWindowTime}
        onChange={(event) =>
          onEdit({ firstWindowTime: event.currentTarget.value })
        }
        mt="xs"
      />
      <NumberInput
        label="A window opens every (days)"
        value={fields.intervalDays}
        min={1}
        max={MAX_SCHEDULE_INTERVAL_DAYS}
        step={1}
        allowDecimal={false}
        error={errors.intervalDays}
        onChange={(value) => onEdit({ intervalDays: value })}
        mt="xs"
      />
      <NumberInput
        label="Each window stays open (hours)"
        description="Both of you must be running during the same window, so a wide window is what absorbs the difference between your two clocks and the slack of two independently-kept machines."
        value={fields.windowHours}
        min={MIN_SCHEDULE_WINDOW_HOURS}
        max={MAX_SCHEDULE_WINDOW_HOURS}
        step={1}
        allowDecimal={widthNeedsDecimals}
        clampBehavior="none"
        error={errors.windowHours}
        onChange={(value) => onEdit({ windowHours: value })}
        mt="xs"
      />
      {resolved !== undefined && (
        <p className={`${styles.small} ${styles.sub}`}>
          The first window opens {resolved}. Check that against what you agreed:
          your partner enters the same moment on their own clock, and every
          later window is counted from it.
        </p>
      )}
    </>
  );
}

/**
 * The agreed run schedule, read-only: the cadence, where the recurrence stands
 * at this render, and the states this runtime owes the operator accurately
 * around it -- whether an unattended run happens here at all, that a browser
 * holding no pointer to the input file cannot meet a window with nobody
 * present, and, once misses have accumulated, the coordination prompt.
 *
 * A record with no agreed schedule renders nothing here: it is attended-only,
 * and the local-fields editor above is where a schedule is entered.
 *
 * The instant is read at render (`Date.now()`) rather than held in state: this
 * section reads where the recurrence stands when the operator opened it, and a
 * window that opens or closes while they sit on the page is the next visit's
 * reading, not a ticking one. The runtime reading beside it is read the same
 * way and cannot change while the page is open (see {@link isInstalledRuntime}).
 */
function RunSchedule({ record }: { record: ManagedExchangeRecord }) {
  const view = scheduleView(
    record,
    storedInputHandleUsable(record.inputFileHandle),
    isInstalledRuntime(),
    Date.now(),
  );
  if (view === undefined) return null;
  return (
    <div className={styles.callout}>
      <h2 className={styles.eyebrow}>Run schedule</h2>
      <p className={styles.calloutLead}>{view.dueLine}</p>
      <p className={styles.small}>{view.cadence}</p>
      {view.coordination !== undefined && (
        <Alert color="yellow" title={REPEATED_MISS_TITLE} mt="sm" mb="sm">
          {view.coordination.prompt}
        </Alert>
      )}
      <p className={`${styles.small} ${styles.sub}`}>{view.attendanceNote}</p>
      {view.inputReselectionNote !== undefined && (
        <p className={`${styles.small} ${styles.sub}`}>
          {view.inputReselectionNote}
        </p>
      )}
      <p className={`${styles.small} ${styles.sub}`}>
        This schedule is what you and your partner agreed out of band; it is
        kept only in this browser and is never sent anywhere. Change it under
        Local settings above.
      </p>
    </div>
  );
}

/**
 * The run history: what the most recent run DID, whether or not it completed.
 * The record's own bookkeeping keeps only that one run (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, the `lastRun` row), so this section is
 * scoped to it. Every completed run's disclosures are in the accounting below;
 * a run that failed before disclosing never enters it. A saved-but-never-run
 * exchange renders the plain empty state.
 */
function RunHistory({ record }: { record: ManagedExchangeRecord }) {
  const entries = runHistoryEntries(record);
  return (
    <div className={styles.callout}>
      <h2 className={styles.eyebrow}>Run history</h2>
      {entries.length === 0 ? (
        <p className={styles.small}>
          This exchange has not run yet. Its runs will appear here.
        </p>
      ) : (
        <>
          <p className={`${styles.small} ${styles.sub}`}>
            Only the most recent run&apos;s outcome is kept. Every completed
            run&apos;s disclosure is in the accounting below.
          </p>
          {entries.map((entry) => (
            <div key={entry.at} className={styles.dlRow}>
              <span className={styles.dlLabel}>
                {entry.when} - {entry.outcome}
              </span>
              <span>{entry.disclosure}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/** One disclosure fact as a configuration row, rendered in the same voice as
 * the agreed terms above it: its values when it has any, its named empty state
 * when it does not. */
function factRow(fact: DisclosureFact): ConfigRow {
  return fact.values.length > 0
    ? {
        label: fact.label,
        values: fact.values,
        ...(fact.note !== undefined ? { note: fact.note } : {}),
      }
    : { label: fact.label, muted: fact.muted };
}

/**
 * The accounting of disclosures: one entry per completed run, each read off
 * that run's own self-attested exchange record (see
 * docs/spec/EXCHANGE_RECORD.md), plus the CSV a compliance reader is handed.
 * Entries are the records themselves, not a summary beside them, so this view
 * holds no facts of its own that could drift from the underlying record.
 *
 * A failed read renders as its own state, never as an empty accounting -- an
 * empty accounting is a claim ("nothing was disclosed") this view must not
 * make on a read it could not perform. The read's own classification picks
 * which state: a value written under an EARLIER record format routes to the
 * export-then-reset recovery ({@link UnreadableAccountingRecovery}); one
 * written under a LATER one routes to the reload notice
 * ({@link StalePageAccountingNotice}); a store that never yielded a value
 * routes to the transient notice ({@link UnavailableAccountingNotice}). Only
 * the first offers anything destructive -- the other two describe a condition
 * outside the stored records, which clearing them would not fix. All three
 * replace the CSV export and the footer's offer of it, since neither can
 * speak for entries this read did not obtain.
 *
 * Each entry starts collapsed behind its date and partner, keeping a long
 * history scannable.
 *
 * A read still IN FLIGHT is its own state: an absent classification is not
 * the `"none"` one, so the empty accounting must not stand in for it. It has
 * no affordance either -- the recovery arms belong to a read that reached a
 * verdict.
 *
 * Every count and empty state here speaks for THIS browser's copy: the
 * export/import artifact migrates the runnable exchange without its
 * accounting (see {@link ../psi/managedExchangeStore.ts}), so an imported
 * device starts an accounting of its own, where an unqualified "nothing was
 * disclosed" would be treated as the partnership's whole history.
 */
function DisclosureAccountingView({
  read,
  completedRunOnRecord,
  onReset,
  onRetryRead,
}: {
  read: DisclosureAccountingRead | undefined;
  /** Whether the record beside this accounting remembers a completed run,
   * which an empty accounting must reflect accurately (see
   * {@link EmptyAccountingNotice}). */
  completedRunOnRecord: boolean;
  onReset: () => Promise<void>;
  onRetryRead: () => void;
}) {
  const [openedNonce, setOpenedNonce] = useState<string>();
  // Entries come only from the validated accounting, so the stored form the
  // recovery hands back as a file has no path into anything rendered here.
  const accounting = read?.kind === "accounting" ? read.accounting : undefined;
  const entries = accounting === undefined ? [] : disclosureEntries(accounting);
  const exportCsv = () => {
    if (accounting === undefined) return;
    triggerBlobDownload(
      disclosureAccountingFileName(new Date()),
      disclosureAccountingCsv(accounting),
      DISCLOSURE_EXPORT_MIME,
    );
  };
  return (
    <div className={styles.callout}>
      <h2 className={styles.eyebrow}>Accounting of disclosures</h2>
      <p className={styles.small}>
        Every completed run files its own record here: who you disclosed to,
        under which agreement and for what purpose, the categories of data that
        moved each way, how many records you exposed, and -- when both sides
        received the result -- its size. Each entry is that run&apos;s
        self-attested record, built from what both sides already hold and
        deliberately unsigned: an honest local account, not a signed or
        non-repudiable receipt.
      </p>
      {read === undefined ? (
        <>
          <Loader size="sm" />
          <p className={styles.small}>
            Reading this browser&apos;s copy of the accounting.
          </p>
        </>
      ) : read.kind === "unavailable" ? (
        <UnavailableAccountingNotice onRetryRead={onRetryRead} />
      ) : read.kind === "stale-page" ? (
        <StalePageAccountingNotice stored={read.stored} />
      ) : read.kind === "unreadable" ? (
        <UnreadableAccountingRecovery stored={read.stored} onReset={onReset} />
      ) : entries.length === 0 ? (
        <EmptyAccountingNotice completedRunOnRecord={completedRunOnRecord} />
      ) : (
        <>
          <p className={`${styles.small} ${styles.sub}`}>
            {entries.length === 1
              ? "1 disclosure recorded in this browser."
              : `${entries.length} disclosures recorded in this browser.`}
          </p>
          {entries.map((entry) => (
            <DisclosureSection
              key={entry.bindingNonce}
              label={entry.when}
              summary={entry.partner}
              open={openedNonce === entry.bindingNonce}
              onToggle={(open) =>
                setOpenedNonce(open ? entry.bindingNonce : undefined)
              }
              headingOrder={3}
            >
              {entry.facts.map((fact) => (
                <ConfigRowItem key={fact.label} row={factRow(fact)} />
              ))}
            </DisclosureSection>
          ))}
          <Button variant="default" onClick={exportCsv} mt="sm">
            Export this accounting (CSV)
          </Button>
        </>
      )}
      <p className={`${styles.small} ${styles.sub}`}>
        This accounting is kept in this browser and is deleted with the
        exchange.{" "}
        {entries.length > 0 && (
          <>
            Export it if you need to keep it, or hand an auditor a run record
            file you downloaded when that run finished.{" "}
          </>
        )}
        To check a record file you saved, open the{" "}
        <Link to="/verify">verify page</Link> and drop it in.
      </p>
    </div>
  );
}

/**
 * The store was read and holds no accounting for this exchange, in the terms
 * the record beside it supports.
 *
 * An empty accounting is not by itself evidence that no run has completed: the
 * recovery reset destroys the entries while leaving the exchange -- run
 * history included -- standing, and the export/import artifact migrates the
 * runnable exchange without its accounting. Where the record remembers a
 * completed run, this states the emptiness as fact and names those two paths
 * to it, rather than reporting an absence of runs the record beside it
 * refutes. Where the record remembers no completed run, the plain empty state
 * stands.
 *
 * Neither reading claims the exchange disclosed nothing: both speak for this
 * browser's copy, since the accounting does not travel with the exchange.
 */
function EmptyAccountingNotice({
  completedRunOnRecord,
}: {
  completedRunOnRecord: boolean;
}) {
  if (completedRunOnRecord)
    return (
      <p className={styles.small}>
        This browser&apos;s copy of the accounting is empty, while the run
        history above records a completed run -- so it is not an account of
        everything this exchange has disclosed. Records filed here are destroyed
        by &quot;Start a fresh accounting&quot;, and an exchange restored from
        an export or backup file arrives without the accounting kept on the
        device it came from. Each run this browser completes files its record
        here.
      </p>
    );
  return (
    <p className={styles.small}>
      No run of this exchange has completed in this browser, so this
      browser&apos;s copy of the accounting is empty. That is not necessarily
      the exchange&apos;s whole history: an exchange imported from a backup file
      arrives without the accounting kept on the device it came from. Each run
      this browser completes will file its record here.
    </p>
  );
}

/**
 * The state where the accounting could not be OBTAINED: the browser's store
 * did not open, or the read did not complete. Nothing is known about what is
 * stored, so this state makes no claim about it and offers no arm of the
 * recovery -- not the reset, which destroys records this read has no evidence
 * are damaged. The documented cause is transient and self-healing (another tab
 * holding an older version of the store open; see
 * {@link ../psi/managedExchangeStore.ts}), so the affordance is to read again.
 *
 * Reading again rather than reloading the page: a reload ends a run in
 * progress, and this section sits below the run controls.
 */
function UnavailableAccountingNotice({
  onRetryRead,
}: {
  onRetryRead: () => void;
}) {
  return (
    <Alert color="blue" title="This accounting could not be read right now">
      <p>
        The disclosure records stored for this exchange could not be read from
        this browser&apos;s storage, so they are not shown. This does not mean
        nothing was disclosed, and nothing stored here has been changed or
        deleted.
      </p>
      <p>
        A tab running an older version of this app can hold that storage for a
        while. Close any other tab this app is open in, then try again.
      </p>
      <Button variant="default" mt="sm" onClick={onRetryRead}>
        Try reading it again
      </Button>
    </Alert>
  );
}

/** Hand the stored accounting back as the file it is stored as. Shared by the two
 * states that hold a stored value, so what an operator downloads does not depend
 * on which one they reached it from. */
function downloadStoredAccounting(stored: StoredDisclosureAccounting): void {
  triggerBlobDownload(
    storedDisclosureAccountingFileName(new Date()),
    storedDisclosureAccountingDocument(stored),
    DISCLOSURE_STORED_EXPORT_MIME,
  );
}

/**
 * The state where the stored entries were written by a LATER version of the
 * app than this page is running: a new deployment activated while this tab
 * went on running the code it loaded with (the service worker does not swap
 * code under a running page; see {@link ../utils/appShellUpdate.ts}), and the
 * entries that build filed name a record format this one does not admit.
 *
 * The records are not stranded and nothing here is damaged -- a build that
 * reads them exists, and this page simply is not it. This state offers no
 * reset: clearing would destroy records the current version reads, over a
 * condition a reload clears. The stored-form export stays, since handing back
 * stored bytes asserts nothing about them and costs nothing.
 *
 * Like the stranded state, a run from this page discloses and files nothing
 * here: this build's read failure is a write failure too, which is what makes
 * the reload urgent rather than cosmetic.
 *
 * The reload is named rather than pressed: this section sits below the run
 * controls, a reload ends a run in progress, and the app's own update banner
 * holds the reload button, above every route.
 */
function StalePageAccountingNotice({
  stored,
}: {
  stored: StoredDisclosureAccounting;
}) {
  return (
    <>
      <Alert
        color="blue"
        title="This page is running an older version of psilink"
      >
        <p>
          The disclosure records stored for this exchange were filed by a newer
          version of this app than this page is running, so they are not shown
          here. Nothing is wrong with them, and nothing stored here has been
          changed or deleted.
        </p>
        <p>
          Runs started from this page file no record here either: this version
          cannot add to what a newer one wrote. Reload this page to use the
          current version, which reads these records and files again. If a run
          is under way, reloading ends it.
        </p>
      </Alert>
      <p className={`${styles.small} ${styles.sub}`}>
        You can still download the records in the form they are stored in, for
        your own files. This app version cannot read that file back or check it.
      </p>
      <div className={styles.savedRowActions} style={{ marginTop: "1rem" }}>
        <Button
          variant="default"
          onClick={() => downloadStoredAccounting(stored)}
        >
          Download the stored records (JSON)
        </Button>
      </div>
    </>
  );
}

/**
 * The recovery affordance for an accounting this build can no longer read: an
 * app upgrade moved the exchange-record format forward, the stored entries
 * stay admissible under the format they were written under, and the
 * validating read refuses them wholesale. Reached only for entries this build
 * is AHEAD of; the opposite direction is a stale page rather than a stranded
 * accounting, and takes {@link StalePageAccountingNotice}.
 *
 * Two arms, offered export-then-reset (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, "The recovery offered is export then
 * reset"): the EXPORT is the only thing that retains the record -- the
 * accounting is a HIPAA/FERPA disclosure source and nothing else holds it --
 * and the RESET is the only thing that restores appendability, since the read
 * failure is an append failure too. Reversing the order loses the record the
 * export would have saved.
 *
 * Whether the export is offered is read off the stored value: a
 * record-version bump leaves the envelope parsable and the entries come back
 * whole; corruption that takes the envelope leaves nothing to hand over, and
 * that state says so. The reset is offered either way -- it is what restores
 * appendability -- but only behind an explicit confirm naming what is
 * destroyed and what is kept.
 */
function UnreadableAccountingRecovery({
  stored,
  onReset,
}: {
  stored: StoredDisclosureAccounting | undefined;
  onReset: () => Promise<void>;
}) {
  // Whether the download was TAKEN here, not whether the file landed: the browser
  // writes it after the click and reports nothing back. It drives a prompt to check
  // for the file, never a claim that it is saved.
  const [downloadTaken, setDownloadTaken] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetFailed, setResetFailed] = useState(false);

  function downloadStored() {
    if (stored === undefined) return;
    downloadStoredAccounting(stored);
    setDownloadTaken(true);
  }

  function confirmReset() {
    setResetting(true);
    setResetFailed(false);
    void onReset()
      .then(() => setConfirming(false))
      .catch(() => {
        // A rejected delete leaves the accounting standing: keep the modal open and
        // show the failure, so the operator retries rather than believing a
        // destructive step took that did not.
        setResetFailed(true);
      })
      .finally(() => setResetting(false));
  }

  return (
    <>
      <Alert color="red" title="This accounting could not be read">
        <p>
          The disclosure records stored for this exchange could not be read, so
          they are not shown. This does not mean nothing was disclosed. An app
          upgrade can leave a stored accounting unreadable to this version of
          the app.
        </p>
        <p>
          Until it is cleared, this exchange cannot add to it either: every run
          still discloses, and none of them files a record here.
        </p>
        {stored !== undefined ? (
          <p>
            The records themselves are still stored, in the form the app that
            wrote them used. Download them first -- that is the only way to keep
            them -- and then start a fresh accounting, which destroys them and
            lets this exchange file its disclosures again.
          </p>
        ) : (
          <p>
            What is stored could not be read even in its stored form, so there
            is no export of it from here. What remains is any record file you
            downloaded yourself when a run finished; a run that finished
            unattended left none. Starting a fresh accounting destroys what is
            stored and lets this exchange file its disclosures again.
          </p>
        )}
      </Alert>
      {stored !== undefined && (
        <p className={`${styles.small} ${styles.sub}`}>
          The downloaded file is the stored form of this accounting, for your
          own records. It is not a run&apos;s record file, and this app version
          cannot read it back or check it.
        </p>
      )}
      <div className={styles.savedRowActions} style={{ marginTop: "1rem" }}>
        {stored !== undefined && !confirming && (
          // Withdrawn while the confirm is open, which re-offers the same
          // download: the modal renders over this rather than replacing it, so
          // leaving both mounted would put two buttons under one accessible name
          // in the tree a screen reader walks.
          <Button variant="default" onClick={downloadStored}>
            Download the stored records (JSON)
          </Button>
        )}
        <Button
          variant="subtle"
          color="red"
          disabled={resetting}
          onClick={() => {
            setResetFailed(false);
            setConfirming(true);
          }}
        >
          Start a fresh accounting
        </Button>
      </div>
      <Modal
        opened={confirming}
        onClose={() => setConfirming(false)}
        title="Start a fresh accounting"
        centered
        transitionProps={{ duration: 0 }}
      >
        <p>
          Delete the disclosure records stored for this exchange? They are
          destroyed permanently, this browser holds no other copy, and it cannot
          be undone.
        </p>
        <p className={`${styles.small} ${styles.sub}`}>
          The exchange itself is kept: its agreed terms, its stored secret, its
          schedule, and its run history are untouched. Its next completed run
          files the first entry of the new accounting.
        </p>
        {stored !== undefined ? (
          <>
            <p className={`${styles.small} ${styles.sub}`}>
              {downloadTaken
                ? "Check that the download reached your downloads folder before continuing."
                : "You have not downloaded the stored records from here. Download them first if you need to keep them."}
            </p>
            <Button variant="default" onClick={downloadStored}>
              Download the stored records (JSON)
            </Button>
          </>
        ) : (
          <p className={`${styles.small} ${styles.sub}`}>
            There is nothing to download first: what is stored could not be read
            even in its stored form.
          </p>
        )}
        {resetFailed && (
          <Alert
            color="red"
            title="That accounting could not be reset"
            mt="sm"
            mb="sm"
          >
            The stored records were not deleted. Nothing changed; try again.
          </Alert>
        )}
        <div className={styles.savedRowActions} style={{ marginTop: "1rem" }}>
          <Button variant="default" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button
            color="red"
            variant="light"
            loading={resetting}
            onClick={confirmReset}
          >
            Delete these records
          </Button>
        </div>
      </Modal>
    </>
  );
}
