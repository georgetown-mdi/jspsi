import { useEffect, useRef, useState } from "react";

import { Alert, Button, FileButton, Loader } from "@mantine/core";
import { Link } from "@tanstack/react-router";

import { triggerBlobDownload } from "@components/blobDownload";

import {
  exportManagedBackup,
  exportManagedMigration,
} from "@psi/managedExchangeExport";
import {
  getManagedLocalState,
  markManagedExchangeBackedUp,
  markManagedExchangeSpent,
} from "@psi/managedLocalState";
import { MANAGED_EXCHANGE_ARTIFACT_MIME } from "@psi/managedExchangeArtifact";
import { deriveManagedBackupState } from "@psi/managedBackupState";
import { fileSystemAccessSupported } from "@psi/managedInputHandle";
import { getManagedExchange } from "@psi/managedExchangeStore";
import { managedRerunCompletion } from "@psi/managedCompletionSurface";
import { runManagedExchangeInBrowser } from "@psi/managedRunDriver";
import { whenDiagnostic } from "@utils/diagnostics";

import { DonePanel, DownloadRow, WithheldResultInset } from "./BenchRunSurface";
import {
  classifyManagedRunFailure,
  managedRunRetryable,
} from "./managedRunLaunchModel";
import { BenchPage } from "./BenchPage";
import { dateLabel } from "./inviterModel";
import styles from "./bench.module.css";

import type { ManagedBackupMarker } from "@psi/managedBackupState";
import type { ManagedExchangeRecord } from "@psi/managedExchangeRecord";
import type { ManagedInputSource } from "@psi/managedInputHandle";
import type { ManagedRunFailure } from "./managedRunLaunchModel";
import type { RunOutputs } from "./runOutputs";

/**
 * The attended re-run surface: open a stored managed exchange, confirm the input,
 * and run -- reconnecting to the partner without a new invitation and completing
 * through the durable rotate-and-persist path. The pure run orchestration is
 * {@link runManagedExchangeInBrowser}; this thin host owns the record load, the
 * per-run input (the persisted handle, or a re-selection where none is held), and
 * folds the outcome into the completion surface.
 *
 * Deliberately minimal: it is the run affordance, not the management surface.
 * Deleting, editing, and per-exchange detail are separate items.
 */
