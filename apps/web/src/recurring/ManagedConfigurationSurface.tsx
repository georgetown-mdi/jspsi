import { useMemo, useState } from "react";

import { Alert, Button, Checkbox, NumberInput, TextInput } from "@mantine/core";
import { Link } from "@tanstack/react-router";

import { CopyableCode } from "@components/CopyableCode";
import { DisclosureSection } from "@components/DisclosureSection";
import { triggerBlobDownload } from "@components/blobDownload";

import { updateManagedExchangeLocalFields } from "@psi/managed/managedExchangeStore";

import {
  LABEL_GUIDANCE,
  MAX_LABEL_LENGTH,
  MAX_TOKEN_MAX_AGE_DAYS,
  labelWithinCap,
  maxAgeDaysError,
} from "@exchange/manageOfferModel";
import { AppPage } from "@components/AppPage";
import styles from "@styles/app.module.css";

import {
  CLI_BUILT_IN_STUN_URI,
  managedConfigurationExportState,
} from "./managedCronExportModel";
import {
  SIDE_LABELS,
  connectionRows,
  linkageTermsRows,
} from "./managedDetailModel";
import { ConfigRowItem } from "./ManagedExchangeDetail";
import { DeleteExchangeButton } from "./SavedExchanges";

import type {
  ManagedExchangeLocalEdits,
  ManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";

/** The heading the surface leads with for an unnamed exchange. */
const UNNAMED_CONFIGURATION_TITLE = "Imported configuration";

/**
 * What this browser holds for a configuration-only exchange, and what it does
 * not. Stated once, at the top: the operator arrives here expecting the Run
 * control every other saved exchange offers, and the absent key file is why
 * there is none.
 */
const CONFIGURATION_ONLY_LEAD =
  "This exchange was imported from a command-line configuration, without the " +
  ".psilink.key file it runs under. Its settings are editable here and export " +
  "back to a psilink.yaml you run with psilink; it does not run in this " +
  "browser.";

/**
 * The per-exchange surface of a CONFIGURATION-ONLY record: the settings the
 * operator edits in a browser and the `psilink.yaml` they run on the command
 * line (docs/MANAGED_EXCHANGE.md, "Bringing a command-line configuration
 * back"). It is the whole of what such a record has -- no run, no backup, no
 * hand-off, no re-invite -- because the record holds no shared secret, and
 * nothing here can reach a path that needs one: {@link ManagedRunSurface} routes
 * a record to this surface exactly where the record's own shape withholds the
 * run (see `runnableManagedExchange`).
 *
 * The agreed terms are read-only, as they are for a browser-run exchange: they
 * are the partnership's, not this browser's, and exchanging on different ones is
 * a new exchange. The label and the max-age policy edit in place through the
 * same store path a browser-run exchange edits through.
 */
export function ManagedConfigurationSurface({
  record,
  onRecordEdited,
  onDeleted,
}: {
  record: ManagedExchangeRecord;
  /** Adopt the record the store returned after an edit, so what the surface
   * shows and what the next export composes are the stored record. */
  onRecordEdited: (record: ManagedExchangeRecord) => void;
  /** The exchange was deleted from this browser; the host navigates away. */
  onDeleted: () => void;
}) {
  return (
    <AppPage>
      <main className={styles.work}>
        <h1>
          {record.label === "" ? UNNAMED_CONFIGURATION_TITLE : record.label}
        </h1>
        <p className={styles.sub}>{CONFIGURATION_ONLY_LEAD}</p>
        <ConfigurationRows record={record} />
        <ConfigurationExportPanel record={record} />
        <ConfigurationSettingsEditor
          record={record}
          onRecordEdited={onRecordEdited}
        />
        <div className={styles.workFoot}>
          <DeleteExchangeButton
            id={record.id}
            label={record.label}
            backedUp={false}
            configurationOnly
            onDeleted={onDeleted}
          />
        </div>
        <p className={styles.small}>
          <Link to="/saved">Back to recurring exchanges</Link>
        </p>
      </main>
    </AppPage>
  );
}

/** The read-only view of what the imported configuration holds: this party's
 * side, the signaling endpoint, and the agreed linkage terms -- the same rows a
 * browser-run exchange shows, from the same derivations. */
function ConfigurationRows({ record }: { record: ManagedExchangeRecord }) {
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
        These agreed terms are fixed for this partnership and are not editable
        here. To exchange on different terms, agree them with your partner and
        set the exchange up again.
      </p>
    </div>
  );
}

/**
 * The export back to the command line: the `psilink.yaml` this browser composed
 * from the stored settings, and the invocation that runs it beside the
 * `.psilink.key` the operator already has. No key file and no hand-off
 * confirmation: nothing here was ever this browser's to hand over.
 *
 * The composed file is the mounted record's, which is the record the store
 * returned from the last edit on this surface. A configuration-only record
 * rotates nothing and runs nothing, so the only thing that moves it is an edit
 * -- this surface's own, or one made in another tab, which this page would show
 * as stale settings either way.
 */
