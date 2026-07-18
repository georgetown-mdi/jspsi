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
  webrtcEndpointFromLocation,
} from "@psi/invitation";
import { emptyColumnPositions, unnameableColumnsAlert } from "@psi/columnNames";
import { capturedInputHandle } from "@psi/managedInputHandle";
import { columnSamplesFromRows } from "@psi/columnSamples";
import { createManagedExchange } from "@psi/managedExchangeStore";
import { fetchJobRendezvous } from "@psi/workInputClient";
import { fetchSftpRemotes } from "@psi/serverJobExchangeDriver";
import { invitationLocation } from "@psi/invitationLocation";
import { loadCSVFileOffMainThread } from "@psi/csvParseController";

import { isConsoleBuild } from "@utils/clientConfig";
import { whenDiagnostic } from "@utils/diagnostics";

import {
  benchCoverageProvider,
  useNonEmptyRates,
} from "@components/useNonEmptyRates";
import { CONSOLE_COVERAGE_PENDING_LABEL } from "@components/FieldCoverage";
import { triggerBlobDownload } from "@components/blobDownload";
import { unlinkableFileAlert } from "@components/UnlinkableFileAlert";

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
import {
  availableTransports,
  cleaningCoverageProblems,
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
  editorWithKeyEnabled,
  editorWithKeyMoved,
  editorWithLegalAgreement,
  editorWithLifetime,
  editorWithLinkageStrategy,
  editorWithOutputDirection,
  editorWithRecommendedCleaning,
  editorWithTransport,
  inviterCleaningAttention,
  inviterLedgerRows,
  inviterRailFacts,
  isCliTransport,
  rendezvousLocatorName,
  resetToRecommended,
  reviewValidation,
  sealEditor,
  spineProblems,
  transportRunMode,
  unsealEditor,
} from "./inviterModel";
import {
  buildManagedDeposit,
  composeManagedDocument,
  webrtcLocatorFromEndpoint,
} from "./manageOfferModel";
import { downloadSampleCsvs, sampleInviterFile } from "./sampleData";
import { AgreementTab } from "./AgreementTab";
import { BenchShell } from "./BenchShell";
import { CleaningTab } from "./CleaningTab";
import { InviterExchangeSection } from "./InviterExchangeSection";
import { KeysTab } from "./KeysTab";
import { Ledger } from "./Ledger";
import { ManageExchangeOffer } from "./ManageExchangeOffer";
import { MatchingSharingSection } from "./MatchingSharingSection";
import { Problems } from "./Problems";
import { ReviewCreateSection } from "./ReviewCreateSection";
import { SaveExchangeSection } from "./SaveExchangeSection";
import { TopBar } from "./TopBar";
import { YourFileSection } from "./YourFileSection";
import { consoleAcquiredCsv } from "./consoleAcquiredCsv";
import { restorableSection } from "./stepRestore";
import { sftpEndpointForRemote } from "./sftpRemoteChoice";
import { timelineSteps } from "./exchangeRun";
import { useInviterExchange } from "./useInviterExchange";
import { useStepHistory } from "./useStepHistory";
import { useUnloadGuard } from "./useUnloadGuard";

import type { AcquiredCsv, InviterEditor, RailStep } from "./inviterModel";
import type { CliTransport, SaveExchangeFields } from "./saveExchangeModel";
import type {
  ConnectionEndpointRequest,
  GeneratedInvitation,
} from "@psi/invitation";
import type { BenchCoverageInput } from "@components/useNonEmptyRates";
import type { ColumnSamples } from "@psi/columnSamples";
import type { DisclosureChoice } from "@psi/metadataEditing";
import type { IntakeAlert } from "./YourFileSection";
import type { JobInputProfile } from "@jobs/workInputs";
import type { JobInputSource } from "@psi/serverJobExchangeDriver";
import type { JobRendezvousConfig } from "@psi/workInputClient";
import type { ManageOfferChoices } from "./manageOfferModel";
import type { ManageOfferStatus } from "./ManageExchangeOffer";
import type { SavedExchange } from "./SaveExchangeSection";
import type { Section } from "./stepRestore";
import type { SftpRemoteProjection } from "@jobs/jobManager";

