import fs from "node:fs";
import { userInfo } from "node:os";

import type { Argv, Arguments } from "yargs";
import logLibrary from "loglevel";

import {
  describeDecodeError,
  getLogger,
  decodeInvitation,
  isInvitationExpired,
  parseExchangeSpec,
  sanitizeForDisplay,
  UsageError,
} from "@psilink/core";
import type {
  ConnectionConfig,
  ExchangeSpec,
  InvitationToken,
  LinkageTerms,
  PreparedExchange,
} from "@psilink/core";

import {
  diffLinkageTerms,
  formatReconcileDiffs,
  type ReconcileDiff,
} from "../config";
import { detectFileConflicts } from "../fileUtils";
import { parseSensitiveYaml } from "../sensitiveFile";
import { resolveAtSignRefs } from "../util/atSignRefs";
import { configureLogFile, promptConfirm } from "../util/cli";
import { resolveRecordOutput } from "../recordFile";
import {
  checkLinkageSatisfiability,
  type LinkagePreflightMessaging,
} from "./linkagePreflight";
import { assertNoProvisionConflicts, provisionConfigAndKey } from "./provision";
import {
  addCommonBootstrapOptions,
  applyEndpointSplitDirectories,
  buildDataSpec,
  connectionFromEndpoint,
  connectionFromURL,
  connectionOverridesFrom,
  diffConnectionAgainstTarget,
  loadInputRows,
  logOnlineBootstrapOutcome,
  looksLikeUrl,
  parseCommonBootstrapArgs,
  prepareForOnlineExchange,
  runOnlineBootstrap,
  runOrExit,
  warnServerOverridesIgnoredOffline,
  type CommonBootstrapOptions,
  type ResolvedDataSpec,
  type RunnableConnectionConfig,
} from "./bootstrap";

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
          "INVITATION [INPUT_FILE] (offline), or URL INVITATION INPUT_FILE " +
          "[OUTPUT_FILE] (online)",
      })
      .usage(
        "Usage:\n" +
          "  $0 accept [options] INVITATION [INPUT_FILE]                  (offline)\n" +
          "  $0 accept [options] URL INVITATION INPUT_FILE [OUTPUT_FILE]  (online)\n\n" +
          "INVITATION is a base64url string or an @path reference to a file\n" +
          "containing one. Offline: decode, confirm, and write config and key\n" +
          "files. Online: also connect, complete the handshake, and run the\n" +
          "exchange.",
      ),
  );
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
 * @internal exported for testing
 */
export function resolveAcceptPositionals(positionals: Array<unknown>):
  | { mode: "offline"; invitation: string; input?: string }
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
      "an invitation is required; usage: psilink accept INVITATION " +
        "[INPUT_FILE]",
    );

  if (looksLikeUrl(arg0)) {
    const invitation =
      positionals[1] !== undefined ? String(positionals[1]) : undefined;
    const input =
      positionals[2] !== undefined ? String(positionals[2]) : undefined;
    if (invitation === undefined || input === undefined)
      throw new UsageError(
        "online acceptance requires an invitation and an input file; usage: " +
          "psilink accept URL INVITATION INPUT_FILE [OUTPUT_FILE]",
      );
    const output =
      positionals[3] !== undefined ? String(positionals[3]) : undefined;
    return { mode: "online", url: new URL(arg0), invitation, input, output };
  }

  return {
    mode: "offline",
    invitation: arg0,
    input: positionals[1] !== undefined ? String(positionals[1]) : undefined,
  };
}

// --- Invitation decode + validation ------------------------------------------

/**
 * Resolve an `@path` reference, decode the invitation (verifying the 4-byte
 * checksum and the Zod schema), and reject an expired token by name. All
 * failures are raised as {@link UsageError} (so the CLI exits 64) and -- being
 * thrown before any prompt -- guarantee the user is never asked to accept an
 * invitation that did not validate.
 *
 * @internal exported for testing
 */
