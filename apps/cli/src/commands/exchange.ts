import type { Argv, Arguments } from "yargs";
import fs from "node:fs";
import logLibrary from "loglevel";
import { userInfo } from "node:os";

import {
  parseExchangeSpec,
  describeDecodeError,
  getLogger,
  loadCSVFile,
  prepareForExchange,
  UsageError,
} from "@psilink/core";
import type { ExchangeDataSpec, PreparedExchange } from "@psilink/core";

import {
  applyConnectionOverrides,
  announceRetainMode,
  assertRetainSweepGuard,
  DEFAULT_CONFIG_PATH,
} from "../config";
import { expandTilde } from "../fileUtils";
import { establishHostKeyTrust } from "../hostKeyTrust";
import {
  loadKeyFile,
  checkKeyFileExpiry,
  DEFAULT_KEY_PATH,
  type KeyFile,
  type KeyFileExpiryStatus,
} from "../keyFile";
import { resolveRecordOutput } from "../recordFile";
import { parseSensitiveYaml } from "../sensitiveFile";
import { resolveAtSignRefs, resolveExchangeSpecRefs } from "../util/atSignRefs";
import {
  configureLogFile,
  exitWithError,
  parseOrExit,
  openInputSource,
} from "../util/cli";
import {
  addCommonBootstrapOptions,
  connectionOverridesFrom,
  parseCommonBootstrapArgs,
  warnUnsupportedFileSyncFlags,
  type CommonBootstrapOptions,
} from "./bootstrap";
import { checkLinkageSatisfiability } from "./linkagePreflight";
import {
  runProtocol,
  type AuthPersist,
  type ProtocolConnectionConfig,
} from "../protocol";

export function builder(cmd: Argv): Argv {
  return addCommonBootstrapOptions(
    cmd
      .usage("Usage: $0 exchange [options] INPUT_FILE [OUTPUT_FILE]")
      .positional("input", {
        type: "string",
        describe: "CSV to link; use `-` to read from stdin",
        demandOption: true,
      })
      .positional("output", {
        type: "string",
        describe: "where to write results; defaults to stdout",
      }),
    // exchange reads a config and has no URL, so the config/key files are read
    // (not written) and the server-* / peer-id overrides apply to the config.
    {
      "config-file": `exchange configuration file (default: ${DEFAULT_CONFIG_PATH})`,
      "key-file": `shared key file (default: ${DEFAULT_KEY_PATH})`,
      "server-port": "server port; overrides connection.server.port in config",
      "server-username":
        "server username; overrides connection.server.username in config",
      "server-password":
        "server password; use @path to read from file; overrides " +
        "connection.server.password in config",
      "server-private-key":
        "SSH private key; use @path to read from file; overrides " +
        "connection.server.privateKey in config",
      "peer-id":
        "stable identifier for this party; appears in filenames and logs. " +
        "Overrides connection.options.peer_id in config. Requires " +
        "timestamp_in_filename: true. Both parties must use distinct ids",
      "timestamp-in-filename":
        "encode a UTC timestamp and per-session counter in each outgoing " +
        "message filename; --retain-files implies it, so it need not be passed " +
        "explicitly. Both parties must use the same value",
      "retain-files":
        "keep all exchange files as a permanent transcript instead of " +
        "deleting them after consumption; intended for sync-mediated " +
        "transports that do not propagate deletions and for audit use cases. " +
        "Requires --timestamp-in-filename. Both parties must set this flag " +
        "identically -- a mismatch is detected at rendezvous and fails fast on " +
        "both sides with a clear error naming each side's setting, rather than " +
        "stalling until the peer timeout. A fresh " +
        "directory is required for each exchange and is enforced: reusing a " +
        "directory with retained files from a prior session is rejected with " +
        "an error at startup",
    },
  )
    .option("sweep-exchange-files", {
      type: "boolean",
      describe:
        "before rendezvous, delete every protocol file left in the directory " +
        "(this party's and the peer's: hellos, acks, locks, joining sentinels, " +
        "messages) and start a fresh exchange. Foreign (non-protocol) files are " +
        "never deleted. Use to recover a directory after a crashed or " +
        "mismatched prior run, once you have confirmed no other session is " +
        "using it. CLI-only and invocation-scoped: it is never persisted to " +
        "psilink.yaml. Refuses on a retain-mode signal unless " +
        "--force-retain-sweep is also set",
    })
    .option("force-retain-sweep", {
      type: "boolean",
      describe:
        "DANGEROUS. Permit --sweep-exchange-files to delete a retain-mode audit " +
        "transcript (a directory that is, or whose peer is, in retain mode); the " +
        "prior transcript is permanently lost. Requires --sweep-exchange-files " +
        "-- on its own it is rejected. Only use when you intend to discard the " +
        "transcript",
    });
}

