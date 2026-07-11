import { useEffect, useRef, useState } from "react";

import { Alert, Button, Text, TextInput } from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import { IconAlertCircle } from "@tabler/icons-react";
import log from "loglevel";

import { MAX_CSV_FILE_BYTES } from "@components/csvIntake";

import { FILE_ASSURANCE_LINE } from "./fileAssurance";
import { fileCardMeta } from "./inviterModel";
import styles from "./bench.module.css";

import type { AcquiredCsv } from "./inviterModel";
import type { FileRejection } from "@mantine/dropzone";

/** A titled alert for a failed or unusable read, focused when it appears so
 * the failure is announced without clearing the operator's input. */
export interface IntakeAlert {
  title: string;
  message: string;
}

/**
 * Step 1 of the inviter spine: the inviter's name and file. Presentational --
 * the host owns the parse and the draft; this section renders the intake
 * surface (dropzone always available, file card once read, recommended-terms
 * callout when the file can back an exchange) and gates Continue on a name
 * and a linkable file.
 */
export function YourFileSection({
  name,
  onNameChange,
  onFile,
  reading,
  acquired,
  linkable,
  alert,
  onContinue,
}: {
  name: string;
  onNameChange: (name: string) => void;
  /** The dropped or selected file; the host parses it. */
  onFile: (file: File) => void;
  reading: boolean;
  acquired: AcquiredCsv | undefined;
  /** Whether the read file can back at least one matching key. */
  linkable: boolean;
  alert: IntakeAlert | undefined;
  onContinue: () => void;
}) {
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (alert !== undefined) alertRef.current?.focus();
  }, [alert]);

  // The dropzone enforces the size cap and type list itself but only flashes a
  // reject icon; surface why, or a refused drop is a silent no-op. Codes only
  // in the log -- a rejected file's NAME can itself be sensitive here.
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

  const ready =
    name.trim().length > 0 && acquired !== undefined && linkable && !reading;
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
      <Dropzone
        className={styles.dropzone}
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
              {fileCardMeta(acquired.rawRows.length, acquired.sizeBytes)}
            </div>
          </div>
        </div>
      )}
      {FILE_ASSURANCE_LINE !== undefined && (
        <p className={`${styles.small} ${styles.sub}`}>{FILE_ASSURANCE_LINE}</p>
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
      {acquired !== undefined && linkable && (
        <div className={styles.callout}>
          <p className={styles.calloutLead}>
            Recommended terms are ready. Most exchanges need nothing more.
          </p>
          <p className={styles.small}>
            Cleaning, matching keys, and the option of a legal agreement were
            set from your file&apos;s columns. Customize any of them any time
            before you create the invitation.
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
            : "A name and a file are needed to proceed."}
        </p>
      </div>
    </>
  );
}
