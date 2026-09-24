import { useCallback, useEffect, useRef, useState } from "react";

import {
  Alert,
  Button,
  CopyButton,
  FileButton,
  Loader,
  Modal,
} from "@mantine/core";
import { Link, useNavigate } from "@tanstack/react-router";

import { describeResolvedMatching } from "@alcove/core";

import { triggerBlobDownload } from "@components/blobDownload";
import { useOnlineStatus } from "@components/useOnlineStatus";

import {
  COMPROMISE_ACKNOWLEDGE_LABEL,
  COMPROMISE_ACKNOWLEDGE_LEAD,
  COMPROMISE_ACKNOWLEDGE_NOTE,
  COMPROMISE_RESPONSE_MESSAGE,
  COMPROMISE_RESPONSE_STANDS,
  COMPROMISE_RESPONSE_TITLE,
  COMPROMISE_RESPONSE_UNSAVED_REASON,
  COMPROMISE_RESPONSE_UNSAVED_TITLE,
  composeManagedFailureConfirmation,
  routeConfirmationReply,
} from "@psi/managed/managedFailureConfirmation";
import {
  ManagedHandoffRefusedError,
  dispatchManagedMigration,
  exportManagedBackup,
} from "@psi/managed/managedExchangeExport";
import {
  ManagedReinviteWithheldError,
  clearManagedExchangeStandingCondition,
  getManagedExchange,
  persistManagedExchangeOutputDirectory,
  readRecordAndMarkBackedUp,
  recordManagedExchangeCompromiseResponse,
  spendManagedExchangeIfCurrent,
  updateManagedExchangeLocalFields,
} from "@psi/managed/managedExchangeStore";
import {
  readDisclosureAccounting,
  resetDisclosureAccounting,
} from "@psi/disclosureAccountingStore";

import { clearParkedResults, readParkedResults } from "@psi/parkedResultsStore";
import {
  clearUnfiledExchangeFlag,
  unfiledExchangeFlagged,
} from "@psi/unfiledDisclosureFlag";
import {
  fileUnfiledDisclosures,
  readUnfiledDisclosures,
} from "@psi/unfiledDisclosureStore";

import {
  MAX_KEY_FILE_IMPORT_BYTES,
  retakeManagedExchange,
} from "@psi/managed/managedRetake";

import {
  runnableManagedExchange,
  runnableManagedExchangeOrRefuse,
  standingCompromiseResponse,
} from "@psi/managed/managedExchangeRecord";
import { MANAGED_EXCHANGE_ARTIFACT_MIME } from "@psi/managed/managedExchangeArtifact";
import { ManagedExchangeLockUnavailableError } from "@psi/managed/managedExchangeLock";
import { canReinviteFromRecord } from "@psi/managed/managedReinvite";
import { chooseManagedOutputDirectory } from "@psi/managed/managedOutputDirectory";
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
  FailureBody,
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
  ManagedExchangeDetail,
  ParkedResultsView,
} from "./ManagedExchangeDetail";
import {
  RECORD_GONE_HANDOFF_REASON,
  RECORD_GONE_HANDOFF_TITLE,
  RUN_IN_FLIGHT_HANDOFF_REASON,
  RUN_IN_FLIGHT_HANDOFF_TITLE,
  SUPERSEDED_HANDOFF_TITLE,
  supersededHandoffReason,
} from "./managedHandoffGate";
import {
  RETAKE_ACTION_LABEL,
  RETAKE_CONFIRM_LABEL,
  RETAKE_KEY_FILE_NOTE,
  RETAKE_LEAD,
  RETAKE_NO_KEY_FILE_NOTE,
  RETAKE_STORE_FAILED,
  managedRetakeRefusal,
} from "./managedRetakeModel";
import {
  STANDING_CONDITION_CLEAR_LABEL,
  managedStandingConditionView,
} from "./managedStandingConditionModel";
import { DeleteExchangeButton } from "./SavedExchanges";
import { ManagedConfigurationSurface } from "./ManagedConfigurationSurface";
import { ManagedCronExportPanel } from "./ManagedCronExportPanel";
import { REINVITE_RUN_IN_FLIGHT_REASON } from "./managedReinviteGate";
import { useManagedRunInFlight } from "./useManagedRunInFlight";

import type { Ref } from "react";
import type { ResolvedMatching } from "@alcove/core";

