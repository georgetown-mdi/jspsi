import fs from "node:fs";

import type { Argv, Arguments } from "yargs";

import {
  assertCountOnlyTransmitsNoColumn,
  describeDecodeError,
  deriveAcceptedLinkageTerms,
  deriveOutboundPayloadConsent,
  disclosedColumnNames,
  getLogger,
  parseExchangeSpec,
  redactAndSanitizeForDisplay,
  UsageError,
} from "@psilink/core";
import type {
  ConnectionConfig,
  ExchangeSpec,
  InvitationToken,
  LinkageTerms,
  OutboundPayloadConsent,
  PreparedExchange,
  WebRTCConnectionConfig,
} from "@psilink/core";

import {
  diffLinkageTerms,
  linkageTermsStandingOf,
  persistExpectedPartnerDeduplicate,
  persistExpectedPayloadColumns,
  persistOutboundPayloadConsent,
  reconcileConflictMessage,
  warnOnLinkageRuleSetCitationDrift,
  type ReconcileDiff,
} from "../config";
import { detectFileConflicts } from "../fileUtils";
import {
  ACCEPT_IDENTITY_QUESTION,
  askIdentityAtPrompt,
  identityFromFlagOrPrompt,
  resolveIdentity,
  resolveKeptConfigurationIdentity,
} from "../partyIdentity";
import { parseSensitiveYaml } from "../sensitiveFile";
import { decodeAndValidateInvitation } from "../invitationDecode";
import {
  consentSurfaceSink,
  displayInvitation,
  renderDialedBroker,
  type ConsentSurfaceSink,
} from "../invitationDisplay";
import {
  assertNoUnknownOptions,
  configureLogging,
  promptConfirm,
  runOrExit,
} from "../util/cli";
import { resolveRecordOutput } from "../recordFile";
import {
  checkLinkageSatisfiability,
  RUN_BLOCK_CONSEQUENCE,
  warnColumnsTheInvitationWillNotAccept,
  type LinkagePreflightMessaging,
} from "./linkagePreflight";
import { assertNoProvisionConflicts, provisionConfigAndKey } from "./provision";
import {
  connectionFromURL,
  type RunnableConnectionConfig,
} from "../connectionFromUrl";
import { brokerLocationFromConnection } from "../connection/webrtc/weriftPeer";
import {
  dialedBrokerHostAndPort,
  type DialedBrokerHostAndPort,
} from "../connection/webrtc/brokerClient";
import { withWebRTCPeerRole } from "../webrtcPeerRole";
import { diffConnectionAgainstTarget } from "../reconcile";
import {
  addCommonBootstrapOptions,
  connectionOverridesFrom,
  parseCommonBootstrapArgs,
  warnConnectionPerPollShortInterval,
  warnLowPollingFrequency,
  warnOptionsOverridesIgnoredOffline,
  warnServerOverridesIgnoredOffline,
  warnUnsupportedFileSyncFlags,
  type CommonBootstrapOptions,
} from "../optionDefinitions";
import {
  applyEndpointSplitDirectories,
  buildDataSpec,
  connectionFromEndpoint,
  loadInputRows,
  logOnlineBootstrapOutcome,
  looksLikeUrl,
  prepareForOnlineExchange,
  runOnlineBootstrap,
  type ResolvedDataSpec,
} from "../onlineBootstrap";

export function builder(cmd: Argv): Argv {
  return addCommonBootstrapOptions(
    cmd
      // Capture all positionals into `args` (rather than relying on the global
      // `_`) and treat an unknown `-`-leading token as a positional, so an
      // invitation string beginning with `-` (a valid base64url character) is
      // taken as the positional invitation, not a cluster of option flags.
      // Scoped to this command so the other commands' parsing is unaffected.
      .parserConfiguration({ "unknown-options-as-args": true })
      .positional("args", {
        type: "string",
        array: true,
        describe:
          "INVITATION [INPUT_FILE] [OUTPUT_FILE] (offline), or URL INVITATION " +
          "INPUT_FILE [OUTPUT_FILE] (online)",
      })
      .usage(
        "Usage:\n" +
          "  $0 accept [options] INVITATION [INPUT_FILE] [OUTPUT_FILE]    (offline)\n" +
          "  $0 accept [options] URL INVITATION INPUT_FILE [OUTPUT_FILE]  (online)\n\n" +
          "INVITATION is a base64url string or an @path reference to a file\n" +
          "containing one. Offline: decode, confirm, and write config and key\n" +
          "files; an invitation naming a webrtc coordination server, given an\n" +
          "INPUT_FILE, also runs the exchange it accepts. Online: connect,\n" +
          "complete the handshake, and run the exchange.",
      ),
    // --consent-to-terms is the one accept-specific option: it records, in
    // advance, the operator's consent to THIS invitation's disclosed terms -- the
    // consent the interactive prompt otherwise collects -- so accept can run
    // unattended. The name states the object of consent (the terms), and is scoped
    // to this one decision: it does NOT bypass the separate SSH host-key trust
    // step (which keeps its own pin / fail-closed resolution), nor any prompt
    // added later -- each such gate takes its own opt-in. No short form: bypassing
    // the command's central human checkpoint should be a deliberate, legible
    // token, and accept's `unknown-options-as-args` (which lets a `-`-leading
    // invitation positional through) would make a single-letter flag ambiguous
    // besides.
  ).option("consent-to-terms", {
    type: "boolean",
    default: false,
    describe:
      "consent in advance to this invitation's disclosed terms, skipping the " +
      "interactive confirmation, so accept can run unattended or in a script. " +
      "This BYPASSES the one human checkpoint before the configuration and " +
      "linkage key are written from the partner-supplied invitation; on an " +
      "invitation carrying a webrtc endpoint, given an INPUT_FILE, that same " +
      "checkpoint is the last one before this command connects to the " +
      "coordination server the invitation names and runs the exchange, so the " +
      "flag also authorizes connecting and transmitting unattended. Review the " +
      "terms before using it; it does not affect SSH host-key verification. It " +
      "also frees standard input, so INPUT_FILE may be `-` to read the CSV " +
      "from stdin.",
  });
}

// --- Positional parsing ------------------------------------------------------

/**
 * Classify the positional arguments as an offline or online acceptance. The
 * first positional is a server URL (online) when it parses as a supported
 * transport URL; otherwise it is the invitation string (offline). Because the
 * invitation is never matched as a URL, an invitation beginning with `-` (a
 * valid base64url leading character) is taken as the positional invitation, not
 * a flag -- the top-level parser is configured to push unknown `-`-leading
 * tokens into the positionals for this reason.
 *
 * Both forms end in an optional OUTPUT_FILE, the destination of the result an
 * acceptance that runs its own exchange writes (see {@link validateAccept}).
 * Offline it is honored only by an acceptance that runs one, which reports it
 * unused otherwise rather than dropping a positional the operator typed.
 *
 * A positional past the last one each form names is a usage error rather than a
 * silent drop, checked per form because the two differ in what the same position
 * means: the third is an OUTPUT_FILE offline and an INPUT_FILE online, so an
 * operator who reached for the wrong form is told so instead of having a file
 * they named ignored.
 *
 * @internal exported for testing
 */
