import type { Argv, Arguments } from "yargs";

import {
  getLogger,
  encodeInvitation,
  assertDisclosedNamesCarriable,
  CONNECTION_BLOCK_NOTICE,
  DEFAULT_PEER_TIMEOUT_MS,
  disclosedColumnNames,
  inferMetadata,
  INVITATION_LIFETIME_SECONDS,
  MAX_INVITATION_LIFETIME_SECONDS,
  operatorSuppliedText,
  redactAndRenderOperatorSuppliedText,
  redactAndSanitizeForDisplay,
  MAX_RELAY_LOCATOR_URL_LENGTH,
  MAX_RELAY_LOCATOR_URLS,
  StunUrlSchema,
  TurnUrlSchema,
  UsageError,
} from "@alcove/core";
import type {
  ConnectionConfig,
  ConnectionEndpoint,
  ExchangeSpec,
  LinkageStrategy,
  LinkageTerms,
  Metadata,
  PreparedExchange,
  WebRTCConnectionConfig,
} from "@alcove/core";

import {
  csvDelimiterForRun,
  loadConfigLinkageSource,
  loadConfigWebRTCConnection,
  persistOutboundPayloadConsent,
  warnOnLinkageRuleSetCitationDrift,
} from "../config";
import { writeTermsRecord } from "../acceptedTermsRecords";
import { assertConfigTermsRunnable } from "../configTermsGuards";
import { resolveIdentity, resolveInvitationIdentity } from "../partyIdentity";
import { resolveRecordOutput } from "../recordFile";
import { DURATION_VALUE_HELP, parseDuration } from "../util/duration";
import { runOrExit } from "../util/exit";
import {
  assertNoUnknownOptions,
  csvDelimiterFlag,
  durationFlagSeconds,
  MAX_TIMEOUT_SECONDS,
  singleValue,
} from "../util/flags";
import { configureLogging } from "../util/logging";
import { redactUrlCredentials } from "../util/connectionUrl";
import {
  checkLinkageSatisfiability,
  COVER_REQUIRED_FIELD_TYPES,
  type LinkagePreflightMessaging,
} from "./linkagePreflight";
import { assertNoProvisionConflicts, provisionConfigAndKey } from "./provision";
import {
  inviterConnectionFromURL,
  isWebAppAddress,
  type InviterConnectionConfig,
  type InviterOwnRelay,
} from "../connectionFromUrl";
import { withWebRTCPeerRole } from "../webrtcPeerRole";
import { DEFAULT_WEBRTC_INACTIVITY_TIMEOUT_MS } from "../connection/webrtc/webrtcMessageConnection";
import {
  brokerLocationFromConnection,
  DEFAULT_CHANNEL_OPEN_TIMEOUT_MS,
  DEFAULT_RENDEZVOUS_TIMEOUT_MS,
} from "../connection/webrtc/weriftPeer";
import {
  addCommonBootstrapOptions,
  addCsvDelimiterOption,
  connectionOverridesFrom,
  parseCommonBootstrapArgs,
  warnConnectionPerPollShortInterval,
  warnLowPollingFrequency,
  warnOptionsOverridesIgnoredOffline,
  warnServerOverridesIgnoredOffline,
  warnUnsupportedFileSyncFlags,
  warnUnsupportedWebRTCServerFlags,
  type CommonBootstrapOptions,
} from "../optionDefinitions";
import {
  buildDataSpec,
  connectionFromEndpoint,
  describeInputSource,
  endpointFromConnection,
  DEFAULT_ACCEPT_TIMEOUT_SECONDS,
  expiresFromNow,
  generateSharedSecret,
  loadInputRows,
  logOnlineBootstrapOutcome,
  looksLikeUrl,
  parseLinkageStrategyFlag,
  prepareForOnlineExchange,
  runOnlineBootstrap,
  singlePassDisclosureNotice,
  type ResolvedDataSpec,
} from "../onlineBootstrap";

// The invitation lifetime default and one-year ceiling are shared from
// @alcove/core (INVITATION_LIFETIME_SECONDS, MAX_INVITATION_LIFETIME_SECONDS) so
// the CLI and the web inviter cannot drift. The default lifetime is distinct from
// --accept-timeout, which bounds how long the inviter waits at the rendezvous,
// not how long the token stays valid; --expires-in overrides the default up to
// the ceiling (see the builder option and validateInvite).

export function builder(cmd: Argv): Argv {
  return addCommonBootstrapOptions(
    addCsvDelimiterOption(cmd)
      // Capture all positionals into `args` (rather than relying on the global
      // `_`) and treat an unknown `-`-leading token as a positional, so an
      // input path is never misread as a flag. Scoped to this command so the
      // other commands' parsing is unaffected.
      .parserConfiguration({ "unknown-options-as-args": true })
      .positional("args", {
        type: "string",
        array: true,
        // Offline, INPUT_FILE is optional: linkage terms come from a pre-existing
        // config when one is present, and are inferred from INPUT_FILE otherwise.
        // Online still requires INPUT_FILE (the data to exchange).
        describe:
          "[INPUT_FILE] (offline), or URL INPUT_FILE [OUTPUT_FILE] (online)",
      })
      .usage(
        "Usage:\n" +
          "  $0 invite [options] [INPUT_FILE]                       (offline)\n" +
          "  $0 invite [options] URL INPUT_FILE [OUTPUT_FILE]       (online)\n\n" +
          "Offline: generate an invitation string and key file to share with a\n" +
          "partner out-of-band. Online: also connect, wait for the partner to\n" +
          "accept, and run the exchange. Offline, linkage terms are taken from a\n" +
          "pre-existing configuration file when present (the INPUT_FILE, if given,\n" +
          "is checked against it) and inferred from INPUT_FILE otherwise.\n\n" +
          "Online, URL is the web app's address (e.g. https://app.example.org/),\n" +
          "a ws:// or wss:// coordination server, or an sftp://, ssh://, or\n" +
          "file:// exchange directory.\n\n" +
          "INPUT_FILE may be `-` to read the CSV from stdin.",
      ),
  )
    .option("accept-timeout", {
      type: "string",
      describe:
        "online only: how long to wait for the partner to accept before " +
        `giving up (default: ${DEFAULT_ACCEPT_TIMEOUT_SECONDS}s, maximum: ` +
        `${MAX_TIMEOUT_SECONDS / 86_400}d). ` +
        DURATION_VALUE_HELP,
    })
    .option("expires-in", {
      type: "string",
      describe:
        "override the invitation lifetime (default: 1 hour, maximum: 365d). " +
        DURATION_VALUE_HELP,
    })
    .option("linkage-strategy", {
      type: "string",
      describe:
        "how the agreed linkage keys are run on the wire (default: cascade). " +
        "cascade runs one dependent PSI round per key; single-pass batches " +
        "every key into one exchange for a constant round-trip count, at the " +
        "cost of disclosing your full per-key value structure to the receiver " +
        "-- a consented disclosure tradeoff, not a free speed-up. Has no " +
        "effect when linkage terms come from an existing configuration file " +
        "(set linkage_strategy there). See " +
        "https://github.com/georgetown-mdi/alcove/blob/main/docs/" +
        "EXCHANGE_REFERENCE.md (linkage_terms.linkage_strategy).",
    })
    .option("turn", {
      type: "string",
      describe:
        "online webrtc invitation only (an http://, https://, ws://, or " +
        "wss:// URL): a TURN relay url (turn: or turns:) " +
        "named in the invitation for your partner and saved as a " +
        "connection.turn entry. Each run signs in with a credential minted " +
        "from the shared secret, so the relay must accept those and the url " +
        "takes no username or credential. Repeat the flag to name more than " +
        "one.",
    })
    .option("stun", {
      type: "string",
      describe:
        "online webrtc invitation only (an http://, https://, ws://, or " +
        "wss:// URL): a STUN server url (stun: or " +
        "stuns:) named in the invitation for your partner and saved in " +
        "connection.stun, in place of the built-in default. Repeat the flag " +
        "to name more than one.",
    });
}