import type {
  ManagedExchangeLocalEdits,
  ManagedExchangeRecord,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type {
  ManagedHandoffRefusal,
  ManagedMigrationDispatch,
} from "@psi/managed/managedExchangeExport";
import type {
  ManagedLocalState,
  ManagedSpentState,
} from "@psi/managed/managedLocalState";
import type { DisclosureAccountingRead } from "@psi/disclosureAccountingStore";
import type { ManagedBackupMarker } from "@psi/managed/managedBackupState";
import type { ManagedInputSource } from "@psi/managed/managedInputHandle";
import type { ManagedReinvite } from "@psi/managed/managedReinvite";
import type { ManagedRetakeRefusal } from "./managedRetakeModel";
import type { ManagedRunFailureAlert } from "./managedRunLaunchModel";
import type { ManagedStandingConditionView } from "./managedStandingConditionModel";
import type { ParkedResultsRead } from "@psi/parkedResultsStore";
import type { RunOutputs } from "@psi/runOutputs";
import type { UnfiledDisclosureRead } from "@psi/unfiledDisclosureStore";

/** The classified failure on screen, with the number of the run that produced it.
 * Each tier's copy is a shared constant, so two runs failing the same way yield the
 * same alert object; the run number is what tells one failure from another, and it
 * is what a confirmation the operator gave at a gate is granted for. */
interface LiveManagedRunFailure {
  /** The classified failure the surface renders. */
  alert: ManagedRunFailureAlert;
  /** Which of this visit's runs produced it, counting from one. */
  runNumber: number;
}

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
  const [record, setRecord] = useState<RunnableManagedExchangeRecord>();
  // The loaded record when it holds no secret: a configuration imported from the
  // command line, which edits and exports here and runs there. It is held apart
  // from `record` rather than beside a flag, so no run control can be reached
  // with it -- the run path takes the runnable record type and this is not one.
  const [configuration, setConfiguration] = useState<ManagedExchangeRecord>();
  // Every store write this surface makes keeps the secret the record it read
  // holds -- a rotation, a local-fields edit, a folder grant -- so adopting the
  // returned record restates what this surface holds rather than admitting a
  // shape it has no controls for.
  const adoptRecord = useCallback(
    (updated: ManagedExchangeRecord) =>
      setRecord(runnableManagedExchangeOrRefuse(updated)),
    [],
  );
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
  // Bumped to load the record and its sibling state again, after a re-take has
  // cleared the spent state this surface loaded under.
  const [recordReads, setRecordReads] = useState(0);
  const [backupMarker, setBackupMarker] = useState<ManagedBackupMarker>();
  // The local sibling state as the load read it, for the standing condition's own
  // section: the import marker is what tells a restored copy's stale secret from a
  // handshake nothing on this device explains.
  const [localState, setLocalState] = useState<ManagedLocalState>();
  // This exchange's accounting of disclosures as its own read classified it, one
  // value rather than an accounting beside flags: an unreadable accounting must
  // not render as an empty one (which would be treated as "nothing was disclosed"), and
  // a store that did not answer must not render as either. `undefined` while the
  // read is in flight.
  const [accountingRead, setAccountingRead] =
    useState<DisclosureAccountingRead>();
  // Bumped to re-read the accounting: after a reset, so the surface shows what the
  // store actually holds rather than assuming the delete took, and on an explicit
  // retry of a read that never reached the store. The unfiled-run note is read
  // again with it, so one retry answers for the whole section.
  const [accountingReads, setAccountingReads] = useState(0);
  // The runs this exchange noted as having disclosed without filing a record, as
  // their own read classified them: a store that did not answer must not render
  // as "nothing is missing". `undefined` while the read is in flight.
  const [unfiledRead, setUnfiledRead] = useState<UnfiledDisclosureRead>();
  // The exchange this visit found flagged as holding a run this browser could
  // record nowhere -- the id rather than a flag, so switching exchanges cannot
  // carry the state, and a re-read that finds the flag already cleared cannot
  // retract what this visit has shown.
  const [flaggedUnrecordedId, setFlaggedUnrecordedId] = useState<string>();
  // What a scheduled run left for this visit, as its own read classified it. Read
  // here for the same reason the accounting is: a store that did not answer must
  // not render as "no run left anything". `undefined` while the read is in
  // flight.
  const [parkedResultsRead, setParkedResultsRead] =
    useState<ParkedResultsRead>();
  // Bumped to read the parked results again, on an explicit retry of a read that
  // never reached the store.
  const [parkedResultsReads, setParkedResultsReads] = useState(0);
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
  // Every hand-off affordance on this surface, plus the re-invite mint below, reads
  // one in-flight signal, which sees a run started anywhere in this browser profile
  // -- here, in a second tab, or by the scheduled runtime -- not just the one this
  // surface started.
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
  const [liveFailure, setLiveFailure] = useState<LiveManagedRunFailure>();
  const failure = liveFailure?.alert;
  // How many runs this visit has started, so each failure gets a number of its own.
  const runsStarted = useRef(0);
  // The run's non-fatal notices, in arrival order. The driver raises one only for
  // a run that produced its outputs, and its close resolves after those outputs
  // reach here, so a notice lands on the completion surface beside the results.
  const [runWarnings, setRunWarnings] = useState<ReadonlyArray<string>>([]);
  // What the agreed `deduplicate` values resolved to, reported by the driver
  // once the terms are agreed: the running copy states the pair while the run
  // is still going, and the completion panel restates it from the outputs.
  const [matching, setMatching] = useState<ResolvedMatching>();
  // The Tier-2 confirmation gate: once the operator confirms a real partner-side
  // failure, the surface proceeds to re-invite; a "does not add up" reply routes to
  // the compromise-response copy instead. The grant names the failure it was given
  // for, so a later failure the operator has answered nothing about still gets the
  // gate.
  const [confirmationGrantedFor, setConfirmationGrantedFor] =
    useState<number>();
  const confirmationGated =
    liveFailure !== undefined &&
    confirmationGrantedFor === liveFailure.runNumber;
  // The compromise response is the record's own, written at whichever gate the
  // operator answered and read back off the record this page holds, so one answer
  // covers both gates and stands at the next visit as it does here. A write this
  // device refused leaves it standing until the page is left or a run starts,
  // which is the side to fail to; the panel states that where the operator reads
  // it.
  const [respondingCompromise, setRespondingCompromise] = useState(false);
  const [compromiseWriteFailed, setCompromiseWriteFailed] = useState(false);
  // The store refused this page's mint because the record it holds has an answer
  // this page had not read -- another tab's, written after this one mounted. The
  // response stands on the exchange, so the page reads as it would have had it
  // mounted after the answer.
  const [reinviteWithheld, setReinviteWithheld] = useState(false);
  // Which failure's own gate the answer was given at, where it was given on this
  // visit. Clearing the response grants the confirmation for that failure alone: a
  // response given at the standing condition's gate, or at an earlier visit, has no
  // live failure behind it and grants none.
  const [compromiseAnsweredFor, setCompromiseAnsweredFor] = useState<number>();
  // Every state in which an answer holds this page: one the record holds, one
  // being written (whose two outcomes both keep the withhold, so no control is live
  // across the write), one this device refused, and one the store refused a mint
  // over.
  const compromiseResponse =
    respondingCompromise ||
    compromiseWriteFailed ||
    reinviteWithheld ||
    (record !== undefined && standingCompromiseResponse(record) !== undefined);
  // The standing condition's own clearance, held apart from the live failure's gate
  // above: the two states can stand at once (a no-show this visit over a condition an
  // earlier run raised), and clearing one must not move the other.
  const [standingSettled, setStandingSettled] = useState(false);
  const [clearingStanding, setClearingStanding] = useState(false);
  const [clearStandingFailed, setClearStandingFailed] = useState(false);
  // A fresh re-invite the operator forwards out-of-band. Present once a re-invite is
  // composed and the fresh secret persisted onto the record.
  const [reinvite, setReinvite] = useState<ManagedReinvite>();
  const [reinviting, setReinviting] = useState(false);
  const [reinviteFailed, setReinviteFailed] = useState(false);
  // The mint's own write refused this click: a run held the record's lock at it,
  // which the poll's last reading was too old to see. It states the reason; it does
  // not disable the control, which the poll gives back when the run ends.
  const [reinviteRefusedByRun, setReinviteRefusedByRun] = useState(false);
  // A run holds the mint back: the polled reading, or that refusal.
  const runHoldsReinvite = runInFlight || reinviteRefusedByRun;
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
        } else if (!runnableManagedExchange(loaded)) {
          // A configuration-only record has its own surface: settings and the
          // command-line export, no run. The record's shape decides it.
          setConfiguration(loaded);
        } else {
          setBackupMarker(local?.backup);
          setLocalState(local);
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
  }, [id, recordReads]);

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

  // The runs the accounting is short, read beside it and keyed the same way, so a
  // run that has just failed to file is read back without a reload and a re-read
  // of the accounting re-reads what it owes. The flag is read here too, and
  // dropped only once its alert has rendered: this surface shows nothing at all
  // for a missing, unloadable or spent exchange, and clearing on the visit
  // instead would destroy the only trace of that run unseen.
  useEffect(() => {
    let live = true;
    if (unfiledExchangeFlagged(id)) setFlaggedUnrecordedId(id);
    void readUnfiledDisclosures(id)
      .then((read) => {
        if (live) setUnfiledRead(read);
      })
      // The read classifies every failure rather than rejecting, so this is the
      // safety check for that contract lapsing. Unavailable claims nothing about
      // what is stored, where an unhandled rejection would leave the section
      // stating that nothing is missing.
      .catch(() => {
        if (live) setUnfiledRead({ kind: "unavailable" });
      });
    return () => {
      live = false;
    };
  }, [id, finishedAt, accountingReads]);

  // The results a run with nobody present left here, read on its own for the
  // reasons above. The read applies the retention as it goes, so what lands here
  // is what is still offered, never an entry the stated retention has released.
  useEffect(() => {
    let live = true;
    void readParkedResults(id)
      .then((read) => {
        if (live) setParkedResultsRead(read);
      })
      // The read classifies every failure rather than rejecting; this is the
      // safety check for that contract lapsing, landing on the state that claims
      // nothing about what is stored rather than stranding the section.
      .catch(() => {
        if (live) setParkedResultsRead({ kind: "unavailable" });
      });
    return () => {
      live = false;
    };
  }, [id, parkedResultsReads]);

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
    runsStarted.current += 1;
    const runNumber = runsStarted.current;
    setRunning(true);
    setLiveFailure(undefined);
    setRunWarnings([]);
    setMatching(undefined);
    setConfirmationGrantedFor(undefined);
    setCompromiseWriteFailed(false);
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
      let launched: RunnableManagedExchangeRecord = record;
      try {
        const reread = await getManagedExchange(record.id).catch(
          () => undefined,
        );
        // A re-read holding no secret is not this run's to act on: the
        // surface's own record stands in, and the run's own gates decide.
        launched =
          reread !== undefined && runnableManagedExchange(reread)
            ? reread
            : record;
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
          onResolvedMatching: setMatching,
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
        // the classified copy, and the escaped error where the state's placement
        // shows one (`managedRunLaunchModel`).
        whenDiagnostic(() => console.error(error));
        // The tier is derived from the record's OWN bookkeeping, which the run path
        // just stamped (the auth/transport/storage/input/consent/cancelled
        // failureKind), so the record and its import marker are reloaded before
        // classifying -- an unattended run's failure would show through the same
        // tiers at the next visit. A corrupted record or sibling entry makes the
        // reload reject (a ZodError); rather than skip setLiveFailure entirely
        // (spinner clears, no error UI, unhandled rejection), fall back to the
        // launch reading and no sibling state, so the original error still shows
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
        setLiveFailure({ alert: failed, runNumber });
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
    // Closed at the mint rather than at each control that reaches it, whichever part
    // of the page asked: while a compromise response stands, a fresh invitation on
    // this channel would hand the new secret to whoever is interfering, and a run in
    // flight is connecting on the secret the mint replaces. Both halves are a second
    // check over the store's own refusals, which are decided on the record the store
    // reads and the lock a run holds rather than on this page's copy.
    if (record === undefined || reinviting || compromiseResponse || runInFlight)
      return;
    setReinviteSource(source);
    setReinviting(true);
    setReinviteFailed(false);
    setReinviteRefusedByRun(false);
    void (async () => {
      try {
        // The controls above render from a poll, so a run started since the last
        // reading is still news here; re-reading also puts the reason on screen. A
        // run this reading still misses is refused by the mint's own write, which
        // takes the run's lock.
        if (await recheckLock()) return;
        const result = await reinviteManagedExchange(record);
        adoptRecord(result.record);
        setLiveFailure(undefined);
        setReinvite(result.reinvite);
      } catch (error) {
        // The store refuses the rotation over an answer this page has not read, and
        // that is not a failure to retry: the page adopts the withhold and offers the
        // acknowledgement instead.
        if (error instanceof ManagedReinviteWithheldError) {
          setReinviteWithheld(true);
        } else if (error instanceof ManagedExchangeLockUnavailableError) {
          setReinviteRefusedByRun(true);
        } else {
          whenDiagnostic(() => console.error(error));
          setReinviteFailed(true);
        }
      } finally {
        setReinviting(false);
      }
    })();
  }

  // Write the operator's answer that nothing adds up onto the record, so the mint
  // stays withheld past this visit. Both gates route here; the record the store
  // holds is what the write attaches the answer to, and the page adopts it.
  function respondCompromise() {
    if (record === undefined || respondingCompromise) return;
    setRespondingCompromise(true);
    void recordManagedExchangeCompromiseResponse(
      record.id,
      new Date().toISOString(),
    )
      .then(adoptRecord)
      .catch((error) => {
        whenDiagnostic(() => console.error(error));
        setCompromiseWriteFailed(true);
      })
      .finally(() => setRespondingCompromise(false));
  }

  // The two-outcome gate: a confirmed real partner-side failure proceeds to re-invite;
  // anything that does not add up routes to the compromise response (no quiet
  // re-invite on the possibly-compromised channel). The inviter side mints the fresh
  // invitation right away; the acceptor side cannot mint one from its mirrored
  // document, so the gated recovery names asking the partner instead.
  function resolveConfirmation(
    outcome: Parameters<typeof routeConfirmationReply>[0],
  ) {
    // No reply mints while a compromise response stands, including one raised at the
    // standing condition's gate: that channel is the one the operator flagged.
    if (compromiseResponse) return;
    if (routeConfirmationReply(outcome) === "compromise-response") {
      setCompromiseAnsweredFor(liveFailure?.runNumber);
      respondCompromise();
      return;
    }
    setConfirmationGrantedFor(liveFailure?.runNumber);
    if (record !== undefined && canReinviteFromRecord(record))
      reinviteNow("recovery");
  }

  // The standing condition's clear-and-acknowledge: the operator's own act, and the
  // only clearance a page offers (a re-invite drops the condition in its own rotation
  // write, and deleting the exchange takes it with the record). The re-invite stays
  // offered afterwards, which is why the section holds its place rather than
  // disappearing on the write. `pastResponse` is the same act taken from under a
  // compromise response, which the write clears along with the condition holding it.
  function clearStanding(pastResponse: boolean) {
    // The answer's own write has to land first: a clear that overtook it would be
    // reverted by the answer arriving after it, leaving a response the operator has
    // already settled.
    if (record === undefined || clearingStanding || respondingCompromise)
      return;
    setClearingStanding(true);
    setClearStandingFailed(false);
    clearManagedExchangeStandingCondition(record.id)
      .then((updated) => {
        adoptRecord(updated);
        setStandingSettled(true);
        setCompromiseWriteFailed(false);
        setReinviteWithheld(false);
        // The gate is not put again to an operator who answered it and then settled
        // it out-of-band: the failure they answered offers the mint they can now
        // take. Only that failure -- a run since then raised one they have answered
        // nothing about, and it keeps its own gate.
        if (pastResponse) setConfirmationGrantedFor(compromiseAnsweredFor);
      })
      .catch((error) => {
        whenDiagnostic(() => console.error(error));
        setClearStandingFailed(true);
      })
      .finally(() => setClearingStanding(false));
  }

  // The standing condition's two-outcome gate, the same routing the live Tier-2
  // failure takes: a confirmed partner-side failure clears the condition, and a reply
  // that does not add up clears nothing and routes to the compromise response.
  function resolveStanding(
    outcome: Parameters<typeof routeConfirmationReply>[0],
  ) {
    // The refusal the live gate's reply takes, for the same reason: no reply clears
    // or mints on a channel the operator has already flagged.
    if (compromiseResponse) return;
    if (routeConfirmationReply(outcome) === "compromise-response") {
      respondCompromise();
      return;
    }
    clearStanding(false);
  }

  // The standing condition as the page would render it, and whether it renders at
  // all. A live run's own failure already speaks for this run, and where it landed
  // on the state the condition resolves to it holds that state's recovery and the
  // compromise response answered here -- so the section stands down rather than
  // putting a second copy beside the first. It returns as soon as the live state is
  // something else, and at the next visit; once cleared it holds its place.
  const standingView =
    record !== undefined
      ? managedStandingConditionView(record, localState)
      : undefined;
  const showStanding =
    reinvite === undefined &&
    (standingSettled ||
      (standingView !== undefined && standingView.tier !== failure?.kind));

  // Whether the live failure holds the re-invite: it offers the mint directly, or it
  // holds the confirmation gate, whose two outcomes decide whether one happens at
  // all. Both mint from this record, so the standing section keeps its status and
  // its clear control and adds no button of its own -- neither a second copy of the
  // offer, whose failed mint would alert twice, nor a way around the gate.
  const failureHoldsReinvite =
    failure !== undefined &&
    (managedRunReinvites(failure) || failure.recovery === "confirm");

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
    adoptRecord(updated);
  }

  // The picker is reached with no awaited work in front of it: a browser hands a
  // site a folder only under the operator's own gesture, and an await before the
  // call spends it. A dismissed picker yields no handle and changes nothing.
  function grantOutputFolder(): Promise<void> {
    const held = record;
    if (held === undefined) return Promise.resolve();
    return chooseManagedOutputDirectory().then(async (directory) => {
      if (directory === undefined) return;
      adoptRecord(
        await persistManagedExchangeOutputDirectory(held.id, directory),
      );
    });
  }

  async function stopUsingOutputFolder(): Promise<void> {
    if (record === undefined) return;
    adoptRecord(await persistManagedExchangeOutputDirectory(record.id, null));
  }

  // Queue a fresh read of the accounting, dropping the standing verdict as it
  // goes: the section returns to its in-flight state rather than rendering the
  // previous verdict and its buttons under a click that has already been taken --
  // which displays as an inert control, beside an irreversible one.
  function readAccountingAgain(): void {
    setAccountingRead(undefined);
    setUnfiledRead(undefined);
    setAccountingReads((reads) => reads + 1);
  }

  // Drop the flag, called by the alert that shows it. Held stable across renders
  // so the alert's mount effect runs once rather than on every render of the
  // section around it.
  const dropUnrecordedRunFlag = useCallback(() => {
    void clearUnfiledExchangeFlag(id);
  }, [id]);

  // File the records the unfiled-run note retained, then read both again so the
  // section shows what the store holds afterwards: a filing that did not take
  // leaves the shortfall standing rather than an entry that is not there.
  async function fileUnfiled(): Promise<void> {
    await fileUnfiledDisclosures(id);
    readAccountingAgain();
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

  // Read the parked results again after a read that never reached the store,
  // dropping the standing verdict as it goes so the section returns to its
  // in-flight state rather than rendering a notice under a click already taken.
  // Offered instead of a page reload for the reason the accounting's retry is:
  // a reload ends a run in progress, and the blocked-open condition it recovers
  // from clears on its own.
  function retryParkedResultsRead(): void {
    setParkedResultsRead(undefined);
    setParkedResultsReads((reads) => reads + 1);
  }

  // Load the record and its sibling state again after a re-take has cleared the
  // spent state, so what the surface shows is what the store holds rather than the
  // re-take's own answer: the load is the one place the run affordance, the backup
  // state, and the standing condition are derived.
  function readRecordAgain(): void {
    setSpent(undefined);
    setSpentByRefusedRun(false);
    setLoadFailure(undefined);
    setRecordReads((reads) => reads + 1);
  }

  // Remove everything this exchange's scheduled runs left in this browser, then
  // read the store again: what the section shows afterwards is what the store
  // holds, not an assumption that the delete took. A rejection reaches the
  // control, which keeps its confirm open and states the failure.
  async function clearParked(): Promise<void> {
    await clearParkedResults(id);
    setParkedResultsRead(undefined);
    setParkedResultsReads((reads) => reads + 1);
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
          <SpentSurface
            spent={spent}
            refusedRun={spentByRefusedRun}
            parkedResultsRead={parkedResultsRead}
            onRetryParkedResultsRead={retryParkedResultsRead}
            onClearParkedResults={clearParked}
            id={id}
            onRetaken={readRecordAgain}
          />
        ) : configuration !== undefined ? (
          <ManagedConfigurationSurface
            record={configuration}
            onRecordEdited={setConfiguration}
            onDeleted={() => void navigate({ to: "/saved" })}
          />
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
              You exported this exchange&apos;s alcove.yaml and .alcove.key, so
              it no longer runs here. Run it on the machine you saved them to:
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
                    <FailureBody failure={failure} />
                  </Alert>
                  {/* Below the failure, not in place of it: a run that stopped
                      after sending raises its own notice when it could not file
                      the disclosure, and that notice speaks for a run with no
                      completion surface to show it on. */}
                  <RunWarningsAlert warnings={runWarnings} />
                  {/* The recovery is the whole of what a compromise response
                      withholds: every branch of it either mints or asks a gate
                      the operator has answered. The failure's own account of
                      what happened stays above it. */}
                  {!compromiseResponse && (
                    <FailureRecovery
                      failure={failure}
                      record={record}
                      confirmationGated={confirmationGated}
                      reinviting={reinviting}
                      runInFlight={runInFlight}
                      runHoldsReinvite={runHoldsReinvite}
                      // The failed alert renders only at the site that triggered the
                      // mint, so the recovery and the detail section do not both show it.
                      reinviteFailed={
                        reinviteFailed && reinviteSource === "recovery"
                      }
                      onReinvite={() => reinviteNow("recovery")}
                      onResolveConfirmation={resolveConfirmation}
                    />
                  )}
                </>
              )
            )}
            {compromiseResponse && (
              <CompromiseResponsePanel
                unsaved={compromiseWriteFailed}
                // The acknowledgement waits out the answer's own write, which it
                // cannot be taken ahead of.
                clearing={clearingStanding || respondingCompromise}
                clearFailed={clearStandingFailed}
                onAcknowledge={() => clearStanding(true)}
              />
            )}
            {showStanding && !compromiseResponse && (
              <StandingConditionSection
                record={record}
                view={standingView}
                settled={standingSettled}
                clearing={clearingStanding}
                clearFailed={clearStandingFailed}
                reinviting={reinviting}
                runInFlight={runInFlight}
                runHoldsReinvite={runHoldsReinvite}
                reinviteFailed={reinviteFailed && reinviteSource === "recovery"}
                reinviteHeldByFailure={failureHoldsReinvite}
                onReinvite={() => reinviteNow("recovery")}
                onClear={() => clearStanding(false)}
                onResolve={resolveStanding}
              />
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
            {running && matching !== undefined && (
              <p className={styles.sub}>{describeResolvedMatching(matching)}</p>
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
              unfiledDisclosureRead={unfiledRead}
              unrecordedRunFlagged={flaggedUnrecordedId === id}
              parkedResultsRead={parkedResultsRead}
              onFileUnfiledDisclosures={fileUnfiled}
              onUnrecordedRunFlagShown={dropUnrecordedRunFlag}
              onResetAccounting={resetAccounting}
              onRetryAccountingRead={retryAccountingRead}
              onRetryParkedResultsRead={retryParkedResultsRead}
              onClearParkedResults={clearParked}
              onSaveLocalFields={saveLocalFields}
              onGrantOutputFolder={grantOutputFolder}
              onStopUsingOutputFolder={stopUsingOutputFolder}
              onReinviteToChangeTerms={() => reinviteNow("detail")}
              canReinvite={canReinviteFromRecord(record)}
              compromiseResponse={compromiseResponse}
              runInFlight={runInFlight}
              runHoldsReinvite={runHoldsReinvite}
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
 * above this (the {@link ReinvitePanel}), so this never handles the minted artifacts.
 * The host renders none of this while a compromise response stands, showing the
 * {@link CompromiseResponsePanel} in its place. */
function FailureRecovery({
  failure,
  record,
  confirmationGated,
  reinviting,
  runInFlight,
  runHoldsReinvite,
  reinviteFailed,
  onReinvite,
  onResolveConfirmation,
}: {
  failure: ManagedRunFailureAlert;
  record: ManagedExchangeRecord;
  confirmationGated: boolean;
  reinviting: boolean;
  runInFlight: boolean;
  runHoldsReinvite: boolean;
  reinviteFailed: boolean;
  onReinvite: () => void;
  onResolveConfirmation: (
    outcome: Parameters<typeof routeConfirmationReply>[0],
  ) => void;
}) {
  if (failure.recovery === "confirm") {
    // Past the gate on a confirmed partner-side failure, the recovery is fast
    // re-invite -- the same panel a direct re-invite tier shows (which mints for the
    // inviter and names asking the partner for the acceptor, with a retry on failure).
    if (confirmationGated)
      return (
        <ReinviteRecovery
          record={record}
          reinviting={reinviting}
          runInFlight={runInFlight}
          runHoldsReinvite={runHoldsReinvite}
          reinviteFailed={reinviteFailed}
          onReinvite={onReinvite}
        />
      );
    return (
      <ConfirmationPanel
        record={record}
        busy={reinviting}
        onResolve={onResolveConfirmation}
      />
    );
  }

  if (managedRunReinvites(failure))
    return (
      <ReinviteRecovery
        record={record}
        reinviting={reinviting}
        runInFlight={runInFlight}
        runHoldsReinvite={runHoldsReinvite}
        reinviteFailed={reinviteFailed}
        onReinvite={onReinvite}
      />
    );

  return null;
}

/** The alert every clearance shows when the store refused the write: the standing
 * condition's two legs and the compromise response's acknowledgement all take the
 * same write, and a rejected one leaves the condition standing wherever it was
 * taken from. */
function ClearFailureAlert() {
  return (
    <Alert color="red" title="Could not clear this" mt="sm">
      Nothing changed here, so this still stands. Try again.
    </Alert>
  );
}

/**
 * The compromise response: the answer the operator gave at a failure gate, held on
 * the record so it stands at the next visit and not this one alone. It renders
 * wherever the page would have put a gate or an offer of a fresh invitation, since
 * minting on the channel the operator flagged is the act the response names as the
 * wrong one.
 *
 * The acknowledgement below it is the one way back to that offer from this page: the
 * operator reached the partner on another channel and heard the failure was theirs.
 * It clears the standing condition, and the response with it, and mints nothing --
 * the re-invite is offered again once the write lands (a re-invite and a delete are
 * the other two acts that clear it, and neither is reachable from here under one).
 */
function CompromiseResponsePanel({
  unsaved,
  clearing,
  clearFailed,
  onAcknowledge,
}: {
  /** Whether this device refused the write. The response holds this page either
   * way; an unsaved one ends when the page is left or a run starts, and says
   * so. */
  unsaved: boolean;
  clearing: boolean;
  clearFailed: boolean;
  onAcknowledge: () => void;
}) {
  return (
    <>
      {unsaved && (
        <Alert color="yellow" title={COMPROMISE_RESPONSE_UNSAVED_TITLE} mb="md">
          {COMPROMISE_RESPONSE_UNSAVED_REASON}
        </Alert>
      )}
      <Alert color="red" title={COMPROMISE_RESPONSE_TITLE} mb="md">
        <span style={{ whiteSpace: "pre-line" }}>
          {COMPROMISE_RESPONSE_MESSAGE}
        </span>
        {!unsaved && (
          <p className={styles.small}>{COMPROMISE_RESPONSE_STANDS}</p>
        )}
      </Alert>
      <div className={styles.callout}>
        <p className={styles.calloutLead}>{COMPROMISE_ACKNOWLEDGE_LEAD}</p>
        <p className={styles.small}>{COMPROMISE_ACKNOWLEDGE_NOTE}</p>
        {clearFailed && <ClearFailureAlert />}
        <Button
          mt="sm"
          variant="default"
          loading={clearing}
          onClick={onAcknowledge}
        >
          {COMPROMISE_ACKNOWLEDGE_LABEL}
        </Button>
      </div>
    </>
  );
}

/**
 * The standing condition on the exchange's page: the unanswered evidence an
 * earlier run raised, carried past every no-show and success since, with the one
 * clearance a page offers.
 *
 * The copy and which clearance applies are the pure model's
 * ({@link managedStandingConditionView}); this renders them. The unexplained tier
 * goes through the same two-outcome gate the live Tier-2 failure uses, so a reply
 * that does not add up is written onto the record here exactly as it is there, and
 * clears nothing. Every other tier's explanation the record already holds, so it
 * gets the re-invite recovery and a short acknowledgement instead of an attack
 * checklist (docs/MANAGED_EXCHANGE.md, "Telling a desync from an attack").
 *
 * Once cleared, the section keeps its place and shows the re-invite: settling a
 * condition is not the same act as re-establishing the secret it was raised over.
 * Where the live failure above holds that re-invite -- offering it, or holding the
 * gate that decides whether it happens -- the act is left to it, so there is one
 * control for it and no way around the gate. The host renders none of this while a
 * compromise response stands, showing the {@link CompromiseResponsePanel} in its
 * place.
 */
function StandingConditionSection({
  record,
  view,
  settled,
  clearing,
  clearFailed,
  reinviting,
  runInFlight,
  runHoldsReinvite,
  reinviteFailed,
  reinviteHeldByFailure,
  onReinvite,
  onClear,
  onResolve,
}: {
  record: ManagedExchangeRecord;
  /** The condition as the page renders it, absent once nothing stands. */
  view: ManagedStandingConditionView | undefined;
  /** Whether the operator has cleared the condition on this visit. */
  settled: boolean;
  clearing: boolean;
  clearFailed: boolean;
  reinviting: boolean;
  runInFlight: boolean;
  runHoldsReinvite: boolean;
  reinviteFailed: boolean;
  /** Whether the live failure above holds the re-invite: it offers the mint itself,
   * or it holds the gate deciding whether one happens. Either way this section shows
   * its status and its clearance and no control of its own. */
  reinviteHeldByFailure: boolean;
  onReinvite: () => void;
  onClear: () => void;
  onResolve: (outcome: Parameters<typeof routeConfirmationReply>[0]) => void;
}) {
  const offersReinvite = !reinviteHeldByFailure;
  const clearFailure = clearFailed ? <ClearFailureAlert /> : null;
  if (settled)
    return offersReinvite ? (
      <ReinviteRecovery
        record={record}
        reinviting={reinviting}
        runInFlight={runInFlight}
        runHoldsReinvite={runHoldsReinvite}
        reinviteFailed={reinviteFailed}
        onReinvite={onReinvite}
      />
    ) : null;
  if (view === undefined) return null;
  return (
    <>
      <Alert
        color={view.clearance === "confirmation" ? "red" : "yellow"}
        title={view.title}
        mb="md"
      >
        {view.message}
      </Alert>
      {view.clearance === "confirmation" ? (
        <>
          <ConfirmationPanel
            record={record}
            busy={clearing}
            onResolve={onResolve}
          />
          {clearFailure}
        </>
      ) : (
        <>
          {offersReinvite && (
            <ReinviteRecovery
              record={record}
              reinviting={reinviting}
              runInFlight={runInFlight}
              runHoldsReinvite={runHoldsReinvite}
              reinviteFailed={reinviteFailed}
              onReinvite={onReinvite}
            />
          )}
          {clearFailure}
          <Button
            mt="sm"
            variant="default"
            loading={clearing}
            onClick={onClear}
          >
            {STANDING_CONDITION_CLEAR_LABEL}
          </Button>
        </>
      )}
    </>
  );
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
  runInFlight,
  runHoldsReinvite,
  reinviteFailed,
  onReinvite,
}: {
  record: ManagedExchangeRecord;
  reinviting: boolean;
  /** Whether a run of this exchange is under way anywhere this browser profile
   * can see. The mint replaces the secret that run is connecting on, so the
   * control waits it out. */
  runInFlight: boolean;
  /** That same reading, or the mint write's own refusal when a run held the lock
   * at it. It states the reason; it does not disable the control, which the
   * reading gives back when the run ends. */
  runHoldsReinvite: boolean;
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
          <Button
            mt="sm"
            onClick={onReinvite}
            loading={reinviting}
            disabled={runInFlight}
          >
            Create a fresh invitation
          </Button>
          {runHoldsReinvite && (
            <p className={styles.small}>{REINVITE_RUN_IN_FLIGHT_REASON}</p>
          )}
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
  busy,
  onResolve,
}: {
  record: ManagedExchangeRecord;
  /** Whether the write a reply started is still in flight. Both legs are disabled
   * for it: the two outcomes are one answer, and a second click landing before the
   * write resolves would settle the condition under the other one. */
  busy: boolean;
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
        <Button
          disabled={busy}
          onClick={() => onResolve("confirmed-partner-failure")}
        >
          {confirmation.confirmedOption}
        </Button>{" "}
        <Button
          color="red"
          variant="light"
          disabled={busy}
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
 * named against the command-line export below, whose two files bring back no secret
 * (its `alcove.yaml` imports as a configuration only), so the state this panel shows
 * is about the restorable file alone.
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
 * produced the CLI's two files, which bring back no secret, so the exchange runs
 * from those files and they are its backup of record.
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
 * gate resting on them ({@link MANAGED_RUN_HANDED_OFF_ATTESTATION}).
 *
 * A hand-off takes the exchange's future runs, not what its earlier scheduled
 * runs left at rest here, so this surface collects those too -- the same
 * section the detail page offers them in. Without it the results sit in this
 * browser for the rest of the retention with nothing offering them. */
function SpentSurface({
  spent,
  refusedRun = false,
  parkedResultsRead,
  onRetryParkedResultsRead,
  onClearParkedResults,
  id,
  onRetaken,
}: {
  spent: ManagedSpentState | undefined;
  refusedRun?: boolean;
  /** How reading this exchange's parked results turned out; `undefined` while
   * the read is in flight. */
  parkedResultsRead: ParkedResultsRead | undefined;
  /** Read the parked results again, for a read that never reached the store. */
  onRetryParkedResultsRead: () => void;
  /** Remove what earlier runs left here. A spent copy runs nothing more, so this
   * is the only thing short of the retention that removes them. */
  onClearParkedResults: () => Promise<void>;
  /** The record the re-take acts on. */
  id: string;
  /** Read this exchange again, once a re-take has made it live. */
  onRetaken: () => void;
}) {
  const refused = refusedRun ? (
    <p className={styles.small}>{MANAGED_RUN_HANDED_OFF_ATTESTATION}</p>
  ) : null;
  // A spent copy runs nothing more here, so the section stands only on what is
  // actually at rest.
  const parked = (
    <ParkedResultsView
      read={parkedResultsRead}
      scheduled={false}
      onRetryRead={onRetryParkedResultsRead}
      onClear={onClearParkedResults}
    />
  );
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
        {parked}
        <SavedExchangesFoot />
      </>
    );
  const on = ` on ${dateLabel(new Date(spent.spentAt))}`;
  return spent.handoff === "command-line" ? (
    <>
      <h1>This exchange was handed off</h1>
      <p className={styles.sub}>
        You handed this exchange to the command line{on}, so it no longer runs
        here. It runs from the alcove.yaml and .alcove.key you saved, on the
        machine you saved them to.
      </p>
      {refused}
      <p className={styles.small}>
        Those two files are this exchange&apos;s backup of record. Keep them
        somewhere only you can read.
      </p>
      <RetakeControl id={id} onRetaken={onRetaken} />
      {parked}
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
      {parked}
      <SavedExchangesFoot />
    </>
  );
}

/**
 * The re-take on a copy handed to the command line: the one route back from the
 * spent state to a running exchange, and the only one the import refusal points at
 * (see {@link ./managedHandoffGate.ts}).
 *
 * Behind a confirmation, because the browser cannot see either thing the operator
 * has to have settled: that the scheduled run on the other machine is stopped, and
 * whether it has run since the hand-off -- which decides whether the `.alcove.key`
 * from that machine is needed. Declining writes nothing and leaves the copy spent.
 *
 * The key file is optional at the confirmation rather than required, since the
 * stored secret is still the partnership's where nothing has run there. A file the
 * parse will not take, and a re-take the store refused, both keep the confirmation
 * open with what happened beside it: nothing reads as a take-back that did not
 * happen.
 */
function RetakeControl({
  id,
  onRetaken,
}: {
  id: string;
  onRetaken: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [keyFile, setKeyFile] = useState<File | null>(null);
  const [retaking, setRetaking] = useState(false);
  const [refusal, setRefusal] = useState<ManagedRetakeRefusal>();

  function confirmRetake() {
    setRetaking(true);
    setRefusal(undefined);
    void (async () => {
      try {
        // Capped before the read, as the artifact import is: the key file holds one
        // secret and one instant, so an over-cap file is the wrong file rather than
        // one to read into memory ahead of the bounded parse.
        if (keyFile !== null && keyFile.size > MAX_KEY_FILE_IMPORT_BYTES) {
          setRefusal(managedRetakeRefusal("unreadable-key-file"));
          return;
        }
        const source = keyFile === null ? undefined : await keyFile.text();
        const result = await retakeManagedExchange(id, source);
        if (result.kind === "retaken") {
          setConfirming(false);
          onRetaken();
          return;
        }
        setRefusal(managedRetakeRefusal(result.kind));
      } catch {
        setRefusal(RETAKE_STORE_FAILED);
      } finally {
        setRetaking(false);
      }
    })();
  }

  return (
    <>
      <div className={styles.savedRowActions} style={{ marginTop: "1rem" }}>
        <Button
          variant="default"
          onClick={() => {
            setRefusal(undefined);
            setKeyFile(null);
            setConfirming(true);
          }}
        >
          {RETAKE_ACTION_LABEL}
        </Button>
      </div>
      <Modal
        opened={confirming}
        onClose={() => setConfirming(false)}
        title={RETAKE_ACTION_LABEL}
        centered
        transitionProps={{ duration: 0 }}
      >
        <p>{RETAKE_LEAD}</p>
        <p className={styles.small}>{RETAKE_KEY_FILE_NOTE}</p>
        <p className={`${styles.small} ${styles.sub}`}>
          {RETAKE_NO_KEY_FILE_NOTE}
        </p>
        <FileButton accept="application/json,.key" onChange={setKeyFile}>
          {(props) => (
            <Button variant="default" {...props}>
              Choose the .alcove.key file
            </Button>
          )}
        </FileButton>
        {keyFile !== null && (
          <p className={`${styles.small} ${styles.mono}`}>{keyFile.name}</p>
        )}
        {refusal !== undefined && (
          <Alert color="yellow" title={refusal.title} mt="sm" mb="sm">
            {refusal.reason}
          </Alert>
        )}
        <div className={styles.savedRowActions} style={{ marginTop: "1rem" }}>
          <Button variant="default" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button variant="light" loading={retaking} onClick={confirmRetake}>
            {RETAKE_CONFIRM_LABEL}
          </Button>
        </div>
      </Modal>
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
