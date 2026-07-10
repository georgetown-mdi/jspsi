import { Fragment, useEffect, useRef, useState } from "react";

import { Alert, Anchor, VisuallyHidden } from "@mantine/core";
import { Link } from "@tanstack/react-router";

import { sanitizeErrorForDisplay, sanitizeForDisplay } from "@psilink/core";

import { InvitationFileError, generateInvitation } from "@psi/invitation";
import { emptyColumnPositions, unnameableColumnsAlert } from "@psi/columnNames";
import { invitationLocation } from "@psi/invitationLocation";
import { loadCSVFileOffMainThread } from "@psi/csvParseController";

import { whenDiagnostic } from "@utils/diagnostics";

import { unlinkableFileAlert } from "@components/UnlinkableFileAlert";

import { Rail, RailFacts, RailGroup, RailProblems, RailSteps } from "./Rail";
import {
  editorFromCsv,
  editorWithAuthoredDraft,
  editorWithColumnDisclosure,
  editorWithColumnType,
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
  inviterLedgerRows,
  inviterRailFacts,
  resetToRecommended,
  reviewValidation,
  sealEditor,
  spineProblems,
} from "./inviterModel";
import { AgreementTab } from "./AgreementTab";
import { BenchShell } from "./BenchShell";
import { CleaningTab } from "./CleaningTab";
import { KeysTab } from "./KeysTab";
import { Ledger } from "./Ledger";
import { MatchingSharingSection } from "./MatchingSharingSection";
import { ReviewCreateSection } from "./ReviewCreateSection";
import { YourFileSection } from "./YourFileSection";

import type { AcquiredCsv, InviterEditor, SpineTarget } from "./inviterModel";
import type { DisclosureChoice } from "@psi/metadataEditing";
import type { GeneratedInvitation } from "@psi/invitation";
import type { IntakeAlert } from "./YourFileSection";
import type { RailStep } from "./Rail";
import type { SemanticType } from "@psilink/core";

type Section = SpineTarget | "share";
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

  function goTo(next: Section) {
    if (isSpineStep(next)) setLastSpineStep(next);
    setSection(next);
  }

  // A parse may still be in flight when the surface unmounts or a newer file
  // is dropped; the id lets the stale resolution fall on the floor instead of
  // clobbering current state (the FileAcquire pattern).
  const parseId = useRef(0);
  useEffect(
    () => () => {
      parseId.current += 1;
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

  async function readFile(file: File) {
    const id = ++parseId.current;
    setReading(true);
    setIntakeAlert(undefined);
    try {
      const result = await loadCSVFileOffMainThread(file);
      if (id !== parseId.current) return;
      const columns = result.meta.fields ?? [];
      const emptyPositions = emptyColumnPositions(columns);
      if (emptyPositions.length > 0) {
        setIntakeAlert(unnameableColumnsAlert(emptyPositions));
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
      if (seeded.draft.keys.length === 0)
        setIntakeAlert({
          title: "This file cannot be matched",
          message:
            "None of the matching keys can be built from this file's columns. Matching needs columns like name, date of birth, Social Security number, ZIP code, phone, or email.",
        });
    } catch (error) {
      if (id !== parseId.current) return;
      setIntakeAlert({
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
    const validation = reviewValidation(editor);
    if (!validation.canGenerate || validation.terms === undefined) return;
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
        // diagnostic mode -- the InvitePanel rule, applied literally.
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

  const linkable = editor !== undefined && editor.draft.keys.length > 0;
  const fileReady = name.trim().length > 0 && linkable;
  const sealed = editor?.sealed === true;

  // Inside a Customize tab no spine step is current; the step the operator
  // came from stays navigable like any completed step.
  const inTab = !isSpineStep(section) && section !== "share";
  const currentPosition = SPINE_ORDER.indexOf(
    isSpineStep(section) ? section : lastSpineStep,
  );
  const steps: Array<RailStep> =
    section === "share"
      ? [
          { label: "Share", state: "current" },
          { label: "Partner accepts", state: "pending" },
          { label: "Exchange runs", state: "pending" },
          { label: "Results", state: "pending" },
        ]
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
          rows={inviterLedgerRows(editor, invitation?.expires).map((row) => ({
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
          footer="Your file stays in this browser. Nothing is uploaded; your partner receives only what this ledger names."
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
                  setEditor(editorWithLifetime(editor, seconds))
                }
                onDirection={(direction) =>
                  setEditor(editorWithOutputDirection(editor, direction))
                }
                onReset={() => setEditor(resetToRecommended(editor, acquired))}
                onCreate={() => void createInvitation()}
                onNavigate={goTo}
              />
              {createAlert !== undefined && (
                <Alert color="red" title={createAlert.title} mt="md">
                  {createAlert.message}
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
                setEditor(editorWithFieldSteps(editor, output, fieldSteps))
              }
              onFieldInput={(output, input) =>
                setEditor(editorWithFieldInput(editor, output, input))
              }
              onFieldAdded={(type) =>
                setEditor(editorWithFieldAdded(editor, type))
              }
              onFieldRemoved={(output) =>
                setEditor(editorWithFieldRemoved(editor, output))
              }
              onResetCleaning={() =>
                setEditor(editorWithRecommendedCleaning(editor, acquired))
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
                setEditor(editorWithKeyEnabled(editor, index, enabled))
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
                setEditor(editorWithAuthoredDraft(editor, draft))
              }
              onStrategy={(strategy) =>
                setEditor(editorWithLinkageStrategy(editor, strategy))
              }
              onImport={(terms) => {
                setEditor(editorWithImportedTerms(editor, acquired, terms));
                setEditorAnnouncement(
                  "Imported. Review the loaded terms before creating.",
                );
              }}
              announce={setEditorAnnouncement}
              onBack={() => goTo("review")}
            />
          )}
        {section === "agreement" && editor !== undefined && (
          <AgreementTab
            editor={editor}
            validation={reviewValidation(editor)}
            onAgreement={(agreement) =>
              setEditor(editorWithLegalAgreement(editor, agreement))
            }
            onBack={() => goTo("review")}
          />
        )}
        {section === "share" && (
          <>
            <h1 tabIndex={-1}>Your invitation is ready</h1>
            <p>
              The terms are sealed: the invitation your partner consents to is
              exactly the proposal you just reviewed.
            </p>
            <Alert color="yellow" title="Under construction" mt="md">
              The share screen - the invitation link and code with their copy
              actions - arrives with the next bench screens. Nothing has been
              shared: the invitation exists only in this browser and expires on
              its own. To run an exchange today, use the{" "}
              <Anchor component={Link} to="/">
                current app
              </Anchor>
              .
            </Alert>
          </>
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
