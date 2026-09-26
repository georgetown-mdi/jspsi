import {
  FileSyncConnection,
  fromEventConnection,
  EncryptedMessageConnection,
  DEFAULT_PEER_TIMEOUT_MS,
  getLogger,
  describeExchangeStages,
  runExchange,
  SINGLE_PASS_STAGE_IDS,
  exchangeRecordFromFailure,
  exchangeRecordOwedButUnbuilt,
  countIsPartnerReported,
  buildOutputTable,
  resultCsvDelimiter,
  describeEntityClusters,
  describeResolvedMatching,
  describeResolvedRunShape,
  authenticateConnection,
  assertFirstRoundFitsWebRtcFrame,
  assertSharedSecretReadyForHandshake,
  ConnectionError,
  deriveAbortToken,
  OperatorConfigError,
  PeerAbortError,
  ReceiptVerificationError,
  causeChainSome,
  isPeerWaitTimeout,
  keepOperatorSuppliedText,
  messageWithOperatorText,
  operatorSuppliedText,
  redactAndDisplayPartyIdentity,
  redactAndRenderOperatorSuppliedText,
  redactAndSanitizeForDisplay,
  sanitizeErrorForDisplay,
  UsageError,
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
} from "@alcove/core";
import type {
  Authentication,
  ConnectionConfig,
  HandshakeRole,
  MessageConnection,
  PreparedExchange,
  ExchangeBootstrapResult,
  ExchangeStageDefinition,
  RelayCredential,
  SigningIdentity,
  WebRTCConnectionConfig,
} from "@alcove/core";

import { LocalFSClient } from "./connection/localFSClient";
import { assertFileSyncFirstRoundFits } from "./fileSyncFirstRound";
import { SSH2SFTPClientAdapter } from "./connection/ssh2SftpAdapter";
import { dialedBrokerAuthority } from "./connection/webrtc/brokerClient";
import { describeIceTransportPolicy } from "./connection/webrtc/iceDiagnostics";
import { openWebRtcMessageConnection } from "./connection/webrtc/webrtcMessageConnection";
import {
  brokerLocationFromConnection,
  iceServersFromConnection,
  relayCredentialForRun,
  relayCredentialNotice,
  relayCredentialRenewal,
} from "./connection/webrtc/weriftPeer";
import { persistPartnerFingerprint } from "./config";
import {
  buildRotatedKeyFile,
  clearRotationInFlight,
  markRotationInFlight,
  saveKeyFile,
} from "./keyFile";
import { preflightKeyFilePath } from "./keyFilePreflight";
import { loadCliPsiBackend } from "./psiBackend";
import {
  createPsiProgressDisplay,
  terminalPsiStatusLine,
  type PsiProgressDisplay,
} from "./psiProgressDisplay";
import { createPsiEngine } from "./psiWorkerHost";
import { writeExchangeRecord, type RecordOutput } from "./recordFile";
import { writeDualSignedRecord, type ReceiptOutput } from "./receiptFile";
import {
  closeWithinCeiling,
  teardownCeilingNotice,
  transportTeardownCeilingMs,
  type TeardownOutcome,
} from "./transportTeardown";
import { writeOutput } from "./util/dataIo";
import { AUTHENTICATION_FAILED_EXIT_CODE } from "./util/exit";
import { noteSignalOwnsExit } from "./util/exitGate";
import { runBeforeEachLogLine } from "./util/logging";
import { logRuntimeEnv } from "./util/runtimeEnv";
import {
  PERSISTENCE_LOSS_EXIT_CODE,
  openEventStream,
  reportPersistenceLoss,
  type ErrorPhase,
  type EventStreamEmitter,
} from "./eventStream";

import type { WebRtcMessageConnectionOptions } from "./connection/webrtc/webrtcMessageConnection";
import type { WebRtcPeerOptions } from "./connection/webrtc/weriftPeer";

/**
 * Operator guidance appended to the file-sync peer-silence timeout error, used
 * when no valid cross-party abort marker (`<id>-abort.json`, armed below
 * post-handshake) is present to upgrade the failure to a definitive
 * {@link PeerAbortError}. The marker holds no cause and cannot exist for a
 * peer whose exchange directory has gone unwritable (the same condition that
 * stops it writing the marker) or that was hard-killed, so this text states
 * the likely receiver-side causes without naming one as certain, and hedges
 * ("may have") to cover the slow-peer case too. See docs/spec/FILE_SYNC.md
 * ("Sender-side peer-silence attribution").
 */
export const PEER_SILENCE_GUIDANCE =
  "The peer completed the rendezvous but has sent nothing since. The likely " +
  "cause is on the peer's side: its process may have exited, or its exchange " +
  "directory may have become unwritable (for example a read-only or full " +
  "filesystem, or revoked permissions) -- and a peer that cannot write its " +
  "next message also cannot record why, so this side cannot name the cause. " +
  "Check the peer's own logs for the underlying error. If the peer is instead " +
  "still working on a large dataset, raise the peer timeout (--peer-timeout).";

/**
 * Operator guidance replacing {@link PEER_SILENCE_GUIDANCE} when the peer hello
 * this run rendezvoused against was already in the folder at entry and nothing
 * has confirmed a live peer behind it since (`unconfirmedEntryPeerHello`).
 *
 * An entry-present hello is byte-identical whether a partner wrote it or an
 * interrupted run in this same folder left it behind, so this text does not
 * accuse the peer's side; it hedges ("may be") and prescribes a re-run before
 * removal, since a partner that died mid-handshake leaves the same shape a
 * merely slow one clears on retry.
 *
 * Kept short, with the filename LAST: this line rides behind the core layer's
 * own peer-silence sentence inside one cause-chain link, and the rendered
 * boundary truncates each link, so every fixed character here is one the
 * filename does not get. The truncation budget is pinned by a test, not
 * asserted here.
 */
export const entryHelloResidueGuidance = (helloName: string): string =>
  "No peer was confirmed; the hello present at start may be residue. " +
  "Re-run; remove only if it persists: " +
  helloName;

/**
 * Operator guidance for a run that swept the shared folder at entry and then
 * timed out waiting for the partner.
 *
 * `--sweep-exchange-files` fires when both operators reach for it at once:
 * the second sweep deletes the first party's live rendezvous files, so each
 * side times out with no mention of sweeping in its own error. The text is
 * identical for both parties and prescribes the same action, so recovering
 * needs no contact between them; it hedges ("appear to have") since only the
 * party that swept first can confirm it, and the prescribed retry is correct
 * even if the timeout had an unrelated cause.
 *
 * Claiming the folder is empty is licensed only for a clean delete-mode
 * timeout: a sweep that could not delete every file, or a retain-mode run
 * that keeps every protocol file it wrote, does not reach this text -- see
 * the gate at the emission site. Operator-facing description:
 * docs/EXCHANGE_REFERENCE.md ("Directory exclusivity").
 */
export const BOTH_SWEPT_GUIDANCE =
  "Both sides appear to have cleared the folder at the same time, removing " +
  "each other's files. The folder should be empty now -- run the exchange " +
  "again on both sides, without --sweep-exchange-files.";

/**
 * Operator guidance for a run that configures a signing identity while record
 * writing is off (`--no-record`).
 *
 * The receipt is bound to its run by a binder the exchange record holds, so a
 * receipt with no record beside it verifies at most `INCOMPLETE` everywhere,
 * forever -- the salts and binder are minted during the exchange and stored
 * nowhere else, so this is only correctable before the run, which is why it
 * fires here rather than at the receipt write.
 *
 * Warns rather than refuses: a receipt kept for its signatures alone is a
 * legitimate use, so the text names both consequences and both ways out (keep
 * the record, or drop the signing block). See docs/CLI.md ("Signing without an
 * exchange record") and docs/spec/EXCHANGE_RECORD.md.
 */
export const SIGNING_WITHOUT_RECORD_WARNING =
  "A signing identity is configured but record writing is off (--no-record). " +
  "This run still writes its signed receipt, and that receipt can never " +
  "verify above INCOMPLETE on any verifier: pairing it to this run needs the " +
  "exchange record, and the record cannot be reconstructed after the " +
  "exchange. Keep the record (drop --no-record) if you retain receipts as " +
  "evidence, or drop the signing block if you do not.";

/**
 * What a run reports when it disclosed, terminated after that, and owed a
 * self-attested record its build could not produce.
 *
 * Pairs with the completed path's missing-artifact report so a disclosure
 * that occurred is never left with no record and no notice: core warns at
 * the build with the cause, but only on the operator log, which an
 * unattended run discards -- so the machine stream states the fact here too.
 *
 * Names no destination, since nothing reached a write. Not a persistence
 * loss: this run failed and keeps its own exit code rather than the one that
 * tells a supervisor not to re-run.
 */
export const TERMINATED_RECORD_UNBUILT_WARNING =
  "no audit record could be built for this exchange, so none was written; " +
  "the exchange had already disclosed when it failed, so that disclosure has " +
  "no local record";

/**
 * What the "terms agreed" line adds when the partner named nobody on a run that
 * files an exchange record.
 *
 * A record for a partner that supplied no `linkage_terms.identity` omits
 * `partnerIdentity` rather than inventing one, so it states every other
 * accounting element but not who the other party was -- an absence that is
 * treated as benign unless named here, at the point the operator can still
 * re-run with a named partner instead of finding the gap at audit time.
 *
 * One sentence, no advice about whether to proceed: an unnamed partner is
 * ordinary for a quick, unsigned run, and this fires only where a record is
 * being written. See docs/COMPLIANCE.md (HIPAA considerations).
 */
export const UNNAMED_PARTNER_ACCOUNTING_NOTE =
  "-- this exchange's record will hold no partner name, so an accounting of " +
  "disclosures drawn from it must take the recipient from your own records of " +
  "who this exchange was with.";

/**
 * What the operator is told when a run adopts the partner's certificate on a
 * first authenticated contact. It names the value pinned and the file it went
 * into, says plainly what that pin is authenticated by, and asks for the
 * out-of-band comparison that is the only thing which can strengthen it.
 *
 * The fingerprint is a digest this party derived from the presented
 * certificate, so no partner-authored text reaches the line through it.
 */
function partnerCertificatePinnedNotice(
  fingerprint: string,
  configPath: string,
): string {
  return (
    "Pinned the partner's signing certificate on this first contact: " +
    `fingerprint ${fingerprint}, recorded as signing.partner_fingerprint in ` +
    `${configPath}. This pin is authenticated by the channel the invitation ` +
    "secret travelled and nothing else, so compare the fingerprint with the " +
    "one your partner's 'alcove fingerprint' prints, over a channel you " +
    "trust. Every later exchange refuses a certificate that does not match it."
  );
}

/**
 * CLI-layer extension of {@link Authentication} that co-locates the path where
 * the rotated shared secret is persisted after each successful key exchange.
 * Passed to {@link runProtocol} on its own `auth` parameter, separate from the
 * connection config (the shared secret is a channel-agnostic partner-trust
 * concern, not embedded in the connection).
 *
 * `sharedSecret` is narrowed from optional in {@link Authentication} to required
 * here: every authenticated exchange must supply a valid token before the
 * connection is opened.
 */
export interface AuthPersist extends Authentication {
  sharedSecret: string;
  keyFilePath: string;
  /** Save the rotated secret with an exclusive create, refusing a key file
   * already at {@link keyFilePath}: the online `invite` and `accept` hold no
   * key file before the handshake, so one found there is not theirs. */
  saveKeyFileExclusively?: boolean;
}

/**
 * The signing inputs for the certificate-backed signed-receipt step, resolved by
 * the exchange command from the `signing` config block. Passed to
 * {@link runProtocol} on its own `signing` parameter; `null` (the default) skips
 * the signing step so the unsigned-record path is unaffected. The signing step
 * runs only on the authenticated path (the only one that holds a session key), so
 * a non-null value is meaningful only with a non-null `auth`.
 */
export interface SigningPersist {
  /** This party's long-lived signing identity (private key + certificate). */
  identity: SigningIdentity;
  /** The pinned partner certificate fingerprint (`signing.partner_fingerprint`);
   * absent means this run is a first authenticated contact, which adopts the
   * certificate the partner presents at the terms exchange and records its
   * fingerprint into {@link configPath}. */
  partnerFingerprint?: string;
  /** The configuration file this exchange was given, and the only file a
   * freshly adopted partner fingerprint is written into. */
  configPath: string;
  /** Where the dual-signed record is written (an explicit path, or `undefined`
   * for the default timestamped location). */
  receiptOutput: ReceiptOutput;
}

/**
 * The connection configs {@link runProtocol} can run. `Extract` names the
 * channels explicitly rather than aliasing {@link ConnectionConfig}, so a new
 * channel is rejected here until it is dispatched below (the allowlist
 * convention in CONTRIBUTING.md). Authentication is a separate `auth`
 * parameter, not part of this connection union.
 */
export type ProtocolConnectionConfig = Extract<
  ConnectionConfig,
  { channel: "sftp" | "filedrop" | "webrtc" }
>;

/**
 * The refusal a webrtc exchange gets when the run holds no shared secret.
 *
 * Both parties derive the signaling id they register under, and the one they
 * dial, from the shared secret, so with none there is no address and the
 * broker has nothing to pair the two sockets by. This is why the zero-setup
 * bootstrap -- whose assumption is that the parties share nothing beforehand
 * -- cannot run over this channel; the refusal names that rather than
 * reporting the channel itself as unsupported.
 */
export const WEBRTC_RENDEZVOUS_SECRET_REQUIRED =
  "the webrtc channel needs a shared secret: both parties derive the " +
  "signaling ids they meet at from it, so without one there is no address to " +
  "dial. Establish one with 'alcove invite' and 'alcove accept', then run " +
  "'alcove exchange'.";

/**
 * The refusal a webrtc connection with no `role` gets.
 *
 * The two parties register under complementary ids, so each has to know which
 * end it is; a config missing the field is a misconfiguration that would
 * otherwise show up as a rendezvous that never completes. `alcove invite` and
 * `alcove accept` stamp it, so a config missing it was hand-authored.
 */
export const WEBRTC_ROLE_REQUIRED =
  "this webrtc connection has no `role`: each party registers with the " +
  "signaling server under the id its own role derives, and dials the id the " +
  "other's does. Set `role: inviter` or `role: acceptor` on the connection " +
  "block.";

/** The webrtc rendezvous inputs, resolved before anything is dialed. */
interface WebRtcDial {
  /** The key-exchange role this party takes once the channel is open. */
  handshakeRole: HandshakeRole;
  options: WebRtcPeerOptions & WebRtcMessageConnectionOptions;
}

/**
 * Resolve a webrtc connection and this run's shared secret into the rendezvous
 * the transport is opened with. Every failure it can raise is locally knowable,
 * so it runs in {@link runProtocol}'s prepare block, before any socket is
 * opened.
 *
 * The rendezvous roles are asymmetric and so is the handshake: the acceptor
 * dials the data channel and sends the first key-exchange message, the inviter
 * listens and answers. A browser peer maps the two the same way
 * (`apps/web/src/psi/authenticateExchange.ts`), which is what lets a CLI peer
 * complete an exchange with one.
 *
 * @param runRelayCredential This run's minted TURN credential
 *   (`relayCredentialForRun`), for the TURN urls the connection's invitation
 *   relay names or its own `turn` entries that set no username or credential;
 *   unused when every selected TURN entry sets its own. When one is given, a
 *   fresh one is minted while the partner is absent
 *   (`relayCredentialRenewal`).
 * @throws {UsageError} when the run holds no shared secret, when the connection
 *   names no role, when the server block cannot be resolved to a broker, or
 *   when the connection sets `ice_provision` (via `iceServersFromConnection`).
 * @internal exported for testing
 */
