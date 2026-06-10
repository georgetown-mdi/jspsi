import type { Argv, Arguments } from "yargs";
import logLibrary from "loglevel";
import { userInfo } from "node:os";

import { getLogger, encodeInvitation, UsageError } from "@psilink/core";
import type {
  ConnectionConfig,
  ExchangeSpec,
  LinkageTerms,
  PreparedExchange,
} from "@psilink/core";

import { loadConfigLinkageSource } from "../config";
import { detectFileConflicts } from "../fileUtils";
import { resolveRecordOutput } from "../recordFile";
import { parseDuration } from "../util/duration";
import { assertNoProvisionConflicts, provisionConfigAndKey } from "./provision";
import {
  addCommonBootstrapOptions,
  buildDataSpec,
  connectionFromEndpoint,
  connectionFromURL,
  connectionOverridesFrom,
  DEFAULT_ACCEPT_TIMEOUT_SECONDS,
  expiresFromNow,
  generateSharedSecret,
  loadInputRows,
  logOnlineBootstrapOutcome,
  looksLikeUrl,
  parseCommonBootstrapArgs,
  redactUrlCredentials,
  prepareForOnlineExchange,
  runOnlineBootstrap,
  runOrExit,
  unsatisfiedLinkageFields,
  type CommonBootstrapOptions,
  type ResolvedDataSpec,
  type RunnableConnectionConfig,
} from "./bootstrap";

