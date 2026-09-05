import { useEffect, useRef, useState } from "react";

import { Alert, Button, Stack, Text, TextInput } from "@mantine/core";
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCircleCheck,
  IconFileText,
} from "@tabler/icons-react";
import { Dropzone } from "@mantine/dropzone";
import log from "loglevel";

import {
  deriveOurIdColumn,
  reconstructCommittedData,
  reproductionMismatchCauses,
  sanitizeErrorForDisplay,
  toRetainedResult,
  verifyExchangeRecord,
} from "@psilink/core";

import { DisclosureSection } from "@components/DisclosureSection";
import { MAX_CSV_FILE_BYTES } from "@components/csvIntake";
import { importLinkageTerms } from "@psi/linkageTermsIO";
import { loadCSVFileOffMainThread } from "@psi/csvParseController";

import {
  parseCertificateDocument,
  parseKeysDocument,
  parseRecordDocument,
  parseSignedRecordDocument,
  pinnedFingerprintProblem,
  signedVerdictViewModel,
  verdictViewModel,
  verifySignedRecord,
} from "./verifyReceiptModel";
import { BenchShell } from "./BenchShell";
import styles from "./bench.module.css";

import type {
  DualSignedRecord,
  ExchangeRecord,
  LinkageTerms,
  RecordVerificationReport,
  VerificationKeys,
} from "@psilink/core";
import type {
  SignedVerdictViewModel,
  VerdictRow,
  VerdictTone,
  VerdictViewModel,
} from "./verifyReceiptModel";
import type { FileRejection } from "@mantine/dropzone";
import type { ReactNode } from "react";

/**
 * The console's "Verify a receipt" surface: a read-only, browser-only check of the
 * artifacts an exchange leaves behind. The user loads the exchange record and its
 * keys, and optionally re-supplies their retained input, result, and both parties'
 * linkage terms to open the commitments and re-derive the agreed-terms hash. When
 * the exchange was signed, the dual-signed record is checked in the same run,
 * anchored by the partner's pinned fingerprint and by this party's own EXPORTED
 * certificate -- no private signing key is accepted, required, or used here. The
 * verdicts are accurate -- a mismatch is stated as "altered or the wrong file",
 * never as tamper alone, and an unanchored certificate holds the signed verdict
 * short of verified (see {@link verifyReceiptModel}) -- and nothing is uploaded.
 *
 * The pure parsing and the verdict copy live in {@link verifyReceiptModel}; this
 * component owns the file inputs, the re-run gating, and the designed alert
 * states. A file input is never cleared on error: a malformed or wrong file lands
 * on a focused alert with the input intact so the user can swap just that file.
 */

// A JSON receipt or keys file is tiny; cap the dropzone far below the CSV cap.
// The sensitive-JSON chokepoint bounds the body too, but the dropzone refuses a
// pathological file before it is ever read.
const MAX_JSON_FILE_BYTES = 2 * 1024 ** 2;
const JSON_MAX_MB = MAX_JSON_FILE_BYTES / 1024 ** 2;

// The re-supplied input/result CSVs share the app-wide browser-memory bound.
const CSV_MAX_MB = MAX_CSV_FILE_BYTES / 1024 ** 2;

// What a dropzone shows for the file it holds: its name, and nothing else. The
// impossible `text` member is the enforcement -- a document's own text is read,
// parsed, and dropped inside the handler, and this makes the shape that held
// it alongside the name unassignable to any slot on this page rather than
// merely unused. It does not stop a future author declaring a new member.
interface ChosenFile {
  name: string;
  text?: never;
}

interface ParsedRecordState {
  file: ChosenFile;
  record?: ExchangeRecord;
  alert?: string;
}

interface ParsedKeysState {
  file: ChosenFile;
  keys?: VerificationKeys;
  alert?: string;
}

interface ParsedSignedRecordState {
  file: ChosenFile;
  record?: DualSignedRecord;
  alert?: string;
}