export function resolveAcceptPositionals(positionals: Array<unknown>):
  | { mode: "offline"; invitation: string; input?: string; output?: string }
  | {
      mode: "online";
      url: URL;
      invitation: string;
      input: string;
      output?: string;
    } {
  const arg0 =
    positionals[0] !== undefined ? String(positionals[0]) : undefined;
  if (arg0 === undefined)
    throw new UsageError(
      "an invitation is required; usage: psilink accept --identity IDENTITY " +
        "INVITATION [INPUT_FILE] [OUTPUT_FILE]",
    );

  if (looksLikeUrl(arg0)) {
    const invitation =
      positionals[1] !== undefined ? String(positionals[1]) : undefined;
    const input =
      positionals[2] !== undefined ? String(positionals[2]) : undefined;
    if (invitation === undefined || input === undefined)
      throw new UsageError(
        "online acceptance requires an invitation and an input file; usage: " +
          "psilink accept --identity IDENTITY URL INVITATION INPUT_FILE " +
          "[OUTPUT_FILE]",
      );
    if (positionals.length > 4)
      throw new UsageError(
        "online acceptance takes at most four positionals; usage: psilink " +
          "accept --identity IDENTITY URL INVITATION INPUT_FILE [OUTPUT_FILE]",
      );
    const output =
      positionals[3] !== undefined ? String(positionals[3]) : undefined;
    return { mode: "online", url: new URL(arg0), invitation, input, output };
  }

  if (positionals.length > 3)
    throw new UsageError(
      "offline acceptance takes at most three positionals; usage: psilink " +
        "accept --identity IDENTITY INVITATION [INPUT_FILE] [OUTPUT_FILE]",
    );
  return {
    mode: "offline",
    invitation: arg0,
    input: positionals[1] !== undefined ? String(positionals[1]) : undefined,
    output: positionals[2] !== undefined ? String(positionals[2]) : undefined,
  };
}

// --- Validation (the no-commit phase) ----------------------------------------

/**
 * Everything an acceptance needs that is fallible but free of the gating side
 * effects (the confirmation prompt, writing files, opening a connection):
 * decode + validate the invitation, detect conflicts, validate the URL and read
 * the input (online), and resolve the data spec and connection. The caller's
 * commit step performs the prompt and side effects from this bundle, so a
 * missing file, bad URL, or invalid invitation aborts before the user is asked
 * to confirm. Cleaning warnings are logged here so they precede the prompt.
 */
type AcceptReady = {
  /**
   * True when a pre-existing config was reconciled against the invitation (and,
   * online, the URL) and matched, so it is kept untouched and only the key file
   * is written. False when no config existed and a fresh one will be written.
   */
  reuseExistingConfig: boolean;
  /**
   * The kept config's own `output.shareWithPartner`, present only under reuse.
   * Reconciliation compares no output field, so the invitation's mirror cannot
   * stand in for it when deciding what outbound-consent record the kept config
   * needs (see the derivation at the accept handler).
   */
  existingOutputShares?: boolean;
} & (
  | {
      mode: "online";
      url: URL;
      output?: string;
      token: InvitationToken;
      connection: RunnableConnectionConfig;
      dataSpec: ResolvedDataSpec;
      prepared: PreparedExchange;
    }
  | {
      /**
       * An acceptance that runs the exchange on the connection the invitation's
       * own endpoint names, with no server URL of its own: the webrtc
       * rendezvous. It reaches {@link runOnlineBootstrap} exactly as the URL-driven
       * mode above does, so it writes the same configuration, key file, record,
       * and result -- what differs is only where the connection came from.
       */
      mode: "endpointRun";
      output?: string;
      token: InvitationToken;
      connection: WebRTCConnectionConfig;
      /**
       * The host and port the rendezvous will dial, resolved from the endpoint
       * by the same resolver the dial uses. Carried so the consent surface and
       * the confirmation question can name the coordination server this run
       * connects to, which on this path the operator never typed.
       */
      brokerAuthority: DialedBrokerHostAndPort;
      dataSpec: ResolvedDataSpec;
      prepared: PreparedExchange;
    }
  | {
      mode: "offline";
      token: InvitationToken;
      connection: ConnectionConfig;
      seeded: boolean;
      dataSpec: ResolvedDataSpec;
    }
);

/**
 * Validate and prepare an acceptance without committing any side effect. Throws
 * (for the shared {@link runOrExit} mapper) on any failure; runs the invitation
 * decode before the connection/input work so the `decode -> myTerms ->
 * buildDataSpec` dependency stays ordered.
 *
 * The one question it can ask is `askIdentity`, and only where the caller
 * supplied it: the label is an input to everything below it -- the derived
 * terms, the data spec, the satisfiability check, the prepared exchange -- so it
 * cannot be collected later, at the confirmation prompt, without validating the
 * acceptance twice. It is asked after the invitation has decoded and validated
 * and after the key-file conflict gate, so nobody types a name for an
 * acceptance that was never going to proceed. An acceptance that keeps a
 * configuration already at the path neither asks nor reads the flag: its label
 * is that file's own (see {@link keptConfigurationIdentity}).
 *
 * @internal exported for testing
 */
