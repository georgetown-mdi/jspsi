import { useEffect, useRef, useState } from "react";

import { Alert, Anchor, Button, Text, TextInput } from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import { IconAlertCircle } from "@tabler/icons-react";
import { getLogger } from "@alcove/core";

import {
  CSV_DELIMITER_LOCAL_NOTICE,
  CsvDelimiterField,
} from "@components/CsvDelimiterField";
import { MAX_CSV_FILE_BYTES } from "@components/csvIntake";
import { resolveCsvDelimiter } from "@components/csvDelimiterChoice";

import { isConsoleBuild } from "@utils/clientConfig";

import { fileCardMeta } from "@psi/formatting";

import { ServerFilePicker } from "@console/ServerFilePicker";
import styles from "@styles/app.module.css";

import { APPLIANCE_FILE_ASSURANCE, FILE_ASSURANCE_LINE } from "./fileAssurance";

import type {
  ProfiledJobInput,
  WorkInputReference,
} from "@psi/jobClient/workInputClient";
import type { AcquiredCsv } from "@psi/inviterEditor";
import type { AlertContent } from "@components/csvIntake";
import type { CsvDelimiterChoice } from "@components/csvDelimiterChoice";
import type { FileRejection } from "@mantine/dropzone";

const log = getLogger("YourFileSection");

/**
 * Step 1 of the inviter spine: the inviter's name and file. Presentational --
 * the host owns the parse and the draft; this section renders the intake
 * surface and gates Continue on a name and a linkable file.
 *
 * The intake surface is deployment-specific. The hosted build reads the file in
 * the browser through a dropzone (file card once read, recommended-terms callout
 * when the file can back an exchange). The console never reads the file in the
 * browser: it renders {@link ServerFilePicker} over the operator-mounted
 * work-input directory, and the file-assurance line and sample-data copy say so.
 *
 * Both surfaces offer the delimiter control: the hosted build reads the dropped
 * file by it, and the console hands it to the picker, which profiles the mounted
 * file by it and passes it to the run the console composes. Changing it voids a
 * file already committed on the console, so Continue is withheld until the
 * operator confirms the file the new choice reads.
 */
