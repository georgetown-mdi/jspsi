// The supported entry point of @psilink/core: the names a consumer of the
// published package may import from "@psilink/core". They are listed one at a
// time rather than re-exported by module, so publishing a name is a decision
// made here rather than a side effect of exporting it somewhere under src/.
//
// A name belongs here when production code outside packages/core calls it, or
// when a comment beside it states why the package publishes it anyway.
// Anything else stays module-internal, and product code exposed only so a test
// outside packages/core can drive it goes on the ./testing subpath
// (src/testing.ts). Which channel shared test material takes: docs/TESTING.md,
// Shared test material.

export {
  DirectoryListingBoundsError,
  FrameSizeExceededError,
  InternalConsistencyError,
  LinkageTermsUnsatisfiableError,
  OperatorConfigError,
  OutboundDisclosureRefusalError,
  PeerAbortError,
  StandardizationTermsError,
  TransportOperationStalledError,
  TransportPublishIndeterminateError,
  UnknownStandardizationFunctionError,
  UsageError,
  causeChainSome,
  chainDetailCauses,
  isPeerWaitTimeout,
} from "./errors";
export { PSIParticipant, ProcessState } from "./psi/participant";
export { loadPsiBackend } from "./psi/psiBackend";
export type { PsiBackendOptions, PsiBackendSelection } from "./psi/psiBackend";
export { InProcessPsiEngine } from "./psi/psiEngine";
export type { PsiEngine, PsiEngineMode } from "./psi/psiEngine";
export { WorkerPsiEngine, servePsiWorker } from "./psi/psiWorkerEngine";
export type {
  PsiWorkerHandle,
  PsiWorkerInit,
  PsiWorkerRequest,
  PsiWorkerResponse,
} from "./psi/psiWorkerEngine";
export { linkViaSinglePassPSI } from "./psi/link";