/**
 * Read a repeatable relay url flag (`--turn` / `--stun`) off parsed args:
 * `undefined` when absent, else every occurrence in order, each checked
 * against the connection block's own url grammar. A refusal names the flag
 * and which occurrence, never the value, which may hold a pasted credential.
 *
 * @internal exported for testing
 */
export function relayUrlFlag(
  argv: Arguments,
  name: "turn" | "stun",
): string[] | undefined {
  const raw = argv[name];
  if (raw === undefined) return undefined;
  const values = (Array.isArray(raw) ? raw : [raw]).map(String);
  const schema = name === "turn" ? TurnUrlSchema : StunUrlSchema;
  return values.map((value, index) => {
    const result = schema.safeParse(value);
    if (!result.success)
      throw new UsageError(
        `--${name}` +
          (values.length > 1 ? ` (occurrence ${index + 1})` : "") +
          `: ${result.error.issues.map((issue) => issue.message).join("; ")}`,
      );
    return result.data;
  });
}

/**
 * The invitation endpoint for `connection`, refused as a {@link UsageError}
 * before the token exists when its relay names more urls, or a longer url,
 * than an invitation holds; the token schema would otherwise throw a raw
 * ZodError. `relayFields` names where the operator set each list: the flags
 * online, the configuration fields offline. The url itself is never echoed,
 * since it may hold a pasted credential.
 */
function invitationEndpoint(
  connection: Parameters<typeof endpointFromConnection>[0],
  relayFields: { turn: string; stun: string },
): ConnectionEndpoint {
  const endpoint = endpointFromConnection(connection);
  if (endpoint.channel !== "webrtc" || endpoint.relay === undefined)
    return endpoint;
  for (const name of ["turn", "stun"] as const) {
    const urls = endpoint.relay[name] ?? [];
    const field = relayFields[name];
    if (urls.length > MAX_RELAY_LOCATOR_URLS)
      throw new UsageError(
        `${field} names too many urls to hold in an invitation ` +
          `(${urls.length} > ${MAX_RELAY_LOCATOR_URLS}); name at most ` +
          `${MAX_RELAY_LOCATOR_URLS}.`,
      );
    for (const url of urls)
      if (url.length > MAX_RELAY_LOCATOR_URL_LENGTH)
        throw new UsageError(
          `a ${field} url is too long to hold in an invitation ` +
            `(${url.length} > ${MAX_RELAY_LOCATOR_URL_LENGTH} characters); ` +
            "shorten it.",
        );
  }
  return endpoint;
}

/** The names of the `--turn` / `--stun` flags an invocation gave. */
function relayFlagsGiven(
  ownRelay: InviterOwnRelay | undefined,
): Array<"turn" | "stun"> {
  return (["turn", "stun"] as const).filter(
    (name) => ownRelay?.[name] !== undefined,
  );
}

/**
 * The invitation endpoint an offline invite names for the webrtc connection
 * in its configuration: the coordination server and the relay from
 * `connection.turn` / `connection.stun`, through the same
 * {@link endpointFromConnection} the online path uses. The mount point is
 * resolved as this CLI dials it first, since a partner running another client
 * resolves an absent one to its own default; a shape the dial would refuse is
 * a usage error here, before the token exists.
 */
function offlineWebRTCEndpoint(
  connection: WebRTCConnectionConfig,
): ConnectionEndpoint {
  const { path } = brokerLocationFromConnection(connection.server, () => {});
  return invitationEndpoint(
    { ...connection, server: { ...connection.server, path } },
    { turn: "connection.turn", stun: "connection.stun" },
  );
}

/**
 * The warning for an invitation whose webrtc endpoint names a plaintext
 * (ws://) coordination server: an endpoint has no scheme field, so the
 * acceptor seeded from it dials TLS and would meet nobody.
 */
function plaintextEndpointWarning(remedy: string): string {
  return (
    "this invitation's connection endpoint names the coordination server " +
    "but not the plaintext (ws://) scheme, which an endpoint has no " +
    "field for; your partner's configuration will be seeded to dial it " +
    "over TLS (wss://). Have them set `secure: false` on the connection " +
    `block before running 'alcove exchange', or ${remedy}.`
  );
}

// --- Positional parsing ------------------------------------------------------

// The URLs an online invite takes: the transport URLs the other commands take,
// plus a web app's address, which only this command resolves.
function isInviteUrl(value: string): boolean {
  if (looksLikeUrl(value)) return true;
  try {
    return isWebAppAddress(new URL(value));
  } catch {
    return false;
  }
}

/**
 * Classify the positional arguments as an offline or online invitation. The
 * first positional is a server URL (online) when it parses as a supported
 * transport URL or a web app's `http:`/`https:` address; otherwise it is the
 * optional input file (offline).
 *
 * @internal exported for testing
 */
export function resolveInvitePositionals(
  positionals: Array<unknown>,
):
  | { mode: "offline"; input?: string }
  | { mode: "online"; url: URL; input: string; output?: string } {
  const arg0 =
    positionals[0] !== undefined ? String(positionals[0]) : undefined;

  if (arg0 !== undefined && isInviteUrl(arg0)) {
    const input =
      positionals[1] !== undefined ? String(positionals[1]) : undefined;
    if (input === undefined)
      throw new UsageError(
        "online invitation requires an input file; usage: alcove invite " +
          "--identity IDENTITY URL INPUT_FILE [OUTPUT_FILE]",
      );
    const output =
      positionals[2] !== undefined ? String(positionals[2]) : undefined;
    return { mode: "online", url: new URL(arg0), input, output };
  }

  return { mode: "offline", input: arg0 };
}

/**
 * The disclosed-columns subset the invitation includes: the columns the
 * acceptor will receive for matched records, from this party's metadata via
 * the same `isDisclosedToPartner` predicate `preparePayload` transmits on.
 * Undefined when the metadata is unknown at mint (a config-as-source invite
 * whose config declares no metadata block); otherwise the set is included
 * verbatim, including the empty set, which locks the acceptor to receiving
 * nothing. See the InvitationToken field.
 */
function disclosedColumnsFor(
  metadata: Metadata | undefined,
): string[] | undefined {
  if (metadata === undefined) return undefined;
  return disclosedColumnNames(metadata);
}

/**
 * Mint-time wording for the shared linkage pre-flight
 * ({@link checkLinkageSatisfiability}): core grades the terms, this function
 * supplies the copy for {@link LinkagePreflightMessaging}. `configPath` names
 * the file the terms came from, composed raw -- the CLI's error boundary
 * escapes the rendered chain once.
 */
function mintPreflightMessaging(configPath: string): LinkagePreflightMessaging {
  return {
    source: "configuration",
    blockConsequence:
      "Generating an invitation would hand your partner terms that this " +
      "configuration's own exchange refuses to run, discovered only after " +
      "they had accepted them.",
    blockRemedy: `then generate the invitation again; these terms come from ${configPath}.`,
    termsStanding: "draft",
  };
}

/**
 * The same mint-time wording for the online path, whose linkage terms are
 * derived from the input file's own columns rather than read from a
 * configuration: `inputPath` names that file, unlike `configPath` above the
 * online path's input may be the stdin sentinel `-`, so it is named through
 * {@link describeInputSource} rather than composed raw. Nobody has authored
 * a terms document here, so the keyless refusal leads with the input-side
 * remedy the shortfall refusal already gives.
 */