export async function validateAccept(params: {
  resolved: ReturnType<typeof resolveAcceptPositionals>;
  options: CommonBootstrapOptions;
  log: ReturnType<typeof getLogger>;
  /**
   * The operator passed `--consent-to-terms`, so the confirmation prompt is
   * skipped. Because the prompt is what otherwise owns the single-use stdin, this
   * also frees stdin to carry the input CSV, so a `-` input is allowed
   * (`allowStdin`); without it `-` stays rejected, as the prompt would starve.
   * Defaults to false so a caller that omits it keeps the prompt-and-reject-`-`
   * behavior.
   */
  consentToTerms?: boolean;
  /**
   * Ask the operator for this party's identity, where `options.identity` carries
   * none and this acceptance is going to write the configuration that remembers
   * the answer. Omitted for a run with no terminal to ask at, and for one whose
   * stdin the input CSV holds -- both of which then take the standing
   * no-identity refusal rather than blocking on a read no one answers.
   */
  askIdentity?: () => Promise<string>;
}): Promise<AcceptReady> {
  const {
    resolved,
    options,
    log,
    consentToTerms = false,
    askIdentity,
  } = params;

  // Validate (checksum, schema, expiry) first, so the user is never prompted for
  // an invalid invitation. A pre-existing key file remains a hard conflict on
  // accept (docs/CLI.md "Online acceptance"): a stale token must never be
  // silently reused. A pre-existing config, by contrast, is reconciled against
  // the invitation below (reconcileAcceptConfig) rather than aborting.
  const token = await decodeAndValidateInvitation(resolved.invitation);
  assertNoProvisionConflicts(
    { configPath: options.configFile, keyPath: options.keyFile },
    ["key"],
  );

  // A configuration already at the path either aborts the acceptance below or
  // is kept and reused (its consent record refreshed in place, docs/CLI.md
  // under Existing files, but never its linkage_terms.identity -- see the
  // "handler: accept-reuse leaves the kept configuration's identity untouched"
  // test) -- so the label this party runs under is that file's own, and there
  // is nothing to ask: an answer would have nowhere to be remembered, and a
  // flag has nowhere to be written. This is the acceptance's one read of that
  // file: the label is an input to the terms reconcileAcceptConfig compares,
  // so the parsed spec is threaded into it rather than read a second time
  // there.
  const keptConfig = readExistingAcceptConfig(
    options.configFile,
    reconciliationSources(resolved.mode === "online"),
  );
  const myIdentity =
    keptConfig !== undefined
      ? keptConfigurationIdentity({
          configured: keptConfig.linkageTerms.identity,
          supplied: options.identity,
          configPath: options.configFile,
          // The same sink resolution the terms display below takes, on the same
          // two inputs: acceptance prompts exactly where `--consent-to-terms`
          // did not declare the run unattended, so the notice reaches the
          // terminal the y/N is asked on wherever the operator routed the log.
          notify: consentSurfaceSink({
            log,
            logFile: options.logFile,
            willPrompt: !consentToTerms,
            level: "warn",
          }),
        })
      : resolveIdentity(
          await identityFromFlagOrPrompt(options.identity, askIdentity),
        );
  // Adopt the invitation's agreed linkage fields/keys/algorithm, but record this
  // party's own identity (the invitation's identity is the inviter's) and MIRROR
  // the output direction rather than copying it: validateCompatibility compares
  // output as a mirror, so a verbatim copy only happens to agree in the symmetric
  // both-receive case and would abort any one-sided exchange. The shared core
  // helper also backs the web acceptor (see deriveAcceptedLinkageTerms).
  const myTerms: LinkageTerms = deriveAcceptedLinkageTerms(
    token.linkageTerms,
    myIdentity,
  );

  if (resolved.mode === "online") {
    const { url, input, output } = resolved;
    // Validate the URL before reading the input file, mirroring validateInvite,
    // so a bad scheme/host fails fast without first parsing the CSV.
    const urlConnection = connectionFromURL(
      url,
      connectionOverridesFrom(options),
    );
    // When the acceptor did NOT pass --outbound-path (the explicit override,
    // which wins), a split-directory invitation endpoint seeds the mirror-swapped
    // inbound/outbound roles and retain trio onto the URL-built connection -- the
    // online counterpart to the offline path's connectionFromEndpoint. Host,
    // port, and credentials stay the URL's. A non-split (or absent) endpoint is a
    // no-op, leaving the URL connection unchanged.
    const { connection: seededConnection, appliedSplitDirectories } =
      options.outboundPath === undefined
        ? applyEndpointSplitDirectories(urlConnection, token.connectionEndpoint)
        : { connection: urlConnection, appliedSplitDirectories: false };
    const connection = withWebRTCPeerRole(seededConnection, "acceptor");
    if (appliedSplitDirectories)
      log.info(
        "seeding the split inbound/outbound directories (mirror-swapped) and " +
          "retain mode from the invitation's endpoint; the connection URL " +
          "supplies the host, port, and credentials. Pass --outbound-path to " +
          "override.",
      );
    // Only on this online path -- the offline path reports --polling-frequency
    // ignored (see below). connectionFromURL has already rejected a webrtc URL,
    // so `connection` is a file-sync channel here and the channel gate always
    // passes.
    warnLowPollingFrequency(
      connection.channel,
      options.pollingFrequencyMs,
      log,
    );
    // Warn when --connection-per-poll resolves to a channel that ignores it (a
    // file:// URL is filedrop, which holds no session). connectionFromURL applies
    // the override only on sftp, so on filedrop the raw flag is the only carrier
    // of the operator's intent; read it too, not just the merged value that a
    // future persisted source would set. A no-op on sftp (the mode's own channel),
    // where warnConnectionPerPollShortInterval covers the short-interval case
    // instead -- the two are channel-exclusive and never double-warn.
    warnUnsupportedFileSyncFlags(
      connection.channel,
      {
        connectionPerPoll:
          options.connectionPerPoll === true ||
          connection.options?.connectionPerPoll === true,
      },
      log,
    );
    // Warn when --connection-per-poll is paired with a short poll interval. Built
    // from the URL (endpoint-seeded), so `connection` carries the effective mode
    // and interval; a no-op off sftp (the mode is SFTP-only).
    warnConnectionPerPollShortInterval(
      connection.channel,
      connection.options?.connectionPerPoll,
      connection.options?.pollIntervalMs,
      log,
    );
    // Reconcile a pre-existing config against the invitation AND the connection
    // the exchange will actually use (the built `connection`, now possibly
    // endpoint-influenced) before the input is read and before any network
    // activity, so a location disagreement aborts with a diff and no acceptance
    // is ever sent to the inviter.
    const { reuse: reuseExistingConfig, existingOutputShares } =
      reconcileAcceptConfig({
        configPath: options.configFile,
        existing: keptConfig,
        myTerms,
        consentedPayloadColumns: token.disclosedPayloadColumns,
        target: connection,
        log,
      });
    // accept reads its y/N confirmation from stdin (promptConfirm), so it cannot
    // also take the CSV there -- unless `--consent-to-terms` skips that prompt,
    // which frees stdin for the CSV. Gate `-` on it: rejected when the prompt
    // would run, allowed when it is bypassed (see the consentToTerms doc above).
    const rows = await loadInputRows(input, { allowStdin: consentToTerms });
    checkLinkageSatisfiability(
      rows.columns,
      myTerms,
      INVITATION_PREFLIGHT_MESSAGING,
    );
    const dataSpec = buildDataSpec({
      terms: myTerms,
      identity: myIdentity,
      rows,
    });
    // Fail closed on a count-only invitation this party's own columns would
    // transmit a column under: the algorithm carries no payload in either
    // direction, so the marked columns are neither dropped to bring the run into
    // the count-only shape nor carried into an outbound-consent record. This is
    // the one count-only shape rule no linkage-terms document carries -- the
    // other four are refused as the invitation is decoded, and again by
    // deriveAcceptedLinkageTerms above. Ahead of the prepare below, whose
    // algorithm gate would report only that no count-only run path exists, and
    // ahead of the consent surface, which states the same fact with no account of
    // what to change.
    assertCountOnlyTransmitsNoColumn(myTerms.algorithm, dataSpec.metadata);
    warnColumnsTheInvitationWillNotAccept({
      metadata: dataSpec.metadata,
      columnNames: rows.columns,
      terms: myTerms,
      mode: "online",
      log,
    });

    const prepared = await prepareForOnlineExchange(dataSpec, myIdentity, rows);
    // Lock in the columns the invitation declared the inviter will send, so the
    // exchange aborts if the payload actually received does not match what the
    // operator consented to (see reconcileReceivedPayload). Absent on an
    // invitation that carried no disclosed-subset (an older or metadata-unknown
    // mint path) -- then this party reconciles lazily, as before.
    prepared.expectedPayloadColumns = token.disclosedPayloadColumns;
    // Bind the inviting party's own side of the cardinality to what this
    // acceptance consented to: the invitation declared it, the consent surface
    // stated it, and nothing in the agreed terms compares the two sides -- so a
    // partner presenting a different value at the terms exchange is refused
    // before any key or payload moves (see
    // assertPresentedDeduplicateMatchesInvitation).
    prepared.expectedPartnerDeduplicate = token.linkageTerms.deduplicate;
    return {
      mode: "online",
      url,
      output,
      token,
      connection,
      dataSpec,
      prepared,
      reuseExistingConfig,
      existingOutputShares,
    };
  }

  // Offline: the server-block overrides (--server-* and --outbound-path) and the
  // connection-options overrides (timeouts, --max-reconnect-attempts, the
  // file-sync toggles) cannot take effect (the connection block is seeded from
  // the invitation endpoint or a placeholder, not built from a URL), so warn
  // rather than drop a deliberately-passed flag silently. Two diagnostics: the
  // server block and the connection.options block have distinct remedies.
  warnServerOverridesIgnoredOffline(options, log);
  warnOptionsOverridesIgnoredOffline(options, log);

  // Offline.
  const { reuse: reuseExistingConfig, existingOutputShares } =
    reconcileAcceptConfig({
      configPath: options.configFile,
      existing: keptConfig,
      myTerms,
      consentedPayloadColumns: token.disclosedPayloadColumns,
      log,
    });
  const { connection: endpointConnection, seeded } = connectionFromEndpoint(
    token.connectionEndpoint,
  );
  const connection = withWebRTCPeerRole(endpointConnection, "acceptor");
  // `-` is gated on `--consent-to-terms` here exactly as on the online path
  // above: stdin serves the confirmation prompt unless the flag skips it, freeing
  // it for the CSV.
  const rows =
    resolved.input !== undefined
      ? await loadInputRows(resolved.input, { allowStdin: consentToTerms })
      : undefined;
  // The connection this acceptance can run the exchange on itself, rather than
  // writing a configuration for a later `psilink exchange`. A webrtc acceptance
  // holds everything the run needs and nothing the operator must still fill in:
  // the invitation's endpoint IS the coordination server, the role is this
  // command's own (stamped above), and the shared secret is the token's -- so the
  // partner need not run a second command while the inviter sits inside its
  // accept timeout. The other channels are not runnable here: their connection
  // block is a locator whose credentials the operator still supplies by hand.
  //
  // A kept configuration is excluded because it, not this acceptance, governs
  // the exchange: `psilink exchange` loads that file, resolves its `@path`
  // references and its own `server.key`/`secure`, and dials what it says.
  // Running the endpoint-built connection here instead would dial a different
  // coordination server than the acceptance's own configuration names.
  const runnableConnection =
    connection.channel === "webrtc" && !reuseExistingConfig
      ? connection
      : undefined;
  const runsExchange = runnableConnection !== undefined && rows !== undefined;
  // Name the kept configuration as the reason a webrtc acceptance stops short of
  // the run its endpoint would otherwise support, so an operator who passed an
  // input file expecting one reads why rather than a silent exit 0 with no
  // result. (The other reason -- no input file at all -- is named where the
  // configuration is written, since only then is there a path to point at.)
  if (connection.channel === "webrtc" && reuseExistingConfig)
    log.info(
      "this acceptance keeps the existing configuration, so it writes the key " +
        "file and stops: the exchange is governed by that configuration's own " +
        "connection block rather than by the invitation's endpoint. Run " +
        "'psilink exchange' with your input file once this command finishes.",
    );
  // The result destination belongs to a run; an acceptance that writes only a
  // configuration and key file has none to send there, so report the positional
  // rather than drop it silently.
  if (resolved.output !== undefined && !runsExchange)
    log.warn(
      "the OUTPUT_FILE positional has no effect on this acceptance: it writes " +
        "the configuration and key file and runs no exchange, so there is no " +
        "result to write. Pass the destination to 'psilink exchange' instead.",
    );
  if (rows !== undefined)
    checkLinkageSatisfiability(
      rows.columns,
      myTerms,
      INVITATION_PREFLIGHT_MESSAGING,
    );
  const dataSpec = buildDataSpec({
    terms: myTerms,
    identity: myIdentity,
    rows,
  });
  // The offline half of the count-only metadata refusal above. A no-op when this
  // acceptance was given no input file, which leaves this party's transmitted set
  // unresolved rather than empty.
  assertCountOnlyTransmitsNoColumn(myTerms.algorithm, dataSpec.metadata);
  warnColumnsTheInvitationWillNotAccept({
    metadata: dataSpec.metadata,
    columnNames: rows?.columns,
    terms: myTerms,
    // What the acceptance does after the warning is what the mode selects, and a
    // run reaches prepareForOnlineExchange below -- the same prepareForExchange
    // that carries the refusal -- so it stops before the terms are displayed,
    // exactly as the URL-driven mode does.
    mode: runsExchange ? "online" : "offline",
    log,
  });

  if (runnableConnection !== undefined && rows !== undefined) {
    // Resolve the partner-supplied locator into the broker location the dial
    // would use, here rather than inside the exchange: every shape
    // `webRtcDialFrom` refuses -- an undialable port, or a delimiter the
    // endpoint schema's length-only bound carried into the host or path -- is
    // then a usage error before the terms are displayed, so a locator this run
    // could not dial costs neither a confirmation nor a written file. This is
    // the same resolver the dial itself calls, so nothing here decides what is
    // dialable. The warn callback is a no-op because the dial below runs in this
    // same process and emits the plaintext advisory itself.
    const brokerLocation = brokerLocationFromConnection(
      runnableConnection.server,
      () => {},
    );
    const prepared = await prepareForOnlineExchange(dataSpec, myIdentity, rows);
    // The same two bindings the URL-driven mode sets on its prepared exchange,
    // for the same single run: the columns the invitation declared its party
    // will send, and the cardinality side it declared for itself.
    prepared.expectedPayloadColumns = token.disclosedPayloadColumns;
    prepared.expectedPartnerDeduplicate = token.linkageTerms.deduplicate;
    return {
      mode: "endpointRun",
      output: resolved.output,
      token,
      connection: runnableConnection,
      // What the socket will actually dial, not the endpoint's own text: the URL
      // parser normalizes a host on its way to the wire, so naming the partner's
      // spelling on the consent surface could name a server this run never
      // contacts (see dialedBrokerHostAndPort). It runs the same authority parse
      // the dial does, so a locator that fails it fails identically at the dial,
      // here before the terms are displayed.
      brokerAuthority: dialedBrokerHostAndPort(brokerLocation),
      dataSpec,
      prepared,
      reuseExistingConfig,
      existingOutputShares,
    };
  }

  return {
    mode: "offline",
    token,
    connection,
    seeded,
    dataSpec,
    reuseExistingConfig,
    existingOutputShares,
  };
}