export function webRtcDialFrom(
  connection: WebRTCConnectionConfig,
  sharedSecret: string | undefined,
  runRelayCredential?: RelayCredential,
): WebRtcDial {
  if (sharedSecret === undefined)
    throw new UsageError(WEBRTC_RENDEZVOUS_SECRET_REQUIRED);
  const { role } = connection;
  if (role === undefined) throw new UsageError(WEBRTC_ROLE_REQUIRED);
  // peer_timeout_ms is documented as the total wait for the partner, which on
  // this transport is three waits: the rendezvous, the channel opening, and the
  // parked receive after. It bounds all three, so it is the operator's one
  // reachable setting on each -- short to fail fast on an absent partner, long
  // for a negotiation that needs a relay before a candidate pair works.
  const peerTimeoutMs = connection.options?.peerTimeoutMs;
  return {
    handshakeRole: role === "acceptor" ? "initiator" : "responder",
    options: {
      location: brokerLocationFromConnection(connection.server),
      role,
      sharedSecret,
      iceServers: iceServersFromConnection(connection, runRelayCredential),
      ...(runRelayCredential !== undefined && {
        iceServerRenewal: relayCredentialRenewal(connection, sharedSecret),
      }),
      ...(connection.iceTransportPolicy !== undefined && {
        iceTransportPolicy: connection.iceTransportPolicy,
      }),
      ...(peerTimeoutMs !== undefined && {
        inactivityTimeoutMs: peerTimeoutMs,
        rendezvousTimeoutMs: peerTimeoutMs,
        channelOpenTimeoutMs: peerTimeoutMs,
      }),
    },
  };
}

/**
 * CLI-only, non-persistable runtime wiring for one invocation: the file-sync
 * transport's entry-sweep controls (threaded straight to the
 * {@link FileSyncConnection} constructor), the machine-interface stream, and
 * the caller's pre-terminal hook. The sweep controls are not part of
 * {@link ProtocolConnectionConfig} / FileSyncOptions / the Zod config schema,
 * since anything there is persistable to alcove.yaml. The CLI command layer
 * resolves these from argv and passes them here, separate from config
 * construction (applyConnectionOverrides).
 */
export interface FileSyncRuntimeOptions {
  /** `--sweep-exchange-files`: clear protocol files at entry (see FILE_SYNC.md). */
  sweepExchangeFiles?: boolean;
  /** `--force-retain-sweep`: permit the sweep to wipe a retain-mode transcript. */
  forceRetainSweep?: boolean;
  /**
   * `--event-stream`: emit the opt-in NDJSON machine-interface stream on fd 3
   * (see eventStream.ts and docs/spec/CLI_EVENTS.md). Unset (the default)
   * constructs no emitter, so the run is byte-identical to one without the
   * flag; `true` opens the stream here, before any exchange work, so the
   * fail-closed fd-3 preflight fires first. An already-open
   * {@link EventStreamEmitter} is a caller that opened the stream itself
   * (openEventStream ran its preflight), since it also reports its own
   * persistence losses on the one channel the terminal event travels on.
   */
  eventStream?: boolean | EventStreamEmitter;
  /**
   * The caller's own post-exchange persistence, run inside this frame once
   * the output stage has completed (result CSV and every audit artifact,
   * each loss already reported) and before the metrics and terminal events --
   * the placement lets it report what it loses on the same terminal event,
   * since the stream contract requires that event last
   * (docs/spec/CLI_EVENTS.md) and a supervisor keys off it.
   *
   * Invoked only on the fully-completed path: a failed exchange throws
   * before the output stage, and a signal-interrupted run returns without a
   * terminal event, so a hook that ran is proof the exchange succeeded and
   * must not be re-run. May be synchronous or async; it is awaited before
   * the terminal events are emitted.
   *
   * A failure from the hook is non-fatal, like {@link runProtocol}'s
   * `onAuthenticated`: the exchange already completed and cannot be undone by
   * a local write, so it is logged at error level and reported as a
   * persistence loss on both machine channels rather than shown as a clean
   * success.
   *
   * The hook states what became of its own writes on
   * {@link OutputCompleteResult}. A hook that catches its own failure and
   * reports it returns `persisted: false`, which is the only way that loss
   * reaches what the run afterwards tells the operator about its files: a
   * caught failure throws nothing for this frame to see.
   */
  onOutputComplete?: (
    context: OutputCompleteContext,
  ) => OutputCompleteResult | Promise<OutputCompleteResult>;
}

/** What a {@link FileSyncRuntimeOptions.onOutputComplete} hook reports back. */
export interface OutputCompleteResult {
  /**
   * Whether everything this hook owed disk reached it. A hook with nothing to
   * write for this run returns true; one that caught a write failure and
   * reported it as a persistence loss returns false, so the run no longer
   * claims every file it writes is on disk (`teardownCeilingNotice`).
   */
  persisted: boolean;
}

/** What {@link FileSyncRuntimeOptions.onOutputComplete} is handed. */
export interface OutputCompleteContext {
  /**
   * The received-payload column set this party observed from the partner
   * (`partnerPayload.columns`, partner's namespace), known as soon as the
   * exchange completes. Always an array; empty when the partner sent no
   * payload.
   *
   * A save-capable caller that learns its received set only by observation --
   * the online inviter, a zero-setup `--save` party -- stores this into the
   * persisted config's `expectedPayloadColumns` so a later recurring
   * `alcove exchange` fails closed on a divergent received payload
   * ({@link reconcileReceivedPayload}). Callers must persist an empty
   * observation as NOTHING, never as `[]`: a zero-match first exchange is
   * indistinguishable from "partner discloses nothing", and a strict empty
   * commitment would false-abort a later matching run. See
   * `observedReceivedColumnsForSave` in bootstrap.ts.
   *
   * The only route this observation takes out of {@link runProtocol} --
   * {@link RunProtocolResult} holds none of it.
   */
  observedReceivedPayloadColumns: string[];
  /**
   * The zero-setup `--save` bootstrap outcome, decided by the terms exchange
   * before this call, so the save itself runs inside this hook rather than
   * after {@link runProtocol} returns. Defined whenever a boolean
   * `saveIntent` was passed (including `false`, which holds the partner's
   * intent); `undefined` on every authenticated exchange, which runs no
   * bootstrap. Do not collapse a `false` saveIntent to `undefined` -- that
   * would silently suppress the no-save notices.
   *
   * The only route the bootstrap outcome takes out of {@link runProtocol} --
   * {@link RunProtocolResult} holds none of it -- so the established shared
   * secret reaches only the caller that provisions from it.
   */
  bootstrap?: ExchangeBootstrapResult;
}

/** The value {@link runProtocol} resolves with. */
export interface RunProtocolResult {
  /**
   * The error thrown or rejected by `onAuthenticated`, when the post-handshake
   * hook failed but the run otherwise resolved. The hook is non-fatal, so its
   * failure does not stop the exchange; this field reports it so the caller
   * can correct its own messaging (e.g. the online invite/accept callers
   * avoid claiming the config was saved when `saveConfig` actually failed).
   * Already logged at error level by {@link runProtocol}. `undefined` when no
   * hook was passed or it succeeded. A signal-interrupted run keeps whatever
   * value was already recorded. When the hook failed and the exchange then
   * also failed, `runProtocol` rejects with the exchange error and this
   * field is never observed.
   */
  onAuthenticatedError?: unknown;
}

/**
 * Per-stage wall-clock timing for the machine-interface stream. `open` marks the
 * START of a stage; a stage COMPLETES when the next one opens or when the
 * exchange finishes, at which point its duration is emitted as a stageEnd
 * event. Only completed stages are reported, so a stageEnd is always a whole
 * stage's time -- a run that aborts mid-stage emits none for the in-flight one.
 */
function createStageTimer(
  emit: (fn: (e: EventStreamEmitter) => void) => void,
): {
  open: (id: string) => void;
  close: () => void;
} {
  let current: { id: string; startedAt: number } | undefined;
  return {
    open: (id) => {
      current = { id, startedAt: Date.now() };
    },
    close: () => {
      if (current === undefined) return;
      const { id, startedAt } = current;
      // Clamp against a wall-clock adjustment so a duration is never negative.
      const durationMs = Math.max(0, Date.now() - startedAt);
      emit((e) => e.stageEnd(id, durationMs));
      current = undefined;
    },
  };
}

// The single-pass stages core does not enumerate, since which of them a party
// passes through follows the role the handshake resolves. Listed in the order
// either role passes them, so the `stages` event names every id a `stage`
// event can hold.
const SINGLE_PASS_STAGE_DEFINITIONS: ExchangeStageDefinition[] = [
  {
    id: SINGLE_PASS_STAGE_IDS.encryptingOwnData,
    label: "Encrypting my data",
  },
  {
    id: SINGLE_PASS_STAGE_IDS.encryptingPartnerData,
    label: "Doubly-encrypting partner's data",
  },
  {
    id: SINGLE_PASS_STAGE_IDS.identifyingSharedValues,
    label: "Identifying shared elements",
  },
];

// What linkViaSinglePassPSI passes to onStage as its last call: the end of the
// round rather than a stage, so the last stage's timing runs to the end of the
// exchange and no unlisted id reaches the stream. The web seat skips it too.
const SINGLE_PASS_END_MARKER = "done";

/**
 * The run's exchange stage: announce the PSI stages, then run the two-party
 * exchange over the negotiated transport, reporting each stage transition,
 * warning and confirmation as it arrives. Returns what the exchange produced,
 * which the output stage then writes.
 *
 * `onRunPhase` fires once the stage list is out and the exchange proper is
 * about to begin, so the caller can classify every failure from that point on
 * as a run fault rather than a preparation one.
 */
async function runExchangeStage(params: {
  build: PreparedTransport;
  run: RunLifecycle;
  mc: MessageConnection;
  role: HandshakeRole;
  prepared: PreparedExchange;
  psiLibrary: Awaited<ReturnType<typeof loadCliPsiBackend>>["library"];
  verbosity: number;
  saveIntent: boolean | undefined;
  signing: SigningPersist | null;
  recordOutput: RecordOutput | undefined;
  stageTimer: { open: (id: string) => void; close: () => void };
  psiProgress: PsiProgressDisplay;
  onRunPhase: () => void;
  log: ReturnType<typeof getLogger>;
  emit: (fn: (e: EventStreamEmitter) => void) => void;
}): Promise<ExchangeOutcome> {
  const {
    build,
    run,
    mc,
    role,
    prepared,
    psiLibrary,
    verbosity,
    saveIntent,
    signing,
    recordOutput,
    stageTimer,
    psiProgress,
    onRunPhase,
    log,
    emit,
  } = params;
  const stageDefinitions = [
    ...describeExchangeStages(prepared),
    ...(prepared.linkageTerms.linkageStrategy === "single-pass"
      ? SINGLE_PASS_STAGE_DEFINITIONS
      : []),
  ];
  const stageLabels = Object.fromEntries(
    stageDefinitions.map(({ id, label }) => [id, label]),
  );
  // Emit the full stage list once, before the first transition, mirroring the
  // web's onStages. The PSI exchange proper is about to begin, so any failure
  // from here on is a "run" fault (until output, marked below).
  emit((e) => e.stages(stageDefinitions));
  onRunPhase();
  return runExchange(
    // Encrypted path: `secure` is the AEAD decorator over mc (the
    // handshake negotiated applyEncryption), so PSI frames are encrypted
    // on the wire. Otherwise secure is undefined and the exchange runs
    // over the unencrypted mc (transport security only): the no-auth
    // zero-setup path (which runs the --save bootstrap), and the
    // authenticated path where applyEncryption negotiated false.
    run.secure ?? mc,
    role,
    prepared,
    {
      psiLibrary,
      // Run the PSI masking in a worker thread so a long round keeps the
      // event-loop-owning thread responsive for the SFTP heartbeat and the
      // liveness timers. Falls back to in-process when
      // the bundled worker is absent (dev / tests); see createPsiEngine.
      psiEngineFactory: (role, id, mode) =>
        createPsiEngine(psiLibrary, role, id, mode),
      verbosity,
      saveIntent,
      // Signed-receipt inputs, threaded only when a signing config was
      // passed (the exchange command resolves it from the `signing`
      // block). The step is gated inside runExchange on both the
      // identity and the session key being present; sessionKeyForReceipt
      // is set only on the authenticated path, and a signing config on
      // the no-auth path was already rejected above, so these three
      // travel together. Signing null leaves all three undefined and the
      // step skipped.
      signingIdentity: signing?.identity,
      partnerFingerprint: signing?.partnerFingerprint,
      sessionKey: signing !== null ? run.sessionKeyForReceipt : undefined,
      // Record the adopted pin into the configuration this exchange was
      // given, at the moment of adoption and before anything is disclosed, so
      // a run that pins and then fails mid-round does not re-pin blind on the
      // next attempt; a throw here stops the run rather than leaving the
      // operator believing the pin was saved. The fingerprint is a digest
      // this party derived, and still takes the display escape every other
      // value on these sinks takes.
      onPartnerCertificatePinned:
        signing === null
          ? undefined
          : (fingerprint: string) => {
              persistPartnerFingerprint(signing.configPath, fingerprint);
              const message = partnerCertificatePinnedNotice(
                fingerprint,
                signing.configPath,
              );
              log.warn(
                redactAndSanitizeForDisplay(message, {
                  maxLength: WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
                }),
              );
              emit((e) => e.warning("partnerCertificatePinned", message));
            },
      // Advertise the observed SFTP host key for cross-party
      // reconciliation only when the exchange runs over the
      // authenticated, AEAD-wrapped channel (`secure` set): the value is
      // unforgeable only because it rides that channel, so advertising
      // it on the unencrypted no-auth path -- where an active MITM could
      // rewrite it to suppress the divergence -- would defeat the check.
      // observedHostKey is itself undefined for a file-drop or the
      // no-pin path, and there is no file-sync connection at all on
      // webrtc, so this is also a no-op there.
      observedHostKey:
        run.secure !== undefined ? build.fileSync?.observedHostKey : undefined,
      // Each crypto operation's element count and duration, rendered as the
      // phase's live progress. Counts and durations only -- no value from
      // either party's data reaches the display.
      onPsiProgress: (progress) => psiProgress.report(progress),
      onStage: (id: string) => {
        if (id === SINGLE_PASS_END_MARKER) return;
        const label = stageLabels[id] ?? id;
        // The label derives from linkage-key names the partner may have
        // authored, so it goes through the display-boundary escape before
        // reaching the terminal, like this file's other stderr sites. The
        // emitter applies the same escape before the pair reaches fd 3.
        log.info(
          redactAndSanitizeForDisplay(
            label.charAt(0).toLowerCase() + label.slice(1),
          ),
        );
        // Close the previous stage's timing before entering this one, then
        // start the clock for the new stage. The emitter sanitizes the id.
        stageTimer.close();
        stageTimer.open(id);
        emit((e) => e.stage(id, label));
      },
      onWarning: (msg: string) => {
        // Terms-exchange warnings can embed partner-authored column
        // names, so the text goes through the display-boundary escape
        // here and inside the emitter alike. Redaction leads the escape:
        // escaping first can truncate a whole key block into a dangling
        // marker at the display cap, which the prefixer's pass then
        // fails closed on for the rest of the argument. A warning is a
        // COMPOSITION, so the cap is the composed-warning budget the
        // fd-3 event applies rather than the per-value default: both
        // sinks show the same text, and stderr must not show less of it
        // than the machine channel relays.
        log.warn(
          "terms exchange:",
          redactAndSanitizeForDisplay(msg, {
            maxLength: WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
          }),
        );
        emit((e) => e.warning("termsExchange", msg));
      },
      // A host-key divergence is a security signal, not a terms warning,
      // so it gets its own un-prefixed warn line; the message is
      // complete and display-safe (reconcileHostKeyFingerprints
      // sanitizes both parties' server-controlled values). It also rides
      // the machine-interface warning event: a supervisor that discards
      // stderr on success (an unattended CLI run under cron, say) must
      // still see the one control that catches a one-sided SFTP
      // interception. Non-fatal: the exchange still completes and the
      // operator disambiguates a rekey from an interception out-of-band.
      onHostKeyDivergence: (msg: string) => {
        log.warn(msg);
        emit((e) => e.warning("hostKeyDivergence", msg));
      },
      // A present-but-malformed partner host-key advertisement is
      // dropped by the fail-soft parse, so reconciliation is silently
      // skipped for it. Log that drop at debug -- low enough that a
      // benign version-skew does not warn on every exchange -- so an
      // operator can tell a non-conforming partner from one that simply
      // observed no host key (which logs nothing here). The dropped
      // value is not included: it is unusable and partner-controlled, so
      // echoing it into a log would be an injection risk.
      onPartnerHostKeyMalformed: () =>
        log.debug(
          "partner advertised a malformed SFTP host key in the terms " +
            "exchange; it was dropped per the fail-soft contract and " +
            "cross-party host-key reconciliation was skipped for it",
        ),
      onProtocolConfirmed: (partnerTerms, resolvedRole, runShape) => {
        // identity is partner-controlled free text with no consistency
        // check (a mutually-distrusting party sets it), so escape it
        // before it reaches the operator's terminal/logs. A partner that
        // supplied none is reported as unnamed rather than as an empty
        // line.
        //
        // On a run that files a record, that absence has a consequence
        // the marker alone does not: the record this exchange writes
        // will hold no partnerIdentity, so an accounting of disclosures
        // that cites it has to take the recipient from the operator's
        // own notes. Warn rather than inform for that one case, and
        // state the consequence in the same line. It also rides the
        // machine-interface warning event, for the same
        // unattended-supervisor reason as SIGNING_WITHOUT_RECORD_WARNING.
        const line = [
          "terms agreed, partner identity:",
          redactAndDisplayPartyIdentity(partnerTerms.identity),
        ] as const;
        if (recordOutput !== undefined && partnerTerms.identity === undefined) {
          log.warn(...line, UNNAMED_PARTNER_ACCOUNTING_NOTE);
          emit((e) =>
            e.warning("unnamedPartnerRecord", UNNAMED_PARTNER_ACCOUNTING_NOTE),
          );
        } else log.info(...line);
        log.info("role:", resolvedRole);
        // Each party's deduplicate value comes from its own document, so the
        // pair -- and the cardinality it resolves to -- exists only now. Stated
        // on the info line beside the role rather than on the warning channel
        // below: it is what every run proceeds on, not an exception to it.
        log.info(describeResolvedMatching(runShape));

        // What the agreed terms actually resolved to, named here because
        // nothing earlier states it: the consent surfaces show each
        // party's DECLARED deduplicate, and the cardinality the pair
        // resolves to -- which decides whose duplicates match and how
        // many rows the result holds -- is decided only now. Both
        // notices take the warning channel rather than the info line
        // beside the role, since the machine-interface warning event is
        // the only sink a supervisor that discards stderr (or a console
        // seat watching the run) reads at all. Composed by core so the
        // CLI and browser seats cannot drift; both strings are
        // first-party prose over integers core formats itself, so
        // neither includes partner-authored text in the sinks.
        const { cardinalityNotice, pairTableAdvisory } =
          describeResolvedRunShape(runShape);
        for (const [source, notice] of [
          ["resolvedCardinality", cardinalityNotice],
          ["pairTableAdvisory", pairTableAdvisory],
        ] as const) {
          if (notice === undefined) continue;
          log.warn(notice);
          emit((e) => e.warning(source, notice));
        }
      },
    },
  );
}

