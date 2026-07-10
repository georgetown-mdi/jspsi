import { Fragment, useEffect, useRef, useState } from "react";

import { Alert, Anchor } from "@mantine/core";
import { Link } from "@tanstack/react-router";

import { sanitizeErrorForDisplay } from "@psilink/core";

import { emptyColumnPositions, unnameableColumnsAlert } from "@psi/columnNames";
import { loadCSVFileOffMainThread } from "@psi/csvParseController";

import { Rail, RailFacts, RailGroup, RailProblems, RailSteps } from "./Rail";
import {
  editorFromCsv,
  editorWithColumnDisclosure,
  editorWithColumnType,
  editorWithIdentity,
  identifierProblem,
  inviterLedgerRows,
  inviterRailFacts,
} from "./inviterModel";
import { BenchShell } from "./BenchShell";
import { Ledger } from "./Ledger";
import { MatchingSharingSection } from "./MatchingSharingSection";
import { YourFileSection } from "./YourFileSection";
import styles from "./bench.module.css";

import type { AcquiredCsv, InviterEditor } from "./inviterModel";
import type { DisclosureChoice } from "@psi/metadataEditing";
import type { IntakeAlert } from "./YourFileSection";
import type { RailStep } from "./Rail";
import type { SemanticType } from "@psilink/core";

type SpineSection = "file" | "columns" | "review";

const SPINE_LABELS: Record<SpineSection, string> = {
  file: "Your file",
  columns: "Matching & sharing",
  review: "Review & create",
};

const SPINE_ORDER: ReadonlyArray<SpineSection> = ["file", "columns", "review"];

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
  const [section, setSection] = useState<SpineSection>("file");
  const [acquired, setAcquired] = useState<AcquiredCsv>();
  const [editor, setEditor] = useState<InviterEditor>();
  const [intakeAlert, setIntakeAlert] = useState<IntakeAlert>();
  const [reading, setReading] = useState(false);
  const [announcement, setAnnouncement] = useState("");

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

  const linkable = editor !== undefined && editor.draft.keys.length > 0;
  const fileReady = name.trim().length > 0 && linkable;

  const currentPosition = SPINE_ORDER.indexOf(section);
  const steps: Array<RailStep> = SPINE_ORDER.map((step, position) => {
    const state =
      step === section
        ? "current"
        : position < currentPosition
          ? "done"
          : "pending";
    return {
      label: SPINE_LABELS[step],
      state,
      onSelect: state === "done" ? () => setSection(step) : undefined,
    };
  });

  const problems =
    editor !== undefined && identifierProblem(editor.draft)
      ? [
          {
            label: "Choose a single row identifier",
            onSelect: () => setSection("columns"),
          },
        ]
      : [];

  return (
    <BenchShell
      rail={
        <Rail label="Exchange setup">
          <RailGroup label="Set up">
            <RailSteps steps={steps} />
          </RailGroup>
          <RailGroup label="Customize" note="Filled in from your file.">
            <RailFacts facts={inviterRailFacts(editor)} />
          </RailGroup>
          <RailProblems problems={problems} />
        </Rail>
      }
      ledger={
        <Ledger
          rows={inviterLedgerRows(editor).map((row) => ({
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
              if (fileReady) setSection("columns");
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
              onContinue={() => setSection("review")}
            />
          )}
        {section === "review" && (
          <>
            <p className={styles.eyebrow}>Step 3 of 3</p>
            <h1 tabIndex={-1}>Review &amp; create</h1>
            <Alert color="yellow" title="Under construction" mt="md">
              This step is not built yet: the check-your-answers review, the
              transport choice, and the create action arrive with the next bench
              screens. To run an exchange today, use the{" "}
              <Anchor component={Link} to="/">
                current app
              </Anchor>
              .
            </Alert>
          </>
        )}
      </div>
    </BenchShell>
  );
}