/**
 * This party's label for an acceptance that keeps the configuration already at
 * the path: that file's own `linkage_terms.identity`, with a `--identity` given
 * alongside it reported as having no effect.
 *
 * The stored label wins because the kept file governs every exchange under the
 * partnership, and under `signing.mode: certificate` the label in the agreed
 * terms is what a receipt is verified against -- so a flag that quietly renamed
 * the party for one run would put the name the partner reads on this run at odds
 * with the one the file keeps sending. Renaming is an edit of that file, which
 * is what the notice says.
 *
 * This acceptance does refresh the kept file's consent record in place
 * (docs/CLI.md, under Existing files), but never `linkage_terms.identity`
 * itself (see the "handler: accept-reuse leaves the kept configuration's
 * identity untouched" test) -- so the label a certificate was issued against
 * never moves under it.
 *
 * The notice reads as the one `psilink invite` gives on its own
 * config-as-source path, and is escaped the same way: both labels and the path
 * are free text reaching the consent surface's sink, which is their boundary
 * (CONTRIBUTING.md, Operator-facing escaping). What triggers it deliberately
 * diverges. Invite warns on any non-blank flag, this one only where the flag
 * also differs from the stored label: a flag naming exactly that label asks for
 * what the run already does, so reporting it as ineffective would misdescribe an
 * acceptance that does run under the name the operator typed. A blank flag --
 * what a scripted `--identity "$ORG"` sends with `ORG` unset -- names nothing to
 * begin with, and is silent on both commands. Align the two only on a decision
 * to change that behavior, not to make the pair look uniform.
 *
 * `notify` is the consent surface's own sink rather than the logger, because
 * this notice is part of what the operator answers for: it says the name the
 * partner will read is not the name this invocation typed, and the y/N over
 * that name comes a screen later. A plain `log.warn` would let `--log-file` or
 * a level above `warn` carry it away from the terminal the question is asked
 * on, which is the routing {@link consentSurfaceSink} exists to survive
 * (docs/CLI.md, under acceptance).
 */
