import { Fragment, useEffect, useRef, useState } from "react";

import { Alert, VisuallyHidden } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";

import {
  mintExchangeFile,
  sanitizeErrorForDisplay,
  sanitizeForDisplay,
} from "@psilink/core";

import { InvitationFileError, generateInvitation } from "@psi/invitation";
import { emptyColumnPositions, unnameableColumnsAlert } from "@psi/columnNames";
import { invitationLocation } from "@psi/invitationLocation";
import { loadCSVFileOffMainThread } from "@psi/csvParseController";

import { deploymentProfile } from "@utils/clientConfig";
import { whenDiagnostic } from "@utils/diagnostics";

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
import { Rail, RailFacts, RailGroup, RailProblems, RailSteps } from "./Rail";
import {
  editorFromCsv,
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
  inviterLedgerRows,
  inviterRailFacts,
  isCliTransport,
  resetToRecommended,
  reviewValidation,
  sealEditor,
  spineProblems,
  unsealEditor,
} from "./inviterModel";
import { AgreementTab } from "./AgreementTab";
import { BenchShell } from "./BenchShell";
import { CleaningTab } from "./CleaningTab";
import { InviterExchangeSection } from "./InviterExchangeSection";
import { KeysTab } from "./KeysTab";
import { Ledger } from "./Ledger";
import { MatchingSharingSection } from "./MatchingSharingSection";
import { ReviewCreateSection } from "./ReviewCreateSection";
import { SaveExchangeSection } from "./SaveExchangeSection";
import { YourFileSection } from "./YourFileSection";
import { selectExchangeDriver } from "./exchangeDriverSelection";
import { timelineSteps } from "./exchangeRun";
import { useInviterExchange } from "./useInviterExchange";

import type { AcquiredCsv, InviterEditor, SpineTarget } from "./inviterModel";
import type { CliTransport, SaveExchangeFields } from "./saveExchangeModel";
import type { DisclosureChoice } from "@psi/metadataEditing";
import type { GeneratedInvitation } from "@psi/invitation";
import type { IntakeAlert } from "./YourFileSection";
import type { RailStep } from "./Rail";
import type { SavedExchange } from "./SaveExchangeSection";
import type { SemanticType } from "@psilink/core";

type Section = SpineTarget | "share" | "save";
type SpineStep = "file" | "columns" | "review";

const SPINE_LABELS: Record<SpineStep, string> = {
  file: "Your file",
  columns: "Matching & sharing",
  review: "Review & create",
};

const SPINE_ORDER: ReadonlyArray<SpineStep> = ["file", "columns", "review"];

function isSpineStep(section: Section): section is SpineStep {
  return (SPINE_ORDER as ReadonlyArray<Section>).includes(section);
}

function demotionNotice(demoted: ReadonlyArray<string>): string {
  if (demoted.length === 0) return "";
  return `${demoted.join(", ")} changed to Ignored - only one column can be the row identifier.`;
}

// Deferred well past the click so a browser copying the blob asynchronously is
// not cut off; matches TermsImportExport's download discipline.
const DOWNLOAD_REVOKE_DELAY_MS = 40_000;

/** Trigger a client-side download of `content` as `fileName`. The exchange file
 * never leaves the browser; this writes it to the operator's disk the same way
 * the CSV is read in (locally). */
function triggerDownload(fileName: string, content: string): void {
  const blob = new Blob([content], { type: "application/yaml" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_REVOKE_DELAY_MS);
  }
}

/**
 * The inviter's working surface: one bench whose rail walks the three-step
 * required spine while the work column swaps sections in place. The draft
 * seeds from the file the moment it is read (step 1) and every step-2 edit
 * flows through the shared draft model, so the rail facts and the disclosure
 * ledger track live. Step 3 is not built yet and says so.
 */
