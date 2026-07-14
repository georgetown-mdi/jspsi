import type { Argv, Arguments } from "yargs";
import { userInfo } from "node:os";

import {
  getLogger,
  encodeInvitation,
  assertAlgorithmImplemented,
  assertDeduplicateImplemented,
  assertPayloadSendDisclosed,
  assertStandardizationMatchesTerms,
  disclosedColumnNames,
  inferMetadata,
  INVITATION_LIFETIME_SECONDS,
  MAX_INVITATION_LIFETIME_SECONDS,
  UsageError,
} from "@psilink/core";
import type {
  ConnectionConfig,
  ExchangeSpec,
  LinkageStrategy,
  LinkageTerms,
  Metadata,
  PreparedExchange,
} from "@psilink/core";

import {
  loadConfigLinkageSource,
  persistDisclosedPayloadColumns,
} from "../config";
import { detectFileConflicts } from "../fileUtils";
import { resolveRecordOutput } from "../recordFile";
import { DURATION_VALUE_HELP, parseDuration } from "../util/duration";
import {
  configureLogging,
  durationFlagSeconds,
  MAX_TIMEOUT_SECONDS,
  runOrExit,
  singleValue,
} from "../util/cli";
import { redactUrlCredentials } from "../util/connectionUrl";
import { assertNoProvisionConflicts, provisionConfigAndKey } from "./provision";
import {
  connectionFromURL,
  type RunnableConnectionConfig,
} from "../connectionFromUrl";
import {
  addCommonBootstrapOptions,
  connectionOverridesFrom,
  parseCommonBootstrapArgs,
  warnLowPollingFrequency,
  warnOptionsOverridesIgnoredOffline,
  warnServerOverridesIgnoredOffline,
  type CommonBootstrapOptions,
} from "../optionDefinitions";
import {
  buildDataSpec,
  connectionFromEndpoint,
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
  unsatisfiedLinkageFields,
  type ResolvedDataSpec,
} from "../onlineBootstrap";

// The invitation lifetime default and one-year ceiling are shared from
// @psilink/core (INVITATION_LIFETIME_SECONDS, MAX_INVITATION_LIFETIME_SECONDS) so
// the CLI and the web inviter cannot drift. The default lifetime is distinct from
// --accept-timeout, which bounds how long the inviter waits at the rendezvous,
// not how long the token stays valid; --expires-in overrides the default up to
// the ceiling (see the builder option and validateInvite).

export function builder(cmd: Argv): Argv {
  return addCommonBootstrapOptions(
    cmd
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
        "-- a consented disclosure tradeoff, not a free speed-up (see " +
        "docs/EXCHANGE_REFERENCE.md, linkage_terms.linkage_strategy). Has no " +
        "effect when linkage terms come from an existing configuration file " +
        "(set linkage_strategy there).",
    });
}

// --- Positional parsing ------------------------------------------------------

/**
 * Classify the positional arguments as an offline or online invitation. The
 * first positional is a server URL (online) when it parses as a supported
 * transport URL; otherwise it is the optional input file (offline).
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

  if (arg0 !== undefined && looksLikeUrl(arg0)) {
    const input =
      positionals[1] !== undefined ? String(positionals[1]) : undefined;
    if (input === undefined)
      throw new UsageError(
        "online invitation requires an input file; usage: psilink invite " +
          "URL INPUT_FILE [OUTPUT_FILE]",
      );
    const output =
      positionals[2] !== undefined ? String(positionals[2]) : undefined;
    return { mode: "online", url: new URL(arg0), input, output };
  }

  return { mode: "offline", input: arg0 };
}

/**
 * The disclosed-columns subset to carry on the invitation: exactly the columns
 * the acceptor will RECEIVE for matched records, derived from this party's
 * metadata via the same `isDisclosedToPartner` predicate `preparePayload`
 * transmits on. Returns undefined -- so the field is omitted and the acceptor
 * reconciles lazily ONLY when the metadata is unknown at mint (a config-as-source
 * invite whose config carries no explicit metadata block, where the run infers
 * metadata from the exchange input the invite command never sees). When the
 * metadata IS known, the disclosed set is carried verbatim -- INCLUDING the empty
 * set when nothing is disclosed, which locks the acceptor in to "receive nothing"
 * so a non-empty payload later aborts, rather than leaving it lazy. Empty is a
 * constraint here, not the absence of one. See the InvitationToken field.
 */
