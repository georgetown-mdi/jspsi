import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import { Alert, Button, Checkbox, Text, TextInput } from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import { IconAlertCircle } from "@tabler/icons-react";
import log from "loglevel";

import {
  deriveAcceptedLinkageTerms,
  describeDecodeError,
  sanitizeErrorForDisplay,
} from "@psilink/core";

import { emptyColumnPositions, unnameableColumnsAlert } from "@psi/columnNames";
import { capturedInputHandle } from "@psi/managedInputHandle";
import { columnSamplesFromRows } from "@psi/columnSamples";
import { createManagedExchange } from "@psi/managedExchangeStore";
import { fetchJobRendezvous } from "@psi/workInputClient";
import { loadCSVFileOffMainThread } from "@psi/csvParseController";
import { prepareAcceptedInvitation } from "@psi/acceptInvitation";

import { deploymentProfile, isConsoleBuild } from "@utils/clientConfig";
import { whenDiagnostic } from "@utils/diagnostics";

import {
  benchCoverageProvider,
  useNonEmptyRates,
} from "@components/useNonEmptyRates";
import { CONSOLE_COVERAGE_PENDING_LABEL } from "@components/FieldCoverage";
import { InvitationTerms } from "@components/InvitationTerms";
import { MAX_CSV_FILE_BYTES } from "@components/csvIntake";
import { setColumnTypeForMatching } from "@psi/metadataEditing";

import {
  ACCEPTOR_COLUMNS_LEDGER_FOOTER,
  ACCEPTOR_LEDGER_FOOTER,
  acceptUnsupported,
  acceptorAdvisoryLocator,
  acceptorConsentName,
  acceptorConsentReady,
  acceptorDoneLedgerFooter,
  acceptorDoneLedgerRows,
  acceptorDoneLedgerTag,
  acceptorHowItRunsLabel,
  acceptorLedgerRows,
  acceptorLedgerTag,
  acceptorLegalAgreementDisplay,
  acceptorRailFacts,
  acceptorRunsAsServerJob,
  acceptorSpine,
  invitingPartyName,
} from "./acceptorModel";
import { APPLIANCE_FILE_ASSURANCE, FILE_ASSURANCE_LINE } from "./fileAssurance";
import {
  acceptorCleaningAttention,
  acceptorColumnsEditorState,
  acceptorInitialColumnsState,
  acceptorLaunchPayload,
  acceptorVerdict,
} from "./acceptorColumnsModel";
import {
  buildManagedDeposit,
  composeManagedDocument,
  webrtcLocatorFromEndpoint,
} from "./manageOfferModel";
import { AcceptorCleaningStep } from "./AcceptorCleaningStep";
import { AcceptorColumnsStep } from "./AcceptorColumnsStep";
import { AcceptorExchangeSection } from "./AcceptorExchangeSection";
import { BenchShell } from "./BenchShell";
import { Ledger } from "./Ledger";
import { ManageExchangeOffer } from "./ManageExchangeOffer";
import { Problems } from "./Problems";
import { ServerFilePicker } from "./ServerFilePicker";
import { TopBar } from "./TopBar";
import { acceptorTimelineSteps } from "./exchangeRun";
import { consoleAcquiredCsv } from "./consoleAcquiredCsv";
import { restorablePosition } from "./stepRestore";
import { seedRows } from "./inviterModel";
import styles from "./bench.module.css";
import { useAcceptorExchange } from "./useAcceptorExchange";
import { useStepHistory } from "./useStepHistory";
import { useUnloadGuard } from "./useUnloadGuard";

import type {
  AcceptableInvitation,
  AcceptorDataEdits,
} from "@psi/acceptInvitation";
import type {
  AcceptorAcquiredCsv,
  AcceptorColumnsState,
} from "./acceptorColumnsModel";
import type {
  CSVRow,
  Metadata,
  SemanticType,
  Standardization,
  StandardizationStep,
} from "@psilink/core";
import type { AcceptorLaunchSource } from "./useAcceptorExchange";
import type { AcceptorStep } from "./acceptorModel";
import type { AlertContent } from "@components/csvIntake";
import type { BenchCoverageInput } from "@components/useNonEmptyRates";
import type { ColumnSamples } from "@psi/columnSamples";
import type { FieldStepOverride } from "@psi/standardizationAuthoring";
import type { FileRejection } from "@mantine/dropzone";
import type { IntakeAlert } from "./YourFileSection";
import type { ManageOfferChoices } from "./manageOfferModel";
import type { ManageOfferStatus } from "./ManageExchangeOffer";
import type { ProfiledJobInput } from "@psi/workInputClient";
import type { RailStep } from "./inviterModel";

/** Stable empty inputs for {@link useNonEmptyRates} before a file is acquired, so the
 * hook's controller is not rebuilt every render on a fresh `[]` identity. */
const EMPTY_ROWS: ReadonlyArray<CSVRow> = [];
const EMPTY_STANDARDIZATION: Standardization = [];

/** Stable "no file yet" coverage input and preview samples, so the coverage hook's
 * provider is not rebuilt every render on a fresh identity before a file is acquired.
 * The empty-rows coverage input drives the hosted worker provider over no rows, never
 * a console fetch (mirrors {@link InviterBench}). */
const EMPTY_COVERAGE_INPUT: BenchCoverageInput = {
  kind: "rows",
  rows: EMPTY_ROWS,
};
const EMPTY_COLUMN_SAMPLES: ColumnSamples = new Map();

/** The columns-step sub-section: the main confirm surface, or the Cleaning tab the
 * Customize menu navigates to (mirroring how InviterBench mounts its
 * CleaningTab). Only meaningful while {@link AcceptorStep} is `columns`. */
type AcceptorColumnsSection = "columns" | "cleaning";

