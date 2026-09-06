import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import { Alert, VisuallyHidden } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";

import {
  mintExchangeFile,
  sanitizeErrorForDisplay,
  sanitizeForDisplay,
} from "@psilink/core";

import {
  InvitationFileError,
  generateInvitation,
  invitationDeclaresRetainedFiles,
  webrtcEndpointFromLocation,
} from "@psi/invitation";
import {
  emptyColumnPositions,
  overlongColumnsAlert,
  unnameableColumnsAlert,
} from "@psi/columnNames";
import { capturedInputHandle } from "@psi/managed/managedInputHandle";
import { columnSamplesFromRows } from "@psi/columnSamples";
import { createManagedExchange } from "@psi/managed/managedExchangeStore";
import { deleteSftpConnection } from "@psi/jobClient/sftpAuthoringClient";
import { fetchJobRendezvous } from "@psi/jobClient/workInputClient";
import { fetchSftpConnection } from "@psi/jobClient/serverJobExchangeDriver";
import { invitationLocation } from "@psi/invitationLocation";
import { loadCSVFileOffMainThread } from "@psi/workers/csvParseController";

import { isConsoleBuild, psilinkVersion } from "@utils/clientConfig";
import { whenDiagnostic } from "@utils/diagnostics";

import {
  coverageProvider,
  useNonEmptyRates,
} from "@components/useNonEmptyRates";
import { CONSOLE_COVERAGE_PENDING_LABEL } from "@components/FieldCoverage";
import { triggerBlobDownload } from "@components/blobDownload";
import { unlinkableFileAlert } from "@components/UnlinkableFileAlert";

import { RECEIPTS_DEFAULT, receiptsIntentFields } from "@psi/receiptsModel";
import {
  RUN_DIAGNOSTICS_DEFAULT,
  runDiagnosticsAfterRetarget,
  runDiagnosticsIntentFields,
} from "@psi/runDiagnosticsModel";
import {
  demotionNotice,
  editorFromCsv,
  editorReprofiled,
  editorWithAlgorithm,
  editorWithAuthoredDraft,
  editorWithColumnDisclosure,
  editorWithColumnType,
  editorWithDeduplicate,
  editorWithFieldAdded,
  editorWithFieldInput,
  editorWithFieldRemoved,
  editorWithFieldSteps,
  editorWithIdentity,
  editorWithImportedTerms,
  editorWithIncludeOwnColumns,
  editorWithKeyEnabled,
  editorWithKeyMoved,
  editorWithLegalAgreement,
  editorWithLifetime,
  editorWithLinkageStrategy,
  editorWithOutputDirection,
  editorWithRecommendedCleaning,
  editorWithTransport,
  resetToRecommended,
  sealEditor,
  unsealEditor,
} from "@psi/inviterEditor";

import {
  cleaningCoverageProblems,
  inviterCleaningAttention,
  inviterRailFacts,
  reviewValidation,
  spineProblems,
} from "@psi/inviterModel";
import { inviterLedgerRows, ledgerOutcomeOf } from "@psi/ledger";
import { outputForDirection } from "@psi/authoring/advancedInvite";
import { ownColumnsActionable } from "@psi/ownColumnsModel";

import {
  availableTransports,
  isCliTransport,
  transportRunMode,
} from "@psi/transportChooser";

import {
  CONFIG_EXCHANGE_FILES,
  EXCHANGE_FILES_DEFAULT,
  exchangeFilesOptions,
} from "@console/exchangeFilesModel";
import {
  CONNECTION_TUNING_DEFAULT,
  FILEDROP_CONNECTION_TUNING,
  SFTP_CONNECTION_TUNING,
  withConnectionTuning,
} from "@console/connectionTuningModel";
import {
  acceptKitEndpointForRendezvous,
  filedropEndpointForRendezvous,
  splitRendezvousRetainProblem,
} from "@console/filedropRendezvousChoice";
import {
  sftpEndpointForConnection,
  splitDirectoryRetainProblem,
} from "@console/sftpConnectionChoice";
import { consoleAcquiredCsv } from "@console/consoleAcquiredCsv";

import {
  EMPTY_SAVE_FIELDS,
  endpointRequestFor,
  exchangeFileInputFor,
  exchangeFileName,
  liveRunLedgerFooter,
  saveExchangeError,
  saveRailNote,
  saveTrustFooter,
} from "./saveExchangeModel";
import { acceptKitFileName, buildAcceptKit } from "./acceptKit";
import {
  buildManagedDeposit,
  webrtcLocatorFromEndpoint,
} from "./manageOfferModel";
import { downloadSampleCsvs, sampleInviterFile } from "./sampleData";
import { useBeforeUnloadPrompt, useUnloadGuard } from "./useUnloadGuard";
import { AgreementTab } from "./AgreementTab";
import { WorkShell } from "./WorkShell";

import { CleaningTab } from "./CleaningTab";
import { InviterExchangeSection } from "./InviterExchangeSection";
import { KeysTab } from "./KeysTab";
import { Ledger } from "./Ledger";
import { ManageExchangeOffer } from "./ManageExchangeOffer";
import { MatchingSharingSection } from "./MatchingSharingSection";
import { Problems } from "./Problems";
import { RecoveredExchangePanel } from "./RecoveredExchangePanel";
import { ReviewCreateSection } from "./ReviewCreateSection";
import { SaveExchangeSection } from "./SaveExchangeSection";
import { TopBar } from "./TopBar";
import { YourFileSection } from "./YourFileSection";
import { restorableSection } from "./stepRestore";
import { timelineSteps } from "./exchangeRun";
import { useInviterExchange } from "./useInviterExchange";
import { useStepHistory } from "./useStepHistory";

import type { AcceptKitEndpoint, AcceptKitExchange } from "./acceptKit";
import type { AcquiredCsv, InviterEditor } from "@psi/inviterEditor";
import type { RailStep } from "@psi/rail";

import type { CliTransport, SaveExchangeFields } from "./saveExchangeModel";
import type {
  ConnectionEndpointRequest,
  GeneratedInvitation,
  InvitationFileFailure,
} from "@psi/invitation";
import type {
  JobInputSource,
  SftpConnectionInfo,
} from "@psi/jobClient/serverJobExchangeDriver";
import type {
  JobRendezvousConfig,
  ProfiledJobInput,
} from "@psi/jobClient/workInputClient";
import type { AlertContent } from "@components/csvIntake";
import type { CoverageInput } from "@components/useNonEmptyRates";

import type { ColumnSamples } from "@psi/columnSamples";
import type { ConnectionTuningDraft } from "@console/connectionTuningModel";
import type { DisclosureChoice } from "@psi/metadataEditing";
import type { ExchangeFilesDraft } from "@console/exchangeFilesModel";
import type { ManageOfferChoices } from "./manageOfferModel";
import type { ManageOfferStatus } from "./ManageExchangeOffer";
import type { ReceiptsDraft } from "@psi/receiptsModel";
import type { RunDiagnosticsDraft } from "@psi/runDiagnosticsModel";
import type { SavedExchange } from "./SaveExchangeSection";
import type { Section } from "./stepRestore";
import type { SftpConnectionProjection } from "@jobs/jobManager";

import type { CSVRow, SemanticType, Standardization } from "@psilink/core";

type SpineStep = "file" | "columns" | "review";