// --- Argument parsing --------------------------------------------------------

// The common bootstrap options (config/key paths, identity, server-* overrides,
// timeouts, record/-file, log-level, verbosity, the file-sync flags) plus the
// exchange-specific positionals and CLI-only sweep controls. record/recordFile/
// logLevel/verbosity come from CommonBootstrapOptions.
interface ExchangeArgs extends CommonBootstrapOptions {
  input: string;
  output?: string;
  // CLI-only sweep controls (see protocol.FileSyncRuntimeOptions). Excluded from
  // ExchangeOptions below so they never reach loadConfig / the config schema.
  sweepExchangeFiles: boolean;
  forceRetainSweep: boolean;
}

type ExchangeOptions = Omit<
  ExchangeArgs,
  | "input"
  | "output"
  | "logLevel"
  | "logFile"
  | "verbosity"
  | "sweepExchangeFiles"
  | "forceRetainSweep"
  | "record"
  | "recordFile"
>;

function parseArgs(argv: Arguments): ExchangeArgs {
  // Parse the common options through the shared parser (the same singleValue
  // repeat-rejection and log-level validation invite/accept use), then layer the
  // exchange-specific handling on top.
  const common = parseCommonBootstrapArgs(argv);
  return {
    ...common,
    // exchange tilde-expands the local file paths it reads/writes. Unlike the
    // persistence commands (zero-setup --save, invite/accept), which defer @path
    // resolution so a saved config keeps the reference, exchange resolves any
    // @path credential ref here at parse time: it only ever reads a config,
    // never writes one, so there is no reference to preserve and the resolved
    // value is needed immediately for the connection. (server-password /
    // -private-key are credential values, not paths to tilde-expand.)
    configFile: expandTilde(common.configFile),
    keyFile: expandTilde(common.keyFile),
    recordFile: expandTilde(common.recordFile),
    serverPassword: resolveAtSignRefs(common.serverPassword) as
      | string
      | undefined,
    serverPrivateKey: resolveAtSignRefs(common.serverPrivateKey) as
      | string
      | undefined,
    // exchange-specific positionals; not repeatable flags, so they stay plain.
    input: expandTilde(argv["input"] as string),
    output: expandTilde(argv["output"] as string | undefined),
    // CLI-only, never persisted: resolve to a definite boolean here since there
    // is no config layer to merge with (unlike the file-sync flags above).
    sweepExchangeFiles:
      (argv["sweep-exchange-files"] as boolean | undefined) ?? false,
    forceRetainSweep:
      (argv["force-retain-sweep"] as boolean | undefined) ?? false,
  };
}

// --- Config loading ----------------------------------------------------------