function onlineMintPreflightMessaging(
  inputPath: string,
): LinkagePreflightMessaging {
  return {
    source: "input file",
    blockConsequence:
      "Generating an invitation would hand your partner terms that the " +
      "exchange it starts refuses to run, discovered only after they had " +
      "accepted them.",
    blockRemedy:
      "then generate the invitation again; these terms are derived from " +
      `${describeInputSource(inputPath)}.`,
    termsStanding: "draft",
    keylessRemedyLead: COVER_REQUIRED_FIELD_TYPES,
  };
}

// --- Validation (the no-commit phase) ----------------------------------------

/**
 * Everything an invitation needs that is fallible but free of the gating side
 * effects (printing the token, writing files, opening a connection): conflict
 * detection, URL validation (online), input reading, and minting+encoding the
 * invitation. The caller's commit step performs the side effects from this
 * bundle, so a failure here aborts before the live token reaches stdout or a
 * config is written. Diagnostics are logged here, before the token print.
 */
type InviteReady =
  | {
      mode: "online";
      url: URL;
      output?: string;
      connection: InviterConnectionConfig;
      dataSpec: ResolvedDataSpec;
      prepared: PreparedExchange;
      invitation: string;
      expires: string;
      sharedSecret: string;
    }
  | {
      // Offline with no pre-existing config: terms are inferred from the input
      // file, and both the config and the key file are written.
      mode: "offline";
      dataSpec: ResolvedDataSpec;
      invitation: string;
      expires: string;
      sharedSecret: string;
    }
  | {
      // Offline sourcing terms from a pre-existing config: the config supplies
      // the linkage terms (and its operator-authored content persists unchanged),
      // so the key file is written and the machine-managed
      // disclosed_payload_columns commitment is refreshed in place. When an input
      // file was also supplied it has already been checked against the config's
      // linkage fields here.
      mode: "offlineFromConfig";
      configPath: string;
      linkageTerms: LinkageTerms;
      // The disclosed set this re-invite published (this party's own namespace),
      // persisted into the reused config so a later exchange can verify it still
      // holds; undefined when the config declares no metadata (reconcile lazily,
      // and any stale field is removed). See persistDisclosedPayloadColumns.
      disclosedPayloadColumns?: string[];
      invitation: string;
      expires: string;
      sharedSecret: string;
    };

/**
 * Validate and prepare an invitation without committing any side effect. Throws
 * (for the shared {@link runOrExit} mapper) on any failure; mints `expires` and
 * the shared secret at encode time, so the lifetime clock starts when the
 * shared secret exists, not at process entry.
 *
 * `expiresIn`, when given, overrides the default 1-hour lifetime and is parsed
 * (rejecting zero, negative, or malformed values) before any conflict gate,
 * input read, or token mint.
 *
 * `linkageStrategy`, when given, applies only to terms this command authors
 * from the input (the online and infer-from-input paths); a pre-existing
 * configuration file is authoritative instead, and the selection is reported
 * as ignored. Selecting `single-pass` shows the disclosure-tradeoff note.
 *
 * `--identity` follows the same rule: the two paths that author terms require
 * it, while the config-as-source path takes the label from the config's own
 * `linkage_terms.identity` and warns the flag had no effect. Every path
 * requires an identity; an invitation names its inviter.
 *
 * @internal exported for testing
 */
