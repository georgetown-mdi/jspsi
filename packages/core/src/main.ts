export * from "./errors";
export * from "./participant";
export * from "./link";
export * from "./protocolSetup";
export * from "./types";
export * from "./connection/fileSyncConnection";
export type { HelloEnvelope } from "./connection/controlEnvelope";
export * from "./connection/messageConnection";
export { getLogger, setLogPrefixer } from "./utils/logger";
export { retryPromise, withTimeout } from "./utils/promise";
// @internal: shared with the CLI config writer so read/write skip identical
// subtrees; not a stable public API (see the declaration's JSDoc).
export { OPAQUE_VALUE_KEYS } from "./utils/camelizeKeys";

export * from "./config/standardization";
export * from "./config/connection";
export * from "./defaults/linkageTerms";
export * from "./defaults/standardization";
export * from "./config/exchangeSpec";
export * from "./config/linkageTerms";
export * from "./config/invitation";
export * from "./config/metadata";
export * from "./standardization";
export { loadCSVFile } from "./file";

export { inferDateFormat } from "./utils/date.js";
export * from "./exchange";
export * from "./payloadExchange";
export { authenticateConnection, deriveAeadKey } from "./auth";
export type { AuthResult } from "./auth";
export { runSpake2 } from "./pake";
export type { Spake2Result } from "./pake";