/**
 * The run's transport-open stage: dial the webrtc rendezvous, or open, sync and
 * start the file-sync connection, and report the handshake role the rendezvous
 * settled. Marks the lifecycle as it goes so the cleanup knows what to close.
 *
 * A signal arriving mid-open is checked for after every await: the handler's
 * cleanup found nothing to close at the time, so this closes what has since
 * opened and throws rather than exchanging over it.
 */
async function openRunTransport(params: {
  build: PreparedTransport;
  run: RunLifecycle;
  connection: ProtocolConnectionConfig;
  interrupted: AbortController;
  log: ReturnType<typeof getLogger>;
}): Promise<HandshakeRole> {
  const { build, run, connection, interrupted, log } = params;
  let role: HandshakeRole;
  if (connection.channel === "webrtc") {
    // Resolved by the prepare block for exactly this channel; the check is
    // what licenses treating the dial as present.
    if (build.webRtcDial === undefined)
      throw new Error("the webrtc rendezvous was not resolved");
    log.info(
      "rendezvousing through the signaling server at",
      // dialedBrokerAuthority (see its doc) is what the socket actually
      // dials, not the configured `host` text.
      //
      // The broker host is partner-controlled on an endpoint-seeded config, so
      // escape it before it reaches the operator's terminal, as the file-sync
      // locators below are. The rendezvous ids are NOT logged: they are derived
      // from the shared secret, and anything that reaches the terminal reaches
      // a --log-file too.
      redactAndSanitizeForDisplay(
        dialedBrokerAuthority(build.webRtcDial.options.location),
      ),
    );
    // Which candidate types the run gathers under, stated before the
    // rendezvous that uses them: nothing else the run reports tells a
    // relay-only exchange from a default one until one of them fails.
    log.info(
      describeIceTransportPolicy(build.webRtcDial.options.iceTransportPolicy),
    );
    // The rendezvous is this channel's open: it registers with the broker,
    // negotiates, and resolves only once the data channel is up. Its own
    // budgets bound it (rendezvous, channel-open), so a partner that never
    // arrives fails here rather than hanging. The interrupt signal ends it
    // early: the transport fails the negotiation and tears down the broker
    // socket and peer connection on an abort, so Ctrl-C during a
    // rendezvous does not wait out that budget. The post-dial guard below
    // still stands, for the window between the dial settling and the
    // transport being assigned.
    const dialed = await openWebRtcMessageConnection({
      ...build.webRtcDial.options,
      signal: interrupted.signal,
    });
    build.transport = dialed;
    run.opened = true;

    // A signal that arrived while the rendezvous was in flight already
    // ran doCleanup, which found no transport to close because there was
    // none yet. Close the one that has just opened and short-circuit, so
    // the channel and broker socket are not left standing -- the twin of
    // the post-open guard on the file-sync side.
    if (run.signalReceived !== undefined) {
      try {
        await dialed.close();
      } catch (err) {
        log.debug(
          "post-rendezvous signal close failed:",
          sanitizeErrorForDisplay(err),
        );
      }
      throw new Error(`interrupted by ${run.signalReceived} during rendezvous`);
    }
    // Fixed by the connection's role rather than negotiated at the transport:
    // the two parties already had to disagree about which end they are to find
    // each other at all, so the handshake inherits that instead of running a
    // second tiebreaker.
    role = build.webRtcDial.handshakeRole;
  } else {
    if (connection.channel === "filedrop") {
      log.info(
        "opening local path",
        // The filedrop path is partner-seeded on an offline-accept config (it
        // comes from the invitation's filedrop endpoint, charset-unconstrained),
        // so escape it before it reaches the operator's terminal -- the filedrop
        // twin of the SFTP host below. A split config has no single `path`; show
        // the inbound directory it reads the peer's files from instead.
        redactAndSanitizeForDisplay(
          connection.path ?? connection.inboundPath ?? "",
        ),
      );
    } else if (connection.channel === "sftp") {
      log.info(
        "opening connection to",
        // The SFTP host is partner-controlled on an offline-accept-seeded config
        // (it comes from the invitation endpoint, charset-unconstrained), so
        // escape it before it reaches the operator's terminal.
        redactAndSanitizeForDisplay(connection.server.host),
        "with options",
        connection.options,
      );
    }
    // The prepare block builds the connection and its bridge together on
    // every file-sync channel; the check is what licenses the rest of the
    // block treating them as present.
    if (build.fileSync === undefined || build.transport === undefined)
      throw new Error("the file-sync transport was not constructed");
    const fileSyncConn = build.fileSync;
    await fileSyncConn.open(connection);
    run.opened = true;

    // If a signal fired while `conn.open()` was awaiting, the signal
    // handler already ran doCleanup, including a conn.close() that
    // no-op'd because `connected` was still false at that moment. Now
    // that open() has resolved, close the freshly-opened connection
    // explicitly and short-circuit so the catch's signalReceived branch
    // resolves runProtocol cleanly -- otherwise the connection stays open
    // until process termination, harmless in production but a state leak
    // in tests that mock process.exit.
    if (run.signalReceived !== undefined) {
      try {
        await fileSyncConn.close();
      } catch (err) {
        log.debug(
          "post-open signal close failed:",
          sanitizeErrorForDisplay(err),
        );
      }
      throw new Error(
        `interrupted by ${run.signalReceived} during connection open`,
      );
    }

    log.info("synchronizing");
    await fileSyncConn.synchronize();

    // If a signal fired during the synchronize() round-trip, doCleanup
    // already ran (closing the connection and removing our hello/lock
    // files). Bail out before start() so the poller is not launched
    // against a closed transport -- otherwise conn.start() would
    // schedule polls that fail against the closed client, producing
    // spurious error logs while the signal handler is already exiting.
    // The corresponding check after open() handles the open/synchronize
    // window; this one handles synchronize/start.
    if (run.signalReceived !== undefined) {
      throw new Error(
        `interrupted by ${run.signalReceived} during synchronization`,
      );
    }

    const rendezvousRole = fileSyncConn.handshakeRole;
    // Invariant: synchronize() throws on all failure paths, so role is always
    // defined when synchronize() returns normally.
    if (rendezvousRole === undefined)
      throw new Error(
        "connection did not establish a handshake role after synchronization",
      );
    role = rendezvousRole;

    log.info("starting polling");
    // conn.start() must precede authenticateConnection: the key exchange
    // awaits mc.receive(), which is fed by the bridge's data listener; that
    // listener only sees inbound frames once the polling loop is running.
    fileSyncConn.start();
    run.started = true;
  }

  // Report the negotiated handshake role by what this party does next, not
  // as "arrived first/second": under lockless rendezvous (retain mode,
  // and so a split inbound/outbound directory) the role is a
  // deterministic lexicographic tiebreaker on the two hello filenames,
  // not wall-clock arrival order -- the party whose peer id sorts lower is
  // always the responder regardless of who connected first. Describing
  // send/wait behavior is accurate under both rendezvous modes and is the
  // operationally useful fact (which side acts next).
  if (role === "responder") {
    log.info("waiting for your partner's first message");
  } else {
    log.info("sending your partner the first message");
  }
  return role;
}

/** What {@link authenticateRun} states ahead of the key file it could not mark. */
const ROTATION_MARK_PREAMBLE =
  "the key exchange did not start because it could not be recorded in the " +
  "key file at ";

/** What {@link authenticateRun} states behind that key file and the failure. */
const ROTATION_MARK_REMEDY =
  " The shared secret is unchanged, though the key file may still record " +
  "this attempt; fix the key file's location or permissions and run the " +
  "exchange again.";

/**
 * Remove the rotation-in-flight marker after a key exchange that failed closed:
 * this side did not rotate (the partner may have, which the authentication
 * failure's confirm-first guidance covers), and the failure is what the
 * operator reads, so the next run
 * does not treat it as a rotation that stopped partway. A crash or a dropped
 * connection never reaches here and leaves the marker. A write failure is
 * logged rather than thrown, so it cannot replace the authentication failure.
 */
function clearRotationInFlightAfterFailedHandshake(
  keyFilePath: string,
  sharedSecret: string,
  log: ReturnType<typeof getLogger>,
): void {
  try {
    clearRotationInFlight(keyFilePath, sharedSecret);
  } catch (err) {
    log.warn(
      `the key file at ${redactAndRenderOperatorSuppliedText(
        operatorSuppliedText(keyFilePath),
      )} still records this key exchange as in flight, because removing ` +
        `that record failed: ${sanitizeErrorForDisplay(err)}`,
    );
  }
}

/** What {@link authenticateRun} states ahead of the key file it could not save. */
const ROTATED_TOKEN_SAVE_PREAMBLE =
  "authentication succeeded and the shared token was rotated, but the " +
  "updated token could not be saved to ";

/** What {@link authenticateRun} states behind that key file and the failure. */
const ROTATED_TOKEN_SAVE_REMEDY =
  " Your partner may already hold the rotated token. To recover, both " +
  "parties must re-invite to establish a new shared secret.";

/**
 * The run's authentication stage: run the key exchange, persist the rotated
 * token, fire the caller's post-handshake hook, wrap the transport in the
 * negotiated AEAD layer, and arm the cross-party abort marker. Runs only on the
 * authenticated path; the unauthenticated one has no acceptance step at all.
 *
 * The rotated-token save and the flag recording it are one synchronous step, so
 * a signal handler reading the lifecycle sees both the pre-save state or both
 * the post-save state, never one of each.
 */
