import { useEffect, useRef } from "react";

import { Alert, Button, TextInput } from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";

import { MAX_CSV_FILE_BYTES } from "@components/csvIntake";

import { fileCardMeta } from "./inviterModel";
import styles from "./bench.module.css";

import type { AcquiredCsv } from "./inviterModel";

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

  const ready = name.trim().length > 0 && acquired !== undefined && linkable;
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
          const file = files.at(0);
          if (file !== undefined) onFile(file);
        }}
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
        <p className={styles.dropzoneMax}>
          (Max file size: {MAX_CSV_FILE_BYTES / 1024 ** 2} MB)
        </p>
      </Dropzone>
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
      <p className={`${styles.small} ${styles.sub}`}>
        Your file is processed entirely in your browser and it is never uploaded
        to our server.
      </p>
      {alert !== undefined && (
        <Alert
          color="red"
          title={alert.title}
          mt="md"
          ref={alertRef}
          tabIndex={-1}
        >
          {alert.message}
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
