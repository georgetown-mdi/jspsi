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
export { retryPromise, withTimeout } from "./utils/promise";
// @internal: the CLI config writer (saveConfig) delegates to this snakeize
// direction so the read and write paths share one recurse-and-skip traversal;
// not a stable public API (see the declaration's JSDoc).
export { snakeizeKeys } from "./utils/camelizeKeys";
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
export { loadCSVFile } from "./file";

export { inferDateFormat } from "./utils/date.js";
export * from "./exchange";
export * from "./exchangeRecord";
export * from "./payloadExchange";
export {
  authenticateConnection,
  assertSharedSecretReadyForHandshake,
  deriveAeadKey,
  AEAD_CONTEXTS,
} from "./auth";
export type { AuthResult, AeadContext } from "./auth";
export { runKex } from "./kex";
export type { KexResult } from "./kex";
export { deriveRendezvousPeerId, RENDEZVOUS_ROLES } from "./rendezvous";
export type { RendezvousRole } from "./rendezvous";
