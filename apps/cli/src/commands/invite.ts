import type { Argv, Arguments } from "yargs";
import logLibrary from "loglevel";
import { userInfo } from "node:os";

import { getLogger, encodeInvitation, UsageError } from "@psilink/core";
import type {
  ConnectionConfig,
  ExchangeSpec,
  PreparedExchange,
} from "@psilink/core";

import { detectFileConflicts } from "../fileUtils";
import { resolveRecordOutput } from "../recordFile";
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
  type CommonBootstrapOptions,
  type ResolvedDataSpec,
  type RunnableConnectionConfig,
} from "./bootstrap";

// Invitation tokens carry a 1-hour lifetime by default, per
// docs/SECURITY_DESIGN.md. The --expires-in override is a separate epic item;
// the value is hard-coded here. Distinct from --accept-timeout, which bounds how
// long the inviter waits at the rendezvous, not how long the token stays valid.
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
        // INPUT_FILE is required in both modes today: linkage terms are inferred
        // from it. It becomes optional once reusing a pre-existing config as the
        // terms source lands (board item 196895356); update this then.
        describe:
          "INPUT_FILE (offline), or URL INPUT_FILE [OUTPUT_FILE] (online)",
      })
      .usage(
        "Usage:\n" +
          "  $0 invite [options] INPUT_FILE                         (offline)\n" +
          "  $0 invite [options] URL INPUT_FILE [OUTPUT_FILE]       (online)\n\n" +
          "Offline: generate an invitation string and key file to share with a\n" +
          "partner out-of-band. Online: also connect, wait for the partner to\n" +
          "accept, and run the exchange. Linkage terms are inferred from\n" +
          "INPUT_FILE.",
      ),
  ).option("accept-timeout", {
    type: "number",
    describe:
      "online only: seconds to wait for the partner to accept before giving " +
      `up (default: ${DEFAULT_ACCEPT_TIMEOUT_SECONDS}, i.e. 15 minutes)`,
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
      mode: "offline";
      dataSpec: ResolvedDataSpec;
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
 * @internal exported for testing
 */
export async function validateInvite(params: {
  resolved: ReturnType<typeof resolveInvitePositionals>;
  options: CommonBootstrapOptions;
  acceptTimeout: number;
  log: ReturnType<typeof getLogger>;
}): Promise<InviteReady> {
  const { resolved, options, acceptTimeout, log } = params;
  const identity = options.identity ?? userInfo().username;

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
    // still aborts here: reusing it as the linkage-terms source is tracked
    // separately (board 9, itemId 196895356). A pre-existing key file, on the
    // online path only, is downgraded to a warning below -- it will be
    // overwritten by the rotated token if the partner accepts, so surface it
    // rather than abort (docs/CLI.md "Online invitation").
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

    // The token's lifetime is fixed; an accept-timeout longer than it would keep
    // waiting at the rendezvous past the point the token can be honored.
    if (acceptTimeout > INVITATION_LIFETIME_SECONDS)
      log.warn(
        `--accept-timeout (${acceptTimeout}s) exceeds the invitation ` +
          `lifetime (${INVITATION_LIFETIME_SECONDS}s); the token will expire ` +
          "first and a later acceptance will be rejected.",
      );

    const rows = await loadInputRows(input);
    const { dataSpec, warnings } = buildDataSpec({ identity, rows });
    for (const w of warnings) log.warn(w);

    const expires = expiresFromNow(INVITATION_LIFETIME_SECONDS);
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

  // Offline.
  if (resolved.input === undefined)
    throw new UsageError(
      "an input file is required to generate an invitation; usage: " +
        "psilink invite INPUT_FILE",
    );
  assertNoProvisionConflicts({
    configPath: options.configFile,
    keyPath: options.keyFile,
  });

  const rows = await loadInputRows(resolved.input);
  const { dataSpec, warnings } = buildDataSpec({ identity, rows });
  for (const w of warnings) log.warn(w);

  const expires = expiresFromNow(INVITATION_LIFETIME_SECONDS);
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
    const positionals = (argv["args"] as Array<string> | undefined) ?? [];
    const resolved = resolveInvitePositionals(positionals);
    const ready = await validateInvite({
      resolved,
      options,
      acceptTimeout,
      log,
    });

    if (ready.mode === "online") {
      // The token is disclosed only now -- after all validation and prep above
      // succeeded. Nothing fallible runs after this print except the network
      // wait it is meant to precede.
      printInvitation(ready.invitation, { url: ready.url });
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