async function authenticateRun(params: {
  build: PreparedTransport;
  run: RunLifecycle;
  mc: MessageConnection;
  auth: AuthPersist;
  connection: ProtocolConnectionConfig;
  role: HandshakeRole;
  onAuthenticated: (() => void | Promise<void>) | undefined;
  log: ReturnType<typeof getLogger>;
  eventStream: EventStreamEmitter | undefined;
}): Promise<void> {
  const {
    build,
    run,
    mc,
    auth,
    connection,
    role,
    onAuthenticated,
    log,
    eventStream,
  } = params;
  log.info("authenticating");
  // Discard the (possibly whitespace-padded) keyFilePath from auth;
  // saveKeyFile below uses trimmedKeyFilePath, which was captured and
  // trimmed during pre-flight without mutating the caller-supplied
  // auth object.
  const { keyFilePath: _ignored, saveKeyFileExclusively, ...authParams } = auth;
  // trimmedKeyFilePath is set whenever auth is set; they are populated
  // together in the pre-flight branch above.
  const keyFilePath = build.trimmedKeyFilePath!;
  // Before the key exchange can rotate anything: a run that stops between the
  // handshake and the rotated-key save leaves this marker for the next run to
  // report. A failed write stops the run here, with the secret unchanged.
  try {
    markRotationInFlight(keyFilePath, auth.sharedSecret, Date.now());
  } catch (err) {
    const message = messageWithOperatorText`${ROTATION_MARK_PREAMBLE}${operatorSuppliedText(
      keyFilePath,
    )}: ${err instanceof Error ? err.message : String(err)}${ROTATION_MARK_REMEDY}`;
    throw Object.assign(
      keepOperatorSuppliedText(new Error(message.text), message),
      { alcoveRecoveryHintEmitted: true },
    );
  }
  // Set synchronously before the await so a signal arriving during the
  // key-exchange round-trip or before saveKeyFile runs can distinguish the
  // "handshake may have completed on the partner side" case from the
  // "handshake never started" case.
  run.authStarted = true;
  // sessionKey (32 bytes, both parties derive the same value) keys the
  // per-direction AEAD encryption set up below, so every PSI frame
  // after this point is opaque on the wire to an SFTP/file-drop admin.
  // rotatedSecret is the new shared secret persisted to disk.
  // requestEncryption is what this party asks for; applyEncryption is
  // the negotiated OR both parties agree on, gating the
  // EncryptedMessageConnection wrap below.
  //
  // A file-sync channel asks for it unconditionally, since its
  // filesystem admin can read every frame. A webrtc data channel does
  // not: it is already end-to-end confidential under DTLS, so the wrap
  // would buy nothing, and a browser peer declines and refuses a
  // partner that asks. See docs/spec/CHANNEL_SECURITY.md.
  const requestEncryption = connection.channel !== "webrtc";
  const { rotatedSecret, sessionKey, applyEncryption } =
    await authenticateConnection(mc, authParams, role, requestEncryption).catch(
      (err: unknown) => {
        if (err instanceof ConnectionError && err.kind === "security")
          clearRotationInFlightAfterFailedHandshake(
            keyFilePath,
            auth.sharedSecret,
            log,
          );
        throw err;
      },
    );
  // Capture the session key for the signed-receipt step (it derives the replay
  // binder from it); only the authenticated path reaches here, so the no-auth
  // path leaves it undefined and runExchange's signing step stays skipped.
  run.sessionKeyForReceipt = sessionKey;
  // buildRotatedKeyFile stamps `expires` = now + tokenMaxAgeDays days
  // when the operator set a max-age policy, computed here at the
  // moment of rotation rather than at config-parse time. Built before
  // the try/catch below so its input-validation guard (a non-positive
  // or non-integer tokenMaxAgeDays, reachable only by a caller
  // bypassing the config schema) propagates as the UsageError it is
  // (exit 64) rather than being caught and re-wrapped as a
  // "could not be saved" failure (exit 77).
  const rotatedKeyFile = buildRotatedKeyFile(
    rotatedSecret,
    auth.tokenMaxAgeDays,
    Date.now(),
  );
  try {
    // saveKeyFile is synchronous; the assignment below runs in the same
    // microtask tick, so no signal can interleave between them. A
    // signal handler that reads tokenRotated sees either both pre-save
    // state (false) or both post-save state (true). Maintain this: do
    // not insert an await between saveKeyFile and the assignment.
    saveKeyFile(keyFilePath, rotatedKeyFile, {
      exclusive: saveKeyFileExclusively === true,
    });
    run.tokenRotated = true;
  } catch (err) {
    // "may already hold": both parties independently derive
    // rotatedSecret from the session key, but either party's disk
    // write can fail, and we cannot know whether the partner's save
    // succeeded, so "may" is intentionally conservative.
    //
    // The wrapped error already holds the full recovery hint specific
    // to this failure mode. Tag it with the same
    // `alcoveRecoveryHintEmitted` convention authenticateConnection
    // uses on its own validation errors (see auth.ts), so the
    // runProtocol catch below skips its generic authStarted advisory
    // and the user sees one coherent recovery message.
    //
    // It exits with the authentication code rather than 69: the parties'
    // secrets may now differ, so a retry fails the key exchange instead of
    // recovering.
    const message = messageWithOperatorText`${ROTATED_TOKEN_SAVE_PREAMBLE}${operatorSuppliedText(
      keyFilePath,
    )}: ${err instanceof Error ? err.message : String(err)}${ROTATED_TOKEN_SAVE_REMEDY}`;
    throw Object.assign(
      keepOperatorSuppliedText(new Error(message.text), message),
      {
        alcoveRecoveryHintEmitted: true,
        exitCode: AUTHENTICATION_FAILED_EXIT_CODE,
      },
    );
  }

  // The handshake has succeeded and the rotated token is now persisted
  // to the key file. Fire the optional post-handshake hook here --
  // exactly at acceptance, after the key save and before encryption
  // setup and the data exchange -- so a caller (online invite/accept)
  // can persist its configuration at this point. Runs only on the
  // authenticated path, exactly once, and is awaited.
  //
  // Unlike the other interruptible awaits, this one has no preceding
  // `signalReceived` guard: the gap since the last guarded await
  // (authenticateConnection) is synchronous, so no signal can have
  // arrived yet. A signal firing during an async hook lets that write
  // finish by design; the check after
  // EncryptedMessageConnection.create then bails before the exchange.
  //
  // A hook failure is non-fatal: logged at error level and the
  // exchange proceeds, since the data exchange must not be aborted by
  // a failure to persist recoverable config.
  if (onAuthenticated !== undefined) {
    try {
      await onAuthenticated();
    } catch (hookErr) {
      // The caller distinguishes a hook failure from success by the
      // presence of this value, so it must be truthy even when the hook
      // threw a falsy value (`undefined`, `null`, `0`, `""`, `false`,
      // `NaN`) -- `undefined` is the success sentinel, so coerce any
      // falsy throw to an Error: a failure can never masquerade as a
      // clean write.
      run.onAuthenticatedError = hookErr
        ? hookErr
        : new Error(
            "the post-authentication hook threw a falsy value: " +
              String(hookErr),
          );
      log.error(
        "the post-authentication hook failed after the handshake " +
          "succeeded and the rotated key was saved; the exchange will " +
          "continue, but any persistence the hook performs (e.g. writing " +
          "the configuration) did not complete: " +
          sanitizeErrorForDisplay(hookErr),
      );
      // A supervisor that discards stderr on a run that completes would
      // otherwise have nothing to tell it the setup is half
      // provisioned -- the exchange runs and its result is written, but
      // what the hook persists is not on disk. Reported on both machine
      // channels at the loss itself. The message holds the same hedge
      // as the line above rather than naming the caller's own artifact.
      reportPersistenceLoss(
        "the post-authentication persistence step (writing the " +
          "configuration) did not complete; the exchange continued and " +
          "the rotated key is saved",
        eventStream,
      );
    }
  }

  // Wrap mc in the AEAD decorator when the handshake negotiated it, and
  // run the PSI exchange through `secure` so every frame is encrypted
  // on the wire. Gated on applyEncryption -- the transcript-bound OR of
  // both parties' requests -- rather than bare authentication state:
  // file-sync requests it unconditionally, so behavior here is
  // unchanged today, while the gate readies the path for a future
  // caller on an already-confidential transport that declines the
  // extra layer.
  //
  // create() derives the two per-direction keys via HKDF and registers
  // no listeners on mc, so a signal arriving before it resolves needs
  // no listener juggling: doCleanup closes mc/conn directly, latches
  // cleaned, and leaves the decorator create() later assigns to
  // `secure` unclosed but harmless (mc is already closed, and the
  // decorator holds only CryptoKey objects). The signalReceived check
  // below mirrors the post-open and post-synchronize guards, bailing
  // before runExchange so the encrypted stream never starts against an
  // already-closed mc; it runs whether or not the wrap was applied,
  // since a signal may also have arrived during the onAuthenticated
  // hook above.
  if (applyEncryption) {
    run.secure = await EncryptedMessageConnection.create(mc, sessionKey, role);
  }
  if (run.signalReceived !== undefined) {
    throw new Error(
      `interrupted by ${run.signalReceived} during channel encryption setup`,
    );
  }

  // Arm the authenticated cross-party abort marker now that the session
  // key is in hand (the only path that holds one): derive this party's
  // token -- written into <myId>-abort.json on a terminal organic fault
  // so a waiting peer fails fast instead of waiting out its full
  // peer-timeout -- and the peer's, verified against an incoming
  // <peerId>-abort.json. Placed after the signal guard so an interrupt
  // during setup bails before arming.
  //
  // Armed unconditionally, including retain mode: the fast-fail
  // benefits a waiting peer either way, and the marker doubles as an
  // audit record. A retain-mode fault leaves the marker on disk (the
  // entry-time sweep is delete-mode only), but a retain fault already
  // leaves a non-clean directory, so this adds no incremental cleanup
  // burden.
  //
  // File-sync only, with no webrtc counterpart: the fast-fail it buys
  // is what a live channel already gives for free, since a dying party
  // drops the data channel and the peer learns of it from connection
  // state rather than an absence.
  if (build.fileSync !== undefined) {
    const peerRole = role === "initiator" ? "responder" : "initiator";
    const [selfAbortToken, peerAbortToken] = await Promise.all([
      deriveAbortToken(sessionKey, role),
      deriveAbortToken(sessionKey, peerRole),
    ]);
    build.fileSync.armAbort(selfAbortToken, peerAbortToken);
  }
}

/**
 * How far one run got: the flags its stages set as they advance, which the
 * cleanup and the error path both read to decide what to close, what to warn
 * about, and how to classify a failure. Held in one object so a stage that
 * sets a flag and the teardown that reads it are looking at the same value.
 */
interface RunLifecycle {
  /** The transport is open, so cleanup has a connection to close. */
  opened: boolean;
  /** The file-sync poller is running, so cleanup has polling to stop. */
  started: boolean;
  /**
   * The AEAD decorator over the transport, present only when the handshake
   * negotiated encryption. Its close() delegates to the transport's.
   */
  secure: EncryptedMessageConnection | undefined;
  /**
   * The session key from the authenticated key exchange, which the
   * signed-receipt step derives its replay binder from.
   */
  sessionKeyForReceipt: Uint8Array<ArrayBuffer> | undefined;
  /**
   * Set immediately before the key exchange is awaited. The partner may have
   * completed and persisted a rotated token even where this side did not, so
   * this is the weaker of the two rotation signals.
   */
  authStarted: boolean;
  /** Set only after this side's own rotated-token save succeeded. */
  tokenRotated: boolean;
  /**
   * Set once the two-party exchange returned, so a failure in the local
   * output stage that follows writes no cross-party abort marker.
   */
  exchangeComplete: boolean;
  /**
   * Set once the output stage returned with every local artifact a run owes --
   * the result file, the exchange record, the receipt, and whatever the
   * caller's own post-exchange step writes -- on disk. A run that entered the
   * stage and failed inside it, and one that lost an artifact non-fatally,
   * each wrote some or none of them, so nothing told to the operator about
   * what is on disk keys on the stage being reached.
   */
  outputsWritten: boolean;
  /**
   * Set synchronously at the top of a signal handler, before any await, so an
   * in-flight failure caused by signal-driven cleanup is told apart from an
   * organic one and the exit code is left to the handler.
   */
  signalReceived: NodeJS.Signals | undefined;
  /**
   * A failure from the optional post-handshake hook. Non-fatal, so it does not
   * stop the exchange; it is reported on the resolved result instead.
   */
  onAuthenticatedError: unknown;
}

/**
 * The run's cleanup stage: seal the abort decision, then close every transport
 * layer this run opened, innermost first. Each close is idempotent and its
 * failure is caught, so cleanup runs to completion whether the exchange
 * finished, failed, or was interrupted mid-open.
 *
 * Reads the {@link RunLifecycle} itself rather than a copy of its flags, so an
 * open that completes while an earlier layer's close is still being awaited
 * counts as opened for the layers below it.
 *
 * The three layer closes share one ceiling, `ceilingMs`: they are one
 * obligation, the transport's, and this is the channel-independent point at
 * which a finished run stops waiting on it (see
 * {@link transportTeardownCeilingMs}). Nothing local is inside it -- the
 * result, the record and the receipt are already on disk by the time cleanup
 * runs -- so reaching the ceiling costs the close, never an artifact.
 */
async function closeRunLayers(params: {
  build: PreparedTransport;
  run: RunLifecycle;
  log: ReturnType<typeof getLogger>;
  ceilingMs: number;
}): Promise<TeardownOutcome> {
  const { build, run, log, ceilingMs } = params;
  // Seal the abort decision before the first layer-close drives the real
  // conn.close() cascade (secure.close() -> mc.close() -> conn.close()):
  // on the clean-completion, signal, and echo paths no writeAbortMarker()
  // ran, so without this seal conn.close() would wait out its fallback
  // grace and block teardown for the full window. A catch-path
  // writeAbortMarker() (if it ran) already pre-empted this. Synchronous
  // and side-effect free, so hoisting it here is safe, and a no-op on the
  // unauthenticated path and on webrtc, neither of which has a marker.
  build.fileSync?.sealAbort();
  if (run.started) log.info("stopping polling");
  if (run.opened) log.info("closing connection");
  return closeWithinCeiling(ceilingMs, async () => {
    // When the AEAD decorator was built (encryption negotiated), close it:
    // its close() delegates to mc.close(), detaching the bridge's
    // data/error listeners and closing the underlying FileSyncConnection.
    // `secure` is undefined on the no-auth path, when applyEncryption was
    // negotiated false, and in the window where a signal arrived between
    // authenticateConnection returning and create resolving -- in each case
    // mc.close() below closes the transport directly. All idempotent.
    if (run.secure !== undefined) {
      await run.secure.close().catch((err: unknown) => {
        log.debug(
          "secure.close() during cleanup:",
          sanitizeErrorForDisplay(err),
        );
      });
    }
    // Closing the transport detaches the file-sync bridge's data/error
    // listeners and closes the underlying FileSyncConnection -- stopping
    // the poller, sweeping the responsible files, and ending the client --
    // or, on webrtc, flushes the outbound queue and tears the data channel,
    // peer connection and broker socket down. All idempotent, so this is
    // safe even when open() never ran. Undefined only when the webrtc
    // rendezvous never produced a connection.
    await build.transport?.close().catch((err: unknown) => {
      log.debug(
        "transport close during cleanup:",
        sanitizeErrorForDisplay(err),
      );
    });
    // If an earlier transport failure already terminated the bridge, its
    // close() returns immediately without re-closing fileSync (that earlier
    // close was fire-and-forget, hence unawaited). Close fileSync directly
    // to guarantee the poller is stopped, the responsible files are swept,
    // and the client is ended before doCleanup returns. Idempotent, so in
    // the normal path this is a near no-op after the bridge already closed
    // it.
    await build.fileSync?.close().catch((err: unknown) => {
      // When the connection was open, a close failure is user-visible: the
      // transport may not have terminated cleanly (e.g. SSH session timeout).
      // close() is idempotent and does not throw on an unopened instance, so
      // the else branch is only a defensive fallback for an unexpected error.
      if (run.opened) {
        log.warn(
          "failed to close connection during cleanup:",
          sanitizeErrorForDisplay(err),
        );
      } else {
        log.debug(
          "fileSync.close() during cleanup:",
          sanitizeErrorForDisplay(err),
        );
      }
    });
  });
}