// The runtime-injected authentication fields: their values come only from
// `.psilink.key`, so an operator who sets them in the top-level `authentication`
// block of psilink.yaml is warned and the value is stripped. Each canonical name
// carries the user-input spellings it can appear as before `camelizeKeys` runs
// (snake_case is the YAML convention; camelCase is accepted too), so neither
// form slips through silently, alongside the hint shown when it is stripped.
// Keeping forms and hint in one entry keeps them from drifting out of sync.
const INJECTED_AUTH_FIELDS: Record<string, { forms: string[]; hint: string }> =
  {
    sharedSecret: {
      forms: ["shared_secret", "sharedSecret"],
      hint:
        "the shared secret is always loaded from the key file (any @-file " +
        "reference in this field was also not resolved)",
    },
    expires: {
      forms: ["expires"],
      hint:
        "expiration is always loaded from the key file (any @-file reference " +
        "in this field was also not resolved)",
    },
  };

/**
 * Warn about and strip the runtime-injected authentication fields
 * (`shared_secret`/`expires`) from a raw top-level `authentication` block, in
 * place. Their values come only from `.psilink.key`, so a value set in YAML is
 * ignored; warning rather than silently dropping lets the operator see why their
 * setting did nothing. Operator-policy fields (e.g. `token_max_age_days`) are NOT
 * touched -- they pass through to schema validation, which is the authority on
 * which policy fields are valid (and, being strict, rejects an unrecognized one).
 * Runs on the raw config before `parseExchangeSpec` (which applies `camelizeKeys`
 * then Zod), so it matches both the snake_case and camelCase spelling of each
 * injected field.
 *
 * @internal exported for testing
 */
export function warnAndStripInjectedAuthFields(
  rawAuth: Record<string, unknown>,
  configFile: string,
  log: ReturnType<typeof getLogger>,
): void {
  // Map every accepted spelling straight to its hint, so matching a key both
  // identifies it as injected and yields the message in one lookup (no second
  // indexed access that could interpolate `undefined` if the tables drifted).
  const formToHint = new Map<string, string>();
  for (const { forms, hint } of Object.values(INJECTED_AUTH_FIELDS))
    for (const form of forms) formToHint.set(form, hint);

  for (const key of Object.keys(rawAuth)) {
    const hint = formToHint.get(key);
    // An operator-policy field (or an unrecognized one): leave it for the schema
    // to accept or strip, the same treatment any other config key gets.
    if (hint === undefined) continue;
    log.warn(
      `${configFile}: authentication.${key} is set and will be ignored; ` +
        hint,
    );
    delete rawAuth[key];
  }
}