// Only the fingerprint recomputed from the certificate is retained: it is the
// whole of what anchors the verifier's own slot, so neither the parsed
// certificate nor the document it came from is held past the parse. The file
// dropped here can be a signing identity file, which holds a private key
// beside the certificate and is refused -- keeping only the name means a
// refused one leaves no key material in component state.
interface ParsedCertificateState {
  file: ChosenFile;
  fingerprint?: string;
  alert?: string;
}

/** Shown at both call sites the one-CSV state reaches: the re-supply section
 * that owns the two inputs, and the work foot, where it says why a run that
 * would otherwise skip the reconstruction in silence is held back instead. */
function OneCsvWarning() {
  return (
    <Text role="alert" c="yellow.8" size="sm">
      Supply both the input and the result to open the commitments, or neither.
    </Text>
  );
}

const TONE_COLOR: Record<VerdictTone, string> = {
  verified: "green",
  failed: "red",
  incomplete: "yellow",
};

function toneIcon(tone: VerdictTone): ReactNode {
  if (tone === "verified") return <IconCircleCheck aria-hidden />;
  if (tone === "failed") return <IconAlertCircle aria-hidden />;
  return <IconAlertTriangle aria-hidden />;
}

/** A labelled JSON dropzone: a parameterized copy of the console's CSV intake
 * furniture, for a single .json input with a filename-convention hint. */
function JsonDropzone({
  label,
  hint,
  chosen,
  onFile,
}: {
  label: string;
  hint: string;
  chosen: ChosenFile | undefined;
  onFile: (file: File) => void;
}) {
  const [rejectionMessage, setRejectionMessage] = useState<string>();
  function handleReject(rejections: Array<FileRejection>) {
    const codes = new Set(
      rejections.flatMap((rejection) =>
        rejection.errors.map((error) => error.code),
      ),
    );
    // Codes only in the log: a rejected file's name can itself be sensitive.
    log.warn(`rejected ${rejections.length} file(s):`, [...codes]);
    const reasons: Array<string> = [];
    if (codes.has("file-too-large"))
      reasons.push(`larger than the ${JSON_MAX_MB} MB maximum`);
    if (codes.has("file-invalid-type") || reasons.length === 0)
      reasons.push("not a JSON file");
    setRejectionMessage(
      `That file is ${reasons.join(" and ")}. Choose a .json file under ${JSON_MAX_MB} MB.`,
    );
  }
  return (
    <div>
      <Text size="sm" fw={600}>
        {label}
      </Text>
      <Text size="xs" c="dimmed" mb={4}>
        {hint}
      </Text>
      <Dropzone
        className={styles.dropzone}
        onDrop={(files) => {
          setRejectionMessage(undefined);
          const file = files.at(0);
          if (file !== undefined) onFile(file);
        }}
        onReject={handleReject}
        accept={["application/json", "text/json"]}
        maxSize={MAX_JSON_FILE_BYTES}
        multiple={false}
        aria-label={label}
      >
        <p>
          <strong>Drag the file here or click to select</strong>
        </p>
        <p className={styles.dropzoneMax}>(Max file size: {JSON_MAX_MB} MB)</p>
      </Dropzone>
      {rejectionMessage !== undefined && (
        <Text role="alert" c="red" size="sm" mt="xs">
          {rejectionMessage}
        </Text>
      )}
      {chosen !== undefined && (
        <div className={styles.fileCard}>
          <IconFileText aria-hidden />
          <div className={`${styles.fileName} ${styles.mono}`}>
            {chosen.name}
          </div>
        </div>
      )}
    </div>
  );
}

/** A dashed inset for a designed parse-failure alert, focused when it appears so
 * the failure is announced without clearing the input. */
function ParseAlert({ title, message }: { title: string; message: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [message]);
  return (
    <Alert
      color="red"
      title={title}
      icon={<IconAlertCircle aria-hidden />}
      ref={ref}
      tabIndex={-1}
      mt="xs"
    >
      {/* sanitizeErrorForDisplay separates a cause chain with newlines; pre-line
          preserves them (its documented rendering contract). */}
      <span style={{ whiteSpace: "pre-line" }}>{message}</span>
    </Alert>
  );
}