/**
 * The end-of-run transport counters, one line each and only when non-zero: the
 * sessions lost and re-established mid-exchange, the dialing retries, and the
 * connection-per-poll boundaries where the session was released, forced closed,
 * held, or skipped. All are this party's own integers, never partner-controlled.
 */
function logTransportCounters(
  client: LocalFSClient | SSH2SFTPClientAdapter | undefined,
  log: ReturnType<typeof getLogger>,
): void {
  // The end-of-run summary at normal verbosity: --event-stream reports the
  // two counts only as one machine metric, and the SFTP adapter's per-drop
  // WARN flags each recovery burst, not the run. Two lines rather than one
  // total because a dial retried until it gave up never connected, and
  // reporting it as a re-establishment would read as a flaky link where the
  // server or directory was never reachable. Both are zero on a clean run.
  const midExchangeLosses = client?.midExchangeReconnectCount ?? 0;
  const connectRetries = client?.connectRetryCount ?? 0;
  if (midExchangeLosses > 0)
    log.info(
      `the connection was lost and re-established ${midExchangeLosses} ` +
        `time${midExchangeLosses === 1 ? "" : "s"} during this exchange`,
    );
  if (connectRetries > 0)
    log.info(
      `connecting was retried ${connectRetries} ` +
        `time${connectRetries === 1 ? "" : "s"} during this exchange ` +
        `(not a lost connection)`,
    );
  // Connection-per-poll's per-cycle outcomes, each its own line on its own
  // count: their inline WARNs are paced or absent, so this is the only
  // place the true totals are stated for an unattended run. Not folded
  // into the reconnect line above: that line counts SESSIONS LOST, these
  // count BOUNDARIES, and the two overlap without either containing the
  // other, so folding any of them in would double-count. See
  // docs/notes/connection-per-poll-sftp.md for the full boundary model.
  // All are 0 outside connection-per-poll, so the guards stay quiet.
  const heldBoundaries = client?.heldBoundaryCount ?? 0;
  const heldStretches = client?.heldBoundaryStretchCount ?? 0;
  const perCycleOutcomes: {
    count: number;
    line: (count: number) => string;
  }[] = [
    {
      count: client?.releasedBoundaryCount ?? 0,
      line: (count) =>
        `the connection-per-poll release closed the SFTP session at ` +
        `${count} idle ${count === 1 ? "boundary" : "boundaries"} during ` +
        `this exchange, each re-dialed at the start of the next poll cycle`,
    },
    {
      count: client?.forcedReleaseCount ?? 0,
      line: (count) =>
        `the connection did not close when released at ${count} idle ` +
        `${count === 1 ? "boundary" : "boundaries"} during this exchange, ` +
        `so it was closed from this side`,
    },
    {
      count: client?.declinedReleaseCount ?? 0,
      line: (count) =>
        `the connection-per-poll release did not close the session at ` +
        `${count} idle ${count === 1 ? "boundary" : "boundaries"} during ` +
        `this exchange (not a dropped session): another session transition ` +
        `on this connection did not complete within the release's wait, so ` +
        `the session stayed live across ` +
        `${count === 1 ? "that idle gap" : "those idle gaps"}`,
    },
    {
      count: client?.declinedCycleRedialCount ?? 0,
      line: (count) =>
        `the connection-per-poll re-dial skipped ${count} poll ` +
        `${count === 1 ? "cycle" : "cycles"} during this exchange (not a ` +
        `dropped session): another session transition on this connection ` +
        `did not complete within the re-dial's wait, so ` +
        `${count === 1 ? "that cycle" : "those cycles"} had no session`,
    },
    {
      // The stretch sub-count tells one operation holding twenty
      // boundaries apart from twenty operations each holding one -- a mode
      // that has stopped delivering per-cycle sessions vs. one that is
      // working -- so it is stated only when it says something the
      // boundary count does not.
      count: heldBoundaries,
      line: (count) => {
        const summary =
          `the connection-per-poll release held the SFTP session at ` +
          `${count} idle ${count === 1 ? "boundary" : "boundaries"} during ` +
          `this exchange (not a dropped session): an operation this side ` +
          `had issued was still unsettled, so the session stayed live ` +
          `across ${count === 1 ? "that idle gap" : "those idle gaps"}`;
        return heldStretches < count
          ? `${summary}, in ${heldStretches} unbroken ` +
              `${heldStretches === 1 ? "stretch" : "stretches"}`
          : summary;
      },
    },
  ];
  for (const { count, line } of perCycleOutcomes)
    if (count > 0) log.info(line(count));
}

/**
 * What the preparation stage builds: the transport pieces the run then opens
 * and exchanges over, plus the validated key-file path. Filled in place rather
 * than returned, so a throw partway through still leaves the caller holding
 * whatever was already constructed -- the terminal metrics event reads the
 * client's counters, which a failure after its construction must not lose.
 */
interface PreparedTransport {
  trimmedKeyFilePath?: string;
  webRtcDial?: WebRtcDial;
  client?: LocalFSClient | SSH2SFTPClientAdapter;
  fileSync?: FileSyncConnection;
  transport?: MessageConnection;
}

/**
 * The run's preparation stage: check the channel and the caller's contract,
 * confirm the shared secret and its key-file path, then construct the
 * transport for this channel. Everything here runs before the exchange's own
 * try block, so a throw is a "prepare"-phase fault and no connection has been
 * opened.
 */
async function prepareTransport(
  build: PreparedTransport,
  params: {
    connection: ProtocolConnectionConfig;
    prepared: PreparedExchange;
    auth: AuthPersist | null;
    saveIntent: boolean | undefined;
    onAuthenticated: (() => void | Promise<void>) | undefined;
    signing: SigningPersist | null;
    recordOutput: RecordOutput | undefined;
    verbosity: number;
    fileSyncRuntime: FileSyncRuntimeOptions;
    log: ReturnType<typeof getLogger>;
    emit: (fn: (e: EventStreamEmitter) => void) => void;
  },
): Promise<void> {
  const {
    connection,
    prepared,
    auth,
    saveIntent,
    onAuthenticated,
    signing,
    recordOutput,
    verbosity,
    fileSyncRuntime,
    log,
    emit,
  } = params;
  if (
    connection.channel !== "filedrop" &&
    connection.channel !== "sftp" &&
    connection.channel !== "webrtc"
  ) {
    // Only reachable via an unsafe cast past ProtocolConnectionConfig. The
    // `never` binding holds the other half at build time: it compiles only
    // while the dispatch below covers every channel the type admits.
    const unsupported: never = connection;
    throw new Error(
      `unsupported channel: ` +
        (unsupported as unknown as { channel: string }).channel,
    );
  }

  // saveIntent drives the zero-setup `--save` bootstrap, which exists only
  // on the unauthenticated path: an authenticated exchange has a
  // persistent key already and no provisioning step to consume a bootstrap
  // result, so a stray saveIntent here would advertise a save field inside
  // the authenticated channel with nothing reading it back. Reject the
  // combination rather than leave the mistake open to a future caller.
  if (auth && saveIntent !== undefined)
    throw new Error(
      "saveIntent is only valid on an unauthenticated (zero-setup) exchange; " +
        "an authenticated exchange must not pass it",
    );
  // The mirror constraint: onAuthenticated hooks the moment of acceptance,
  // which exists only on the authenticated path -- its invocation below is
  // nested in `if (auth)`. Reject a hook supplied with `auth: null` up
  // front, so a future caller wiring a hook to a zero-setup exchange gets
  // a clear error instead of a persistence step that never runs.
  if (!auth && onAuthenticated !== undefined)
    throw new Error(
      "onAuthenticated is only valid on an authenticated exchange; an " +
        "unauthenticated (zero-setup) exchange has no acceptance step to hook",
    );
  // The signed-receipt step binds the receipt to the session key, which
  // only the authenticated key exchange produces. Reject a signing config
  // on the unauthenticated (`auth: null`) path up front: there is no
  // session key to derive the replay binder from, so a caller that wired
  // it would get a receipt-less exchange with no signal why.
  if (!auth && signing !== null)
    throw new Error(
      "a signing identity is only valid on an authenticated exchange; an " +
        "unauthenticated (zero-setup) exchange has no session key to bind the " +
        "signed receipt to",
    );
  // Signing with records off produces a receipt no verifier can ever pair
  // to its run, and nothing after the exchange can repair it. Raise it here
  // -- before any credential, terms, or data are sent, while both choices
  // are still the operator's to change -- on both the machine-interface
  // warning event and stderr, since an unattended supervisor that discards
  // stderr on success would otherwise collect unpairable receipts run
  // after run. First-party prose with no interpolated value, so it takes
  // its one escape from the emitter.
  if (signing !== null && recordOutput === undefined) {
    log.warn(SIGNING_WITHOUT_RECORD_WARNING);
    emit((e) =>
      e.warning("signingWithoutRecord", SIGNING_WITHOUT_RECORD_WARNING),
    );
  }
  if (auth) {
    // Fail fast on the locally-knowable secret preconditions -- a malformed
    // or already-expired shared secret -- before any credential is
    // presented, rather than letting a dead credential drive the file-sync
    // rendezvous first, whose losing side would then get a misleading
    // "peer abandoned the handshake" hint for what is really an expired or
    // malformed secret. authenticateConnection still runs the same check
    // as the authoritative boundary for library consumers that bypass
    // runProtocol. The shared check sets alcoveRecoveryHintEmitted, so the
    // catch block below suppresses its generic advisory.
    assertSharedSecretReadyForHandshake(auth);
    // Validate and trim the key-file path before any credential is
    // presented, so a misconfiguration fails here rather than at
    // saveKeyFile post-handshake, before the partner could be left holding
    // a rotated token this side cannot persist. Returns the trimmed path,
    // reused by the saveKeyFile call below.
    build.trimmedKeyFilePath = preflightKeyFilePath(auth.keyFilePath, log);
  }
  if (connection.channel === "webrtc") {
    // A first round too large for one WebRTC message is refused here, before
    // the rendezvous is resolved and before anything is sent.
    assertFirstRoundFitsWebRtcFrame(prepared);
    // Resolve the rendezvous -- broker location, ICE servers, role, and the
    // secret both ids derive from -- here rather than at the dial, so a
    // misconfigured connection fails with no socket opened and no id
    // registered. The file-sync construction below has no webrtc
    // counterpart: on this channel there is no client to build.
    const runRelayCredential = await relayCredentialForRun(
      connection,
      auth?.sharedSecret,
      new Date(),
    );
    build.webRtcDial = webRtcDialFrom(
      connection,
      auth?.sharedSecret,
      runRelayCredential,
    );
    if (runRelayCredential !== undefined)
      log.info(relayCredentialNotice(connection, runRelayCredential));
  } else {
    // A first round too large for one message file is refused before the
    // transport is built and before any file is written for the partner.
    assertFileSyncFirstRoundFits(connection, prepared);
    const client =
      connection.channel === "filedrop"
        ? new LocalFSClient()
        : new SSH2SFTPClientAdapter({
            verbosity,
            // connection_per_poll (SFTP-only) turns on the adapter's
            // ephemeral-session mode: a fresh session per poll cycle, released
            // before the idle gap. Resolved from the merged config; undefined
            // (unset) leaves the adapter's held-session default.
            ephemeralSessions: connection.options?.connectionPerPoll,
          });
    build.client = client;
    // CLI-only sweep controls are passed straight to the constructor (the
    // verbose/joinerRecoveryMs precedent), never through config.options, so they
    // cannot be persisted to alcove.yaml. Spread conditionally so an unset value
    // does not clobber the constructor default.
    const fileSyncConn = new FileSyncConnection(client, {
      verbose: verbosity,
      ...(fileSyncRuntime.sweepExchangeFiles !== undefined && {
        sweepExchangeFiles: fileSyncRuntime.sweepExchangeFiles,
      }),
      ...(fileSyncRuntime.forceRetainSweep !== undefined && {
        forceRetainSweep: fileSyncRuntime.forceRetainSweep,
      }),
    });
    build.fileSync = fileSyncConn;

    // The PSI protocol layer (authenticateConnection / runExchange)
    // consumes the pull-based MessageConnection interface. Bridge the
    // event-based FileSyncConnection through fromEventConnection so its
    // data/error events reach awaited receive() calls with no per-phase
    // listener gap. The bridge bounds a parked receive() by the
    // peer-inactivity budget, so a silent peer fails as a transport error
    // rather than hanging; peerTimeoutMs (when configured) overrides the
    // default and also bounds the file-sync rendezvous TTL in conn.open().
    const peerBudgetMs =
      connection.options?.peerTimeoutMs ?? DEFAULT_PEER_TIMEOUT_MS;
    // inactivityHint enriches the generic peer-silence error with
    // file-sync operator guidance: the receiver names its own cause
    // locally, but the sender only sees the inactivity timeout, so this
    // points at the likely receiver-side causes (PEER_SILENCE_GUIDANCE).
    // Supplied as a function because which guidance applies depends on the
    // rendezvous outcome, known only after this bridge is built and read
    // from the connection when the deadline fires.
    build.transport = fromEventConnection(fileSyncConn, {
      inactivityTimeoutMs: peerBudgetMs,
      inactivityHint: () => {
        const leftover = fileSyncConn.unconfirmedEntryPeerHello;
        return leftover === undefined
          ? PEER_SILENCE_GUIDANCE
          : entryHelloResidueGuidance(leftover);
      },
    });
  }
}

/** What {@link runExchange} resolves with, threaded into the output stage. */
type ExchangeOutcome = Awaited<ReturnType<typeof runExchange>>;

/**
 * The run's local output stage: report the outcome, write the result CSV, then
 * the audit record, the dual-signed record, and finally the caller's own
 * post-exchange persistence. Runs only after the two-party exchange completed,
 * so every failure here is local and none of it may be re-run.
 *
 * Each artifact after the result CSV is non-fatal and reports its own loss:
 * a missing one is a persistence-loss warning rather than a failed exchange.
 * The result CSV is the exception -- a result that does not reach where it was
 * owed throws, carrying `PERSISTENCE_LOSS_EXIT_CODE` so a command boundary
 * reports the loss rather than the exit code a transport fault gets. That
 * throw is raised after the audit artifacts have been written and not at the
 * write that failed: the exchange disclosed, and what it disclosed is owed its
 * record whether or not this party got to keep the result
 * (docs/notes/record-durability-point.md).
 *
 * Returns whether every artifact it owed reached disk: false once any of the
 * non-fatal losses above has been reported, the caller's own persistence
 * included -- whether that step threw or caught its failure and reported
 * `persisted: false` -- so what the run tells the operator afterwards about
 * its files keys on the artifacts rather than on this stage returning.
 */