export function ManagedRunSurface({ id }: { id: string }) {
  const [record, setRecord] = useState<ManagedExchangeRecord>();
  // The load states with distinct recoveries: a MISSING record (the store resolves
  // undefined -- deleted or cleared); an UNLOADABLE one (the read rejects: a stored
  // record this app version can no longer load, the documented app-upgrade case,
  // whose recovery is re-invite -- see docs/spec/MANAGED_EXCHANGE_RECORD.md,
  // "Versioning"); and SPENT (a migration export handed this device's copy off, so
  // it has no Run affordance and revives only by importing the artifact back). Spent
  // is a load state, not a disabled button: no code path from a spent record reaches
  // the run controls or run(), the structural guard the migration invariant needs.
  const [loadFailure, setLoadFailure] = useState<
    "missing" | "unloadable" | "spent"
  >();
  const [spentAt, setSpentAt] = useState<string>();
  const [backupMarker, setBackupMarker] = useState<ManagedBackupMarker>();
  const [exportBusy, setExportBusy] = useState(false);
  const [migrated, setMigrated] = useState(false);
  const [reselected, setReselected] = useState<File>();
  const [running, setRunning] = useState(false);
  const [outputs, setOutputs] = useState<RunOutputs>();
  const [finishedAt, setFinishedAt] = useState<Date>();
  const [failure, setFailure] = useState<ManagedRunFailure>();

  // A single AbortController per in-flight run, aborted on unmount so a torn-down
  // surface stops the rendezvous, the connection, and the exchange.
  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    let live = true;
    Promise.all([getManagedExchange(id), getManagedLocalState(id)])
      .then(([loaded, local]) => {
        if (!live) return;
        if (loaded === undefined) {
          setLoadFailure("missing");
        } else if (local?.spent !== undefined) {
          // A spent record never reaches the run controls: the guard is the load
          // state, not a hidden button.
          setSpentAt(local.spent.spentAt);
          setLoadFailure("spent");
        } else {
          setBackupMarker(local?.backup);
          setRecord(loaded);
        }
      })
      .catch(() => {
        if (live) setLoadFailure("unloadable");
      });
    return () => {
      live = false;
      abortRef.current?.abort();
      abortRef.current = undefined;
    };
  }, [id]);

  // Revoke the run's object URLs when they are replaced or the surface unmounts:
  // the results blob is matched-record PII and the keys blob is private material.
  useEffect(() => {
    if (outputs === undefined) return;
    return () => {
      if (outputs.resultsUrl !== undefined)
        window.URL.revokeObjectURL(outputs.resultsUrl);
      if (outputs.record !== undefined) {
        window.URL.revokeObjectURL(outputs.record.recordUrl);
        window.URL.revokeObjectURL(outputs.record.keysUrl);
      }
    };
  }, [outputs]);

  // Where the File System Access API exists and the record holds a handle, the run
  // reads through it (attended, so a gone permission may be re-prompted once);
  // otherwise the operator re-selects the file each run.
  const hasHandle =
    record?.inputFileHandle !== undefined && fileSystemAccessSupported();

  function inputSource(): ManagedInputSource | undefined {
    if (record === undefined) return undefined;
    if (hasHandle)
      return {
        kind: "handle",
        handle: record.inputFileHandle as FileSystemFileHandle,
        attendance: "attended",
      };
    if (reselected !== undefined) return { kind: "file", file: reselected };
    return undefined;
  }

  function run() {
    const source = inputSource();
    if (record === undefined || source === undefined || running) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setFailure(undefined);
    void (async () => {
      try {
        const result = await runManagedExchangeInBrowser({
          record,
          source,
          signal: controller.signal,
          urls: {
            create: (blob) => window.URL.createObjectURL(blob),
            revoke: (url) => window.URL.revokeObjectURL(url),
          },
          // Attended: fail fast when a run is already in progress elsewhere,
          // surfacing the benign "already running" state rather than waiting.
          options: { lock: { ifAvailable: true } },
        });
        if (controller.signal.aborted) return;
        setOutputs(result.exchange);
        setFinishedAt(new Date());
      } catch (error) {
        if (controller.signal.aborted) return;
        // The raw error can embed partner-/server-controlled bytes and reads as an
        // internal message, so it stays in the dev-gated console; the surface shows
        // the classified, sanitized copy.
        whenDiagnostic(() => console.error(error));
        setFailure(classifyManagedRunFailure(error));
      } finally {
        if (!controller.signal.aborted) setRunning(false);
        abortRef.current = undefined;
      }
    })();
  }

  const downloadArtifact = (fileName: string, content: string) =>
    triggerBlobDownload(fileName, content, MANAGED_EXCHANGE_ARTIFACT_MIME);

  // A backup export leaves the source live; a migration export spends it (this
  // device's copy transitions to the spent load state on the next visit) and hands
  // the secret off. Both write a fresh backup marker, so the source reads green after
  // a backup and the spent copy carries a current artifact by construction.
  function backUp() {
    if (record === undefined || exportBusy) return;
    setExportBusy(true);
    void exportManagedBackup(record, {
      download: downloadArtifact,
      markBackedUp: markManagedExchangeBackedUp,
      now: () => new Date(),
    })
      .then(() => setBackupMarker({ backedUpAt: new Date().toISOString() }))
      .finally(() => setExportBusy(false));
  }

  function migrate() {
    if (record === undefined || exportBusy) return;
    setExportBusy(true);
    void exportManagedMigration(record, {
      download: downloadArtifact,
      markBackedUp: markManagedExchangeBackedUp,
      markSpent: markManagedExchangeSpent,
      now: () => new Date(),
    })
      .then(() => setMigrated(true))
      .finally(() => setExportBusy(false));
  }

  // The run just rotated the secret, so the previous backup is stale; the completion
  // surface offers "download updated backup", which exports the artifact and records
  // the backup marker (returning the exchange to green). The record used is the
  // just-run one; the export snapshots the rotated secret it now holds.
  const completion =
    record === undefined
      ? managedRerunCompletion()
      : managedRerunCompletion({
          downloadUpdatedBackup: () =>
            exportManagedBackup(record, {
              download: (fileName, content) =>
                triggerBlobDownload(
                  fileName,
                  content,
                  MANAGED_EXCHANGE_ARTIFACT_MIME,
                ),
              markBackedUp: markManagedExchangeBackedUp,
              now: () => new Date(),
            }),
        });

  return (
    <BenchPage>
      <main className={styles.lobby}>
        {loadFailure === "missing" ? (
          <>
            <h1>Exchange not found</h1>
            <p className={styles.sub}>
              This exchange&apos;s browser copy was not found. It may have been
              deleted or cleared.
            </p>
            <SavedExchangesFoot />
          </>
        ) : loadFailure === "unloadable" ? (
          <>
            <h1>This exchange cannot be loaded</h1>
            <p className={styles.sub}>
              This exchange&apos;s stored copy can no longer be loaded by this
              version of the app. Re-invite your partner to set up the exchange
              again.
            </p>
            <SavedExchangesFoot />
          </>
        ) : loadFailure === "spent" ? (
          <>
            <h1>This exchange was handed off</h1>
            <p className={styles.sub}>
              You exported this exchange to take over on another device
              {spentAt !== undefined
                ? ` on ${dateLabel(new Date(spentAt))}`
                : ""}
              , so it can no longer run here. Import the backup to run it on
              this device again, or delete it.
            </p>
            <SavedExchangesFoot />
          </>
        ) : record === undefined ? (
          <>
            <h1>Loading exchange</h1>
            <Loader />
          </>
        ) : outputs !== undefined ? (
          <>
            <h1>Run complete</h1>
            <DonePanel
              matchedRecordCount={outputs.matchedRecordCount}
              finishedAt={finishedAt}
            />
            {outputs.resultWithheld === true ? (
              <WithheldResultInset />
            ) : (
              <DownloadRow
                label="Download result"
                href={outputs.resultsUrl}
                fileName="results.csv"
              />
            )}
            {outputs.record !== undefined && (
              <>
                <DownloadRow
                  label="Download record (safe to share)"
                  href={outputs.record.recordUrl}
                  fileName={outputs.record.recordFileName}
                />
                <DownloadRow
                  label="Download verification keys"
                  caveat="keep private"
                  href={outputs.record.keysUrl}
                  fileName={outputs.record.keysFileName}
                />
              </>
            )}
            {completion.backupHook !== undefined && (
              <div className={styles.callout}>
                <p className={styles.calloutLead}>Back up this exchange.</p>
                <p className={styles.small}>
                  This run rotated the stored secret, so your previous backup is
                  now out of date. Download an updated backup to keep it
                  current.
                </p>
                <p className={styles.small}>
                  The backup file holds the exchange&apos;s secret in plain
                  text. Keep it somewhere only you can read, and never send it
                  over an unencrypted channel.
                </p>
                <Button
                  mt="sm"
                  onClick={() =>
                    void completion.backupHook?.downloadUpdatedBackup()
                  }
                >
                  Download updated backup
                </Button>
              </div>
            )}
            <SavedExchangesFoot />
          </>
        ) : migrated ? (
          <>
            <h1>Handed off to another device</h1>
            <p className={styles.sub}>
              You downloaded this exchange&apos;s backup to take over on another
              device, so it no longer runs here. Import that backup on the other
              device to run it there. Keep the file somewhere only you can read.
            </p>
            <SavedExchangesFoot />
          </>
        ) : (
          <>
            <h1>{record.label === "" ? "Run this exchange" : record.label}</h1>
            <p className={styles.sub}>
              Run this exchange again with the same partner, without a new
              invitation. Your partner must run their side at the same time.
            </p>
            {failure !== undefined && (
              <Alert color="red" title={failure.title} mb="md">
                <span style={{ whiteSpace: "pre-line" }}>
                  {failure.message}
                </span>
              </Alert>
            )}
            {!hasHandle && (
              <div className={styles.callout}>
                <p className={styles.calloutLead}>Choose your input file.</p>
                <p className={styles.small}>
                  This browser did not keep a pointer to your file, so choose it
                  for this run. Its contents are read in your browser and never
                  stored.
                </p>
                <FileButton
                  accept="text/csv,.csv"
                  onChange={(file) => file !== null && setReselected(file)}
                >
                  {(props) => (
                    <Button mt="sm" variant="default" {...props}>
                      {reselected === undefined
                        ? "Choose file"
                        : `Chosen: ${reselected.name}`}
                    </Button>
                  )}
                </FileButton>
              </div>
            )}
            <p>
              <Button
                onClick={run}
                loading={running}
                disabled={inputSource() === undefined}
              >
                Run exchange
              </Button>
            </p>
            {running && (
              <p className={styles.sub}>
                Connecting to your partner and running the exchange. Keep this
                tab open.
              </p>
            )}
            <BackupPanel
              marker={backupMarker}
              record={record}
              busy={exportBusy}
              onBackUp={backUp}
              onMigrate={migrate}
            />
            {failure !== undefined && !managedRunRetryable(failure) && (
              <SavedExchangesFoot />
            )}
          </>
        )}
      </main>
    </BenchPage>
  );
}