/** The linkage-terms re-supply idiom, paste-based, mirroring TermsImportExport:
 * a textarea whose Import validates through importLinkageTerms and reports a
 * value-free error inline. */
function TermsInput({
  label,
  description,
  terms,
  onTerms,
}: {
  label: string;
  description: string;
  terms: LinkageTerms | undefined;
  onTerms: (terms: LinkageTerms | undefined) => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  function handleImport() {
    const result = importLinkageTerms(text);
    if (!result.success) {
      setError(result.error);
      onTerms(undefined);
      return;
    }
    setError(undefined);
    onTerms(result.terms);
  }
  return (
    <Stack gap="xs">
      <Text size="sm" fw={600}>
        {label}
      </Text>
      <Text size="xs" c="dimmed">
        {description}
      </Text>
      <textarea
        aria-label={label}
        value={text}
        onChange={(event) => {
          setText(event.currentTarget.value);
          setError(undefined);
          // The parse belongs to the text it was made from: editing the buffer
          // withdraws it, so neither the "Loaded." badge nor a verdict computed
          // from it can describe a document that was never imported.
          if (terms !== undefined) onTerms(undefined);
        }}
        rows={4}
        style={{ fontFamily: "monospace", width: "100%" }}
        placeholder="{ ... }"
      />
      {error !== undefined && (
        <Text role="alert" c="red" size="sm">
          {error}
        </Text>
      )}
      {terms !== undefined && error === undefined && (
        <Text size="xs" c="var(--mantine-color-green-light-color)">
          Loaded.
        </Text>
      )}
      <div>
        <Button size="xs" onClick={handleImport} disabled={text.trim() === ""}>
          Load these terms
        </Button>
      </div>
    </Stack>
  );
}

export function VerifyReceiptBench() {
  const [record, setRecord] = useState<ParsedRecordState>();
  const [keys, setKeys] = useState<ParsedKeysState>();

  // Re-supply (optional): the retained input and result files, and both parties'
  // linkage terms.
  const [resupplyOpen, setResupplyOpen] = useState(false);
  // The original File, never its contents: unlike the JSON record and keys
  // (parsed and dropped on load), a re-supplied CSV is only parsed at verify
  // time and the run can repeat, so the File itself is held rather than read
  // to text now and rewrapped into a fresh File at each run.
  const [inputCsv, setInputCsv] = useState<File>();
  const [resultCsv, setResultCsv] = useState<File>();
  const [localTerms, setLocalTerms] = useState<LinkageTerms>();
  const [partnerTerms, setPartnerTerms] = useState<LinkageTerms>();

  // The signed leg (optional): the dual-signed record, and the two anchoring
  // values -- the partner's pinned fingerprint, typed, and this party's own
  // exported certificate (never its signing identity, which holds the key).
  const [signedOpen, setSignedOpen] = useState(false);
  const [signedRecord, setSignedRecord] = useState<ParsedSignedRecordState>();
  const [pinnedFingerprint, setPinnedFingerprint] = useState("");
  const [certificate, setCertificate] = useState<ParsedCertificateState>();

  const [verdict, setVerdict] = useState<VerdictViewModel>();
  const [signedVerdict, setSignedVerdict] = useState<SignedVerdictViewModel>();
  const [verifyError, setVerifyError] = useState<string>();
  const [verifying, setVerifying] = useState(false);

  // Which exchange the loaded inputs belong to: bumped when the record or keys
  // change, and used as the terms inputs' key so their paste buffers are the
  // previous exchange's no more than the parsed terms are.
  const [exchangeGeneration, setExchangeGeneration] = useState(0);
  // Which set of inputs a verdict may be written from: bumped by every input
  // event, and read by a run to decide whether its own inputs still stand.
  const runToken = useRef(0);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const verdictRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (
      verdict !== undefined ||
      signedVerdict !== undefined ||
      verifyError !== undefined
    )
      verdictRef.current?.focus();
  }, [verdict, signedVerdict, verifyError]);

  // Every input event withdraws both verdicts and any fault alert, so nothing
  // rendered is derived from an input the page no longer holds. Both verdicts
  // go on any edit, since the record verdict's standing note points at the
  // signed panel beside it and must not outlive it. The bump also supersedes
  // any run already in flight -- including one captured between a handler's
  // first bump and its awaited parse, since the handlers bump again after
  // their state writes land.
  function invalidateVerdicts() {
    runToken.current += 1;
    setVerdict(undefined);
    setSignedVerdict(undefined);
    setVerifyError(undefined);
  }

  // A newly loaded record or keys file starts a possibly different exchange, so
  // every input belonging to the previous one is cleared: the re-supplied files
  // and pasted terms (which open that record's commitments), and the
  // dual-signed record -- its verification consults values that repeat across
  // every run of the same partnership and are reported rather than compared,
  // so a stale receipt would otherwise be consumed beside the wrong record
  // without saying so. The two anchoring values stay: the operator reuses them
  // across a partner's exchanges, and one belonging elsewhere reaches neither
  // certificate in the record, which the verdict reports as an unmatched
  // anchor.
  function clearExchangeScopedInputs() {
    setInputCsv(undefined);
    setResultCsv(undefined);
    setLocalTerms(undefined);
    setPartnerTerms(undefined);
    setSignedRecord(undefined);
    setExchangeGeneration((generation) => generation + 1);
  }

  async function onRecordFile(file: File) {
    invalidateVerdicts();
    const parsed = parseRecordDocument(await file.text());
    clearExchangeScopedInputs();
    const chosen = { name: file.name };
    if (parsed.kind === "ok")
      setRecord({ file: chosen, record: parsed.record });
    else setRecord({ file: chosen, alert: parsed.message });
    invalidateVerdicts();
  }

  async function onKeysFile(file: File) {
    invalidateVerdicts();
    const parsed = parseKeysDocument(await file.text());
    clearExchangeScopedInputs();
    const chosen = { name: file.name };
    if (parsed.kind === "ok") setKeys({ file: chosen, keys: parsed.keys });
    else setKeys({ file: chosen, alert: parsed.message });
    invalidateVerdicts();
  }

  async function onSignedRecordFile(file: File) {
    invalidateVerdicts();
    const parsed = parseSignedRecordDocument(await file.text());
    const chosen = { name: file.name };
    if (parsed.kind === "ok")
      setSignedRecord({ file: chosen, record: parsed.record });
    else setSignedRecord({ file: chosen, alert: parsed.message });
    invalidateVerdicts();
  }

  async function onCertificateFile(file: File) {
    invalidateVerdicts();
    const parsed = await parseCertificateDocument(await file.text());
    const chosen = { name: file.name };
    if (parsed.kind === "ok")
      setCertificate({ file: chosen, fingerprint: parsed.fingerprint });
    else setCertificate({ file: chosen, alert: parsed.message });
    invalidateVerdicts();
  }

  function onPinnedFingerprint(value: string) {
    invalidateVerdicts();
    setPinnedFingerprint(value);
  }

  function onCsvFile(file: File, set: (value: File) => void): void {
    invalidateVerdicts();
    set(file);
  }

  function onLocalTerms(terms: LinkageTerms | undefined) {
    invalidateVerdicts();
    setLocalTerms(terms);
  }

  function onPartnerTerms(terms: LinkageTerms | undefined) {
    invalidateVerdicts();
    setPartnerTerms(terms);
  }

  const pinProblem = pinnedFingerprintProblem(pinnedFingerprint);
  const recordReady = record?.record !== undefined && keys?.keys !== undefined;
  const signedReady = signedRecord?.record !== undefined;
  // A malformed pin gates the run rather than reaching the verification, where
  // it would be reported as a partner certificate that does not match.
  const canVerify =
    (recordReady || signedReady) && pinProblem === undefined && !verifying;

  async function runVerify() {
    if (!recordReady && !signedReady) return;
    setVerifying(true);
    // The inputs this run reads are the ones loaded now; nothing on the page is
    // disabled while it runs, and it writes its verdicts several awaits later.
    const token = runToken.current;
    setVerifyError(undefined);
    try {
      const parsedRecord = record?.record;
      let recordReport: RecordVerificationReport | undefined;
      let recordWarnings: Array<string> = [];
      if (parsedRecord !== undefined && keys?.keys !== undefined) {
        let data: Awaited<ReturnType<typeof reconstructCommittedData>>["data"] =
          {};
        if (inputCsv !== undefined && resultCsv !== undefined) {
          const inputParse = await loadCSVFileOffMainThread(inputCsv);
          const resultParse = await loadCSVFileOffMainThread(resultCsv);
          const result = toRetainedResult(resultParse);
          const ourIdColumn = deriveOurIdColumn(
            result.headers,
            new Set(inputParse.meta.fields ?? []),
          );
          const reconstructed = reconstructCommittedData({
            record: parsedRecord,
            inputRows: inputParse.data,
            result,
            ourIdColumn,
          });
          data = reconstructed.data;
          recordWarnings = reconstructed.warnings;
        }
        recordReport = await verifyExchangeRecord(parsedRecord, keys.keys, {
          data,
          localTerms,
          partnerTerms,
        });
        // A reproduction limitation is named only once the verdict shows it
        // could be the cause, so it joins the notes after the report, not
        // before it.
        recordWarnings = [
          ...recordWarnings,
          ...reproductionMismatchCauses(recordReport, data),
        ];
      }
      let signedView: SignedVerdictViewModel | undefined;
      if (signedRecord?.record !== undefined) {
        const report = await verifySignedRecord(
          signedRecord.record,
          {
            pinnedFingerprint,
            ownCertificateFingerprint: certificate?.fingerprint,
          },
          { record: parsedRecord, localTerms, partnerTerms },
        );
        signedView = signedVerdictViewModel(report);
      }
      // An input changed while this run was reading files and computing, so its
      // result describes inputs the page no longer holds: the edit already
      // withdrew the verdicts, and this run adds none back.
      if (token !== runToken.current) return;
      // Both verdicts are set once both legs have run: the record verdict's
      // standing note points at the signed panel on the strength of the verdict
      // rendered beside it, never of the input supplied to produce it.
      if (recordReport !== undefined)
        setVerdict(
          verdictViewModel(
            recordReport,
            recordWarnings,
            signedView !== undefined,
          ),
        );
      if (signedView !== undefined) setSignedVerdict(signedView);
    } catch (error) {
      // The verify path is fail-safe in core (every check yields a status), so a
      // throw here is an unexpected fault -- show it sanitized, never raw,
      // and only while it is still this run's inputs that faulted.
      if (token === runToken.current)
        setVerifyError(sanitizeErrorForDisplay(error));
    } finally {
      setVerifying(false);
    }
  }

  const bothCsvSupplied = inputCsv !== undefined && resultCsv !== undefined;
  const oneCsvSupplied = (inputCsv !== undefined) !== (resultCsv !== undefined);
  // Every Verify button starts the same run, and only the record leg reads the
  // re-supplied CSVs, so a half-supplied pair blocks a run exactly when that leg
  // is the one that would run. A signed-record-only run never reads them.
  const oneCsvStarvesRun = recordReady && oneCsvSupplied;

  return (
    <BenchShell>
      <h1 tabIndex={-1} ref={headingRef}>
        Verify a receipt
      </h1>
      <p className={`${styles.small} ${styles.sub}`}>
        Check that an exchange record you kept is internally consistent: its
        commitments open against the files you re-supply, the result size it
        records is the number of matched pairs it commits to, and its
        agreed-terms hash re-derives. If the exchange was signed, check a
        dual-signed record too: both parties&apos; signatures, and what anchors
        each certificate outside the record. This is read-only and runs entirely
        in your browser -- nothing is uploaded.
      </p>

      <Stack gap="lg" mt="md">
        <JsonDropzone
          label="Exchange record"
          hint="The shareable record: psilink-record-<stamp>.json"
          chosen={record?.file}
          onFile={(file) => void onRecordFile(file)}
        />
        {record?.alert !== undefined && (
          <ParseAlert
            title="This record could not be used"
            message={record.alert}
          />
        )}

        <JsonDropzone
          label="Verification keys"
          hint="The private keys: psilink-record-<stamp>.keys.json"
          chosen={keys?.file}
          onFile={(file) => void onKeysFile(file)}
        />
        {keys?.alert !== undefined && (
          <ParseAlert
            title="These keys could not be used"
            message={keys.alert}
          />
        )}
      </Stack>

      <div className={styles.workFoot}>
        <Button
          disabled={!canVerify || oneCsvStarvesRun}
          onClick={() => void runVerify()}
        >
          Verify
        </Button>
        <p className={styles.statusLine}>
          {recordReady
            ? "Ready to verify."
            : signedReady
              ? "Ready to verify the dual-signed record."
              : "Load the record and its keys, or a dual-signed record, to verify."}
        </p>
        {oneCsvStarvesRun && <OneCsvWarning />}
      </div>

      {/* The verdict and any verify-time fault share one stable focus target. */}
      <div ref={verdictRef} tabIndex={-1} data-testid="verdict">
        {verifyError !== undefined && (
          <Alert
            color="red"
            title="Verification could not run"
            icon={<IconAlertCircle aria-hidden />}
            mt="md"
          >
            <span style={{ whiteSpace: "pre-line" }}>{verifyError}</span>
          </Alert>
        )}
        {verdict !== undefined && (
          <Stack gap="sm" mt="md">
            <Alert
              color={TONE_COLOR[verdict.headline.tone]}
              icon={toneIcon(verdict.headline.tone)}
              title={verdict.headline.title}
            >
              {verdict.headline.detail}
            </Alert>
            <div className={styles.stateInset}>
              <p className={styles.stateLabel}>What was checked</p>
              <Stack gap="xs">
                {verdict.commitments.map((row) => (
                  <VerdictCheckRow key={row.label} row={row} />
                ))}
                {verdict.resultSize !== undefined && (
                  <VerdictCheckRow row={verdict.resultSize} />
                )}
                <VerdictCheckRow row={verdict.termsHash} />
              </Stack>
              {verdict.warnings.length > 0 && (
                <Stack gap={4} mt="sm">
                  {verdict.warnings.map((warning, index) => (
                    <Text key={index} size="xs" c="dimmed">
                      Note: {warning}
                    </Text>
                  ))}
                </Stack>
              )}
              <Text size="xs" c="dimmed" mt="sm">
                {verdict.signatureNote}
              </Text>
            </div>
          </Stack>
        )}
        {signedVerdict !== undefined && (
          <Stack gap="sm" mt="md">
            <Alert
              color={TONE_COLOR[signedVerdict.headline.tone]}
              icon={toneIcon(signedVerdict.headline.tone)}
              title={signedVerdict.headline.title}
            >
              {signedVerdict.headline.detail}
            </Alert>
            <div className={styles.stateInset}>
              <p className={styles.stateLabel}>
                What the signatures and certificates show
              </p>
              <Stack gap="md">
                {signedVerdict.parties.map((party) => (
                  <SignedPartySection key={party.label} party={party} />
                ))}
                <VerdictCheckRow row={signedVerdict.termsHash} />
                <VerdictCheckRow row={signedVerdict.runBinding} />
              </Stack>
              {signedVerdict.guidance.length > 0 && (
                <Stack gap={4} mt="sm">
                  {signedVerdict.guidance.map((line) => (
                    <Text key={line} size="xs" c="yellow.8">
                      {line}
                    </Text>
                  ))}
                </Stack>
              )}
              <Text size="xs" c="dimmed" mt="sm">
                {signedVerdict.binderNote}
              </Text>
            </div>
          </Stack>
        )}
      </div>

      <div style={{ marginTop: "2rem" }}>
        <DisclosureSection
          label="Re-supply your files to open the commitments"
          open={resupplyOpen}
          onToggle={setResupplyOpen}
          headingOrder={2}
          summary="Optional"
        >
          <Stack gap="lg" mt="sm">
            <Text size="sm" c="dimmed">
              Without your retained files, the record is checked for structure
              and version only, and each commitment is reported as not opened.
              Re-supply the input and result you kept to open the commitments,
              and both parties&apos; linkage terms to check the agreed-terms
              hash. Supply the input and result together, or neither.
            </Text>
            <JsonOrCsvDropzone
              label="Your input CSV"
              hint="The input file you contributed to this exchange"
              chosen={inputCsv}
              onFile={(file) => onCsvFile(file, setInputCsv)}
            />
            <JsonOrCsvDropzone
              label="Your result CSV"
              hint="The result file you retained from this exchange"
              chosen={resultCsv}
              onFile={(file) => onCsvFile(file, setResultCsv)}
            />
            {oneCsvSupplied && <OneCsvWarning />}
            {/* Keyed by the exchange: a new record or keys file remounts these,
                dropping the pasted text with the terms parsed from it. */}
            <TermsInput
              key={`local-terms-${exchangeGeneration}`}
              label="Your linkage terms"
              description="Paste your exchange config or exported linkage-terms document. Only its linkage_terms are read; nothing else in a config is."
              terms={localTerms}
              onTerms={onLocalTerms}
            />
            <TermsInput
              key={`partner-terms-${exchangeGeneration}`}
              label="Your partner's linkage terms"
              description="Paste your partner's config or exported terms, read the same way. The partner's terms are not retained by default; both sides are needed to check the hash."
              terms={partnerTerms}
              onTerms={onPartnerTerms}
            />
            <div>
              <Button
                onClick={() => void runVerify()}
                disabled={!canVerify || oneCsvStarvesRun}
              >
                Verify with these files
              </Button>
              {bothCsvSupplied && (
                <Text size="xs" c="dimmed" mt={4}>
                  Re-running updates the verdict above.
                </Text>
              )}
            </div>
          </Stack>
        </DisclosureSection>
      </div>

      <div style={{ marginTop: "2rem" }}>
        <DisclosureSection
          label="Check the partner's signatures with the dual-signed record"
          open={signedOpen}
          onToggle={setSignedOpen}
          headingOrder={2}
          summary="Optional"
        >
          <Stack gap="lg" mt="sm">
            <Text size="sm" c="dimmed">
              A dual-signed record is the evidence against your partner: both
              parties signed the same receipt content. Signatures alone prove
              only that the holders of the two certificates inside it signed,
              and anyone can mint two certificates of their own -- so each
              certificate must be anchored to a party you know from outside the
              record. Enter your partner&apos;s fingerprint, pinned out-of-band,
              and load your own exported certificate for the slot that is yours.
            </Text>
            <JsonDropzone
              label="Dual-signed record"
              hint="The record both parties signed: psilink-receipt-<stamp>.json"
              chosen={signedRecord?.file}
              onFile={(file) => void onSignedRecordFile(file)}
            />
            {signedRecord?.alert !== undefined && (
              <ParseAlert
                title="This dual-signed record could not be used"
                message={signedRecord.alert}
              />
            )}
            <TextInput
              label="Your partner's certificate fingerprint"
              description="The fingerprint your partner gave you out-of-band, from 'psilink fingerprint'. It anchors their slot: without it, nothing outside the record vouches for their certificate."
              classNames={{ input: styles.mono }}
              value={pinnedFingerprint}
              error={pinProblem}
              errorProps={{ role: "alert" }}
              onChange={(event) =>
                onPinnedFingerprint(event.currentTarget.value)
              }
            />
            <JsonDropzone
              label="Your exported certificate"
              hint="The public certificate from 'psilink fingerprint --export-certificate'. Not your signing identity file: nothing here signs, so this page never imports or uses a private key."
              chosen={certificate?.file}
              onFile={(file) => void onCertificateFile(file)}
            />
            {certificate?.alert !== undefined && (
              <ParseAlert
                title="This certificate could not be used"
                message={certificate.alert}
              />
            )}
            <div>
              <Button
                onClick={() => void runVerify()}
                disabled={!canVerify || oneCsvStarvesRun}
              >
                Verify with the signed record
              </Button>
              {signedReady && (
                <Text size="xs" c="dimmed" mt={4}>
                  Re-running updates the verdict above.
                </Text>
              )}
            </div>
          </Stack>
        </DisclosureSection>
      </div>
    </BenchShell>
  );
}

