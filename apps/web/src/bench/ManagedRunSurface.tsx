import { useEffect, useRef, useState } from "react";

import { Alert, Button, CopyButton, FileButton, Loader } from "@mantine/core";
import { Link } from "@tanstack/react-router";

import { triggerBlobDownload } from "@components/blobDownload";

import {
  COMPROMISE_RESPONSE_MESSAGE,
  COMPROMISE_RESPONSE_TITLE,
  composeManagedFailureConfirmation,
  routeConfirmationReply,
} from "@psi/managedFailureConfirmation";
import {
  dispatchManagedMigration,
  exportManagedBackup,
} from "@psi/managedExchangeExport";
import {
  getManagedExchange,
  readRecordAndMarkBackedUp,
} from "@psi/managedExchangeStore";
import {
  getManagedLocalState,
  markManagedExchangeSpent,
} from "@psi/managedLocalState";
import { MANAGED_EXCHANGE_ARTIFACT_MIME } from "@psi/managedExchangeArtifact";
import { canReinviteFromRecord } from "@psi/managedReinvite";
import { deriveManagedBackupState } from "@psi/managedBackupState";
import { fileSystemAccessSupported } from "@psi/managedInputHandle";
import { managedRerunCompletion } from "@psi/managedCompletionSurface";
import { reinviteManagedExchange } from "@psi/managedReinviteDriver";
import { runManagedExchangeInBrowser } from "@psi/managedRunDriver";
import { whenDiagnostic } from "@utils/diagnostics";

import {
  CopyRow,
  DonePanel,
  DownloadRow,
  WithheldResultInset,
} from "./BenchRunSurface";
import {
  classifyManagedRunFailure,
  managedRunReinvites,
  managedRunRetryable,
} from "./managedRunLaunchModel";
import { dateLabel, dateTimeLabel } from "./inviterModel";
import { BenchPage } from "./BenchPage";
import styles from "./bench.module.css";

