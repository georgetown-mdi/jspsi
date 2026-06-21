export * from "./errors";
export * from "./participant";
export * from "./link";
export * from "./protocolSetup";
export * from "./types";
export * from "./connection/fileSyncConnection";
export type { HelloEnvelope } from "./connection/controlEnvelope";
export * from "./connection/messageConnection";
export { EncryptedMessageConnection } from "./connection/encryptedMessageConnection";
export {
  getLogger,
  getLoggerForVerbosity,
  setLogPrefixer,
} from "./utils/logger";
export { retryPromise, withTimeout, TimeoutError } from "./utils/promise";
// @internal: the CLI config writer (saveConfig) delegates to this snakeize
// direction so the read and write paths share one recurse-and-skip traversal;
// not a stable public API (see the declaration's JSDoc).
export { snakeizeKeys } from "./utils/camelizeKeys";
// The camelize/snakeize nesting-depth discipline, re-applied by the CLI's
// invitation-vs-config reconcile to its own recursive NFC/canonical walk
// (apps/cli/src/config.ts, nfcDeep): the invitation decode path does not run
// camelizeKeys over the z.unknown() transform.params, so the same bound must be
// asserted at that downstream consumer. See docs/spec/CHANNEL_SECURITY.md.
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

export * from "./config/standardization";
export * from "./config/connection";
export * from "./defaults/linkageTerms";
export * from "./defaults/standardization";
export * from "./config/exchangeSpec";
export * from "./config/linkageTerms";
export * from "./config/invitation";
export * from "./config/metadata";
export * from "./config/signing";
export * from "./signingIdentity";
export * from "./standardization";
export { loadCSVFile, loadCSVColumns } from "./file";

export { inferDateFormat } from "./utils/date.js";
export {
  computeHostKeyFingerprint,
  verifyHostKeyFingerprint,
  keyTypeFromBlob,
} from "./utils/sshHostKey.js";
export * from "./exchange";
export * from "./exchangeRecord";
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