export async function validateInvite(params: {
  resolved: ReturnType<typeof resolveInvitePositionals>;
  options: CommonBootstrapOptions;
  acceptTimeout: number;
  expiresIn?: string;
  linkageStrategy?: LinkageStrategy;
  /** The field delimiter this run reads its input by and, on the online path,
   * writes its result with; recorded in the configuration this command writes
   * so the recurring exchange it governs needs no flag. */
  csvDelimiter?: string;
  /** The relay `--turn` / `--stun` name, applied on a webrtc URL (http://, https://, ws://, or wss://). */
  ownRelay?: InviterOwnRelay;
  log: ReturnType<typeof getLogger>;
}): Promise<InviteReady> {
  const {
    resolved,
    options,
    acceptTimeout,
    expiresIn,
    linkageStrategy,
    csvDelimiter,
    ownRelay,
    log,
  } = params;
  const delimiterSection = csvDelimiter !== undefined ? { csvDelimiter } : {};
  // parseDuration yields whole milliseconds at second granularity (its smallest
  // unit), so dividing by 1000 is exact: the lifetime is always a whole number
  // of seconds, whether defaulted or overridden, and feeds expiresFromNow below.
  const lifetimeSeconds =
    expiresIn !== undefined
      ? parseDuration(expiresIn) / 1000
      : INVITATION_LIFETIME_SECONDS;
  // Reject an override past the ceiling before any side effect (mirrors the
  // zero/negative rejection inside parseDuration). The default path cannot
  // exceed it, so only an --expires-in override is ever bounded here.
  if (lifetimeSeconds > MAX_INVITATION_LIFETIME_SECONDS)
    throw new UsageError(
      `--expires-in must not exceed ${MAX_INVITATION_LIFETIME_SECONDS / 86400}d ` +
        `(the maximum invitation lifetime); got ${expiresIn}`,
    );

  // The input is read at most once per invocation. The online branch below and
  // the two offline branches (config-as-source, and infer-from-input) are
  // mutually exclusive -- each returns -- and each reads the input through a
  // single loadInputRows call with allowStdin enabled. When the input is `-`
  // that stream is process.stdin, which is single-use, so this exclusivity is
  // critical: merging these branches such that two loadInputRows calls could
  // both run would read stdin twice and silently yield empty rows the second time.
  if (resolved.mode === "online") {
    const { url, input, output } = resolved;
    // This path authors its terms from the input file, so the label is the
    // operator's to supply; refuse before any probe, mint, or write.
    const identity = resolveIdentity(options.identity);
    // A non-positive accept-timeout is a pure usage error; reject it before any
    // filesystem probe or connection construction. The CLI handler already
    // rejects a non-positive or malformed value when it parses the flag
    // (durationFlagSeconds -> parseDurationFlag -> parseDuration), so this is
    // unreachable from the command line; it is kept as an independent guard
    // because validateInvite is exported and driven with a raw numeric
    // acceptTimeout that does not pass through that parse (invite.test.ts,
    // "validateInvite: a non-positive accept-timeout is rejected").
    if (acceptTimeout <= 0)
      throw new UsageError(
        `accept-timeout must be a positive duration; got ${acceptTimeout}s`,
      );
    // Detect a pre-existing config or key file before anything else so a
    // bootstrap never clobbers either partway through an exchange. Reusing a
    // pre-existing config as the linkage-terms source is a documented remaining
    // limitation (see docs/CLI.md "Online invitation").
    assertNoProvisionConflicts({
      configPath: options.configFile,
      keyPath: options.keyFile,
    });
    // Validate the URL before the token is minted, so an unusable URL (e.g. one
    // with no host) fails before the caller can disclose the token. The role is
    // stamped here because this command is the inviting end; on a ws:/wss: URL
    // that is what makes the connection dialable, since a URL has no role field.
    //
    // --accept-timeout is not merged in: this connection is what the bootstrap
    // persists, and an accept-only wait written as the config's peer_timeout_ms
    // would silently become the budget of every later recurring run. It reaches
    // this run alone, through runOnlineBootstrap's runOnlyPeerTimeoutSeconds.
    const connection = withWebRTCPeerRole(
      inviterConnectionFromURL(url, connectionOverridesFrom(options), ownRelay),
      "inviter",
    );
    // The file-sync half of this connection's options, absent on webrtc (whose
    // options block is the shared timeouts alone). The diagnostics and the retain
    // declaration below all read file-sync facts, so each reads it through here
    // rather than off a connection that may have no such field.
    const fileSyncOptions =
      connection.channel === "webrtc" ? undefined : connection.options;
    // Only on this online path -- the offline path reports the override ignored
    // (see below). A no-op on webrtc, which polls nothing.
    warnLowPollingFrequency(
      connection.channel,
      options.pollingFrequencyMs,
      log,
    );
    // Warn when a file-sync flag resolves to a channel that ignores it (a file://
    // URL is filedrop, which holds no session; a ws:// URL is webrtc, which has
    // no directory to poll or retain). applyConnectionOverrides drops each flag on
    // channels that cannot use it, so the raw flag is the only source of the
    // operator's intent; read it alongside the merged value a future persisted
    // source would set. --connection-per-poll on sftp is a no-op here --
    // warnConnectionPerPollShortInterval covers the short-interval case instead,
    // and the two never double-warn.
    warnUnsupportedFileSyncFlags(
      connection.channel,
      {
        locklessRendezvous: options.locklessRendezvous,
        retainFiles: options.retainFiles,
        pollingFrequencyMs: options.pollingFrequencyMs,
        connectionPerPoll:
          options.connectionPerPoll === true ||
          fileSyncOptions?.connectionPerPoll === true,
        peerId: options.peerId,
        timestampInFilename: options.timestampInFilename,
      },
      log,
    );
    // The server-block half of the same report: applyConnectionOverrides merges
    // that sub-group on sftp alone, so every --server-* flag typed at this
    // command's ws:/wss: URL is dropped, credentials included.
    warnUnsupportedWebRTCServerFlags(
      connection.channel,
      {
        serverPort: options.serverPort,
        serverUsername: options.serverUsername,
        serverPassword: options.serverPassword,
        serverPrivateKey: options.serverPrivateKey,
        serverPrivateKeyPassphrase: options.serverPrivateKeyPassphrase,
        serverKeyboardInteractive: options.serverKeyboardInteractive,
        serverHostKeyFingerprint: options.serverHostKeyFingerprint,
      },
      log,
      "url",
    );
    // A webrtc endpoint holds no scheme, so a plaintext coordination server is
    // one thing this invitation cannot convey: the acceptor seeded from it
    // resolves TLS and would meet nobody. Name it where the operator can still
    // act, beside the disclosure warning the dial itself raises.
    if (connection.channel === "webrtc" && connection.server.secure === false)
      log.warn(
        plaintextEndpointWarning(
          "invite over a wss:// coordination server or an https:// web app " +
            "address",
        ),
      );
    // The relay flags describe a webrtc connection's own relay; a file-sync
    // connection has none to name or save.
    if (connection.channel !== "webrtc")
      for (const name of relayFlagsGiven(ownRelay))
        log.warn(
          `--${name} applies only to a webrtc URL (http://, https://, ` +
            "ws://, or wss://); this " +
            `${connection.channel} invitation names no relay and saves ` +
            "none, so it was ignored.",
        );
    // Warn when --connection-per-poll is paired with a short poll interval. Built
    // from the URL with no loaded config, so `connection` holds the effective
    // mode and interval (the CLI overrides applied when it was built).
    warnConnectionPerPollShortInterval(
      connection.channel,
      fileSyncOptions?.connectionPerPoll,
      fileSyncOptions?.pollIntervalMs,
      log,
    );

    // --accept-timeout is this run's peer budget unconditionally, since it is
    // always set (by the flag or its default), so a --peer-timeout typed here
    // does not bound this wait. It is not discarded either: when the
    // configuration is written, it becomes the budget of the runs that follow.
    // This warning fires before the partner has accepted, so it states that
    // destination conditionally, naming both budgets rather than leaving the
    // operator to read silence as the one they asked for.
    if (options.peerTimeout !== undefined)
      log.warn(
        "--peer-timeout does not bound this online invitation: " +
          `--accept-timeout (${acceptTimeout}s) is this run's peer budget, ` +
          "bounding both the wait for the partner to accept and the peer waits " +
          "of the exchange that follows. When the configuration is saved, " +
          `--peer-timeout (${options.peerTimeout}s) is recorded in it as ` +
          "connection.options.peer_timeout_ms, the budget a later " +
          "'alcove exchange' runs on.",
      );

    // An accept-timeout longer than the token's lifetime would keep waiting at
    // the rendezvous past the point the token can be honored. Compare against
    // the resolved lifetime so an --expires-in override is respected here too.
    if (acceptTimeout > lifetimeSeconds)
      log.warn(
        `--accept-timeout (${acceptTimeout}s) exceeds the invitation ` +
          `lifetime (${lifetimeSeconds}s); the token will expire ` +
          "first and a later acceptance will be rejected.",
      );

    const rows = await loadInputRows(input, {
      allowStdin: true,
      csvDelimiter,
    });
    const builtDataSpec = {
      ...buildDataSpec({ identity, rows, linkageStrategy }),
      ...delimiterSection,
    };
    // Grade the derived terms before the token is minted and before any
    // connection is opened: the same verdict prepareForExchange enforces at the
    // run boundary, where it is stated on the agreed standing rather than on
    // this seat's draft one. The standardization and metadata are the ones that
    // grading reads, so the refusal lands exactly where the run's would.
    checkLinkageSatisfiability(
      rows.columns,
      builtDataSpec.linkageTerms,
      onlineMintPreflightMessaging(input),
      builtDataSpec.standardization,
      builtDataSpec.metadata,
    );
    noteSinglePassSelection(linkageStrategy, log);

    // The metadata this party's disclosure is read from: the same one
    // prepareForExchange uses (dataSpec.metadata, or inferred from the input
    // columns).
    const disclosureMetadata =
      builtDataSpec.metadata ??
      inferMetadata(rows.columns, rows.sanitizedColumnPositions);

    // Fail closed, before the token is minted or any file is written, on a
    // disclosed column whose name is too long to hold. This path infers its
    // metadata from the input header (no schema), so the name would otherwise
    // reach the token's own MAX_NAME_LENGTH bound inside encodeInvitation as a
    // raw ZodError, not an operator-facing refusal naming the position. The same
    // guard applies at exchange time in prepareForExchange. See
    // assertDisclosedNamesCarriable.
    assertDisclosedNamesCarriable(
      disclosureMetadata,
      builtDataSpec.linkageTerms.output,
    );

    // The columns this party will transmit for matched records, over that same
    // metadata, so the declared set equals what preparePayload transmits.
    // Included on the token and persisted into the saved config as
    // disclosedPayloadColumns, so a later recurring `alcove exchange` verifies
    // its current metadata still discloses exactly this set before any data is
    // sent (assertDisclosureMatchesCommitment) -- the send-side commitment the
    // online path would otherwise keep only on the discarded token.
    const disclosedPayloadColumns = disclosedColumnsFor(disclosureMetadata);
    const dataSpec: ResolvedDataSpec = {
      ...builtDataSpec,
      ...(disclosedPayloadColumns !== undefined
        ? { disclosedPayloadColumns }
        : {}),
    };

    const expires = expiresFromNow(lifetimeSeconds);
    const sharedSecret = generateSharedSecret();
    const invitation = await encodeInvitation({
      version: "1",
      linkageTerms: dataSpec.linkageTerms,
      sharedSecret,
      expires,
      // Embed the credential-free locator for the connection this invite is
      // using, so the acceptor seeds its connection block from it (the same path
      // web-originated invitations exercise) rather than reconstructing it by
      // hand. On webrtc that locator is all the acceptor needs to reach this
      // party's own coordination server. Derived from the post-override
      // `connection`, so a `--server-port` or `--outbound-path` override is
      // reflected; holds no credentials by construction (see
      // endpointFromConnection).
      connectionEndpoint: invitationEndpoint(connection, {
        turn: "--turn",
        stun: "--stun",
      }),
      // The same disclosed-columns subset persisted above: the acceptor's consent
      // screen and runtime enforcement derive from the wire's own disclosure
      // predicate.
      disclosedPayloadColumns,
      // Declare retain mode where this invite's own connection runs it, so the
      // acceptor is told before consenting that the exchange leaves a permanent
      // transcript. Read from the post-override connection, so `--retain-files`
      // is reflected; a declaration only, never applied on the accept side. A
      // webrtc run has no retain mode to declare, and the invitation schema
      // refuses the declaration beside a webrtc endpoint, so the two agree by
      // reading the file-sync options alone.
      ...(fileSyncOptions?.retainFiles === true
        ? { inviterRetainsFiles: true }
        : {}),
    });
    // prepareForOnlineExchange can throw; run it here, before the token print in
    // the caller's commit step, so a failure never follows disclosure.
    const prepared = await prepareForOnlineExchange(dataSpec, identity, rows);

    return {
      mode: "online",
      url,
      output,
      connection,
      dataSpec,
      prepared,
      invitation,
      expires,
      sharedSecret,
    };
  }

  // Offline: the server-block overrides (--server-* and --outbound-path) and the
  // connection-options overrides (timeouts, --max-reconnect-attempts, the
  // file-sync toggles) cannot take effect (the connection block is written as a
  // placeholder to edit, not built from a URL), so warn rather than silently
  // drop a flag the operator chose to pass. Two diagnostics: the server block
  // and the connection.options block have distinct remedies.
  warnServerOverridesIgnoredOffline(options, log);
  warnOptionsOverridesIgnoredOffline(options, log);
  for (const name of relayFlagsGiven(ownRelay))
    log.warn(
      `--${name} applies only to an online invitation over a webrtc URL ` +
        "(http://, https://, ws://, or wss://), so it was ignored. An " +
        "offline invitation names the " +
        `relay in connection.${name} of a webrtc configuration; set it there.`,
    );

  // Offline. Linkage terms come from a pre-existing config when one is present
  // at the config path, and are inferred from the input file otherwise.
  const configSource = loadConfigLinkageSource(options.configFile);

  if (configSource !== undefined) {
    const configTerms = configSource.linkageTerms;
    // The config is the source of the terms this mint uses, so a citation its
    // rules no longer support is reported before the token is built rather than
    // after it has left for the partner.
    warnOnLinkageRuleSetCitationDrift(
      configTerms,
      options.configFile,
      log,
      configSource.linkageTermsStanding,
      "author-fresh-terms",
    );
    // The config is the authoritative terms source here, so --linkage-strategy
    // cannot silently override its linkage_strategy; name it as ignored (like the
    // offline server/options override warnings above) and point at the config
    // field as the way to change it. The config's strategy is always materialized
    // (the schema default), so it can be stated plainly.
    if (linkageStrategy !== undefined)
      log.warn(
        `--linkage-strategy ${linkageStrategy} has no effect when the linkage ` +
          "terms come from an existing configuration file; the file's " +
          `linkage_strategy (${configTerms.linkageStrategy}) is used instead. ` +
          `Edit linkage_strategy in ${redactAndRenderOperatorSuppliedText(
            operatorSuppliedText(options.configFile),
          )} to change it.`,
      );
    // The identity is one of those terms, so it is governed by the same rule:
    // the config supplies the label this invitation is minted under, and a flag
    // typed here is reported rather than silently dropped. A configuration
    // holding none refuses instead -- an invitation names its inviter, and this
    // path cannot write the label anywhere the partnership's later runs would
    // read it. A blank flag value is nothing to report -- it is what a scripted
    // `--identity "$ORG"` sends with ORG unset, and the config supplies it
    // either way.
    const configIdentity = resolveInvitationIdentity(
      configTerms.identity,
      options.configFile,
    );
    const suppliedIdentity = options.identity?.trim();
    if (suppliedIdentity)
      log.warn(
        `--identity "${redactAndSanitizeForDisplay(suppliedIdentity)}" has no effect ` +
          "when the linkage terms come from an existing configuration file; " +
          "the file's linkage_terms.identity " +
          `("${redactAndSanitizeForDisplay(configIdentity)}") is used instead. ` +
          "Edit linkage_terms.identity in " +
          `${redactAndRenderOperatorSuppliedText(
            operatorSuppliedText(options.configFile),
          )} to change it.`,
      );
    // The delimiter this mint reads the input by: the flag for this run, else
    // the config's own, which is what the exchanges run from this file read
    // by. The config persists unchanged here, so a flag naming a different
    // delimiter is reported rather than written into it.
    const runCsvDelimiter = csvDelimiterForRun({
      configured: configSource.csvDelimiter,
      supplied: csvDelimiter,
      configPath: options.configFile,
      warn: (message) => log.warn(message),
    });
    // Config-as-source: the config supplies the linkage terms and persists
    // unchanged. The config read above is the mode discriminator, so it must run
    // first; the only conflict it can clobber here is an existing key file (the
    // config existing is expected), so gate just the key path -- the same
    // primitive accept uses when reusing a reconciled config -- before the input
    // is read or the token is minted, mirroring the online path's
    // conflicts-first order.
    assertNoProvisionConflicts(
      { configPath: options.configFile, keyPath: options.keyFile },
      ["key"],
    );

    if (resolved.input !== undefined) {
      const rows = await loadInputRows(resolved.input, {
        allowStdin: true,
        csvDelimiter: runCsvDelimiter,
      });
      // The input only validated compatibility; the invitation's terms come from
      // the config, not the input. Say so ahead of the check below, so a user who
      // passed an input expecting it to define the terms reads the refusal it can
      // raise against the right source.
      log.info(
        `a configuration file at ${redactAndRenderOperatorSuppliedText(
          operatorSuppliedText(options.configFile),
        )} is present; deriving ` +
          "the invitation's linkage terms from it and checking the input file " +
          "against those terms (the input does not redefine them). Pass " +
          "--config-file pointing at a new path to infer terms from the input " +
          "instead.",
      );
      // Reconcile the input against the config on the same verdict the run
      // boundary enforces, rather than on column coverage alone: an invitation
      // whose terms declare a key this input cannot produce -- or one whose own
      // cleaning drops every record -- is refused here, before it is minted,
      // instead of at an `alcove exchange` the partner has already accepted into.
      //
      // Pass the config's explicit standardization AND metadata so the columns
      // resolve to linkage fields exactly as the eventual exchange does: metadata
      // retypes columns for the type fallback, so without it a config that types a
      // column explicitly (or types an inferred one away) would be checked against
      // name inference and could mint an invitation the exchange cannot satisfy.
      checkLinkageSatisfiability(
        rows.columns,
        configTerms,
        mintPreflightMessaging(options.configFile),
        configSource.standardization,
        configSource.metadata,
      );
    } else {
      log.info(
        `a configuration file at ${redactAndRenderOperatorSuppliedText(
          operatorSuppliedText(options.configFile),
        )} is present; deriving ` + "the invitation's linkage terms from it.",
      );
    }

    // Fail closed, before the token is minted, on terms this config's own
    // exchange would refuse, so the partner is never handed an invitation it
    // accepts only to have the first run refuse it.
    assertConfigTermsRunnable(configTerms, configSource);

    // Include the disclosed-columns subset only when the config declares an
    // explicit metadata block: without one the run infers metadata from the
    // exchange input (which this offline invite never reads), so the transmitted
    // set is unknown at mint and the acceptor reconciles lazily. The same value
    // is persisted into the reused config's disclosed_payload_columns below, so a
    // later recurring `alcove exchange` (and a re-invite) checks and refreshes
    // the commitment; undefined here means the field is removed, never left stale.
    const disclosedPayloadColumns = disclosedColumnsFor(configSource.metadata);

    // A webrtc config names the coordination server and relay this invitation's
    // exchange runs on, so the acceptor is seeded from them as the online path's
    // acceptor is. The file-sync channels keep a placeholder-tolerant block and
    // name no endpoint.
    const webrtcConnection = loadConfigWebRTCConnection(options.configFile);
    const connectionEndpoint =
      webrtcConnection !== undefined
        ? offlineWebRTCEndpoint(webrtcConnection)
        : undefined;
    if (webrtcConnection?.server.secure === false)
      log.warn(
        plaintextEndpointWarning(
          "reach the coordination server over TLS by removing `secure: false`",
        ),
      );

    const expires = expiresFromNow(lifetimeSeconds);
    const sharedSecret = generateSharedSecret();
    const invitation = await encodeInvitation({
      version: "1",
      linkageTerms: configTerms,
      sharedSecret,
      expires,
      disclosedPayloadColumns,
      ...(connectionEndpoint !== undefined ? { connectionEndpoint } : {}),
      // The config is the connection this invitation's exchange runs on, so its
      // retain mode is the one to declare. Taken as the single boolean the reader
      // lifts out (the block itself stays unvalidated here, so an unfinished one
      // still mints); a config that does not turn retain mode on declares
      // nothing, since a placeholder connection cannot back a cleanup promise.
      ...(configSource.retainsFiles ? { inviterRetainsFiles: true } : {}),
    });

    return {
      mode: "offlineFromConfig",
      configPath: options.configFile,
      linkageTerms: configTerms,
      disclosedPayloadColumns,
      invitation,
      expires,
      sharedSecret,
    };
  }

  // No config: infer terms from the input file, then write both files. Nothing
  // here holds a label, so it is the operator's to supply, refused ahead of
  // the input read and the token mint below.
  const identity = resolveIdentity(options.identity);
  if (resolved.input === undefined)
    throw new UsageError(
      "generating an invitation requires an input file or a pre-existing " +
        "configuration file; usage: alcove invite --identity IDENTITY " +
        "[INPUT_FILE]",
    );
  assertNoProvisionConflicts({
    configPath: options.configFile,
    keyPath: options.keyFile,
  });

  const rows = await loadInputRows(resolved.input, {
    allowStdin: true,
    csvDelimiter,
  });
  const builtDataSpec = {
    ...buildDataSpec({ identity, rows, linkageStrategy }),
    ...delimiterSection,
  };
  noteSinglePassSelection(linkageStrategy, log);

  // The metadata the inferred terms (and the eventual exchange) read this party's
  // disclosure from.
  const disclosureMetadata =
    builtDataSpec.metadata ??
    inferMetadata(rows.columns, rows.sanitizedColumnPositions);

  // Fail closed pre-mint on a disclosed column name too long to hold, for the
  // reason the online path above does: this path's metadata comes from the input
  // header too, so the refusal is the operator's own file's, named by position,
  // rather than the raw ZodError of the token bound inside encodeInvitation --
  // and it lands before the config and key file are written. See
  // assertDisclosedNamesCarriable.
  assertDisclosedNamesCarriable(
    disclosureMetadata,
    builtDataSpec.linkageTerms.output,
  );

  // The disclosed-columns subset over that metadata, so the acceptor's consent and
  // commitment derive from what preparePayload will actually transmit. Included
  // on the token and persisted into the written config as disclosedPayloadColumns,
  // so a later recurring `alcove exchange` verifies its metadata still discloses
  // exactly this set before any data is sent (assertDisclosureMatchesCommitment).
  const disclosedPayloadColumns = disclosedColumnsFor(disclosureMetadata);
  const dataSpec: ResolvedDataSpec = {
    ...builtDataSpec,
    ...(disclosedPayloadColumns !== undefined
      ? { disclosedPayloadColumns }
      : {}),
  };

  const expires = expiresFromNow(lifetimeSeconds);
  const sharedSecret = generateSharedSecret();
  // No retain declaration on this path, by design: the config it writes is a
  // placeholder scaffold whose connection block the operator still has to fill in
  // and may set either way, so this mint has no fixed mode to declare. An
  // absent declaration states nothing, which is the accurate answer here.
  const invitation = await encodeInvitation({
    version: "1",
    linkageTerms: dataSpec.linkageTerms,
    sharedSecret,
    expires,
    disclosedPayloadColumns,
  });

  return { mode: "offline", dataSpec, invitation, expires, sharedSecret };
}

