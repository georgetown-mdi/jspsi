export * from "./errors";
export * from "./participant";
export * from "./psiBackend";
export * from "./psiEngine";
export * from "./psiWorkerEngine";
export * from "./link";
export * from "./protocolSetup";
export * from "./types";
export * from "./connection/fileSyncConnection";
// The filename grammar module is not barrelled (see its header); this one
// recognizer is named individually because a FileTransportClient implementation
// outside this package needs it -- the CLI's SFTP adapter decides from it
// whether a path handed to safeDelete is the protocol's own in-flight temp
// write.
export { isProtocolTempName } from "./connection/fileSyncNames";
export type { HelloEnvelope } from "./connection/controlEnvelope";
export * from "./connection/messageConnection";
export {
  EncryptedMessageConnection,
  AEAD_ENVELOPE_VERSION,
} from "./connection/encryptedMessageConnection";
// The transport-agnostic half of the WebRTC data-channel inbound bound. Barrelled
// because the enforcement point is per-transport and lives outside this package
// (the web app's PeerJS reassembly wrapper), while the constants and the
// structural pre-scan they parameterize must stay one implementation.
export * from "./connection/binaryPackBounds";
export {
  getLogger,
  getLoggerForVerbosity,
  setLogLevel,
  setLogPrefixer,
  setDiagnosticSink,
  getDiagnosticSink,
} from "./utils/logger";
export type { DiagnosticSink } from "./utils/logger";
export { retryPromise, withTimeout, TimeoutError } from "./utils/promise";
// The untrusted-JSON chokepoint. Barrelled because a partner wire frame is
// parsed outside this package too -- the CLI's WebRTC broker signaling client
// reads JSON text off a socket the signaling server and the remote peer both
// feed -- and that parse must be the same structurally-bounded one, not a second
// implementation of it (CONTRIBUTING.md, Untrusted-JSON parsing).
export { parseBoundedJson, JsonStructureBoundError } from "./utils/boundedJson";
// The split-directory distinctness comparison. Barrelled because the console
// decides, ahead of a mint, whether the two rendezvous locators it would put on an
// invitation endpoint are distinct -- and that verdict has to be the one core's own
// endpoint and connection refines will reach, so the operator meets the name to set
// rather than core's refusal at mint. Comparison only: never the path used on disk
// (see the module header).
export { pathsResolveToSameDir } from "./utils/pathCompare";
// @internal: the CLI config writer (saveConfig) delegates to this snakeize
// direction so the read and write paths share one recurse-and-skip traversal;
// not a stable public API (see the declaration's JSDoc).
export { snakeizeKeys } from "./utils/camelizeKeys";
// The scalar half of that direction, for a seam that names ONE key to an
// operator: a schema error locates its field on the camelized shape, and the
// operator is reading the snake_case document (see the declaration's JSDoc).
export { snakeizeKey } from "./utils/camelizeKeys";
// The camelize/snakeize nesting-depth discipline. The invitation decode path
// normalizes transform.params through this bounded camelizeKeys chokepoint (the
// camelize pre-pass in config/invitation.ts), so a pathologically deep params is
// rejected at decode like it is on every other parse path; the CLI's
// invitation-vs-config reconcile (apps/cli/src/config.ts, withoutUndefinedDeep)
// keeps its own depth guard as a backstop for that independent recursive walk. See
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
  displayText,
  renderedDisplayCost,
  clipToRenderedCost,
  controlCharacterMarker,
  replaceControlCharactersForDisplay,
  trimPartialControlCharacterMarker,
  DISPLAY_TRUNCATION_MARKER,
  DEFAULT_MAX_DISPLAY_LENGTH,
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
} from "./utils/sanitizeForDisplay";
export type {
  Displayable,
  SanitizeForDisplayOptions,
} from "./utils/sanitizeForDisplay";
export {
  sanitizeErrorForDisplay,
  sanitizeErrorChainLinks,
  joinErrorCauseChain,
  redactPrivateKeyMaterial,
  redactAndSanitizeForDisplay,
  MAX_ERROR_CAUSE_DEPTH,
  CAUSE_DEPTH_ELISION_MARKER,
} from "./utils/sanitizeErrorForDisplay";
// The delimiting seam for a linkage-terms value named in an operator-facing
// diagnostic. Exported because the CLI's reconcile refusal and citation-drift
// warning and both consent surfaces name the same class of partner-chosen value
// in the same clause structure, and a second delimiting grammar there would be
// the independent re-implementation the shared-primitive rule exists to
// prevent.
export {
  quoteTermsValue,
  quoteTermsValueList,
  bareTermsValue,
  compatibilityMessage,
  ruleSetCitation,
} from "./config/compatibilityMessage";
export type { CompatibilityMessageFragment } from "./config/compatibilityMessage";
export { reconcileHostKeyFingerprints } from "./hostKeyReconciliation";
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
export * from "./config/outboundPayloadConsent";
export * from "./config/signing";
export * from "./signingIdentity";
export * from "./standardization";
export * from "./fuzzyComparisons";
// The one display model both acceptance surfaces render the inviter's proposed
// terms from -- the web consent screen and the CLI accept prompt -- so the
// judgment of what an acceptor is consenting to, and the escaping of every
// partner-controlled string in it, is made once rather than per surface.
export {
  summarizeInvitation,
  TRANSFORM_FUNCTION_GLOSSARY,
} from "./invitationSummary.js";
export type {
  InvitationFieldSummary,
  InvitationKeyElementSummary,
  InvitationKeySummary,
  InvitationLegalAgreementSummary,
  InvitationPayloadSummary,
  InvitationRuleSetIdentitySummary,
  InvitationRuleSetSummary,
  InvitationSummary,
  InvitationTransformSummary,
} from "./invitationSummary.js";
// The classification and caveat copy that go with that display model: whether a
// fact the acceptance surfaces state is enforced by the exchange or rests on the
// partner's word, and the fixed sentences both surfaces render for it.
export {
  CONSENT_BASIS_MARKERS,
  CONSENT_FACTS,
  COUNT_ONLY_DISCLOSURE_STATEMENT,
  DEDUPLICATE_ACCEPTOR_SIDE_NOTE,
  DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT,
  DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT,
  LINKAGE_RULE_SET_VERDICT_COPY,
  OUTBOUND_SEND_NO_PAYLOAD_SENTENCE,
  PROPOSED_NOT_APPLIED_NOTES,
  RECORDED_LINKAGE_RULE_SET_CAVEAT,
  UNRECOGNIZED_TRANSFORM_NOTE,
  distinctLinkageRuleSetVerdicts,
  linkageRuleSetVerdictNote,
} from "./consentFacts.js";
export type {
  ConsentFact,
  ConsentFactBasis,
  ConsentFactId,
  LinkageRuleSetVerdictReader,
} from "./consentFacts.js";
// The count every acceptance surface paints a partner-declared name list under,
// and the sentence a bounded list closes on: one cut and one wording across the
// CLI accept prompt and the two web surfaces.
export {
  MAX_DECLARED_NAMES_SHOWN,
  unshownDeclaredNamesLine,
} from "./declaredNameBound.js";
// Which proposed settings today's exchange actually applies. Read by the summary
// above (to flag a proposed-but-not-applied term) and by the web app's linkage-
// terms editor and import path.
export { APPLIED_SETTINGS } from "./appliedSettings.js";
export {
  loadCSVFile,
  loadCSVColumnSample,
  streamCSVRows,
  readRowColumn,
  CSV_LINE_BYTE_CEILING,
  CsvLineByteCeilingError,
  CsvRowParseError,
} from "./file";
export type { CSVRow } from "./file";
export {
  inferDateInputFormatFromSource,
  inferDateOfBirthColumn,
} from "./inferDateInputFormat";
export type { InferredDateInputFormat } from "./inferDateInputFormat";

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
export * from "./pairTableProjection";
export * from "./exchangeRecord";
export * from "./partyIdentityDisplay";
export * from "./signedReceipt";
export * from "./recordVerification";
export * from "./signedReceiptVerification";
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