/** Stable empty inputs for {@link useNonEmptyRates} before a file is acquired,
 * so the hook's controller is not rebuilt every render on a fresh `[]` identity
 * (the AcceptorScreen lift). */
const EMPTY_ROWS: ReadonlyArray<CSVRow> = [];
const EMPTY_STANDARDIZATION: Standardization = [];

/** Stable "no file yet" coverage input and preview samples, so the coverage hook's
 * provider is not rebuilt every render on a fresh identity before a file is
 * acquired. The empty-rows coverage input drives the hosted worker provider over no
 * rows (an empty coverage), never a console fetch. */
const EMPTY_COVERAGE_INPUT: CoverageInput = {
  kind: "rows",
  rows: EMPTY_ROWS,
};
const EMPTY_COLUMN_SAMPLES: ColumnSamples = new Map();

const SPINE_LABELS: Record<SpineStep, string> = {
  file: "Your file",
  columns: "Matching & sharing",
  review: "Review & create",
};

const SPINE_ORDER: ReadonlyArray<SpineStep> = ["file", "columns", "review"];

/**
 * The alert for a mint that refused this file. The mint re-parses the retained file
 * and re-checks it, so it fails in the same user-actionable ways the file step gates
 * on; both mint surfaces (create and save) render this one composition, so they
 * cannot state the same refusal in different words. Exhaustive over
 * {@link InvitationFileFailure}, so a new refusal reason cannot reach either surface
 * as the generic "something went wrong".
 */
function invitationFileAlert(failure: InvitationFileFailure): AlertContent {
  switch (failure.kind) {
    case "unreadable":
      return {
        title: "Could not read your file",
        message: sanitizeErrorForDisplay(failure.cause),
      };
    case "unnameable":
      return unnameableColumnsAlert(failure.positions);
    case "overlong":
      return overlongColumnsAlert(failure.positions);
    case "unlinkable":
      return unlinkableFileAlert(failure.refusal);
  }
}

function isSpineStep(section: Section): section is SpineStep {
  return (SPINE_ORDER as ReadonlyArray<Section>).includes(section);
}

// Exhaustive over Section (the Record keying enforces it), so a history entry
// restored by Back/Forward is admitted only when it names a live section -- a
// stale entry from before a deploy renamed a section is ignored rather than
// rendered as an empty work column.
const SECTION_SET: Record<Section, true> = {
  file: true,
  columns: true,
  review: true,
  cleaning: true,
  keys: true,
  agreement: true,
  share: true,
  save: true,
};

function isSection(value: string): value is Section {
  return value in SECTION_SET;
}

// The inviter name the sample seeds, so step 1 lands complete without the
// visitor typing one. Plainly a placeholder, consistent with the synthetic data.
const SAMPLE_INVITER_NAME = "Sample County Health Dept";

/**
 * The inviter's working surface: one console whose top bar walks the three-step
 * required spine while the work column swaps sections in place. The draft
 * seeds from the file the moment it is read (step 1) and every step-2 edit
 * flows through the shared draft model, so the Customize facts and the
 * disclosure ledger track live. Step 3 is the review-and-create step,
 * `ReviewCreateSection`.
 */
