import {
  Fragment,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import { Alert, VisuallyHidden } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";

import {
  disclosedColumnNames,
  mintExchangeFile,
  sanitizeErrorForDisplay,
  sanitizeForDisplay,
  transformRefusalIn,
} from "@alcove/core";

import {
  InvitationFileError,
  generateInvitation,
  invitationDeclaresRetainedFiles,
  webrtcEndpointFromLocation,
} from "@psi/invitation";
import {
  emptyColumnPositions,
  overlongColumnsAlert,
  overlongCoverageColumns,
  refusedColumnNames,
  sanitizedColumnsAlert,
  savedExchangeColumnRefusalAlert,
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

import { alcoveVersion, isConsoleBuild } from "@utils/clientConfig";
import { whenDiagnostic } from "@utils/diagnostics";

import {
  INITIAL_CSV_DELIMITER_CHOICE,
  resolveCsvDelimiter,
} from "@components/csvDelimiterChoice";
import {
  coverageProvider,
  useNonEmptyRates,
} from "@components/useNonEmptyRates";
import { CONSOLE_COVERAGE_PENDING_LABEL } from "@components/FieldCoverage";
import { triggerBlobDownload } from "@components/blobDownload";
import { unlinkableFileAlert } from "@components/UnlinkableFileAlert";

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
} from "@psi/inviterEditor";
import { receiptsIntentFields } from "@psi/receiptsModel";
import { runDiagnosticsIntentFields } from "@psi/runDiagnosticsModel";

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
  exchangeFilesOptions,
} from "@console/exchangeFilesModel";
import {
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
  DivergedCommitmentNotice,
  MountedConfigurationCard,
} from "@console/MountedConfigurationCard";
import {
  configurationSaveShown,
  configurationSaveState,
  connectionSettingsHeldNotice,
  conversionStatement,
  editedTermsWarning,
  runWithheldReason,
  unconvertedSigningWithheldReason,
} from "@console/mountedConfiguration";
import {
  editorWithLoadedTerms,
  termsEditedSinceOpened,
  termsSettingsStatedBy,
} from "@console/loadedConfig";
import {
  fetchMountedConfiguration,
  saveOpenedConfiguration,
} from "@psi/jobClient/mountedConfigClient";
import { configurationHandBack } from "@console/configurationHandBack";

import {
  INVITER_SCREEN_INITIAL,
  INVITER_SPINE_ORDER,
  inviterScreenReducer,
  isInviterSpineStep,
  unmatchableFileAlert,
} from "./inviterScreenModel";
import { acceptKitFileName, buildAcceptKit } from "./acceptKit";
import {
  buildManagedDeposit,
  webrtcLocatorFromEndpoint,
} from "./manageOfferModel";
import { downloadSampleCsvs, sampleInviterFile } from "./sampleData";
import {
  endpointRequestFor,
  exchangeFileInputFor,
  exchangeFileName,
  liveRunLedgerFooter,
  saveExchangeError,
  saveRailNote,
  saveTrustFooter,
} from "./saveExchangeModel";
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

import type { AcquiredCsv, InviterEditor } from "@psi/inviterEditor";
import type { AcceptKitEndpoint } from "./acceptKit";
import type { RailStep } from "@psi/rail";

import type {
  ConnectionEndpointRequest,
  InvitationFileFailure,
} from "@psi/invitation";
import type { AlertContent } from "@components/csvIntake";
import type { CliTransport } from "./saveExchangeModel";
import type { CoverageInput } from "@components/useNonEmptyRates";
import type { CsvDelimiterChoice } from "@components/csvDelimiterChoice";
import type { JobInputSource } from "@psi/jobClient/serverJobExchangeDriver";
import type { ProfiledJobInput } from "@psi/jobClient/workInputClient";

import type { ColumnSamples } from "@psi/columnSamples";
import type { ConfigurationSaveState } from "@console/mountedConfiguration";
import type { DisclosureChoice } from "@psi/metadataEditing";
import type { InviterSpineStep } from "./inviterScreenModel";
import type { ManageOfferChoices } from "./manageOfferModel";
import type { Section } from "./stepRestore";
import type { SftpConnectionProjection } from "@jobs/jobManager";

