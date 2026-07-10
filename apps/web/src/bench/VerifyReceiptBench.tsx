import { useEffect, useRef, useState } from "react";

import { Alert, Button, Stack, Text } from "@mantine/core";
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
  sanitizeErrorForDisplay,
  toRetainedResult,
  verifyExchangeRecord,
} from "@psilink/core";

import { DisclosureSection } from "@components/DisclosureSection";
import { importLinkageTerms } from "@psi/linkageTermsIO";
import { loadCSVFileOffMainThread } from "@psi/csvParseController";

import {
  parseKeysDocument,
  parseRecordDocument,
  verdictViewModel,
} from "./verifyReceiptModel";
import { BenchShell } from "./BenchShell";
import styles from "./bench.module.css";

import type {
  ExchangeRecord,
  LinkageTerms,
  VerificationKeys,
} from "@psilink/core";
import type { VerdictTone, VerdictViewModel } from "./verifyReceiptModel";
import type { FileRejection } from "@mantine/dropzone";
import type { ReactNode } from "react";

/**
 * The bench's "Verify a receipt" surface: a read-only, browser-only consistency
 * check of a stored exchange record. The user loads the record and its keys, and
 * optionally re-supplies their retained input, result, and both parties' linkage
 * terms to open the commitments and re-derive the agreed-terms hash. The verdict
 * is honest -- a mismatch is stated as "altered or the wrong file", never as
 * tamper alone (see {@link verifyReceiptModel}) -- and nothing is uploaded.
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

// The reconstruction and terms re-supply are optional; each holds its own parse
// state and a possible alert.
interface SuppliedFile {
  name: string;
  text: string;
}

interface ParsedRecordState {
  file: SuppliedFile;
  record?: ExchangeRecord;
  alert?: string;
}

interface ParsedKeysState {
  file: SuppliedFile;
  keys?: VerificationKeys;
  alert?: string;
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

/** A labelled JSON dropzone: a parameterized copy of the bench's CSV intake
 * furniture, for a single .json input with a filename-convention hint. */