export function YourFileSection({
  name,
  onNameChange,
  onFile,
  delimiter,
  onDelimiterChange,
  reading,
  acquired,
  linkable,
  alert,
  notice,
  committed,
  onCommit,
  onInvalidate,
  onContinue,
  onLoadSample,
  onDownloadSamples,
}: {
  name: string;
  onNameChange: (name: string) => void;
  /** The dropped or selected file; the host parses it. Hosted build only. */
  onFile: (file: File) => void;
  /** How this party's file separates its fields: the delimiter the hosted build
   * reads the dropped file by, and the one the console profiles and runs its
   * mounted file by. */
  delimiter: CsvDelimiterChoice;
  onDelimiterChange: (choice: CsvDelimiterChoice) => void;
  reading: boolean;
  acquired: AcquiredCsv | undefined;
  /** Whether the read file can back at least one matching key. */
  linkable: boolean;
  alert: AlertContent | undefined;
  /** An advisory about the read file the operator should see but need not act on
   * before continuing -- the boundary's column-name sanitation. Rendered beside
   * {@link alert}, which is the refusal slot. */
  notice: AlertContent | undefined;
  /** The file committed to the host on the console (its profiled reference), so the
   * picker marks its row; unused off the console. */
  committed?: WorkInputReference;
  /** Commit a profiled console file to the host (the picker's "Use this file");
   * unused off the console. */
  onCommit?: (profile: ProfiledJobInput) => void;
  /** Drop the committed console file and the terms derived from it: the delimiter
   * moved, so its columns are not the ones the run reads. Unused off the console. */
  onInvalidate?: () => void;
  onContinue: () => void;
  /** Seed the synthetic sample into this exchange in place. Hosted build only -- the
   * console cannot read an in-browser file, so its sample path is download-only. */
  onLoadSample: () => void;
  /** Download the two sample CSVs client-side, uploading nothing. */
  onDownloadSamples: () => void;
}) {
  const consoleBuild = isConsoleBuild();
  const assuranceLine = consoleBuild
    ? APPLIANCE_FILE_ASSURANCE
    : FILE_ASSURANCE_LINE;
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (alert !== undefined) alertRef.current?.focus();
  }, [alert]);

  // The dropzone enforces the size cap and type list itself but only flashes a
  // reject icon; say why, or a refused drop is a silent no-op. Codes only in the
  // log -- a rejected file's NAME can itself be sensitive here.
  const [rejectionMessage, setRejectionMessage] = useState<string>();
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

  // A delimiter the rule refuses reads nothing: the intake closes and Continue
  // is withheld, rather than a file being read by a delimiter nobody chose.
  const delimiterResolution = resolveCsvDelimiter(delimiter);
  const delimiterUsable = delimiterResolution.ok;
  const ready =
    name.trim().length > 0 &&
    acquired !== undefined &&
    linkable &&
    delimiterUsable &&
    !reading;
  return (
    <>
      <p className={styles.eyebrow}>Step 1 of 3</p>
      <h1 tabIndex={-1}>Your file</h1>
      <TextInput
        label="Your name"
        description="Recorded in the invitation's linkage terms so your partner can identify you"
        value={name}
        maxLength={200}
        onChange={(event) => onNameChange(event.currentTarget.value)}
      />
      {consoleBuild ? (
        <>
          <CsvDelimiterField
            choice={delimiter}
            onChange={onDelimiterChange}
            note={CSV_DELIMITER_LOCAL_NOTICE}
          />
          <ServerFilePicker
            committed={committed}
            delimiter={delimiterResolution}
            onUse={(profile) => onCommit?.(profile)}
            onInvalidate={() => onInvalidate?.()}
          />
          {acquired === undefined && (
            <p className={`${styles.small} ${styles.sub}`}>
              Use sample data:{" "}
              <Anchor
                inherit
                component="button"
                type="button"
                onClick={onDownloadSamples}
              >
                download the CSVs
              </Anchor>
              , then place one in this console&apos;s mounted work directory --
              see the{" "}
              <Anchor
                inherit
                href="https://github.com/georgetown-mdi/alcove/blob/main/docs/DEPLOYMENT.md"
                target="_blank"
                rel="noreferrer"
              >
                deployment guide
              </Anchor>
              .
            </p>
          )}
        </>
      ) : (
        <>
          <CsvDelimiterField
            choice={delimiter}
            onChange={onDelimiterChange}
            disabled={reading}
            note={CSV_DELIMITER_LOCAL_NOTICE}
          />
          <Dropzone
            className={styles.dropzone}
            disabled={!delimiterUsable}
            onDrop={(files) => {
              setRejectionMessage(undefined);
              const file = files.at(0);
              if (file !== undefined) onFile(file);
            }}
            onReject={handleReject}
            accept={["text/plain", "text/csv", "application/vnd.ms-excel"]}
            maxSize={MAX_CSV_FILE_BYTES}
            multiple={false}
            loading={reading}
            aria-label="Your data file"
            mt="md"
          >
            <p>
              <strong>Drag your CSV here or click to select</strong>
            </p>
            <p className={styles.dropzoneMax}>(Max file size: {maxMb} MB)</p>
          </Dropzone>
          {rejectionMessage !== undefined && (
            <Text role="alert" c="red" size="sm" mt="xs">
              {rejectionMessage}
            </Text>
          )}
          {acquired === undefined && (
            <p className={`${styles.small} ${styles.sub}`}>
              Use sample data:{" "}
              <Anchor
                inherit
                component="button"
                type="button"
                onClick={onLoadSample}
              >
                load it into this exchange
              </Anchor>
              , or{" "}
              <Anchor
                inherit
                component="button"
                type="button"
                onClick={onDownloadSamples}
              >
                download the CSVs
              </Anchor>
              .
            </p>
          )}
          {acquired !== undefined && (
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
                  {acquired.fileName}
                </div>
                <div className={`${styles.fileMeta} ${styles.mono}`}>
                  {fileCardMeta(acquired.rowCount, acquired.sizeBytes)}
                </div>
              </div>
            </div>
          )}
        </>
      )}
      {assuranceLine !== undefined && (
        <p className={`${styles.small} ${styles.sub}`}>{assuranceLine}</p>
      )}
      {alert !== undefined && (
        <Alert
          color="red"
          title={alert.title}
          icon={<IconAlertCircle />}
          mt="md"
          ref={alertRef}
          tabIndex={-1}
        >
          {/* sanitizeErrorForDisplay separates a cause chain with newlines;
              pre-line preserves them (its documented rendering contract). */}
          <span style={{ whiteSpace: "pre-line" }}>{alert.message}</span>
        </Alert>
      )}
      {notice !== undefined && (
        <Alert
          color="yellow"
          title={notice.title}
          icon={<IconAlertCircle />}
          mt="md"
        >
          <span style={{ whiteSpace: "pre-line" }}>{notice.message}</span>
        </Alert>
      )}
      {acquired !== undefined && linkable && (
        <div className={styles.callout}>
          <p className={styles.calloutLead}>Using defaults</p>
          <p className={styles.small}>
            Customize data cleaning steps, matching keys, or attach an
            associated agreement before you create the invitation (bottom of
            right toolbar).
          </p>
        </div>
      )}
      <div className={styles.workFoot}>
        <Button disabled={!ready} onClick={onContinue}>
          Continue to matching &amp; sharing
        </Button>
        <p
          className={
            ready
              ? `${styles.statusLine} ${styles.statusLineOk}`
              : styles.statusLine
          }
        >
          {ready
            ? "Ready to continue."
            : !delimiterUsable
              ? "Enter a field separator your file uses to proceed."
              : "A name and a file are needed to proceed."}
        </p>
      </div>
    </>
  );
}