function keptConfigurationIdentity(params: {
  configured: string | undefined;
  supplied: string | undefined;
  configPath: string;
  notify: ConsentSurfaceSink;
}): string {
  const { configured, supplied, configPath, notify } = params;
  const identity = resolveKeptConfigurationIdentity(configured, configPath);
  const stated = supplied?.trim();
  if (stated !== undefined && stated !== "" && stated !== identity)
    notify(
      `--identity "${redactAndSanitizeForDisplay(stated)}" has no effect on an ` +
        "acceptance that keeps the existing configuration file; that file's " +
        "linkage_terms.identity " +
        `("${redactAndSanitizeForDisplay(identity)}") names this party in the ` +
        "terms this acceptance agrees to, and in every exchange the file " +
        "governs. Edit linkage_terms.identity in " +
        `${redactAndSanitizeForDisplay(configPath)} to change it.`,
    );
  return identity;
}

/**
 * What a pre-existing configuration is compared against, woven into every
 * message about it so the online case ("the invitation and the connection URL")
 * and the offline one ("the invitation") each read right.
 */
function reconciliationSources(comparesConnectionUrl: boolean): {
  against: string;
  retryWith: string;
} {
  return comparesConnectionUrl
    ? {
        against: "the invitation and the connection URL",
        retryWith: "the same URL and invitation",
      }
    : { against: "the invitation", retryWith: "the same invitation" };
}

/**
 * The configuration already at `configPath`, parsed, or `undefined` where no
 * file is there. Throws a {@link UsageError} naming the path and what to do
 * about it when a file is there but cannot be read as an exchange spec.
 *
 * Called once per acceptance, by {@link validateAccept}, which threads the
 * result to everything that needs it: the label the run proceeds under and the
 * terms {@link reconcileAcceptConfig} compares then act on one read of one file.
 *
 * Parse, then validate, in two steps. The YAML parse can echo source bytes (an
 * inline credential) and warn to stderr, so it routes through the sensitive-file
 * chokepoint (see sensitiveFile.ts); on any parse failure this reports the path
 * and reconciliation guidance, never the parser's message. A schema failure from
 * parseExchangeSpec (Zod) names field paths and issue kinds, not the offending
 * values, so its message is safe to surface.
 */
function readExistingAcceptConfig(
  configPath: string,
  sources: { against: string; retryWith: string },
): ExchangeSpec | undefined {
  if (detectFileConflicts([configPath]).length === 0) return undefined;
  const { against, retryWith } = sources;
  let parsed: unknown;
  try {
    // The chokepoint's own path-only message is discarded by the catch below,
    // which re-labels with reconciliation guidance; the label is passed only to
    // keep the call signature uniform.
    parsed = parseSensitiveYaml(
      fs.readFileSync(configPath, "utf8"),
      `a configuration file at ${configPath}`,
    );
  } catch {
    throw new UsageError(
      `a configuration file already exists at ${configPath} but is not valid ` +
        `YAML, so it cannot be compared against ${against}. Fix or remove it, ` +
        `or pass --config-file to write elsewhere, then retry with ${retryWith}.`,
    );
  }
  try {
    return parseExchangeSpec(parsed);
  } catch (err) {
    throw new UsageError(
      `a configuration file already exists at ${configPath} but could not be ` +
        `parsed to compare against ${against}: ` +
        describeDecodeError(err) +
        `. Fix or remove it, or pass --config-file to write elsewhere, then ` +
        `retry with ${retryWith}.`,
    );
  }
}

/**
 * Reconcile a pre-existing configuration file against an acceptance. Returns
 * `false` when no config was at `configPath` (a fresh one will be written);
 * `true` when one was and it agrees with the invitation (and, online, the URL),
 * so it is kept and only the key file is written. Throws a {@link UsageError} --
 * before the prompt and before any network activity -- when it disagrees,
 * showing the user exactly what to resolve.
 *
 * Both accept-reuse paths -- offline, and online ahead of any network activity --
 * reach the received-payload warning below through this one call, so a single
 * wording covers both and lands before the confirmation prompt, where the
 * operator can still decline what it reports.
 */