export { AlgorithmSchema, SEMANTIC_TYPES } from "./types";
export type {
  Algorithm,
  AssociationTable,
  HandshakeRole,
  SemanticType,
} from "./types";
export {
  DEFAULT_PEER_TIMEOUT_MS,
  DEFAULT_POLLING_FREQUENCY_MS,
  FileSyncConnection,
  normalizeFiledropPath,
} from "./connection/fileSyncConnection";
export type {
  FileInfo,
  FileTransportClient,
  GetOptions,
  PresentedHostKey,
  PutOptions,
  PutSource,
} from "./connection/fileSyncConnection";
// The filename grammar module is not barrelled (see its header); this one
// recognizer is named individually because a FileTransportClient implementation
// outside this package needs it -- the CLI's SFTP adapter decides from it
// whether a path handed to safeDelete is the protocol's own in-flight temp
// write.
export { isProtocolTempName } from "./connection/fileSyncNames";
export {
  ConnectionError,
  QueuedMessageConnection,
  asConnectionError,
  errorMessage,
  fromEventConnection,
} from "./connection/messageConnection";
export type {
  ConnectionErrorKind,
  MessageConnection,
} from "./connection/messageConnection";
export { EncryptedMessageConnection } from "./connection/encryptedMessageConnection";
// The transport-agnostic half of the WebRTC data-channel inbound bound. Barrelled
// because the enforcement point is per-transport and lives outside this package
// (the web app's PeerJS reassembly wrapper), while the constants and the
// structural pre-scan they parameterize must stay one implementation.
export {
  MAX_CHUNKS_PER_REASSEMBLY,
  MAX_CONCURRENT_REASSEMBLIES,
  MAX_WEBRTC_FRAME_BYTES,
  MAX_WEBRTC_FRAME_STRUCTURE_BYTES,
  MAX_WEBRTC_REASSEMBLY_DEPTH,
  MAX_WEBRTC_STRING_BYTES,
  MIN_CHUNK_RESIDENT_BYTES,
  describeFrameStructureRefusal,
  scanFrameStructure,
} from "./connection/binaryPackBounds";
export type { FrameStructureRefusal } from "./connection/binaryPackBounds";
export {
  getLogger,
  getLoggerForVerbosity,
  setLogLevel,
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
// The scalar half of that direction, for a call site that names ONE key to
// an operator: a schema error locates its field on the camelized shape, and
// the operator is reading the snake_case document (see the declaration's
// JSDoc).
export { snakeizeKey } from "./utils/camelizeKeys";
// The camelize/snakeize nesting-depth discipline. The invitation decode path
// normalizes transform.params through this bounded camelizeKeys chokepoint
// (the camelize pre-pass in config/invitation.ts), so a pathologically deep
// params is rejected at decode like it is on every other parse path; the CLI's
// invitation-vs-config reconcile (apps/cli/src/config.ts,
// withoutUndefinedDeep) keeps its own depth guard as a safety check for that
// independent recursive walk. See docs/spec/CHANNEL_SECURITY.md.
export {
  MAX_NESTING_DEPTH,
  NestingDepthExceededError,
} from "./utils/camelizeKeys";
export {
  canonicalString,
  canonicalBytes,
  CanonicalEncodingError,
} from "./utils/canonical";
export type { CanonicalValue } from "./utils/canonical";
export {
  sanitizeForDisplay,
  displayText,
  renderedDisplayCost,
  clipToRenderedCost,
  replaceControlCharactersForDisplay,
  trimPartialControlCharacterMarker,
  DISPLAY_TRUNCATION_MARKER,
  DEFAULT_MAX_DISPLAY_LENGTH,
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
} from "./utils/sanitizeForDisplay";
export type { Displayable } from "./utils/sanitizeForDisplay";
export {
  sanitizeErrorForDisplay,
  sanitizeErrorChainLinks,
  joinErrorCauseChain,
  redactPrivateKeyMaterial,
  redactAndSanitizeForDisplay,
  createPrivateKeyStreamRedactor,
  MAX_ERROR_CAUSE_DEPTH,
} from "./utils/sanitizeErrorForDisplay";
export type { PrivateKeyStreamRedactor } from "./utils/sanitizeErrorForDisplay";
// The delimiting grammar for a linkage-terms value named in an operator-facing
// diagnostic. Exported because the CLI's reconcile refusal and citation-drift
// warning and both consent surfaces name the same class of partner-chosen
// value in the same clause structure, and a second delimiting grammar there
// would be the independent re-implementation the shared-primitive rule exists
// to prevent.
export {
  quoteTermsValue,
  quoteTermsValueList,
  bareTermsValue,
  compatibilityMessage,
  ruleSetCitation,
} from "./config/compatibilityMessage";
export type { CompatibilityMessageFragment } from "./config/compatibilityMessage";
export { describeDecodeError } from "./utils/describeDecodeError";

export { StandardizationSchema } from "./config/standardizationSchema";
export type {
  Standardization,
  StandardizationStep,
} from "./config/standardizationSchema";
export {
  CONNECTION_PER_POLL_SHORT_INTERVAL_WARN_MS,
  ConnectionConfigSchema,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_SERVER_CONNECT_TIMEOUT_MS,
  HOST_KEY_FINGERPRINT_REGEX,
  LOW_POLLING_FREQUENCY_WARN_MS,
  MAX_RECONNECT_ATTEMPTS,
  MAX_TIMEOUT_SECONDS,
  MAX_TOKEN_MAX_AGE_DAYS,
  SHARED_SECRET_REGEX,
  generateSharedSecret,
  safeParseConnectionConfig,
  safeParseFileSyncOptions,
  withRetainModeImplications,
} from "./config/connection";
export type {
  Authentication,
  ConnectionConfig,
  FileDropConnectionConfig,
  FileSyncOptions,
  HttpAuth,
  SFTPConnectionConfig,
  WebRTCConnectionConfig,
} from "./config/connection";
export {
  DEFAULT_LINKAGE_KEY_SET_NAME,
  DEFAULT_LINKAGE_RULE_SET,
  OPT_IN_LINKAGE_FIELD_TYPES,
  authoredLinkageFields,
  encodeForComparison,
  getDefaultLinkageTerms,
  isDrawnFromLinkageRuleSet,
  isOptInLinkageKey,
  linkageRuleSetReferenceFor,
  optInLinkageKeys,
} from "./defaults/builtInLinkageTerms";
export type {
  BuiltInLinkageRuleSet,
  LinkageRuleSetCitationVerdict,
} from "./defaults/builtInLinkageTerms";
export { getDefaultStandardization } from "./defaults/builtInStandardization";
export {
  ExchangeSpecSchema,
  parseExchangeSpec,
  safeParseExchangeSpec,
} from "./config/exchangeSpec";
export type { ExchangeSpec } from "./config/exchangeSpec";
export {
  DEDUPLICATE_IMPLEMENTED_BY_STRATEGY,
  assertDeduplicateImplemented,
  countOnlyShapeViolation,
  swapPairTransformsDiffer,
} from "./linkageTermsPolicy";
export {
  LinkageStrategySchema,
  LinkageTermsSchema,
  MAX_NAME_LENGTH,
  MAX_PAYLOAD_ENTRIES,
  MAX_TEXT_LENGTH,
  MAX_TRANSFORM_PATTERN_LENGTH,
  TEXT_CONTROL_CHAR_MESSAGE,
  TEXT_CONTROL_CHAR_PATTERN,
  referencedLinkageFieldNames,
  safeParseLinkageTerms,
} from "./config/linkageTermsSchema";
export {
  deriveAcceptedLinkageTerms,
  validateCompatibility,
} from "./linkageTermsNegotiation";
export type { CountOnlyShapeViolation } from "./linkageTermsPolicy";
export type {
  LinkageField,
  LinkageKey,
  LinkageKeyElement,
  LinkageRuleSetReference,
  LinkageSetIdentity,
  LinkageStrategy,
  LinkageTerms,
  Output,
  Payload,
  TransformStep,
} from "./config/linkageTermsSchema";
export {
  INVITATION_LIFETIME_SECONDS,
  MAX_INVITATION_LIFETIME_SECONDS,
  decodeInvitation,
  encodeInvitation,
  endpointRequiresRetainedFiles,
  hasExpiryInstantPassed,
  isInvitationExpired,
  stripInvitationWhitespace,
} from "./config/invitation";
export type {
  ConnectionEndpoint,
  FileDropEndpoint,
  InvitationToken,
  SFTPEndpoint,
  WebRTCEndpoint,
} from "./config/invitation";
export {
  PLACEHOLDER_SFTP_HOST,
  PLACEHOLDER_SSH_USERNAME,
  endpointFromConnection,
} from "./config/endpointProducer";
export type { EndpointSourceConnectionConfig } from "./config/endpointProducer";
export {
  assembleExchangeSpec,
  connectionFromLocator,
  mintExchangeFile,
} from "./config/exchangeFile";
export type {
  ExchangeFileConnection,
  ExchangeFileInput,
  ExchangeLocator,
  WebRTCExchangeLocator,
} from "./config/exchangeFile";
export {
  MetadataSchema,
  OwnColumnSelectionSchema,
  assertCountOnlyTransmitsNoColumn,
  countOnlyTransmitsColumn,
  disclosedColumnNames,
  inferMetadata,
  isDisclosedToPartner,
  overlongDisclosedColumnPositions,
  ownResultColumnNames,
  safeParseMetadata,
} from "./config/metadata";
export type {
  ColumnMetadata,
  Metadata,
  OwnColumnSelection,
} from "./config/metadata";
export type { OutboundPayloadConsent } from "./config/outboundPayloadConsent";
export { FINGERPRINT_REGEX } from "./config/signing";
export type { SigningConfig } from "./config/signing";
export {
  SIGNING_CERTIFICATE_VERSION,
  SIGNING_IDENTITY_VERSION,
  certificateAuthorizesIdentity,
  computeCertificateFingerprint,
  generateSigningIdentity,
  parseCertificate,
  parseSigningIdentity,
  serializeCertificate,
  serializeSigningIdentity,
  verifyCertificateSelfSignature,
} from "./records/signingIdentity";
export type {
  CertificateBody,
  P256PrivateJwk,
  SigningCertificate,
  SigningIdentity,
} from "./records/signingIdentity";
export {
  FAN_OUT_FUNCTION_NAMES,
  STANDARDIZATION_FUNCTION_DESCRIPTORS,
  STANDARDIZATION_FUNCTION_NAMES,
  StandardizedDataset,
  StandardizedField,
  buildKeyStrings,
  buildStandardizedDataset,
  runPipeline,
} from "./standardization";
export {
  assertFanOutImplemented,
  assertStandardizationMatchesTerms,
  assertTransformsCompile,
  assessLinkageSatisfiability,
  coalesceSubstitutesConstant,
  decideLinkageTermsVerdict,
  pipelineAlwaysDrops,
  stepCanEmptyRealizedValue,
  summarizeLinkageShortfall,
  validateStandardizationAgainstTerms,
} from "./linkageSatisfiability";
export {
  checkValueConstraints,
  summarizeDatasetConstraintViolations,
} from "./valueConstraints";
export type {
  FieldValue,
  StandardizationFunctionDescriptor,
} from "./standardization";
export type {
  LinkageKeyFitness,
  LinkageTermsStanding,
  LinkageTermsVerdict,
} from "./linkageSatisfiability";

// The one display model both acceptance surfaces render the inviter's proposed
// terms from -- the web consent screen and the CLI accept prompt -- so the
// judgment of what an acceptor is consenting to, and the escaping of every
// partner-controlled string in it, is made once rather than per surface.
export {
  summarizeInvitation,
  TRANSFORM_FUNCTION_GLOSSARY,
} from "./consent/invitationSummary.js";
export type {
  InvitationKeySummary,
  InvitationRuleSetSummary,
  InvitationSummary,
} from "./consent/invitationSummary.js";
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
} from "./consent/consentFacts.js";
export type { ConsentFact, ConsentFactId } from "./consent/consentFacts.js";
// The count every acceptance surface paints a partner-declared name list under,
// and the sentence a bounded list closes on: one cut and one wording across the
// CLI accept prompt and the two web surfaces.
export {
  MAX_DECLARED_NAMES_SHOWN,
  unshownDeclaredNamesLine,
} from "./consent/declaredNameBound.js";
// Which proposed settings today's exchange actually applies. Read by the summary
// above (to flag a proposed-but-not-applied term) and by the web app's linkage-
// terms editor and import path.
export { APPLIED_SETTINGS } from "./consent/appliedSettings.js";
export {
  loadCSVFile,
  streamCSVRows,
  readRowColumn,
  CsvLineByteCeilingError,
  CsvRowParseError,
} from "./file";
export type { CSVRow } from "./file";
export {
  inferDateInputFormatFromSource,
  inferDateOfBirthColumn,
} from "./inferDateInputFormat";

