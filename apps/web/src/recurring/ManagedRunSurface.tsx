import { useEffect, useRef, useState } from "react";

import { Alert, Button, CopyButton, FileButton, Loader } from "@mantine/core";
import { Link, useNavigate } from "@tanstack/react-router";

import { triggerBlobDownload } from "@components/blobDownload";
import { useOnlineStatus } from "@components/useOnlineStatus";

import {
  COMPROMISE_RESPONSE_MESSAGE,
  COMPROMISE_RESPONSE_TITLE,
  composeManagedFailureConfirmation,
  routeConfirmationReply,
} from "@psi/managed/managedFailureConfirmation";
import {
  ManagedHandoffRefusedError,
  dispatchManagedMigration,
  exportManagedBackup,
} from "@psi/managed/managedExchangeExport";
import {
  getManagedExchange,
  readRecordAndMarkBackedUp,
  spendManagedExchangeIfCurrent,
  updateManagedExchangeLocalFields,
} from "@psi/managed/managedExchangeStore";
import {
  readDisclosureAccounting,
  resetDisclosureAccounting,
} from "@psi/disclosureAccountingStore";
import { MANAGED_EXCHANGE_ARTIFACT_MIME } from "@psi/managed/managedExchangeArtifact";
import { canReinviteFromRecord } from "@psi/managed/managedReinvite";
import { deriveManagedBackupState } from "@psi/managed/managedBackupState";
import { getManagedLocalState } from "@psi/managed/managedLocalState";
import { managedRerunCompletion } from "@psi/managed/managedCompletionSurface";
import { reinviteManagedExchange } from "@psi/managed/managedReinviteDriver";
import { runManagedExchangeInBrowser } from "@psi/managed/managedRunDriver";
import { storedInputHandleUsable } from "@psi/managed/managedInputHandle";
import { whenDiagnostic } from "@utils/diagnostics";

import { dateLabel, dateTimeLabel } from "@psi/formatting";
import { OFFLINE_EXCHANGE_REASON } from "@psi/offlineExchangeGate";
import { appendSanitizedRunWarning } from "@psi/runWarnings";

import {
  CopyRow,
  DonePanel,
  RunDownloads,
  RunWarningsAlert,
} from "@exchange/RunSurface";
import { AppPage } from "@components/AppPage";
import styles from "@styles/app.module.css";
import { useBeforeUnloadPrompt } from "@exchange/useUnloadGuard";

import {
  MANAGED_RUN_HANDED_OFF_ATTESTATION,
  classifyManagedRunFailure,
  managedReinviteRecoveryCopy,
  managedRunReinvites,
  managedRunRetryable,
} from "./managedRunLaunchModel";
import {
  RECORD_GONE_HANDOFF_REASON,
  RECORD_GONE_HANDOFF_TITLE,
  RUN_IN_FLIGHT_HANDOFF_REASON,
  RUN_IN_FLIGHT_HANDOFF_TITLE,
  SUPERSEDED_HANDOFF_TITLE,
  supersededHandoffReason,
} from "./managedHandoffGate";
import { DeleteExchangeButton } from "./SavedExchanges";
import { ManagedCronExportPanel } from "./ManagedCronExportPanel";
import { ManagedExchangeDetail } from "./ManagedExchangeDetail";
import { useManagedRunInFlight } from "./useManagedRunInFlight";

import type { Ref } from "react";