// Exhaustive over AcceptorStep (the Record keying enforces it): the steps a
// history entry restored by Back/Forward is allowed to name.
const ACCEPTOR_STEP_SET: Record<AcceptorStep, true> = {
  review: true,
  consent: true,
  columns: true,
  launched: true,
};

function isAcceptorStep(value: string): value is AcceptorStep {
  return value in ACCEPTOR_STEP_SET;
}

/** The exchange the acceptor launched: the assembled per-party edits and the
 * optional partial-coverage advisory the run surface carries forward. Drives
 * the acceptor's run surface ({@link AcceptorExchangeSection}); the run hook
 * keys on the derived launch object, so a fresh launch restarts the run. */
interface AcceptorLaunched {
  edits: AcceptorDataEdits;
  warning?: AlertContent;
}

/** The async decode's outcome: pending while it runs, an error message on a bad
 * or expired invitation, or the validated invitation ready to review. Mirrors the
 * legacy accept route's DecodeState. */
type DecodeState =
  | { status: "pending" }
  | { status: "error"; message: string }
  | { status: "ready"; invitation: AcceptableInvitation };

/** A titled inline error rendered beside a consent-step field when a submit slips
 * past the disabled gate and fails the handler re-check. */
interface FieldErrors {
  name?: string;
  file?: boolean;
}

/** Human file size for the consent filecard, e.g. `8.4 MB` / `12 KB`. The
 * acceptor's file is held unparsed here, so the card shows its size, not a row
 * count (parsing stays behind the consent gate). */