// --- Handler -----------------------------------------------------------------

export async function handler(argv: Arguments): Promise<void> {
  let closeLogging: (() => void) | undefined;
  try {
    await runOrExit("invite", async () => {
      // Parse and apply the log level before creating the logger, so the
      // configured level actually takes effect (loglevel binds a logger's level
      // at creation). Doing this inside runOrExit also routes an invalid option
      // (e.g. an unrecognized --log-level) through the same error->exit path as
      // everything else, rather than yargs's noisier top-level catch.
      const options = parseCommonBootstrapArgs(argv);
      // Install the sink, apply the level, and build getLogger("invite") through
      // the shared configureLogging helper (in that order, so the logger inherits
      // the sink): the file sink when --log-file is given, otherwise the default
      // stderr sink so stdout contains only the invitation token. A missing parent
      // directory is a UsageError -> exit 64, mapped here by the enclosing
      // runOrExit.
      const { log, close } = configureLogging({
        logLevel: options.logLevel,
        logFile: options.logFile,
        name: "invite",
      });
      closeLogging = close;
      // accept-timeout is parsed to seconds here (not in validateInvite) so a
      // malformed or bare-integer value is a clean usage error (exit 64) before any
      // side effect; durationFlagSeconds also rejects a repeat (via singleValue)
      // before the array could reach validateInvite's numeric comparisons. expires-in
      // is read as a string and parsed inside validateInvite; singleValue still
      // rejects its repeat first, before the array would hit parseDuration's
      // .trim() and appear as a confusing exit 69.
      const acceptTimeout =
        durationFlagSeconds(argv, "accept-timeout", MAX_TIMEOUT_SECONDS) ??
        DEFAULT_ACCEPT_TIMEOUT_SECONDS;
      const expiresIn = singleValue(argv, "expires-in") as string | undefined;
      // Validate the linkage-strategy enum here (not in validateInvite) so an
      // unknown value is a clean usage error (exit 64) before any side effect,
      // mirroring how accept-timeout is parsed above; singleValue rejects a
      // repeat first.
      const linkageStrategy = parseLinkageStrategyFlag(argv);
      const csvDelimiter = csvDelimiterFlag(argv);
      const ownRelay: InviterOwnRelay = {
        turn: relayUrlFlag(argv, "turn"),
        stun: relayUrlFlag(argv, "stun"),
      };
      const positionals = (argv["args"] as Array<string> | undefined) ?? [];
      // This command sets unknown-options-as-args, so a mistyped `--flag` lands
      // in the positionals rather than being rejected by the top-level
      // strictOptions; reject it here, before any conflict gate, input read, or
      // token mint.
      assertNoUnknownOptions(positionals);
      const resolved = resolveInvitePositionals(positionals);
      const ready = await validateInvite({
        resolved,
        options,
        acceptTimeout,
        expiresIn,
        linkageStrategy,
        csvDelimiter,
        ownRelay,
        log,
      });

      if (ready.mode === "online") {
        // The token is disclosed only now -- after all validation and prep above
        // succeeded. Nothing fallible runs after this print except the network
        // wait it is meant to precede.
        printInvitation(ready.invitation, {
          url: ready.url,
          channel: ready.connection.channel,
        });
        // State the invitation's validity contract before announcing the wait: the
        // inviter's exit (cancel, connection timeout, or accept-timeout) already
        // makes the printed invitation unacceptable, since the setup secret is
        // held only in memory until a handshake succeeds and the rendezvous is
        // swept on cleanup. Logged here rather than at exit, since a SIGINT exits
        // via the signal handler's process.exit before any post-wait line could
        // run.
        log.info(onlineWaitInvalidationNotice(acceptTimeout));
        log.info("waiting for the partner to accept...");
        const { configWriteError } = await runOnlineBootstrap({
          connection: ready.connection,
          dataSpec: ready.dataSpec,
          prepared: ready.prepared,
          sharedSecret: ready.sharedSecret,
          expires: ready.expires,
          keyPath: options.keyFile,
          configPath: options.configFile,
          output: ready.output,
          csvDelimiter,
          verbosity: options.verbosity,
          loggerName: "invite",
          logFile: options.logFile,
          recordOutput: resolveRecordOutput({
            enabled: options.record,
            recordFile: options.recordFile,
          }),
          eventStream: options.eventStream,
          // The wait this invitation was printed for, and the peer waits of the
          // exchange that follows it, run on --accept-timeout; the configuration
          // saved at acceptance does not, so an unattended recurring run is never
          // handed a budget sized for one operator sitting at a terminal.
          runOnlyPeerTimeoutSeconds: acceptTimeout,
          // The inviter's received-payload set is unknown until the acceptor
          // transmits it, so crystallize the observed set into the saved config
          // after this first exchange -- a later `alcove exchange` then fails
          // closed on a divergent payload. (The acceptor learns its set up front
          // from the token, so its online path does not request this.)
          persistObservedReceivedPayload: true,
        });
        // The summary only; the exit code a failed persistence implies was set
        // where that persistence was lost, so nothing here can raise or lower it.
        logOnlineBootstrapOutcome(log, {
          configFile: options.configFile,
          keyFile: options.keyFile,
          configWriteError,
        });
        // State the peer budget that configuration holds, only once it is
        // actually on disk: the accept timeout this run waited on is not it, and
        // an operator who never reads the file would otherwise have to infer
        // what a later recurring run is bounded by.
        if (configWriteError === undefined)
          log.info(
            persistedPeerBudgetNotice(
              options.peerTimeout,
              acceptTimeout,
              ready.connection.channel,
            ),
          );
        return;
      }

      if (ready.mode === "offlineFromConfig") {
        // The config already exists and sourced the linkage terms; reuse it and
        // write only the key file (refusing to clobber an existing one), after
        // the records below. Under reuseExistingConfig the spec is ignored and
        // the operator-authored config content is left untouched, so the
        // placeholder spec here is never written.
        const { keyPath } = provisionConfigAndKey(
          specWithPlaceholderConnection({ linkageTerms: ready.linkageTerms }),
          { sharedSecret: ready.sharedSecret, expires: ready.expires },
          { configPath: ready.configPath, keyPath: options.keyFile },
          {
            reuseExistingConfig: true,
            refreshReusedConfig: (keptConfigPath) => {
              // Refresh the machine-managed send-side commitment in place
              // (comments and operator content preserved), binding the write to
              // this mint so it can never lag the token the acceptor commits
              // to. A config with no metadata publishes no subset, so the field
              // is removed rather than left stale. Before the token print, so a
              // failure never follows disclosure.
              writeTermsRecord(keptConfigPath, {
                record: "disclosed_payload_columns",
                columns: ready.disclosedPayloadColumns,
              });
              // This mint re-establishes the config as the inviting side, whose
              // outbound set is the commitment itself, so an acceptor-era
              // outbound-consent record would go stale against re-edited
              // metadata; it is removed, a no-op where none exists.
              persistOutboundPayloadConsent(keptConfigPath, undefined);
            },
          },
        );

        printInvitation(ready.invitation, undefined);
        log.info(
          `derived the invitation's linkage terms from ${redactAndRenderOperatorSuppliedText(
            operatorSuppliedText(ready.configPath),
          )} and ` +
            `wrote the key file to ${redactAndRenderOperatorSuppliedText(
              operatorSuppliedText(keyPath),
            )} (the invitation expires at ` +
            `${ready.expires}). Keep the key file private.`,
        );
        log.info(offlineAbandonNotice(keyPath));
        log.info(
          `ensure the connection block in ${redactAndRenderOperatorSuppliedText(
            operatorSuppliedText(ready.configPath),
          )} is filled in ` +
            `before running 'alcove exchange'. ${CONNECTION_BLOCK_NOTICE}`,
        );
        return;
      }

      const spec = specWithPlaceholderConnection(ready.dataSpec);
      const { configPath, keyPath } = provisionConfigAndKey(
        spec,
        { sharedSecret: ready.sharedSecret, expires: ready.expires },
        { configPath: options.configFile, keyPath: options.keyFile },
      );

      printInvitation(ready.invitation, undefined);
      log.info(
        `wrote config to ${redactAndRenderOperatorSuppliedText(
          operatorSuppliedText(configPath),
        )} and key file to ${redactAndRenderOperatorSuppliedText(
          operatorSuppliedText(keyPath),
        )} (the ` +
          `invitation expires at ${ready.expires}). Keep the key file private.`,
      );
      log.info(offlineAbandonNotice(keyPath));
      log.info(
        `fill in the connection block in ${redactAndRenderOperatorSuppliedText(
          operatorSuppliedText(configPath),
        )} before running ` + `'alcove exchange'. ${CONNECTION_BLOCK_NOTICE}`,
      );
    });
  } finally {
    // Restore the loglevel factory (and close the log-file descriptor, for the
    // file sink) on the normal exit path. Writes are synchronous and already
    // durable, so the error path's process.exit (which bypasses this finally)
    // loses nothing -- this is only factory/descriptor cleanup.
    closeLogging?.();
  }
}