import type {
  ManagedExchangeLocalEdits,
  ManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type {
  ManagedHandoffRefusal,
  ManagedMigrationDispatch,
} from "@psi/managed/managedExchangeExport";
import type { DisclosureAccountingRead } from "@psi/disclosureAccountingStore";
import type { ManagedBackupMarker } from "@psi/managed/managedBackupState";
import type { ManagedInputSource } from "@psi/managed/managedInputHandle";
import type { ManagedReinvite } from "@psi/managed/managedReinvite";
import type { ManagedRunFailureAlert } from "./managedRunLaunchModel";
import type { ManagedSpentState } from "@psi/managed/managedLocalState";
import type { RunOutputs } from "@psi/runOutputs";

/**
 * The attended re-run surface: open a stored managed exchange, confirm the input,
 * and run -- reconnecting to the partner without a new invitation and completing
 * through the durable rotate-and-persist path. The pure run orchestration is
 * {@link runManagedExchangeInBrowser}; this thin host owns the record load, the
 * per-run input (the persisted handle, or a re-selection where none is held), and
 * folds the outcome into the completion surface.
 *
 * It is the run affordance only, not the management surface -- deleting,
 * editing, and per-exchange detail are separate items.
 */
export function ManagedRunSurface({ id }: { id: string }) {
  const [record, setRecord] = useState<ManagedExchangeRecord>();
  // Three load states, each with its own recovery: MISSING (the store resolves
  // undefined -- deleted or cleared); UNLOADABLE (the read rejects: a stored record
  // this app version can no longer load, the documented app-upgrade case, whose
  // recovery is re-invite -- see docs/spec/MANAGED_EXCHANGE_RECORD.md, "Versioning");
  // and SPENT (an export handed this device's copy off, so it has no Run affordance,
  // and what runs in its place depends on which export did it). Spent is a load
  // state, not a disabled button: no code path from a spent record reaches the run
  // controls or run(). A run refused by the hand-off it met inside the run+rotate
  // lock moves into that same state directly, rather than waiting for the next load.
  const [loadFailure, setLoadFailure] = useState<
    "missing" | "unloadable" | "spent"
  >();
  // The stored spent state behind that load state, held whole: its date and the
  // hand-off that wrote it are what the spent surface reads, and a migration's
  // recovery (import the artifact back) is not a command-line hand-off's.
  const [spent, setSpent] = useState<ManagedSpentState>();
  // Whether the spent state above was reached by a run this surface started and the
  // hand-off refused, rather than by a load that found it standing: only then does
  // the spent surface owe the operator an account of that run.
  const [spentByRefusedRun, setSpentByRefusedRun] = useState(false);
  const [backupMarker, setBackupMarker] = useState<ManagedBackupMarker>();
  // This exchange's accounting of disclosures as its own read classified it, one
  // value rather than an accounting beside flags: an unreadable accounting must
  // not render as an empty one (which would be treated as "nothing was disclosed"), and
  // a store that did not answer must not render as either. `undefined` while the
  // read is in flight.
  const [accountingRead, setAccountingRead] =
    useState<DisclosureAccountingRead>();
  // Bumped to re-read the accounting: after a reset, so the surface shows what the
  // store actually holds rather than assuming the delete took, and on an explicit
  // retry of a read that never reached the store.
  const [accountingReads, setAccountingReads] = useState(0);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);
  // A hand-off the store refused, and which refusal it was: a run held the
  // run+rotate lock at the click, a run rotated past the artifact this screen
  // downloaded, or the record is gone from this browser entirely. Its own state,
  // not exportFailed, because none of the three is an error tier.
  const [migrationRefusal, setMigrationRefusal] =
    useState<ManagedHandoffRefusal>();
  // A dispatched migration whose download fired but whose spend awaits the operator
  // attesting "the file is saved"; a dismissed save leaves the source live.
  const [migrationDispatch, setMigrationDispatch] =
    useState<ManagedMigrationDispatch>();
  const [migrated, setMigrated] = useState(false);
  // The invocation a confirmed command-line export handed over, present once this
  // browser's copy is spent that way: like a migration, the record no longer runs
  // here, and the surface names what runs in its place.
  const [commandLineHandoff, setCommandLineHandoff] = useState<string>();
  const [reselected, setReselected] = useState<File>();
  const [running, setRunning] = useState(false);
  // The record, its detail, and the backup affordances all read the browser's own
  // store and render offline; a run is a live two-party session and cannot. Gating
  // the action names that rather than letting the operator press it into an opaque
  // connection failure. Only the offline direction is gated -- being online is no
  // promise the partner is there (see @utils/networkStatus).
  const online = useOnlineStatus();
  // Every hand-off affordance on this surface reads one in-flight signal, which sees
  // a run started anywhere in this browser profile -- here, in a second tab, or by
  // the scheduled runtime -- not just the one this surface started.
  const { inFlight: runInFlight, recheckLock } = useManagedRunInFlight(
    id,
    running,
  );
  // A run holds the migration back: the polled reading, or the spend's own refusal
  // at a click the poll's last reading was too old to hold back.
  const runHoldsMigration = runInFlight || migrationRefusal === "run-in-flight";
  // The refusals no retry can clear -- the downloaded artifact is out of date, or
  // the record it came from is gone -- as against the run one, which ends with the
  // run.
  const staleMigration =
    migrationRefusal !== undefined && migrationRefusal !== "run-in-flight";
  const [outputs, setOutputs] = useState<RunOutputs>();
  const [finishedAt, setFinishedAt] = useState<Date>();
  // This holds alert copy alone: the hand-off state has no copy of its own and
  // never lands here, because reaching it moves the surface to the spent state below.
  const [failure, setFailure] = useState<ManagedRunFailureAlert>();
  // The run's non-fatal notices, in arrival order. The driver raises one only for
  // a run that produced its outputs, and its close resolves after those outputs
  // reach here, so a notice lands on the completion surface beside the results.
  const [runWarnings, setRunWarnings] = useState<ReadonlyArray<string>>([]);
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
  // Which entry point triggered the in-flight (or last) re-invite: the failure-path
  // recovery near the top, or the detail configuration section far below. The failed
  // alert renders only at the triggering site (so the two on-screen sites do not both
  // show it), and a detail-triggered mint scrolls its result panel into view.
  const [reinviteSource, setReinviteSource] = useState<"recovery" | "detail">();

  // A single AbortController per in-flight run, aborted on unmount so a torn-down
  // surface stops the rendezvous, the connection, and the exchange.
  const abortRef = useRef<AbortController | undefined>(undefined);
  // The re-invite result panel, scrolled into view when the detail section (far below
  // the panel) triggered the mint, so the operator lands on the artifacts they need.
  const reinvitePanelRef = useRef<HTMLDivElement | null>(null);

  const navigate = useNavigate();

  // A run is a live two-party session with no resumption: an unload ends it, the
  // partner's side fails with it, and nothing else on the page intercepts one.
  // The app-shell update notice renders above every route, so its Reload button
  // is reachable throughout a run -- this is what puts the browser's own
  // confirmation in front of it, and in front of a tab close or a typed URL.
  useBeforeUnloadPrompt(running);

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
          setSpent(local.spent);
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

  // The accounting of disclosures is read on its own, never folded into the record
  // load above: an unreadable accounting must not present the exchange as
  // unloadable, and an unloadable record must not hide a readable accounting.
  // Keyed on the completion instant as well as the id, so the entry a finished run
  // just filed is read back without a reload. The read is total (see
  // {@link readDisclosureAccounting}), so what lands here is a classified state to
  // render rather than an error to interpret -- in particular, a store that did
  // not open is its own transient state, not the destructive-recovery one.
  useEffect(() => {
    let live = true;
    void readDisclosureAccounting(id)
      .then((read) => {
        if (live) setAccountingRead(read);
      })
      // The read classifies every failure rather than rejecting, so this is the
      // safety check for that contract lapsing rather than a second failure path.
      // Unavailable is the safe landing: it claims nothing about what is stored
      // and offers no destructive arm, where an unhandled rejection would strand
      // the section on its spinner.
      .catch(() => {
        if (live) setAccountingRead({ kind: "unavailable" });
      });
    return () => {
      live = false;
    };
  }, [id, finishedAt, accountingReads]);

  // Revoke the run's object URLs when they are replaced or the surface unmounts:
  // the results blob is matched-record PII and the keys blob is private material.
  useEffect(() => {
    if (outputs === undefined) return;
    return () => {
      if (outputs.kind === "matched")
        window.URL.revokeObjectURL(outputs.resultsUrl);
      if (outputs.record !== undefined) {
        window.URL.revokeObjectURL(outputs.record.recordUrl);
        window.URL.revokeObjectURL(outputs.record.keysUrl);
      }
    };
  }, [outputs]);

  // The ReinvitePanel renders near the top of the surface; the detail section that
  // can trigger it is far below, so a detail-triggered mint would land the result
  // off-screen. Scroll it into view once it renders for the detail source. The
  // failure-path recovery already renders where that user is looking, so it is left
  // alone.
  useEffect(() => {
    if (
      reinvite !== undefined &&
      reinviteSource === "detail" &&
      reinvitePanelRef.current !== null
    )
      reinvitePanelRef.current.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
  }, [reinvite, reinviteSource]);

  // With a usable pointer the run reads through it (attended, so a gone permission
  // may be re-prompted once); otherwise the operator re-selects the file each run.
  const hasHandle = storedInputHandleUsable(record?.inputFileHandle);

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
    setRunWarnings([]);
    setConfirmationGated(false);
    setCompromiseResponse(false);
    setReinvite(undefined);
    setReinviteFailed(false);
    // This run's phase boundary, read by the failure classification below: a state
    // whose copy says nothing left this device is only accurate before it, and the
    // record's own bookkeeping cannot stand in (its write is best-effort, and the
    // fallback path below classifies against a pre-run record). Local to this run,
    // not React state -- nothing renders from it, and a later run starts fresh.
    let dataExchangeStarted = false;
    void (async () => {
      // The record the store holds at this launch, read before the run so this
      // run's own bookkeeping stamp cannot be in it. A rejected read, or one that
      // finds no record, leaves the surface's held record standing in for this run.
      let launched = record;
      try {
        launched =
          (await getManagedExchange(record.id).catch(() => undefined)) ??
          record;
        if (controller.signal.aborted) return;
        const result = await runManagedExchangeInBrowser({
          record: launched,
          source,
          signal: controller.signal,
          urls: {
            create: (blob) => window.URL.createObjectURL(blob),
            revoke: (url) => window.URL.revokeObjectURL(url),
          },
          // Attended: fail fast when a run is already in progress elsewhere,
          // surfacing the benign "already running" state rather than waiting.
          options: {
            lock: { ifAvailable: true },
            onDataExchangeStart: () => {
              dataExchangeStarted = true;
            },
          },
          onWarning: (message) =>
            setRunWarnings((current) =>
              appendSanitizedRunWarning(current, message),
            ),
        });
        // The run can resolve after the surface unmounts; the getter can flip true
        // across the await even though the launch check above narrowed it (ESLint
        // models the getter as a literal, hence the disable).
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (controller.signal.aborted) return;
        setOutputs(result.exchange);
        setFinishedAt(new Date());
      } catch (error) {
        if (controller.signal.aborted) return;
        // The raw error can embed partner-/server-controlled bytes and displays as an
        // internal message, so it stays in the dev-gated console; the surface shows
        // the classified, sanitized copy.
        whenDiagnostic(() => console.error(error));
        // The tier is derived from the record's OWN bookkeeping, which the run path
        // just stamped (the auth/transport/storage/input/consent/cancelled
        // failureKind), so the record and its import marker are reloaded before
        // classifying -- an unattended run's failure would show through the same
        // tiers at the next visit. A corrupted record or sibling entry makes the
        // reload reject (a ZodError); rather than skip setFailure entirely (spinner
        // clears, no error UI, unhandled rejection), fall back to the launch
        // reading and no sibling state, so the original error still shows
        // through the generic tier.
        //
        // The classification also gets the record as the store held it at this
        // launch, read before the run so this run's own stamp is not in it. A
        // no-show's stamp replaces `lastRun` and has no failureKind, so the
        // reloaded record alone cannot say whether a standing desync signal was
        // there to outrank the benign no-show reading.
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
        const failed = classifyManagedRunFailure(
          error,
          { atLaunch: launched, afterRun: reloaded ?? launched },
          local,
          Date.now(),
          dataExchangeStarted,
        );
        // A run the hand-off refused moves the surface into the spent state here,
        // rather than leaving the run controls standing over a copy this device no
        // longer owns until the operator reloads. It is taken from the CLASSIFIED
        // state rather than the raw error, so the phase-boundary guard the
        // classification holds decides it: a refusal that somehow arrived past
        // the first peer-visible payload is not this benign state and keeps the
        // generic failure surface. The reload beside it supplies the date and the
        // hand-off the spent surface names, and a reload that did not answer costs
        // those and not the state.
        if (failed.kind === "handed-off") {
          setSpent(local?.spent);
          setSpentByRefusedRun(true);
          setLoadFailure("spent");
          return;
        }
        setFailure(failed);
      } finally {
        if (!controller.signal.aborted) setRunning(false);
        abortRef.current = undefined;
      }
    })();
  }

  const downloadArtifact = (fileName: string, content: string) =>
    triggerBlobDownload(fileName, content, MANAGED_EXCHANGE_ARTIFACT_MIME);

  // The two artifact exports read the record fresh from the store and mark it in one
  // atomic step (readRecordAndMarkBackedUp), so a mount-time React snapshot -- with a
  // pre-rotation secret -- is never what an export serializes or the marker attests.
  const exportDeps = {
    readAndMark: readRecordAndMarkBackedUp,
    download: downloadArtifact,
    now: () => new Date(),
  };

  // A backup export leaves the source live; a migration export hands the secret off
  // and spends this device's copy -- but only once the operator attests the file is
  // saved (a dismissed save leaves the source live). Both read the current record and
  // mark backed-up atomically, so the source displays green after a backup and a spent
  // copy holds a current artifact -- the ordering managedExchangeExport.test.ts
  // drives, marking before a spend is possible and refusing a superseded artifact.
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

  // Dispatching mid-run only manufactures an artifact the confirmation will refuse:
  // the run rotates past it before the operator can attest to it.
  function migrate() {
    if (record === undefined || exportBusy || runInFlight) return;
    setExportBusy(true);
    setExportFailed(false);
    setMigrationRefusal(undefined);
    void dispatchManagedMigration(record.id, {
      ...exportDeps,
      spendIfCurrent: spendManagedExchangeIfCurrent,
    })
      .then((dispatch) => {
        setBackupMarker({ backedUpAt: dispatch.backedUpAt.toISOString() });
        setMigrationDispatch(dispatch);
      })
      .catch(() => setExportFailed(true))
      .finally(() => setExportBusy(false));
  }

  // The operator attested the downloaded migration file is saved: spend the source
  // (this device's copy transitions to the spent load state on the next visit). The
  // spend itself refuses a run in flight and an artifact the record has rotated
  // past, so this classifies those refusals rather than guarding against them.
  function confirmMigration() {
    const dispatch = migrationDispatch;
    if (dispatch === undefined || exportBusy || runInFlight || staleMigration)
      return;
    setExportBusy(true);
    setExportFailed(false);
    setMigrationRefusal(undefined);
    void (async () => {
      try {
        // The gate above renders from a poll, so a run started since the last
        // reading is still news here; re-reading also puts the reason on screen.
        // A run this reading still misses is refused by the spend itself, which
        // takes the run's own lock.
        if (await recheckLock()) return;
        await dispatch.confirm(new Date());
        setMigrationDispatch(undefined);
        setMigrated(true);
      } catch (error) {
        if (error instanceof ManagedHandoffRefusedError)
          setMigrationRefusal(error.refusal);
        else setExportFailed(true);
      } finally {
        setExportBusy(false);
      }
    })();
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
  // state, so a failed export shows without claiming the backup was taken.
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
  // consumed failure shows "fresh invitation sent" rather than the recovered tier.
  function reinviteNow(source: "recovery" | "detail") {
    if (record === undefined || reinviting) return;
    setReinviteSource(source);
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
    if (record !== undefined && canReinviteFromRecord(record))
      reinviteNow("recovery");
  }

  // Persist an in-place edit to the local fields (label, max-token-age policy)
  // through the single-transaction store path, then adopt the returned record so
  // the surface reflects the edit -- including the conservatively re-derived
  // `expires` an age-policy edit produces. The detail editor shows the failure;
  // rethrowing keeps its form and its "not saved" message accurate.
  async function saveLocalFields(
    edits: ManagedExchangeLocalEdits,
  ): Promise<void> {
    if (record === undefined) return;
    const updated = await updateManagedExchangeLocalFields(record.id, edits);
    setRecord(updated);
  }

  // Queue a fresh read of the accounting, dropping the standing verdict as it
  // goes: the section returns to its in-flight state rather than rendering the
  // previous verdict and its buttons under a click that has already been taken --
  // which displays as an inert control, beside an irreversible one.
  function readAccountingAgain(): void {
    setAccountingRead(undefined);
    setAccountingReads((reads) => reads + 1);
  }

  // Destroy the accounting this build cannot read, then re-read it: the surface
  // shows what the store holds afterwards, so a delete that did not take leaves
  // the unreadable state standing rather than a stale empty one.
  async function resetAccounting(): Promise<void> {
    await resetDisclosureAccounting(id);
    readAccountingAgain();
  }

  // Read the accounting again after a read that never reached the store. It is
  // offered instead of asking for a page reload because a reload ends a run in
  // progress, while the blocked-open condition this recovers from clears on its
  // own as soon as the other tab's connection yields.
  function retryAccountingRead(): void {
    readAccountingAgain();
  }

  return (
    <AppPage>
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
          <SpentSurface spent={spent} refusedRun={spentByRefusedRun} />
        ) : record === undefined ? (
          <>
            <h1>Loading exchange</h1>
            <Loader />
          </>
        ) : outputs !== undefined ? (
          <>
            <h1>Run complete</h1>
            <DonePanel outputs={outputs} finishedAt={finishedAt} />
            <RunWarningsAlert warnings={runWarnings} />
            <RunDownloads outputs={outputs} />
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
                  <Alert color="red" title="Could not save the backup" mb="sm">
                    Nothing changed here; try again.
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
        ) : commandLineHandoff !== undefined ? (
          <>
            <h1>Handed off to the command line</h1>
            <p className={styles.sub}>
              You exported this exchange&apos;s psilink.yaml and .psilink.key,
              so it no longer runs here. Run it on the machine you saved them
              to:
            </p>
            <p className={styles.mono}>{commandLineHandoff}</p>
            <p className={styles.small}>
              Those two files are this exchange&apos;s backup of record. Keep
              them somewhere only you can read.
            </p>
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
              <Alert
                color="red"
                title="Could not hand off this exchange"
                mb="md"
              >
                This device&apos;s copy could not be handed off. It is still
                live here; try again.
              </Alert>
            )}
            <p className={styles.small}>
              Keep the file somewhere only you can read, and never send it over
              an unencrypted channel.
            </p>
            <p className={styles.small}>
              This exchange&apos;s accounting of disclosures stays on this
              device: it does not travel in the backup file. If you need to keep
              it, keep the exchange here for now, export the accounting as CSV,
              and then move it.
            </p>
            {runHoldsMigration && (
              <Alert color="yellow" title={RUN_IN_FLIGHT_HANDOFF_TITLE} mb="md">
                {RUN_IN_FLIGHT_HANDOFF_REASON}
              </Alert>
            )}
            {staleMigration && (
              <Alert
                color="yellow"
                title={
                  migrationRefusal === "record-gone"
                    ? RECORD_GONE_HANDOFF_TITLE
                    : SUPERSEDED_HANDOFF_TITLE
                }
                mb="md"
              >
                {migrationRefusal === "record-gone"
                  ? RECORD_GONE_HANDOFF_REASON
                  : supersededHandoffReason("migration")}
              </Alert>
            )}
            <p>
              <Button
                onClick={confirmMigration}
                loading={exportBusy}
                disabled={runInFlight || staleMigration}
              >
                I saved the file; hand off this exchange
              </Button>{" "}
              <Button
                variant="subtle"
                disabled={exportBusy}
                onClick={() => {
                  setMigrationDispatch(undefined);
                  setMigrationRefusal(undefined);
                }}
              >
                {migrationRefusal === "record-gone"
                  ? "Close"
                  : "Keep it on this device"}
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
              <ReinvitePanel
                record={record}
                reinvite={reinvite}
                panelRef={reinvitePanelRef}
              />
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
                    // The failed alert renders only at the site that triggered the
                    // mint, so the recovery and the detail section do not both show it.
                    reinviteFailed={
                      reinviteFailed && reinviteSource === "recovery"
                    }
                    onReinvite={() => reinviteNow("recovery")}
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
                disabled={inputSource() === undefined || !online}
              >
                Run exchange
              </Button>
            </p>
            {!online && (
              <p className={styles.sub}>
                {OFFLINE_EXCHANGE_REASON} Everything else here is available.
              </p>
            )}
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
              runInFlight={runInFlight}
              onBackUp={backUp}
              onMigrate={migrate}
            />
            <ManagedCronExportPanel
              record={record}
              runInFlight={runInFlight}
              recheckRunInFlight={recheckLock}
              onHandedOff={setCommandLineHandoff}
            />
            <ManagedExchangeDetail
              record={record}
              accountingRead={accountingRead}
              onResetAccounting={resetAccounting}
              onRetryAccountingRead={retryAccountingRead}
              onSaveLocalFields={saveLocalFields}
              onReinviteToChangeTerms={() => reinviteNow("detail")}
              canReinvite={canReinviteFromRecord(record)}
              reinviting={reinviting}
              // The failed alert renders here only when the detail section triggered
              // the mint, so it and the failure-path recovery do not both show it.
              reinviteFailed={reinviteFailed && reinviteSource === "detail"}
            />
            <div className={styles.workFoot}>
              <DeleteExchangeButton
                id={record.id}
                label={record.label}
                backedUp={
                  deriveManagedBackupState(backupMarker).kind === "backed-up"
                }
                onDeleted={() => void navigate({ to: "/saved" })}
              />
            </div>
            {failure !== undefined && !managedRunRetryable(failure) && (
              <SavedExchangesFoot />
            )}
          </>
        )}
      </main>
    </AppPage>
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
  failure: ManagedRunFailureAlert;
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
 * inviter side re-mints from the stored document, so it gets the mint action; the
 * acceptor side cannot mint an inviter-namespace invitation from its mirrored
 * perspective, so its recovery is to ask the partner to send a fresh invitation,
 * accept it, and delete the record that accept supersedes. Both readings are the pure
 * model's, composed from the record's own `side` ({@link managedReinviteRecoveryCopy});
 * this renders them. */
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
  const copy = managedReinviteRecoveryCopy(record);
  return (
    <div className={styles.callout}>
      <p className={styles.calloutLead}>{copy.lead}</p>
      {copy.body.map((paragraph) => (
        <p key={paragraph} className={styles.small}>
          {paragraph}
        </p>
      ))}
      {canReinviteFromRecord(record) && (
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
          <Button mt="sm" onClick={onReinvite} loading={reinviting}>
            Create a fresh invitation
          </Button>
        </>
      )}
    </div>
  );
}

