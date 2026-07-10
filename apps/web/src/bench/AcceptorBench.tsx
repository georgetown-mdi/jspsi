import { Fragment, useEffect, useRef, useState } from "react";

import { Alert, Button, Checkbox, Text, TextInput } from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import { IconAlertCircle } from "@tabler/icons-react";
import log from "loglevel";

import { describeDecodeError, sanitizeErrorForDisplay } from "@psilink/core";

import { emptyColumnPositions, unnameableColumnsAlert } from "@psi/columnNames";
import { loadCSVFileOffMainThread } from "@psi/csvParseController";
import { prepareAcceptedInvitation } from "@psi/acceptInvitation";

import { InvitationTerms } from "@components/InvitationTerms";
import { MAX_CSV_FILE_BYTES } from "@components/csvIntake";

import {
  ACCEPTOR_LEDGER_FOOTER,
  acceptorConsentName,
  acceptorConsentReady,
  acceptorLedgerRows,
  acceptorLedgerTag,
  acceptorRailFacts,
  acceptorSpine,
  invitingPartyName,
} from "./acceptorModel";
import { Rail, RailFacts, RailGroup, RailSteps } from "./Rail";
import { BenchShell } from "./BenchShell";
import { Ledger } from "./Ledger";
import styles from "./bench.module.css";

import type { AcceptableInvitation } from "@psi/acceptInvitation";
import type { AcceptorStep } from "./acceptorModel";
import type { FileRejection } from "@mantine/dropzone";
import type { IntakeAlert } from "./YourFileSection";
import type { RailStep } from "./Rail";

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
 * re-check inside the handler, exactly as the legacy AcceptInvitationPanel and
 * AcceptInvitation.handleAcquired do.
 */
export function AcceptorBench() {
  const [decode, setDecode] = useState<DecodeState>({ status: "pending" });
  const [step, setStep] = useState<AcceptorStep>("review");
  // The consent gate's two inputs; the file is held as an unparsed handle until
  // "Accept and continue" fires and passes the gate.
  const [consented, setConsented] = useState(false);
  const [acceptorName, setAcceptorName] = useState("");
  const [file, setFile] = useState<File>();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [rejectionMessage, setRejectionMessage] = useState<string>();
  const [parseAlert, setParseAlert] = useState<IntakeAlert>();
  const [parsing, setParsing] = useState(false);

  // Decode the fragment token once, failing closed: an empty fragment, a bad
  // checksum/schema, an expired token, or a non-WebRTC endpoint each throws in
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
        const invitation = await prepareAcceptedInvitation(encoded);
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

  // Moving between the consent and columns steps replaces the work column, so
  // focus is sent to the incoming h1 (they carry tabIndex -1) or a screen-reader
  // user is left on a control that no longer exists. Skipped on mount and on the
  // review step, whose focus the decode effect above owns.
  const stepHeadingRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current && step !== "review")
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
      setStep("columns");
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

  const spineSteps: Array<RailStep> = acceptorSpine(step).map((entry) => ({
    label: entry.label,
    state: entry.state,
    onSelect: entry.navigable ? () => setStep(entry.step) : undefined,
  }));

  const rail = (
    <Rail label="Accept an invitation">
      <RailGroup label="Accept an invitation">
        <RailSteps steps={spineSteps} />
      </RailGroup>
      <RailGroup label="Customize">
        <RailFacts facts={acceptorRailFacts()} />
      </RailGroup>
    </Rail>
  );

  const ledger =
    token === undefined ? undefined : (
      <Ledger
        tag={acceptorLedgerTag(invitingPartyName(token))}
        rows={acceptorLedgerRows(token).map((row) => ({
          label: row.label,
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
        footer={ACCEPTOR_LEDGER_FOOTER}
      />
    );

  const consentGateReady = acceptorConsentReady({
    consented,
    name: acceptorName,
  });

  return (
    <BenchShell rail={ready ? rail : undefined} ledger={ledger}>
      <div ref={stepHeadingRef}>
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
              <Button onClick={() => setStep("consent")}>
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
            <p className={`${styles.small} ${styles.sub}`}>
              Your file is processed entirely in your browser and it is never
              uploaded to our server.
            </p>
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
        {decode.status === "ready" && step === "columns" && (
          <>
            <p className={styles.eyebrow}>Step 3 of 3</p>
            <h1 tabIndex={-1}>Confirm your columns</h1>
            <p className={`${styles.small} ${styles.sub}`}>
              This step is the next package: it confirms which of your columns
              map to the agreed matching keys, then runs the exchange.
            </p>
          </>
        )}
      </div>
    </BenchShell>
  );
}