export async function decodeAndValidateInvitation(
  rawArg: string,
): Promise<InvitationToken> {
  let encoded: unknown;
  try {
    encoded = resolveAtSignRefs(rawArg);
  } catch (err) {
    throw new UsageError(
      `could not read invitation from ${rawArg}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (typeof encoded !== "string")
    throw new UsageError("invitation must be a string");

  let token: InvitationToken;
  try {
    token = await decodeInvitation(encoded);
  } catch (err) {
    throw new UsageError(
      "invalid invitation string: " + describeDecodeError(err),
    );
  }

  if (isInvitationExpired(token.expires))
    throw new UsageError(
      `invitation expired at ${token.expires}; ask your partner for a new ` +
        "invitation",
    );

  return token;
}

// --- Display -----------------------------------------------------------------

/** @internal exported for testing */
export function displayInvitation(
  token: InvitationToken,
  log: ReturnType<typeof getLogger>,
): void {
  const t = token.linkageTerms;
  log.info("Invitation details:");
  // identity and linkage-key names are partner-controlled free text (the inviter
  // crafts the token); escape them before they reach the acceptor's terminal,
  // since this summary is shown before the operator confirms acceptance.
  log.info(`  inviting party: ${sanitizeForDisplay(t.identity)}`);
  log.info(`  PSI algorithm: ${t.algorithm}`);
  log.info(
    `  inviter receives output: ${t.output.expectsOutput ? "yes" : "no"}`,
  );
  log.info(
    `  inviter shares result with partner: ` +
      `${t.output.shareWithPartner ? "yes" : "no"}`,
  );
  log.info(
    `  linkage keys: ` +
      `${t.linkageKeys.map((k) => sanitizeForDisplay(k.name)).join(", ")}`,
  );
  if (token.expires !== undefined) log.info(`  expires: ${token.expires}`);
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
 * @internal exported for testing
 */
export async function validateAccept(params: {
  resolved: ReturnType<typeof resolveAcceptPositionals>;
  options: CommonBootstrapOptions;
  log: ReturnType<typeof getLogger>;
}): Promise<AcceptReady> {
  const { resolved, options, log } = params;

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

  const myIdentity = options.identity ?? userInfo().username;
  // Adopt the invitation's linkage keys, algorithm, and output policy, but record
  // this party's own identity (the invitation's identity is the inviter's).
  const myTerms: LinkageTerms = { ...token.linkageTerms, identity: myIdentity };

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
    const { connection, appliedSplitDirectories } =
      options.outboundPath === undefined
        ? applyEndpointSplitDirectories(urlConnection, token.connectionEndpoint)
        : { connection: urlConnection, appliedSplitDirectories: false };
    if (appliedSplitDirectories)
      log.info(
        "seeding the split inbound/outbound directories (mirror-swapped) and " +
          "retain mode from the invitation's endpoint; the connection URL " +
          "supplies the host, port, and credentials. Pass --outbound-path to " +
          "override.",
      );
    // Reconcile a pre-existing config against the invitation AND the connection
    // the exchange will actually use (the built `connection`, now possibly
    // endpoint-influenced) before the input is read and before any network
    // activity, so a location disagreement aborts with a diff and no acceptance
    // is ever sent to the inviter.
    const reuseExistingConfig = reconcileAcceptConfig({
      configPath: options.configFile,
      myTerms,
      target: connection,
      log,
    });
    // accept reads its y/N confirmation from stdin (promptConfirm), so it cannot
    // also take the CSV there: reject `-` rather than starve the prompt.
    const rows = await loadInputRows(input, { allowStdin: false });
    checkLinkageSatisfiability(
      rows.columns,
      myTerms,
      log,
      INVITATION_PREFLIGHT_MESSAGING,
    );
    const { dataSpec, warnings } = buildDataSpec({
      terms: myTerms,
      identity: myIdentity,
      rows,
    });
    for (const w of warnings) log.warn(w);

    const prepared = await prepareForOnlineExchange(dataSpec, myIdentity, rows);
    return {
      mode: "online",
      url,
      output,
      token,
      connection,
      dataSpec,
      prepared,
      reuseExistingConfig,
    };
  }

  // Offline: the server-block overrides (--server-* and --outbound-path) cannot
  // take effect (the connection block is seeded from the invitation endpoint or a
  // placeholder, not built from a URL), so warn rather than drop a
  // deliberately-passed flag silently.
  warnServerOverridesIgnoredOffline(options, log);

  // Offline.
  const reuseExistingConfig = reconcileAcceptConfig({
    configPath: options.configFile,
    myTerms,
    log,
  });
  const rows =
    resolved.input !== undefined
      ? await loadInputRows(resolved.input, { allowStdin: false })
      : undefined;
  if (rows !== undefined)
    checkLinkageSatisfiability(
      rows.columns,
      myTerms,
      log,
      INVITATION_PREFLIGHT_MESSAGING,
    );
  const { dataSpec, warnings } = buildDataSpec({
    terms: myTerms,
    identity: myIdentity,
    rows,
  });
  for (const w of warnings) log.warn(w);

  const { connection, seeded } = connectionFromEndpoint(
    token.connectionEndpoint,
  );
  return {
    mode: "offline",
    token,
    connection,
    seeded,
    dataSpec,
    reuseExistingConfig,
  };
}

/**
 * Reconcile a pre-existing configuration file against an acceptance. Returns
 * `false` when no config exists at `configPath` (a fresh one will be written);
 * `true` when a config exists and agrees with the invitation (and, online, the
 * URL), so it is kept and only the key file is written. Throws a
 * {@link UsageError} -- before the prompt and before any network activity -- when
 * a config exists but disagrees, or cannot be parsed to compare, showing the
 * user exactly what to resolve.
 */
function reconcileAcceptConfig(params: {
  configPath: string;
  myTerms: LinkageTerms;
  target?: RunnableConnectionConfig;
  log: ReturnType<typeof getLogger>;
}): boolean {
  const { configPath, myTerms, target, log } = params;
  if (detectFileConflicts([configPath]).length === 0) return false;

  // Reference to the source(s) compared against, woven into the messages so the
  // online ("invitation and URL") and offline ("invitation") cases read right.
  // A `target` connection is present only online.
  const against =
    target !== undefined
      ? "the invitation and the connection URL"
      : "the invitation";
  const retryWith =
    target !== undefined
      ? "the same URL and invitation"
      : "the same invitation";

  // Parse, then validate, in two steps. The YAML parse can echo source bytes (an
  // inline credential) and warn to stderr, so it routes through the sensitive-
  // file chokepoint (see sensitiveFile.ts); on any parse failure this reports the
  // path and reconciliation guidance, never the parser's message. A schema
  // failure from parseExchangeSpec (Zod) names field paths and issue kinds, not
  // the offending values, so its message is safe to surface (below).
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
  let existing: ExchangeSpec;
  try {
    existing = parseExchangeSpec(parsed);
  } catch (err) {
    throw new UsageError(
      `a configuration file already exists at ${configPath} but could not be ` +
        `parsed to compare against ${against}: ` +
        describeDecodeError(err) +
        `. Fix or remove it, or pass --config-file to write elsewhere, then ` +
        `retry with ${retryWith}.`,
    );
  }

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
      `the configuration file at ${configPath} disagrees with ${against}:\n` +
        formatReconcileDiffs(all) +
        `\nResolve the differences (or pass --config-file to write elsewhere), ` +
        `then retry with ${retryWith}.`,
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

  log.info(
    conn.warnings.length === 0
      ? `the existing configuration at ${configPath} matches ${against}; ` +
          "it will be reused unchanged."
      : `the existing configuration at ${configPath} will be reused unchanged; ` +
          "the connection differences above apply to this exchange only.",
  );
  return true;
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
  blockRemedy:
    "or ask your partner for an invitation with different linkage terms.",
};

// --- Handler -----------------------------------------------------------------

export async function handler(argv: Arguments): Promise<void> {
  let logFileSink: ReturnType<typeof configureLogFile> | undefined;
  try {
    await runOrExit("accept", async () => {
      // Parse and apply the log level before creating the logger, so the
      // configured level actually takes effect (loglevel binds a logger's level
      // at creation). Doing this inside runOrExit also routes an invalid option
      // (e.g. an unrecognized --log-level) through the same error->exit path as
      // everything else, rather than yargs's noisier top-level catch.
      const options = parseCommonBootstrapArgs(argv);
      // Redirect logging to the file (if requested) before the level is applied
      // and any logger is created, so getLogger("accept") below inherits the
      // file sink. A missing parent directory is a UsageError -> exit 64 here.
      if (options.logFile !== undefined)
        logFileSink = configureLogFile(options.logFile);
      logLibrary.setDefaultLevel(options.logLevel);
      const log = getLogger("accept");
      const positionals = (argv["args"] as Array<string> | undefined) ?? [];
      const resolved = resolveAcceptPositionals(positionals);
      // All validation runs before the prompt: the user is never asked to confirm
      // an invitation, URL, or input file that has not validated, and the prompt
      // itself runs inside runOrExit so a stdin error exits cleanly rather than
      // crashing.
      const ready = await validateAccept({ resolved, options, log });

      displayInvitation(ready.token, log);
      const confirmed = await promptConfirm(
        "Accept this invitation and write configuration?",
      );
      if (!confirmed) {
        log.info("invitation declined; no files were written");
        return;
      }

      if (ready.mode === "online") {
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
          reuseExistingConfig: ready.reuseExistingConfig,
        });
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

      if (ready.reuseExistingConfig)
        log.info(
          `reused the existing configuration at ${configPath}; it already matches ` +
            "the invitation, so the connection and linkage settings are unchanged.",
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
    // Close the log-file descriptor on the normal exit path. Writes are
    // synchronous and already durable, so the error path's process.exit (which
    // bypasses this finally) loses nothing -- this is only descriptor cleanup.
    logFileSink?.close();
  }
}