function disclosedColumnsFor(
  metadata: Metadata | undefined,
): string[] | undefined {
  if (metadata === undefined) return undefined;
  return disclosedColumnNames(metadata);
}

// --- Validation (the no-commit phase) ----------------------------------------

/**
 * Everything an invitation needs that is fallible but free of the gating side
 * effects (printing the token, writing files, opening a connection): conflict
 * detection, URL validation (online), input reading, and minting+encoding the
 * invitation. The caller's commit step performs the side effects from this
 * bundle, so any failure here aborts before the live token reaches stdout or a
 * config is written. Data-cleaning warnings are logged here (so they precede the
 * token print), so this is not literally side-effect-free.
 */
type InviteReady =
  | {
      mode: "online";
      url: URL;
      output?: string;
      connection: RunnableConnectionConfig;
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
 * the shared secret at encode time so the lifetime clock starts when the shared
 * secret exists, not at process entry.
 *
 * `expiresIn`, when given, overrides the default 1-hour lifetime. It is parsed
 * (and rejected if zero, negative, or malformed) at the very top -- before any
 * conflict gate, input read, or token mint -- so a bad value never produces a
 * token or touches disk.
 *
 * `linkageStrategy`, when given, is the operator's `--linkage-strategy`
 * selection. It is applied to the terms this command authors from the input
 * (the online and infer-from-input paths); when the terms instead come from a
 * pre-existing configuration file the config is authoritative and the selection
 * is warned-ignored rather than silently overriding it. Selecting `single-pass`
 * surfaces the disclosure-tradeoff note at this point of selection.
 *
 * @internal exported for testing
 */
export async function validateInvite(params: {
  resolved: ReturnType<typeof resolveInvitePositionals>;
  options: CommonBootstrapOptions;
  acceptTimeout: number;
  expiresIn?: string;
  linkageStrategy?: LinkageStrategy;
  log: ReturnType<typeof getLogger>;
}): Promise<InviteReady> {
  const { resolved, options, acceptTimeout, expiresIn, linkageStrategy, log } =
    params;
  const identity = options.identity ?? userInfo().username;
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
  // load-bearing: merging these branches such that two loadInputRows calls could
  // both run would read stdin twice and silently yield empty rows the second time.
  if (resolved.mode === "online") {
    const { url, input, output } = resolved;
    // A non-positive accept-timeout is a pure usage error; reject it before any
    // filesystem probe or connection construction (it feeds peerTimeout below).
    // The CLI handler already rejects a non-positive or malformed value when it
    // parses the flag (durationFlagSeconds -> parseDurationFlag -> parseDuration),
    // so this is unreachable from the command line; it is kept as an independent
    // guard because validateInvite is exported and unit-tested with a raw numeric
    // acceptTimeout that does not pass through that parse.
    if (acceptTimeout <= 0)
      throw new UsageError(
        `accept-timeout must be a positive duration; got ${acceptTimeout}s`,
      );
    // Detect a pre-existing config before anything else so a bootstrap never
    // clobbers a configuration partway through an exchange. A pre-existing config
    // still aborts here: reusing it as the linkage-terms source is a documented
    // remaining limitation (see docs/CLI.md "Online invitation"). A pre-existing
    // key file, on the online path only, is downgraded to a warning below -- it
    // will be overwritten by the rotated token if the partner accepts, so surface
    // it rather than abort (docs/CLI.md "Online invitation").
    assertNoProvisionConflicts(
      { configPath: options.configFile, keyPath: options.keyFile },
      ["config"],
    );
    if (detectFileConflicts([options.keyFile]).length > 0)
      log.warn(
        `a key file already exists at ${options.keyFile}; it will be ` +
          "overwritten by the rotated token if the partner accepts. Delete it " +
          "or pass --key-file if reusing that secret was not intended.",
      );
    // Validate the URL before the token is minted, so an unusable URL (e.g. a
    // not-yet-supported webrtc scheme, or one with no host) fails before the
    // caller can disclose the token.
    const connection = connectionFromURL(
      url,
      connectionOverridesFrom(options, { peerTimeout: acceptTimeout }),
    );
    // Only on this online path -- the offline path reports the override ignored
    // (see below). connectionFromURL has already rejected a webrtc URL, so
    // `connection` is a file-sync channel here and the channel gate always passes.
    warnLowPollingFrequency(
      connection.channel,
      options.pollingFrequencyMs,
      log,
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

    const rows = await loadInputRows(input, { allowStdin: true });
    const { dataSpec: builtDataSpec, warnings } = buildDataSpec({
      identity,
      rows,
      linkageStrategy,
    });
    for (const w of warnings) log.warn(w);
    noteSinglePassSelection(linkageStrategy, log);

    // The columns this party will transmit for matched records, computed over the
    // same metadata prepareForExchange uses (dataSpec.metadata, or inferred from
    // the input columns), so the declared set equals what preparePayload
    // transmits. Carried on the token AND persisted into the saved config as
    // disclosedPayloadColumns, so a later recurring `psilink exchange` verifies
    // its current metadata still discloses exactly this set before connecting
    // (assertDisclosureMatchesCommitment) -- the send-side commitment the online
    // path would otherwise keep only on the discarded token.
    const disclosedPayloadColumns = disclosedColumnsFor(
      builtDataSpec.metadata ?? inferMetadata(rows.columns),
    );
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
      // hand. Derived from the post-override `connection`, so a `--server-port`
      // or `--outbound-path` override is reflected; carries no credentials by
      // construction (see endpointFromConnection).
      connectionEndpoint: endpointFromConnection(connection),
      // The same disclosed-columns subset persisted above: the acceptor's consent
      // screen and runtime lock-in derive from the wire's own disclosure predicate.
      disclosedPayloadColumns,
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
  // placeholder to edit, not built from a URL), so warn rather than drop a
  // deliberately-passed flag silently. Two diagnostics: the server block and the
  // connection.options block have distinct remedies.
  warnServerOverridesIgnoredOffline(options, log);
  warnOptionsOverridesIgnoredOffline(options, log);

  // Offline. Linkage terms come from a pre-existing config when one is present
  // at the config path, and are inferred from the input file otherwise.
  const configSource = loadConfigLinkageSource(options.configFile);

  if (configSource !== undefined) {
    const configTerms = configSource.linkageTerms;
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
          `Edit linkage_strategy in ${options.configFile} to change it.`,
      );
    // Config-as-source: the config supplies the linkage terms and persists
    // unchanged. The config read above is the mode discriminator -- it must run
    // first to know a config exists -- but it is a pure read; the only conflict
    // that can clobber state here is an existing key file (the config existing is
    // expected, not an error), so gate just the key path -- the same primitive
    // accept uses when reusing a reconciled config. Run it before the input is
    // read or the token is minted, mirroring the "conflicts first" order of the
    // online path.
    assertNoProvisionConflicts(
      { configPath: options.configFile, keyPath: options.keyFile },
      ["key"],
    );

    if (resolved.input !== undefined) {
      // Reconcile the input against the config: a conflict is an input whose
      // columns cannot be transformed through the available data
      // standardizations to produce the config's linkage fields. Fail naming the
      // unsatisfiable fields rather than minting an invitation the input cannot
      // honor.
      const rows = await loadInputRows(resolved.input, { allowStdin: true });
      // Pass the config's explicit standardization AND metadata so the columns
      // resolve to linkage fields exactly as the eventual exchange does: metadata
      // retypes columns for the type fallback, so without it a config that types a
      // column explicitly (or types an inferred one away) would be checked against
      // name inference and could mint an invitation the exchange cannot satisfy.
      const unsatisfied = unsatisfiedLinkageFields(
        rows.columns,
        configTerms,
        configSource.standardization,
        configSource.metadata,
      );
      if (unsatisfied.length > 0)
        throw new UsageError(
          "the input file cannot satisfy the configuration's linkage " +
            `${unsatisfied.length === 1 ? "field" : "fields"}: ` +
            unsatisfied.map((f) => `${f.name} (${f.type})`).join(", ") +
            `. The input columns [${rows.columns.join(", ")}] cannot be ` +
            "transformed through the available data standardizations to " +
            "produce " +
            `${unsatisfied.length === 1 ? "it" : "them"}; adjust the input ` +
            "file or the configuration before generating an invitation.",
        );
      // The input only validated compatibility; the invitation's terms come from
      // the config, not the input. Say so up front (before the token is minted),
      // so a user who passed an input expecting it to define the terms is not
      // surprised to find it was merely checked.
      log.info(
        `a configuration file at ${options.configFile} is present; deriving ` +
          "the invitation's linkage terms from it and checking the input file " +
          "against those terms (the input does not redefine them). Pass " +
          "--config-file pointing at a new path to infer terms from the input " +
          "instead.",
      );
    } else {
      log.info(
        `a configuration file at ${options.configFile} is present; deriving ` +
          "the invitation's linkage terms from it.",
      );
    }

    // Reject a payload.send that does not match what this party's metadata
    // discloses before the token is minted, so the partner's consent screen and
    // the encoded token never carry a dictionary that misstates what is sent (a
    // column metadata gates off, or one it transmits but the dictionary omits);
    // the exchange-time check in prepareForExchange protects the record but runs
    // too late for the consent surface. Only this config-as-source path can carry a hand-authored
    // payload.send -- the online and infer paths build terms from columns and
    // author none. Gated on an explicit metadata block: without one, metadata is
    // inferred from the exchange's input columns (unknown here), so that case is
    // left to the exchange-time check.
    if (configSource.metadata !== undefined)
      assertPayloadSendDisclosed(configTerms.payload, configSource.metadata);

    // Fail closed, before the token is minted, on a config whose authored
    // standardization contradicts its own linkage terms -- the mint-boundary
    // counterpart of the exchange-time check in prepareForExchange (the same shared
    // assert), so this path -- the only offline mint that carries a hand-authored
    // standardization -- never discloses an invitation the config's own
    // `psilink exchange` would then refuse (exit 64). Gated on an explicit
    // standardization: absent, the exchange reconstructs one from the terms (the
    // terms-only path), which cannot contradict them. Mirrors the
    // assertPayloadSendDisclosed guard above, which fails closed pre-mint for the
    // same "never disclose a token the exchange rejects" reason.
    if (configSource.standardization !== undefined)
      assertStandardizationMatchesTerms(
        configSource.standardization,
        configTerms,
      );

    // Fail closed, before the token is minted, on a config whose `algorithm` the
    // run cannot honor -- the mint-boundary counterpart of the same shared
    // exchange-time check, so this hand-authored offline mint never discloses an
    // invitation the config's own `psilink exchange` would then refuse (exit 64).
    // Unconditional, unlike the two guards above: `algorithm` is always present,
    // and only this config-as-source path can carry a hand-authored `psi-c` (the
    // online and infer paths build terms from columns via getDefaultLinkageTerms,
    // which is always `psi`). See assertAlgorithmImplemented.
    assertAlgorithmImplemented(configTerms.algorithm);

    // Likewise fail closed pre-mint on a `deduplicate: true` term the run
    // refuses (matching runs strictly one-to-one): the schema alone admits it
    // when paired with `expects_output: true`, and only this hand-authored
    // config-as-source path can carry it (the online and infer paths build
    // terms via getDefaultLinkageTerms, which is always deduplicate: false).
    // See assertDeduplicateImplemented.
    assertDeduplicateImplemented(configTerms.deduplicate);

    // Carry the disclosed-columns subset only when the config declares an
    // explicit metadata block: without one the run infers metadata from the
    // exchange input (which this offline invite never reads), so the transmitted
    // set is unknown at mint and the acceptor reconciles lazily. The same value
    // is persisted into the reused config's disclosed_payload_columns below, so a
    // later recurring `psilink exchange` (and a re-invite) checks and refreshes
    // the commitment; undefined here means the field is removed, never left stale.
    const disclosedPayloadColumns = disclosedColumnsFor(configSource.metadata);

    const expires = expiresFromNow(lifetimeSeconds);
    const sharedSecret = generateSharedSecret();
    const invitation = await encodeInvitation({
      version: "1",
      linkageTerms: configTerms,
      sharedSecret,
      expires,
      disclosedPayloadColumns,
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

  // No config: infer terms from the input file, then write both files.
  if (resolved.input === undefined)
    throw new UsageError(
      "generating an invitation requires an input file or a pre-existing " +
        "configuration file; usage: psilink invite [INPUT_FILE]",
    );
  assertNoProvisionConflicts({
    configPath: options.configFile,
    keyPath: options.keyFile,
  });

  const rows = await loadInputRows(resolved.input, { allowStdin: true });
  const { dataSpec: builtDataSpec, warnings } = buildDataSpec({
    identity,
    rows,
    linkageStrategy,
  });
  for (const w of warnings) log.warn(w);
  noteSinglePassSelection(linkageStrategy, log);

  // The disclosed-columns subset over the same metadata the inferred terms (and
  // the eventual exchange) use, so the acceptor's consent and lock-in derive from
  // what preparePayload will actually transmit. Carried on the token AND persisted
  // into the written config as disclosedPayloadColumns, so a later recurring
  // `psilink exchange` verifies its metadata still discloses exactly this set
  // before connecting (assertDisclosureMatchesCommitment).
  const disclosedPayloadColumns = disclosedColumnsFor(
    builtDataSpec.metadata ?? inferMetadata(rows.columns),
  );
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
      // stderr sink so stdout carries only the invitation token. A missing parent
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
      // is read as a string and parsed inside validateInvite; singleValue rejects its
      // repeat too, before the array would hit parseDuration's .trim() and surface as
      // a confusing exit 69.
      const acceptTimeout =
        durationFlagSeconds(argv, "accept-timeout", MAX_TIMEOUT_SECONDS) ??
        DEFAULT_ACCEPT_TIMEOUT_SECONDS;
      const expiresIn = singleValue(argv, "expires-in") as string | undefined;
      // Validate the linkage-strategy enum here (not in validateInvite) so an
      // unknown value is a clean usage error (exit 64) before any side effect,
      // mirroring how accept-timeout is parsed above; singleValue rejects a
      // repeat first.
      const linkageStrategy = parseLinkageStrategyFlag(argv);
      const positionals = (argv["args"] as Array<string> | undefined) ?? [];
      const resolved = resolveInvitePositionals(positionals);
      const ready = await validateInvite({
        resolved,
        options,
        acceptTimeout,
        expiresIn,
        linkageStrategy,
        log,
      });

      if (ready.mode === "online") {
        // The token is disclosed only now -- after all validation and prep above
        // succeeded. Nothing fallible runs after this print except the network
        // wait it is meant to precede.
        printInvitation(ready.invitation, { url: ready.url });
        // State the invitation's validity contract before announcing the wait. The
        // inviter's exit (cancel, connection timeout, or accept-timeout) already
        // makes the printed invitation unacceptable -- the setup secret is held
        // only in memory until a handshake succeeds and the rendezvous is swept on
        // cleanup -- so this notice is the user-facing half of that guarantee. It
        // is logged here rather than at exit because a SIGINT exits via the signal
        // handler's process.exit before any post-wait line could run.
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
          verbosity: options.verbosity,
          loggerName: "invite",
          recordOutput: resolveRecordOutput({
            enabled: options.record,
            recordFile: options.recordFile,
          }),
          eventStream: options.eventStream,
          // The inviter's received-payload set is unknown until the acceptor
          // transmits it, so crystallize the observed set into the saved config
          // after this first exchange -- a later `psilink exchange` then fails
          // closed on a divergent payload. (The acceptor learns its set up front
          // from the token, so its online path does not request this.)
          persistObservedReceivedPayload: true,
        });
        logOnlineBootstrapOutcome(log, {
          configFile: options.configFile,
          keyFile: options.keyFile,
          configWriteError,
        });
        return;
      }

      if (ready.mode === "offlineFromConfig") {
        // The config already exists and sourced the linkage terms; reuse it and
        // write only the key file (refusing to clobber an existing one). Under
        // reuseExistingConfig the spec is ignored and the operator-authored config
        // content is left untouched, so the placeholder spec here is never written.
        const { keyPath } = provisionConfigAndKey(
          specWithPlaceholderConnection({ linkageTerms: ready.linkageTerms }),
          { sharedSecret: ready.sharedSecret, expires: ready.expires },
          { configPath: ready.configPath, keyPath: options.keyFile },
          { reuseExistingConfig: true },
        );

        // Refresh the machine-managed send-side commitment in place (comments and
        // operator content preserved), binding the write to this mint so it can
        // never lag the token the acceptor locks in: this closes the drift the
        // partner would otherwise abort on mid-exchange, whether this is a first
        // invite from a metadata-only config (no commitment persisted before) or a
        // re-invite over edited metadata (a prior commitment now stale). A config
        // with no metadata publishes no subset, so the field is removed here rather
        // than left stale. Before the token print, so a failure never follows
        // disclosure.
        persistDisclosedPayloadColumns(
          ready.configPath,
          ready.disclosedPayloadColumns,
        );

        printInvitation(ready.invitation, undefined);
        log.info(
          `derived the invitation's linkage terms from ${ready.configPath} and ` +
            `wrote the key file to ${keyPath} (the invitation expires at ` +
            `${ready.expires}). Keep the key file private.`,
        );
        log.info(offlineAbandonNotice(keyPath));
        log.info(
          `ensure the connection block in ${ready.configPath} is filled in ` +
            "before running 'psilink exchange'.",
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
        `wrote config to ${configPath} and key file to ${keyPath} (the ` +
          `invitation expires at ${ready.expires}). Keep the key file private.`,
      );
      log.info(offlineAbandonNotice(keyPath));
      log.info(
        `fill in the connection block in ${configPath} before running ` +
          "'psilink exchange'.",
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
  const connection: ConnectionConfig =
    connectionFromEndpoint(undefined).connection;
  return { connection, ...dataSpec };
}

/**
 * Surface the single-pass disclosure-tradeoff note at the point of selection,
 * when the operator's `--linkage-strategy single-pass` was applied to the
 * authored terms. A no-op for `cascade` or an absent selection. Called only from
 * the two paths where the flag is actually applied (online and infer-from-input)
 * -- not the config-as-source path, where the flag is warned-ignored and the
 * note would misrepresent what was used.
 */
function noteSinglePassSelection(
  strategy: LinkageStrategy | undefined,
  log: ReturnType<typeof getLogger>,
): void {
  if (strategy === "single-pass") log.info(singlePassDisclosureNotice());
}

/**
 * The notice logged once an online invitation has been printed and the inviter
 * begins waiting, stating the invitation's validity contract: it can be accepted
 * only while this command waits at the rendezvous. Cancelling (Ctrl-C), the
 * connection timing out, or reaching the accept-timeout all leave the rendezvous
 * and discard the one-time setup secret (held only in memory until a handshake
 * succeeds), so the printed invitation can no longer be accepted afterward and a
 * fresh one must be issued. This is the user-facing half of the early-revocation
 * guarantee the inviter's exit already enforces (see docs/CLI.md "Online
 * invitation").
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
    "invitation can no longer be accepted -- run 'psilink invite' again to " +
    "issue a fresh one."
  );
}

/**
 * The hint logged after an offline invitation is written, naming the early
 * abandonment path. Unlike the online flow (whose pending secret lives only in
 * the inviter's memory during the wait and is discarded on exit), the offline
 * flow persists the pending shared secret to the key file at `keyPath`. Deleting
 * that file invalidates the invitation before its nominal `expires`: the offline
 * key exchange cannot complete unless the inviting party still holds the pending
 * shared secret, so once the file is gone the secret carried in the forwarded
 * invitation can no longer authenticate a handshake against the inviter. The
 * hint directs the user to delete only the key file, never the configuration, so
 * abandoning a pending invitation leaves intact any configuration a recurring
 * exchange still serves. This is the offline counterpart to
 * {@link onlineWaitInvalidationNotice} and the user-facing half of the
 * abandonment affordance documented in docs/CLI.md ("Offline invitation").
 *
 * @internal exported for testing
 */
export function offlineAbandonNotice(keyPath: string): string {
  return (
    "To withdraw this invitation before it expires, delete the key file " +
    `(${keyPath}); without it the invitation can no longer complete a ` +
    "handshake. Delete only the key file -- leaving any configuration file in " +
    "place keeps an existing recurring exchange undisturbed."
  );
}

/**
 * Print the invitation string (to stdout, so it is captured even at a quiet log
 * level) with copy/pasteable usage instructions. When `online.url` is present,
 * the accept template references the shared server.
 */
function printInvitation(
  invitation: string,
  online: { url: URL } | undefined,
): void {
  const log = getLogger("invite");
  log.info(
    "Share this invitation with your partner over a trusted, out-of-band " +
      "channel:",
  );
  // The invitation is the primary artifact; emit it on stdout regardless of log
  // level so it is reliably captured for copy/paste.
  console.log(invitation);
  if (online !== undefined) {
    // Strip any credentials embedded in the URL before echoing it: the partner
    // supplies their own, and a password must not reach the terminal or logs.
    log.info(
      `Your partner accepts and runs the exchange with:\n  psilink accept ` +
        `${redactUrlCredentials(online.url)} ${invitation} <INPUT_FILE>`,
    );
  } else {
    log.info(
      `Your partner accepts with:\n  psilink accept ${invitation} <INPUT_FILE>`,
    );
  }
}