/** One party's slot in the signed verdict: who the record says they are, the
 * fingerprint recomputed from their certificate, and the per-check rows. */
function SignedPartySection({
  party,
}: {
  party: SignedVerdictViewModel["parties"][number];
}) {
  return (
    <div>
      <Text size="sm" fw={600}>
        {party.label}: {party.identity}
      </Text>
      <Text size="xs" c="dimmed">
        Certificate fingerprint{" "}
        <span className={styles.mono}>{party.fingerprint}</span>
      </Text>
      <Stack gap="xs" mt={4}>
        {party.rows.map((row) => (
          <VerdictCheckRow key={row.label} row={row} />
        ))}
      </Stack>
    </div>
  );
}

function VerdictCheckRow({ row }: { row: VerdictRow }) {
  return (
    <div>
      <Text size="sm">
        <Text span fw={600}>
          {row.label}:
        </Text>{" "}
        <Text span c={`${TONE_COLOR[row.tone]}.8`}>
          {row.status}
        </Text>
      </Text>
      {row.explanation !== undefined && (
        <Text size="xs" c="dimmed">
          {row.explanation}
        </Text>
      )}
    </div>
  );
}

/** A CSV dropzone for the re-supply section: the same furniture as the JSON one
 * but accepting the CSV type list. Kept local (not the inviter's YourFileSection,
 * which holds a name field and terms callout this page does not want). */