function reconcileAcceptConfig(params: {
  configPath: string;
  /**
   * The configuration already at `configPath` as {@link validateAccept} read
   * it, or `undefined` where none is there. Passed in rather than read here so
   * the label this acceptance runs under and the terms compared below come from
   * one read of one file.
   */
  existing: ExchangeSpec | undefined;
  myTerms: LinkageTerms;
  /**
   * The disclosed subset this acceptance consents to, from the invitation token.
   * Compared against the kept config's recorded lock-in only to warn about a
   * removal; what is persisted is decided by the caller's own write (see
   * {@link persistExpectedPayloadColumns}).
   */
  consentedPayloadColumns: string[] | undefined;
  target?: RunnableConnectionConfig;
  log: ReturnType<typeof getLogger>;
}): { reuse: boolean; existingOutputShares?: boolean } {
  const {
    configPath,
    existing,
    myTerms,
    consentedPayloadColumns,
    target,
    log,
  } = params;
  if (existing === undefined) return { reuse: false };
  // A `target` connection is present only online, which is what decides the
  // source(s) every message here names.
  const { against, retryWith } = reconciliationSources(target !== undefined);

  // Reported ahead of the reconciliation below, so a kept config's stale
  // citation reaches the operator whether or not its terms agree with the
  // invitation's -- it is a claim about this file's own rules either way. The
  // standing read here is the file's as it stands, before this acceptance
  // records itself on it: terms no earlier acceptance stands behind are still
  // the operator's alone to correct at this point.
  warnOnLinkageRuleSetCitationDrift(
    existing.linkageTerms,
    configPath,
    log,
    linkageTermsStandingOf(existing),
    "decline-to-reuse",
  );

  const { conflicts, warnings } = diffLinkageTerms(
    existing.linkageTerms,
    myTerms,
  );
  for (const w of warnings) log.warn(w);

  const conn: { conflicts: ReconcileDiff[]; warnings: string[] } =
    target !== undefined
      ? diffConnectionAgainstTarget(existing.connection, target)
      : { conflicts: [], warnings: [] };

  const all: ReconcileDiff[] = [...conflicts, ...conn.conflicts];
  if (all.length > 0)
    throw new UsageError(
      reconcileConflictMessage({ configPath, against, retryWith, diffs: all }),
    );

  // A connection field that is "how you reach the same drop" (protocol, port,
  // credentials) may differ without aborting: it applies to this exchange only,
  // and the saved config is deliberately left unchanged (we never clobber the
  // user's stored connection block). Surface the divergence so the user can
  // update the config themselves if they meant it to persist.
  if (conn.warnings.length > 0)
    log.warn(
      `the connection details you specified differ from the saved ` +
        `configuration at ${configPath}; they apply to this exchange only and ` +
        `the saved config is left unchanged:\n` +
        conn.warnings.map((w) => `  - ${w}`).join("\n"),
    );

  // A kept config recording a consented received set, re-accepted from an
  // invitation that carries no disclosed subset, has that record REMOVED -- the
  // contract leaves no set standing that this acceptance did not show -- and the
  // next run then reconciles the received payload lazily. The removal stands; the
  // warning is so giving up that check is a decision the operator sees at the
  // prompt rather than a silent consequence of accepting. A recorded EMPTY set is
  // named rather than listed: it is the strictest lock-in (receive nothing) and
  // has no column names to show. Each recorded name is partner-sourced (the
  // inviter's namespace), so it is redacted and escaped at this composition site
  // and printed one per line -- a name carrying a list separator cannot then be
  // misread as two.
  const recordedLockIn = existing.expectedPayloadColumns;
  if (recordedLockIn !== undefined && consentedPayloadColumns === undefined)
    log.warn(
      `this invitation declares no disclosed columns, so accepting it removes ` +
        `the received-payload lock-in recorded in ${configPath}. That lock-in ` +
        `holds the partner's payload to ` +
        (recordedLockIn.length === 0
          ? "no columns at all (a strict receive-nothing consent)."
          : "exactly these columns:\n" +
            recordedLockIn
              .map((column) => `  - ${redactAndSanitizeForDisplay(column)}`)
              .join("\n")) +
        `\nWithout it the next 'psilink exchange' from this configuration ` +
        `accepts whatever columns the partner transmits. To keep the check, ask ` +
        `the inviting party for an invitation that declares the columns it sends.`,
    );

  log.info(
    conn.warnings.length === 0
      ? `the existing configuration at ${configPath} matches ${against}; ` +
          "it will be reused with its connection and linkage settings unchanged."
      : `the existing configuration at ${configPath} will be reused with its ` +
          "connection and linkage settings unchanged; the connection " +
          "differences above apply to this exchange only.",
  );
  // The kept config's own output terms ride back with the verdict: the later
  // run is governed by them, and this diff deliberately compares no output
  // field, so a caller deciding what to record about the acceptor's outbound
  // set must not take the invitation's mirror as the kept config's reality.
  return {
    reuse: true,
    existingOutputShares: existing.linkageTerms.output.shareWithPartner,
  };
}

// --- Linkage preflight -------------------------------------------------------

// Accept adopts only the inviter's linkage terms and infers its standardization
// and metadata from its own CSV (default type-based pipelines, which never remap a
// column onto a field whose type is absent), so it passes neither override to the
// shared check and relies on name inference -- which matches the acceptor's
// exchange-time satisfiability exactly. The override arguments exist for the
// exchange path, whose committed config can carry a remap or an explicit type.
const INVITATION_PREFLIGHT_MESSAGING: LinkagePreflightMessaging = {
  source: "invitation",
  blockConsequence: RUN_BLOCK_CONSEQUENCE,
  blockRemedy:
    "or ask your partner for an invitation with different linkage terms.",
};

// --- Handler -----------------------------------------------------------------