import type {
  CSVRow,
  SemanticType,
  Standardization,
  TransformRefusal,
} from "@alcove/core";

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

const SPINE_LABELS: Record<InviterSpineStep, string> = {
  file: "Your file",
  columns: "Matching & sharing",
  review: "Review & create",
};

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
      return unnameableColumnsAlert(
        failure.positions,
        failure.sanitizedPositions,
      );
    case "overlong":
      return overlongColumnsAlert(failure.positions);
    case "unlinkable":
      return unlinkableFileAlert(failure.refusal);
  }
}

/**
 * The alert for a mint the transform check refused. Both mint surfaces render this
 * one composition, as they do {@link invitationFileAlert}, and it is exhaustive over
 * {@link TransformRefusal}, so a refusal core adds cannot reach either surface as
 * the generic "something went wrong".
 *
 * The words are this app's own and interpolate only what core narrowed for it -- a
 * step label that is a build literal, and two counts -- so an imported terms
 * document, which a partner may have authored, cannot echo a byte of itself here.
 */
function transformRefusalAlert(refusal: TransformRefusal): AlertContent {
  switch (refusal.reason) {
    case "uncompilable-step":
      return {
        title: "A transform step cannot be built",
        message:
          `One transform step (${refusal.stepLabel}) cannot be built from the ` +
          "settings it declares, so the exchange would stop before it matched " +
          "anything. Open that step in your linkage keys or cleaning steps and " +
          "correct its settings, or remove the step.",
      };
    case "too-many-steps":
      return {
        title: "These terms declare too many transform steps",
        message:
          `Your linkage keys and cleaning steps declare ${refusal.declaredSteps} ` +
          `transform steps together, more than the limit of ${refusal.maxSteps}. ` +
          "Reduce the number of linkage keys, key elements, or transform steps " +
          "they declare.",
      };
  }
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
 *
 * Its whole state lives in one reducer ({@link inviterScreenReducer}); this
 * component holds the I/O -- the parse, the mint, the save, and the console's
 * fetches -- and reports each outcome to it as an action.
 */
export function InviterScreen() {
  const [screenState, dispatch] = useReducer(
    inviterScreenReducer,
    INVITER_SCREEN_INITIAL,
  );
  const {
    acceptKitExchange,
    acquired,
    announcement,
    connectionTuning,
    consoleSource,
    createAlert,
    delimiterChoice,
    demoActive,
    editor,
    editorAnnouncement,
    exchangeFiles,
    expertMode,
    intakeAlert,
    invitation,
    lastSpineStep,
    loadedConfiguration,
    loadedEnforcementRecords,
    loadedSftpForm,
    loadedTermsBaseline,
    loadedTermsFile,
    manageOffer,
    minting,
    mountedConfiguration,
    name,
    reading,
    receipts,
    rendezvous,
    runDiagnostics,
    sanitizedNotice,
    saveAlert,
    saveFields,
    savedExchange,
    saving,
    section,
    sftpInfo,
    sftpSaveFilePreferred,
    sourceFile,
    sourceHandle,
  } = screenState;

  const delimiterResolution = resolveCsvDelimiter(delimiterChoice);
  const csvDelimiter = delimiterResolution.ok
    ? delimiterResolution.delimiter
    : undefined;

  // A file already read is read again by the new delimiter: its rows, columns,
  // and the terms derived from them all come out of the parse, so keeping the
  // previous reading would mint terms for columns the run does not see. A
  // refused choice reads nothing -- the field states the refusal and the intake
  // is closed until it resolves.
  function changeDelimiter(choice: CsvDelimiterChoice) {
    dispatch({ type: "delimiter-chosen", choice });
    const resolution = resolveCsvDelimiter(choice);
    if (!resolution.ok || sourceFile === undefined) return;
    void readFile(sourceFile, resolution.delimiter);
  }

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
      if (!cancelled) dispatch({ type: "console-sftp-resolved", info });
    });
    return () => {
      cancelled = true;
    };
  }, [sftpInfo]);

  // Open the configuration the operator mounted. The read answers here and the
  // reducer decides what it may change, the delimiter included: an invitation
  // minted while this fetch is in flight leaves every field the document states
  // where the sealed terms had it.
  async function openMountedConfiguration(): Promise<void> {
    dispatch({ type: "mounted-configuration-reading" });
    dispatch({
      type: "mounted-configuration-read",
      answer: await fetchMountedConfiguration(),
    });
  }

  // Where saving the opened configuration back to the folder stands. Cleared
  // when a configuration is opened or closed, since a save names the file
  // that was open.
  const [configurationSave, setConfigurationSave] =
    useState<ConfigurationSaveState>({ status: "idle" });
  useEffect(() => {
    setConfigurationSave({ status: "idle" });
  }, [mountedConfiguration.status]);

  // The hand-back the steps hold now, where the opened configuration is one
  // the console saves back rather than runs: what a save sends, and what a
  // written save is compared against to say whether it still holds.
  const saveBackOffered = runWithheldReason(mountedConfiguration) !== undefined;
  const currentHandBack = useMemo(() => {
    if (!saveBackOffered || editor === undefined) return undefined;
    const validation = reviewValidation(editor);
    if (!validation.canGenerate || validation.terms === undefined)
      return undefined;
    return configurationHandBack({
      editor,
      terms: validation.terms,
      csvDelimiter,
      receipts,
    });
  }, [saveBackOffered, editor, csvDelimiter, receipts]);

  // Write the settings these steps edit into the opened configuration's file,
  // for a channel the console does not conduct: the console keeps the file's
  // connection itself, so the save sends only what the steps hold.
  async function saveConfiguration(): Promise<void> {
    if (currentHandBack === undefined) return;
    const sent = currentHandBack;
    setConfigurationSave({ status: "saving" });
    const answer = await saveOpenedConfiguration(sent);
    setConfigurationSave(configurationSaveState(answer, sent));
  }

  // Convert the open configuration to the console's own paths: the run's
  // signing identity and receipt and the hand-off's placeholders.
  function convertMountedConfiguration() {
    dispatch({ type: "mounted-configuration-converted" });
  }

  // Close the open configuration: it stops being an input here, so the draft
  // falls back to what the file's own headers infer and the reducer drops
  // everything else the load filled.
  function closeMountedConfiguration() {
    dispatch({
      type: "loaded-configuration-discarded",
      ...(acquired !== undefined
        ? { editor: editorFromCsv(name, acquired) }
        : {}),
    });
  }

  // The open configuration's terms over the file the file step holds: the
  // import rebuilds each field's binding against the operator's own columns, so
  // it runs once the file is read and again for the next file read while the
  // configuration is open -- a draft seeded from a file's headers alone would
  // disclose a column the configuration states is kept back. The own-column
  // choice goes on first, because the import reads it off the draft it rebuilds
  // from. The transport the file's channel selects goes on in the reducer,
  // which holds it.
  useEffect(() => {
    if (
      loadedConfiguration === undefined ||
      editor === undefined ||
      acquired === undefined ||
      loadedTermsFile === acquired
    )
      return;
    const applied = editorWithLoadedTerms(
      editorWithIncludeOwnColumns(editor, loadedConfiguration.ownColumns),
      acquired,
      loadedConfiguration,
    );
    dispatch({
      type: "loaded-terms-applied",
      file: acquired,
      editor: applied.editor,
      notApplied: applied.notApplied,
      notCovered: applied.notCovered,
    });
  }, [acquired, editor, loadedConfiguration, loadedTermsFile]);

  // Fetch the console's rendezvous mount once on a console build; the mount is
  // boot-static on the server, so one fetch per console serves the session. The
  // helper resolves to `{ configured: false }` on any failure, so the filedrop
  // card stays disabled unless the console confirms a mounted directory.
  useEffect(() => {
    if (!isConsoleBuild() || rendezvous !== undefined) return;
    let cancelled = false;
    void fetchJobRendezvous().then((config) => {
      if (!cancelled) dispatch({ type: "console-rendezvous-resolved", config });
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
  // A console run of the opened configuration continues the exchange it set
  // up, under the key file beside it on the server, so it sends no invitation.
  const continuesOpenedExchange =
    mountedConfiguration.status === "opened" &&
    runWithheldReason(mountedConfiguration) === undefined &&
    chosenRunMode === "server-job";
  // Whether the terms this draft builds are still the ones the opened
  // configuration built when they reached the file the step holds, compared
  // rather than tracked through edits, so an undone change clears it.
  const openedTermsEdited =
    editor !== undefined &&
    loadedTermsFile !== undefined &&
    loadedTermsFile === acquired &&
    termsEditedSinceOpened(loadedTermsBaseline, editor);
  // A signed console run of an opened configuration naming signing paths of
  // its own waits for the operator to convert it to the console's.
  const signingWithheld =
    chosenRunMode === "server-job"
      ? unconvertedSigningWithheldReason(mountedConfiguration, receipts.mode)
      : undefined;
  const signingWithheldConversion =
    signingWithheld === undefined
      ? undefined
      : conversionStatement(mountedConfiguration);

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
    runRecord,
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
    loadedEnforcementRecords,
    mountedConfigurationOpened: mountedConfiguration.status === "opened",
    mountedConfigurationConverted:
      mountedConfiguration.status === "opened" &&
      mountedConfiguration.converted === true,
    ...(csvDelimiter !== undefined ? { csvDelimiter } : {}),
  });

  // The coverage input, unified across builds: the browser's parsed rows on the
  // hosted build, the mounted-file reference on the console (its sweep is a fetch,
  // not parsed rows). Memoized so a standardization edit reuses the provider and
  // only a new file rebuilds it. The console reads no rows -- `acquired.rawRows` is a
  // throwing getter there -- so this never touches it on that path.
  const coverageInput = useMemo<CoverageInput>(() => {
    if (consoleSource !== undefined)
      return {
        kind: "workFile",
        reference: { name: consoleSource.name },
        ...(csvDelimiter !== undefined ? { csvDelimiter } : {}),
      };
    if (!isConsoleBuild() && acquired !== undefined)
      return { kind: "rows", rows: acquired.rawRows };
    return EMPTY_COVERAGE_INPUT;
  }, [acquired, consoleSource, csvDelimiter]);

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
  // The columns whose header the console's coverage sweep refuses over its length,
  // so the unavailable notice names what tripped the bound. Empty off the console:
  // the hosted sweep runs in this browser, under no such bound.
  const coverageRefusedColumns = useMemo(
    () =>
      consoleSource === undefined
        ? []
        : overlongCoverageColumns(
            editor?.draft.standardization ?? EMPTY_STANDARDIZATION,
            consoleSource.columns,
          ),
    [consoleSource, editor],
  );
  const coverageProblems = cleaningCoverageProblems(editor, rates);

  // The operator authored an SFTP connection in-console (its credential-free
  // projection): hold it and drop any save-a-file preference so the run mode flips
  // to server-job. The connection lives in console memory, scoped to the one
  // exchange; the browser holds only the locator. A freshly authored server is a
  // different rendezvous directory, so any sweep confirmation is re-asked.
  function authorSftpConnection(connection: SftpConnectionProjection) {
    dispatch({ type: "sftp-connection-authored", connection });
  }

  // Clear the authored connection: forget it on the console and locally, so the
  // card returns to the authoring empty state.
  function clearSftpConnection() {
    dispatch({ type: "sftp-connection-cleared" });
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
    dispatch({ type: "started-over" });
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
    dispatch({ type: "manage-offer-started" });
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
              ...(csvDelimiter !== undefined ? { csvDelimiter } : {}),
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
      dispatch({ type: "manage-offer-deposited" });
    } catch (error) {
      console.error(
        "managed exchange deposit failed:",
        error instanceof Error ? error.name : typeof error,
      );
      whenDiagnostic(() =>
        console.error("managed exchange deposit failed (detail):", error),
      );
      // The alert names the column out of the document's own metadata, which is
      // what the refused parse read; a failure no column explains leaves the
      // generic copy standing.
      const refused = refusedColumnNames(invitation.metadata);
      dispatch({
        type: "manage-offer-failed",
        refusal:
          refused.length > 0
            ? savedExchangeColumnRefusalAlert(refused)
            : undefined,
      });
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
    dispatch({ type: "section-shown", section: settled });
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
    dispatch({ type: "section-shown", section: next });
    pushStep(next);
  }

  function applyEditor(next: InviterEditor) {
    dispatch({ type: "editor-applied", editor: next });
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

  // The delimiter is a parameter rather than read off state inside: a re-read
  // fired from the control itself runs with the choice that fired it, not with
  // whatever the state had settled to by the time the read began.
  async function readFile(
    file: File,
    delimiter: string | undefined,
    seed?: { name: string },
  ) {
    const id = ++parseId.current;
    parseAbort.current?.abort();
    const controller = new AbortController();
    parseAbort.current = controller;
    // The sample seed has its own inviter name so step 1 lands complete; a
    // real drop keeps whatever the operator typed. Read before the dispatch so
    // the derived editor's identity and the name field agree.
    const identity = seed?.name ?? name;
    dispatch({ type: "read-started", seedName: seed?.name });
    try {
      const result = await loadCSVFileOffMainThread(file, {
        signal: controller.signal,
        ...(delimiter !== undefined ? { delimiter } : {}),
      });
      if (id !== parseId.current) return;
      const columns = result.meta.fields ?? [];
      const stripped = result.meta.sanitizedColumnPositions;
      const emptyPositions = emptyColumnPositions(columns);
      // The refusal names the columns the removal left unnamed, the notice
      // every position the read changed; both apply to the same read.
      const notice =
        stripped.length > 0 ? sanitizedColumnsAlert(stripped) : undefined;
      if (emptyPositions.length > 0) {
        dispatch({
          type: "read-discarded",
          alert: unnameableColumnsAlert(emptyPositions, stripped),
          notice,
        });
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
      dispatch({
        type: "file-acquired",
        acquired: csv,
        file,
        handle: capturedInputHandle(file),
        editor: seeded,
        notice,
        alert:
          seeded.draft.keys.length === 0 ? unmatchableFileAlert() : undefined,
      });
    } catch (error) {
      if (id !== parseId.current) return;
      dispatch({
        type: "read-discarded",
        alert: {
          title: "The file could not be read",
          message: sanitizeErrorForDisplay(error),
        },
      });
    } finally {
      if (id === parseId.current) dispatch({ type: "read-finished" });
    }
  }

  // Commit a profiled mounted file (the console picker's "Use this file") as
  // the acquired file. A blank header cell is refused early with the shared
  // unnameable alert (as readFile does), or core's inferMetadata would throw
  // at seed time and unmount the console. Re-profiling the same committed file
  // keeps the authored draft when its columns are unchanged and only refreshes
  // the profile-derived facts; otherwise it reseeds from the profile.
  function commitConsoleFile(profile: ProfiledJobInput) {
    const stripped = profile.sanitizedColumnPositions;
    const emptyPositions = emptyColumnPositions(profile.columns);
    const notice =
      stripped.length > 0 ? sanitizedColumnsAlert(stripped) : undefined;
    if (emptyPositions.length > 0) {
      dispatch({
        type: "read-discarded",
        alert: unnameableColumnsAlert(emptyPositions, stripped),
        notice,
      });
      return;
    }
    const csv = consoleAcquiredCsv({
      fileName: profile.name,
      sizeBytes: profile.sizeBytes,
      columns: profile.columns,
      rowCount: profile.rowCount,
      dateInputFormats: profile.dateInputFormats,
    });
    const reseed = (reseedAnnouncement?: string) => {
      const seeded = editorFromCsv(name, csv);
      dispatch({
        type: "console-file-seeded",
        source: profile,
        delimiter: csvDelimiter,
        acquired: csv,
        editor: seeded,
        notice,
        alert:
          seeded.draft.keys.length === 0 ? unmatchableFileAlert() : undefined,
        announcement: reseedAnnouncement,
      });
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
        dispatch({
          type: "console-file-reprofiled",
          source: profile,
          delimiter: csvDelimiter,
          acquired: csv,
          editor: editorReprofiled(editor, csv),
          notice,
          announcement:
            "Re-profiled with the file's current contents; your customizations are unchanged.",
        });
        return;
      }
      reseed(
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
    dispatch({
      type: "delimiter-chosen",
      choice: INITIAL_CSV_DELIMITER_CHOICE,
    });
    void readFile(sampleInviterFile(), undefined, {
      name: SAMPLE_INVITER_NAME,
    });
  }

  // Clear the sample back to a fresh exchange: drop the read, the derived terms,
  // and every demo-seeded field in place, and return to step 1. A parse still in
  // flight is discarded (its resolution falls on the floor). Nothing about the
  // demo persists.
  function clearSample() {
    parseId.current += 1;
    parseAbort.current?.abort();
    dispatch({ type: "sample-cleared" });
    goTo("file");
  }

  function updateName(next: string) {
    dispatch({ type: "name-changed", name: next });
  }

  function applyColumnEdit(result: {
    editor: InviterEditor;
    demotedIdentifiers: Array<string>;
  }) {
    dispatch({
      type: "column-edited",
      editor: result.editor,
      announcement: demotionNotice(result.demotedIdentifiers),
    });
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
      dispatch({ type: "save-routed", editor });
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
    dispatch({ type: "mint-started" });
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
        ...(csvDelimiter !== undefined ? { csvDelimiter } : {}),
        ...(connectionEndpoint !== undefined ? { connectionEndpoint } : {}),
        retainsFiles: declaresRetainedFiles,
      });
      // The bilateral file-handling choices are captured beside the locator:
      // the lockless rendezvous from the options block the run itself holds
      // rather than from the raw toggles -- retain mode's implication of it
      // included -- and retain mode from the value the token declares, so the
      // sheet cannot state a mode the partner's invitation does not.
      dispatch({
        type: "invitation-minted",
        editor,
        invitation: minted,
        acceptKitExchange:
          kitEndpoint === undefined
            ? undefined
            : {
                endpoint: kitEndpoint,
                retainFiles: declaresRetainedFiles,
                locklessRendezvous: runOptions?.locklessRendezvous === true,
              },
      });
      goTo("share");
    } catch (error) {
      if (error instanceof InvitationFileError) {
        // The mint re-parses the retained file, so it can fail in the same
        // user-actionable ways step 1 gates on (the file changed on disk, or
        // its satisfiability shifted with the edited terms); show the same
        // shared alerts rather than a generic failure.
        dispatch({
          type: "mint-failed",
          alert: invitationFileAlert(error.failure),
        });
      } else {
        // The tag is read after the class test rather than before it: the read
        // walks `.cause` links, and an accessor that throws there propagates
        // out of this handler, which must not cost a file error its alert.
        const transformRefusal = transformRefusalIn(error);
        if (transformRefusal !== undefined) {
          // A document the transform check refused: the operator holds the
          // terms and the remedy is an edit, so retrying the same click cannot
          // clear it.
          dispatch({
            type: "mint-failed",
            alert: transformRefusalAlert(transformRefusal),
          });
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
          dispatch({
            type: "mint-failed",
            alert: {
              title: "Could not create the invitation",
              message:
                "Something went wrong while creating the invitation. Your terms are unchanged - try again.",
            },
          });
        }
      }
    } finally {
      dispatch({ type: "mint-finished" });
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
    dispatch({ type: "save-started" });
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
        ...(csvDelimiter !== undefined ? { csvDelimiter } : {}),
        connectionEndpoint: endpointRequestFor(cliTransport, saveFields),
      });
      // Mint the config from the SAME invitation the code came from; a
      // ZodError here (a malformed locator the endpoint schema also rejects)
      // aborts before any download, so a code is never displayed with no file.
      const yaml = mintExchangeFile({
        ...exchangeFileInputFor(cliTransport, saveFields, minted),
        ...(csvDelimiter !== undefined ? { csvDelimiter } : {}),
      });
      const fileName = exchangeFileName(new Date());
      triggerBlobDownload(fileName, yaml, "application/yaml");
      dispatch({
        type: "exchange-file-saved",
        saved: { invitation: minted, fileName },
      });
    } catch (error) {
      if (error instanceof InvitationFileError) {
        dispatch({
          type: "save-failed",
          alert: invitationFileAlert(error.failure),
        });
      } else {
        // The tag is read after the class test here too, for the reason the
        // create click's handler states.
        const transformRefusal = transformRefusalIn(error);
        if (transformRefusal !== undefined) {
          dispatch({
            type: "save-failed",
            alert: transformRefusalAlert(transformRefusal),
          });
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
          dispatch({
            type: "save-failed",
            alert: {
              title: "Could not save the exchange file",
              message:
                "Something went wrong while saving. Your terms are unchanged - try again.",
            },
          });
        }
      }
    } finally {
      dispatch({ type: "save-finished" });
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
      buildAcceptKit({ ...acceptKitExchange, version: alcoveVersion() }),
      "text/plain",
    );
  }

  const linkable = editor !== undefined && editor.draft.keys.length > 0;
  const fileReady = name.trim().length > 0 && linkable;
  const sealed = editor?.sealed === true;

  // What an open configuration's commitments are read against: the set this
  // draft would send and the direction it would send it in. Absent until a file
  // is read, where no draft settles either.
  const runDisclosure =
    editor === undefined
      ? undefined
      : {
          disclosedColumns: disclosedColumnNames(editor.draft.metadata),
          sharesWithPartner: outputForDirection(editor.draft.outputDirection)
            .shareWithPartner,
          records: loadedEnforcementRecords,
          ...(loadedTermsFile !== undefined && loadedTermsFile === acquired
            ? { termsSettingsStated: termsSettingsStatedBy(editor) }
            : {}),
        };

  // Inside a Customize tab no spine step is current; the step the operator
  // came from stays navigable like any completed step. The share and save
  // sections have their own rails, so neither is a Customize tab.
  const inTab =
    !isInviterSpineStep(section) && section !== "share" && section !== "save";
  const currentPosition = INVITER_SPINE_ORDER.indexOf(
    isInviterSpineStep(section) ? section : lastSpineStep,
  );
  const steps: Array<RailStep> =
    section === "share"
      ? timelineSteps(run)
      : INVITER_SPINE_ORDER.map((step, position) => {
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
        {isConsoleBuild() && section === "file" && (
          <MountedConfigurationCard
            state={mountedConfiguration}
            sealed={sealed}
            disclosure={runDisclosure}
            onOpen={() => void openMountedConfiguration()}
            onClose={closeMountedConfiguration}
            onConvert={convertMountedConfiguration}
          />
        )}
        {section === "file" && (
          <YourFileSection
            name={name}
            onNameChange={updateName}
            onFile={(file) => void readFile(file, csvDelimiter)}
            delimiter={delimiterChoice}
            onDelimiterChange={changeDelimiter}
            reading={reading}
            acquired={acquired}
            linkable={linkable}
            alert={intakeAlert}
            notice={sanitizedNotice}
            committed={
              consoleSource !== undefined
                ? { name: consoleSource.name }
                : undefined
            }
            onCommit={commitConsoleFile}
            onInvalidate={() => dispatch({ type: "console-file-voided" })}
            onContinue={() => {
              if (fileReady) goTo("columns");
            }}
            onLoadSample={loadSample}
            onDownloadSamples={downloadSampleCsvs}
          />
        )}
        {isConsoleBuild() && section === "columns" && (
          <DivergedCommitmentNotice
            state={mountedConfiguration}
            disclosure={runDisclosure}
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
                loadedSftpForm={loadedSftpForm}
                sftpSaveFilePreferred={sftpSaveFilePreferred}
                runWithheld={
                  runWithheldReason(mountedConfiguration) ?? signingWithheld
                }
                continuesOpenedExchange={continuesOpenedExchange}
                editedTermsWarning={editedTermsWarning(mountedConfiguration, {
                  termsEdited: openedTermsEdited,
                  continuesOpenedExchange,
                })}
                connectionSettingsHeld={connectionSettingsHeldNotice(
                  mountedConfiguration,
                )}
                configurationSave={configurationSaveShown(
                  configurationSave,
                  currentHandBack,
                )}
                {...(saveBackOffered
                  ? { onSaveConfiguration: () => void saveConfiguration() }
                  : {})}
                {...(signingWithheldConversion !== undefined
                  ? {
                      conversion: {
                        statement: signingWithheldConversion,
                        onConvert: convertMountedConfiguration,
                      },
                    }
                  : {})}
                rendezvous={rendezvous}
                exchangeFiles={exchangeFiles}
                onExchangeFiles={(draft) =>
                  dispatch({ type: "exchange-files-chosen", draft })
                }
                connectionTuning={connectionTuning}
                onConnectionTuning={(draft) =>
                  dispatch({ type: "connection-tuning-chosen", draft })
                }
                runDiagnostics={runDiagnostics}
                onRunDiagnostics={(draft) =>
                  dispatch({ type: "run-diagnostics-chosen", draft })
                }
                receipts={receipts}
                onReceipts={(draft) =>
                  dispatch({ type: "receipts-chosen", draft })
                }
                onLifetime={(seconds) =>
                  applyEditor(editorWithLifetime(editor, seconds))
                }
                onDirection={(direction) =>
                  applyEditor(editorWithOutputDirection(editor, direction))
                }
                onTransport={(next) =>
                  dispatch({
                    type: "transport-chosen",
                    editor: editorWithTransport(editor, next),
                  })
                }
                onAuthorConnection={authorSftpConnection}
                onClearConnection={clearSftpConnection}
                onUseCliForSftp={() =>
                  dispatch({
                    type: "sftp-save-file-preferred",
                    preferred: true,
                  })
                }
                onRunHereForSftp={() =>
                  dispatch({
                    type: "sftp-save-file-preferred",
                    preferred: false,
                  })
                }
                onReset={() =>
                  dispatch({
                    type: "editor-replaced",
                    editor: resetToRecommended(editor, acquired),
                    announcement: "Reset to the default settings.",
                  })
                }
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
              coverageRefusedColumns={coverageRefusedColumns}
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
              onResetCleaning={() =>
                dispatch({
                  type: "editor-replaced",
                  editor: editorWithRecommendedCleaning(editor, acquired),
                  announcement: "Cleaning reset to the default steps.",
                })
              }
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
              onExpertMode={(on) =>
                dispatch({ type: "expert-mode-chosen", expertMode: on })
              }
              onKeyEnabled={(index, enabled) =>
                applyEditor(editorWithKeyEnabled(editor, index, enabled))
              }
              onKeyMoved={(index, offset) => {
                const moved = editorWithKeyMoved(editor, index, offset);
                if (moved === editor) return;
                const key = moved.draft.keys[index + offset];
                dispatch({
                  type: "editor-replaced",
                  editor: moved,
                  announcement: `Moved ${sanitizeForDisplay(key.key.name)} to position ${index + offset + 1} of ${moved.draft.keys.length}. Keys earlier in the list match first.`,
                });
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
              onImport={(terms) =>
                dispatch({
                  type: "editor-replaced",
                  editor: editorWithImportedTerms(editor, acquired, terms),
                  announcement:
                    "Imported. Review the loaded terms before creating.",
                })
              }
              keysError={reviewValidation(editor).errors.keys}
              announce={(message) =>
                dispatch({ type: "editor-announced", announcement: message })
              }
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
              runRecord={runRecord}
              warnings={warnings}
              partnerAcceptsByCli={isCliTransport(transport)}
              onDownloadAcceptKit={
                acceptKitExchange === undefined ? undefined : downloadAcceptKit
              }
              serverJob={chosenRunMode === "server-job"}
              continuesOpenedExchange={continuesOpenedExchange}
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
                  status={manageOffer.status}
                  refusal={manageOffer.refusal}
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
            onFields={(fields) =>
              dispatch({ type: "save-fields-changed", fields })
            }
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