function JsonOrCsvDropzone({
  label,
  hint,
  chosen,
  onFile,
}: {
  label: string;
  hint: string;
  chosen: File | undefined;
  onFile: (file: File) => void;
}) {
  const [rejectionMessage, setRejectionMessage] = useState<string>();
  function handleReject(rejections: Array<FileRejection>) {
    const codes = new Set(
      rejections.flatMap((rejection) =>
        rejection.errors.map((error) => error.code),
      ),
    );
    log.warn(`rejected ${rejections.length} file(s):`, [...codes]);
    const reasons: Array<string> = [];
    if (codes.has("file-too-large"))
      reasons.push(`larger than the ${CSV_MAX_MB} MB maximum`);
    if (codes.has("file-invalid-type") || reasons.length === 0)
      reasons.push("not a supported file type");
    setRejectionMessage(
      `That file is ${reasons.join(" and ")}. Choose a CSV file under ${CSV_MAX_MB} MB.`,
    );
  }
  return (
    <div>
      <Text size="sm" fw={600}>
        {label}
      </Text>
      <Text size="xs" c="dimmed" mb={4}>
        {hint}
      </Text>
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
        aria-label={label}
      >
        <p>
          <strong>Drag the file here or click to select</strong>
        </p>
        <p className={styles.dropzoneMax}>(Max file size: {CSV_MAX_MB} MB)</p>
      </Dropzone>
      {rejectionMessage !== undefined && (
        <Text role="alert" c="red" size="sm" mt="xs">
          {rejectionMessage}
        </Text>
      )}
      {chosen !== undefined && (
        <div className={styles.fileCard}>
          <IconFileText aria-hidden />
          <div className={`${styles.fileName} ${styles.mono}`}>
            {chosen.name}
          </div>
        </div>
      )}
    </div>
  );
}