async function writeExchangeOutputs(params: {
  outcome: ExchangeOutcome;
  prepared: PreparedExchange;
  output: string | undefined;
  csvDelimiter: string | undefined;
  recordOutput: RecordOutput | undefined;
  signing: SigningPersist | null;
  loggerName: string;
  log: ReturnType<typeof getLogger>;
  eventStream: EventStreamEmitter | undefined;
  onOutputComplete: FileSyncRuntimeOptions["onOutputComplete"];
}): Promise<boolean> {
  const {
    outcome,
    prepared,
    output,
    csvDelimiter,
    recordOutput,
    signing,
    loggerName,
    log,
    eventStream,
    onOutputComplete,
  } = params;
  const {
    associationTable,
    intersectionCount,
    entityClusters,
    resolvedRole,
    partnerPayload,
    audit,
    bootstrap,
    signedReceipt,
  } = outcome;

  // The result's failure -- a table that could not be built from the partner's
  // payload, or a write that did not deliver it -- held until the audit
  // artifacts below have been written. A box rather than the error itself,
  // since a thrower may raise any value, `undefined` included.
  let resultFailure: { error: unknown; notice: string } | undefined;

  // A count-only exchange produces no matched pairing for either party,
  // so there is no result file to write and nothing was withheld from
  // this party: its whole result is the count, reported here. Checked
  // first, since a count-only receiver holds no association table
  // either and would otherwise be told it receives nothing.
  //
  // The sender seat's copy adds the trust-contingent caveat at the
  // moment the number is read: its count arrived over the partner's
  // count-report leg rather than from a round it ran, and psi-c is the
  // instrument parties reach for before an agreement, so the reminder
  // belongs here too, not only at consent time. The receiver seat
  // computed its own count under an enforced mode, so the same caveat
  // there would be false.
  if (intersectionCount !== undefined) {
    log.info(
      countIsPartnerReported({ intersectionCount, resolvedRole })
        ? `exchange complete: your partner reported ${intersectionCount} ` +
            "record(s) in common. Only your partner computed the count; " +
            "Alcove does not check a count it is sent against a run of its " +
            "own. The agreed terms asked for a count only, so no result file " +
            "was written."
        : `exchange complete: ${intersectionCount} record(s) in common. The ` +
            "agreed terms asked for a count only, so no result file was written.",
    );
  }
  // The result table is withheld (associationTable undefined) when this
  // party's agreed terms give it no output -- a one-sided exchange
  // where it is the PSI sender/helper. It contributed its records to
  // find the match but is not entitled to the result, so report that
  // plainly rather than writing an empty CSV that could be mistaken for
  // a zero-match run. The audit record below is still written (the
  // helper's record does not bind the table).
  else if (associationTable === undefined) {
    log.info(
      "exchange complete: your records contributed to the match, but by the " +
        "agreed terms you receive no result, so no result file was written.",
    );
  } else {
    // buildOutputTable is outside the stamp below on purpose: its
    // integrity throws (duplicate partner row indices, rows missing for
    // association indices, a length mismatch) are partner-shaped
    // faults, and 73's published meaning is that what failed is a local
    // write on this machine. They stay 69, distinguished by the
    // terminal event's `output` category, which covers the whole stage.
    // One delimiter for the escaping and the join: buildOutputTable quotes
    // each field against it and writeOutput joins the fields with it, so the
    // file reads back through the delimiter this party chose. A party that
    // named none, or chose detection, gets a comma-separated result.
    const resultDelimiter = resultCsvDelimiter(csvDelimiter);
    let table: ReturnType<typeof buildOutputTable> | undefined;
    try {
      table = buildOutputTable(
        associationTable,
        prepared.rawRows,
        prepared.metadata,
        partnerPayload,
        prepared.includeOwnColumns,
        resultDelimiter,
      );
    } catch (err) {
      resultFailure = {
        error: err,
        notice:
          "the result could not be built from your partner's payload, so " +
          "no result was written",
      };
    }
    try {
      if (table !== undefined)
        await writeOutput(
          output,
          table.headers,
          table.rows,
          log,
          undefined,
          resultDelimiter,
        );
    } catch (err) {
      // The result did not reach where it was owed -- a file that did
      // not reach disk, or a stdout reader that stopped taking it before
      // the drain's ceiling -- the terminal form of the same loss the
      // persistence-loss reports share: the exchange completed, only
      // local delivery failed, and re-running would re-send this party's
      // data for an exchange that already happened. Set the
      // persistence-loss code on the error so a command boundary reports
      // it instead of the 69 a transport fault gets; exitCodeForError
      // (util/exit.ts) prefers an error's own code, measured (not
      // asserted) by exchange.test.ts and zeroSetup.test.ts driving each
      // handler to a trapped process.exit. An error that already holds a
      // code keeps it.
      if (
        typeof err === "object" &&
        err !== null &&
        (err as { exitCode?: number }).exitCode === undefined
      )
        Object.assign(err, { exitCode: PERSISTENCE_LOSS_EXIT_CODE });
      // Raised below, after the record and the receipt: a disclosure that
      // occurred is owed its record whatever became of the result
      // (docs/notes/record-durability-point.md), and a result the reader of
      // a pipe refused leaves the disk the record goes to untouched.
      resultFailure = {
        error: err,
        notice: "the result was not delivered",
      };
    }
  }

  // How the entity closure grouped the pairs this party just wrote, stated
  // after the result it describes and only where that result was delivered.
  // Core hands one to a party that ran the closure over a many-to-many table
  // -- both parties under the cascade, the receiver alone under single-pass --
  // and none otherwise, so the cardinality is not re-read here. The sentence
  // is core's own composition over integers it formats itself -- the same one
  // the browser seat renders, so no two sinks drift -- and holds no
  // partner-authored text.
  if (entityClusters !== undefined && resultFailure === undefined)
    log.info(describeEntityClusters(entityClusters));

  // Every audit artifact this run was asked for and could not produce,
  // as the messages the machine-interface stream states below.
  const missingArtifacts: string[] = [];

  // Persist the self-attested record after the results: a secondary
  // audit artifact, written last, whose failure is non-fatal (see
  // writeExchangeRecord). Skipped when records are disabled, and written
  // even where the result was not delivered, since the disclosure it
  // accounts for happened either way; on a disk that failed mid-write the
  // write fails too and reports itself as a missing artifact. A withheld
  // result writes no CSV but still records the exchange. An audit
  // runExchange did not return is a record that could not be built
  // (warned there, with the cause), so it reports as a missing artifact
  // exactly as a failed write does.
  if (recordOutput !== undefined) {
    const failure =
      audit === undefined
        ? "no audit record could be built for this exchange, so none was " +
          "written; the exchange and its results succeeded and need not be " +
          "re-run"
        : writeExchangeRecord(
            recordOutput,
            audit.record,
            audit.keys,
            loggerName,
          );
    if (failure !== undefined) missingArtifacts.push(failure);
  }

  // Persist the dual-signed record after the self-attested record.
  // Written only when the signing step ran and the signature exchange
  // completed (runExchange returns signedReceipt undefined otherwise,
  // and throws to the catch on a verification failure, so no partial
  // artifact is written for a terminated swap). Independent of the
  // self-attested record: core signs the receipt from the
  // mutually-verifiable facts regardless of whether this party's local
  // record built, so a record-build failure must not discard it. Its
  // timestamp is the record's createdAt when there is one, so the
  // record and receipt files for one exchange share a stamp. Non-fatal,
  // like the record write.
  if (signing !== null && signedReceipt !== undefined) {
    const failure = writeDualSignedRecord(
      signing.receiptOutput,
      signedReceipt,
      audit?.record.createdAt ?? new Date().toISOString(),
      loggerName,
    );
    if (failure !== undefined) missingArtifacts.push(failure);
  }

  // A lost audit artifact is not a failed exchange -- the result is written and
  // must not be re-run -- so the terminal event below stays `result`. But it is
  // not a success either: an unattended supervisor that discards stderr, or an
  // operator running at --log-level error, would otherwise read a clean exit 0
  // for a run that produced no record. Each failure therefore takes the same
  // persistence-loss report every other completed-run loss takes: a warning on
  // the machine stream and the exit code that separates "do not re-run this"
  // from a transport failure. The caller's own remaining work (a bootstrap's
  // config write) still runs and still reports what it loses.
  for (const missing of missingArtifacts)
    reportPersistenceLoss(missing, eventStream);

  let everyArtifactOnDisk = missingArtifacts.length === 0;

  // The result went nowhere, so the run fails on it and the caller's own
  // persistence below does not run: it writes configuration for a run whose
  // operator never received the result. What it would have saved is named
  // before the throw, on the same two channels every other completed-run loss
  // takes, since the partner may hold the recurring setup this side skipped
  // and the terminal error alone names only the result.
  if (resultFailure !== undefined) {
    if (onOutputComplete !== undefined) {
      const skipped =
        `${resultFailure.notice}, so the post-exchange persistence ` +
        "step did not run: what this run would have saved after the result " +
        "-- a configuration, a key file, or the payload set recorded for a " +
        "later run -- did not reach disk, and your partner may have saved a " +
        "recurring exchange this side did not. The exchange itself " +
        "completed, so do not re-run it; confirm with your partner what " +
        "each side saved before setting up a recurring exchange.";
      log.error(skipped);
      reportPersistenceLoss(skipped, eventStream);
    }
    throw resultFailure.error;
  }

  // The caller's own last persistence, run here rather than after this function
  // returns so that whatever it loses is reported BEFORE the terminal event
  // below -- the stream's terminal-is-last guarantee, and the only ordering a
  // supervisor that stops reading at the terminal event can observe.
  if (onOutputComplete !== undefined) {
    try {
      const hookOutcome = await onOutputComplete({
        observedReceivedPayloadColumns: partnerPayload.columns,
        bootstrap,
      });
      if (!hookOutcome.persisted) everyArtifactOnDisk = false;
    } catch (hookErr) {
      // The hook reports its own losses; reaching here means one escaped it.
      // The exchange is already complete and cannot be undone by a local
      // write, so this is non-fatal -- but a run that silently swallowed it
      // would read as a clean success to the supervisor the stream exists for.
      log.error(
        "the post-exchange persistence step failed after the exchange and " +
          "its results completed; what that step writes did not reach disk: " +
          sanitizeErrorForDisplay(hookErr),
      );
      reportPersistenceLoss(
        "a post-exchange persistence step did not complete; the exchange " +
          "and its results succeeded and must not be re-run, and the error " +
          "logged beside this notice names the step",
        eventStream,
      );
      everyArtifactOnDisk = false;
    }
  }

  return everyArtifactOnDisk;
}

/**
 * The one argument {@link runProtocol} takes. Every field it needs is named
 * here rather than passed by position, so a caller supplying only some of the
 * optional inputs states which ones it means.
 */
export interface RunProtocolOptions {
  /** The transport this exchange runs over. */
  connection: ProtocolConnectionConfig;
  /**
   * The shared secret and its key file, or `null` to run unauthenticated.
   * There is no `undefined` state: every caller states which it means.
   */
  auth: AuthPersist | null;
  /** This party's standardized dataset and the terms it was prepared under. */
  prepared: PreparedExchange;
  /**
   * Where to write the result CSV; `undefined` writes it to stdout. There is
   * no omitted state: every caller states which it means.
   */
  output: string | undefined;
  /**
   * The field delimiter this party's result CSV is written with -- the one its
   * input was read by. Omit it to write commas.
   */
  csvDelimiter?: string;
  /** The `-v` count, forwarded to the transport's own diagnostics. */
  verbosity: number;
  /** The name of the logger this run's diagnostics are written through. */
  loggerName: string;
  /**
   * The `--log-file` path this run's diagnostics were redirected to (the value
   * the caller handed `configureLogging`), or `undefined` when they go to
   * stderr. Read only by the PSI progress display, which draws its live line on
   * a terminal whose diagnostics it shares and nowhere else.
   */
  logFile?: string;
  /** Where to write the exchange record; omit to skip recording. */
  recordOutput?: RecordOutput;
  /** This party's zero-setup `--save` intent. Meaningful only with `auth: null`. */
  saveIntent?: boolean;
  /** The post-handshake hook. Meaningful only on the authenticated path. */
  onAuthenticated?: () => void | Promise<void>;
  /** The file-sync entry-sweep controls, event stream, and output hook. */
  fileSyncRuntime?: FileSyncRuntimeOptions;
  /** The signed-receipt inputs; omit or pass `null` to skip signing. */
  signing?: SigningPersist | null;
}

/**
 * Runs the PSI protocol over an SFTP or file-drop connection and writes
 * results to output. Authentication is supplied on the separate
 * {@link RunProtocolOptions.auth} field, not embedded in `connection`.
 *
 * When `auth` is an {@link AuthPersist}, `keyFilePath` must be a non-empty,
 * non-whitespace string, checked before any credential is presented so a
 * whitespace-only path cannot silently create a file named " " in the
 * current directory. `sharedSecret` is validated by
 * {@link authenticateConnection} after the connection opens; `keyFilePath` is
 * checked only for non-emptiness, and an invalid path is caught with a plain
 * OS error at the key-file write step.
 *
 * When `auth` is `null` the exchange runs without authentication -- the path
 * for callers (e.g. zero-setup) that explicitly accept transport-layer
 * security only. The parameter has no `undefined` state: every caller passes
 * `AuthPersist` to authenticate or `null` to opt out.
 *
 * When `recordOutput` is given, the self-attested exchange record and its
 * private verification keys are written after the results (non-fatal on
 * failure; see {@link writeExchangeRecord}). Pass `undefined` to skip
 * recording. A record that was asked for and could not be produced never
 * fails the exchange but is reported: a `warning` event on the
 * machine-interface stream and `PERSISTENCE_LOSS_EXIT_CODE`, so an
 * unattended run is not treated as a clean success or retried as a
 * transport failure.
 *
 * `saveIntent` holds this party's zero-setup `--save` intent for the
 * exchange's in-band bootstrap (see {@link runExchange}). Omit it on every
 * authenticated path; pass a boolean only from the
 * zero-setup command, whose `onOutputComplete` hook then reads
 * {@link OutputCompleteContext.bootstrap} to provision the saved
 * config/key. Meaningful only with `auth: null`.
 *
 * `onAuthenticated` is an optional post-handshake hook invoked exactly once,
 * on the authenticated path only, after the rotated token is saved to the
 * key file and before the data exchange begins. The online invite/accept
 * callers persist their configuration here, so a handshake that succeeds but
 * whose exchange then fails still leaves both the rotated key and the
 * config on disk. A handshake that never succeeds never reaches the hook
 * (protocol.test.ts, "runProtocol does not invoke onAuthenticated when the
 * handshake fails"). May be synchronous or async; a returned promise settles
 * before the exchange begins. A hook failure is non-fatal -- the data
 * exchange must not be aborted by a failure to persist recoverable config --
 * and is logged at error level, reported as a persistence loss (`warning`
 * event and `PERSISTENCE_LOSS_EXIT_CODE`), and returned on
 * {@link RunProtocolResult.onAuthenticatedError}. Omit it on the
 * no-auth path and from callers with no post-handshake step; passing a hook
 * with `auth: null` is rejected up front, since an unauthenticated exchange
 * has no acceptance step to hook.
 *
 * `fileSyncRuntime` holds the CLI-only, non-persistable file-sync
 * entry-sweep controls (`--sweep-exchange-files` / `--force-retain-sweep`)
 * passed straight to the {@link FileSyncConnection} constructor, bypassing
 * config construction so they can never be persisted to alcove.yaml.
 * Defaults to `{}` (no sweep) and is inert on any non-file-sync transport.
 * Also holds the run's machine-interface stream and the caller's
 * pre-terminal {@link FileSyncRuntimeOptions.onOutputComplete} hook.
 *
 * `signing` holds the signed-receipt inputs (this party's signing identity,
 * the pinned partner fingerprint, and where to write the dual-signed
 * record). Pass `null` (the default) to skip signing. Runs only on the
 * authenticated path, the only one holding the session key the receipt
 * binder needs; a non-null `signing` on the unauthenticated (`auth: null`)
 * path is rejected up front. A non-null `signing` with no `recordOutput` is
 * permitted and warned about ({@link SIGNING_WITHOUT_RECORD_WARNING}), not
 * refused.
 */
