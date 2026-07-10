export * from "./errors";
export * from "./participant";
export * from "./psiBackend";
export * from "./psiEngine";
export * from "./psiWorkerEngine";
export * from "./link";
export * from "./protocolSetup";
export * from "./types";
export * from "./connection/fileSyncConnection";
export type { HelloEnvelope } from "./connection/controlEnvelope";
export * from "./connection/messageConnection";
export {
  EncryptedMessageConnection,
  AEAD_ENVELOPE_VERSION,
} from "./connection/encryptedMessageConnection";
export {
  getLogger,
  getLoggerForVerbosity,
  setLogPrefixer,
  setDiagnosticSink,
  getDiagnosticSink,
} from "./utils/logger";
export type { DiagnosticSink } from "./utils/logger";
export { retryPromise, withTimeout, TimeoutError } from "./utils/promise";
// @internal: the CLI config writer (saveConfig) delegates to this snakeize
// direction so the read and write paths share one recurse-and-skip traversal;
// not a stable public API (see the declaration's JSDoc).
export { snakeizeKeys } from "./utils/camelizeKeys";
// The camelize/snakeize nesting-depth discipline. The invitation decode path
// normalizes transform.params through this bounded camelizeKeys chokepoint (the
// camelize pre-pass in config/invitation.ts), so a pathologically deep params is
// rejected at decode like it is on every other parse path; the CLI's
// invitation-vs-config reconcile (apps/cli/src/config.ts, nfcDeep) keeps its own
// depth guard as a backstop for that independent recursive walk. See
// docs/spec/CHANNEL_SECURITY.md.
export {
  MAX_NESTING_DEPTH,
  NestingDepthExceededError,
} from "./utils/camelizeKeys";
export {
  canonicalString,
  canonicalBytes,
  safeIntegerSchema,
  CanonicalEncodingError,
} from "./utils/canonical";
export type { CanonicalValue } from "./utils/canonical";
export {
  sanitizeForDisplay,
  DISPLAY_TRUNCATION_MARKER,
  DEFAULT_MAX_DISPLAY_LENGTH,
} from "./utils/sanitizeForDisplay";
export type { SanitizeForDisplayOptions } from "./utils/sanitizeForDisplay";
export {
  sanitizeErrorForDisplay,
  MAX_ERROR_CAUSE_DEPTH,
} from "./utils/sanitizeErrorForDisplay";
export { describeDecodeError } from "./utils/describeDecodeError";
export { compileLinearRegex } from "./utils/linearRegex";
export type { CompiledLinearRegex } from "./utils/linearRegex";

export * from "./config/standardization";
export * from "./config/connection";
export * from "./defaults/linkageTerms";
export * from "./defaults/standardization";
export * from "./config/exchangeSpec";
export * from "./config/linkageTerms";
export * from "./config/invitation";
export * from "./config/endpointProducer";
export * from "./config/exchangeFile";
export * from "./config/metadata";
export * from "./config/signing";
export * from "./signingIdentity";
export * from "./standardization";
export {
  loadCSVFile,
  loadCSVColumns,
  loadCSVColumnSample,
  CSV_LINE_BYTE_CEILING,
} from "./file";
export type { CSVRow } from "./file";

export {
  inferDateFormat,
  columnValues,
  INFER_DATE_SCAN_CAP,
} from "./utils/date.js";
export {
  computeHostKeyFingerprint,
  keyTypeFromBlob,
} from "./utils/sshHostKey.js";
export * from "./exchange";
export * from "./exchangeRecord";
export * from "./recordVerification";
export * from "./payloadExchange";
export {
  authenticateConnection,
  assertSharedSecretReadyForHandshake,
  deriveAeadKey,
  AEAD_CONTEXTS,
  deriveAbortToken,
  ABORT_TOKEN_ROLES,
} from "./auth";
export type { AuthResult, AeadContext, AbortTokenRole } from "./auth";
export { runKex } from "./kex";
export type { KexResult } from "./kex";
export { deriveRendezvousPeerId, RENDEZVOUS_ROLES } from "./rendezvous";
export type { RendezvousRole } from "./rendezvous";
// The shared chokepoint for parsing config/credential documents that may hold
// secrets, so a parse error never leaks source bytes. Consumed by the CLI (file
// reads, via its thin re-export) and the web app (an imported linkage-terms
// document); the raw `yaml` parsers are ESLint-banned outside this module in
// both apps.
export {
  parseSensitiveYaml,
  editSensitiveYamlDocument,
  parseSensitiveJson,
} from "./sensitiveFile";