/** A forwardable, multi-paragraph message the operator must READ before sending: the
 * whole prose is shown in a visible, wrapped, readonly area with a copy action --
 * unlike {@link CopyRow}, which collapses a secret to a one-line head/tail preview. The
 * message has no secret (it interpolates only this record's own label and failure
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

/** The composed re-invite artifacts the operator forwards: the link and code holding
 * the fresh setup secret, and the accurate ongoing cost -- every re-invite puts a fresh
 * live secret on the out-of-band channel, so the confidentiality requirement is
 * ongoing, not one-time. */
function ReinvitePanel({
  record,
  reinvite,
  panelRef,
}: {
  record: ManagedExchangeRecord;
  reinvite: ManagedReinvite;
  /** Attached so a detail-triggered mint (which renders this panel far above the
   * button that fired it) can scroll it into view. */
  panelRef: Ref<HTMLDivElement>;
}) {
  return (
    <div className={styles.callout} ref={panelRef}>
      <p className={styles.calloutLead}>Send this fresh invitation.</p>
      <p className={styles.small}>
        Send this to your partner over your usual trusted channel (for example,
        secure email). It carries a new one-time secret, so treat it as
        confidential -- every re-invite puts a fresh secret on that channel, so
        it must stay trusted each time. Your partner accepts it by opening the
        link.
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
 * the actionable "Back up this exchange") plus the two export intents that download
 * the artifact this browser restores from. A backup export leaves this exchange live;
 * a migration export hands it off to another device, spending this copy. Both are
 * named against the command-line export below, whose two files this browser's import
 * does not accept, so the state this panel shows is about the restorable file alone.
 * The custody guidance matches the CLI key file's: the file is a plaintext credential
 * to keep under owner-only custody. */
function BackupPanel({
  marker,
  busy,
  failed,
  runInFlight,
  onBackUp,
  onMigrate,
}: {
  marker: ManagedBackupMarker | undefined;
  busy: boolean;
  failed: boolean;
  /** Whether a run of this exchange is in flight in any context. Only the migration
   * is withheld while it is: a backup leaves the source live, so taking one across a
   * rotation costs the operator nothing. */
  runInFlight: boolean;
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
        The backup file is the one this browser restores from: import it here to
        bring this exchange back. It holds this exchange&apos;s secret in plain
        text -- keep it somewhere only you can read, and never send it over an
        unencrypted channel.
      </p>
      {failed && (
        <Alert color="red" title="Could not save the backup" mb="sm">
          Nothing changed here; try again.
        </Alert>
      )}
      <Button mt="sm" variant="default" onClick={onBackUp} loading={busy}>
        Download a backup
      </Button>{" "}
      <Button
        mt="sm"
        variant="subtle"
        onClick={onMigrate}
        disabled={busy || runInFlight}
      >
        Move to another device
      </Button>
      {runInFlight && (
        <p className={styles.small}>{RUN_IN_FLIGHT_HANDOFF_REASON}</p>
      )}
    </div>
  );
}

/** The durable surface of a spent copy, read from the stored spent state on every
 * later visit -- so it must say what THAT hand-off left the operator with. A
 * migration copy is somewhere an import can bring back; a command-line hand-off
 * produced the CLI's two files, which the import flow does not accept, so the
 * exchange runs from those files and they are its backup of record.
 *
 * `spent` is undefined when the run-refusal transition reached this state without
 * the stored entry in hand: the reload behind it reads the record and the sibling
 * together, so either read rejecting costs both. That costs the hand-off's form
 * and its date, so the copy names neither -- naming one would send an operator
 * whose exchange went to the command line after a backup file that hand-off never
 * produced.
 *
 * `refusedRun` is set when this surface arrived here from a run the hand-off
 * refused rather than from a load, and adds that run's own account above the
 * durable copy: an operator who just pressed Run is owed what became of the run
 * they started, which the standing state cannot say. That account is the
 * hand-off tier's non-disclosure attestation, so its words are held beside the
 * gate resting on them ({@link MANAGED_RUN_HANDED_OFF_ATTESTATION}). */
function SpentSurface({
  spent,
  refusedRun = false,
}: {
  spent: ManagedSpentState | undefined;
  refusedRun?: boolean;
}) {
  const refused = refusedRun ? (
    <p className={styles.small}>{MANAGED_RUN_HANDED_OFF_ATTESTATION}</p>
  ) : null;
  if (spent === undefined)
    return (
      <>
        <h1>This exchange was handed off</h1>
        <p className={styles.sub}>
          This browser&apos;s copy of this exchange was handed off, so it no
          longer runs here. It runs where you handed it over to -- the device
          you moved it to, or the machine running it from the command line.
        </p>
        {refused}
        <SavedExchangesFoot />
      </>
    );
  const on = ` on ${dateLabel(new Date(spent.spentAt))}`;
  return spent.handoff === "command-line" ? (
    <>
      <h1>This exchange was handed off</h1>
      <p className={styles.sub}>
        You handed this exchange to the command line{on}, so it no longer runs
        here. It runs from the psilink.yaml and .psilink.key you saved, on the
        machine you saved them to.
      </p>
      {refused}
      <p className={styles.small}>
        Those two files are this exchange&apos;s backup of record. Keep them
        somewhere only you can read.
      </p>
      <SavedExchangesFoot />
    </>
  ) : (
    <>
      <h1>This exchange was handed off</h1>
      <p className={styles.sub}>
        You exported this exchange to take over on another device{on}, so it can
        no longer run here. Import the backup to run it on this device again.
      </p>
      {refused}
      <SavedExchangesFoot />
    </>
  );
}

/** The link back to the saved-exchanges list, shown at completion and on a
 * terminal (non-retryable) failure. */
function SavedExchangesFoot() {
  return (
    <div className={styles.workFoot}>
      <Button component={Link} to="/saved" variant="default">
        Back to recurring exchanges
      </Button>
    </div>
  );
}
