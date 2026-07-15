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
import { createManagedExchange } from "@psi/managedExchangeStore";
import { loadCSVFileOffMainThread } from "@psi/csvParseController";
import { prepareAcceptedInvitation } from "@psi/acceptInvitation";

import { deploymentProfile } from "@utils/clientConfig";
import { whenDiagnostic } from "@utils/diagnostics";

import { InvitationTerms } from "@components/InvitationTerms";
import { MAX_CSV_FILE_BYTES } from "@components/csvIntake";
import { setColumnTypeForMatching } from "@psi/metadataEditing";
import { useNonEmptyRates } from "@components/useNonEmptyRates";

import {
  ACCEPTOR_COLUMNS_LEDGER_FOOTER,
  ACCEPTOR_DONE_LEDGER_FOOTER,
  ACCEPTOR_LEDGER_FOOTER,
  acceptorConsentName,
  acceptorConsentReady,
  acceptorDoneLedgerRows,
  acceptorDoneLedgerTag,
  acceptorLedgerRows,
  acceptorLedgerTag,
  acceptorLegalAgreementDisplay,
  acceptorRailFacts,
  acceptorSpine,
  invitingPartyName,
} from "./acceptorModel";
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
import { FILE_ASSURANCE_LINE } from "./fileAssurance";
import { Ledger } from "./Ledger";
import { ManageExchangeOffer } from "./ManageExchangeOffer";
import { Problems } from "./Problems";
import { TopBar } from "./TopBar";
import { acceptorTimelineSteps } from "./exchangeRun";
import { restorablePosition } from "./stepRestore";
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
import type { AcceptorStep } from "./acceptorModel";
import type { AlertContent } from "@components/csvIntake";
import type { FieldStepOverride } from "@psi/standardizationAuthoring";
import type { FileRejection } from "@mantine/dropzone";
import type { IntakeAlert } from "./YourFileSection";
import type { ManageOfferChoices } from "./manageOfferModel";
import type { ManageOfferStatus } from "./ManageExchangeOffer";
import type { RailStep } from "./inviterModel";

/** Stable empty inputs for {@link useNonEmptyRates} before a file is acquired, so the
 * hook's controller is not rebuilt every render on a fresh `[]` identity. */
const EMPTY_ROWS: ReadonlyArray<CSVRow> = [];
const EMPTY_STANDARDIZATION: Standardization = [];

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
 * then parses it behind the consent gate and hands off to the (stubbed) confirm-
 * columns step.
 *
 * The consent semantics are re-surfaced from the hardened legacy flow, never
 * re-derived: {@link InvitationTerms} renders the full, never-condensed terms at
 * the review step, and {@link acceptorConsentName} (the shared `commitAcceptance`
 * gate) governs the consent step's submit BOTH as its disabled state and as a
 * re-check inside the handler, exactly as the legacy accept flow did.
 */