export {
  inferDateFormat,
  columnValues,
  INFER_DATE_SCAN_CAP,
} from "./utils/date.js";
export {
  computeHostKeyFingerprint,
  keyTypeFromBlob,
} from "./utils/sshHostKey.js";
export {
  CONFIRMING_PROTOCOL_STAGE_ID,
  InvitationTermDivergenceError,
  assertAlgorithmImplemented,
  assertLocalCertificateAuthorizesAgreedIdentity,
  assertSigningModeImplemented,
  countIsPartnerReported,
  describeExchangeStages,
  exchangeRecordFromFailure,
  exchangeRecordOwedButUnbuilt,
  matchedPairCount,
  prepareForExchange,
  resolveExchangeInputs,
  runExchange,
} from "./exchange";
export type {
  ExchangeBootstrapResult,
  ExchangeDataSpec,
  ExchangeResult,
  ExchangeStageDefinition,
  PreparedExchange,
  RunExchangeOptions,
} from "./exchange";
export { describeResolvedRunShape } from "./pairTableProjection";
export type { ResolvedRunShape } from "./pairTableProjection";
export {
  EXCHANGE_KEYS_VERSION,
  EXCHANGE_RECORD_OUTCOMES,
  EXCHANGE_RECORD_VERSION,
  buildExchangeRecord,
  computeTermsHash,
  parseExchangeRecord,
  parseVerificationKeys,
  serializeExchangeRecord,
  serializeVerificationKeys,
  verifyRecordCommitments,
} from "./records/exchangeRecord";
export type {
  BuiltExchangeRecord,
  CommitmentName,
  CommittedPayload,
  ExchangeRecord,
  ExchangeRecordInputs,
  ExchangeRecordOutcome,
  RecordLinkageRuleSet,
  VerificationKeys,
} from "./records/exchangeRecord";
export {
  UNNAMED_PARTY_LABEL,
  displayPartyIdentity,
  redactAndDisplayPartyIdentity,
} from "./records/partyIdentityDisplay";
export {
  ReceiptVerificationError,
  SIGNED_RECEIPT_VERSION,
  deriveReceiptBinder,
  parseDualSignedRecord,
  serializeDualSignedRecord,
  signReceiptContent,
  verifyReceiptSignature,
} from "./records/signedReceipt";
export type { DualSignedRecord, ReceiptContent } from "./records/signedReceipt";
export {
  deriveOurIdColumn,
  reconstructCommittedData,
  recordAlterationIsTheOnlyExplanation,
  recordedVersionMatches,
  reproductionMismatchCauses,
  toRetainedResult,
  verifyExchangeRecord,
} from "./records/recordVerification";
export type {
  CommitmentStatus,
  RecordVerificationReport,
  ResultSizeStatus,
  TermsHashStatus,
} from "./records/recordVerification";
export {
  anchorsPhrase,
  decideSignedReceiptVerdict,
  signedRecordExpectations,
  verifyDualSignedRecord,
} from "./records/signedReceiptVerification";
export type {
  AnchoredCertificateSlot,
  AnchoredCertificateStatus,
  AssertedIdentityStatus,
  CertificateBindingStatus,
  DualSignedRecordVerificationInputs,
  DualSignedRecordVerificationReport,
  LocalIdentityAnchor,
  LocalIdentitySource,
  ReceiptSignatureStatus,
  RunBindingStatus,
  SignedReceiptPartyReport,
  SignedReceiptVerdictAnchor,
  SignedReceiptVerdictCheck,
  SignedReceiptVerdictGuidance,
  SignedReceiptVerdictHeadline,
  SignedReceiptVerdictParty,
  SignedReceiptVerdictRunBinding,
  SignedRecordExpectationSources,
  UnanchoredCertificateClause,
} from "./records/signedReceiptVerification";
export {
  assertDisclosedNamesCarriable,
  assertPayloadSendDisclosed,
  assessOutboundPayloadConsent,
  buildOutputTable,
  deriveOutboundPayloadConsent,
  outboundPayloadConsentRefusal,
  preparePayload,
  reconcileReceivedPayload,
  toCommittedPayload,
} from "./payloadExchange";
export type {
  OutboundPayloadConsentConfirmationRequired,
  PartnerPayload,
} from "./payloadExchange";
export {
  authenticateConnection,
  assertSharedSecretReadyForHandshake,
  deriveAbortToken,
} from "./auth";
export type { AuthResult } from "./auth";
export { runKex } from "./kex";
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