export function InviterBench() {
  const [name, setName] = useState("");
  const [section, setSection] = useState<Section>("file");
  const [lastSpineStep, setLastSpineStep] = useState<SpineStep>("file");
  const [acquired, setAcquired] = useState<AcquiredCsv>();
  const [sourceFile, setSourceFile] = useState<File>();
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

  const transport = editor?.transport ?? "browser";
  const selection = selectExchangeDriver(transport, deploymentProfile());

  // The live run starts the moment a live invitation exists (the hook drives
  // the partner exchange right away) and is torn down when the invitation is
  // discarded or the bench unmounts. A `save-file` selection never runs live:
  // its invitation is minted for the save surface, so it is withheld from the
  // hook and `invitation` alone (not the withheld value) proves nothing dials
  // for a saved exchange. A `server-job` selection runs live too -- the console
  // appliance carries it out -- so it drives the hook exactly as `browser` does.
  const runsLive = selection.kind !== "save-file";
  const { run, outputs, failure, tryAgain } = useInviterExchange({
    invitation: runsLive ? invitation : undefined,
    inviterName: editor?.draft.identity ?? "",
    channel: transport,
    sourceFile,
  });

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
    goTo("review");
  }

  function goTo(next: Section) {
    if (isSpineStep(next)) setLastSpineStep(next);
    setSection(next);
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
    setSourceFile(undefined);
    setEditor(undefined);
    setIntakeAlert(alert);
  }

  async function readFile(file: File) {
    const id = ++parseId.current;
    parseAbort.current?.abort();
    const controller = new AbortController();
    parseAbort.current = controller;
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
      };
      const seeded = editorFromCsv(name, csv);
      setAcquired(csv);
      setSourceFile(file);
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

  // Minting re-parses the retained source file through generateInvitation --
  // the same fail-closed parse boundary the current app mints at -- so the
  // embedded terms, the returned rows, and the satisfiability re-check all
  // bind to one read of the file.
  async function createInvitation() {
    if (editor === undefined || sourceFile === undefined) return;
    // The Create button is disabled on any open problem; this repeats the gate
    // because spineProblems covers the identifier conflict, which
    // canGenerate alone does not.
    if (spineProblems(editor).length > 0) return;
    const validation = reviewValidation(editor);
    if (!validation.canGenerate || validation.terms === undefined) return;
    // A save-file selection seals the terms exactly as the live path does but
    // mints NOTHING here: the code and the config YAML are minted together on
    // the save surface, from the authored locator. Seal, discard any prior
    // saved artifacts, and route to save. A server-job selection (filedrop on
    // the console appliance) instead mints here and routes to the live run,
    // exactly as the browser path does.
    if (selection.kind === "save-file") {
      setEditor(sealEditor(editor));
      setSavedExchange(undefined);
      setSaveAlert(undefined);
      goTo("save");
      return;
    }
    setMinting(true);
    setCreateAlert(undefined);
    try {
      const minted = await generateInvitation({
        inviterName: editor.draft.identity,
        file: sourceFile,
        location: invitationLocation(),
        lifetimeSeconds: editor.draft.lifetimeSeconds,
        linkageTerms: validation.terms,
        metadata: editor.draft.metadata,
        standardization: editor.draft.standardization,
      });
      setEditor(sealEditor(editor));
      setInvitation(minted);
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
    if (editor === undefined || sourceFile === undefined) return;
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
        file: sourceFile,
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
      triggerDownload(fileName, yaml);
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

  const facts = inviterRailFacts(editor).map((fact) => ({
    ...fact,
    onSelect: editor !== undefined ? () => goTo(fact.target) : undefined,
    current: section === fact.target,
  }));

  const problems = sealed
    ? []
    : spineProblems(editor).map((problem) => ({
        label: problem.message,
        onSelect: () => goTo(problem.target),
      }));

  return (
    <BenchShell
      rail={
        section === "share" ? (
          <Rail label="Exchange progress">
            <RailGroup label="This exchange" note="Browser">
              <RailSteps steps={steps} />
            </RailGroup>
          </Rail>
        ) : section === "save" && isCliTransport(transport) ? (
          <Rail label="Exchange progress">
            <RailGroup label="This exchange" note={saveRailNote(transport)}>
              <RailSteps steps={saveSteps} />
            </RailGroup>
          </Rail>
        ) : (
          <Rail label="Exchange setup">
            <RailGroup label="Set up">
              <RailSteps steps={steps} />
            </RailGroup>
            <RailGroup label="Customize" note="Filled in from your file.">
              <RailFacts facts={facts} />
            </RailGroup>
            <RailProblems problems={problems} />
          </Rail>
        )
      }
      ledger={
        <Ledger
          tag={sealed ? "Terms sealed at create" : undefined}
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
              ? saveTrustFooter(transport)
              : liveRunLedgerFooter(
                  selection.kind === "server-job",
                  outputs !== undefined,
                )
          }
        />
      }
    >
      <div ref={headingRef}>
        {section === "file" && (
          <YourFileSection
            name={name}
            onNameChange={updateName}
            onFile={(file) => void readFile(file)}
            reading={reading}
            acquired={acquired}
            linkable={linkable}
            alert={intakeAlert}
            onContinue={() => {
              if (fileReady) goTo("columns");
            }}
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
                problems={spineProblems(editor)}
                minting={minting}
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
                  setEditorAnnouncement("Reset to the recommended settings.");
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
              csv={acquired}
              expertMode={expertMode}
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
                setEditorAnnouncement(
                  "Cleaning reset to the recommended steps.",
                );
              }}
              cleaningError={reviewValidation(editor).errors.standardization}
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
          <InviterExchangeSection
            invitation={invitation}
            run={run}
            outputs={outputs}
            failure={failure}
            onTryAgain={tryAgain}
            onStartOver={startOver}
          />
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