export function InviterScreen() {
  const [name, setName] = useState("");
  const [section, setSection] = useState<Section>("file");
  const [lastSpineStep, setLastSpineStep] = useState<SpineStep>("file");
  const [acquired, setAcquired] = useState<AcquiredCsv>();
  // The console profile behind the acquired shape: the console reads the file, so
  // the browser holds only the profile (name, size, mtime, columns, samples, date
  // format). It backs the mint (columns), the run (the mounted-file reference), the
  // coverage sweep, and the preview samples. Undefined on the hosted build, which
  // reads the file in the browser instead.
  const [consoleSource, setConsoleSource] = useState<ProfiledJobInput>();
  const [sourceFile, setSourceFile] = useState<File>();
  // The File System Access handle a drop attached to the selected file, where the
  // platform yielded one; captured so a managed deposit can persist a reusable
  // pointer to the input without a second picker dialog. Absent for a
  // click-selected file, a browser without the API, and the in-memory sample.
  const [sourceHandle, setSourceHandle] = useState<FileSystemFileHandle>();
  const [editor, setEditor] = useState<InviterEditor>();
  const [intakeAlert, setIntakeAlert] = useState<AlertContent>();
  const [reading, setReading] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [invitation, setInvitation] = useState<GeneratedInvitation>();
  // The current invitation as the mint fixed it for the partner's accept kit: the
  // token's own locator and the run's retain-mode choice, so the sheet cannot
  // describe a regime the authoring controls moved to after the mint. Set only
  // where an invitation is minted for a partner who accepts from the command line
  // (a console sftp/filedrop run); undefined for a WebRTC exchange and for the
  // hosted build, whose CLI transports route to the save surface and mint nothing
  // here.
  const [acceptKitExchange, setAcceptKitExchange] =
    useState<AcceptKitExchange>();
  const [minting, setMinting] = useState(false);
  const [createAlert, setCreateAlert] = useState<AlertContent>();
  const [expertMode, setExpertMode] = useState(false);
  const [editorAnnouncement, setEditorAnnouncement] = useState("");
  const [saveFields, setSaveFields] =
    useState<SaveExchangeFields>(EMPTY_SAVE_FIELDS);
  const [savedExchange, setSavedExchange] = useState<SavedExchange>();
  const [saving, setSaving] = useState(false);
  const [saveAlert, setSaveAlert] = useState<AlertContent>();
  // The console's effective SFTP connection, fetched once on a console build and
  // updated when the operator authors or clears one. Undefined before it resolves;
  // its `connection` is null when none is authored, else the credential-free
  // locator. `sftpConfigured` (below) gates the SFTP transport, and the locator is
  // authored into an sftp invitation's endpoint.
  const [sftpInfo, setSftpInfo] = useState<SftpConnectionInfo>();
  // The operator's deliberate choice to run SFTP through their own command-line
  // tool (save-a-file) instead of authoring a connection here. Reset on a new file.
  const [sftpSaveFilePreferred, setSftpSaveFilePreferred] = useState(false);
  // The console's rendezvous mount, fetched once on a console build. Undefined before
  // it resolves; `configured` gates the filedrop transport (offered iff a directory is
  // mounted), `locator` is the advisory locator minted into a filedrop invitation, and
  // `folderName` is the shared folder's own name, present only where the console has
  // one to show as the folder's name.
  const [rendezvous, setRendezvous] = useState<JobRendezvousConfig>();
  // The operator's file-handling choices for a console server-job run (retain mode
  // and the toggles that travel with it). Held here, beside the transport, because
  // the review step authors them and the run hook consumes them; the disclosure's
  // own open state rides along so a reset does not spring it open.
  const [exchangeFiles, setExchangeFiles] = useState<ExchangeFilesDraft>(
    EXCHANGE_FILES_DEFAULT,
  );
  const [exchangeFilesOpen, setExchangeFilesOpen] = useState(false);
  // The operator's connection-tuning choices for the same run (polling, timeouts,
  // the retry budget, and the SFTP session mode), held beside the file-handling
  // draft for the same reasons.
  const [connectionTuning, setConnectionTuning] =
    useState<ConnectionTuningDraft>(CONNECTION_TUNING_DEFAULT);
  const [connectionTuningOpen, setConnectionTuningOpen] = useState(false);
  // The operator's per-run diagnostic and recovery choices for the same run, held
  // beside the two drafts above for the same reasons.
  const [runDiagnostics, setRunDiagnostics] = useState<RunDiagnosticsDraft>(
    RUN_DIAGNOSTICS_DEFAULT,
  );
  const [runDiagnosticsOpen, setRunDiagnosticsOpen] = useState(false);
  // The operator's receipt-signing and retention choices for the same run, held
  // beside the three drafts above for the same reasons.
  const [receipts, setReceipts] = useState<ReceiptsDraft>(RECEIPTS_DEFAULT);
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  const [demoActive, setDemoActive] = useState(false);
  const [manageStatus, setManageStatus] = useState<ManageOfferStatus>("idle");

  // Fetch the console's authored SFTP connection once on a console build; one
  // fetch per console serves the session, and the default transport reads its
  // presence (SFTP when authored, else the filedrop save-a-file card). The helper
  // resolves to null on any failure or when none is authored, so Create then falls
  // back to the save-file surface rather than arming a server-job run with no
  // connection.
  useEffect(() => {
    if (!isConsoleBuild() || sftpInfo !== undefined) return;
    let cancelled = false;
    void fetchSftpConnection().then((info) => {
      if (!cancelled) setSftpInfo(info);
    });
    return () => {
      cancelled = true;
    };
  }, [sftpInfo]);

  // Fetch the console's rendezvous mount once on a console build; the mount is
  // boot-static on the server, so one fetch per console serves the session. The
  // helper resolves to `{ configured: false }` on any failure, so the filedrop
  // card stays disabled unless the console confirms a mounted directory.
  useEffect(() => {
    if (!isConsoleBuild() || rendezvous !== undefined) return;
    let cancelled = false;
    void fetchJobRendezvous().then((config) => {
      if (!cancelled) setRendezvous(config);
    });
    return () => {
      cancelled = true;
    };
  }, [rendezvous]);

  const sftpConnection =
    sftpInfo === undefined ? undefined : sftpInfo.connection;
  const sftpConfigured = sftpConnection != null;
  const rendezvousConfigured = rendezvous?.configured === true;
  const available = availableTransports(
    isConsoleBuild(),
    sftpConfigured,
    rendezvousConfigured,
    sftpSaveFilePreferred,
  );
  const transport = editor?.transport ?? available.defaultTransport;
  // How the chosen transport runs, from the chooser's own policy (which offers a
  // console filedrop as a save-a-file card, unlike the raw driver mapping): the
  // create branch and the live run both read it.
  const chosenRunMode = transportRunMode(available, transport);

  // The console reads the mounted file, so a server-job run holds only a REFERENCE
  // (the opaque name), never the content.
  const inputSource: JobInputSource | undefined =
    consoleSource !== undefined
      ? { kind: "workFile", name: consoleSource.name }
      : undefined;

  // The live run starts the moment a live invitation exists (the hook drives
  // the partner exchange right away) and is torn down when the invitation is
  // discarded or the console unmounts. A `save-file` run mode never runs live:
  // its invitation is minted for the save surface, so it is withheld from the
  // hook and `invitation` alone (not the withheld value) proves nothing dials
  // for a saved exchange. A `server-job` run mode runs live too -- the console
  // performs it -- so it drives the hook exactly as `browser` does.
  const runsLive = chosenRunMode !== "save-file";
  // Which tuning controls the chosen transport can hold: the SFTP session mode
  // applies only where a session exists.
  const tuningCapabilities =
    transport === "sftp" ? SFTP_CONNECTION_TUNING : FILEDROP_CONNECTION_TUNING;
  // The tuning options the run holds, resolved from both authored drafts in one
  // place: the run and the partner's accept kit read the same block, so the
  // sheet cannot describe a file-handling regime the run does not have.
  const runOptions = withConnectionTuning(
    exchangeFilesOptions(exchangeFiles, CONFIG_EXCHANGE_FILES),
    connectionTuning,
    tuningCapabilities,
  );
  const {
    run,
    outputs,
    failure,
    warnings,
    jobId,
    reattached,
    reattaching,
    tryAgain,
    abandonRun,
  } = useInviterExchange({
    invitation: runsLive ? invitation : undefined,
    inviterName: editor?.draft.identity ?? "",
    channel: transport,
    inputSource,
    sftpConfigured,
    options: runOptions,
    runDiagnostics: runDiagnosticsIntentFields(runDiagnostics),
    receipts: receiptsIntentFields(receipts),
  });

  // The coverage input, unified across builds: the browser's parsed rows on the
  // hosted build, the mounted-file reference on the console (its sweep is a fetch,
  // not parsed rows). Memoized so a standardization edit reuses the provider and
  // only a new file rebuilds it. The console reads no rows -- `acquired.rawRows` is a
  // throwing getter there -- so this never touches it on that path.
  const coverageInput = useMemo<CoverageInput>(() => {
    if (consoleSource !== undefined)
      return { kind: "workFile", reference: { name: consoleSource.name } };
    if (!isConsoleBuild() && acquired !== undefined)
      return { kind: "rows", rows: acquired.rawRows };
    return EMPTY_COVERAGE_INPUT;
  }, [acquired, consoleSource]);

  // The per-column preview samples the Cleaning tab's before/after preview reads:
  // computed from the browser rows on the hosted build, read from the server-side
  // profile on the console. Kept off `acquired.rawRows` on the console for the same
  // reason as the coverage input.
  const columnSamples = useMemo<ColumnSamples>(() => {
    if (consoleSource !== undefined) return consoleSource.columnSamples;
    if (!isConsoleBuild() && acquired !== undefined)
      return columnSamplesFromRows(acquired.rawRows, acquired.columns);
    return EMPTY_COLUMN_SAMPLES;
  }, [acquired, consoleSource]);

  // Full-CSV coverage for the Cleaning tab, the Customize menu's Cleaning-attention
  // value, and the coverage Problems entry -- one sweep shared by all three, lifted
  // to the console so the fact and the create gate render regardless of the active
  // section (the AcceptorScreen lift). The hook must run every render, so it takes
  // stable empty inputs until a file is acquired.
  const {
    rates,
    pending: ratesPending,
    unavailable: ratesUnavailable,
  } = useNonEmptyRates(
    coverageInput,
    editor?.draft.standardization ?? EMPTY_STANDARDIZATION,
    coverageProvider,
  );
  const cleaningAttention = inviterCleaningAttention(
    editor,
    rates,
    ratesUnavailable,
  );
  const coverageProblems = cleaningCoverageProblems(editor, rates);

  // The operator authored an SFTP connection in-console (its credential-free
  // projection): hold it and drop any save-a-file preference so the run mode flips
  // to server-job. The connection lives in console memory, scoped to the one
  // exchange; the browser holds only the locator. A freshly authored server is a
  // different rendezvous directory, so any sweep confirmation is re-asked.
  function authorSftpConnection(connection: SftpConnectionProjection) {
    setSftpInfo({ connection });
    setSftpSaveFilePreferred(false);
    setRunDiagnostics(runDiagnosticsAfterRetarget);
  }

  // Clear the authored connection: forget it on the console and locally, so the
  // card returns to the authoring empty state.
  function clearSftpConnection() {
    setSftpInfo({ connection: null });
    void deleteSftpConnection();
  }

  // The failure alerts' "start over with a fresh invitation": the seal lifts
  // with every input intact, the failed invitation is discarded (its run has
  // already torn down; the hook drops the run state), and the operator lands
  // back on Review & create, where the next create mints a fresh secret.
  function startOver() {
    // A server-job run the operator is leaving is abandoned: cancel-if-running
    // and DELETE, which also frees the console's single slot for the fresh
    // create. A no-op on a browser run.
    abandonRun();
    setEditor((current) =>
      current === undefined ? current : unsealEditor(current),
    );
    setInvitation(undefined);
    setAcceptKitExchange(undefined);
    setSavedExchange(undefined);
    setManageStatus("idle");
    goTo("review");
  }

  // Deposit a managed-exchange record for this exchange as the inviter: the
  // standing terms plus the secret embedded in the just-minted invitation, so the
  // partnership can run again later. The connection block is composed from this
  // app's own signaling location -- the same window.location source the
  // invitation's endpoint was built from -- not read back off the encoded token.
  // The secret is the minted invitation's, not the one-shot run's own derived
  // rotation; only a managed re-run rotates it. Declining is simply not pressing
  // Manage, so there is no discard path here.
  async function manageExchange(choices: ManageOfferChoices) {
    if (invitation === undefined || editor === undefined) return;
    setManageStatus("depositing");
    try {
      const connection = webrtcLocatorFromEndpoint(
        webrtcEndpointFromLocation(invitationLocation()),
      );
      await createManagedExchange(
        buildManagedDeposit(
          {
            documentParts: {
              side: "inviter",
              linkageTerms: invitation.linkageTerms,
              ...(invitation.metadata !== undefined
                ? { metadata: invitation.metadata }
                : {}),
              ...(invitation.standardization !== undefined
                ? { standardization: invitation.standardization }
                : {}),
              // The token's own published set (including the strict empty set),
              // so the persisted send-side commitment is the one the partner
              // locked in -- never a re-derivation that could drift from it.
              disclosedPayloadColumns: invitation.disclosedPayloadColumns,
              ...(invitation.includeOwnColumns !== undefined
                ? { includeOwnColumns: invitation.includeOwnColumns }
                : {}),
            },
            connection,
            sharedSecret: invitation.sharedSecret,
            ...(sourceHandle !== undefined
              ? { inputFileHandle: sourceHandle }
              : {}),
            choices,
          },
          Date.now(),
        ),
      );
      setManageStatus("deposited");
    } catch (error) {
      console.error(
        "managed exchange deposit failed:",
        error instanceof Error ? error.name : typeof error,
      );
      whenDiagnostic(() =>
        console.error("managed exchange deposit failed (detail):", error),
      );
      setManageStatus("error");
    }
  }

  // Apply a section arriving from a browser Back/Forward: set the step state
  // without pushing a new history entry (the browser already moved the cursor).
  // The console stays mounted throughout, so the loaded file, the derived terms,
  // and every in-progress edit survive the transition untouched. A section whose
  // backing state is gone (a `share` entry left behind by a start-over) clamps
  // to a step that can still render; the settled section is returned so the hook
  // rewrites the dead entry.
  function restoreSection(next: Section): Section {
    const settled = restorableSection(next, {
      hasInvitation: invitation !== undefined,
      isCliTransport: isCliTransport(transport),
    });
    if (isSpineStep(settled)) setLastSpineStep(settled);
    setSection(settled);
    return settled;
  }

  const { pushStep } = useStepHistory("file", (step) => {
    if (isSection(step)) return restoreSection(step);
  });

  // The unload guard arms once a file is loaded and disarms once the exchange is
  // finalized -- the invitation minted (a browser run is listening) or the
  // exchange file saved. A console server-job run is NOT armed: leaving the page
  // does not abandon it (the console keeps running it and the recovery panel is
  // the way back), so a prompt would assert a loss that does not happen.
  useUnloadGuard({
    hasFile: acquired !== undefined,
    finalized: invitation !== undefined || savedExchange !== undefined,
    demoActive,
  });

  // The live exchange itself, armed exactly where the guard above disarms and
  // held until the run settles: this browser listens from the mint onward,
  // an unload ends the session for BOTH parties, and the app-shell update
  // notice renders its Reload button above this route throughout the run. A
  // server-job run stays out for the same reason it is out above -- the
  // console performs it. A sample-seeded mint (?demo=1 walked to a real mint)
  // starts a real session with a real secret while demoActive is still true,
  // but its partner is ordinarily the same operator's other tab, so losing it
  // is judged not worth an unload prompt.
  useBeforeUnloadPrompt(
    chosenRunMode === "browser" &&
      invitation !== undefined &&
      !demoActive &&
      outputs === undefined &&
      failure === undefined,
  );

  function goTo(next: Section) {
    if (next === section) return;
    if (isSpineStep(next)) setLastSpineStep(next);
    setSection(next);
    pushStep(next);
  }

  // Non-announcing edits clear the live region, so a stale notice never lingers
  // and a repeated identical notice re-announces.
  function applyEditor(next: InviterEditor) {
    setEditor(next);
    setEditorAnnouncement("");
  }

  // A parse may still be in flight when the surface unmounts or a newer file
  // is dropped; the id lets the stale resolution fall on the floor instead of
  // clobbering current state, and the abort tears the parse worker down so a
  // discarded read does not run to completion (the FileAcquire pattern).
  const parseId = useRef(0);
  const parseAbort = useRef<AbortController | undefined>(undefined);
  useEffect(
    () => () => {
      parseId.current += 1;
      parseAbort.current?.abort();
    },
    [],
  );

  // Seed the synthetic sample when the visitor arrived at `?demo=1` (the
  // under-dropzone entry and the lobby link both route here). The param is read
  // once and stripped from the URL with replaceState so a reload or a shared
  // link does not re-seed; replaceState adds no history entry and leaves the
  // step-history integration (which lives in history.state, not the URL) alone.
  // The seed rides the same readFile intake a dropped file does, so the stale-
  // parse guard and every derived-terms path are shared, not forked.
  const seededDemo = useRef(false);
  useEffect(() => {
    if (seededDemo.current) return;
    seededDemo.current = true;
    // The sample seed reads an in-memory File in the browser; the console never
    // reads a file in the browser (its intake is the mounted-directory picker), so
    // the in-place seed is hidden there per the sample-data decision.
    if (isConsoleBuild()) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("demo") !== "1") return;
    params.delete("demo");
    const query = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + (query === "" ? "" : `?${query}`),
    );
    loadSample();
  }, []);

  // Moving between sections replaces the whole work column, so focus is sent
  // to the incoming h1 (they have tabIndex -1) or a screen-reader user is
  // left on a control that no longer exists. Skipped on mount: initial focus
  // stays at the top of the document.
  const headingRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) headingRef.current?.querySelector("h1")?.focus();
    mounted.current = true;
  }, [section]);

  // A failed read discards any prior read as well: the file card, the
  // recommended-terms callout, and the Continue gate all vouch for
  // `acquired`/`editor`, so leaving them set would present the previous file
  // as the one the operator just dropped.
  function discardRead(alert: AlertContent) {
    setAcquired(undefined);
    setConsoleSource(undefined);
    setSourceFile(undefined);
    setSourceHandle(undefined);
    setEditor(undefined);
    setDemoActive(false);
    setIntakeAlert(alert);
  }

  async function readFile(file: File, seed?: { name: string }) {
    const id = ++parseId.current;
    parseAbort.current?.abort();
    const controller = new AbortController();
    parseAbort.current = controller;
    // A real drop clears the sample marker; the sample seed sets it. Editing the
    // sample's terms never re-reads, so the marker survives edits.
    setDemoActive(seed !== undefined);
    // The sample seed has its own inviter name so step 1 lands complete; a
    // real drop keeps whatever the operator typed. Applied before the read so
    // the derived editor's identity and the name field agree.
    const identity = seed?.name ?? name;
    if (seed !== undefined) setName(seed.name);
    setReading(true);
    setIntakeAlert(undefined);
    try {
      const result = await loadCSVFileOffMainThread(file, {
        signal: controller.signal,
      });
      if (id !== parseId.current) return;
      const columns = result.meta.fields ?? [];
      const emptyPositions = emptyColumnPositions(columns);
      if (emptyPositions.length > 0) {
        discardRead(unnameableColumnsAlert(emptyPositions));
        return;
      }
      const csv: AcquiredCsv = {
        fileName: file.name,
        sizeBytes: file.size,
        rawRows: result.data,
        columns,
        rowCount: result.data.length,
      };
      const seeded = editorFromCsv(identity, csv);
      setAcquired(csv);
      setSourceFile(file);
      setSourceHandle(capturedInputHandle(file));
      setEditor(seeded);
      // A fresh file re-seeds the terms and resets the transport to browser;
      // any exchange file saved for the prior read no longer describes them.
      setSavedExchange(undefined);
      if (seeded.draft.keys.length === 0)
        setIntakeAlert({
          title: "This file cannot be matched",
          message:
            "None of the matching keys can be built from this file's columns. Matching needs columns like name, date of birth, Social Security number, ZIP code, phone, or email.",
        });
    } catch (error) {
      if (id !== parseId.current) return;
      discardRead({
        title: "The file could not be read",
        message: sanitizeErrorForDisplay(error),
      });
    } finally {
      if (id === parseId.current) setReading(false);
    }
  }

  // Commit a profiled mounted file (the console picker's "Use this file") as
  // the acquired file. A blank header cell is refused early with the shared
  // unnameable alert (as readFile does), or core's inferMetadata would throw
  // at seed time and unmount the console. Re-profiling the same committed file
  // keeps the authored draft when its columns are unchanged and only refreshes
  // the profile-derived facts; otherwise it reseeds from the profile.
  function commitConsoleFile(profile: ProfiledJobInput) {
    const emptyPositions = emptyColumnPositions(profile.columns);
    if (emptyPositions.length > 0) {
      discardRead(unnameableColumnsAlert(emptyPositions));
      return;
    }
    const csv = consoleAcquiredCsv({
      fileName: profile.name,
      sizeBytes: profile.sizeBytes,
      columns: profile.columns,
      rowCount: profile.rowCount,
      dateInputFormat: profile.dateInputFormat,
    });
    const reseed = () => {
      const seeded = editorFromCsv(name, csv);
      setConsoleSource(profile);
      setAcquired(csv);
      setEditor(seeded);
      // A fresh file re-seeds the terms and resets the transport to the default; any
      // exchange file saved for the prior file no longer describes them.
      setSavedExchange(undefined);
      setIntakeAlert(
        seeded.draft.keys.length === 0
          ? {
              title: "This file cannot be matched",
              message:
                "None of the matching keys can be built from this file's columns. Matching needs columns like name, date of birth, Social Security number, ZIP code, phone, or email.",
            }
          : undefined,
      );
    };
    if (
      editor !== undefined &&
      editor.sealed !== true &&
      consoleSource !== undefined &&
      consoleSource.name === profile.name
    ) {
      const columnsUnchanged =
        consoleSource.columns.length === profile.columns.length &&
        consoleSource.columns.every(
          (column, index) => column === profile.columns[index],
        );
      if (columnsUnchanged) {
        setConsoleSource(profile);
        setAcquired(csv);
        setEditor(editorReprofiled(editor, csv));
        setSavedExchange(undefined);
        setEditorAnnouncement(
          "Re-profiled with the file's current contents; your customizations are unchanged.",
        );
        return;
      }
      reseed();
      setEditorAnnouncement(
        "The file's columns changed, so your customizations were reset to the defaults.",
      );
      return;
    }
    reseed();
  }

  // Load the synthetic inviter sample into the live spine: build the in-memory
  // File and pass it through the same readFile intake a dropped file uses, with
  // a sample inviter name so step 1 lands complete. The mint path stays
  // demo-free -- from here the visitor drives every real step by hand.
  function loadSample() {
    void readFile(sampleInviterFile(), { name: SAMPLE_INVITER_NAME });
  }

  // Clear the sample back to a fresh exchange: drop the read, the derived terms,
  // and every demo-seeded field in place, and return to step 1. A parse still in
  // flight is discarded (its resolution falls on the floor). Nothing about the
  // demo persists.
  function clearSample() {
    parseId.current += 1;
    parseAbort.current?.abort();
    setName("");
    setAcquired(undefined);
    setConsoleSource(undefined);
    setSourceFile(undefined);
    setSourceHandle(undefined);
    setEditor(undefined);
    setIntakeAlert(undefined);
    setReading(false);
    setDemoActive(false);
    setSavedExchange(undefined);
    setInvitation(undefined);
    setAcceptKitExchange(undefined);
    setManageStatus("idle");
    goTo("file");
  }

  function updateName(next: string) {
    setName(next);
    setEditor((current) =>
      current === undefined ? current : editorWithIdentity(current, next),
    );
  }

  function applyColumnEdit(result: {
    editor: InviterEditor;
    demotedIdentifiers: Array<string>;
  }) {
    setEditor(result.editor);
    setAnnouncement(demotionNotice(result.demotedIdentifiers));
  }

  // The mint's input source, build-aware: the retained browser File on the hosted
  // build (re-parsed at the fail-closed parse boundary), or the console's profiled
  // columns bound directly (the console never reads the file in the browser, so the
  // mint binds the profiled columns without a re-parse; the satisfiability re-check
  // stays columns-based).
  function mintSource():
    { file: File } | { profiledColumns: Array<string> } | undefined {
    if (consoleSource !== undefined)
      return { profiledColumns: consoleSource.columns };
    return sourceFile !== undefined ? { file: sourceFile } : undefined;
  }

  // Minting binds the invitation to the file's columns through generateInvitation --
  // re-parsing the retained File on the hosted build (the fail-closed parse
  // boundary), or the profiled columns on the console -- so the embedded terms and
  // the satisfiability re-check bind to one view of the file.
  async function createInvitation() {
    const source = mintSource();
    if (editor === undefined || source === undefined) return;
    // The Create button is disabled on any open problem; this repeats the gate
    // because spineProblems covers the identifier conflict and coverageProblems
    // the silent-empty coverage, neither of which canGenerate alone captures.
    if (spineProblems(editor).length > 0 || coverageProblems.length > 0) return;
    const validation = reviewValidation(editor);
    if (!validation.canGenerate || validation.terms === undefined) return;
    // A save-file run mode seals the terms exactly as the live path does but
    // mints NOTHING here: the code and the config YAML are minted together on
    // the save surface, from the authored locator. Seal, discard any prior
    // saved artifacts, and route to save. A server-job run mode (sftp on the
    // console) instead mints here and routes to the live run, exactly as the
    // browser path does.
    if (chosenRunMode === "save-file") {
      setEditor(sealEditor(editor));
      setSavedExchange(undefined);
      setSaveAlert(undefined);
      goTo("save");
      return;
    }
    // An sftp server-job run authors the invitation's endpoint from the
    // authored connection's locator -- the same connectionEndpoint field the
    // save surface's free-text fields feed -- so the partner's CLI meets the
    // console where it will actually connect. A missing connection here means
    // the fetch had not resolved or reported none; refuse rather than mint a
    // code with no rendezvous.
    let connectionEndpoint: ConnectionEndpointRequest | undefined;
    // The accept kit's locator is the SAME value minted into the token, taken
    // from the one place it is built, so the sheet can print back only what the
    // partner's own invitation already contains.
    let kitEndpoint: AcceptKitEndpoint | undefined;
    if (transport === "sftp") {
      if (sftpConnection == null) return;
      // The create gate holds a split-directory connection whose retain mode was
      // turned off after it was authored; repeated here because everything past
      // this point is partner-facing -- the minted endpoint and the accept kit's
      // file-handling disclosure -- for a rendezvous the run would refuse.
      if (
        splitDirectoryRetainProblem(
          sftpConnection,
          exchangeFiles.retainFiles,
        ) !== undefined
      )
        return;
      const sftpEndpoint = sftpEndpointForConnection(sftpConnection);
      connectionEndpoint = sftpEndpoint;
      kitEndpoint = sftpEndpoint;
    } else if (transport === "filedrop") {
      // The create gate holds a split rendezvous whose retain mode was turned off
      // after the transport was chosen; repeated here because everything past this
      // point is partner-facing -- the minted endpoint and the accept kit's
      // file-handling disclosure -- for a rendezvous the run would refuse.
      if (
        splitRendezvousRetainProblem(rendezvous, exchangeFiles.retainFiles) !==
        undefined
      )
        return;
      // A console filedrop server-job's invitation contains NAMES as its advisory
      // locator -- one, or the split pair -- never the console's absolute paths;
      // the server decides which names those are. The mounts are server-side, so a
      // missing locator means the rendezvous state changed mid-create: refuse
      // rather than mint a code with none.
      const filedropEndpoint = filedropEndpointForRendezvous(rendezvous);
      if (filedropEndpoint === undefined) return;
      connectionEndpoint = filedropEndpoint;
      // The sheet is the one place that CALLS a locator the shared folder's name,
      // so it gets the names only where the console has them; where a locator is
      // the mount point it was bound at, the sheet says nothing rather than
      // asking the partner to match a name that is not the folder's.
      kitEndpoint = acceptKitEndpointForRendezvous(rendezvous);
    }
    // One value behind both partner-facing statements of the mode -- the
    // token's declaration and the accept kit's file-handling disclosure --
    // derived by the rule the mint applies: the options block the run itself
    // holds, ORed with the endpoint's own shape. Gated on a file-sync endpoint
    // because retain mode is a file-sync setting; a webrtc mint declares
    // nothing.
    const declaresRetainedFiles = invitationDeclaresRetainedFiles({
      connectionEndpoint,
      retainsFiles:
        connectionEndpoint !== undefined && runOptions?.retainFiles === true,
    });
    setMinting(true);
    setCreateAlert(undefined);
    try {
      const minted = await generateInvitation({
        inviterName: editor.draft.identity,
        ...source,
        location: invitationLocation(),
        lifetimeSeconds: editor.draft.lifetimeSeconds,
        linkageTerms: validation.terms,
        metadata: editor.draft.metadata,
        standardization: editor.draft.standardization,
        includeOwnColumns: editor.draft.includeOwnColumns ?? "none",
        ...(connectionEndpoint !== undefined ? { connectionEndpoint } : {}),
        retainsFiles: declaresRetainedFiles,
      });
      setEditor(sealEditor(editor));
      setInvitation(minted);
      // The bilateral file-handling choices are captured beside the locator:
      // the lockless rendezvous from the options block the run itself holds
      // rather than from the raw toggles -- retain mode's implication of it
      // included -- and retain mode from the value the token declares, so the
      // sheet cannot state a mode the partner's invitation does not.
      setAcceptKitExchange(
        kitEndpoint === undefined
          ? undefined
          : {
              endpoint: kitEndpoint,
              retainFiles: declaresRetainedFiles,
              locklessRendezvous: runOptions?.locklessRendezvous === true,
            },
      );
      setManageStatus("idle");
      goTo("share");
    } catch (error) {
      if (error instanceof InvitationFileError) {
        // The mint re-parses the retained file, so it can fail in the same
        // user-actionable ways step 1 gates on (the file changed on disk, or
        // its satisfiability shifted with the edited terms); show the same
        // shared alerts rather than a generic failure.
        setCreateAlert(invitationFileAlert(error.failure));
      } else {
        // Internal and non-user-actionable: a fixed message avoids echoing
        // internals into a secret-bearing flow, the default log states only
        // the error type, and the detail reaches the console only under
        // diagnostic mode.
        console.error(
          "invitation creation failed:",
          error instanceof Error ? error.name : typeof error,
        );
        whenDiagnostic(() =>
          console.error("invitation creation failed (detail):", error),
        );
        setCreateAlert({
          title: "Could not create the invitation",
          message:
            "Something went wrong while creating the invitation. Your terms are unchanged - try again.",
        });
      }
    } finally {
      setMinting(false);
    }
  }

  // Mint the invitation code and the CLI config YAML together and trigger the
  // download. The invitation contains the authored sftp/filedrop locator; the
  // YAML is derived from that same minted invitation and the same locator, so
  // the code and the file point at one rendezvous. Re-saving after an edit
  // re-mints both: the atomic savedExchange update replaces the old code and
  // file in one step, so a stale code can never sit beside a new file.
  async function saveExchangeFile() {
    const source = mintSource();
    if (editor === undefined || source === undefined) return;
    if (!isCliTransport(transport)) return;
    const cliTransport: CliTransport = transport;
    if (saveExchangeError(cliTransport, saveFields) !== undefined) return;
    const validation = reviewValidation(editor);
    if (!validation.canGenerate || validation.terms === undefined) return;
    setSaving(true);
    setSaveAlert(undefined);
    try {
      const minted = await generateInvitation({
        inviterName: editor.draft.identity,
        ...source,
        location: invitationLocation(),
        lifetimeSeconds: editor.draft.lifetimeSeconds,
        linkageTerms: validation.terms,
        metadata: editor.draft.metadata,
        standardization: editor.draft.standardization,
        includeOwnColumns: editor.draft.includeOwnColumns ?? "none",
        connectionEndpoint: endpointRequestFor(cliTransport, saveFields),
      });
      // Mint the config from the SAME invitation the code came from; a
      // ZodError here (a malformed locator the endpoint schema also rejects)
      // aborts before any download, so a code is never displayed with no file.
      const yaml = mintExchangeFile(
        exchangeFileInputFor(cliTransport, saveFields, minted),
      );
      const fileName = exchangeFileName(new Date());
      triggerBlobDownload(fileName, yaml, "application/yaml");
      setSavedExchange({ invitation: minted, fileName });
    } catch (error) {
      if (error instanceof InvitationFileError) {
        setSaveAlert(invitationFileAlert(error.failure));
      } else {
        // Internal and non-user-actionable (a schema/encoding fault): a fixed
        // message keeps internals out of a secret-bearing flow, the default
        // log states only the error type, and the detail is diagnostic-gated.
        console.error(
          "exchange file save failed:",
          error instanceof Error ? error.name : typeof error,
        );
        whenDiagnostic(() =>
          console.error("exchange file save failed (detail):", error),
        );
        setSaveAlert({
          title: "Could not save the exchange file",
          message:
            "Something went wrong while saving. Your terms are unchanged - try again.",
        });
      }
    } finally {
      setSaving(false);
    }
  }

  // Write the partner's accept kit to disk through the same blob download the
  // exchange-file save uses. The sheet is composed from the minted exchange and
  // this build's own release version alone: it contains no secret, no invitation
  // token (the partner pastes their own copy over the sheet's placeholder), and
  // nothing else from this machine. The retain-mode flag selects fixed text and
  // a fixed command flag rather than reaching the sheet as a value.
  function downloadAcceptKit() {
    if (acceptKitExchange === undefined) return;
    triggerBlobDownload(
      acceptKitFileName(new Date()),
      buildAcceptKit({ ...acceptKitExchange, version: psilinkVersion() }),
      "text/plain",
    );
  }

  const linkable = editor !== undefined && editor.draft.keys.length > 0;
  const fileReady = name.trim().length > 0 && linkable;
  const sealed = editor?.sealed === true;

  // Inside a Customize tab no spine step is current; the step the operator
  // came from stays navigable like any completed step. The share and save
  // sections have their own rails, so neither is a Customize tab.
  const inTab =
    !isSpineStep(section) && section !== "share" && section !== "save";
  const currentPosition = SPINE_ORDER.indexOf(
    isSpineStep(section) ? section : lastSpineStep,
  );
  const steps: Array<RailStep> =
    section === "share"
      ? timelineSteps(run)
      : SPINE_ORDER.map((step, position) => {
          const state =
            !inTab && step === section
              ? "current"
              : position < currentPosition || (inTab && step === lastSpineStep)
                ? "done"
                : "pending";
          return {
            label: SPINE_LABELS[step],
            state,
            onSelect: state === "done" ? () => goTo(step) : undefined,
          };
        });

  // The save surface's static timeline: Save file is current before the save
  // and done after it; the browser never observes the later steps, so Partner
  // accepts, CLI runs, and Results stay pending throughout.
  const saveSteps: Array<RailStep> = [
    {
      label: "Save file",
      state: savedExchange === undefined ? "current" : "done",
    },
    { label: "Partner accepts", state: "pending" },
    { label: "CLI runs", state: "pending" },
    { label: "Results", state: "pending" },
  ];

  const facts = inviterRailFacts(editor, cleaningAttention).map((fact) => ({
    ...fact,
    onSelect: editor !== undefined ? () => goTo(fact.target) : undefined,
    current: section === fact.target,
  }));

  // The coverage problem is file-dependent (the full-CSV sweep), so it lives
  // beside the draft-validation spineProblems rather than inside it; merged here
  // so the work-column Problems block, the create gate, and its status line all
  // see one problem list.
  const openProblems = sealed
    ? []
    : [...spineProblems(editor), ...coverageProblems];
  const problems = openProblems.map((problem) => ({
    label: problem.message,
    key: problem.key,
    onSelect: () => goTo(problem.target),
  }));

  return (
    <WorkShell
      topBar={
        section === "share" ? (
          <TopBar
            navLabel="Exchange progress"
            steps={steps}
            transportNote="Browser"
          />
        ) : section === "save" && isCliTransport(transport) ? (
          <TopBar
            navLabel="Exchange progress"
            steps={saveSteps}
            transportNote={saveRailNote(transport)}
          />
        ) : (
          <TopBar navLabel="Exchange setup" steps={steps} />
        )
      }
      ledger={
        <Ledger
          tag={
            sealed ? "Terms locked when the invitation was created" : undefined
          }
          demoNotice={
            demoActive
              ? {
                  label: "Sample data (synthetic records)",
                  ...(sealed ? {} : { onClear: clearSample }),
                }
              : undefined
          }
          customize={sealed ? undefined : facts}
          rows={inviterLedgerRows(
            editor,
            savedExchange?.invitation.expires ?? invitation?.expires,
            outputs === undefined ? undefined : ledgerOutcomeOf(outputs),
          ).map((row) => ({
            label: row.label,
            reference: row.reference,
            muted: row.muted,
            shareBar: row.shareBar,
            value: Array.isArray(row.value) ? (
              <>
                {row.value.map((line, index) => (
                  <Fragment key={line}>
                    {index > 0 && <br />}
                    {line}
                  </Fragment>
                ))}
              </>
            ) : (
              row.value
            ),
          }))}
          footer={
            section === "save" && isCliTransport(transport)
              ? saveTrustFooter()
              : liveRunLedgerFooter(
                  chosenRunMode === "server-job",
                  outputs !== undefined,
                )
          }
        />
      }
    >
      <div ref={headingRef}>
        <Problems problems={problems} />
        {/* The console's idle entry state (no file acquired): a way back to an
            exchange still running from a prior visit. Renders nothing when there
            is none to recover. */}
        {isConsoleBuild() && section === "file" && acquired === undefined && (
          <RecoveredExchangePanel />
        )}
        {section === "file" && (
          <YourFileSection
            name={name}
            onNameChange={updateName}
            onFile={(file) => void readFile(file)}
            reading={reading}
            acquired={acquired}
            linkable={linkable}
            alert={intakeAlert}
            committed={
              consoleSource !== undefined
                ? { name: consoleSource.name }
                : undefined
            }
            onCommit={commitConsoleFile}
            onContinue={() => {
              if (fileReady) goTo("columns");
            }}
            onLoadSample={loadSample}
            onDownloadSamples={downloadSampleCsvs}
          />
        )}
        {section === "columns" &&
          editor !== undefined &&
          acquired !== undefined && (
            <MatchingSharingSection
              metadata={editor.draft.metadata}
              onColumnType={(columnName: string, type: SemanticType) =>
                applyColumnEdit(
                  editorWithColumnType(editor, acquired, columnName, type),
                )
              }
              onColumnDisclosure={(
                columnName: string,
                choice: DisclosureChoice,
              ) =>
                applyColumnEdit(
                  editorWithColumnDisclosure(
                    editor,
                    acquired,
                    columnName,
                    choice,
                  ),
                )
              }
              ownColumns={
                ownColumnsActionable({
                  algorithm: editor.draft.algorithm,
                  output: outputForDirection(editor.draft.outputDirection),
                })
                  ? (editor.draft.includeOwnColumns ?? "none")
                  : undefined
              }
              onOwnColumns={(choice) =>
                applyEditor(editorWithIncludeOwnColumns(editor, choice))
              }
              announcement={announcement}
              onContinue={() => goTo("review")}
            />
          )}
        {section === "review" &&
          editor !== undefined &&
          acquired !== undefined && (
            <>
              <ReviewCreateSection
                editor={editor}
                csv={acquired}
                problems={openProblems}
                minting={minting}
                sftpConnection={sftpConnection}
                sftpSaveFilePreferred={sftpSaveFilePreferred}
                rendezvous={rendezvous}
                exchangeFiles={exchangeFiles}
                exchangeFilesOpen={exchangeFilesOpen}
                onExchangeFiles={setExchangeFiles}
                onExchangeFilesOpen={setExchangeFilesOpen}
                connectionTuning={connectionTuning}
                connectionTuningOpen={connectionTuningOpen}
                onConnectionTuning={setConnectionTuning}
                onConnectionTuningOpen={setConnectionTuningOpen}
                runDiagnostics={runDiagnostics}
                runDiagnosticsOpen={runDiagnosticsOpen}
                onRunDiagnostics={setRunDiagnostics}
                onRunDiagnosticsOpen={setRunDiagnosticsOpen}
                receipts={receipts}
                receiptsOpen={receiptsOpen}
                onReceipts={setReceipts}
                onReceiptsOpen={setReceiptsOpen}
                onLifetime={(seconds) =>
                  applyEditor(editorWithLifetime(editor, seconds))
                }
                onDirection={(direction) =>
                  applyEditor(editorWithOutputDirection(editor, direction))
                }
                onTransport={(next) => {
                  applyEditor(editorWithTransport(editor, next));
                  // A different transport is a different rendezvous directory,
                  // so any sweep confirmation is re-asked.
                  setRunDiagnostics(runDiagnosticsAfterRetarget);
                }}
                onAuthorConnection={authorSftpConnection}
                onClearConnection={clearSftpConnection}
                onUseCliForSftp={() => setSftpSaveFilePreferred(true)}
                onRunHereForSftp={() => setSftpSaveFilePreferred(false)}
                onReset={() => {
                  setEditor(resetToRecommended(editor, acquired));
                  setEditorAnnouncement("Reset to the default settings.");
                }}
                onCreate={() => void createInvitation()}
                onNavigate={goTo}
              />
              {createAlert !== undefined && (
                <Alert
                  color="red"
                  title={createAlert.title}
                  icon={<IconAlertCircle />}
                  mt="md"
                >
                  <span style={{ whiteSpace: "pre-line" }}>
                    {createAlert.message}
                  </span>
                </Alert>
              )}
            </>
          )}
        {section === "cleaning" &&
          editor !== undefined &&
          acquired !== undefined && (
            <CleaningTab
              editor={editor}
              columnSamples={columnSamples}
              expertMode={expertMode}
              rates={rates}
              pending={ratesPending}
              coverageUnavailable={ratesUnavailable}
              onFieldSteps={(output, fieldSteps) =>
                applyEditor(editorWithFieldSteps(editor, output, fieldSteps))
              }
              onFieldInput={(output, input) =>
                applyEditor(editorWithFieldInput(editor, output, input))
              }
              onFieldAdded={(type) =>
                applyEditor(editorWithFieldAdded(editor, type))
              }
              onFieldRemoved={(output) =>
                applyEditor(editorWithFieldRemoved(editor, output))
              }
              onResetCleaning={() => {
                setEditor(editorWithRecommendedCleaning(editor, acquired));
                setEditorAnnouncement("Cleaning reset to the default steps.");
              }}
              cleaningError={reviewValidation(editor).errors.standardization}
              coveragePendingLabel={
                consoleSource !== undefined
                  ? CONSOLE_COVERAGE_PENDING_LABEL
                  : undefined
              }
              onBack={() => goTo("review")}
            />
          )}
        {section === "keys" &&
          editor !== undefined &&
          acquired !== undefined && (
            <KeysTab
              editor={editor}
              csv={acquired}
              expertMode={expertMode}
              onExpertMode={setExpertMode}
              onKeyEnabled={(index, enabled) =>
                applyEditor(editorWithKeyEnabled(editor, index, enabled))
              }
              onKeyMoved={(index, offset) => {
                const moved = editorWithKeyMoved(editor, index, offset);
                setEditor(moved);
                if (moved !== editor) {
                  const key = moved.draft.keys[index + offset];
                  setEditorAnnouncement(
                    `Moved ${sanitizeForDisplay(key.key.name)} to position ${index + offset + 1} of ${moved.draft.keys.length}. Keys earlier in the list match first.`,
                  );
                }
              }}
              onAuthoredDraft={(draft) =>
                applyEditor(editorWithAuthoredDraft(editor, draft))
              }
              onStrategy={(strategy) =>
                applyEditor(editorWithLinkageStrategy(editor, strategy))
              }
              onAlgorithm={(algorithm) =>
                applyEditor(editorWithAlgorithm(editor, algorithm))
              }
              onDeduplicate={(deduplicate) =>
                applyEditor(editorWithDeduplicate(editor, deduplicate))
              }
              onImport={(terms) => {
                setEditor(editorWithImportedTerms(editor, acquired, terms));
                setEditorAnnouncement(
                  "Imported. Review the loaded terms before creating.",
                );
              }}
              keysError={reviewValidation(editor).errors.keys}
              announce={setEditorAnnouncement}
              onBack={() => goTo("review")}
            />
          )}
        {section === "agreement" && editor !== undefined && (
          <AgreementTab
            editor={editor}
            validation={reviewValidation(editor)}
            onAgreement={(agreement) =>
              applyEditor(editorWithLegalAgreement(editor, agreement))
            }
            onBack={() => goTo("review")}
          />
        )}
        {section === "share" && invitation !== undefined && (
          <>
            <InviterExchangeSection
              invitation={invitation}
              run={run}
              outputs={outputs}
              failure={failure}
              warnings={warnings}
              partnerAcceptsByCli={isCliTransport(transport)}
              onDownloadAcceptKit={
                acceptKitExchange === undefined ? undefined : downloadAcceptKit
              }
              serverJob={chosenRunMode === "server-job"}
              jobId={jobId}
              reattached={reattached}
              reattaching={reattaching}
              onTryAgain={tryAgain}
              onStartOver={startOver}
              onAbandon={abandonRun}
            />
            {/* The manage offer is webrtc-only (its record composes a webrtc
                locator) and is skippable: leaving it untouched keeps the exchange
                one-off. It stands from the share screen through completion, so
                either party can manage the partnership. The sample demo is
                excluded: a standing record of synthetic terms armed with a real
                secret is not a partnership to manage. */}
            {transport === "browser" &&
              failure === undefined &&
              !demoActive && (
                <ManageExchangeOffer
                  status={manageStatus}
                  handleCaptured={sourceHandle !== undefined}
                  onManage={(choices) => void manageExchange(choices)}
                />
              )}
          </>
        )}
        {section === "save" && isCliTransport(transport) && (
          <SaveExchangeSection
            transport={transport}
            fields={saveFields}
            saved={savedExchange}
            saving={saving}
            alert={saveAlert}
            onFields={setSaveFields}
            onSave={() => void saveExchangeFile()}
            onBack={() => goTo("review")}
          />
        )}
        <VisuallyHidden>
          <p aria-live="polite" aria-atomic="true">
            {editorAnnouncement}
          </p>
        </VisuallyHidden>
      </div>
    </WorkShell>
  );
}
