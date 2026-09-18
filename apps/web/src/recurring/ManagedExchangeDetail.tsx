import { useEffect, useRef, useState } from "react";

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

import { downloadBlob, triggerBlobDownload } from "@components/blobDownload";

import {
  outputDirectoryGrantSupported,
  storedOutputDirectoryUsable,
} from "@psi/managed/managedOutputDirectory";

import { DisclosureSection } from "@components/DisclosureSection";
import { isInstalledRuntime } from "@utils/installedRuntime";
import { storedInputHandleUsable } from "@psi/managed/managedInputHandle";

import { dateLabel } from "@psi/formatting";

import {
  LABEL_GUIDANCE,
  MAX_LABEL_LENGTH,
  MAX_TOKEN_MAX_AGE_DAYS,
  labelWithinCap,
  maxAgeCadenceNote,
  maxAgeDaysError,
} from "@exchange/manageOfferModel";
import styles from "@styles/app.module.css";

import {
  DELIVERY_NOT_RECORDED,
  SIDE_LABELS,
  completedRunRecorded,
  connectionRows,
  lastRunMayHaveSentPayload,
  linkageTermsRows,
  runHistoryEntries,
  scheduleView,
} from "./managedDetailModel";
import {
  DISCLOSURE_EXPORT_MIME,
  DISCLOSURE_STORED_EXPORT_MIME,
  PARTIAL_DISCLOSURE_LABEL,
  disclosureAccountingCsv,
  disclosureAccountingFileName,
  disclosureEntries,
  storedDisclosureAccountingDocument,
  storedDisclosureAccountingFileName,
  unfiledDisclosureRows,
  unfiledDisclosureShortfall,
} from "./disclosureAccountingModel";
import {
  MAX_SCHEDULE_INTERVAL_DAYS,
  MAX_SCHEDULE_WINDOW_HOURS,
  MIN_SCHEDULE_WINDOW_HOURS,
  OUTPUT_FOLDER_GRANT_NOTE,
  OUTPUT_FOLDER_SCOPE_NOTE,
  OUTPUT_FOLDER_UNSCHEDULED_NOTE,
  OUTPUT_FOLDER_UNSUPPORTED_NOTE,
  buildScheduleFromEntry,
  cadenceAgainstTokenBound,
  defaultScheduleEntryFields,
  outputFolderGrant,
  outputFolderGrantedNote,
  resolvedFirstWindowLabel,
  scheduleEntryErrors,
  scheduleEntryFieldsFrom,
  scheduleEntryUnchanged,
  scheduleEntryUsable,
} from "./scheduleEntryModel";

import {
  CLEAR_PARKED_RESULTS_NOTE,
  NO_PARKED_RESULTS_NOTE,
  PARKED_RESULTS_RETENTION_NOTE,
  PARKED_RESULTS_SCHEDULE_NOTE,
  UNAVAILABLE_PARKED_RESULTS_NOTE,
  UNREADABLE_PARKED_RESULTS_NOTE,
  parkedResultsRows,
  projectedResultSizeWarning,
} from "./parkedResultsModel";
import {
  REINVITE_COMPROMISE_REASON,
  REINVITE_RUN_IN_FLIGHT_REASON,
} from "./managedReinviteGate";
import {
  REPEATED_MISS_TITLE,
  UNCHANGED_INPUT_TITLE,
} from "./scheduleSurfacingModel";
import { useInputFileModifiedAt } from "./useInputFileModifiedAt";

import type {
  ManagedExchangeLocalEdits,
  ManagedExchangeRecord,
  ManagedExchangeSchedule,
} from "@psi/managed/managedExchangeRecord";
import type {
  OutputFolderGrant,
  ScheduleEntryFields,
} from "./scheduleEntryModel";
import type { ConfigRow } from "./managedDetailModel";
import type { DisclosureAccountingRead } from "@psi/disclosureAccountingStore";
import type { DisclosureFact } from "./disclosureAccountingModel";
import type { ParkedResultsRead } from "@psi/parkedResultsStore";
import type { StoredDisclosureAccounting } from "@psi/disclosureAccounting";
import type { UnfiledDisclosureRead } from "@psi/unfiledDisclosureStore";