export async function runProtocol(
  options: RunProtocolOptions,
): Promise<RunProtocolResult> {
  const {
    connection,
    auth,
    prepared,
    output,
    csvDelimiter,
    verbosity,
    loggerName,
    logFile,
    recordOutput,
    saveIntent,
    onAuthenticated,
    fileSyncRuntime = {},
    signing = null,
  } = options;
  const log = getLogger(loggerName);

  // The opt-in machine-interface emitter (fd-3 NDJSON), constructed only under
  // --event-stream; undefined otherwise, so no line is ever written to fd 3
  // and `emit` below is a no-op. Fails closed and loud FIRST, before any
  // other exchange work: if the flag was given but fd 3 is not wired, this
  // throws a UsageError (exit 64) here rather than dropping events or
  // crashing on the first write. A caller that opened the stream itself
  // passes the emitter instead, having taken the same preflight at its own
  // construction (openEventStream).
  const eventStream =
    typeof fileSyncRuntime.eventStream === "object"
      ? fileSyncRuntime.eventStream
      : openEventStream(fileSyncRuntime.eventStream);

  // Best-effort: a failure to probe the runtime warns and is swallowed, never
  // aborting the exchange.
  logRuntimeEnv(log);
  const emit = (fn: (e: EventStreamEmitter) => void): void => {
    if (eventStream !== undefined) fn(eventStream);
  };
  // The lifecycle phase a terminal event is classified against, advancing with
  // the run: everything through the handshake is "prepare", the PSI exchange
  // is "run", and local result/record generation after is "output". One
  // terminal event fires per run, from exactly one of the two catch
  // boundaries below.
  let terminalPhase: ErrorPhase = "prepare";

  // What the preparation stage builds, held in one object rather than five
  // hoisted bindings so that stage can fill it in place: a throw partway
  // through still leaves the terminal metrics event the client's counters, and
  // the cleanup below closes whatever was constructed. Each field stays
  // undefined until its stage assigns it, and the webrtc channel has no client
  // or file-sync connection to assign at all.
  const build: PreparedTransport = {};

  const stageTimer = createStageTimer(emit);

  // The PSI phase's progress display: a live line on the terminal while one
  // crypto operation runs, and one logged line per operation that completes.
  // Closed by doCleanup -- an interrupt included -- so no half-drawn line is
  // left on the terminal the run's last message goes to.
  const psiProgress = createPsiProgressDisplay({
    statusLine: terminalPsiStatusLine({ verbosity, logFile }),
    clearBeforeLogLine: runBeforeEachLogLine,
    milestone: (line) => log.info(line),
  });

  // The one operational-counter summary, emitted immediately before each
  // terminal event so the terminal event stays last on the stream. recordsProcessed
  // is this party's own input row count; the retry/reconnect counts are read from
  // the transport client's existing loops -- all this party's own integers, never
  // partner-controlled.
  const emitMetrics = (): void => {
    emit((e) =>
      e.metrics(
        prepared.rowCount,
        build.client?.transportRetryCount ?? 0,
        build.client?.reconnectCount ?? 0,
      ),
    );
  };
  // The prepare block. Its throw sites -- channel/caller-contract guards, the
  // shared-secret readiness check, the key-file-path preflight, and
  // client/connection/bridge construction -- all run before the main try
  // below; this catch and the main try's catch are the two disjoint
  // terminal-error-emission sites (phase "prepare" here), so exactly one
  // terminal event fires per run.
  try {
    await prepareTransport(build, {
      connection,
      prepared,
      auth,
      saveIntent,
      onAuthenticated,
      signing,
      recordOutput,
      verbosity,
      fileSyncRuntime,
      log,
      emit,
    });
  } catch (err) {
    emitMetrics();
    emit((e) => e.error(err, "prepare"));
    throw err;
  }

  // SIGINT/SIGTERM handlers and the finally block share this closure so that
  // stop/cleanup/close run at most once, guarded by `cleaned`. Signal
  // handlers deregister only after cleanup completes, so a signal arriving
  // mid-cleanup still hits a handler (which returns via the guard and calls
  // process.exit) rather than Node's default immediate termination. All
  // three are function declarations so they can reference each other freely.
  //
  // No conn.on("error", ...) listener is installed at this layer: synchronous
  // transport failures (open/synchronize) throw directly, and asynchronous
  // poll() errors are observed by the permanent data/error listeners the
  // fromEventConnection bridge attaches for the connection's whole lifetime,
  // appearing at the protocol layer's awaited receive() calls.
  let cleaned = false;
  const run: RunLifecycle = {
    opened: false,
    started: false,
    secure: undefined,
    sessionKeyForReceipt: undefined,
    authStarted: false,
    tokenRotated: false,
    exchangeComplete: false,
    outputsWritten: false,
    signalReceived: undefined,
    onAuthenticatedError: undefined,
  };
  // Cancels work still in flight when a signal arrives, which doCleanup
  // cannot reach: it closes what the run already holds, and a webrtc
  // rendezvous holds its broker socket and half-negotiated peer connection
  // inside the dial until that dial settles. Without this, an interrupt
  // would leave both standing for the rest of the rendezvous budget.
  // Aborted only from a signal handler; ordinary teardown is doCleanup's own
  // closes.
  const interrupted = new AbortController();
  async function doCleanup() {
    if (cleaned) return;
    cleaned = true;
    psiProgress.close();
    // The handlers come off in the finally: the guard above makes cleanup
    // single-entry, so a close that throws past its own per-layer catch would
    // otherwise leave a finished run's SIGINT and SIGTERM handlers installed
    // with nothing left to remove them, and they accumulate where a caller
    // drives runProtocol in-process.
    try {
      const teardown = await closeRunLayers({
        build,
        run,
        log,
        ceilingMs: transportTeardownCeilingMs(connection.channel),
      });
      // The one bounded obligation reached its bound. Cleanup runs after the
      // terminal event, so this goes to the operator log alone -- at error
      // level, the one level an unattended run is certain to keep -- and never
      // to the machine-interface stream, which a consumer may stop reading at
      // the terminal event. It changes no exit code: the teardown is
      // housekeeping, and a supervisor that saw the status move would retry a
      // run that already disclosed.
      if (!teardown.finished)
        log.error(
          teardownCeilingNotice(teardown, {
            channel: connection.channel,
            retainFiles:
              connection.channel !== "webrtc" &&
              connection.options?.retainFiles === true,
            outputsWritten: run.outputsWritten,
          }),
        );
      logTransportCounters(build.client, log);
    } finally {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      // Undo our own contribution to the max-listeners threshold rather than
      // decrementing from whatever it is now: if another module (or a
      // parallel runProtocol) mutated the threshold in between, decrementing
      // from the current value would walk the baseline off by +/-2 each
      // cleanup cycle. Restoring the captured value verbatim leaves any
      // external adjustment intact and undoes only our own +2.
      if (maxListenersIncremented) process.setMaxListeners(prevMaxListeners);
    }
  }
  // The try/catch/finally in each handler ensures process.exit always runs,
  // and that a rejection from doCleanup (an uncaught throw added later)
  // never appears as an unhandled promise rejection, which
  // process.on("SIGINT") would otherwise silently discard.
  // Three states share one message helper so SIGINT, SIGTERM, and the catch
  // block stay consistent:
  // - tokenRotated: our saveKeyFile completed; the partner also derived the
  //   same new token but their save status is unknown.
  // - authStarted && !tokenRotated: the key exchange may have completed on either side;
  //   the partner may have persisted a rotated token even though we did not.
  // - !authStarted: handshake never began; the existing token is still valid.
  function logRotationStateOnInterrupt(reason: string): void {
    if (run.tokenRotated) {
      log.warn(
        `The shared secret was already rotated and saved before ${reason}. ` +
          "Retry without re-inviting; if authentication fails on retry, " +
          "both parties must re-invite.",
      );
    } else if (run.authStarted) {
      log.warn(
        `The key exchange was in progress when ${reason}. Depending on ` +
          "how far the handshake had progressed, the partner may have " +
          "already completed it and saved the rotated token even though " +
          "this side did not. Retry the exchange with the existing key " +
          "file; if authentication fails on retry, both parties must " +
          "re-invite.",
      );
    }
  }
  async function onSigint(): Promise<void> {
    // Must be set synchronously, before the first await, so the runProtocol
    // catch block sees it as soon as the cleanup-induced failure propagates.
    run.signalReceived = "SIGINT";
    // This handler ends the process, at 130 below. The catch returns normally
    // on a signal, so the command promise settles while the teardown here is
    // still running, and nothing else may exit on that settlement.
    noteSignalOwnsExit();
    // Synchronous too, and before the cleanup it cannot substitute for: an
    // in-flight rendezvous tears itself down on this rather than on doCleanup.
    interrupted.abort();
    // Before the first line of the interrupt: the live progress line holds the
    // cursor mid-row, so dropping it here is what puts the lines below on rows
    // of their own. doCleanup closes it again, idempotently.
    psiProgress.close();
    try {
      log.info("caught SIGINT, exiting");
      logRotationStateOnInterrupt("the exchange was interrupted");
      await doCleanup();
    } catch (cleanupErr: unknown) {
      log.debug("onSigint cleanup threw:", sanitizeErrorForDisplay(cleanupErr));
    } finally {
      // 128 + 2 (SIGINT): conventional exit code for a process interrupted
      // by SIGINT, distinguishable from a clean exit (0) or an error (69).
      process.exit(130);
    }
  }
  async function onSigterm(): Promise<void> {
    // Must be set synchronously, before the first await, so the runProtocol
    // catch block sees it as soon as the cleanup-induced failure propagates.
    run.signalReceived = "SIGTERM";
    // As in onSigint: the exit at 143 below is this handler's, and the
    // command promise settles before it is reached.
    noteSignalOwnsExit();
    interrupted.abort();
    // The live line is dropped before the first interrupt line, as in onSigint.
    psiProgress.close();
    try {
      log.info("caught SIGTERM, exiting");
      logRotationStateOnInterrupt("the exchange was interrupted");
      await doCleanup();
    } catch (cleanupErr: unknown) {
      log.debug(
        "onSigterm cleanup threw:",
        sanitizeErrorForDisplay(cleanupErr),
      );
    } finally {
      // 128 + 15 (SIGTERM): conventional exit code for a process terminated by
      // SIGTERM, distinguishable from a clean exit (0) or an error exit (69).
      process.exit(143);
    }
  }

  // Each runProtocol call adds two process-level listeners (SIGINT +
  // SIGTERM). Increment the max-listener threshold for this call's
  // duration so concurrent invocations (e.g. two-party integration tests)
  // do not trigger MaxListenersExceededWarning; doCleanup restores the
  // captured baseline so a concurrent module adjusting the threshold
  // separately is not disturbed. 0 means "unlimited"; left unchanged then.
  const prevMaxListeners = process.getMaxListeners();
  const maxListenersIncremented = prevMaxListeners !== 0;
  if (maxListenersIncremented) process.setMaxListeners(prevMaxListeners + 2);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    const role = await openRunTransport({
      build,
      run,
      connection,
      interrupted,
      log,
    });

    // Set by the prepare block on the file-sync channels and by the rendezvous
    // above on webrtc; either way the exchange has a transport to run over.
    if (build.transport === undefined)
      throw new Error("no transport was established for this exchange");
    const mc = build.transport;

    if (auth) {
      await authenticateRun({
        build,
        run,
        mc,
        auth,
        connection,
        role,
        onAuthenticated,
        log,
        eventStream,
      });
    }

    // Select the PSI crypto backend: the CLI runs under Node, so it prefers the
    // native addon and falls back to WASM when no prebuild ships for this
    // platform.
    const { library: psiLibrary, backend: psiBackend } =
      await loadCliPsiBackend({
        onNativeUnavailable: ({ error }) => {
          if (error) {
            // A prebuild for this platform loaded far enough to fail -- an ABI or
            // libc mismatch (e.g. ERR_DLOPEN_FAILED from a glibc-linked addon on
            // musl, or a host glibc older than the prebuild requires). The native
            // accelerator is silently off when we expected it on, so warn; the
            // ordinary "no prebuild ships for this platform" case stays at debug.
            log.warn(
              "native PSI addon failed to load, using WASM:",
              sanitizeErrorForDisplay(error),
            );
          } else {
            log.debug(
              "native PSI addon unavailable (no prebuild for this platform), using WASM",
            );
          }
        },
      });
    log.debug(`PSI crypto backend: ${psiBackend}`);

    const outcome = await runExchangeStage({
      build,
      run,
      mc,
      role,
      prepared,
      psiLibrary,
      verbosity,
      saveIntent,
      signing,
      recordOutput,
      stageTimer,
      psiProgress,
      onRunPhase: () => {
        terminalPhase = "run";
      },
      log,
      emit,
    });

    // The two-party exchange is complete: runExchange has returned, so this
    // side has received everything and already sent the peer its terminal
    // payload (durable before runExchange resolved). Mark it so the
    // catch's abort-marker gate excludes a failure in the purely-local
    // output stage below: a fault there must not write a cross-party
    // abort marker telling a peer whose exchange succeeded to fail fast --
    // at worst an exit-69 PeerAbortError while its results sit readable on
    // disk. (sealAbort does not help here: it resolves the decision for
    // close(), but writeAbortMarker writes regardless, and the gate keys
    // on abortArmed, still true.)
    run.exchangeComplete = true;
    // The last PSI stage completed when runExchange returned; emit its duration
    // before the terminal event. The output stage below is local I/O, not a named
    // protocol stage, so it is not timed here.
    stageTimer.close();
    // From here on any failure is a purely-local "output"-stage fault (result CSV
    // or audit record), never a run fault: the exchange already succeeded and the
    // operator must not re-run it, so the catch classifies it as "output".
    terminalPhase = "output";

    const {
      associationTable,
      intersectionCount,
      entityClusters,
      matching,
      resolvedRole,
    } = outcome;
    run.outputsWritten = await writeExchangeOutputs({
      outcome,
      prepared,
      output,
      csvDelimiter,
      recordOutput,
      signing,
      loggerName,
      log,
      eventStream,
      onOutputComplete: fileSyncRuntime.onOutputComplete,
    });

    // onAuthenticatedError is set only when a post-handshake hook failed
    // but the exchange above still succeeded (a hook failure followed by
    // an exchange failure rethrows from the catch below instead).
    //
    // The single success terminal event: the exchange completed and the
    // local output stage finished, so exactly one terminal event has now
    // fired. resultWritten is false for a helper whose agreed terms give
    // it no output table and for a count-only exchange, true when a
    // result CSV was produced. The count rides the same event so the two
    // resultWritten:false outcomes stay distinguishable to a supervisor
    // reading only fd 3, and it states the same trust posture (partner-
    // vs. self-reported) the human line does. What the agreed deduplicate
    // pair resolved to rides it for the same reason: the line stating it
    // is an info line, unread on fd 3 alone or at a quieter log level. The
    // entity-cluster summary the output stage logged above rides it on that
    // same footing.
    // The metrics summary precedes it so the terminal event stays last.
    //
    // Both are emitted before cleanup: every local artifact the run owes was
    // written above, or its loss reported there, so the outcome is decided,
    // and a consumer of this stream learns it without waiting on a close that
    // may run to its ceiling. The transport is torn down after, and what that
    // costs goes to the operator log alone.
    emitMetrics();
    emit((e) =>
      e.result(
        associationTable !== undefined,
        matching,
        intersectionCount === undefined
          ? undefined
          : {
              intersectionCount,
              reportedByPartner: countIsPartnerReported({
                intersectionCount,
                resolvedRole,
              }),
            },
        entityClusters,
      ),
    );
    // A close that throws past its own per-layer catch is logged at debug, as
    // the failure path below does with it: the run's result, record and
    // receipt are on disk and its outcome is already on the stream, so a
    // teardown fault must not become the run's own. The finally below
    // re-enters doCleanup and returns at its guard.
    try {
      await doCleanup();
    } catch (cleanupErr: unknown) {
      log.debug(
        "cleanup threw after the run completed:",
        sanitizeErrorForDisplay(cleanupErr),
      );
    }
    return { onAuthenticatedError: run.onAuthenticatedError };
  } catch (err) {
    // tokenRotated=true means this party's saveKeyFile succeeded; the
    // partner independently derived the same new token from the session
    // key, but their disk write cannot be verified from here. "Retry
    // without re-inviting" is the correct first step: if the partner also
    // saved, retry succeeds; if their save failed, retry shows a
    // shared-secret mismatch and both parties re-invite. Neither "both
    // parties hold" (overstates certainty) nor "may already hold"
    // (understates -- this party definitely saved) is said.
    //
    // authStarted && !tokenRotated handles the looser window: the key
    // exchange may have completed on the partner side even though our own
    // save did not run. Raised at error level (rather than warn) because
    // the user's exchange is failing and needs the recovery hint shown
    // prominently. The `alcoveRecoveryHintEmitted` tag marks an error
    // whose own message already states the next step for its fault, so
    // the generic advisory is skipped rather than printed beneath a step
    // it contradicts. Set wherever that holds: the saveKeyFile-failure
    // path below, authenticateConnection's own validation errors (token
    // format, pre- and post-handshake expiry -- see auth.ts), core's
    // terminal transport refusals, and the single-pass reply-cap internal
    // fault. Key-exchange protocol failures from runKex are NOT tagged and
    // do get the generic advisory, which adds useful "retry first; if it
    // fails, re-invite" context.
    //
    // The walk follows `cause` so a future wrap (e.g. `new Error('outer: '
    // + inner.message, { cause: inner })`) still suppresses the generic
    // advisory when an inner error already holds the recovery hint.
    const isHintTagged = (e: unknown): boolean =>
      causeChainSome(
        e,
        (link) =>
          (link as { alcoveRecoveryHintEmitted?: unknown })
            .alcoveRecoveryHintEmitted === true,
      );
    // Walks the `cause` chain for a PeerAbortError, so the echo gate below
    // still recognizes one even behind a future wrap. The critical
    // barrier is actually the sticky first-error latch in the bridge and
    // AEAD layers (a later admin-induced error cannot supersede the
    // PeerAbortError that reaches here); this cause-walk is cheap
    // insurance.
    const errIsPeerAbort = (e: unknown): boolean =>
      causeChainSome(e, (link) => link instanceof PeerAbortError);

    // Missing-receipt observability: this side configured a signed receipt
    // but the exchange failed before runExchange returned (exchangeComplete
    // false), not with a receipt verification error (a distinct security
    // event already reported by that error's own kind/message), and not with
    // this party's own local certificate/terms refusal (a config fault this
    // party's operator caused). A partner presenting no signing certificate,
    // or one this build cannot read, is refused at the terms exchange as a
    // receipt verification error, so what is left here is a run whose signed
    // path had no complaint of its own: the swap is the last step of
    // runExchange, and this side parks on that receive until the peer
    // timeout, a drop otherwise indistinguishable from generic peer-silence.
    // Walks the `cause` chain for a ReceiptVerificationError, so a future wrap
    // of the security failure cannot downgrade it to this softer warn.
    const isReceiptVerificationFailure = (e: unknown): boolean =>
      causeChainSome(e, (link) => link instanceof ReceiptVerificationError);
    // Class-exact, not the UsageError superclass OperatorConfigError itself
    // extends: a different usage fault mid-exchange still warrants the
    // advisory, so only this exact class is excluded. Walks the `cause` chain
    // for the same forward-compatibility reason as
    // isReceiptVerificationFailure above.
    const isLocalConfigRefusal = (e: unknown): boolean =>
      causeChainSome(e, (link) => link.constructor === OperatorConfigError);
    if (
      signing !== null &&
      !run.exchangeComplete &&
      !isReceiptVerificationFailure(err) &&
      !isLocalConfigRefusal(err)
    )
      log.warn(
        "A signed receipt was configured for this exchange, but no receipt " +
          "reached this side before the peer timeout and the receipt swap " +
          "did not complete. A partner that presents no signing certificate " +
          "is refused earlier, at the authenticated setup step, so check the " +
          "transport and the peer rather than the partner's signing " +
          "configuration.",
      );

    // The disclosure a terminated run already made outlives the failure that
    // stopped it: a run past its own payload send has handed this party's payload
    // to the transport, so core hands the self-attested record of that
    // disclosure back on the error rather than discarding it
    // (docs/spec/PROTOCOL.md, Self-attested record). It is written here on the
    // same terms a completed run's is -- same destination, same owner-only pair
    // -- because it is the same kind of artifact; what marks it as a terminated
    // run's is the record's own outcome field, which travels with the file
    // wherever it is copied.
    // Skipped under --no-record, like every other record write.
    const disclosedRecord = exchangeRecordFromFailure(err);
    if (recordOutput !== undefined) {
      // Reported on the stream but NOT as a persistence loss: that class is
      // a completed run's lost local write, and its exit code exists to
      // tell a supervisor not to re-run. This run failed and keeps its own
      // exit code, which a persistence-loss stamp would overwrite with the
      // opposite advice. Both losses take that same disposition: a record
      // that could not be written, and one core could not build for a
      // disclosure it made -- which core warns about on the operator log, a
      // channel an unattended run discards, so the stream states it too.
      // The completed path reports the same pair through missingArtifacts
      // above.
      if (disclosedRecord !== undefined) {
        const failure = writeExchangeRecord(
          recordOutput,
          disclosedRecord.record,
          disclosedRecord.keys,
          loggerName,
        );
        if (failure !== undefined)
          emit((e) => e.warning("terminatedRunRecord", failure));
      } else if (exchangeRecordOwedButUnbuilt(err)) {
        emit((e) =>
          e.warning("terminatedRunRecord", TERMINATED_RECORD_UNBUILT_WARNING),
        );
      }
    }

    // Core tags the rendezvous peer-wait and key-exchange handshake timeouts
    // (see markPeerWaitTimeout), so every fact this inference rests on is local
    // to the run in hand. The tag is also what excludes the sweep's own "may be
    // partially swept" failure: that error is raised from inside the same
    // synchronize() call, so "failed during synchronization" does not
    // distinguish the two, but it is not a peer-wait timeout and is never
    // tagged.
    //
    // Emitted before the generic advisory below rather than instead of
    // it. On the key-exchange side the `authStarted` advisory also fires;
    // the two are compatible (both prescribe a retry) and the token-state
    // context it holds -- the partner may have rotated and saved while
    // this side did not -- is what the operator needs if the retry then
    // fails authentication. Ordering puts the specific likely cause
    // first.
    if (
      connection.channel !== "webrtc" &&
      fileSyncRuntime.sweepExchangeFiles === true &&
      connection.options?.retainFiles !== true &&
      isPeerWaitTimeout(err)
    )
      log.error(BOTH_SWEPT_GUIDANCE);

    const hintAlreadyEmitted = isHintTagged(err);
    if (!hintAlreadyEmitted) {
      if (run.tokenRotated && run.onAuthenticatedError === undefined) {
        log.error(
          "The shared secret was already rotated and saved before this error. " +
            "Retry the exchange without re-inviting; if authentication " +
            "fails on retry, both parties must re-invite.",
        );
      } else if (run.tokenRotated) {
        // The rotated key is on disk, but the post-handshake persistence hook
        // failed (onAuthenticatedError is set), so whatever it would have
        // written -- e.g. the online invite/accept config -- is not on disk. A
        // plain "retry the exchange without re-inviting" is misleading here:
        // `alcove exchange` may have no config to run against. The specific
        // hook failure was already logged at error level when it happened, so
        // emit a corrected advisory rather than the clean-retry one, which would
        // point the user at a recovery path that cannot succeed.
        log.error(
          "The shared secret was rotated and saved, but a post-handshake " +
            "persistence step failed earlier (logged above); resolve that " +
            "before retrying, as the retry may have nothing to run against.",
        );
      } else if (run.authStarted) {
        log.error(
          "The key exchange was in progress when this error occurred. " +
            "Depending on how far the handshake had progressed, the " +
            "partner may have already completed it and saved the rotated " +
            "token even though this side did not. Retry the exchange " +
            "with the existing key file; if authentication fails on " +
            "retry, both parties must re-invite.",
        );
      }
    }
    // If a signal handler is mid-cleanup, it owns the exit code (130/143).
    // Swallowing the error here resolves runProtocol normally so the CLI
    // handler does not race with its own process.exit(69). The signal
    // handler is still running asynchronously and will call process.exit
    // once its cleanup completes; the event loop stays alive until then
    // because the handler's awaited doCleanup is a pending Promise.
    //
    // The in-flight error may be caused by the signal-driven cleanup
    // itself (e.g. a poller rejecting because the connection was closed)
    // or it may be an unrelated protocol error that happened to coincide
    // with the signal. The two are not distinguishable here, so the error
    // is logged at error level rather than discarded silently: if it
    // holds diagnostic information about a real failure, the user sees
    // it even at a strict `--log-level=error` setting; if it is merely
    // cleanup noise, the surrounding "caught SIG..." context makes clear
    // the process is exiting on the signal regardless.
    // Authenticated cross-party abort marker: on a terminal organic fault
    // with the directory still writable, leave a signal so a waiting peer
    // fails fast instead of waiting out its full peer-timeout. Gated to
    // fire only on a genuine fault: not on a signal interrupt (Ctrl-C
    // stays clean), and not on a PeerAbortError (the waiting party must
    // not echo a marker back). The await resolves the connection's abort
    // decision to "write", which a teardown close() parked on that
    // decision then awaits, so the marker lands before the shared
    // transport is ended. Best-effort -- a failed write leaves no marker
    // and the peer falls back to the hedge -- and placed before the
    // signalReceived early-return so a fault that coincides with a signal
    // still defers to the signal.
    //
    // Fires for every terminal post-arm fault, not only "pure" transport
    // faults: a post-arm UsageError (an over-cap inbound frame, a hostile
    // directory, a stalled server, a duplicate/malformed message) is just
    // as terminal and non-retryable, and a peer is waiting on it. Those
    // UsageErrors are peer- or environment-induced; the config-shaped
    // ones (token expiry, bilateral mode mismatch, not-clean directory)
    // are all detected pre-arm and never reach here armed. A failure in
    // the purely-local post-exchange output stage is excluded instead by
    // the exchangeComplete gate above.
    //
    // The marker holds no cause, so signalling on a UsageError discloses
    // nothing the peer's own view of the teardown would not: the local
    // party sees its specific error and exits 64, while the peer sees the
    // cause-free "peer aborted" and exits 69. The pre-arm/post-arm line is
    // principled: only post-arm does a session key (to authenticate the
    // marker) and a waiting post-handshake peer both exist.
    if (
      build.fileSync?.abortArmed === true &&
      !run.exchangeComplete &&
      run.signalReceived === undefined &&
      !errIsPeerAbort(err)
    ) {
      await build.fileSync.writeAbortMarker().catch(() => {
        /* best-effort; teardown proceeds regardless of write outcome */
      });
    }

    if (run.signalReceived !== undefined) {
      log.error(
        `error in flight when ${run.signalReceived} arrived: ` +
          sanitizeErrorForDisplay(err),
      );
      // The run was cut short by a signal and the process is exiting.
      // Preserve onAuthenticatedError so a hook failure recorded before
      // the signal is not silently dropped -- otherwise the caller would
      // treat the run as a clean config write.
      //
      // No terminal event is emitted here: a signal exits via the signal
      // handler's process.exit(130/143), which bypasses this catch, so a
      // supervisor reads "no terminal event plus exit 130/143" as the
      // interrupt (docs/spec/CLI_EVENTS.md). Both interrupt paths emit
      // nothing, so this in-flight-error subpath does not give an
      // inconsistent signal against the far more common clean interrupt.
      // test/unit/protocolInterruptEvents.test.ts drives a real interrupt
      // against a live fd-3 capture, holding that as a check rather than
      // prose.
      return { onAuthenticatedError: run.onAuthenticatedError };
    }
    // The single failure terminal event for an organic (non-signal) fault,
    // classified against the phase the run reached: "output" once the exchange
    // completed, otherwise "run" or "prepare". Exactly one terminal event fires
    // per run, so this is the only error emission and it precedes the rethrow.
    // The metrics summary (with whatever counts the run accrued before the fault)
    // precedes it so the terminal event stays last on the stream.
    //
    // Both are emitted before cleanup, as on the success path above and after
    // the abort marker this catch may have written, so the fault reaches a
    // consumer without waiting on a close that may run to its ceiling. A close
    // that throws past its own per-layer catch is logged at debug, as the
    // interrupt paths do, rather than propagating: it must not displace the
    // original fault.
    emitMetrics();
    emit((e) => e.error(err, terminalPhase));
    try {
      await doCleanup();
    } catch (cleanupErr: unknown) {
      log.debug(
        "cleanup threw during failure:",
        sanitizeErrorForDisplay(cleanupErr),
      );
    }
    // The error is rethrown holding whatever exit code its own thrower
    // gave it, and nothing is stamped here: only the result-file write
    // above is the local write loss 73 names, while the rest of the
    // output stage -- core's refusal of a partner payload that does not
    // fit the association table -- is not. Those keep no code and land on
    // the boundaries' 69. The `output` category on the terminal event
    // stays the finer-grained discriminator for a supervisor that reads
    // fd 3, covering the whole stage either way.
    throw err;
  } finally {
    await doCleanup();
  }
}