function ConfigurationExportPanel({
  record,
}: {
  record: ManagedExchangeRecord;
}) {
  const [scheduleLinesOpen, setScheduleLinesOpen] = useState(false);
  const state = useMemo(
    () => managedConfigurationExportState(record),
    [record],
  );
  if (state.kind === "refused")
    return (
      <Alert
        color="red"
        title="This configuration cannot be exported"
        mt="sm"
        mb="sm"
      >
        {state.reason}
      </Alert>
    );
  const { composed, cronLine, taskSchedulerLine } = state;
  const configFile = composed.config;
  return (
    <div className={styles.callout}>
      <h2 className={styles.eyebrow}>Run it from the command line</h2>
      <p className={styles.small}>
        Download the configuration into the folder holding this exchange&apos;s{" "}
        <span className={styles.mono}>.psilink.key</span> and your input file,
        then run the command there. The file holds the agreed terms and the
        rendezvous address, and no secret.
      </p>
      <Button
        mt="sm"
        onClick={() =>
          triggerBlobDownload(
            configFile.fileName,
            configFile.text,
            configFile.mimeType,
          )
        }
      >
        Download {configFile.fileName}
      </Button>
      <p className={styles.small}>
        The command reads input.csv from the folder it runs in and writes
        results.csv beside it. Name your file to match, or change the names in
        the command.
      </p>
      <CopyableCode code={composed.command} ariaLabel="exchange command" />
      <DisclosureSection
        label="Schedule it (adjust the times and the folder)"
        open={scheduleLinesOpen}
        onToggle={setScheduleLinesOpen}
        headingOrder={3}
      >
        <p className={styles.small}>cron (Linux/macOS), daily at 2am:</p>
        <CopyableCode code={cronLine} ariaLabel="cron schedule line" />
        <p className={styles.small}>Windows Task Scheduler, daily at 2am:</p>
        <CopyableCode
          code={taskSchedulerLine}
          ariaLabel="Windows Task Scheduler command"
        />
        <p className={styles.small}>
          Both lines call psilink by name. Under cron&apos;s minimal PATH or a
          Task Scheduler service account it may not resolve, and fails quietly
          -- use the full path to the psilink binary, or put it on the
          scheduling account&apos;s PATH.
        </p>
      </DisclosureSection>
      <p className={`${styles.small} ${styles.sub}`}>
        This exchange names no STUN server, so every run uses the built-in
        default ({CLI_BUILT_IN_STUN_URI}) to discover the public address of the
        machine it runs on.
      </p>
    </div>
  );
}

/**
 * The settings that edit in place: the label this browser shows the exchange
 * under, and the max-age policy the exported configuration carries as
 * `authentication.token_max_age_days`. Both are written through the store's
 * single local-fields edit, the same one a browser-run exchange takes.
 *
 * The policy bounds a secret this record does not hold, so nothing here lapses
 * anything: what it sets is the bound the command-line run stamps onto the
 * secret it rotates.
 */
function ConfigurationSettingsEditor({
  record,
  onRecordEdited,
}: {
  record: ManagedExchangeRecord;
  onRecordEdited: (record: ManagedExchangeRecord) => void;
}) {
  const [label, setLabel] = useState(record.label);
  const [maxAgeEnabled, setMaxAgeEnabled] = useState(
    record.tokenMaxAgeDays !== undefined,
  );
  // Held as the NumberInput reports it (a string when cleared or mid-edit), so
  // an invalid state blocks the save rather than being coerced to a sentinel
  // that silently drops the opted-in bound.
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
  const labelValid = labelWithinCap(label);
  const canSave = labelValid && !saving && maxAgeError === undefined;

  function save() {
    if (!canSave) return;
    setSaving(true);
    setSaved(false);
    setFailed(false);
    const edits: ManagedExchangeLocalEdits = {
      label,
      tokenMaxAgeDays: maxAgeEnabled ? (tokenMaxAgeDays ?? null) : null,
    };
    void updateManagedExchangeLocalFields(record.id, edits)
      .then((updated) => {
        onRecordEdited(updated);
        setSaved(true);
      })
      .catch(() => setFailed(true))
      .finally(() => setSaving(false));
  }

  return (
    <div className={styles.callout}>
      <h2 className={styles.eyebrow}>Settings</h2>
      <p className={styles.small}>
        The label stays in this browser. The maximum age goes into the
        configuration you download, and the command-line run applies it.
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
        label="Set a maximum age for the exchange's secret"
        description="Off by default. When set, each command-line run stamps this age onto the secret it rotates, and the exchange must run again within it or you re-invite your partner."
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
      {failed && (
        <Alert color="red" title="That could not be saved" mt="sm" mb="sm">
          These settings were not saved. Nothing changed; try again.
        </Alert>
      )}
      {saved && !failed && (
        <p className={`${styles.small} ${styles.statusLineOk}`}>
          Settings saved. Download the configuration again to run with them.
        </p>
      )}
      <Button mt="sm" onClick={save} loading={saving} disabled={!canSave}>
        Save settings
      </Button>
    </div>
  );
}
