import { useState } from "react";

import { Alert, Button, Checkbox, NumberInput, TextInput } from "@mantine/core";
import { Link } from "@tanstack/react-router";

import {
  LABEL_GUIDANCE,
  MAX_LABEL_LENGTH,
  MAX_TOKEN_MAX_AGE_DAYS,
  labelWithinCap,
  maxAgeCadenceNote,
  maxAgeDaysError,
} from "./manageOfferModel";
import {
  SIDE_LABELS,
  connectionRows,
  linkageTermsRows,
  runHistoryEntries,
} from "./managedDetailModel";
import { dateLabel } from "./inviterModel";
import styles from "./bench.module.css";

import type {
  ManagedExchangeLocalEdits,
  ManagedExchangeRecord,
} from "@psi/managedExchangeRecord";
import type { ConfigRow } from "./managedDetailModel";

/**
 * The managed exchange detail sections composed onto the per-partnership home at
 * `/saved/$id` (below the run affordance in {@link ./ManagedRunSurface.tsx}): the
 * read-only configuration a compliance user inspects, the local-fields editor, the
 * run history, and the self-attested record view. Each is its own component so the
 * run surface stays the run affordance and these compose beside it; the derivations
 * and copy are the pure {@link ./managedDetailModel.ts}'s.
 *
 * The agreed terms are read-only here -- fixed for this partnership; a change to
 * them is a new exchange, not an in-place edit ({@link ConfigurationView} says so
 * and offers the fast re-invite on the same terms) -- while the local fields edit
 * in place without touching the partnership ({@link LocalFieldsEditor}). The record
 * view frames what it shows
 * honestly as self-attested and links to the existing verify page; it never claims
 * a signed receipt.
 */
export function ManagedExchangeDetail({
  record,
  onSaveLocalFields,
  onReinviteToChangeTerms,
  canReinvite,
  reinviting,
  reinviteFailed,
}: {
  record: ManagedExchangeRecord;
  /** Persist an in-place edit to the local fields (label, max-token-age policy).
   * Rejects on a store failure; the editor surfaces the failure and keeps the
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
   * so an in-flight re-invite reads the same on a healthy exchange as on a failed one. */
  reinviting: boolean;
  /** Whether the last re-invite attempt failed, so the terms button surfaces the
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
      <RunHistory record={record} />
      <RecordView record={record} />
    </>
  );
}

/** Render one read-only configuration row: a term and its value, its value list,
 * or its muted empty state. */
function ConfigRowItem({ row }: { row: ConfigRow }) {
  return (
    <div className={styles.dlRow}>
      <span className={styles.dlLabel}>{row.label}</span>
      {row.values !== undefined ? (
        <span>{row.values.join(", ")}</span>
      ) : row.muted !== undefined ? (
        <span className={styles.sub}>{row.muted}</span>
      ) : (
        <span>{row.value}</span>
      )}
    </div>
  );
}

/**
 * The read-only configuration view: this party's side, the channel and partner
 * endpoint, and the agreed linkage terms. The agreed terms are the persisted
 * exchange-file document, fixed for this partnership by design -- a change to them
 * is a new exchange, not an in-place edit (see docs/spec/MANAGED_EXCHANGE_RECORD.md,
 * the `exchangeFile` row). The re-invite affordance here refreshes the partnership
 * with a new secret on the SAME terms, honestly labeled: the inviter mints a fresh
 * invitation; the acceptor is told the terms cannot change by re-invite and that
 * different terms mean a new exchange from the partner.
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
            <Alert color="red" title="That could not be completed" mb="sm">
              The fresh invitation could not be created. Nothing changed here;
              try again.
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
 * The local-fields editor: the label and the max-token-age policy edit in place,
 * without touching the partnership (see docs/spec/MANAGED_EXCHANGE_RECORD.md -- a
 * reschedule or a label change is neither a terms change nor a credential). Editing
 * the max-age policy re-derives `expires` conservatively at the store boundary (an
 * edit never extends the stored credential's life without a rotation), so this form
 * only collects the policy; the derivation is not the form's to make.
 *
 * The schedule is not editable here: no schedule-entry surface exists yet
 * (scheduling is a separate item), so the detail view shows the schedule read-only
 * below rather than a half-built editor. A saved schedule can still be dropped, but
 * there is nothing to drop until scheduling can set one.
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
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);

  const maxAgeError = maxAgeEnabled ? maxAgeDaysError(maxAgeDays) : undefined;
  const tokenMaxAgeDays =
    maxAgeEnabled && maxAgeError === undefined && typeof maxAgeDays === "number"
      ? maxAgeDays
      : undefined;
  const cadenceNote = maxAgeCadenceNote(tokenMaxAgeDays);
  const labelValid = labelWithinCap(label);
  const canSave =
    labelValid && !saving && (!maxAgeEnabled || maxAgeError === undefined);

  function save() {
    if (!canSave) return;
    setSaving(true);
    setSaved(false);
    setFailed(false);
    // The policy is a three-way edit: enabled with a valid count sets it, disabled
    // clears it (null), so an off checkbox drops any standing bound rather than
    // leaving it untouched.
    const edits: ManagedExchangeLocalEdits = {
      label,
      tokenMaxAgeDays: maxAgeEnabled ? (tokenMaxAgeDays ?? null) : null,
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
 * The run history: one entry per run with what was disclosed. Today the record
 * persists only the most-recent run's bookkeeping (a per-run disclosure ledger is a
 * separate future item), so this renders around the most recent run honestly -- the
 * section is shaped per-entry so a fuller ledger can slot in later. A
 * saved-but-never-run exchange shows the honest empty state.
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
            Only the most recent run is kept in this browser.
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
 * The record view for the most recent run: what the record honestly shows. The web
 * app does not persist the per-run exchange record file per exchange -- it is
 * offered to download at run completion (see docs/spec/EXCHANGE_RECORD.md) -- so
 * this view surfaces the run's self-attested facts (from `lastRun`) and explains
 * plainly that the full record file is saved at run completion, linking to the
 * existing verify page for checking a stored file. It is framed as self-attested and
 * never claims a signed, non-repudiable receipt.
 */
function RecordView({ record }: { record: ManagedExchangeRecord }) {
  const { lastRun } = record;
  return (
    <div className={styles.callout}>
      <h2 className={styles.eyebrow}>Record</h2>
      <p className={styles.small}>
        The record for a run is a self-attested account of what this exchange
        disclosed -- built from what both sides already hold, and deliberately
        unsigned. It is an honest local audit note, not a signed or
        non-repudiable receipt.
      </p>
      {lastRun !== undefined && lastRun.outcome === "succeeded" ? (
        <p className={styles.small}>
          The most recent run succeeded on{" "}
          <span className={styles.mono}>{dateLabel(new Date(lastRun.at))}</span>
          . Its full record file was offered to download when the run finished;
          this browser does not keep a copy per exchange.
        </p>
      ) : lastRun !== undefined ? (
        <p className={styles.small}>
          The most recent run did not complete (see the run history above), so
          no completed run is recorded for this exchange yet. A run&apos;s full
          record file is offered to download when the run finishes; this browser
          does not keep a copy per exchange.
        </p>
      ) : (
        <p className={styles.small}>
          No completed run is recorded for this exchange yet. A run&apos;s full
          record file is offered to download when the run finishes; this browser
          does not keep a copy per exchange.
        </p>
      )}
      <p className={styles.small}>
        To check a record file you saved, open the{" "}
        <Link to="/verify">verify page</Link> and drop it in.
      </p>
    </div>
  );
}