import type { CSVRow, SemanticType, Standardization } from "@psilink/core";

type SpineStep = "file" | "columns" | "review";

/** Stable empty inputs for {@link useNonEmptyRates} before a file is acquired,
 * so the hook's controller is not rebuilt every render on a fresh `[]` identity
 * (the AcceptorBench lift). */
const EMPTY_ROWS: ReadonlyArray<CSVRow> = [];
const EMPTY_STANDARDIZATION: Standardization = [];

/** Stable "no file yet" coverage input and preview samples, so the coverage hook's
 * provider is not rebuilt every render on a fresh identity before a file is
 * acquired. The empty-rows coverage input drives the hosted worker provider over no
 * rows (an empty coverage), never a console fetch. */
const EMPTY_COVERAGE_INPUT: BenchCoverageInput = {
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

function demotionNotice(demoted: ReadonlyArray<string>): string {
  if (demoted.length === 0) return "";
  return `${demoted.join(", ")} changed to Ignored - only one column can be the record identifier.`;
}

// The inviter name the sample seeds, so step 1 lands complete without the
// visitor typing one. Plainly a placeholder, consistent with the synthetic data.
const SAMPLE_INVITER_NAME = "Sample County Health Dept";

/**
 * The inviter's working surface: one bench whose top bar walks the three-step
 * required spine while the work column swaps sections in place. The draft
 * seeds from the file the moment it is read (step 1) and every step-2 edit
 * flows through the shared draft model, so the Customize facts and the
 * disclosure ledger track live. Step 3 is not built yet and says so.
 */
export function InviterBench() {
  const [name, setName] = useState("");
  const [section, setSection] = useState<Section>("file");
  const [lastSpineStep, setLastSpineStep] = useState<SpineStep>("file");
  const [acquired, setAcquired] = useState<AcquiredCsv>();
  // The console profile behind the acquired shape: the appliance reads the file, so
  // the browser holds only the profile (name, size, mtime, columns, samples, date
  // format). It backs the mint (columns), the run (the mounted-file reference), the
  // coverage sweep, and the preview samples. Undefined on the hosted build, which
  // reads the file in the browser instead.
  const [consoleSource, setConsoleSource] = useState<JobInputProfile>();
  const [sourceFile, setSourceFile] = useState<File>();
  // The File System Access handle a drop attached to the selected file, where the
  // platform yielded one; captured so a managed deposit can persist a reusable
  // pointer to the input without a second picker dialog. Absent for a
  // click-selected file, a browser without the API, and the in-memory sample.
  const [sourceHandle, setSourceHandle] = useState<FileSystemFileHandle>();
  const [editor, setEditor] = useState<InviterEditor>();
  const [intakeAlert, setIntakeAlert] = useState<IntakeAlert>();
  const [reading, setReading] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [invitation, setInvitation] = useState<GeneratedInvitation>();
  const [minting, setMinting] = useState(false);
  const [createAlert, setCreateAlert] = useState<IntakeAlert>();
  const [expertMode, setExpertMode] = useState(false);
  const [editorAnnouncement, setEditorAnnouncement] = useState("");
  const [saveFields, setSaveFields] =
    useState<SaveExchangeFields>(EMPTY_SAVE_FIELDS);
  const [savedExchange, setSavedExchange] = useState<SavedExchange>();
  const [saving, setSaving] = useState(false);
  const [saveAlert, setSaveAlert] = useState<IntakeAlert>();
  const [sftpRemotes, setSftpRemotes] = useState<Array<SftpRemoteProjection>>();
  const [sftpRemoteName, setSftpRemoteName] = useState<string>();
  // The console's rendezvous mount, fetched once on a console build. Undefined before
  // it resolves; `configured` gates the filedrop transport (offered iff a directory is
  // mounted) and `path` is the advisory locator minted into a filedrop invitation.
  const [rendezvous, setRendezvous] = useState<JobRendezvousConfig>();
  const [demoActive, setDemoActive] = useState(false);
  const [manageStatus, setManageStatus] = useState<ManageOfferStatus>("idle");

  // Fetch the appliance's provisioned SFTP remotes once on a console build; the
  // table is boot-static on the server, so one fetch per bench serves the session,
  // and the default transport reads its presence (SFTP when provisioned, else the
  // filedrop save-a-file card). The helper resolves to an empty array on any
  // failure, so Create then falls back to the save-file surface rather than arming a
  // server-job run with no remote to name. The picker defaults to the first remote
  // so a chosen name always exists while the picker is shown.
  useEffect(() => {
    if (!isConsoleBuild() || sftpRemotes !== undefined) return;
    let cancelled = false;
    void fetchSftpRemotes().then((remotes) => {
      if (cancelled) return;
      setSftpRemotes(remotes);
      setSftpRemoteName((current) =>
        remotes.some((remote) => remote.name === current)
          ? current
          : remotes[0]?.name,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [sftpRemotes]);

  // Fetch the appliance's rendezvous mount once on a console build; the mount is
  // boot-static on the server, so one fetch per bench serves the session. The helper
  // resolves to `{ configured: false }` on any failure, so the filedrop card stays
  // disabled unless the appliance confirms a mounted directory.
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

  const sftpRemotesConfigured =
    sftpRemotes !== undefined && sftpRemotes.length > 0;
  const rendezvousConfigured = rendezvous?.configured === true;
  const chosenSftpRemote = sftpRemotes?.find(
    (remote) => remote.name === sftpRemoteName,
  );
  const available = availableTransports(
    isConsoleBuild(),
    sftpRemotesConfigured,
    rendezvousConfigured,
  );
  const transport = editor?.transport ?? available.defaultTransport;
  // How the chosen transport runs, from the chooser's own policy (which offers a
  // console filedrop as a save-a-file card, unlike the raw driver mapping): the
  // create branch and the live run both read it.
  const chosenRunMode = transportRunMode(available, transport);

  // The console reads the mounted file on the appliance, so a server-job run carries
  // only a REFERENCE (the opaque name), never the content.
  const inputSource: JobInputSource | undefined =
    consoleSource !== undefined
      ? { kind: "workFile", name: consoleSource.name }
      : undefined;

  // The live run starts the moment a live invitation exists (the hook drives
  // the partner exchange right away) and is torn down when the invitation is
  // discarded or the bench unmounts. A `save-file` run mode never runs live:
  // its invitation is minted for the save surface, so it is withheld from the
  // hook and `invitation` alone (not the withheld value) proves nothing dials
  // for a saved exchange. A `server-job` run mode runs live too -- the console
  // appliance carries it out -- so it drives the hook exactly as `browser` does.
  const runsLive = chosenRunMode !== "save-file";
  const { run, outputs, failure, warnings, tryAgain } = useInviterExchange({
    invitation: runsLive ? invitation : undefined,
    inviterName: editor?.draft.identity ?? "",
    channel: transport,
    inputSource,
    sftpRemotesConfigured,
    sftpRemote: chosenSftpRemote?.name,
  });

  // The coverage input, unified across builds: the browser's parsed rows on the
  // hosted build, the mounted-file reference on the console (whose sweep is a fetch
  // to the appliance). Memoized so a standardization edit reuses the provider and
  // only a new file rebuilds it. The console reads no rows -- `acquired.rawRows` is a
  // throwing getter there -- so this never touches it on that path.
  const coverageInput = useMemo<BenchCoverageInput>(() => {
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
    if (consoleSource !== undefined)
      return new Map(Object.entries(consoleSource.columnSamples));
    if (!isConsoleBuild() && acquired !== undefined)
      return columnSamplesFromRows(acquired.rawRows, acquired.columns);
    return EMPTY_COLUMN_SAMPLES;
  }, [acquired, consoleSource]);

  // Full-CSV coverage for the Cleaning tab, the Customize menu's Cleaning-attention
  // value, and the coverage Problems entry -- one sweep shared by all three, lifted
  // to the bench so the fact and the create gate render regardless of the active
  // section (the AcceptorBench lift). The hook must run every render, so it takes
  // stable empty inputs until a file is acquired.
  const { rates, pending: ratesPending } = useNonEmptyRates(
    coverageInput,
    editor?.draft.standardization ?? EMPTY_STANDARDIZATION,
    benchCoverageProvider,
  );
  const cleaningAttention = inviterCleaningAttention(editor, rates);
  const coverageProblems = cleaningCoverageProblems(editor, rates);

  // The failure alerts' "start over with a fresh invitation": the seal lifts
  // with every input intact, the failed invitation is discarded (its run has
  // already torn down; the hook drops the run state), and the operator lands
  // back on Review & create, where the next create mints a fresh secret.
  function startOver() {
    setEditor((current) =>
      current === undefined ? current : unsealEditor(current),
    );
    setInvitation(undefined);
    setSavedExchange(undefined);
    setManageStatus("idle");
    goTo("review");
  }

  // Deposit a managed-exchange record for this exchange as the inviter: the
  // standing terms plus the secret embedded in the just-minted invitation, so the
  // same partnership can run again later. The connection block is composed from
  // this app's own signaling location -- the same window.location source the
  // invitation's endpoint was built from -- not read back off the encoded token.
  // The secret is the minted invitation's; the one-shot run that follows discards
  // its own derived rotation, so the record stays coherent at this value until a
  // managed re-run rotates it. Declining is simply not pressing Manage, so there
  // is no discard path here.
  async function manageExchange(choices: ManageOfferChoices) {
    if (invitation === undefined || editor === undefined) return;
    setManageStatus("depositing");
    try {
      const connection = webrtcLocatorFromEndpoint(
        webrtcEndpointFromLocation(invitationLocation()),
      );
      const exchangeFile = composeManagedDocument(
        {
          linkageTerms: invitation.linkageTerms,
          ...(invitation.metadata !== undefined
            ? { metadata: invitation.metadata }
            : {}),
          ...(invitation.standardization !== undefined
            ? { standardization: invitation.standardization }
            : {}),
          // The token's own published set (including the strict empty set), so
          // the persisted send-side commitment is the one the partner locked in
          // -- never a re-derivation that could drift from it.
          disclosedPayloadColumns: invitation.disclosedPayloadColumns,
        },
        connection,
      );
      await createManagedExchange(
        buildManagedDeposit(
          {
            side: "inviter",
            exchangeFile,
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
  // The bench stays mounted throughout, so the loaded file, the derived terms,
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
  // finalized -- the invitation minted (the live run is listening) or the
  // exchange file saved. In either finalized state, leaving costs nothing the
  // operator has not already secured.
  useUnloadGuard({
    hasFile: acquired !== undefined,
    finalized: invitation !== undefined || savedExchange !== undefined,
    demoActive,
  });

  function goTo(next: Section) {
    if (next === section) return;
    if (isSpineStep(next)) setLastSpineStep(next);
    setSection(next);
    pushStep(next);
  }

  // Non-announcing edits clear the live region (the old editor's
  // cleared-by-the-next-interaction rule), so a stale notice never lingers
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
  // to the incoming h1 (they carry tabIndex -1) or a screen-reader user is
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
  function discardRead(alert: IntakeAlert) {
    setAcquired(undefined);
    setConsoleSource(undefined);
    setSourceFile(undefined);
    setSourceHandle(undefined);
    setEditor(undefined);
    setDemoActive(false);
    setIntakeAlert(alert);
  }

  async function readFile(file: File, seed?: { isSample: true; name: string }) {
    const id = ++parseId.current;
    parseAbort.current?.abort();
    const controller = new AbortController();
    parseAbort.current = controller;
    // A real drop clears the sample marker; the sample seed sets it. Editing the
    // sample's terms never re-reads, so the marker survives edits.
    setDemoActive(seed !== undefined);
    // The sample seed carries its own inviter name so step 1 lands complete; a
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

  // Commit a profiled mounted file (the console picker's "Use this file") as the
  // acquired file. A blank header cell is refused early with the shared unnameable
  // alert (as readFile does), or core's inferMetadata would throw at seed time and
  // unmount the bench. Re-profiling the same committed file keeps the authored draft
  // when its columns are unchanged and only refreshes the profile-derived facts;
  // otherwise it reseeds from the profile.
  function commitConsoleFile(profile: JobInputProfile) {
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
    void readFile(sampleInviterFile(), {
      isSample: true,
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
    // console appliance) instead mints here and routes to the live run, exactly
    // as the browser path does.
    if (chosenRunMode === "save-file") {
      setEditor(sealEditor(editor));
      setSavedExchange(undefined);
      setSaveAlert(undefined);
      goTo("save");
      return;
    }
    // An sftp server-job run authors the invitation's endpoint from the picked
    // provisioned remote's locator -- the same connectionEndpoint seam the save
    // surface's free-text fields feed -- so the partner's CLI meets the
    // appliance where it will actually connect. The picker defaults to the
    // first remote, so a missing choice here means the remotes state changed
    // mid-create; refuse rather than mint a code with the wrong rendezvous.
    let connectionEndpoint: ConnectionEndpointRequest | undefined;
    if (transport === "sftp") {
      if (chosenSftpRemote === undefined) return;
      connectionEndpoint = sftpEndpointForRemote(chosenSftpRemote);
    } else if (transport === "filedrop") {
      // A console filedrop server-job carries the rendezvous directory's NAME (its
      // basename) as the invitation's advisory locator, so the partner can confirm the
      // shared folder without the token disclosing the appliance's absolute path. The
      // mount is server-side; a missing path means the rendezvous state changed
      // mid-create, so refuse rather than mint a code with no locator.
      if (rendezvous?.path === undefined) return;
      connectionEndpoint = {
        channel: "filedrop",
        path: rendezvousLocatorName(rendezvous.path),
      };
    }
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
        ...(connectionEndpoint !== undefined ? { connectionEndpoint } : {}),
      });
      setEditor(sealEditor(editor));
      setInvitation(minted);
      setManageStatus("idle");
      goTo("share");
    } catch (error) {
      if (error instanceof InvitationFileError) {
        // The mint re-parses the retained file, so it can fail in the same
        // user-actionable ways step 1 gates on (the file changed on disk, or
        // its satisfiability shifted with the edited terms); surface the same
        // shared alerts rather than a generic failure.
        setCreateAlert(
          error.failure.kind === "unreadable"
            ? {
                title: "Could not read your file",
                message: sanitizeErrorForDisplay(error.failure.cause),
              }
            : error.failure.kind === "unnameable"
              ? unnameableColumnsAlert(error.failure.positions)
              : unlinkableFileAlert(error.failure.unsatisfied),
        );
      } else {
        // Internal and non-user-actionable: a fixed message avoids echoing
        // internals into a secret-bearing flow, the default log carries only
        // the error type, and the detail reaches the console only under
        // diagnostic mode -- the legacy invite surface's rule, applied literally.
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
  // download. The invitation carries the authored sftp/filedrop locator; the
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
        setSaveAlert(
          error.failure.kind === "unreadable"
            ? {
                title: "Could not read your file",
                message: sanitizeErrorForDisplay(error.failure.cause),
              }
            : error.failure.kind === "unnameable"
              ? unnameableColumnsAlert(error.failure.positions)
              : unlinkableFileAlert(error.failure.unsatisfied),
        );
      } else {
        // Internal and non-user-actionable (a schema/encoding fault): a fixed
        // message keeps internals out of a secret-bearing flow, the default
        // log carries only the error type, and the detail is diagnostic-gated.
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

  const linkable = editor !== undefined && editor.draft.keys.length > 0;
  const fileReady = name.trim().length > 0 && linkable;
  const sealed = editor?.sealed === true;

  // Inside a Customize tab no spine step is current; the step the operator
  // came from stays navigable like any completed step. The share and save
  // sections carry their own rails, so neither is a Customize tab.
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
    <BenchShell
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
            outputs === undefined
              ? undefined
              : {
                  matchedRecordCount: outputs.matchedRecordCount,
                  resultWithheld: outputs.resultWithheld,
                },
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
                sftpRemotes={sftpRemotes}
                sftpRemoteName={sftpRemoteName}
                rendezvousConfigured={rendezvousConfigured}
                onSftpRemote={setSftpRemoteName}
                onLifetime={(seconds) =>
                  applyEditor(editorWithLifetime(editor, seconds))
                }
                onDirection={(direction) =>
                  applyEditor(editorWithOutputDirection(editor, direction))
                }
                onTransport={(next) =>
                  applyEditor(editorWithTransport(editor, next))
                }
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
              onTryAgain={tryAgain}
              onStartOver={startOver}
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
    </BenchShell>
  );
}