export async function handler(argv: Arguments): Promise<void> {
  let closeLogging: (() => void) | undefined;
  try {
    await runOrExit("accept", async () => {
      // Parse and apply the log level before creating the logger, so the
      // configured level actually takes effect (loglevel binds a logger's level
      // at creation). Doing this inside runOrExit also routes an invalid option
      // (e.g. an unrecognized --log-level) through the same error->exit path as
      // everything else, rather than yargs's noisier top-level catch.
      const options = parseCommonBootstrapArgs(argv);
      // Install the sink, apply the level, and build getLogger("accept") through
      // the shared configureLogging helper (in that order, so the logger inherits
      // the sink): the file sink when --log-file is given, otherwise the default
      // stderr sink so stdout carries only result data (the exchange CSV when no
      // OUTPUT_FILE positional is given). A missing parent directory is a
      // UsageError -> exit 64, mapped here by the enclosing runOrExit.
      const { log, close } = configureLogging({
        logLevel: options.logLevel,
        logFile: options.logFile,
        name: "accept",
      });
      closeLogging = close;
      const positionals = (argv["args"] as Array<string> | undefined) ?? [];
      // This command sets unknown-options-as-args (so a `-`-leading invitation
      // survives as a positional), which also lets a mistyped `--flag` reach the
      // positionals rather than the top-level strictOptions; reject it here,
      // before the invitation decode, any connection, or any file write.
      assertNoUnknownOptions(positionals);
      const resolved = resolveAcceptPositionals(positionals);
      // --consent-to-terms records advance consent to the invitation's terms and
      // bypasses the confirmation prompt for unattended runs. Read as `=== true`
      // so an absent flag (a hand-built argv in tests, or a parse that did not set
      // it) is a definite false rather than undefined. A boolean option may be
      // repeated, so it is read directly, not via singleValue.
      const consentToTerms = argv["consent-to-terms"] === true;
      // All validation runs before the prompt: the user is never asked to confirm
      // an invitation, URL, or input file that has not validated, and the prompt
      // itself runs inside runOrExit so a stdin error exits cleanly rather than
      // crashing. consentToTerms also lets a `-` input read the CSV from stdin
      // (the prompt that otherwise owns stdin is skipped).
      const ready = await validateAccept({
        resolved,
        options,
        consentToTerms,
        log,
        // The identity question is asked exactly where the consent question is:
        // at a terminal, and only where --consent-to-terms has not declared the
        // run unattended. That is the same resolution the `-` CSV takes rather
        // than a rule of its own -- with the consent prompt running, stdin is
        // this session's; with it skipped, stdin may be the CSV and nothing
        // here may read it. Both questions then belong to one interactive
        // session, this one asking who the operator is before the terms they
        // answer for are shown.
        ...(process.stdin.isTTY === true && !consentToTerms
          ? {
              askIdentity: () => askIdentityAtPrompt(ACCEPT_IDENTITY_QUESTION),
            }
          : {}),
      });

      // The acceptor's own outbound-send set: the columns this party will disclose
      // to the partner for matched records, derived from its own resolved metadata
      // via the same isDisclosedToPartner predicate preparePayload transmits on, so
      // the prompt cannot overstate what leaves this machine.
      //
      // A running acceptance reads it off the PREPARED exchange -- the very object
      // this invocation transmits from -- rather than off the written spec, so the
      // set shown is the set sent. The offline path has no prepared exchange to
      // read: it writes a configuration and stops, so an acceptance given no input
      // file carries no metadata to read the set off, and the display
      // forward-references it.
      const ownMetadata =
        ready.mode === "offline"
          ? ready.dataSpec.metadata
          : ready.prepared.metadata;
      const ownOutboundSend =
        ownMetadata !== undefined
          ? disclosedColumnNames(ownMetadata)
          : undefined;
      // This party's consent to its OWN outbound set, recorded into the
      // configuration this acceptance writes so a later run cannot transmit a set no
      // party chose. Derived from the same metadata the display's set resolves from,
      // so what is recorded is exactly what the prompt below shows (or what
      // --consent-to-terms records advance consent to).
      const outboundPayloadConsent = deriveOutboundPayloadConsent(
        ready.dataSpec.linkageTerms.output,
        ownMetadata,
      );
      // What a REUSED config's record becomes. The later run is governed by the
      // kept config's own terms, and reconciliation compares no output field, so
      // an invitation whose mirror says "nothing transmitted" cannot decide that
      // about a kept config that still shares: deleting the record there would
      // leave the run's gate blind (it no-ops on an absent record) and transmit
      // an unconfirmed set on partner-controlled terms. Where the mirror yields
      // no record but the kept config shares, the safe record is `pending` --
      // this acceptance displayed and confirmed no outbound set for a config
      // that will transmit, so the next run shows and asks, or refuses
      // unattended. Undefined only where the kept config itself does not share
      // (or no config is kept), where a leftover record is inert against the
      // kept config's own terms.
      const reuseOutboundPayloadConsent: OutboundPayloadConsent | undefined =
        outboundPayloadConsent !== undefined
          ? outboundPayloadConsent
          : ready.existingOutputShares === true
            ? { status: "pending" }
            : undefined;
      // The coordination server this acceptance will dial itself, stated above
      // the terms and again in the question: on this path confirming is what
      // connects and transmits, and the locator is the invitation's rather than
      // anything the operator typed. The endpointRun path alone -- the
      // URL-driven mode's server is the URL the operator gave it, and an
      // acceptance that writes a configuration and stops dials nothing.
      const runsExchangeThrough =
        ready.mode === "endpointRun" ? ready.brokerAuthority : undefined;
      // Rendered through a sink that knows whether the prompt below will run: when
      // it will, the terms reach the terminal it asks on even when the operator
      // routed diagnostics to a --log-file or above info, so consent is never asked
      // for terms this run did not show. --consent-to-terms asks nothing, so its
      // surface stays plain diagnostic output on the routing the operator chose.
      const consentSurface = consentSurfaceSink({
        log,
        logFile: options.logFile,
        willPrompt: !consentToTerms,
      });
      displayInvitation({
        token: ready.token,
        ownOutboundSend,
        emit: consentSurface,
        promptFollows: !consentToTerms,
        runsExchangeThrough,
      });
      // With --consent-to-terms, skip the prompt and proceed on the recorded
      // advance consent. Log the bypass so an unattended run's own log shows the
      // human checkpoint was deliberately satisfied ahead of time, not silently
      // absent.
      let confirmed: boolean;
      if (consentToTerms) {
        log.info(
          "--consent-to-terms given: proceeding on advance consent without the " +
            "confirmation prompt.",
        );
        confirmed = true;
      } else {
        // The question names what answering yes does. Where this acceptance runs
        // the exchange it also carries the coordination server, escaped at this
        // sink as it is at the display's: the terms run past a screen, so the
        // locator stated above them has scrolled away by the time the question
        // arrives, and this is the line that has not.
        confirmed = await promptConfirm(
          runsExchangeThrough !== undefined
            ? "Accept this invitation and run the exchange now, through " +
                `${renderDialedBroker(runsExchangeThrough)}?`
            : "Accept this invitation and write configuration?",
        );
      }
      if (!confirmed) {
        // The answer goes back through the surface's own sink rather than the
        // logger: it is what became of the question, so it belongs on the terminal
        // that asked whatever the operator set --log-level to. That is also what
        // tells a decline from an acceptance at a level carrying neither's log
        // lines -- an acceptance goes on to write files and run, a decline says
        // this and stops, and both exit 0.
        consentSurface("invitation declined; no files were written");
        return;
      }

      // The two running modes reach one bootstrap: what differs between them is
      // where the connection came from -- the acceptance's own URL, or the
      // invitation's webrtc endpoint -- and that decision was made in
      // validateAccept. Everything from here (the config, key file, record,
      // result, and every consent record below) is written identically.
      if (ready.mode === "online" || ready.mode === "endpointRun") {
        const { configWriteError } = await runOnlineBootstrap({
          connection: ready.connection,
          dataSpec: ready.dataSpec,
          prepared: ready.prepared,
          sharedSecret: ready.token.sharedSecret,
          // Pass the invitation's expiry through unchanged; authenticateConnection
          // re-checks it before and after the key exchange.
          expires: ready.token.expires,
          keyPath: options.keyFile,
          configPath: options.configFile,
          output: ready.output,
          verbosity: options.verbosity,
          loggerName: "accept",
          recordOutput: resolveRecordOutput({
            enabled: options.record,
            recordFile: options.recordFile,
          }),
          eventStream: options.eventStream,
          reuseExistingConfig: ready.reuseExistingConfig,
          // Persist the consented received-column lock-in so the later `psilink
          // exchange` enforces it, the online sibling of the offline path's
          // expectedPayloadColumns write below. The set is known up front from the
          // token (in the inviter's namespace), so it rides the acceptance hook's
          // first write on a fresh config and refreshes the kept config's field
          // surgically on the reuse path -- the operator has just re-consented on
          // THIS acceptance, and a prior acceptance's set left standing would
          // false-abort the next recurring exchange. reconcileReceivedPayload then
          // fails closed on a divergent received payload. Consented columns of
          // undefined -- an invitation carrying no disclosed subset -- record no
          // lock-in and remove a stale one, leaving the exchange to reconcile lazily.
          receivedPayloadLockIn: {
            consentedColumns: ready.token.disclosedPayloadColumns,
          },
          // Record this party's consent to its own outbound set in the same fresh
          // write, so a later `psilink exchange` from this configuration is held to
          // the columns just consented to here. The reuse path writes no fresh
          // config; the hook refreshes the kept config's record surgically instead,
          // with the record derived for the KEPT config's own output terms (the
          // reuse derivation above) -- identical to the invitation-derived record
          // on the fresh path, where the written config's terms are the mirror's.
          outboundPayloadConsent: reuseOutboundPayloadConsent,
          // Record the invitation's declared cardinality side in the same write,
          // and refresh it in place under reuse, so a later `psilink exchange`
          // from this configuration refuses a partner presenting a value this
          // acceptance did not consent to. The in-memory binding set on `prepared`
          // covers only this single run. Unlike the received-column lock-in it has
          // no "carried nothing" case: `deduplicate` is mandatory in the linkage
          // terms every invitation carries.
          expectedPartnerDeduplicate: ready.token.linkageTerms.deduplicate,
        });
        // The summary only; the exit code a failed persistence implies was set
        // where that persistence was lost, so nothing here can raise or lower it.
        logOnlineBootstrapOutcome(log, {
          configFile: options.configFile,
          keyFile: options.keyFile,
          configWriteError,
          reuseExistingConfig: ready.reuseExistingConfig,
        });
        return;
      }

      const spec: ExchangeSpec = {
        connection: ready.connection,
        ...ready.dataSpec,
        // Persist the consented received-column lock-in so the later `psilink
        // exchange` enforces it. Offline accept's enforcement happens at a separate
        // invocation, so it must be written here; the online path persists the same
        // set into its own fresh config (via runOnlineBootstrap above) in addition to
        // enforcing it in memory for its single run. Carried in the inviter's
        // namespace, distinct from payload.receive. Omitted -- and reconciled lazily
        // -- when the invitation carried no disclosed subset (an older or
        // metadata-unknown mint).
        ...(ready.token.disclosedPayloadColumns !== undefined
          ? { expectedPayloadColumns: ready.token.disclosedPayloadColumns }
          : {}),
        // Persist the invitation's declared cardinality side so the later
        // `psilink exchange` holds the partner's presented value to it
        // (assertPresentedDeduplicateMatchesInvitation). The terms-side twin of
        // the received-column lock-in above, and needed here for the same reason:
        // offline accept's enforcement happens at a separate invocation, so a
        // declaration held only in memory would bind nothing. The invitation's
        // linkage terms carry the INVITER's own side; this party's own value is
        // the mirror's false and rides `linkageTerms` in the spread above.
        expectedPartnerDeduplicate: ready.token.linkageTerms.deduplicate,
        // This party's consent to its own outbound set (see its derivation above),
        // so the later `psilink exchange` sends exactly what was consented to here
        // or stops to ask. Omitted -- and the run left ungated -- only where nothing
        // is transmitted to the partner at all.
        ...(outboundPayloadConsent !== undefined
          ? { outboundPayloadConsent }
          : {}),
      };
      // When reusing a pre-existing config, provisionConfigAndKey ignores `spec`
      // and writes only the key file, leaving the user's config untouched.
      const { configPath, keyPath } = provisionConfigAndKey(
        spec,
        // The acceptor's key file holds the invitation token without an expiry; the
        // inviter's copy carries the expiry. The token rotates on first exchange.
        { sharedSecret: ready.token.sharedSecret },
        { configPath: options.configFile, keyPath: options.keyFile },
        { reuseExistingConfig: ready.reuseExistingConfig },
      );

      if (ready.reuseExistingConfig) {
        // Refresh the consented received-column lock-in in the reused config. The
        // operator has just re-consented to THIS invitation's terms (the prompt
        // above, or --consent-to-terms, gates every write here), so the lock-in is
        // rewritten to the set they consented to on this acceptance -- the token's
        // disclosed subset, in the inviter's namespace. Unlike the connection and
        // linkage blocks (operator prose provisionConfigAndKey deliberately leaves
        // untouched under reuse), this is a machine-managed consent record: leaving
        // a prior acceptance's value stale would false-abort the next recurring
        // exchange after a legitimate re-consent to a changed disclosure. A surgical
        // one-field write; undefined (an older or metadata-unknown mint) removes the
        // field so the exchange reconciles lazily, an empty set is a strict "receive
        // nothing". The fresh-config paths persist the same set via their own write.
        persistExpectedPayloadColumns(
          configPath,
          ready.token.disclosedPayloadColumns,
        );
        // Refresh the invitation's declared cardinality side in the reused config
        // for the same reason and at the same moment: the operator has just
        // consented to THIS invitation's declaration, so a prior acceptance's
        // value is rewritten rather than left to bind the next recurring exchange
        // to terms nobody consented to. Always a boolean here -- the linkage-terms
        // schema makes `deduplicate` mandatory -- so this acceptance never leaves
        // the kept config unbound.
        persistExpectedPartnerDeduplicate(
          configPath,
          ready.token.linkageTerms.deduplicate,
        );
        // Refresh this party's own outbound-set consent in the reused config for the
        // same reason: the operator has just re-consented on THIS acceptance, so the
        // record is rewritten to what they were shown here rather than left at a
        // prior acceptance's value. Where this acceptance could not resolve the set
        // it records `pending`, which asks at the first run that can. The removal
        // case follows the KEPT config's own output terms, not the invitation's
        // mirror (the reuse derivation above): reconciliation compares no output
        // field, so a partner-supplied invitation must not be able to delete the
        // record from a config that still transmits.
        persistOutboundPayloadConsent(configPath, reuseOutboundPayloadConsent);
        log.info(
          `reused the existing configuration at ${configPath}; it already matches ` +
            "the invitation, so the connection and linkage settings are unchanged.",
        );
      } else if (ready.seeded && ready.connection.channel === "webrtc")
        // A webrtc connection block is complete as seeded: the endpoint is the
        // whole locator and the channel authenticates from the shared secret, so
        // there is no credential for the operator to add before running it.
        log.info(
          `wrote config to ${configPath}, seeding the connection block from the ` +
            "invitation's endpoint; it needs no credentials of your own. Run " +
            "'psilink exchange' with your input file to conduct the exchange.",
        );
      else if (ready.seeded)
        log.info(
          `wrote config to ${configPath}, seeding the connection block from the ` +
            "invitation's endpoint; review it and add your own credentials " +
            "before running 'psilink exchange'.",
        );
      else
        log.info(
          `wrote config to ${configPath}; fill in the connection block before ` +
            "running 'psilink exchange'.",
        );
      log.info(`wrote key file to ${keyPath}. Keep it private.`);
    });
  } finally {
    // Restore the loglevel factory (and close the log-file descriptor, for the
    // file sink) on the normal exit path. Writes are synchronous and already
    // durable, so the error path's process.exit (which bypasses this finally)
    // loses nothing -- this is only factory/descriptor cleanup.
    closeLogging?.();
  }
}