// --- Helpers -----------------------------------------------------------------

function specWithPlaceholderConnection(
  dataSpec: ResolvedDataSpec,
): ExchangeSpec {
  const connection: ConnectionConfig = withWebRTCPeerRole(
    connectionFromEndpoint(undefined).connection,
    "inviter",
  );
  return { connection, ...dataSpec };
}

/**
 * Show the single-pass disclosure-tradeoff note at the point of selection, when
 * the operator's `--linkage-strategy single-pass` was applied to the authored
 * terms. A no-op for `cascade` or an absent selection. Called only from the two
 * paths where the flag is actually applied (online and infer-from-input) -- not
 * the config-as-source path, where the flag is reported as ignored and the note
 * would misrepresent what was used.
 */
function noteSinglePassSelection(
  strategy: LinkageStrategy | undefined,
  log: ReturnType<typeof getLogger>,
): void {
  if (strategy === "single-pass") log.info(singlePassDisclosureNotice());
}

/**
 * What bounds a later `alcove exchange` run from a configuration recording no
 * `peer_timeout_ms`, phrased for the channel that run will use.
 *
 * Each figure is read from the constant the channel's own transport falls back
 * to: the file-sync pair from core's file-sync budget, webrtc from the three
 * budgets `webRtcDialFrom` leaves unset. These values differ by transport (see
 * `connection/webrtc/webrtcMessageConnection.ts`), so quoting one transport's
 * number on another channel would misreport the wait. A channel with no
 * default named here gets the reference row instead.
 */