export function AcceptorBench() {
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
  const [columnsState, setColumnsState] = useState<AcceptorColumnsState>();
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
          "No invitation was found in this link. Paste the code on the " +
          "bench's home page instead.",
      });
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const invitation = await prepareAcceptedInvitation(encoded, {
          profile: deploymentProfile(),
        });
        if (!controller.signal.aborted)
          setDecode({ status: "ready", invitation });
      } catch (error) {
        if (!controller.signal.aborted)
          setDecode({ status: "error", message: describeDecodeError(error) });
      }
    })();
    return () => controller.abort();
  }, []);

  // On the review step, move focus to the terms heading once the decode resolves
  // to ready, or to the error alert once it resolves to error, so a screen-reader
  // user is taken to the revealed terms or the failure rather than left on the
  // spinner. The consent and columns steps own their own heading focus below.
  const termsHeadingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (step !== "review") return;
    if (decode.status === "ready") termsHeadingRef.current?.focus();
    else if (decode.status === "error") errorRef.current?.focus();
  }, [decode.status, step]);

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

  // The unload guard arms once the acceptor's file is chosen and disarms once
  // the exchange is launched (the run is dialing); leaving a launched exchange
  // costs nothing the acceptor has not already committed.
  useUnloadGuard({
    hasFile: file !== undefined,
    finalized: launched !== undefined,
  });

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

  // "Accept and continue": re-check the consent gate in the handler (not the
  // disabled state alone), surface the mockup's inline errors when a submit slips
  // past it, then parse the file behind the gate with the inviter bench's intake
  // checks. Only a clean parse advances to the confirm-columns step.
  async function acceptAndContinue() {
    if (decode.status !== "ready") return;
    const name = acceptorConsentName({ consented, name: acceptorName });
    const nextErrors: FieldErrors = {};
    if (name === undefined && acceptorName.trim() === "")
      nextErrors.name = "Your name is required";
    if (file === undefined) nextErrors.file = true;
    if (name === undefined || file === undefined) {
      setFieldErrors(nextErrors);
      return;
    }
    setFieldErrors({});
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
      ? acceptorColumnsEditorState(columnsState, linkageTerms, acquired.rawRows)
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
      acquired === undefined ||
      acceptedFile === undefined
    )
      return undefined;
    return {
      invitation: decode.invitation,
      acceptorName: committedName,
      rawRows: acquired.rawRows,
      columns: acquired.columns,
      edits: launched.edits,
      sourceFile: acceptedFile,
    };
    // `launched` is the launch key: it is set once, from the same render that
    // fixes the acquired CSV, its source file, the committed name, and the ready
    // decode, so keying the memo on it alone cannot go stale.
  }, [launched]);

  const { run, outputs, failure, tryAgain } = useAcceptorExchange({ launch });

  // Full-CSV coverage for the cleaning tab and the Customize menu's
  // Cleaning-attention value, one sweep shared by both. The hook must run
  // every render, so it takes empty inputs until a file is acquired.
  const { rates, pending: ratesPending } = useNonEmptyRates(
    acquired?.rawRows ?? EMPTY_ROWS,
    editorState?.standardization ?? EMPTY_STANDARDIZATION,
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
            )
          : // From the confirm-columns step onward the live metadata governs what
            // leaves this browser, so the send row names exactly that; before a
            // file exists (`editorState` undefined) the row forward-references the
            // confirm-columns step.
            acceptorLedgerRows(token, editorState?.metadata)
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
            ? ACCEPTOR_DONE_LEDGER_FOOTER
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
  // spec this run used. The secret is the invitation's; the one-shot run discards
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
            <div className={styles.workFoot}>
              <Button onClick={() => goToStep("consent")}>
                Continue: consent &amp; your file
              </Button>
            </div>
          </>
        )}
        {decode.status === "ready" && step === "consent" && (
          <>
            <p className={styles.eyebrow}>Step 2 of 3</p>
            <h1 tabIndex={-1}>Consent &amp; your file</h1>
            <p className={`${styles.small} ${styles.sub}`}>
              This invitation should have reached you over a trusted channel.
              Your browser connects directly to your partner.
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
              description="Recorded in your exchange record so your partner can identify you"
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
            <Dropzone
              className={styles.dropzone}
              openRef={openFilePicker}
              onDrop={(files) => {
                const chosen = files.at(0);
                if (chosen !== undefined) selectFile(chosen);
              }}
              onReject={handleReject}
              accept={["text/plain", "text/csv", "application/vnd.ms-excel"]}
              maxSize={MAX_CSV_FILE_BYTES}
              multiple={false}
              loading={parsing}
              aria-label="Your data file"
              mt="md"
            >
              <p>
                <strong>Drag files here or click to select</strong>
              </p>
              <p className={styles.dropzoneMax}>(Max file size: {maxMb} MB)</p>
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
            {FILE_ASSURANCE_LINE !== undefined && (
              <p className={`${styles.small} ${styles.sub}`}>
                {FILE_ASSURANCE_LINE}
              </p>
            )}
            {fieldErrors.file === true && (
              <Alert
                color="red"
                title="Choose a data file"
                icon={<IconAlertCircle aria-hidden />}
                mt="md"
              >
                A file is needed before the exchange can be set up. Drag one
                into the dropzone or click it to select.
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
              rawRows={acquired.rawRows}
              rates={rates}
              ratesPending={ratesPending}
              deadKeyCount={verdict.deadKeyCount}
              cleaningResetKey={cleaningResetKey}
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
              onTryAgain={tryAgain}
              onFixColumns={backToColumns}
            />
            {/* The manage offer is webrtc-only (its record composes a webrtc
                locator from the invitation's endpoint) and is skippable: leaving
                it untouched keeps the exchange one-time. It stands from launch
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