import type { ManagedBackupMarker } from "@psi/managedBackupState";
import type { ManagedExchangeRecord } from "@psi/managedExchangeRecord";
import type { ManagedInputSource } from "@psi/managedInputHandle";
import type { ManagedMigrationDispatch } from "@psi/managedExchangeExport";
import type { ManagedReinvite } from "@psi/managedReinvite";
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
  const [exportFailed, setExportFailed] = useState(false);
  // A dispatched migration whose download fired but whose spend awaits the operator
  // attesting "the file is saved"; a dismissed save leaves the source live.
  const [migrationDispatch, setMigrationDispatch] =
    useState<ManagedMigrationDispatch>();
  const [migrated, setMigrated] = useState(false);
  const [reselected, setReselected] = useState<File>();
  const [running, setRunning] = useState(false);
  const [outputs, setOutputs] = useState<RunOutputs>();
  const [finishedAt, setFinishedAt] = useState<Date>();
  const [failure, setFailure] = useState<ManagedRunFailure>();
  // The Tier-2 confirmation gate: once the operator confirms a real partner-side
  // failure, the surface proceeds to re-invite; a "does not add up" reply routes to
  // the compromise-response copy instead.
  const [confirmationGated, setConfirmationGated] = useState(false);
  const [compromiseResponse, setCompromiseResponse] = useState(false);
  // A fresh re-invite the operator forwards out-of-band. Present once a re-invite is
  // composed and the fresh secret persisted onto the record.
  const [reinvite, setReinvite] = useState<ManagedReinvite>();
  const [reinviting, setReinviting] = useState(false);
  const [reinviteFailed, setReinviteFailed] = useState(false);

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
    setConfirmationGated(false);
    setCompromiseResponse(false);
    setReinvite(undefined);
    setReinviteFailed(false);
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
        // The tier is derived from the record's OWN bookkeeping, which the run path
        // just stamped (the auth/transport/input/storage failureKind), so the record
        // and its import marker are reloaded before classifying -- an unattended run's
        // failure would surface through the same tiers at the next visit. A corrupted
        // record or sibling entry makes the reload reject (a ZodError); rather than
        // skip setFailure entirely (spinner clears, no error UI, unhandled rejection),
        // fall back to the closure's own record and no sibling state, so the original
        // error still surfaces through the generic tier.
        const [reloaded, local] = await Promise.all([
          getManagedExchange(record.id),
          getManagedLocalState(record.id),
        ]).catch(() => {
          whenDiagnostic(() =>
            console.error("managed run failure reload failed"),
          );
          return [undefined, undefined] as const;
        });
        // The reload can resolve after the surface unmounts; the getter can flip true
        // across the await even though the earlier catch check narrowed it (ESLint
        // models the getter as a literal, hence the disable).
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (controller.signal.aborted) return;
        setFailure(
          classifyManagedRunFailure(
            error,
            reloaded ?? record,
            local,
            Date.now(),
          ),
        );
      } finally {
        if (!controller.signal.aborted) setRunning(false);
        abortRef.current = undefined;
      }
    })();
  }

  const downloadArtifact = (fileName: string, content: string) =>
    triggerBlobDownload(fileName, content, MANAGED_EXCHANGE_ARTIFACT_MIME);

  // Every export reads the record fresh from the store and marks it in one atomic
  // step (readRecordAndMarkBackedUp), so a mount-time React snapshot -- with a
  // pre-rotation secret -- is never what an export serializes or the marker attests.
  const exportDeps = {
    readAndMark: readRecordAndMarkBackedUp,
    download: downloadArtifact,
    now: () => new Date(),
  };

  // A backup export leaves the source live; a migration export hands the secret off
  // and spends this device's copy -- but only once the operator attests the file is
  // saved (a dismissed save leaves the source live). Both read the current record and
  // mark backed-up atomically, so the source reads green after a backup and a spent
  // copy carries a current artifact by construction.
  function backUp() {
    if (record === undefined || exportBusy) return;
    setExportBusy(true);
    setExportFailed(false);
    void exportManagedBackup(record.id, exportDeps)
      .then((result) =>
        setBackupMarker({ backedUpAt: result.backedUpAt.toISOString() }),
      )
      .catch(() => setExportFailed(true))
      .finally(() => setExportBusy(false));
  }

  function migrate() {
    if (record === undefined || exportBusy) return;
    setExportBusy(true);
    setExportFailed(false);
    void dispatchManagedMigration(record.id, {
      ...exportDeps,
      markSpent: markManagedExchangeSpent,
    })
      .then((dispatch) => {
        setBackupMarker({ backedUpAt: dispatch.backedUpAt.toISOString() });
        setMigrationDispatch(dispatch);
      })
      .catch(() => setExportFailed(true))
      .finally(() => setExportBusy(false));
  }

  // The operator attested the downloaded migration file is saved: spend the source
  // (this device's copy transitions to the spent load state on the next visit).
  function confirmMigration() {
    if (migrationDispatch === undefined || exportBusy) return;
    setExportBusy(true);
    setExportFailed(false);
    void migrationDispatch
      .confirm(new Date())
      .then(() => {
        setMigrationDispatch(undefined);
        setMigrated(true);
      })
      .catch(() => setExportFailed(true))
      .finally(() => setExportBusy(false));
  }

  // The run just rotated the secret, so the previous backup is stale; the completion
  // surface offers "download updated backup", which reads the just-rotated secret
  // fresh from the store and marks the backup current (returning the exchange to
  // green). It reads by id, never the mount-time React record, so it exports the
  // rotated secret the store now holds.
  const completion =
    record === undefined
      ? managedRerunCompletion()
      : managedRerunCompletion({
          downloadUpdatedBackup: () =>
            exportManagedBackup(record.id, exportDeps).then(() => undefined),
        });

  // Drive the completion surface's refreshed backup with the shared busy/failure
  // state, so a failed export surfaces without claiming the backup was taken.
  function downloadUpdatedBackup() {
    if (completion.backupHook === undefined || exportBusy) return;
    setExportBusy(true);
    setExportFailed(false);
    void completion.backupHook
      .downloadUpdatedBackup()
      .catch(() => setExportFailed(true))
      .finally(() => setExportBusy(false));
  }

  // Fast re-invite: compose a fresh invitation from the record's OWN document (terms
  // and locator), persist the fresh secret onto the record, and hand the operator the
  // shareable artifacts to forward out-of-band. The operator re-authors nothing. The
  // driver returns the rotated record; adopting it drops the stale in-memory secret so
  // a subsequent run derives the rendezvous from the fresh one, and clearing the
  // consumed failure surfaces "fresh invitation sent" rather than the recovered tier.
  function reinviteNow() {
    if (record === undefined || reinviting) return;
    setReinviting(true);
    setReinviteFailed(false);
    void reinviteManagedExchange(record)
      .then((result) => {
        setRecord(result.record);
        setFailure(undefined);
        setReinvite(result.reinvite);
      })
      .catch((error) => {
        whenDiagnostic(() => console.error(error));
        setReinviteFailed(true);
      })
      .finally(() => setReinviting(false));
  }

  // The two-outcome gate: a confirmed real partner-side failure proceeds to re-invite;
  // anything that does not add up routes to the compromise response (no quiet
  // re-invite on the possibly-compromised channel). The inviter side mints the fresh
  // invitation right away; the acceptor side cannot mint one from its mirrored
  // document, so the gated recovery names asking the partner instead.
  function resolveConfirmation(
    outcome: Parameters<typeof routeConfirmationReply>[0],
  ) {
    if (routeConfirmationReply(outcome) === "compromise-response") {
      setCompromiseResponse(true);
      return;
    }
    setConfirmationGated(true);
    if (record !== undefined && canReinviteFromRecord(record)) reinviteNow();
  }

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
              this device again.
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
                {exportFailed && (
                  <Alert
                    color="red"
                    title="That export could not be completed"
                    mb="sm"
                  >
                    The backup could not be saved. Nothing changed here; try
                    again.
                  </Alert>
                )}
                <Button
                  mt="sm"
                  onClick={downloadUpdatedBackup}
                  loading={exportBusy}
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
        ) : migrationDispatch !== undefined ? (
          <>
            <h1>Confirm the move</h1>
            <p className={styles.sub}>
              Your exchange&apos;s backup file was downloaded. Confirm you saved
              it before this device gives up its copy: once you confirm, this
              exchange no longer runs here and you import the file on the other
              device to run it there.
            </p>
            {exportFailed && (
              <Alert color="red" title="That could not be completed" mb="md">
                This device&apos;s copy could not be handed off. It is still
                live here; try again.
              </Alert>
            )}
            <p className={styles.small}>
              Keep the file somewhere only you can read, and never send it over
              an unencrypted channel.
            </p>
            <p>
              <Button onClick={confirmMigration} loading={exportBusy}>
                I saved the file; hand off this exchange
              </Button>{" "}
              <Button
                variant="subtle"
                disabled={exportBusy}
                onClick={() => setMigrationDispatch(undefined)}
              >
                Keep it on this device
              </Button>
            </p>
          </>
        ) : (
          <>
            <h1>{record.label === "" ? "Run this exchange" : record.label}</h1>
            <p className={styles.sub}>
              Run this exchange again with the same partner, without a new
              invitation. Your partner must run their side at the same time.
            </p>
            {reinvite !== undefined ? (
              // A re-invite has superseded the failure: the record is rotated to the
              // fresh secret and its consumed failure cleared, so the stale tier alert
              // and its recovery are gone -- the operator forwards the fresh invitation
              // and the next run derives from the new secret.
              <ReinvitePanel record={record} reinvite={reinvite} />
            ) : (
              failure !== undefined && (
                <>
                  <Alert color="red" title={failure.title} mb="md">
                    <span style={{ whiteSpace: "pre-line" }}>
                      {failure.message}
                    </span>
                  </Alert>
                  <FailureRecovery
                    failure={failure}
                    record={record}
                    confirmationGated={confirmationGated}
                    compromiseResponse={compromiseResponse}
                    reinviting={reinviting}
                    reinviteFailed={reinviteFailed}
                    onReinvite={reinviteNow}
                    onResolveConfirmation={resolveConfirmation}
                  />
                </>
              )
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
              busy={exportBusy}
              failed={exportFailed}
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

/** The recovery affordance a classified failure offers, below its alert: fast
 * re-invite for the re-invite tiers, the out-of-band confirmation and two-outcome gate
 * for the unexplained tier, and nothing extra for a retry/wait state (the run button
 * and the input picker are the recovery there). Thin over the pure model: the copy and
 * the routing are the model's; this renders the buttons. A composed re-invite renders
 * above this (the {@link ReinvitePanel}), so this never handles the minted artifacts. */
function FailureRecovery({
  failure,
  record,
  confirmationGated,
  compromiseResponse,
  reinviting,
  reinviteFailed,
  onReinvite,
  onResolveConfirmation,
}: {
  failure: ManagedRunFailure;
  record: ManagedExchangeRecord;
  confirmationGated: boolean;
  compromiseResponse: boolean;
  reinviting: boolean;
  reinviteFailed: boolean;
  onReinvite: () => void;
  onResolveConfirmation: (
    outcome: Parameters<typeof routeConfirmationReply>[0],
  ) => void;
}) {
  if (failure.recovery === "confirm") {
    if (compromiseResponse)
      return (
        <Alert color="red" title={COMPROMISE_RESPONSE_TITLE} mb="md">
          <span style={{ whiteSpace: "pre-line" }}>
            {COMPROMISE_RESPONSE_MESSAGE}
          </span>
        </Alert>
      );
    // Past the gate on a confirmed partner-side failure, the recovery is fast
    // re-invite -- the same panel a direct re-invite tier shows (which mints for the
    // inviter and names asking the partner for the acceptor, with a retry on failure).
    if (confirmationGated)
      return (
        <ReinviteRecovery
          record={record}
          reinviting={reinviting}
          reinviteFailed={reinviteFailed}
          onReinvite={onReinvite}
        />
      );
    return (
      <ConfirmationPanel record={record} onResolve={onResolveConfirmation} />
    );
  }

  if (managedRunReinvites(failure))
    return (
      <ReinviteRecovery
        record={record}
        reinviting={reinviting}
        reinviteFailed={reinviteFailed}
        onReinvite={onReinvite}
      />
    );

  return null;
}

/** The re-invite recovery for a re-invite tier (lapsed, storage, imported). The
 * inviter side re-mints from the stored document; the acceptor side cannot mint an
 * inviter-namespace invitation from its mirrored perspective, so its recovery is to
 * ask the partner to send a fresh invitation and accept it -- the surface names which,
 * from the record's own `side`. */
function ReinviteRecovery({
  record,
  reinviting,
  reinviteFailed,
  onReinvite,
}: {
  record: ManagedExchangeRecord;
  reinviting: boolean;
  reinviteFailed: boolean;
  onReinvite: () => void;
}) {
  if (!canReinviteFromRecord(record))
    return (
      <div className={styles.callout}>
        <p className={styles.calloutLead}>Ask your partner to re-invite.</p>
        <p className={styles.small}>
          Ask your partner to send you a fresh invitation for this exchange over
          your usual trusted channel, then accept it from the bench&apos;s home
          page. That re-establishes the connection with a new secret; your terms
          are unchanged.
        </p>
      </div>
    );
  return (
    <div className={styles.callout}>
      <p className={styles.calloutLead}>Re-invite your partner.</p>
      <p className={styles.small}>
        This keeps your agreed terms and only replaces the secret. The fresh
        invitation carries a new one-time secret, so send it over your usual
        trusted channel, exactly as you did the first time.
      </p>
      {reinviteFailed && (
        <Alert color="red" title="That could not be completed" mb="sm">
          The fresh invitation could not be created. Nothing changed here; try
          again.
        </Alert>
      )}
      <Button mt="sm" onClick={onReinvite} loading={reinviting}>
        Create a fresh invitation
      </Button>
    </div>
  );
}

/** A forwardable, multi-paragraph message the operator must READ before sending: the
 * whole prose is shown in a visible, wrapped, readonly area with a copy action --
 * unlike {@link CopyRow}, which collapses a secret to a one-line head/tail preview. The
 * message carries no secret (it interpolates only this record's own label and failure
 * time), so showing it in full is correct, not a leak. */
function ForwardableMessage({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className={styles.copyRow}>
      <span className={styles.copyLabel}>{label}</span>
      <textarea
        className={styles.forwardableMessage}
        readOnly
        value={value}
        aria-label={label}
        rows={value.split("\n").length}
      />
      {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        typeof navigator !== "undefined" && navigator.clipboard ? (
          <CopyButton value={value} timeout={1000}>
            {({ copied, copy }) => (
              <Button
                mt="sm"
                variant="default"
                onClick={copy}
                aria-label={
                  copied ? `${label} copied` : `Copy ${label.toLowerCase()}`
                }
              >
                {copied ? "Copied" : "Copy message"}
              </Button>
            )}
          </CopyButton>
        ) : null
      }
    </div>
  );
}

/** The Tier-2 out-of-band confirmation: the forwardable, pre-filled message the
 * operator copies and sends the partner, then the two-outcome gate. The message and
 * the gate labels are the pure model's; this renders them. */
function ConfirmationPanel({
  record,
  onResolve,
}: {
  record: ManagedExchangeRecord;
  onResolve: (outcome: Parameters<typeof routeConfirmationReply>[0]) => void;
}) {
  const confirmation = composeManagedFailureConfirmation(record);
  return (
    <div className={styles.callout}>
      <p className={styles.calloutLead}>Confirm with your partner first.</p>
      <p className={styles.small}>
        Copy this message and send it to your partner on the trusted channel you
        use for this partnership (not a reply to whatever arrived here). It asks
        them to confirm their identity, report what their own tool saw, and say
        whether they ran from more than one place.
      </p>
      <ForwardableMessage
        label="Message to your partner"
        value={confirmation.message}
      />
      <p className={styles.small} style={{ marginTop: "0.75rem" }}>
        When they reply:
      </p>
      <p>
        <Button onClick={() => onResolve("confirmed-partner-failure")}>
          {confirmation.confirmedOption}
        </Button>{" "}
        <Button
          color="red"
          variant="light"
          onClick={() => onResolve("does-not-add-up")}
        >
          {confirmation.doesNotAddUpOption}
        </Button>
      </p>
    </div>
  );
}

/** The composed re-invite artifacts the operator forwards: the link and code carrying
 * the fresh setup secret, and the honest ongoing cost -- every re-invite puts a fresh
 * live secret on the out-of-band channel, so the confidentiality requirement is
 * ongoing, not one-time. */
function ReinvitePanel({
  record,
  reinvite,
}: {
  record: ManagedExchangeRecord;
  reinvite: ManagedReinvite;
}) {
  return (
    <div className={styles.callout}>
      <p className={styles.calloutLead}>Send this fresh invitation.</p>
      <p className={styles.small}>
        Send this to your partner over your usual trusted channel (for example,
        secure email). It carries a new one-time secret, so treat it as
        confidential -- every re-invite puts a fresh secret on that channel, so
        it must stay trusted each time. Your partner accepts it from the
        bench&apos;s home page.
      </p>
      <CopyRow label="Invitation link" value={reinvite.deepLink} />
      <CopyRow label="Invitation code" value={reinvite.encoded} />
      <p className={styles.small}>
        <strong>
          This invitation expires{" "}
          <span className={styles.mono}>
            {dateTimeLabel(new Date(reinvite.tokenExpires))}
          </span>
          .
        </strong>{" "}
        {record.label === ""
          ? "The exchange keeps its terms."
          : `"${record.label}" keeps its terms.`}
      </p>
    </div>
  );
}

/** The pre-run backup panel: the derived backup state ("backed up as of <date>" or
 * the actionable "Back up this exchange") plus the two export intents. A backup
 * export leaves this exchange live; a migration export hands it off to another
 * device, spending this copy. The custody guidance matches the CLI key file's:
 * the file is a plaintext credential to keep under owner-only custody. */
function BackupPanel({
  marker,
  busy,
  failed,
  onBackUp,
  onMigrate,
}: {
  marker: ManagedBackupMarker | undefined;
  busy: boolean;
  failed: boolean;
  onBackUp: () => void;
  onMigrate: () => void;
}) {
  const state = deriveManagedBackupState(marker);
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
      {failed && (
        <Alert color="red" title="That export could not be completed" mb="sm">
          The backup could not be saved. Nothing changed here; try again.
        </Alert>
      )}
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