function absentPeerBudgetDefaults(
  channel: ConnectionConfig["channel"],
): string {
  switch (channel) {
    case "sftp":
    case "filedrop":
      return (
        "the file-sync transport's default peer budget " +
        `(${DEFAULT_PEER_TIMEOUT_MS / 1000}s)`
      );
    case "webrtc":
      return (
        "the webrtc transport's own defaults: " +
        `${DEFAULT_RENDEZVOUS_TIMEOUT_MS / 1000}s to meet the partner at the ` +
        `rendezvous, then ${DEFAULT_CHANNEL_OPEN_TIMEOUT_MS / 1000}s for the ` +
        `data channel to open, then ${DEFAULT_WEBRTC_INACTIVITY_TIMEOUT_MS / 1000}s of ` +
        "peer silence on the open channel"
      );
    default:
      return (
        "that channel's own transport defaults (the peer_timeout_ms row of " +
        "https://github.com/georgetown-mdi/alcove/blob/main/docs/" +
        "EXCHANGE_REFERENCE.md)"
      );
  }
}

/**
 * The line reporting which peer budget the configuration an online invite just
 * saved holds, logged once that configuration is on disk.
 *
 * `--accept-timeout` bounds the invite's own run and is not written: the two
 * timeouts bound different lifetimes -- one operator waiting at a rendezvous,
 * versus every later unattended `alcove exchange` -- so the configuration
 * instead records `--peer-timeout` when the operator set one, and nothing
 * otherwise. Absent a recorded value, those runs fall to the channel's own
 * defaults (see {@link absentPeerBudgetDefaults}). Either way, the value is
 * named here rather than left to be read out of the file.
 *
 * @internal exported for testing
 */