function JsonDropzone({
  label,
  hint,
  chosen,
  onFile,
}: {
  label: string;
  hint: string;
  chosen: SuppliedFile | undefined;
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

/** Read a supplied text file. The browser File API; nothing leaves the tab. */
async function readSupplied(file: File): Promise<SuppliedFile> {
  return { name: file.name, text: await file.text() };
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
  const [inputCsv, setInputCsv] = useState<SuppliedFile>();
  const [resultCsv, setResultCsv] = useState<SuppliedFile>();
  const [localTerms, setLocalTerms] = useState<LinkageTerms>();
  const [partnerTerms, setPartnerTerms] = useState<LinkageTerms>();

  const [verdict, setVerdict] = useState<VerdictViewModel>();
  const [verifyError, setVerifyError] = useState<string>();
  const [verifying, setVerifying] = useState(false);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const verdictRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (verdict !== undefined || verifyError !== undefined)
      verdictRef.current?.focus();
  }, [verdict, verifyError]);

  async function onRecordFile(file: File) {
    const supplied = await readSupplied(file);
    const parsed = parseRecordDocument(supplied.text);
    setVerdict(undefined);
    setVerifyError(undefined);
    if (parsed.kind === "ok")
      setRecord({ file: supplied, record: parsed.record });
    else setRecord({ file: supplied, alert: parsed.message });
  }

  async function onKeysFile(file: File) {
    const supplied = await readSupplied(file);
    const parsed = parseKeysDocument(supplied.text);
    setVerdict(undefined);
    setVerifyError(undefined);
    if (parsed.kind === "ok") setKeys({ file: supplied, keys: parsed.keys });
    else setKeys({ file: supplied, alert: parsed.message });
  }

  async function onCsvFile(
    file: File,
    set: (value: SuppliedFile) => void,
  ): Promise<void> {
    set(await readSupplied(file));
    // A changed re-supply file invalidates the last verdict; the user re-runs.
    setVerdict(undefined);
    setVerifyError(undefined);
  }

  const canVerify =
    record?.record !== undefined && keys?.keys !== undefined && !verifying;

  async function runVerify() {
    if (record?.record === undefined || keys?.keys === undefined) return;
    setVerifying(true);
    setVerifyError(undefined);
    try {
      const parsedRecord = record.record;
      let data: Awaited<ReturnType<typeof reconstructCommittedData>>["data"] =
        {};
      let warnings: Array<string> = [];
      if (inputCsv !== undefined && resultCsv !== undefined) {
        const inputParse = await loadCSVFileOffMainThread(
          new File([inputCsv.text], inputCsv.name),
        );
        const resultParse = await loadCSVFileOffMainThread(
          new File([resultCsv.text], resultCsv.name),
        );
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
        warnings = reconstructed.warnings;
      }
      const report = await verifyExchangeRecord(parsedRecord, keys.keys, {
        data,
        localTerms,
        partnerTerms,
      });
      setVerdict(verdictViewModel(report, warnings));
    } catch (error) {
      // The verify path is fail-safe in core (every check yields a status), so a
      // throw here is an unexpected fault -- surface it sanitized, never raw.
      setVerifyError(sanitizeErrorForDisplay(error));
    } finally {
      setVerifying(false);
    }
  }

  const bothCsvSupplied = inputCsv !== undefined && resultCsv !== undefined;
  const oneCsvSupplied = (inputCsv !== undefined) !== (resultCsv !== undefined);

  return (
    <BenchShell>
      <h1 tabIndex={-1} ref={headingRef}>
        Verify a receipt
      </h1>
      <p className={`${styles.small} ${styles.sub}`}>
        Check that an exchange record you kept is internally consistent: its
        commitments open against the files you re-supply, and its agreed-terms
        hash re-derives. This is read-only and runs entirely in your browser --
        nothing is uploaded.
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
        <Button disabled={!canVerify} onClick={() => void runVerify()}>
          Verify
        </Button>
        <p className={styles.statusLine}>
          {record?.record !== undefined && keys?.keys !== undefined
            ? "Ready to verify."
            : "Load the record and its keys to verify."}
        </p>
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
              onFile={(file) => void onCsvFile(file, setInputCsv)}
            />
            <JsonOrCsvDropzone
              label="Your result CSV"
              hint="The result file you retained from this exchange"
              chosen={resultCsv}
              onFile={(file) => void onCsvFile(file, setResultCsv)}
            />
            {oneCsvSupplied && (
              <Text role="alert" c="yellow.8" size="sm">
                Supply both the input and the result to open the commitments, or
                neither.
              </Text>
            )}
            <TermsInput
              label="Your linkage terms"
              description="Paste your exchange config or exported linkage-terms document."
              terms={localTerms}
              onTerms={setLocalTerms}
            />
            <TermsInput
              label="Your partner's linkage terms"
              description="Paste your partner's config or exported terms. The partner's terms are not retained by default; both sides are needed to check the hash."
              terms={partnerTerms}
              onTerms={setPartnerTerms}
            />
            <div>
              <Button
                onClick={() => void runVerify()}
                disabled={!canVerify || oneCsvSupplied}
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
    </BenchShell>
  );
}

function VerdictCheckRow({ row }: { row: VerdictViewModel["termsHash"] }) {
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
 * which carries a name field and terms callout this page does not want). */
function JsonOrCsvDropzone({
  label,
  hint,
  chosen,
  onFile,
}: {
  label: string;
  hint: string;
  chosen: SuppliedFile | undefined;
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
    setRejectionMessage(
      codes.has("file-invalid-type")
        ? "That is not a supported file type. Choose a CSV file."
        : "That file could not be accepted. Choose a CSV file.",
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
        multiple={false}
        aria-label={label}
      >
        <p>
          <strong>Drag the file here or click to select</strong>
        </p>
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