/** @internal exported for testing */
export function loadConfig(options: ExchangeOptions): {
  connection: ProtocolConnectionConfig;
  authentication: AuthPersist;
} & ExchangeDataSpec {
  const log = getLogger("exchange");

  // Read, then parse through the sensitive-file chokepoint. The fs read can only
  // fail with an errno (ENOENT, EACCES, EISDIR) -- a path plus code, no config
  // content -- so it is surfaced; ENOENT gets the create-a-config guidance. The
  // YAML parse can echo source bytes (an inline credential), so it routes through
  // parseSensitiveYaml, which reports path-only (see sensitiveFile.ts). Invalid
  // caller configuration is a UsageError (exit 64), not a transport failure (69).
  let source: string;
  try {
    source = fs.readFileSync(options.configFile, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      throw Object.assign(
        new Error(
          `config file ${options.configFile} does not exist; ` +
            "to create one, run 'psilink invite URL ...' first",
        ),
        { code: "ENOENT" },
      );
    throw new UsageError(
      `config file ${options.configFile} could not be read: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  const rawConfig = parseSensitiveYaml(
    source,
    `config file ${options.configFile}`,
  );

  // Warn about and strip the runtime-injected fields from the top-level
  // `authentication` block (their values come only from the key file). Operator-
  // policy fields under the same block are left for schema validation. Runs on
  // the raw config before parseExchangeSpec applies camelizeKeys + Zod.
  const rawAuth = (rawConfig as Record<string, unknown>)?.["authentication"];
  if (typeof rawAuth === "object" && rawAuth !== null)
    warnAndStripInjectedAuthFields(
      rawAuth as Record<string, unknown>,
      options.configFile,
      log,
    );

  let parsedSpec: ReturnType<typeof parseExchangeSpec>;
  try {
    parsedSpec = parseExchangeSpec(rawConfig);
  } catch (err) {
    // Well-formed YAML that fails schema validation is still invalid caller
    // configuration (exit 64), not a transport failure.
    throw new UsageError(
      `config file ${options.configFile} is not a valid exchange spec: ` +
        describeDecodeError(err),
    );
  }

  // Resolve @-file references in the supported credential/opaque fields after
  // schema validation, and outside the parse try/catch above: a missing or
  // unreadable referenced file (including a preserved @path credential whose file
  // has since moved) is a UsageError naming the reference (exit 64), so it must
  // propagate as-is rather than be re-wrapped as an "invalid exchange spec",
  // which would mislabel a credential-access failure as a schema error. The
  // literal @path strings validate cleanly as the fields' string values, so
  // resolving after the parse loses no validation. Scoped to the documented
  // @-file fields (all under `connection`); a free-text field such as
  // linkageTerms.identity or retentionDisposition keeps a literal leading `@`.
  const resolvedSpec = resolveExchangeSpecRefs(parsedSpec);
  const {
    connection: baseConn,
    authentication: specAuth,
    ...exchangeDataSpec
  } = resolvedSpec;
  log.info("loaded exchange spec from", options.configFile);

  const connection = applyConnectionOverrides(
    baseConn,
    connectionOverridesFrom(options),
  );

  // The channel here comes from the loaded config (post-override); warn on the
  // file-sync-only flags before the unsupported-channel throw below.
  warnUnsupportedFileSyncFlags(
    connection.channel,
    {
      locklessRendezvous: options.locklessRendezvous,
      retainFiles: options.retainFiles,
    },
    log,
  );

  if (connection.channel !== "sftp" && connection.channel !== "filedrop")
    // An unsupported channel in the config is invalid caller configuration
    // (exit 64), not a transport failure.
    throw new UsageError(
      `the ${connection.channel} channel is not yet supported in the CLI`,
    );

  let keyData: KeyFile | undefined;
  try {
    keyData = loadKeyFile(options.keyFile);
  } catch (err) {
    // A malformed existing key file is bad input the operator must fix or
    // re-provision (exit 64), the same classification saveKeyFile gives a
    // malformed token on write -- not a transport failure (69). loadKeyFile
    // already raises a complete, leak-safe UsageError for an invalid-JSON key
    // file; pass it through rather than re-wrapping (which would echo it twice).
    // A schema failure (a raw ZodError, naming the field not its value) or an
    // errno is reclassified here.
    if (err instanceof UsageError) throw err;
    throw new UsageError(
      `key file at ${options.keyFile} is malformed: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (keyData === undefined)
    // A missing key file is a configuration problem (exit 64), consistent with
    // the missing-config case above.
    throw new UsageError(
      `key file ${options.keyFile} does not exist. ` +
        "Create one with 'psilink invite' (generate an invitation) or " +
        "'psilink accept' (accept a partner's invitation); both write a " +
        ".psilink.key. See docs/CLI.md#offline-invitation and " +
        "docs/SECURITY_DESIGN.md#recurring-exchange-authentication.",
    );
  // Hard stop on an already-expired token before any dataset prep, connection, or
  // PAKE handshake. The `expires` in the key file is authoritative regardless of
  // token_max_age_days -- it may be an invitation token's short lifetime or a
  // max-age stamp from a prior rotation. authenticateConnection enforces the same
  // condition pre-handshake, but surfacing it here exits earlier and with a
  // re-invite-specific message. UsageError -> exit 64, like the malformed/missing
  // key-file cases above. (The threshold-dependent "expiring soon" advisory is
  // emitted later, in the handler, because it is conditional on the rotation
  // outcome.)
  if (checkKeyFileExpiry(keyData, Date.now()) === "expired") {
    // keyData.expires is necessarily set when the status is "expired", but
    // TypeScript does not narrow it across the call; the fallback keeps the
    // message a definite string rather than risk rendering "undefined".
    const expiredAt = keyData.expires ?? "(unknown)";
    throw new UsageError(
      `the shared secret in ${options.keyFile} expired at ${expiredAt} ` +
        "and cannot be used; no exchange was attempted. Both parties must " +
        "re-invite to establish a new shared secret: run 'psilink invite URL " +
        "...' and 'psilink accept URL INVITATION' (the existing psilink.yaml is " +
        "reused; only the key file is recreated). See " +
        "docs/CLI.md#out-of-sync-tokens.",
    );
  }
  const authPersist: AuthPersist = {
    // Operator-policy fields parsed from the YAML `authentication` block (today,
    // token_max_age_days), carried end to end -- protocol.ts reads
    // tokenMaxAgeDays here to stamp the rotated token's expiry. The injected
    // fields below come only from the key file and override any YAML value --
    // already stripped above, so this ordering is belt-and-suspenders.
    ...specAuth,
    sharedSecret: keyData.sharedSecret,
    expires: keyData.expires,
    keyFilePath: options.keyFile,
  };
  // The channel guard above throws on any non-sftp/filedrop channel, so the
  // discriminated union narrows `connection` to ProtocolConnectionConfig here.
  return {
    connection,
    authentication: authPersist,
    ...exchangeDataSpec,
  };
}

// --- Token expiry advisory ---------------------------------------------------

/**
 * Divisor applied to `token_max_age_days` to derive the "expiring soon" warning
 * threshold (days remaining): the advisory fires once a token is within
 * `token_max_age_days / EXPIRY_WARN_THRESHOLD_DIVISOR` days of its expiry. Named
 * so the policy can be tuned in one place.
 */
export const EXPIRY_WARN_THRESHOLD_DIVISOR = 3;

/**
 * The "expiring soon" warning threshold in days for a given max-age policy, or
 * `undefined` when no policy is in force. Without a policy there is nothing to
 * measure "soon" against, so {@link checkKeyFileExpiry} never reports
 * "expiring-soon" and the advisory is suppressed.
 *
 * @internal exported for testing
 */
export function warnThresholdDaysForPolicy(
  tokenMaxAgeDays: number | undefined,
): number | undefined {
  if (tokenMaxAgeDays === undefined) return undefined;
  return tokenMaxAgeDays / EXPIRY_WARN_THRESHOLD_DIVISOR;
}

/**
 * Whether to emit the "token expiring soon" advisory, given the token's expiry
 * status at load time (`before`) and after the exchange attempt (`after`).
 *
 * Warn only when the token was expiring soon at load AND the exchange did not
 * refresh it: a successful rotation under a max-age policy stamps a fresh
 * `expires` farther out than the warning threshold, so `after` is "ok" and the
 * advisory would contradict the "retry without re-inviting" guidance; a failed or
 * absent rotation leaves the token unchanged (still "expiring-soon", or "expired"
 * if time elapsed), so the operator is told.
 *
 * @internal exported for testing
 */
export function shouldWarnTokenExpiring(
  before: KeyFileExpiryStatus,
  after: KeyFileExpiryStatus,
): boolean {
  return before === "expiring-soon" && after !== "ok";
}

/**
 * Build the token-expiry advisory message to emit after an exchange, or
 * `undefined` to stay silent. Call only when the exchange attempt has finished
 * (success or failure).
 *
 * `now` is the CURRENT time -- deliberately later than the load-time `now` that
 * produced `expiryBefore`, so the re-check reflects time that elapsed during the
 * exchange and can catch a token that lapsed mid-run; `warnThresholdDays` is the
 * same value used at load.
 *
 * Re-reads the (possibly rotated) key file to decide: a successful rotation under
 * a max-age policy stamped a fresh `expires` farther out, so the token is no
 * longer expiring soon and the advisory would mislead. The message reports the
 * on-disk expiry, not the value loaded before the exchange, and distinguishes a
 * token that merely nears expiry from one that has already lapsed (which is
 * directed straight to re-invitation). If the key file is absent on the re-read
 * (deleted between rotation and now), the post-exchange state cannot be
 * confirmed, so this stays silent rather than assert a cause. A genuine
 * read/parse failure (the file existed and validated at load but became
 * unreadable or corrupt during the exchange) is not swallowed here; it propagates
 * to the caller, which decides how to treat it. The advisory is best-effort, so
 * the handler logs such a failure at debug and continues rather than surfacing it
 * as the exchange's outcome. The re-read suppresses the over-permissive-file
 * warning already emitted at load.
 *
 * @throws if the key file exists but cannot be read or parsed on the re-read; the
 *         sole caller (the exchange handler) catches this and logs it at debug.
 * @internal exported for testing
 */
export function tokenExpiringAdvisory(
  expiryBefore: KeyFileExpiryStatus,
  keyFilePath: string,
  now: number,
  warnThresholdDays: number | undefined,
): string | undefined {
  if (expiryBefore !== "expiring-soon") return undefined;
  // loadKeyFile returns undefined only for ENOENT (file gone); any other failure
  // (EACCES, malformed JSON) throws and is left to propagate to the caller rather
  // than being silently swallowed.
  const reloaded = loadKeyFile(keyFilePath, { warnOnPermissive: false });
  if (reloaded === undefined) return undefined;
  const expiryAfter = checkKeyFileExpiry(reloaded, now, { warnThresholdDays });
  if (!shouldWarnTokenExpiring(expiryBefore, expiryAfter)) return undefined;
  // shouldWarnTokenExpiring is true only when expiryAfter is "expiring-soon" or
  // "expired", both of which require `expires` to be set; the fallback keeps the
  // message a definite string for the type checker.
  const expiresShown = reloaded.expires ?? "(unknown)";
  if (expiryAfter === "expired")
    // The token lapsed during the exchange and was not refreshed. "Run before it
    // expires" would be wrong (it already has), so direct straight to re-invite,
    // matching the load-time hard-stop guidance.
    return (
      `the shared secret in ${keyFilePath} expired at ${expiresShown} during ` +
      `this exchange and was not refreshed; both parties must re-invite to ` +
      `establish a new shared secret. See docs/CLI.md#out-of-sync-tokens.`
    );
  return (
    `the shared secret in ${keyFilePath} is expiring soon (expires ` +
    `${expiresShown}) and was not refreshed by this exchange. Run a successful ` +
    `exchange before it expires; once it lapses, both parties must re-invite. ` +
    `See docs/CLI.md#out-of-sync-tokens.`
  );
}

// --- Data preparation --------------------------------------------------------

/** @internal exported for testing */
export async function prepareDataset(
  exchangeDataSpec: ExchangeDataSpec,
  identity: string,
  input: string,
): Promise<PreparedExchange> {
  const log = getLogger("exchange");

  const csvResult = await loadCSVFile(
    openInputSource(input, { allowStdin: true }),
  );
  const rawRows = csvResult.data as Array<Record<string, string>>;
  const columns = csvResult.meta.fields ?? [];

  // Pre-flight this run's CSV against the committed linkage terms before any
  // exchange work, the same satisfiability gate accept applies at accept time.
  // The recurring `exchange` path is otherwise unguarded: prepared.warnings never
  // covers the adopt-the-inviter's-terms case (prepareForExchange warns only when
  // an explicit standardization spec is supplied), so without this a run whose CSV
  // no longer satisfies the agreed terms -- a swapped CSV, or one never checked at
  // an offline accept -- would proceed to a silent empty result that is
  // byte-indistinguishable from a real empty intersection. Only the config's
  // explicit linkageTerms are gated: when absent, prepareForExchange derives
  // default terms from this CSV's own columns, which it satisfies by construction.
  // The config's standardization and metadata are fed in so the check resolves
  // fields exactly as prepareForExchange will -- an explicit column remap or an
  // explicit column type does not get mis-flagged (accept passes neither; see its
  // comment).
  if (exchangeDataSpec.linkageTerms !== undefined)
    checkLinkageSatisfiability(
      columns,
      exchangeDataSpec.linkageTerms,
      log,
      {
        source: "configuration",
        blockRemedy:
          "or re-establish the exchange with linkage terms the CSV satisfies.",
      },
      exchangeDataSpec.standardization,
      exchangeDataSpec.metadata,
    );

  const prepared = prepareForExchange(
    exchangeDataSpec,
    identity,
    rawRows,
    columns,
  );
  for (const warning of prepared.warnings)
    log.warn("cleaning configuration issue:", warning);
  return prepared;
}

// --- Handler -----------------------------------------------------------------

export async function handler(argv: Arguments): Promise<void> {
  // parseArgs resolves the log level and reads every option, so it runs before
  // the logger exists. parseOrExit reports its usage errors -- a repeated
  // single-value flag or an unrecognized log-level -- on stderr and exits 64,
  // and lets any other (unexpected) failure propagate to the top-level handler.
  const parsed = parseOrExit(() => parseArgs(argv));
  const {
    input,
    output,
    logLevel,
    logFile,
    verbosity,
    sweepExchangeFiles,
    forceRetainSweep,
    ...options
  } = parsed;

  // Redirect logging to the file (if requested) before the level is applied and
  // the logger is created, so getLogger("exchange") below inherits the file
  // sink. A missing parent directory is a UsageError reported on stderr (the
  // file is not the sink) and exits 64.
  const logFileSink =
    logFile !== undefined
      ? parseOrExit(() => configureLogFile(logFile))
      : undefined;

  logLibrary.setDefaultLevel(logLevel);
  const log = getLogger("exchange");

  try {
    try {
      assertRetainSweepGuard(sweepExchangeFiles, forceRetainSweep);
    } catch (err) {
      exitWithError(log, err, 64);
    }

    let configResult: ReturnType<typeof loadConfig>;
    try {
      configResult = loadConfig(options);
    } catch (err) {
      // A malformed or missing config/key file is a usage error (exit 64); the
      // ENOENT arm keeps the missing-config case, which is tagged rather than a
      // UsageError. Anything else (e.g. an unsupported channel) stays exit 69.
      exitWithError(
        log,
        err,
        err instanceof UsageError ||
          (err as NodeJS.ErrnoException).code === "ENOENT"
          ? 64
          : 69,
      );
    }
    const { connection, authentication, ...exchangeDataSpec } = configResult;

    // Token expiry advisory baseline: was the token expiring soon at load time?
    // This recheck uses a fresh clock just after loadConfig's hard stop, so in the
    // (sub-millisecond) gap a token can tip from "expiring-soon" to "expired". That
    // is handled, not guaranteed away: the advisory below is keyed on
    // "expiring-soon" and self-skips on "expired", and runProtocol's pre-handshake
    // assertSharedSecretReadyForHandshake aborts an expired token with the re-invite
    // message before any handshake. The threshold comes from the max-age policy;
    // without a policy it is undefined and the status is "ok" (never
    // "expiring-soon"). Re-evaluated after the exchange to decide whether to warn
    // (see shouldWarnTokenExpiring).
    const warnThresholdDays = warnThresholdDaysForPolicy(
      authentication.tokenMaxAgeDays,
    );
    const expiryBefore = checkKeyFileExpiry(
      {
        sharedSecret: authentication.sharedSecret,
        expires: authentication.expires,
      },
      Date.now(),
      { warnThresholdDays },
    );

    announceRetainMode(connection, log);

    // Establish SSH host-key trust before any exchange work: on an unpinned sftp
    // config this prompts and pins on first interactive use, and fails closed
    // (no prompt, no auto-accept) on a non-interactive run. It is a no-op for a
    // pinned config or a non-sftp channel. Runs before dataset prep so a
    // non-interactive no-pin run fails fast; a UsageError (non-TTY, or a declined
    // prompt) maps to exit 64, a probe transport failure to 69.
    try {
      await establishHostKeyTrust(connection, {
        verbosity,
        loggerName: "exchange",
        // The config is already on disk and exchange does not re-write it, so a
        // first-use pin is written in place now.
        persistence: { mode: "write-now", configPath: options.configFile },
      });
    } catch (err) {
      exitWithError(log, err, err instanceof UsageError ? 64 : 69);
    }

    let identity: string;
    if (options.identity) {
      identity = options.identity;
      if (exchangeDataSpec.linkageTerms)
        exchangeDataSpec.linkageTerms = {
          ...exchangeDataSpec.linkageTerms,
          identity,
        };
    } else {
      identity = exchangeDataSpec.linkageTerms?.identity ?? userInfo().username;
    }

    let prepared: PreparedExchange;
    try {
      prepared = await prepareDataset(exchangeDataSpec, identity, input);
    } catch (err) {
      // A usage error (exit 64) -- the `-`-at-an-interactive-terminal rejection
      // openInputSource raises is a UsageError carrying no exitCode -- must map to
      // 64, not collapse to 69; a missing input file carries its own exitCode 69.
      // Mirrors zeroSetup's prepareDataset boundary.
      exitWithError(
        log,
        err,
        err instanceof UsageError
          ? 64
          : ((err as { exitCode?: number }).exitCode ?? 69),
      );
    }

    const recordOutput = resolveRecordOutput({
      enabled: options.record,
      recordFile: options.recordFile,
    });

    let exchangeError: unknown;
    try {
      await runProtocol(
        connection,
        authentication,
        prepared,
        output,
        verbosity,
        "exchange",
        recordOutput,
        // saveIntent and onAuthenticated are both undefined on the authenticated
        // exchange path; the trailing object carries the CLI-only sweep controls.
        undefined,
        undefined,
        { sweepExchangeFiles, forceRetainSweep },
      );
    } catch (err) {
      // Capture rather than exit here so the expiry advisory below can run on the
      // failure path too (the criterion is "expiring soon AND rotation did not
      // refresh the token", which only a failed exchange leaves unsatisfied-by-
      // refresh). The exit follows the advisory.
      exchangeError = err;
    }

    // Emit the token-expiry advisory when the token was expiring soon at load and
    // the exchange did not refresh it (a successful rotation stamps a fresh,
    // farther-out expires, so the advisory would contradict runProtocol's "retry
    // without re-inviting" guidance). The decision and message are built by
    // tokenExpiringAdvisory, which re-reads the on-disk token.
    let advisory: string | undefined;
    try {
      advisory = tokenExpiringAdvisory(
        expiryBefore,
        authentication.keyFilePath,
        Date.now(),
        warnThresholdDays,
      );
    } catch (err) {
      // The advisory is best-effort. A re-read failure here (the file became
      // unreadable or corrupt during the exchange; the load-time read had already
      // validated it) is non-fatal -- record it at debug rather than let it mask
      // the exchange's own outcome reported below.
      log.debug(
        "could not re-read the key file for the token-expiry advisory:",
        err instanceof Error ? err.message : String(err),
      );
    }
    if (advisory !== undefined) log.warn(advisory);

    if (exchangeError !== undefined)
      exitWithError(
        log,
        exchangeError,
        exchangeError instanceof UsageError ? 64 : 69,
      );
  } finally {
    // Close the log-file descriptor on the normal exit path. Writes are
    // synchronous and already durable, so exitWithError's process.exit (which
    // bypasses this finally) loses nothing -- this is only descriptor cleanup.
    logFileSink?.close();
  }
}