export function persistedPeerBudgetNotice(
  persistedPeerTimeoutSeconds: number | undefined,
  acceptTimeoutSeconds: number,
  channel: ConnectionConfig["channel"],
): string {
  if (persistedPeerTimeoutSeconds !== undefined)
    return (
      "the saved configuration records connection.options.peer_timeout_ms as " +
      `${persistedPeerTimeoutSeconds}s, from --peer-timeout: that is the peer ` +
      "budget a later 'alcove exchange' runs on. --accept-timeout " +
      `(${acceptTimeoutSeconds}s) bounded this run alone.`
    );
  return (
    "the saved configuration records no connection.options.peer_timeout_ms: " +
    `--accept-timeout (${acceptTimeoutSeconds}s) bounded this run alone, so a ` +
    `later 'alcove exchange' runs on ${absentPeerBudgetDefaults(channel)}. ` +
    "Pass --peer-timeout at invite time, or set " +
    "connection.options.peer_timeout_ms in that configuration, to give those " +
    "runs a budget of your own."
  );
}

/**
 * The notice logged once an online invitation has been printed and the inviter
 * begins waiting: it states the invitation's validity contract -- accepted only
 * while this command waits at the rendezvous. Cancelling (Ctrl-C), the
 * connection timing out, or reaching the accept-timeout all leave the rendezvous
 * and discard the one-time setup secret (held only in memory until a handshake
 * succeeds), so the invitation can no longer be accepted afterward. The
 * user-facing half of the early-revocation guarantee the inviter's exit already
 * enforces (see docs/CLI.md, "Online invitation").
 *
 * @internal exported for testing
 */
export function onlineWaitInvalidationNotice(
  acceptTimeoutSeconds: number,
): string {
  return (
    "This invitation can be accepted only while this command is waiting. If " +
    "you cancel it (Ctrl-C), the connection times out, or the accept-timeout " +
    `(${acceptTimeoutSeconds}s) is reached before your partner accepts, the ` +
    "invitation can no longer be accepted -- run 'alcove invite' again to " +
    "issue a fresh one."
  );
}

/**
 * The hint logged after an offline invitation is written, naming the
 * early-abandonment path. Unlike the online flow (whose pending secret lives
 * only in memory during the wait), the offline flow persists the pending
 * shared secret to the key file at `keyPath`; deleting that file invalidates
 * the invitation before its nominal `expires`, since the offline key exchange
 * cannot complete without it. Directs deleting only the key file, never the
 * configuration, so an existing recurring exchange stays undisturbed. The
 * offline counterpart to {@link onlineWaitInvalidationNotice} (see
 * docs/CLI.md, "Offline invitation").
 *
 * @internal exported for testing
 */
export function offlineAbandonNotice(keyPath: string): string {
  return (
    "To withdraw this invitation before it expires, delete the key file " +
    `(${redactAndRenderOperatorSuppliedText(
      operatorSuppliedText(keyPath),
    )}); without it the invitation can no longer complete a ` +
    "handshake. Delete only the key file -- leaving any configuration file in " +
    "place keeps an existing recurring exchange undisturbed."
  );
}

/**
 * How the accept templates name the invitation: a placeholder the operator fills
 * in from the line stdout holds, never the invitation itself.
 *
 * Every template below is a diagnostic line, routed through the process-wide
 * log sink (`--log-file`, or re-emitted by anything that captures stderr);
 * interpolating the invitation into one would put the secret in that routing,
 * so the invitation itself is delivered only on the stdout line below. It
 * stands beside `<INPUT_FILE>`, a placeholder for the same reason of shape: the
 * template is a recipe to fill in, not a line to paste unchanged.
 *
 * {@link ../../test/unit/commands/invite.test.ts} holds the runtime check: the
 * invite command's diagnostic output must contain no substring of the
 * invitation it prints.
 */
const INVITATION_PLACEHOLDER = "<INVITATION>";

/** The identity placeholder the accept templates use. Accepting requires the
 * partner's own label -- Alcove stands in none -- so the template names the flag
 * where the partner meets the command, rather than leaving the refusal to teach
 * it. A placeholder for the same reason `<INPUT_FILE>` is: nobody but the partner
 * can choose the name their side is known by. Left unquoted like its siblings, so
 * a partner who pastes the template unreplaced gets a shell redirect error
 * instead of a run that accepts under the literal placeholder text; the partner
 * quotes their filled-in value themselves if it contains spaces. */
const IDENTITY_PLACEHOLDER = "--identity <YOUR NAME, YOUR ORGANIZATION>";

/**
 * Print the invitation string (to stdout, so it is captured even at a quiet log
 * level) with the usage instructions for the partner. An online file-sync
 * invitation's accept template references the shared server the partner reaches
 * it at; an online webrtc invitation's does not, since there is no shared
 * server to type -- the invitation's own endpoint names the coordination
 * server, so accepting dials it in one command while this one waits.
 *
 * The templates name the invitation by {@link INVITATION_PLACEHOLDER} rather than
 * including it.
 */
function printInvitation(
  invitation: string,
  online: { url: URL; channel: ConnectionConfig["channel"] } | undefined,
): void {
  const log = getLogger("invite");
  log.info(
    "Share this invitation with your partner over a trusted, out-of-band " +
      "channel:",
  );
  // The invitation is the primary artifact; emit it on stdout regardless of log
  // level so it is reliably captured for copy/paste.
  console.log(invitation);
  if (online === undefined) {
    log.info(
      `Your partner accepts with:\n  alcove accept ${IDENTITY_PLACEHOLDER} ` +
        `${INVITATION_PLACEHOLDER} <INPUT_FILE>\nwhere ` +
        `${INVITATION_PLACEHOLDER} is the invitation printed above.`,
    );
    return;
  }
  if (online.channel === "webrtc") {
    log.info(
      `Your partner accepts and runs the exchange with:\n  alcove accept ` +
        `${IDENTITY_PLACEHOLDER} ${INVITATION_PLACEHOLDER} <INPUT_FILE>\nrun ` +
        `while this command is still waiting, where ` +
        `${INVITATION_PLACEHOLDER} is the invitation printed above.`,
    );
    return;
  }
  // Strip any credentials embedded in the URL before echoing it: the partner
  // supplies their own, and a password must not reach the terminal or logs.
  log.info(
    `Your partner accepts and runs the exchange with:\n  alcove accept ` +
      `${IDENTITY_PLACEHOLDER} ${redactUrlCredentials(online.url)} ` +
      `${INVITATION_PLACEHOLDER} <INPUT_FILE>\nwhere ` +
      `${INVITATION_PLACEHOLDER} is the invitation printed above.`,
  );
}