/**
 * The managed exchange detail sections composed onto the per-partnership home at
 * `/saved/$id` (below the run affordance in {@link ./ManagedRunSurface.tsx}): the
 * read-only configuration, the local-fields editor, the agreed run schedule
 * where one exists, the run history, the results a scheduled run left for this
 * visit, and the accounting of disclosures. Derivations and copy come from
 * {@link ./managedDetailModel.ts}, {@link ./parkedResultsModel.ts}, and
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
  unfiledDisclosureRead,
  unrecordedRunFlagged,
  parkedResultsRead,
  onFileUnfiledDisclosures,
  onUnrecordedRunFlagShown,
  onResetAccounting,
  onRetryAccountingRead,
  onRetryParkedResultsRead,
  onClearParkedResults,
  onSaveLocalFields,
  onGrantOutputFolder,
  onStopUsingOutputFolder,
  onReinviteToChangeTerms,
  canReinvite,
  compromiseResponse,
  runInFlight,
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
  /** How reading the note of any run whose record never reached the accounting
   * turned out; `undefined` while the read is in flight. Classified like the
   * accounting read: a store that did not answer must not render as "nothing is
   * missing". */
  unfiledDisclosureRead: UnfiledDisclosureRead | undefined;
  /** Whether this browser could store neither a run's record nor the note of it,
   * and flagged the exchange instead (see {@link ../psi/unfiledDisclosureFlag.ts}).
   * The run cannot be recovered, so the section states it and names the run
   * history as the place the run itself is recorded. */
  unrecordedRunFlagged: boolean;
  /** How reading the results a scheduled run left for this visit turned out;
   * `undefined` while the read is in flight. Classified for the same reason the
   * accounting read is: a store that did not answer must not render as "no run
   * left anything here". */
  parkedResultsRead: ParkedResultsRead | undefined;
  /** Add the records the unfiled-run note retained to the accounting. Offered
   * only where a noted run still has a record to add. Rejects where the store
   * refused it or the accounting is one this build cannot append to; the control
   * shows the failure and the note stands. */
  onFileUnfiledDisclosures: () => Promise<void>;
  /** Fired where the flag's alert has rendered, so the surface that read the
   * flag drops it only once an operator has been shown it. */
  onUnrecordedRunFlagShown: () => void;
  /** Destroy the stored accounting so the exchange can file disclosures again,
   * leaving the exchange itself untouched. Offered only from the unreadable state,
   * behind an explicit confirm, and after the export. Rejects on a store failure;
   * the confirm shows the failure and stays open. */
  onResetAccounting: () => Promise<void>;
  /** Read the accounting again, for a read that never reached the store. */
  onRetryAccountingRead: () => void;
  /** Read the parked results again, for a read that never reached the store. */
  onRetryParkedResultsRead: () => void;
  /** Remove everything this exchange's scheduled runs left in this browser, and
   * read the store again so the section shows what it actually holds. Rejects on
   * a store failure; the confirm shows the failure and stays open. */
  onClearParkedResults: () => Promise<void>;
  /** Persist an in-place edit to the local fields (label, max-token-age policy).
   * Rejects on a store failure; the editor shows the failure and keeps the
   * form. */
  onSaveLocalFields: (edits: ManagedExchangeLocalEdits) => Promise<void>;
  /** Ask the operator for the folder a scheduled run writes its results into and
   * persist the grant. MUST reach the picker without an intervening await: the
   * browser grants a folder only under the operator's own gesture. Resolves
   * unchanged where they dismissed the picker, and rejects where the grant or its
   * write failed; the fieldset shows that. */
  onGrantOutputFolder: () => Promise<void>;
  /** Drop the stored grant, returning this exchange's scheduled runs to keeping
   * their results in the browser. Rejects on a store failure. */
  onStopUsingOutputFolder: () => Promise<void>;
  /** Enter the fast re-invite flow -- refresh the partnership with a new secret on
   * the SAME terms (it does not change them; a terms change is a new exchange). The
   * inviter mints a fresh invitation; the acceptor's affordance names asking the
   * partner instead (the caller routes by {@link canReinvite}). */
  onReinviteToChangeTerms: () => void;
  /** Whether this party can mint a re-invite (inviter-only); drives the terms
   * re-invite affordance's copy. */
  canReinvite: boolean;
  /** Whether a compromise response stands on this exchange's record -- the
   * operator answered a failure gate "something does not add up" (see
   * {@link ./ManagedRunSurface.tsx}). The terms re-invite is withheld under one: it
   * mints a fresh secret on the channel they flagged. */
  compromiseResponse: boolean;
  /** Whether a run of this exchange is under way anywhere this browser profile can
   * see. The terms re-invite waits it out: the mint replaces the secret the run is
   * connecting on. */
  runInFlight: boolean;
  /** Whether a re-invite is in flight, so the terms button shows loading. Shared
   * with the run surface's own re-invite state (see {@link ./ManagedRunSurface.tsx}),
   * so an in-flight re-invite displays the same on a healthy exchange as on a failed one. */
  reinviting: boolean;
  /** Whether the last re-invite attempt failed, so the terms button shows the
   * failure beside it. Shared with the run surface's re-invite state. */
  reinviteFailed: boolean;
}) {
  // The last run's own declared counts are what a projection of the next run's
  // result size is drawn from, and they are kept beside what that run left. The
  // warning they raise is shown twice: where the schedule is entered, and in the
  // run history for a visit that is not editing it. The size bound only binds an
  // unattended run, so both are withheld once the schedule is off.
  const scheduled = record.schedule !== undefined;
  const parked =
    parkedResultsRead?.kind === "parked"
      ? parkedResultsRead.results
      : undefined;
  const resultSizeWarning = scheduled
    ? projectedResultSizeWarning(
        parked,
        record.outputDirectoryHandle !== undefined &&
          storedOutputDirectoryUsable(record.outputDirectoryHandle),
      )
    : undefined;
  return (
    <>
      <ConfigurationView
        record={record}
        onReinviteToChangeTerms={onReinviteToChangeTerms}
        canReinvite={canReinvite}
        compromiseResponse={compromiseResponse}
        runInFlight={runInFlight}
        reinviting={reinviting}
        reinviteFailed={reinviteFailed}
      />
      <LocalFieldsEditor
        record={record}
        resultSizeWarning={resultSizeWarning}
        onSave={onSaveLocalFields}
        onGrantOutputFolder={onGrantOutputFolder}
        onStopUsingOutputFolder={onStopUsingOutputFolder}
      />
      <RunSchedule record={record} />
      <RunHistory record={record} resultSizeWarning={resultSizeWarning} />
      <ParkedResultsView
        read={parkedResultsRead}
        scheduled={scheduled}
        onRetryRead={onRetryParkedResultsRead}
        onClear={onClearParkedResults}
      />
      <DisclosureAccountingView
        read={accountingRead}
        unfiledRead={unfiledDisclosureRead}
        unrecordedRunFlagged={unrecordedRunFlagged}
        completedRunOnRecord={completedRunRecorded(record)}
        lastRunMayHaveSent={lastRunMayHaveSentPayload(record)}
        onFileUnfiled={onFileUnfiledDisclosures}
        onUnrecordedRunFlagShown={onUnrecordedRunFlagShown}
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
 * terms mean a new exchange from the partner. It is withheld while a compromise
 * response stands -- minting would put a fresh secret on a channel the operator
 * has flagged -- and while a run is in flight, whose secret the mint replaces
 * ({@link ./managedReinviteGate.ts} holds both reasons, shared with the failure
 * recovery's own control).
 */
function ConfigurationView({
  record,
  onReinviteToChangeTerms,
  canReinvite,
  compromiseResponse,
  runInFlight,
  reinviting,
  reinviteFailed,
}: {
  record: ManagedExchangeRecord;
  onReinviteToChangeTerms: () => void;
  canReinvite: boolean;
  compromiseResponse: boolean;
  runInFlight: boolean;
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
            disabled={compromiseResponse || runInFlight}
          >
            Re-invite with the same terms
          </Button>
          {compromiseResponse ? (
            <p className={styles.small}>{REINVITE_COMPROMISE_REASON}</p>
          ) : (
            runInFlight && (
              <p className={styles.small}>{REINVITE_RUN_IN_FLIGHT_REASON}</p>
            )
          )}
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
 *
 * Where a scheduled run's results go is settled here too, under the cadence and
 * in the order the operator should decide it: the folder grant first, as the path
 * to take ({@link OutputFolderGrantField}), and what happens without one --
 * results kept in this browser, which is row values on this disk
 * ({@link ./parkedResultsModel.ts}) -- after it. Both statements belong before
 * the save, because scheduling is the decision that starts producing results
 * nobody is present to take. The grant, unlike them, is not the schedule's: it
 * takes effect on its own gesture rather than on a save, and it is shown for as
 * long as one is held, so the operator who turns the schedule off still has the
 * folder named and the control to stop using it.
 */
function LocalFieldsEditor({
  record,
  resultSizeWarning,
  onSave,
  onGrantOutputFolder,
  onStopUsingOutputFolder,
}: {
  record: ManagedExchangeRecord;
  /** What a further run on the terms the last one declared projects for the size
   * of its result, where that is more than this browser keeps; absent otherwise
   * (see {@link ./parkedResultsModel.ts}). */
  resultSizeWarning: string | undefined;
  onSave: (edits: ManagedExchangeLocalEdits) => Promise<void>;
  onGrantOutputFolder: () => Promise<void>;
  onStopUsingOutputFolder: () => Promise<void>;
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
  const grant = outputFolderGrant(
    record.outputDirectoryHandle,
    storedOutputDirectoryUsable(record.outputDirectoryHandle),
    outputDirectoryGrantSupported(),
  );
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
      {/* A granted folder stands until the operator drops it, so what names it
          and what stops using it are shown whenever one is held, schedule or no
          schedule. */}
      {(scheduleEnabled || grant.kind === "granted") && (
        <OutputFolderGrantField
          grant={grant}
          scheduled={scheduleEnabled}
          onGrant={onGrantOutputFolder}
          onStopUsing={onStopUsingOutputFolder}
        />
      )}
      {scheduleEnabled && (
        <Alert
          color="blue"
          title="Where a scheduled run's results go without a folder"
          mt="sm"
        >
          {PARKED_RESULTS_SCHEDULE_NOTE}
        </Alert>
      )}
      {scheduleEnabled && resultSizeWarning !== undefined && (
        <Alert
          color="yellow"
          title="A result on these terms could exceed what this browser keeps"
          mt="sm"
        >
          {resultSizeWarning}
        </Alert>
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
 *
 * Where those runs' results go is settled below it rather than in it, by
 * {@link LocalFieldsEditor}: the grant stands whether or not the schedule does.
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
 * The output-folder grant, offered where the operator schedules the exchange: the
 * folder a run with nobody present writes its results into.
 *
 * The grant is taken HERE rather than when the run happens, because the browser
 * hands a site a folder only under the operator's own gesture and a scheduled run
 * has nobody to make one. The click therefore reaches the picker with no awaited
 * work in front of it.
 *
 * A browser that cannot grant a folder says so rather than offering a control
 * that would fail, and the folder's own reach -- everything in it, readable and
 * writable while the grant stands -- is stated where the folder is chosen.
 *
 * A grant held while `scheduled` is false is the state the caller keeps this
 * shown for: turning the schedule off stops the runs, not the grant, so the
 * folder is named and the stop-using control offered with the runs off, over copy
 * saying that nothing writes there until a schedule is set again.
 */
function OutputFolderGrantField({
  grant,
  scheduled,
  onGrant,
  onStopUsing,
}: {
  grant: OutputFolderGrant;
  /** Whether the form has this exchange on a schedule, so the copy states what a
   * standing grant does while the runs are off. */
  scheduled: boolean;
  onGrant: () => Promise<void>;
  onStopUsing: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<"grant" | "stop-using" | undefined>(
    undefined,
  );

  function take(which: "grant" | "stop-using", action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setFailed(undefined);
    void action()
      .catch(() => setFailed(which))
      .finally(() => setBusy(false));
  }

  if (grant.kind === "unsupported")
    return (
      <p className={`${styles.small} ${styles.sub}`}>
        {OUTPUT_FOLDER_UNSUPPORTED_NOTE}
      </p>
    );
  return (
    <div className={styles.callout}>
      <h3 className={styles.eyebrow}>Results folder</h3>
      <p className={styles.small}>{OUTPUT_FOLDER_GRANT_NOTE}</p>
      <p className={`${styles.small} ${styles.sub}`}>
        {OUTPUT_FOLDER_SCOPE_NOTE}
      </p>
      {grant.kind === "granted" && (
        <p className={`${styles.small} ${styles.sub}`}>
          {outputFolderGrantedNote(grant.name)}
        </p>
      )}
      {grant.kind === "granted" && !scheduled && (
        <p className={`${styles.small} ${styles.sub}`}>
          {OUTPUT_FOLDER_UNSCHEDULED_NOTE}
        </p>
      )}
      {failed === "grant" && (
        <Alert color="yellow" title="That folder was not set" mt="sm" mb="sm">
          Nothing changed: scheduled runs keep using whatever they used before.
          Try choosing the folder again.
        </Alert>
      )}
      {failed === "stop-using" && (
        <Alert
          color="yellow"
          title="That folder was not removed"
          mt="sm"
          mb="sm"
        >
          Nothing changed: scheduled runs keep writing to this folder. Try
          stopping again.
        </Alert>
      )}
      <Button
        variant="default"
        loading={busy}
        onClick={() => take("grant", onGrant)}
      >
        {grant.kind === "granted"
          ? "Choose a different folder"
          : "Choose folder"}
      </Button>
      {grant.kind === "granted" && (
        <Button
          variant="subtle"
          mt="xs"
          disabled={busy}
          onClick={() => take("stop-using", onStopUsing)}
        >
          Stop writing to this folder
        </Button>
      )}
    </div>
  );
}

/**
 * The agreed run schedule, read-only: the cadence, where the recurrence stands
 * at this render, and the states this runtime owes the operator accurately
 * around it -- whether an unattended run happens here at all, that a browser
 * holding no pointer to the input file cannot meet a window with nobody
 * present, that the file behind that pointer has not changed since the last
 * successful run, and, once misses have accumulated, the coordination prompt.
 *
 * A record with no agreed schedule renders nothing here: it is attended-only,
 * and the local-fields editor above is where a schedule is entered. Such a
 * record's input file is not read either -- the one reading this section makes
 * of the platform is made only where there is a section to hold it.
 *
 * The instant is read at render (`Date.now()`) rather than held in state: this
 * section reads where the recurrence stands when the operator opened it, and a
 * window that opens or closes while they sit on the page is the next visit's
 * reading, not a ticking one. The runtime reading beside it is read the same
 * way and cannot change while the page is open (see {@link isInstalledRuntime}).
 * The input file's own instant is the one reading that cannot be taken at render
 * -- the platform read is asynchronous -- so it arrives a beat later and the
 * note it feeds appears with it.
 */
function RunSchedule({ record }: { record: ManagedExchangeRecord }) {
  const inputModifiedAtMs = useInputFileModifiedAt(
    record.schedule !== undefined ? record.inputFileHandle : undefined,
  );
  const view = scheduleView(
    record,
    storedInputHandleUsable(record.inputFileHandle),
    isInstalledRuntime(),
    Date.now(),
    inputModifiedAtMs,
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
      {view.unchangedInputNote !== undefined && (
        <Alert color="yellow" title={UNCHANGED_INPUT_TITLE} mt="sm" mb="sm">
          {view.unchangedInputNote}
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
 * scoped to it. Every run that sent this party's payload files its disclosure in
 * the accounting below, whether or not it finished, and raises a notice when the
 * filing fails ({@link ../psi/managed/managedRunDriver.ts}); a run that stopped
 * before disclosing never enters it. A saved-but-never-run exchange renders the
 * plain empty state.
 */
function RunHistory({
  record,
  resultSizeWarning,
}: {
  record: ManagedExchangeRecord;
  /** What a further run projects for the size of its result, where that is more
   * than this browser keeps. It stands here as well as at schedule entry so a
   * visit that is not editing the schedule still meets it before the run it
   * speaks about. */
  resultSizeWarning: string | undefined;
}) {
  const entries = runHistoryEntries(record);
  return (
    <div className={styles.callout}>
      <h2 className={styles.eyebrow}>Run history</h2>
      {resultSizeWarning !== undefined && (
        <Alert
          color="yellow"
          title="The next run's results could exceed what this browser keeps"
          mt="sm"
          mb="sm"
        >
          {resultSizeWarning}
        </Alert>
      )}
      {entries.length === 0 ? (
        <p className={styles.small}>
          This exchange has not run yet. Its runs will appear here.
        </p>
      ) : (
        <>
          <p className={`${styles.small} ${styles.sub}`}>
            Only the most recent run&apos;s outcome is kept. Every run that sent
            your payload files its disclosure in the accounting below, whether
            or not it finished, and warns you if it cannot.
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

/**
 * The results a run nobody was present for left behind, and the one section that
 * collects them. A scheduled run builds the same results file an attended run
 * does, with nobody there to take it, so it keeps the file in this browser and
 * this section hands it over at the next visit.
 *
 * It renders wherever this exchange's page stands: under the detail sections
 * while the exchange runs here, and on the page of a copy a hand-off spent,
 * where what earlier runs left is still at rest and still owed to the operator
 * ({@link ./ManagedRunSurface.tsx}). A spent copy runs nothing further, so it
 * is not `scheduled` and its empty state collapses as an unscheduled
 * exchange's does.
 *
 * Every state a read can be in renders as itself: a store that did not answer
 * says so, a stored value this build cannot read says so, and only a read that
 * found nothing says nothing is here. A run this browser refused to store the
 * results of renders as its own row, so the operator meets the state rather than
 * a gap.
 *
 * An exchange with no schedule renders nothing at all where the read FOUND
 * nothing: it produces no unattended results, and the local-fields editor
 * above is where a schedule is entered. The read still being in flight is the
 * same absence for a first visit -- there is nothing yet to show either way,
 * so a visit to an unscheduled exchange never flashes the loading state only
 * to collapse once the read lands on nothing. Once the section has shown
 * something real, though, it holds its ground rather than vanishing under a
 * retry the operator just asked for: a store that did not answer, or answered
 * with a value this build cannot read, still states itself here as it does on
 * a scheduled exchange.
 */
export function ParkedResultsView({
  read,
  scheduled,
  onRetryRead,
  onClear,
}: {
  read: ParkedResultsRead | undefined;
  /** Whether this exchange has an agreed schedule, so the section stands with
   * its empty state for an exchange whose runs will land here. */
  scheduled: boolean;
  onRetryRead: () => void;
  /** Remove everything this exchange's scheduled runs left here. Rejects on a
   * store failure, which the confirm shows while staying open. */
  onClear: () => Promise<void>;
}) {
  const rows = read?.kind === "parked" ? parkedResultsRows(read.results) : [];
  const shownBefore = useRef(false);
  const emptyForNow =
    !scheduled && (read === undefined || read.kind === "none");
  if (emptyForNow && !shownBefore.current) return null;
  shownBefore.current = true;
  return (
    <div className={styles.callout}>
      <h2 className={styles.eyebrow}>Results from scheduled runs</h2>
      {/* Not shown for a value this build cannot read: the retention it states
          is the one that does not apply to such a value, and the statement
          below says so. */}
      {read?.kind !== "unreadable" && (
        <p className={styles.small}>{PARKED_RESULTS_RETENTION_NOTE}</p>
      )}
      {read === undefined ? (
        <>
          <Loader size="sm" />
          <p className={styles.small}>
            Reading what this browser kept for you.
          </p>
        </>
      ) : read.kind === "unavailable" ? (
        <Alert
          color="blue"
          title="Whether anything is kept here could not be read right now"
          mt="sm"
        >
          <p>{UNAVAILABLE_PARKED_RESULTS_NOTE}</p>
          <Button variant="default" mt="sm" onClick={onRetryRead}>
            Try reading them again
          </Button>
        </Alert>
      ) : read.kind === "unreadable" ? (
        <Alert color="yellow" title="These results cannot be read" mt="sm">
          {UNREADABLE_PARKED_RESULTS_NOTE}
        </Alert>
      ) : rows.length === 0 ? (
        <p className={`${styles.small} ${styles.sub}`}>
          {NO_PARKED_RESULTS_NOTE}
        </p>
      ) : (
        rows.map((row) => {
          const parked = row.entry.kind === "results" ? row.entry : undefined;
          return (
            <div key={row.runAt} className={styles.dlRow}>
              <span className={styles.dlLabel}>{row.when}</span>
              <span>{row.summary}</span>
              {parked !== undefined && (
                <Button
                  variant="light"
                  mt="xs"
                  onClick={() => downloadBlob(parked.fileName, parked.csv)}
                >
                  Download result
                </Button>
              )}
              <span
                className={`${styles.dlNote} ${styles.small} ${styles.sub}`}
              >
                {parked !== undefined
                  ? `Kept until ${row.until}.`
                  : `Recorded here until ${row.until}.`}
              </span>
            </div>
          );
        })
      )}
      {/* Offered for anything this exchange has here, including a value this
          build cannot read -- the delete needs no parse, and it is the only way
          out of that state short of deleting the exchange. Withheld only where
          the read found nothing to clear or did not reach the store, which a
          clear could not speak for either. */}
      {(read?.kind === "parked" || read?.kind === "unreadable") && (
        <ClearParkedResultsControl onClear={onClear} />
      )}
    </div>
  );
}

/**
 * The control that removes what this exchange's scheduled runs left in this
 * browser, now rather than at the retention: the rows, the notes of results
 * written to the granted folder, and the states recorded where results were not
 * kept, in one step.
 *
 * Behind a confirm, because the rows are the run's own result and this browser
 * holds no second copy of them. A rejected clear keeps the confirm open with the
 * failure beside it, so nothing reads as a delete that did not happen.
 */
function ClearParkedResultsControl({
  onClear,
}: {
  onClear: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearFailed, setClearFailed] = useState(false);

  function confirmClear() {
    setClearing(true);
    setClearFailed(false);
    void onClear()
      .then(() => setConfirming(false))
      .catch(() => setClearFailed(true))
      .finally(() => setClearing(false));
  }

  return (
    <>
      <div className={styles.savedRowActions} style={{ marginTop: "1rem" }}>
        <Button
          variant="subtle"
          color="red"
          disabled={clearing}
          onClick={() => {
            setClearFailed(false);
            setConfirming(true);
          }}
        >
          Clear what is kept here
        </Button>
      </div>
      <Modal
        opened={confirming}
        onClose={() => setConfirming(false)}
        title="Clear what is kept here"
        centered
        transitionProps={{ duration: 0 }}
      >
        <p>{CLEAR_PARKED_RESULTS_NOTE}</p>
        <p className={`${styles.small} ${styles.sub}`}>
          Download anything you still want before clearing: this browser holds
          no other copy of results kept here.
        </p>
        {clearFailed && (
          <Alert color="red" title="Nothing was cleared" mt="sm" mb="sm">
            What is kept here was not removed. Nothing changed; try again.
          </Alert>
        )}
        <div className={styles.savedRowActions} style={{ marginTop: "1rem" }}>
          <Button variant="default" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button
            color="red"
            variant="light"
            loading={clearing}
            onClick={confirmClear}
          >
            Clear these results
          </Button>
        </div>
      </Modal>
    </>
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
 * The accounting of disclosures: one entry per run that sent this party's
 * payload, each read off that run's own self-attested exchange record (see
 * docs/spec/EXCHANGE_RECORD.md), plus the CSV a compliance reader is handed.
 * Entries are the records themselves, not a summary beside them, so this view
 * holds no facts of its own that could drift from the underlying record.
 *
 * A run that stopped after sending files an entry too, and the record's own
 * outcome is what marks it: the collapsed row states it beside the instant, so
 * an accounting drawn from the list does not take an unconfirmed send for a
 * delivered one. Either kind of run raises a notice when its filing fails, which
 * is what keeps the intro's own promise from overstating what is here
 * ({@link ../psi/managed/managedRunDriver.ts}).
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
 * A run that disclosed and whose record never reached the accounting is stated
 * above the entries ({@link UnfiledDisclosureNotice}), and the number of such
 * runs qualifies the count of entries, so neither a list of entries nor an empty
 * state reads as a complete account of what this exchange disclosed.
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
  unfiledRead,
  unrecordedRunFlagged,
  completedRunOnRecord,
  lastRunMayHaveSent,
  onFileUnfiled,
  onUnrecordedRunFlagShown,
  onReset,
  onRetryRead,
}: {
  read: DisclosureAccountingRead | undefined;
  /** How reading the note of the runs this accounting is short turned out (see
   * {@link UnfiledDisclosureNotice}). */
  unfiledRead: UnfiledDisclosureRead | undefined;
  /** Whether a run of this exchange is flagged as one this browser could not
   * record at all (see {@link UnfiledDisclosureNotice}). */
  unrecordedRunFlagged: boolean;
  /** Whether the record beside this accounting remembers a completed run,
   * which an empty accounting must reflect accurately (see
   * {@link EmptyAccountingNotice}). */
  completedRunOnRecord: boolean;
  /** Whether the record's retained run leaves open that this party's payload was
   * sent, which the empty accounting must not deny (see
   * {@link EmptyAccountingNotice}). */
  lastRunMayHaveSent: boolean;
  onFileUnfiled: () => Promise<void>;
  /** Fired where the flag's alert renders, which is what drops the flag (see
   * {@link UnrecordedRunAlert}). */
  onUnrecordedRunFlagShown: () => void;
  onReset: () => Promise<void>;
  onRetryRead: () => void;
}) {
  const [openedNonce, setOpenedNonce] = useState<string>();
  // Entries come only from the validated accounting, so the stored form the
  // recovery hands back as a file has no path into anything rendered here.
  const accounting = read?.kind === "accounting" ? read.accounting : undefined;
  const entries = accounting === undefined ? [] : disclosureEntries(accounting);
  const partialCount = entries.filter((entry) => entry.partial).length;
  // How many runs the accounting is short, which qualifies the count of entries
  // below: a count of what is here reads as a count of what was disclosed unless
  // what is missing is stated beside it.
  const unfiledCount =
    unfiledRead?.kind === "unfiled" ? unfiledRead.disclosures.length : 0;
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
        Every run that sent your payload files its own record here, whether or
        not it finished, and warns you if it cannot: who you disclosed to, under
        which agreement and for what purpose, the categories of data that moved
        each way, how many records you exposed, and -- when both sides received
        the result -- its size. A run that stopped after sending is marked, and
        states that delivery to your partner is not confirmed. Each entry is
        that run&apos;s self-attested record, built from what both sides already
        hold and deliberately unsigned: an honest local account, not a signed or
        non-repudiable receipt.
      </p>
      <UnfiledDisclosureNotice
        read={unfiledRead}
        flagged={unrecordedRunFlagged}
        onFile={onFileUnfiled}
        onFlagShown={onUnrecordedRunFlagShown}
      />
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
        <EmptyAccountingNotice
          completedRunOnRecord={completedRunOnRecord}
          lastRunMayHaveSent={lastRunMayHaveSent}
        />
      ) : (
        <>
          <p className={`${styles.small} ${styles.sub}`}>
            {entries.length === 1
              ? "1 disclosure recorded in this browser."
              : `${entries.length} disclosures recorded in this browser.`}
            {partialCount > 0 &&
              (partialCount === 1
                ? " 1 of them stopped before the run finished."
                : ` ${partialCount} of them stopped before the run finished.`)}
            {unfiledCount > 0 && ` ${unfiledDisclosureShortfall(unfiledCount)}`}
          </p>
          {entries.map((entry) => (
            <DisclosureSection
              key={entry.bindingNonce}
              label={
                entry.partial
                  ? `${entry.when} - ${PARTIAL_DISCLOSURE_LABEL}`
                  : entry.when
              }
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
 * What this accounting owes and does not hold: the runs that disclosed and whose
 * records never reached it.
 *
 * It renders above the entries, in every state of the accounting's own read: the
 * shortfall is a fact about this exchange rather than about the accounting's
 * readability, and an accounting that reads perfectly is exactly where a missing
 * run would otherwise pass unseen. The run that hit it raised a notice at the
 * time, which needed somebody present; this is what the next visit reads (see
 * {@link ../psi/unfiledDisclosure.ts}).
 *
 * Each state offers only what it supports. A run whose record was retained can
 * be filed, and the control says so. A run that cannot be filed is told plainly
 * rather than given a control that would do nothing, and its note says which of
 * the two states it is in -- no record was built, or one is stored that this
 * build cannot read -- since the second still holds bytes. A note this build
 * cannot read states that a run is missing without naming it, since the fact and
 * the record are separate things at rest. A flagged run -- the one this
 * browser could store nothing about -- names the two places the run may still be
 * stated, since neither is certain to name it.
 *
 * Nothing is offered for a read that never reached the store: it is the
 * accounting's own storage, whose read states that condition and offers the
 * retry that re-reads both.
 */
function UnfiledDisclosureNotice({
  read,
  flagged,
  onFile,
  onFlagShown,
}: {
  read: UnfiledDisclosureRead | undefined;
  flagged: boolean;
  onFile: () => Promise<void>;
  onFlagShown: () => void;
}) {
  const rows =
    read?.kind === "unfiled" ? unfiledDisclosureRows(read.disclosures) : [];
  const fileable = rows.filter((row) => row.fileable).length;
  return (
    <>
      {flagged && <UnrecordedRunAlert onShown={onFlagShown} />}
      {read?.kind === "unreadable" && (
        <Alert
          color="yellow"
          title="A run's record is missing from this accounting"
          mt="sm"
        >
          A run of this exchange disclosed your payload and its record was not
          saved to the accounting below. The note of which run it was cannot be
          read by this version of the app, so the run is not named here. The
          accounting below is short at least one entry.
        </Alert>
      )}
      {read?.kind === "unavailable" && (
        <p className={`${styles.small} ${styles.sub}`}>
          Whether any run&apos;s record is missing from this accounting could
          not be read from this browser&apos;s storage.
        </p>
      )}
      {rows.length > 0 && (
        <Alert
          color="yellow"
          title={
            rows.length === 1
              ? "A run's record is missing from this accounting"
              : "Some runs' records are missing from this accounting"
          }
          mt="sm"
        >
          <p>
            Each run below disclosed your payload and its record was not saved
            to the accounting, so the accounting is not a complete account of
            what this exchange has disclosed. An accounting exported while this
            stands is short these runs.
          </p>
          {rows.map((row) => (
            <div key={row.key} className={styles.dlRow}>
              <span className={styles.dlLabel}>{row.when}</span>
              {row.partner !== undefined && <span>{row.partner}</span>}
              <span
                className={`${styles.dlNote} ${styles.small} ${styles.sub}`}
              >
                {row.note}
              </span>
            </div>
          ))}
          {fileable > 0 && (
            <FileUnfiledDisclosuresControl count={fileable} onFile={onFile} />
          )}
        </Alert>
      )}
    </>
  );
}

/**
 * The flag's own alert: a run this browser could store nothing about, named by
 * the exchange alone.
 *
 * It reports that it has been shown, which is what drops the flag. The fact has
 * no detail to come back to, so an operator who has read it once is not shown it
 * again; a visit that renders this nowhere leaves the flag standing, since the
 * flag is then still the only trace of that run.
 */
function UnrecordedRunAlert({ onShown }: { onShown: () => void }) {
  useEffect(() => {
    onShown();
  }, [onShown]);
  return (
    <Alert
      color="yellow"
      title="At least one run of this exchange could not be recorded"
      mt="sm"
    >
      <p>
        At least one run of this exchange disclosed your payload, and this
        browser&apos;s storage would take neither its record nor a note of which
        run it was. The accounting below has no entry for it, and there is
        nothing left to add: record the disclosure in your own compliance
        material.
      </p>
      <p>
        The run history above keeps only the most recent run, so the run this is
        about may not be named there. The other place to look is this
        browser&apos;s diagnostic log, where the run reported the failure as it
        happened, for as long as this browser keeps that log.
      </p>
      <p>
        The run&apos;s record could not be stored. If this browser is low on
        storage, free space on this device so the next run can file its record.
      </p>
    </Alert>
  );
}

/**
 * The control that adds the retained records to the accounting. No confirm: it
 * files an entry for a disclosure that happened, which is what the accounting is
 * for, and the append it runs is idempotent on the record's own binding nonce so
 * a second press cannot double an entry.
 *
 * A rejected filing keeps the records where they are and says what to do next:
 * the one failure the operator can act on is an accounting this build cannot
 * append to, whose own recovery is below.
 */
function FileUnfiledDisclosuresControl({
  count,
  onFile,
}: {
  count: number;
  onFile: () => Promise<void>;
}) {
  const [filing, setFiling] = useState(false);
  const [fileFailed, setFileFailed] = useState(false);

  function file() {
    setFiling(true);
    setFileFailed(false);
    void onFile()
      .catch(() => setFileFailed(true))
      .finally(() => setFiling(false));
  }

  return (
    <>
      <Button variant="default" mt="sm" loading={filing} onClick={file}>
        {count === 1
          ? "Add this record to the accounting"
          : "Add these records to the accounting"}
      </Button>
      {fileFailed && (
        <p className={styles.small}>
          The records could not be added and are still kept in this browser. If
          the accounting below cannot be read, start a fresh accounting first,
          then add them again.
        </p>
      )}
    </>
  );
}

/**
 * The store was read and holds no accounting for this exchange, in the terms
 * the record beside it supports.
 *
 * An empty accounting is not by itself evidence that no run has disclosed. The
 * recovery reset destroys the entries while leaving the exchange -- run history
 * included -- standing; the export/import artifact migrates the runnable
 * exchange without its accounting; and a run that stopped after sending files
 * its entry best-effort, so a failed filing leaves an entry missing whether or
 * not anybody was there for the notice it raises (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, "When an entry is written"). So each of
 * the three readings states what is recorded here, and none of them reports an
 * absence of disclosures:
 *
 * - A record remembering a COMPLETED run: the emptiness is stated as fact
 *   beside the run that refutes an absence of runs, naming the two paths to it.
 * - A record whose retained run could have sent ({@link
 *   ./managedDetailModel.ts}, `lastRunMayHaveSentPayload`): the same limit the
 *   run history states for that run, in the same words, since an empty
 *   accounting settles it no better than the run bookkeeping does.
 * - Anything else -- no run, or one that provably stopped before sending: the
 *   plain empty state.
 *
 * No reading claims the exchange disclosed nothing: all three speak for this
 * browser's copy, since the accounting does not travel with the exchange.
 */
function EmptyAccountingNotice({
  completedRunOnRecord,
  lastRunMayHaveSent,
}: {
  completedRunOnRecord: boolean;
  lastRunMayHaveSent: boolean;
}) {
  if (completedRunOnRecord)
    return (
      <p className={styles.small}>
        This browser&apos;s copy of the accounting is empty, while the run
        history above records a completed run -- so it is not an account of
        everything this exchange has disclosed. Records filed here are destroyed
        by &quot;Start a fresh accounting&quot;, and an exchange restored from
        an export or backup file arrives without the accounting kept on the
        device it came from. Each run that sends your payload files its record
        here, whether or not it finishes.
      </p>
    );
  if (lastRunMayHaveSent)
    return (
      <p className={styles.small}>
        This browser&apos;s copy of the accounting is empty: no run of this
        exchange has filed a disclosure here. The run history above records a
        run that did not complete. {DELIVERY_NOT_RECORDED}, and an empty copy is
        not a record that nothing was sent: a run that stops after sending files
        its record here, but that filing can itself fail, and an exchange
        imported from a backup file arrives without the accounting kept on the
        device it came from.
      </p>
    );
  return (
    <p className={styles.small}>
      This browser&apos;s copy of the accounting is empty: no run of this
      exchange has filed a disclosure here. That is not necessarily the
      exchange&apos;s whole history: an exchange imported from a backup file
      arrives without the accounting kept on the device it came from. Each run
      that sends your payload will file its record here, whether or not it
      finishes.
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