function fileSizeLabel(sizeBytes: number): string {
  return sizeBytes >= 1024 ** 2
    ? `${(sizeBytes / 1024 ** 2).toFixed(1)} MB`
    : `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
}

/**
 * The acceptor's pre-columns working surface. It decodes the invitation from the
 * URL fragment (failing closed before anything renders), reviews the partner's
 * terms, captures explicit consent and a name, and takes the acceptor's file --
 * then commits it behind the consent gate (parsing it in the browser on the hosted
 * build, or referencing the appliance-profiled mounted file on the console) and
 * hands off to the confirm-columns step. On the console an invitation whose endpoint
 * the appliance cannot run -- no accept channel is appliance-runnable today -- is
 * stopped at the review step with an honest state before consent or intake.
 *
 * The consent semantics are re-surfaced from the hardened legacy flow, never
 * re-derived: {@link InvitationTerms} renders the full, never-condensed terms at
 * the review step, and {@link acceptorConsentName} (the shared `commitAcceptance`
 * gate) governs the consent step's submit BOTH as its disabled state and as a
 * re-check inside the handler, exactly as the legacy accept flow did.
 */
export function AcceptorBench() {
  const consoleBuild = isConsoleBuild();
  const [decode, setDecode] = useState<DecodeState>({ status: "pending" });
  const [step, setStep] = useState<AcceptorStep>("review");
  // The columns-step sub-section: the confirm surface, or the Cleaning tab the
  // Customize menu navigates to. Only meaningful while `step` is `columns`.
  const [columnsSection, setColumnsSection] =
    useState<AcceptorColumnsSection>("columns");
  // The consent gate's two inputs; the file is held as an unparsed handle until
  // "Accept and continue" fires and passes the gate.
  const [consented, setConsented] = useState(false);
  const [acceptorName, setAcceptorName] = useState("");
  // The name recorded in the exchange record, committed through the consent gate
  // at "Accept and continue" and fixed thereafter -- the run adopts the terms
  // under this identity, so it must not drift with a later edit to the input.
  const [committedName, setCommittedName] = useState("");
  const [file, setFile] = useState<File>();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [rejectionMessage, setRejectionMessage] = useState<string>();
  const [parseAlert, setParseAlert] = useState<IntakeAlert>();
  const [parsing, setParsing] = useState(false);
  // The acceptor's own parsed CSV, stored on a passing parse (not discarded) so the
  // columns step and its verdict derive from it; and the layered column-step editor
  // state (metadata + override layers), seeded once from the acquired columns.
  const [acquired, setAcquired] = useState<AcceptorAcquiredCsv>();
  // The original file whose parse produced `acquired`, captured at the same commit
  // so the server-job path submits the exact bytes the browser path parsed (no
  // re-serialization of rawRows). Fixed alongside `acquired` and the committed name.
  const [acceptedFile, setAcceptedFile] = useState<File>();
  // The File System Access handle the committed file's selection yielded, where
  // the platform gave one (a drop on Chromium in a secure context); captured so a
  // managed deposit can persist a reusable pointer to the input without a second
  // picker dialog. Absent for a click-selected file and a browser without the API.
  const [sourceHandle, setSourceHandle] = useState<FileSystemFileHandle>();
  // The console profile behind the acquired shape: the appliance reads the file, so
  // the browser holds only the profile (name, size, mtime, columns, samples, date
  // format), committed via the picker's "Use this file" before consent. It backs the
  // columns seed, the run's mounted-file reference, the coverage sweep, and the preview
  // samples. Undefined on the hosted build, which reads the file in the browser behind
  // the consent gate instead.
  const [consoleSource, setConsoleSource] = useState<ProfiledJobInput>();
  const [columnsState, setColumnsState] = useState<AcceptorColumnsState>();
  // Whether the appliance has a rendezvous mount, fetched once on a console build.
  // Undefined before it resolves; a console filedrop accept is runnable only when
  // `configured` is true (the exchange runs against the mounted directory).
  const [rendezvousConfigured, setRendezvousConfigured] = useState<boolean>();
  const [manageStatus, setManageStatus] = useState<ManageOfferStatus>("idle");
  // The launched exchange (the assembled edits + optional advisory); rendering the
  // minimal run stub the next package replaces.
  const [launched, setLaunched] = useState<AcceptorLaunched>();

  // Decode the fragment token once, failing closed: an empty fragment, a bad
  // checksum/schema, an expired token, or an endpoint this build cannot drive
  // (SFTP, or a filedrop endpoint on a non-console build) each throws in
  // prepareAcceptedInvitation and lands on the focused error alert; only a valid
  // invitation reaches the review step. The token rides ONLY in the fragment,
  // which never reaches the server. Aborted on unmount so a resolving decode does
  // not setState after teardown.
  useEffect(() => {
    const encoded = window.location.hash.replace(/^#/, "");
    if (encoded === "") {
      setDecode({
        status: "error",
        message:
          "No invitation was found in this link. Paste the code into the " +
          "accept form instead.",
      });
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const invitation = await prepareAcceptedInvitation(encoded, {
          profile: deploymentProfile(),
        });
        // Learn the rendezvous state before revealing the terms so the review step
        // decides a console filedrop accept's runnability with the mount known,
        // rather than flashing "unavailable" while a fetch settles.
        const rvzConfigured = consoleBuild
          ? (await fetchJobRendezvous()).configured
          : false;
        if (!controller.signal.aborted) {
          setRendezvousConfigured(rvzConfigured);
          setDecode({ status: "ready", invitation });
        }
      } catch (error) {
        if (!controller.signal.aborted)
          setDecode({ status: "error", message: describeDecodeError(error) });
      }
    })();
    return () => controller.abort();
  }, []);

  // A console accept whose endpoint the appliance cannot run, decided by the endpoint
  // SHAPE ({@link acceptUnsupported}): a WebRTC accept is out of scope here, a
  // split-directory file-drop needs the command-line tool, and a single-directory
  // file-drop needs a rendezvous mount. Surfaced at the review step BEFORE consent or
  // intake, so the operator meets an honest block naming where it CAN run rather than a
  // doomed run. Off the console every admitted endpoint runs in the browser, so this is
  // undefined there.
  const unsupported =
    consoleBuild && decode.status === "ready"
      ? acceptUnsupported(
          decode.invitation.endpoint,
          rendezvousConfigured === true,
        )
      : undefined;

  // On the review step, move focus to the terms heading once the decode resolves
  // to ready, to the unsupported notice when the appliance cannot run this accept,
  // or to the error alert once it resolves to error, so a screen-reader user is
  // taken to the revealed terms, the block, or the failure rather than left on the
  // spinner. The consent and columns steps own their own heading focus below.
  const termsHeadingRef = useRef<HTMLHeadingElement>(null);
  const unsupportedRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const unsupportedShown = unsupported !== undefined;
  useEffect(() => {
    if (step !== "review") return;
    if (decode.status === "ready")
      (unsupportedShown ? unsupportedRef : termsHeadingRef).current?.focus();
    else if (decode.status === "error") errorRef.current?.focus();
  }, [decode.status, step, unsupportedShown]);

  // Moving to the consent step replaces the work column, so focus is sent to the
  // incoming h1 (it carries tabIndex -1) or a screen-reader user is left on a control
  // that no longer exists. Skipped on mount and on the review step (the decode effect
  // owns its focus); the columns, cleaning, and launched surfaces each focus their
  // own heading on entry, so this effect covers only the consent step.
  const stepHeadingRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current && step === "consent")
      stepHeadingRef.current?.querySelector("h1")?.focus();
    mounted.current = true;
  }, [step]);

  // Opens the dropzone's file picker from the filecard's "Choose a different
  // file" button.
  const openFilePicker = useRef<() => void>(null);

  // A parse may be in flight when the surface unmounts; the id lets a stale
  // resolution fall on the floor and the abort tears the parse worker down.
  const parseId = useRef(0);
  const parseAbort = useRef<AbortController | undefined>(undefined);
  useEffect(
    () => () => {
      parseId.current += 1;
      parseAbort.current?.abort();
    },
    [],
  );

  // The acceptor's position is a step plus, on the columns step, its
  // sub-section (confirm vs. the Cleaning tab). Both fold into one opaque token
  // so a browser Back/Forward restores the exact surface, including the tab.
  const positionToken = (
    nextStep: AcceptorStep,
    nextColumnsSection: AcceptorColumnsSection,
  ): string =>
    nextStep === "columns" && nextColumnsSection === "cleaning"
      ? "columns:cleaning"
      : nextStep;

  // Apply a position arriving from a browser Back/Forward: set the step and its
  // sub-section without pushing a new history entry (the browser already moved
  // the cursor). The bench stays mounted, so the loaded file, the confirmed
  // columns, and every in-progress edit survive the transition untouched. A
  // token naming no live step (a stale entry from before a deploy renamed one)
  // is ignored rather than rendered as an empty work column. A position whose
  // backing state is gone (a `launched` entry left behind by a back-to-columns
  // recovery) clamps to a step that can still render; the settled token is
  // returned so the hook rewrites the dead entry.
  function restorePosition(token: string): string | void {
    const settled = restorablePosition(token, {
      hasLaunch: launched !== undefined,
    });
    if (settled === "columns:cleaning") {
      setColumnsSection("cleaning");
      setStep("columns");
      return settled;
    }
    if (!isAcceptorStep(settled)) return;
    setColumnsSection("columns");
    setStep(settled);
    return settled;
  }

  const { pushStep } = useStepHistory("review", restorePosition);

  // Move to a new step and its sub-section, pushing a history entry so Back
  // returns here. Every in-bench step transition routes through this.
  function goToStep(
    nextStep: AcceptorStep,
    nextColumnsSection: AcceptorColumnsSection = "columns",
  ) {
    if (nextStep === step && nextColumnsSection === columnsSection) return;
    setColumnsSection(nextColumnsSection);
    setStep(nextStep);
    pushStep(positionToken(nextStep, nextColumnsSection));
  }

  function selectFile(chosen: File) {
    setRejectionMessage(undefined);
    setParseAlert(undefined);
    setFieldErrors((current) => ({ ...current, file: false }));
    setFile(chosen);
  }

  // The file-assurance line for the acceptor's own intake: with the console now
  // reading the file on the appliance, the acceptor opts into the mounted-directory
  // claim explicitly (as the inviter's YourFileSection does), while the hosted build
  // keeps the browser-only line. Not FILE_ASSURANCE_LINE alone -- that resolves to no
  // claim on the console, which would leave this truthful surface silent.
  const acceptAssuranceLine = consoleBuild
    ? APPLIANCE_FILE_ASSURANCE
    : FILE_ASSURANCE_LINE;

  // The dropzone enforces the size cap and type list itself but only flashes a
  // reject icon; name why. Codes only in the log -- a rejected file's NAME can
  // itself be sensitive here.
  const maxMb = MAX_CSV_FILE_BYTES / 1024 ** 2;
  function handleReject(rejections: Array<FileRejection>) {
    const codes = new Set(
      rejections.flatMap((rejection) =>
        rejection.errors.map((error) => error.code),
      ),
    );
    log.warn(`rejected ${rejections.length} file(s):`, [...codes]);
    const reasons: Array<string> = [];
    if (codes.has("file-too-large"))
      reasons.push(`larger than the ${maxMb} MB maximum`);
    if (codes.has("file-invalid-type") || reasons.length === 0)
      reasons.push("not a supported file type");
    setRejectionMessage(
      `That file is ${reasons.join(" and ")}. Choose a CSV file under ${maxMb} MB.`,
    );
  }

  // Commit a profiled mounted file (the console picker's "Use this file") to the
  // consent step. A blank header cell is refused early with the shared unnameable
  // alert -- core's inferMetadata would otherwise throw when the columns-step editor
  // seeds and unmount the bench. The editor is seeded here from the profile's column
  // NAMES (which the operator already saw in the picker's confirm panel, not from
  // file content), reconciling a re-profile of the committed file the way the inviter
  // does: unchanged columns keep the operator's remaps and cleaning edits, changed
  // columns reseed. `acquired` stays unset until the consent gate passes, so the
  // columns step is still gated on "Accept and continue".
  function commitConsoleAcceptFile(profile: ProfiledJobInput) {
    const emptyPositions = emptyColumnPositions(profile.columns);
    if (emptyPositions.length > 0) {
      setParseAlert(unnameableColumnsAlert(emptyPositions));
      return;
    }
    setParseAlert(undefined);
    setFieldErrors((current) => ({ ...current, file: false }));
    const columnsUnchanged =
      consoleSource !== undefined &&
      consoleSource.name === profile.name &&
      columnsState !== undefined &&
      consoleSource.columns.length === profile.columns.length &&
      consoleSource.columns.every(
        (column, index) => column === profile.columns[index],
      );
    setConsoleSource(profile);
    if (!columnsUnchanged)
      setColumnsState(acceptorInitialColumnsState(profile.columns));
  }

  // "Accept and continue": re-check the consent gate in the handler (not the
  // disabled state alone), surface the mockup's inline errors when a submit slips
  // past it, then commit the file behind the gate. On the hosted build the file is
  // parsed here (the browser holds the rows); on the console the appliance already
  // profiled it, so the acquired shape is built from the committed profile (no rows,
  // no parse). Only a clean commit advances to the confirm-columns step.
  async function acceptAndContinue() {
    if (decode.status !== "ready") return;
    const name = acceptorConsentName({ consented, name: acceptorName });
    const fileChosen = consoleBuild
      ? consoleSource !== undefined
      : file !== undefined;
    if (name === undefined || !fileChosen) {
      const nextErrors: FieldErrors = {};
      if (name === undefined && acceptorName.trim() === "")
        nextErrors.name = "Your name is required";
      if (!fileChosen) nextErrors.file = true;
      setFieldErrors(nextErrors);
      return;
    }
    setFieldErrors({});

    if (consoleBuild) {
      // The console reads the file on the appliance: the profile was committed and
      // the columns seeded via the picker, so there is no browser parse behind the
      // gate. Build the acquired shape from the profile (rows withheld) and advance,
      // committing the gate-checked name so the run records it even if the input is
      // later edited.
      if (consoleSource === undefined) return;
      setCommittedName(name);
      setAcquired(
        consoleAcquiredCsv({
          fileName: consoleSource.name,
          sizeBytes: consoleSource.sizeBytes,
          columns: consoleSource.columns,
          rowCount: consoleSource.rowCount,
          dateInputFormat: consoleSource.dateInputFormat,
        }),
      );
      goToStep("columns");
      return;
    }

    // Narrows `file` for the hosted parse below (the `fileChosen` boolean does not).
    if (file === undefined) return;
    const id = ++parseId.current;
    parseAbort.current?.abort();
    const controller = new AbortController();
    parseAbort.current = controller;
    setParsing(true);
    setParseAlert(undefined);
    try {
      const result = await loadCSVFileOffMainThread(file, {
        signal: controller.signal,
      });
      if (id !== parseId.current) return;
      const columns = result.meta.fields ?? [];
      const emptyPositions = emptyColumnPositions(columns);
      if (emptyPositions.length > 0) {
        setParseAlert(unnameableColumnsAlert(emptyPositions));
        return;
      }
      // Store the parsed CSV (not discard it) and seed the columns-step editor from
      // its columns; the verdict and launch payload derive from this state. Commit
      // the gate-checked name here so the run records it even if the input is later
      // edited (the input stays editable; the committed identity does not drift).
      setCommittedName(name);
      setAcceptedFile(file);
      setSourceHandle(capturedInputHandle(file));
      setAcquired({
        fileName: file.name,
        sizeBytes: file.size,
        columns,
        rawRows: result.data,
        rowCount: result.data.length,
      });
      setColumnsState(acceptorInitialColumnsState(columns));
      goToStep("columns");
    } catch (error) {
      if (id !== parseId.current) return;
      // A parse failure keeps every input: the file handle, the name, and the
      // consent all survive so the operator can retry or swap files.
      setParseAlert({
        title: "Could not read your file",
        message: sanitizeErrorForDisplay(error),
      });
    } finally {
      if (id === parseId.current) setParsing(false);
    }
  }

  const ready = decode.status === "ready";
  const token = ready ? decode.invitation.token : undefined;
  // Whether this accept runs on the appliance as a server job (a console file-drop)
  // rather than in the browser: the one signal behind the "How it runs" ledger row
  // and the settled footer's "never left this browser" claim.
  const acceptServerJob =
    ready && acceptorRunsAsServerJob(decode.invitation.endpoint, consoleBuild);
  // The ledger's "How it runs" phrasing, from the accepted endpoint's run mode: a
  // console single-directory file-drop accept runs on the appliance (the shared
  // directory), every other admitted accept in this browser.
  const howItRuns = ready
    ? acceptorHowItRunsLabel(decode.invitation.endpoint, consoleBuild)
    : "";
  // The partner's advisory shared-directory locator, shown read-only at the consent
  // step for a runnable console file-drop accept so the operator confirms it names the
  // same synced folder mounted on this appliance. Partner-supplied and sanitized
  // through summarizeInvitation; never flows to config. Present only once the accept
  // is runnable (past the unsupported gate), so a doomed accept does not surface it.
  const advisoryLocator =
    ready && acceptServerJob && unsupported === undefined
      ? acceptorAdvisoryLocator(decode.invitation.token)
      : undefined;
  const linkageTerms = token?.linkageTerms;
  // The sanitized legal-agreement values the consent step displays beside the
  // attestation; undefined when the invitation attaches none (no fieldset then).
  // Display only -- consent stays gated on the checkbox and name alone.
  const legalAgreementDisplay =
    token !== undefined ? acceptorLegalAgreementDisplay(token) : undefined;

  // The effective { metadata, standardization } the verdict and launch both consume,
  // derived from the columns-step state in one place (see
  // acceptorColumnsEditorState). Undefined until a file is acquired.
  const editorState =
    columnsState !== undefined &&
    acquired !== undefined &&
    linkageTerms !== undefined
      ? acceptorColumnsEditorState(
          columnsState,
          linkageTerms,
          seedRows(acquired),
          acquired.dateInputFormat,
        )
      : undefined;
  const verdict =
    editorState !== undefined &&
    acquired !== undefined &&
    linkageTerms !== undefined
      ? acceptorVerdict(acquired.columns, linkageTerms, editorState)
      : undefined;

  // The run's launch, assembled once when the columns step commits: the decoded
  // invitation, the committed name, the acquired CSV, and the edited spec. Keyed
  // on `launched` so the run hook restarts only on a fresh launch, not on every
  // render. `launched` is set only when `acquired`, the ready decode, and the
  // committed name all exist (launchExchange gates on the verdict), so the guard
  // just narrows their types.
  const launch = useMemo(() => {
    if (
      launched === undefined ||
      decode.status !== "ready" ||
      acquired === undefined
    )
      return undefined;
    // The run's input source: the console's mounted-file reference (no content
    // transits the browser), or the hosted browser File the server-job inline path
    // reads. The WebRTC path uses the retained rows and never reads it.
    const inputSource: AcceptorLaunchSource | undefined =
      consoleSource !== undefined
        ? { kind: "workFile", name: consoleSource.name }
        : acceptedFile !== undefined
          ? { kind: "inline", file: acceptedFile }
          : undefined;
    if (inputSource === undefined) return undefined;
    return {
      invitation: decode.invitation,
      acceptorName: committedName,
      rawRows: seedRows(acquired),
      columns: acquired.columns,
      edits: launched.edits,
      inputSource,
    };
    // `launched` is the launch key: it is set once, from the same render that
    // fixes the acquired CSV, its input source, the committed name, and the ready
    // decode, so keying the memo on it alone cannot go stale.
  }, [launched]);

  const { run, outputs, failure, tryAgain } = useAcceptorExchange({ launch });

  // A console server-job accept is still executing on the appliance while it is
  // launched and the run has not settled; leaving the page abandons it (an
  // in-app teardown cancels the run, a hard close strands it).
  const consoleExchangeRunning =
    acceptServerJob &&
    launched !== undefined &&
    outputs === undefined &&
    failure === undefined;

  // The unload guard arms once the acceptor's file is chosen -- a browser drop on
  // the hosted build, or a committed mounted-file profile on the console -- and
  // disarms once the exchange is launched (a browser run is dialing), unless a
  // console server-job exchange is still running on the appliance, which keeps it
  // armed until the run settles.
  useUnloadGuard({
    hasFile: file !== undefined || consoleSource !== undefined,
    finalized: launched !== undefined,
    consoleExchangeRunning,
  });

  // The coverage input, unified across builds: the browser's parsed rows on the
  // hosted build, the mounted-file reference on the console (whose sweep is a fetch
  // to the appliance). Memoized so a standardization edit reuses the provider and
  // only a new file rebuilds it. The console reads no rows -- `acquired.rawRows` is a
  // throwing getter there -- so this never touches it on that path.
  const coverageInput = useMemo<BenchCoverageInput>(() => {
    if (consoleSource !== undefined)
      return { kind: "workFile", reference: { name: consoleSource.name } };
    if (!consoleBuild && acquired !== undefined)
      return { kind: "rows", rows: acquired.rawRows };
    return EMPTY_COVERAGE_INPUT;
  }, [acquired, consoleSource, consoleBuild]);

  // The per-column preview samples the Cleaning tab reads: computed from the browser
  // rows on the hosted build, read from the server-side profile on the console. Kept
  // off `acquired.rawRows` on the console for the same reason as the coverage input.
  const columnSamples = useMemo<ColumnSamples>(() => {
    if (consoleSource !== undefined) return consoleSource.columnSamples;
    if (!consoleBuild && acquired !== undefined)
      return columnSamplesFromRows(acquired.rawRows, acquired.columns);
    return EMPTY_COLUMN_SAMPLES;
  }, [acquired, consoleSource, consoleBuild]);

  // Full-CSV coverage for the cleaning tab and the Customize menu's
  // Cleaning-attention value, one sweep shared by both. The hook must run
  // every render, so it takes stable empty inputs until a file is acquired.
  const { rates, pending: ratesPending } = useNonEmptyRates(
    coverageInput,
    editorState?.standardization ?? EMPTY_STANDARDIZATION,
    benchCoverageProvider,
  );
  const cleaningAttention =
    editorState !== undefined && verdict !== undefined
      ? acceptorCleaningAttention(
          editorState.standardization,
          rates,
          verdict.deadKeyCount,
        )
      : undefined;

  const spineSteps: Array<RailStep> =
    step === "launched"
      ? []
      : acceptorSpine(step).map((entry) => ({
          label: entry.label,
          state: entry.state,
          onSelect: entry.navigable ? () => goToStep(entry.step) : undefined,
        }));

  const customizeFacts = acceptorRailFacts(cleaningAttention?.railValue).map(
    (fact) => ({
      ...fact,
      // The Cleaning tab is reachable only once a file is acquired (the
      // columns step exists). Selecting it navigates the columns
      // sub-section, as InviterBench mounts its CleaningTab.
      onSelect:
        editorState !== undefined && step === "columns"
          ? () => goToStep("columns", "cleaning")
          : undefined,
      current: step === "columns" && columnsSection === "cleaning",
    }),
  );

  const topBar =
    step === "launched" ? (
      <TopBar
        navLabel="Exchange progress"
        steps={acceptorTimelineSteps(run)}
        transportNote="Browser"
      />
    ) : (
      <TopBar navLabel="Accept an invitation" steps={spineSteps} />
    );

  // The confirm-columns partial-coverage advisory surfaces in the work
  // column's Problems block as well as its own amber alert, while the run
  // has not failed (a failure clears it so it cannot read as the cause).
  const launchedProblems =
    step === "launched" &&
    launched?.warning !== undefined &&
    failure === undefined
      ? [{ label: launched.warning.title }]
      : [];

  // The ledger settles once the exchange completes: the tag names who it was
  // agreed with, the rows relabel past tense with the actual outcome, and the
  // footer states the file never left. Until then it mirrors the partner's
  // proposal, with the columns step's local-only footer swapped in.
  const settled = outputs !== undefined;
  const ledger =
    token === undefined ? undefined : (
      <Ledger
        tag={
          settled
            ? acceptorDoneLedgerTag(invitingPartyName(token))
            : acceptorLedgerTag(invitingPartyName(token))
        }
        customize={step === "launched" ? undefined : customizeFacts}
        rows={(settled && launched !== undefined
          ? acceptorDoneLedgerRows(
              token,
              {
                matchedRecordCount: outputs.matchedRecordCount,
                resultWithheld: outputs.resultWithheld,
              },
              launched.edits.metadata,
              howItRuns,
            )
          : // From the confirm-columns step onward the live metadata governs what
            // leaves this browser, so the send row names exactly that; before a
            // file exists (`editorState` undefined) the row forward-references the
            // confirm-columns step.
            acceptorLedgerRows(token, howItRuns, editorState?.metadata)
        ).map((row) => ({
          label: row.label,
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
          settled
            ? acceptorDoneLedgerFooter(acceptServerJob)
            : step === "columns"
              ? ACCEPTOR_COLUMNS_LEDGER_FOOTER
              : ACCEPTOR_LEDGER_FOOTER
        }
      />
    );

  const consentGateReady = acceptorConsentReady({
    consented,
    name: acceptorName,
  });

  // The columns-step edit callbacks over the shared layered state: a metadata edit
  // replaces the metadata layer; a remap re-roles the chosen column for matching
  // (setColumnTypeForMatching, forcing role linkage, not a bare retype); a cleaning
  // edit sets an override layer; reset returns to the seed.
  const changeMetadata = (next: Metadata) =>
    setColumnsState((prev) =>
      prev === undefined ? prev : { ...prev, metadata: next },
    );
  const remapColumn = (type: SemanticType, columnName: string) =>
    setColumnsState((prev) =>
      prev === undefined
        ? prev
        : {
            ...prev,
            metadata: setColumnTypeForMatching(prev.metadata, columnName, type),
          },
    );
  const setFieldSteps = (output: string, steps: Array<StandardizationStep>) => {
    const input = editorState?.standardization.find(
      (transformation) => transformation.output === output,
    )?.input;
    if (input === undefined) return;
    setColumnsState((prev) =>
      prev === undefined
        ? prev
        : {
            ...prev,
            stepOverrides: new Map<string, FieldStepOverride>(
              prev.stepOverrides,
            ).set(output, { input, steps }),
          },
    );
  };
  const setFieldInput = (output: string, column: string) =>
    setColumnsState((prev) =>
      prev === undefined
        ? prev
        : {
            ...prev,
            inputOverrides: new Map<string, string>(prev.inputOverrides).set(
              output,
              column,
            ),
          },
    );
  const resetColumns = () =>
    setColumnsState((prev) =>
      prev === undefined || acquired === undefined
        ? prev
        : acceptorInitialColumnsState(acquired.columns),
    );
  const launchExchange = () => {
    if (verdict === undefined || editorState === undefined) return;
    setLaunched(acceptorLaunchPayload(verdict, editorState));
    goToStep("launched");
  };

  // The config-failure recovery: discard the launch (which aborts the run via the
  // hook's effect cleanup and resets it) and return to the confirm-columns step
  // with every column-step input intact, where the acceptor fixes its settings.
  const backToColumns = () => {
    setLaunched(undefined);
    setManageStatus("idle");
    goToStep("columns");
  };

  // Deposit a managed-exchange record for this exchange as the acceptor: this
  // party's own perspective of the terms plus the secret carried in the
  // invitation link, so the same partnership can run again later. The connection
  // block is composed from the INVITATION's endpoint (the acceptor's rendezvous
  // is the inviter's signaling location, not this browser's), and this party's
  // linkage terms are its derived perspective (identity replaced, output/payload
  // mirrored) with its own authored metadata and standardization -- the exact
  // spec this run used. The token's disclosed set is persisted as the record's
  // expectedPayloadColumns (empty = strict receive-nothing; an absent set stays
  // absent = lazy), exactly as the CLI accept persists it, so a managed re-run
  // fails closed if the partner transmits a set diverging from what was
  // consented to here. The secret is the invitation's; the one-shot run discards
  // its own derived rotation, so the record stays coherent at this value until a
  // managed re-run rotates it. Declining is simply not pressing Manage.
  async function manageExchange(choices: ManageOfferChoices) {
    if (decode.status !== "ready" || launched === undefined) return;
    const { token: invitationToken, endpoint } = decode.invitation;
    if (endpoint.channel !== "webrtc") return;
    setManageStatus("depositing");
    try {
      const exchangeFile = composeManagedDocument(
        {
          linkageTerms: deriveAcceptedLinkageTerms(
            invitationToken.linkageTerms,
            committedName,
          ),
          metadata: launched.edits.metadata,
          standardization: launched.edits.standardization,
          ...(invitationToken.disclosedPayloadColumns !== undefined
            ? {
                expectedPayloadColumns: invitationToken.disclosedPayloadColumns,
              }
            : {}),
        },
        webrtcLocatorFromEndpoint(endpoint),
      );
      await createManagedExchange(
        buildManagedDeposit(
          {
            side: "acceptor",
            exchangeFile,
            sharedSecret: invitationToken.sharedSecret,
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

  const cleaningResetKey =
    editorState?.standardization
      .map(
        (transformation) => `${transformation.output}=${transformation.input}`,
      )
      .join(",") ?? "";

  return (
    <BenchShell topBar={ready ? topBar : undefined} ledger={ledger}>
      <div ref={stepHeadingRef}>
        <Problems problems={launchedProblems} />
        {decode.status === "pending" && (
          <p aria-live="polite">Reading your invitation...</p>
        )}
        {decode.status === "error" && (
          <Alert
            color="red"
            icon={<IconAlertCircle aria-hidden />}
            title="Cannot accept this invitation"
            ref={errorRef}
            tabIndex={-1}
            style={{ whiteSpace: "pre-line" }}
          >
            {decode.message}
          </Alert>
        )}
        {decode.status === "ready" && step === "review" && (
          <>
            <InvitationTerms
              linkageTerms={decode.invitation.token.linkageTerms}
              expires={decode.invitation.token.expires}
              disclosedPayloadColumns={
                decode.invitation.token.disclosedPayloadColumns
              }
              perspective="review"
              headingOrder={1}
              headingRef={termsHeadingRef}
            />
            {/* The appliance cannot run this endpoint's shape: stop here, before
                consent or intake, with an honest state naming where the operator CAN
                run it rather than a doomed run. */}
            {unsupported !== undefined ? (
              <Alert
                color="orange"
                icon={<IconAlertCircle aria-hidden />}
                title={unsupported.title}
                ref={unsupportedRef}
                tabIndex={-1}
                mt="md"
              >
                {unsupported.message}
              </Alert>
            ) : (
              <div className={styles.workFoot}>
                <Button onClick={() => goToStep("consent")}>
                  Continue: consent &amp; your file
                </Button>
              </div>
            )}
          </>
        )}
        {decode.status === "ready" && step === "consent" && (
          <>
            <p className={styles.eyebrow}>Step 2 of 3</p>
            <h1 tabIndex={-1}>Consent &amp; your file</h1>
            <p className={`${styles.small} ${styles.sub}`}>
              This invitation should have reached you over a trusted channel.
              {consoleBuild
                ? " This appliance runs the exchange from its mounted work directory."
                : " Your browser connects directly to your partner."}
            </p>
            <Checkbox
              mt="md"
              checked={consented}
              onChange={(event) => setConsented(event.currentTarget.checked)}
              label="I have reviewed my partner's proposed terms and consent to this exchange"
            />
            <TextInput
              mt="md"
              withAsterisk
              required
              label="Your name"
              description="Shown to your partner so they can identify you in this exchange"
              value={acceptorName}
              maxLength={200}
              error={fieldErrors.name}
              onChange={(event) => {
                setAcceptorName(event.currentTarget.value);
                if (fieldErrors.name !== undefined)
                  setFieldErrors((current) => ({
                    ...current,
                    name: undefined,
                  }));
              }}
            />
            {consoleBuild ? (
              <ServerFilePicker
                committed={
                  consoleSource !== undefined
                    ? { name: consoleSource.name }
                    : undefined
                }
                onUse={commitConsoleAcceptFile}
              />
            ) : (
              <>
                <Dropzone
                  className={styles.dropzone}
                  openRef={openFilePicker}
                  onDrop={(files) => {
                    const chosen = files.at(0);
                    if (chosen !== undefined) selectFile(chosen);
                  }}
                  onReject={handleReject}
                  accept={[
                    "text/plain",
                    "text/csv",
                    "application/vnd.ms-excel",
                  ]}
                  maxSize={MAX_CSV_FILE_BYTES}
                  multiple={false}
                  loading={parsing}
                  aria-label="Your data file"
                  mt="md"
                >
                  <p>
                    <strong>Drag files here or click to select</strong>
                  </p>
                  <p className={styles.dropzoneMax}>
                    (Max file size: {maxMb} MB)
                  </p>
                </Dropzone>
                {rejectionMessage !== undefined && (
                  <Text role="alert" c="red" size="sm" mt="xs">
                    {rejectionMessage}
                  </Text>
                )}
                {file !== undefined && (
                  <div className={styles.fileCard}>
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      aria-hidden="true"
                    >
                      <path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z" />
                      <path d="M13 3v6h6" />
                    </svg>
                    <div>
                      <div className={`${styles.fileName} ${styles.mono}`}>
                        {file.name}
                      </div>
                      <div className={`${styles.fileMeta} ${styles.mono}`}>
                        {fileSizeLabel(file.size)}
                      </div>
                    </div>
                    <Button
                      variant="subtle"
                      size="compact-sm"
                      ml="auto"
                      onClick={() => openFilePicker.current?.()}
                    >
                      Choose a different file
                    </Button>
                  </div>
                )}
              </>
            )}
            {advisoryLocator !== undefined && (
              <Alert
                color="blue"
                icon={<IconAlertCircle aria-hidden />}
                title="Confirm the shared folder"
                mt="md"
              >
                Your partner named this shared folder:{" "}
                <span className={styles.mono}>{advisoryLocator}</span>. Confirm
                it is the synced folder mounted on this appliance.
              </Alert>
            )}
            {acceptAssuranceLine !== undefined && (
              <p className={`${styles.small} ${styles.sub}`}>
                {acceptAssuranceLine}
              </p>
            )}
            {fieldErrors.file === true && (
              <Alert
                color="red"
                title="Choose a data file"
                icon={<IconAlertCircle aria-hidden />}
                mt="md"
              >
                {consoleBuild
                  ? "A file is needed before the exchange can be set up. Choose one from the work directory above."
                  : "A file is needed before the exchange can be set up. Drag one into the dropzone or click it to select."}
              </Alert>
            )}
            {parseAlert !== undefined && (
              <Alert
                color="red"
                title={parseAlert.title}
                icon={<IconAlertCircle aria-hidden />}
                mt="md"
              >
                <span style={{ whiteSpace: "pre-line" }}>
                  {parseAlert.message}
                </span>
              </Alert>
            )}
            {legalAgreementDisplay !== undefined && (
              <fieldset className={styles.fieldset}>
                <legend>Legal agreement</legend>
                <p className={`${styles.small} ${styles.sub}`}>
                  Check these values against your signed agreement before you
                  accept.
                </p>
                <Text size="sm">
                  Agreement reference:{" "}
                  <span className={styles.mono}>
                    {legalAgreementDisplay.reference}
                  </span>
                </Text>
                <Text size="sm">
                  Stated purpose of the disclosure:{" "}
                  {legalAgreementDisplay.purpose}
                </Text>
                <Text size="sm">
                  Expiration date:{" "}
                  <span className={styles.mono}>
                    {legalAgreementDisplay.expirationDate}
                  </span>
                </Text>
                {legalAgreementDisplay.alteredForDisplay && (
                  <p className={`${styles.small} ${styles.sub}`}>
                    Some characters here are shown as escape codes because they
                    fall outside plain ASCII, so these values may not read
                    exactly as they do in your document.
                  </p>
                )}
              </fieldset>
            )}
            <div className={styles.workFoot}>
              <Button
                disabled={!consentGateReady || parsing}
                onClick={() => void acceptAndContinue()}
              >
                Accept and continue
              </Button>
            </div>
          </>
        )}
        {decode.status === "ready" &&
          step === "columns" &&
          columnsSection === "columns" &&
          acquired !== undefined &&
          columnsState !== undefined &&
          editorState !== undefined &&
          verdict !== undefined &&
          linkageTerms !== undefined && (
            <AcceptorColumnsStep
              linkageTerms={linkageTerms}
              columns={acquired.columns}
              columnsState={columnsState}
              editorState={editorState}
              verdict={verdict}
              onMetadataChange={changeMetadata}
              onRemap={remapColumn}
              onReset={resetColumns}
              onLaunch={launchExchange}
              onBack={() => goToStep("consent")}
            />
          )}
        {decode.status === "ready" &&
          step === "columns" &&
          columnsSection === "cleaning" &&
          acquired !== undefined &&
          editorState !== undefined &&
          verdict !== undefined &&
          linkageTerms !== undefined && (
            <AcceptorCleaningStep
              declaredFields={linkageTerms.linkageFields}
              metadata={editorState.metadata}
              standardization={editorState.standardization}
              columnSamples={columnSamples}
              rates={rates}
              ratesPending={ratesPending}
              deadKeyCount={verdict.deadKeyCount}
              cleaningResetKey={cleaningResetKey}
              {...(consoleSource !== undefined
                ? { coveragePendingLabel: CONSOLE_COVERAGE_PENDING_LABEL }
                : {})}
              onFieldSteps={setFieldSteps}
              onFieldInput={setFieldInput}
              onReset={resetColumns}
              onBack={() => goToStep("columns")}
            />
          )}
        {decode.status === "ready" && step === "launched" && (
          <>
            <AcceptorExchangeSection
              invitation={decode.invitation}
              run={run}
              outputs={outputs}
              failure={failure}
              warning={launched?.warning}
              serverJob={acceptServerJob}
              onTryAgain={tryAgain}
              onFixColumns={backToColumns}
            />
            {/* The manage offer is webrtc-only (its record composes a webrtc
                locator from the invitation's endpoint) and is skippable: leaving
                it untouched keeps the exchange one-off. It stands from launch
                through completion, so this party can manage the partnership. */}
            {decode.invitation.endpoint.channel === "webrtc" &&
              launched !== undefined &&
              failure === undefined && (
                <ManageExchangeOffer
                  status={manageStatus}
                  handleCaptured={sourceHandle !== undefined}
                  onManage={(choices) => void manageExchange(choices)}
                />
              )}
          </>
        )}
      </div>
    </BenchShell>
  );
}