/** The pre-run backup panel: the derived backup state ("backed up as of <date>" or
 * the actionable "Back up this exchange") plus the two export intents. A backup
 * export leaves this exchange live; a migration export hands it off to another
 * device, spending this copy. The custody guidance matches the CLI key file's:
 * the file is a plaintext credential to keep under owner-only custody. */
function BackupPanel({
  marker,
  record,
  busy,
  onBackUp,
  onMigrate,
}: {
  marker: ManagedBackupMarker | undefined;
  record: ManagedExchangeRecord;
  busy: boolean;
  onBackUp: () => void;
  onMigrate: () => void;
}) {
  const state = deriveManagedBackupState(record, marker);
  return (
    <div className={styles.callout}>
      {state.kind === "backed-up" ? (
        <p className={`${styles.small} ${styles.statusLineOk}`}>
          Backed up as of {dateLabel(new Date(state.backedUpAt))}.
        </p>
      ) : (
        <p className={styles.calloutLead}>Back up this exchange.</p>
      )}
      <p className={styles.small}>
        The backup file holds this exchange&apos;s secret in plain text. Keep it
        somewhere only you can read, and never send it over an unencrypted
        channel.
      </p>
      <Button mt="sm" variant="default" onClick={onBackUp} loading={busy}>
        Download a backup
      </Button>{" "}
      <Button mt="sm" variant="subtle" onClick={onMigrate} disabled={busy}>
        Move to another device
      </Button>
    </div>
  );
}

/** The link back to the saved-exchanges list, shown at completion and on a
 * terminal (non-retryable) failure. */
function SavedExchangesFoot() {
  return (
    <div className={styles.workFoot}>
      <Button component={Link} to="/saved" variant="default">
        Back to saved exchanges
      </Button>
    </div>
  );
}