// Invitation tokens carry a 1-hour lifetime by default, per
// docs/SECURITY_DESIGN.md. --expires-in overrides it (see the builder option).
// Distinct from --accept-timeout, which bounds how long the inviter waits at
// the rendezvous, not how long the token stays valid.
const INVITATION_LIFETIME_SECONDS = 60 * 60;

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
          "is checked against it) and inferred from INPUT_FILE otherwise.",
      ),
  )
    .option("accept-timeout", {
      type: "number",
      describe:
        "online only: seconds to wait for the partner to accept before giving " +
        `up (default: ${DEFAULT_ACCEPT_TIMEOUT_SECONDS}, i.e. 15 minutes)`,
    })
    .option("expires-in", {
      type: "string",
      describe:
        "override the invitation lifetime (default: 1 hour). A duration with " +
        "a required unit suffix: s, m, h, or d, e.g. 45s, 30m, 2h, or 1d",
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
      // the linkage terms (and persists unchanged), so only the key file is
      // written. When an input file was also supplied it has already been
      // checked against the config's linkage fields here.
      mode: "offlineFromConfig";
      configPath: string;
      linkageTerms: LinkageTerms;
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
 * @internal exported for testing
 */
export async function validateInvite(params: {
  resolved: ReturnType<typeof resolveInvitePositionals>;
  options: CommonBootstrapOptions;
  acceptTimeout: number;
  expiresIn?: string;
  log: ReturnType<typeof getLogger>;
}): Promise<InviteReady> {
  const { resolved, options, acceptTimeout, expiresIn, log } = params;
  const identity = options.identity ?? userInfo().username;
  // parseDuration yields whole milliseconds at second granularity (its smallest
  // unit), so dividing by 1000 is exact: the lifetime is always a whole number
  // of seconds, whether defaulted or overridden, and feeds expiresFromNow below.
  const lifetimeSeconds =
    expiresIn !== undefined
      ? parseDuration(expiresIn) / 1000
      : INVITATION_LIFETIME_SECONDS;

  if (resolved.mode === "online") {
    const { url, input, output } = resolved;
    // A non-positive --accept-timeout is a pure usage error; reject it before any
    // filesystem probe or connection construction (it feeds peerTimeout below).
    if (acceptTimeout <= 0)
      throw new UsageError(
        `--accept-timeout must be a positive number of seconds; got ` +
          `${acceptTimeout}`,
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

    // An accept-timeout longer than the token's lifetime would keep waiting at
    // the rendezvous past the point the token can be honored. Compare against
    // the resolved lifetime so an --expires-in override is respected here too.
    if (acceptTimeout > lifetimeSeconds)
      log.warn(
        `--accept-timeout (${acceptTimeout}s) exceeds the invitation ` +
          `lifetime (${lifetimeSeconds}s); the token will expire ` +
          "first and a later acceptance will be rejected.",
      );

    const rows = await loadInputRows(input);
    const { dataSpec, warnings } = buildDataSpec({ identity, rows });
    for (const w of warnings) log.warn(w);

    const expires = expiresFromNow(lifetimeSeconds);
    const sharedSecret = generateSharedSecret();
    const invitation = await encodeInvitation({
      version: "1",
      linkageTerms: dataSpec.linkageTerms,
      sharedSecret,
      expires,
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

  // Offline. Linkage terms come from a pre-existing config when one is present
  // at the config path, and are inferred from the input file otherwise.
  const configSource = loadConfigLinkageSource(options.configFile);

  if (configSource !== undefined) {
    const configTerms = configSource.linkageTerms;
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
      const rows = await loadInputRows(resolved.input);
      const unsatisfied = unsatisfiedLinkageFields(
        rows.columns,
        configTerms,
        configSource.standardization,
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

    const expires = expiresFromNow(lifetimeSeconds);
    const sharedSecret = generateSharedSecret();
    const invitation = await encodeInvitation({
      version: "1",
      linkageTerms: configTerms,
      sharedSecret,
      expires,
    });

    return {
      mode: "offlineFromConfig",
      configPath: options.configFile,
      linkageTerms: configTerms,
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

  const rows = await loadInputRows(resolved.input);
  const { dataSpec, warnings } = buildDataSpec({ identity, rows });
  for (const w of warnings) log.warn(w);

  const expires = expiresFromNow(lifetimeSeconds);
  const sharedSecret = generateSharedSecret();
  const invitation = await encodeInvitation({
    version: "1",
    linkageTerms: dataSpec.linkageTerms,
    sharedSecret,
    expires,
  });

  return { mode: "offline", dataSpec, invitation, expires, sharedSecret };
}

// --- Handler -----------------------------------------------------------------

export async function handler(argv: Arguments): Promise<void> {
  await runOrExit("invite", async () => {
    // Parse and apply the log level before creating the logger, so the
    // configured level actually takes effect (loglevel binds a logger's level at
    // creation). Doing this inside runOrExit also routes an invalid option (e.g.
    // an unrecognized --log-level) through the same error->exit path as
    // everything else, rather than yargs's noisier top-level catch.
    const options = parseCommonBootstrapArgs(argv);
    logLibrary.setDefaultLevel(options.logLevel);
    const log = getLogger("invite");
    const acceptTimeout =
      (argv["accept-timeout"] as number | undefined) ??
      DEFAULT_ACCEPT_TIMEOUT_SECONDS;
    const expiresIn = argv["expires-in"] as string | undefined;
    const positionals = (argv["args"] as Array<string> | undefined) ?? [];
    const resolved = resolveInvitePositionals(positionals);
    const ready = await validateInvite({
      resolved,
      options,
      acceptTimeout,
      expiresIn,
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
      // reuseExistingConfig the spec is ignored and the existing config is left
      // untouched, so the placeholder spec here is never written.
      const { keyPath } = provisionConfigAndKey(
        specWithPlaceholderConnection({ linkageTerms: ready.linkageTerms }),
        { sharedSecret: ready.sharedSecret, expires: ready.expires },
        { configPath: ready.configPath, keyPath: options.keyFile },
        { reuseExistingConfig: true },
      );

      printInvitation(ready.invitation, undefined);
      log.info(
        `derived the invitation's linkage terms from ${ready.configPath} and ` +
          `wrote the key file to ${keyPath} (the invitation expires at ` +
          `${ready.expires}). Keep the key file private.`,
      );
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
    log.info(
      `fill in the connection block in ${configPath} before running ` +
        "'psilink exchange'.",
    );
  });
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
