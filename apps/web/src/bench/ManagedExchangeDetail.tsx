import { useState } from "react";

import { Alert, Button, Checkbox, NumberInput, TextInput } from "@mantine/core";
import { Link } from "@tanstack/react-router";

import { DisclosureSection } from "@components/DisclosureSection";
import { triggerBlobDownload } from "@components/blobDownload";

import {
  DISCLOSURE_EXPORT_MIME,
  disclosureAccountingCsv,
  disclosureAccountingFileName,
  disclosureEntries,
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
import type { DisclosureAccounting } from "@psi/disclosureAccounting";
import type { DisclosureFact } from "./disclosureAccountingModel";

/**
 * The managed exchange detail sections composed onto the per-partnership home at
 * `/saved/$id` (below the run affordance in {@link ./ManagedRunSurface.tsx}): the
 * read-only configuration a compliance user inspects, the local-fields editor, the
 * run history, and the accounting of disclosures. Each is its own component so the
 * run surface stays the run affordance and these compose beside it; the derivations
 * and copy are the pure {@link ./managedDetailModel.ts}'s and
 * {@link ./disclosureAccountingModel.ts}'s.
 *
 * The agreed terms are read-only here -- fixed for this partnership; a change to
 * them is a new exchange, not an in-place edit ({@link ConfigurationView} says so
 * and offers the fast re-invite on the same terms) -- while the local fields edit
 * in place without touching the partnership ({@link LocalFieldsEditor}). The
 * accounting frames what it shows honestly as self-attested and links to the
 * existing verify page; it never claims a signed receipt.
 */
export function ManagedExchangeDetail({
  record,
  accounting,
  accountingUnreadable,
  onSaveLocalFields,
  onReinviteToChangeTerms,
  canReinvite,
  reinviting,
  reinviteFailed,
}: {
  record: ManagedExchangeRecord;
  /** This exchange's accounting of disclosures, read from its own sibling store;
   * `undefined` while it loads, when the exchange has never completed a run, or
   * when the read failed (which `accountingUnreadable` distinguishes). */
  accounting: DisclosureAccounting | undefined;
  /** Whether reading the accounting failed. Distinguished from an empty one so a
   * failed read can never render as "nothing was disclosed". */
  accountingUnreadable: boolean;
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
      <DisclosureAccountingView
        accounting={accounting}
        unreadable={accountingUnreadable}
      />
    </>
  );
}

/**
 * Render one read-only configuration row: a term and its value, its value list,
 * or its muted empty state.
 *
 * A value list renders one entry per item, never joined: every list this view
 * carries holds partner- or operator-authored names, and a name containing the
 * separator would read as two entries in joined text. Keyed by index because a
 * name is not unique across entries and the derivation's order is fixed.
 *
 * A caveat wraps onto its own line below the value rather than sitting beside it,
 * so the reader meets the value and its qualification in that order. It carries
 * this app's own fixed copy, on the same footing as the row's label and its empty
 * state; a value somebody else chose reaches the row through the display-boundary
 * fields instead.
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
 * The run history: what the most recent run DID, whether or not it completed. The
 * record's own bookkeeping keeps only that one run (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, the `lastRun` row), which is why this
 * section is scoped to it and says so; the disclosures of every completed run are
 * the accounting below, which a run that failed before disclosing never enters. A
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

/** One disclosure fact as a configuration row, so a disclosure renders in the same
 * voice as the agreed terms above it: its values when it carries any, its named
 * empty state when it does not. */
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
 * The accounting of disclosures: one entry per completed run, each read off that
 * run's own self-attested exchange record (see docs/spec/EXCHANGE_RECORD.md), plus
 * the CSV a compliance reader is handed. The entries are the records themselves
 * rather than a summary beside them, so this surface has no facts of its own to
 * drift from the artifact.
 *
 * A failed read renders as its own state, never as an empty accounting: "nothing
 * was disclosed" is a claim, and this surface must not make it on a read it could
 * not perform. The footer drops its export offer in that state for the same
 * reason it renders no export button there -- there is nothing to export from a
 * read that failed. Each entry starts collapsed behind its date and partner, so a
 * long history stays scannable and the reader opens the run they came for.
 *
 * Every count and empty state here speaks for THIS browser's copy and says so: the
 * export/import artifact migrates the runnable exchange without its accounting
 * (see {@link ../psi/managedExchangeStore.ts}), so a device that imported one
 * starts an accounting of its own. An unqualified "this exchange has disclosed
 * nothing" would read there as the partnership's whole disclosure history.
 */
function DisclosureAccountingView({
  accounting,
  unreadable,
}: {
  accounting: DisclosureAccounting | undefined;
  unreadable: boolean;
}) {
  const [openedNonce, setOpenedNonce] = useState<string>();
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
      {unreadable ? (
        <Alert color="red" title="This accounting could not be read">
          The disclosure records stored for this exchange could not be read, so
          they are not shown. This does not mean nothing was disclosed. An app
          upgrade can leave a stored accounting unreadable to this version of
          the app, and there is no export of it from here. What remains is any
          record file you downloaded yourself when a run finished; a run that
          finished unattended left none.
        </Alert>
      ) : entries.length === 0 ? (
        <p className={styles.small}>
          No run of this exchange has completed in this browser, so this
          browser&apos;s copy of the accounting is empty. That is not
          necessarily the exchange&apos;s whole history: an exchange imported
          from a backup file arrives without the accounting kept on the device
          it came from. Each run this browser completes will file its record
          here.
        </p>
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
        {!unreadable && entries.length > 0 && (
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
