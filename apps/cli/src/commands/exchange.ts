import type { Argv, Arguments } from "yargs";
import fs from "node:fs";

import {
  parseExchangeSpec,
  describeDecodeError,
  getLogger,
  OperatorConfigError,
  prepareForExchange,
  resolveExchangeInputs,
  sanitizeErrorForDisplay,
  UsageError,
} from "@psilink/core";
import type {
  ExchangeDataSpec,
  FileSyncOptions,
  PreparedExchange,
} from "@psilink/core";

import {
  applyConnectionOverrides,
  announceRetainMode,
  assertRetainSweepGuard,
  DEFAULT_CONFIG_PATH,
  linkageTermsStandingOf,
  warnOnLinkageRuleSetCitationDrift,
} from "../config";
import { expandTilde } from "../fileUtils";
import { establishHostKeyTrust } from "../hostKeyTrust";
import {
  loadKeyFile,
  checkKeyFileExpiry,
  provisionKeyFileFromInvitation,
  DEFAULT_KEY_PATH,
  type KeyFile,
  type KeyFileExpiryStatus,
} from "../keyFile";
import { optionalIdentity } from "../partyIdentity";
import { resolveRecordOutput } from "../recordFile";
import { resolveReceiptOutput } from "../receiptFile";
import { assertIdentityMatchesAgreedTerms } from "../signingIdentityDivergence";
import { loadSigningIdentity } from "../signingIdentityFile";
import { confirmOutboundPayloadConsent } from "../outboundPayloadConsent";
import { parseSensitiveYaml } from "../sensitiveFile";
import { resolveAtSignRefs, resolveExchangeSpecRefs } from "../util/atSignRefs";
import { exitCodeForError, exitWithError } from "../util/exit";
import { parseOrExit, singleValue } from "../util/flags";
import { configureLogging } from "../util/logging";
import { loadInputRows } from "../onlineBootstrap";
import {
  addCommonBootstrapOptions,
  connectionOverridesFrom,
  parseCommonBootstrapArgs,
  warnConnectionPerPollShortInterval,
  warnLowPollingFrequency,
  warnUnsupportedFileSyncFlags,
  warnUnsupportedWebRTCServerFlags,
  type CommonBootstrapOptions,
} from "../optionDefinitions";
import {
  checkLinkageSatisfiability,
  RUN_BLOCK_CONSEQUENCE,
} from "./linkagePreflight";
import { warnOnValueConstraints } from "./valueConstraintWarnings";
import {
  runProtocol,
  type AuthPersist,
  type ProtocolConnectionConfig,
  type SigningPersist,
} from "../protocol";
import type { SigningConfig } from "@psilink/core";

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
      "server-private-key-passphrase":
        "passphrase for an encrypted SSH private key; use @path to read from " +
        "file; overrides connection.server.privateKeyPassphrase in config",
      "server-keyboard-interactive":
        "answer the server's keyboard-interactive prompts with the password, " +
        "overriding connection.server.keyboard_interactive in config; requires " +
        "a password. Enable for a server that rejects the direct password " +
        "method but accepts the same password over keyboard-interactive",
      "server-host-key-fingerprint":
        "pre-pin the server's SSH host-key fingerprint (OpenSSH SHA256 " +
        "format; use @path to read from file), overriding " +
        "connection.server.host_key_fingerprint in config. Lets an " +
        "unattended run connect without the interactive trust prompt; a " +
        "server presenting a different key still fails closed",
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
        "deleting them after consumption. They persist in the shared " +
        "directory -- a directory on the remote SFTP host, or the shared " +
        "folder both parties reach -- along with the plaintext rendezvous " +
        "metadata that accompanies them. Intended for sync-mediated " +
        "transports that do not propagate deletions and for audit use cases. " +
        "Requires --timestamp-in-filename. Both parties must set this flag " +
        "identically -- a mismatch is detected at rendezvous and fails fast on " +
        "both sides with a clear error naming each side's setting, rather than " +
        "stalling until the peer timeout. A fresh " +
        "directory is required for each exchange and is enforced: reusing a " +
        "directory with retained files from a prior session is rejected with " +
        "an error at startup",
      "outbound-path":
        "set the outbound (self-written) directory, overriding " +
        "connection.outbound_path in the config; the config supplies the " +
        "inbound (peer-written) directory -- its single path, or an " +
        "already-configured inbound_path. Requires retain mode; the two " +
        "directories must differ",
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
    })
    .option("invitation", {
      type: "string",
      describe:
        "provision the key file from an invitation code (use @path -- " +
        "`--invitation @code.txt` -- to keep the code out of shell history), the " +
        "same code `psilink accept` takes. For the party that composed the " +
        "exchange in the web app and downloaded a config that has no secret: " +
        "this completes local provisioning from the invitation and runs the " +
        "exchange in one command. The code is decoded and validated (checksum, " +
        "schema, expiry) before anything is written; a malformed or expired code " +
        "fails with nothing written. Errors if a key file already exists at the " +
        "key path -- after the first exchange the secret rotates, so the original " +
        "code must not resurrect a stale secret",
    });
}

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
  // The invitation code that provisions the key file before it is read. Excluded
  // from ExchangeOptions so it never reaches loadConfig; the handler consumes it
  // in the provisioning step ahead of the config/key load.
  invitation?: string;
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
  | "eventStream"
  | "invitation"
  | "record"
  | "recordFile"
>;

/** @internal exported for testing */
export function parseArgs(argv: Arguments): ExchangeArgs {
  // Parse the common options through the shared parser (the same singleValue
  // repeat-rejection and log-level validation invite/accept use), then layer the
  // exchange-specific handling on top.
  const common = parseCommonBootstrapArgs(argv);
  return {
    ...common,
    // exchange resolves any @path credential ref here at parse time, unlike the
    // persistence commands (--save, invite/accept), which defer resolution to
    // preserve the reference in a saved config; exchange only reads a config, so
    // there is nothing to preserve. (server-password / -private-key /
    // -private-key-passphrase are credential values, not paths to tilde-expand.)
    configFile: expandTilde(common.configFile),
    keyFile: expandTilde(common.keyFile),
    recordFile: expandTilde(common.recordFile),
    serverPassword: resolveAtSignRefs(common.serverPassword) as
      string | undefined,
    serverPrivateKey: resolveAtSignRefs(common.serverPrivateKey) as
      string | undefined,
    // Resolved here for the same reason as the sibling credentials above: the
    // override is layered on after resolveExchangeSpecRefs, so a @path passphrase
    // would otherwise reach the live connection unresolved.
    serverPrivateKeyPassphrase: resolveAtSignRefs(
      common.serverPrivateKeyPassphrase,
    ) as string | undefined,
    // exchange-specific positionals; not repeatable flags, so they stay plain.
    input: expandTilde(argv["input"] as string),
    output: expandTilde(argv["output"] as string | undefined),
    // CLI-only, never persisted: resolve to a definite boolean here since there
    // is no config layer to merge with (unlike the file-sync flags above).
    sweepExchangeFiles:
      (argv["sweep-exchange-files"] as boolean | undefined) ?? false,
    forceRetainSweep:
      (argv["force-retain-sweep"] as boolean | undefined) ?? false,
    // Kept verbatim: unlike the server-* credential flags above, the
    // invitation is NOT @-resolved here. Its @-file form is read at decode time
    // by decodeAndValidateInvitation (via provisionKeyFileFromInvitation), so the
    // code stays out of process argv even when supplied as `@code.txt`.
    invitation: singleValue(argv, "invitation") as string | undefined,
  };
}

// The runtime-injected authentication fields: their values come only from
// `.psilink.key`, so an operator who sets them in the top-level `authentication`
// block of psilink.yaml is warned and the value is stripped. Each entry lists
// the user-input spellings (snake_case and camelCase) a field can appear as
// before `camelizeKeys` runs, plus the hint shown when it is stripped.
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
  // content -- so it is reported; ENOENT gets the create-a-config guidance. The
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
  // schema validation: a missing or unreadable referenced file is a UsageError
  // naming the reference (exit 64), propagated unwrapped rather than relabeled as
  // an invalid exchange spec. The literal @path strings validate cleanly as plain
  // string values, so resolving after the parse loses no validation. Scoped to
  // the documented @-file fields under `connection`; a free-text field such as
  // linkageTerms.identity keeps a literal `@`.
  const resolvedSpec = resolveExchangeSpecRefs(parsedSpec);
  const {
    connection: baseConn,
    authentication: specAuth,
    ...exchangeDataSpec
  } = resolvedSpec;
  log.info("loaded exchange spec from", options.configFile);

  warnOnLinkageRuleSetCitationDrift(
    exchangeDataSpec.linkageTerms,
    options.configFile,
    log,
    linkageTermsStandingOf(exchangeDataSpec),
    "decline-to-reuse",
  );

  const connection = applyConnectionOverrides(
    baseConn,
    connectionOverridesFrom(options),
  );

  // The channel here comes from the loaded config (post-override); warn on the
  // file-sync-only flags before the channel allowlist below.
  //
  // connectionPerPoll is read from both the raw CLI flag and the merged config:
  // a persisted connection_per_poll: true in a filedrop config must draw the
  // ignored-warning too, which only the merged connection.options holds.
  // applyConnectionOverrides applies the CLI override only on sftp, so a CLI
  // --connection-per-poll against a filedrop config never reaches
  // connection.options -- only the raw flag states that intent. Either source
  // being on means the operator asked for a mode this channel ignores. The
  // other flags stay raw-CLI-only: they warn solely on a non-file-sync channel
  // (webrtc), whose SharedOptions cannot express them.
  warnUnsupportedFileSyncFlags(
    connection.channel,
    {
      locklessRendezvous: options.locklessRendezvous,
      retainFiles: options.retainFiles,
      pollingFrequencyMs: options.pollingFrequencyMs,
      // This call runs before the channel is narrowed to sftp/filedrop below, so
      // connection.options is typed SharedOptions | FileSyncOptions; read
      // connectionPerPoll through a FileSyncOptions cast (as the core webrtc
      // refines do), which yields undefined on a SharedOptions block that cannot
      // hold it.
      connectionPerPoll:
        options.connectionPerPoll === true ||
        (connection.options as FileSyncOptions | undefined)
          ?.connectionPerPoll === true,
      peerId: options.peerId,
      timestampInFilename: options.timestampInFilename,
    },
    log,
  );
  // The server-block half of the same report: applyConnectionOverrides merges
  // that sub-group on sftp alone, so every --server-* flag typed at a webrtc
  // config is dropped, credentials included -- and a credential typed at a
  // channel that discards it looks, from the terminal, exactly like one that was
  // used.
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
    // The connection is the loaded configuration's own, so the remedies point at
    // its `connection.server` block rather than at a URL this command took none
    // of.
    "configuration",
  );
  warnLowPollingFrequency(connection.channel, options.pollingFrequencyMs, log);

  if (
    connection.channel !== "sftp" &&
    connection.channel !== "filedrop" &&
    connection.channel !== "webrtc"
  ) {
    // An unsupported channel in the config is invalid caller configuration
    // (exit 64), not a transport failure. It is an allowlist, so a channel added
    // to the config union is refused here until runProtocol learns to run it
    // (CONTRIBUTING.md, Transport branching). The `never` binding is what makes
    // that a check rather than a hope: it compiles only while the list above
    // covers every channel the union contains, so adding one to core without
    // adding it here fails the build rather than reaching an operator.
    const unsupported: never = connection;
    throw new UsageError(
      `the ${(unsupported as { channel: string }).channel} channel is not ` +
        `supported in the CLI`,
    );
  }

  // Warn when connection-per-poll is paired with a short poll interval, so a
  // wasteful setting persisted in psilink.yaml is flagged, not only a CLI
  // --connection-per-poll. Read through a FileSyncOptions cast for the same
  // reason as the call above: the merged options are typed for every channel,
  // and a webrtc block cannot hold either field. A no-op off sftp (the mode is
  // SFTP-only).
  warnConnectionPerPollShortInterval(
    connection.channel,
    (connection.options as FileSyncOptions | undefined)?.connectionPerPoll,
    (connection.options as FileSyncOptions | undefined)?.pollIntervalMs,
    log,
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
        ".psilink.key.",
    );
  // Hard stop on an already-expired token before any dataset prep, connection, or
  // PAKE handshake. The `expires` in the key file is authoritative regardless of
  // token_max_age_days -- it may be an invitation token's short lifetime or a
  // max-age stamp from a prior rotation. authenticateConnection enforces the same
  // condition pre-handshake, but reporting it here exits earlier and with a
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
        "re-invite to establish a new shared secret: remove the expired key " +
        "file on both sides, then one party runs 'psilink invite' (the offline " +
        "form, with no URL) and the other runs 'psilink accept INVITATION " +
        "[INPUT_FILE]'. Each side's configuration is reused; only the key file " +
        "is recreated.",
    );
  }
  const authPersist: AuthPersist = {
    // Operator-policy fields parsed from the YAML `authentication` block (today,
    // token_max_age_days), passed through end to end -- protocol.ts reads
    // tokenMaxAgeDays here to stamp the rotated token's expiry. The injected
    // fields below come only from the key file and override any YAML value.
    ...specAuth,
    sharedSecret: keyData.sharedSecret,
    expires: keyData.expires,
    keyFilePath: options.keyFile,
  };
  // The channel guard above throws on any channel runProtocol cannot run, so
  // the discriminated union narrows `connection` to ProtocolConnectionConfig
  // here.
  return {
    connection,
    authentication: authPersist,
    ...exchangeDataSpec,
  };
}

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
 * `now` is the CURRENT time -- later than the load-time `now` that
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
 * the handler logs such a failure at debug and continues rather than reporting it
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
      `establish a new shared secret.`
    );
  return (
    `the shared secret in ${keyFilePath} is expiring soon (expires ` +
    `${expiresShown}) and was not refreshed by this exchange. Run a successful ` +
    `exchange before it expires; once it lapses, both parties must re-invite.`
  );
}

/**
 * Where a run records an outbound-payload confirmation, and how the surface that
 * asks for it is routed. Required rather than optional: the confirmation is the
 * only thing standing between an unconfirmed acceptance and a disclosure no party
 * chose, so a caller cannot omit it and silently lose the gate.
 */
export interface OutboundConsentContext {
  /** The config this run loaded, where a confirmation is written back. */
  configPath: string;
  /** The operator's `--log-file`, so the surface routes like every diagnostic. */
  logFile: string | undefined;
}

/** @internal exported for testing */
export async function prepareDataset(
  exchangeDataSpec: ExchangeDataSpec,
  identity: string | undefined,
  input: string,
  outboundConsent: OutboundConsentContext,
): Promise<PreparedExchange> {
  const log = getLogger("exchange");

  const { rawRows, columns } = await loadInputRows(input, {
    allowStdin: true,
  });

  // Pre-flight this run's CSV against the committed linkage terms before any
  // exchange work -- the same satisfiability gate accept applies, in
  // configuration-specific wording, ahead of the refusal prepareForExchange
  // raises from the same core verdict below. Guards a recurring run whose CSV
  // has drifted from the terms the configuration committed to. Gated on
  // explicit linkageTerms only; the config's standardization and metadata are
  // passed so the verdict matches what prepareForExchange grades.
  if (exchangeDataSpec.linkageTerms !== undefined)
    checkLinkageSatisfiability(
      columns,
      exchangeDataSpec.linkageTerms,
      {
        source: "configuration",
        blockConsequence: RUN_BLOCK_CONSEQUENCE,
        blockRemedy:
          "or re-establish the exchange with linkage terms the CSV satisfies.",
        termsStanding: "agreed",
      },
      exchangeDataSpec.standardization,
      exchangeDataSpec.metadata,
    );

  // Show and confirm this party's OWN outbound columns before any credential,
  // terms, or data are sent, when the exchange has a consent record its current
  // set does not satisfy. Resolved through the same resolveExchangeInputs call
  // prepareForExchange itself uses, so what is confirmed is what the run would
  // transmit; the confirmation is recorded in the config, and an unconfirmable or
  // declined set refuses here -- ahead of prepareForExchange's fail-closed safety
  // check (assertOutboundPayloadConsented). A party with no consent record --
  // every non-acceptor -- passes through untouched.
  const resolved = resolveExchangeInputs(exchangeDataSpec, identity, columns);
  await confirmOutboundPayloadConsent({
    spec: exchangeDataSpec,
    metadata: resolved.metadata,
    output: resolved.linkageTerms.output,
    configPath: outboundConsent.configPath,
    logFile: outboundConsent.logFile,
    log,
  });

  const prepared = prepareForExchange(
    exchangeDataSpec,
    identity,
    rawRows,
    columns,
  );
  warnOnValueConstraints(prepared, log);
  // Recurring / offline-accept enforcement: a committed config has its received
  // payload verified against the pinned column set at runtime (see
  // reconcileReceivedPayload), so a partner that transmits a different set
  // aborts the exchange. The canonical source is the top-level
  // expectedPayloadColumns, written by an offline acceptance; it falls back to
  // the negotiated payload.receive names for an authored recurring config that
  // holds only the data dictionary. An empty set means "receive nothing"
  // strictly; an absent source reconciles lazily (a no-output party's "receive
  // nothing" is enforced independently by runExchange regardless of this field).
  const expectedFromConfig =
    exchangeDataSpec.expectedPayloadColumns ??
    exchangeDataSpec.linkageTerms?.payload?.receive?.map((c) => c.name);
  if (expectedFromConfig !== undefined)
    prepared.expectedPayloadColumns = expectedFromConfig;
  // The terms-side half of the same acceptance's enforcement: the `deduplicate`
  // the invitation declared for the inviting party's own side, written by the
  // accept paths into the config this run loads. Restored so the partner's
  // presented value is held to it at the terms exchange, before any key or
  // payload moves (assertPresentedDeduplicateMatchesInvitation). No fallback and
  // no derivation: this party's own linkage_terms.deduplicate is its OWN side,
  // so reading the binding off it would refuse the legitimate differing pair.
  // An absent field -- an exchange authored from two parties' own documents --
  // binds nothing.
  if (exchangeDataSpec.expectedPartnerDeduplicate !== undefined)
    prepared.expectedPartnerDeduplicate =
      exchangeDataSpec.expectedPartnerDeduplicate;
  return prepared;
}

/**
 * What a `certificate`-mode config that names no signing identity is told,
 * before it connects.
 *
 * Fixed prose over this party's own config: names no partner-authored content
 * and no path of its own beyond the illustrative example, under a mount of the
 * identity's own -- the shape docs/DEPLOYMENT.md gives it, kept clear of the
 * read-write mount the rotating key file needs. Names both spellings the
 * operator writes the path in, and the mode that makes the run legal without
 * one.
 */
const SIGNING_IDENTITY_FILE_UNSET_REFUSAL =
  "this exchange signs receipts (signing.mode: certificate) but names no " +
  "signing identity. Set signing.identity_file to the path where the " +
  "identity lives -- a mount of its own is the usual home, for example " +
  "/run/signing/psilink-signing-identity.json -- and create the file there " +
  "with 'psilink fingerprint --identity-file " +
  "/run/signing/psilink-signing-identity.json'. The run reads it and writes " +
  "nothing to it, so a read-only mount is enough. Or set signing.mode to " +
  '"none" to run unsigned.';

/**
 * The tilde-expanded path a `certificate`-mode signing block names, refusing the
 * block that names none.
 *
 * @throws {OperatorConfigError} when `identityFile` is absent.
 */
function certificateModeIdentityPath(identityFile: string | undefined): string {
  if (identityFile === undefined)
    throw new OperatorConfigError(SIGNING_IDENTITY_FILE_UNSET_REFUSAL);
  return expandTilde(identityFile);
}

/**
 * Refuse a `certificate`-mode signing block that names no identity file, from
 * the parsed configuration alone -- no disk read, no prompt, no connection.
 *
 * The exchange handler runs this as a pre-flight, ahead of both the dataset
 * preparation that can put the outbound-payload consent prompt in front of the
 * operator and the first-use host-key step whose probe opens a transport to the
 * server and whose accepted pin is written into the operator's `psilink.yaml`.
 * A run this refuses could never have finished, so none of that should have
 * happened on its way to being told so. {@link resolveSigningPersist} raises the
 * same refusal where it loads the identity, which is where a caller
 * outside the handler meets it.
 *
 * A no-op for every other mode and for a config with no `signing` block: neither
 * signs, so neither needs an identity.
 *
 * @throws {OperatorConfigError} when `mode: certificate` is set and
 *   `signing.identity_file` names no path (exit 64).
 */
function assertSigningIdentityNamed(signing: SigningConfig | undefined): void {
  if (signing?.mode !== "certificate") return;
  certificateModeIdentityPath(signing.identityFile);
}

/**
 * Resolve the signed-receipt inputs from the exchange config's `signing` block,
 * loading this party's signing identity from disk. Resolves `null` (skip the
 * signing step, leaving the unsigned-record path unchanged) unless the block sets
 * `mode: certificate` -- the only mode this step supports; `none` and
 * `session-derived` are no-ops here. A `certificate`-mode block with no readable
 * identity file is a usage error (exit 64, via {@link loadSigningIdentity}), the
 * same classification a malformed key file gets: an operator who asked for signed
 * receipts but has no identity should be told, not silently given an unsigned
 * exchange.
 *
 * The identity-file path is the config's `signing.identity_file` (tilde-expanded
 * at use, as `psilink fingerprint` does) and nothing else: the signing identity
 * is a credential, so where it lives is the operator's custody decision and no
 * location is resolved on their behalf. A `certificate`-mode block that names
 * none is refused here as well, in the one wording
 * {@link assertSigningIdentityNamed} uses -- an {@link OperatorConfigError}
 * joining the pre-flight family that refuses an unpinned partner and an unnamed
 * local party, and the same exit 64. The exchange handler raises it earlier
 * still, from the parsed configuration alone, so an operator never reaches this
 * point by way of a prompt or a connection the refusal makes pointless.
 *
 * The pinned partner fingerprint is passed through verbatim, and this resolver
 * states no rule about its absence: a certificate-mode block with no pin is
 * refused by core's `assertCertificateModePinsPartner` inside
 * {@link prepareForExchange}, which the handler reaches before this call.
 *
 * `termsIdentity` is this run's `linkage_terms.identity` -- the identity the
 * partner verifies the loaded certificate against -- and a certificate bound to
 * anything else makes the run unfinishable, so it is refused here (see
 * {@link assertIdentityMatchesAgreedTerms}). Pass it on every call: a load that
 * skipped the check would leave the divergence to the exchange layer's own
 * refusal at the terms exchange, which spares this party's data but not the
 * connection, the credentials it presents, or the terms it puts on the wire.
 *
 * @throws {UsageError} when `mode: certificate` is set but no signing identity
 *   exists at the named path, or the file is malformed/unreadable.
 * @throws {OperatorConfigError} when `mode: certificate` is set and
 *   `signing.identity_file` names no path, or the loaded certificate is bound to
 *   an identity other than `termsIdentity`.
 */
export async function resolveSigningPersist(
  signing: SigningConfig | undefined,
  termsIdentity: string | undefined,
): Promise<SigningPersist | null> {
  if (signing === undefined || signing.mode !== "certificate") return null;
  const identityPath = certificateModeIdentityPath(signing.identityFile);
  const identity = await loadSigningIdentity(identityPath);
  // The configured path is named once and referred back to thereafter: the field
  // is bounded only by a min(1), while the composed message truncates at the
  // display boundary, so a second copy of a long path would spend the remedy's
  // headroom on prose the operator has already read.
  if (identity === undefined)
    throw new UsageError(
      `signing is configured (mode: certificate) but no signing identity was ` +
        `found at ${identityPath}, the path signing.identity_file names; ` +
        `create it there with 'psilink fingerprint --identity-file <that ` +
        `path>', or point signing.identity_file at the file you already hold`,
    );
  assertIdentityMatchesAgreedTerms(identity.certificate, termsIdentity);
  return {
    identity,
    partnerFingerprint: signing.partnerFingerprint,
    receiptOutput: resolveReceiptOutput(signing.receiptOutput),
  };
}

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
    eventStream,
    invitation,
    ...options
  } = parsed;

  // Install the sink, apply the level, and build getLogger("exchange") through the
  // shared configureLogging helper (in that order, so the logger inherits the
  // sink): the file sink when --log-file is given, otherwise the default stderr
  // sink. A missing parent directory (configureLogFile) is a UsageError reported
  // on stderr and mapped to exit 64 by parseOrExit here.
  const { log, close: closeLogging } = parseOrExit(() =>
    configureLogging({ logLevel, logFile, name: "exchange" }),
  );

  try {
    try {
      assertRetainSweepGuard(sweepExchangeFiles, forceRetainSweep);
    } catch (err) {
      exitWithError(log, err, 64);
    }

    // Provision the key file from --invitation before loadConfig reads it: the
    // party that composed the exchange in the web app has a config with no
    // secret, so this decodes the invitation code (fail-closed on checksum,
    // schema, or expiry) and writes its own key-file copy -- shared secret and
    // expiry -- then the exchange proceeds as usual, injecting the secret from
    // that key file. A malformed/expired code or a pre-existing key file is a
    // usage error (exit 64), raised before anything is written or connected.
    if (invitation !== undefined) {
      try {
        await provisionKeyFileFromInvitation(invitation, options.keyFile);
      } catch (err) {
        exitWithError(log, err, exitCodeForError(err));
      }
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

    // A certificate-mode run naming no signing identity is unrunnable from the
    // parsed configuration alone, so it is refused here: ahead of the dataset
    // preparation that can put the outbound-payload consent prompt in front of
    // the operator, and ahead of the first-use host-key step that opens a probe
    // transport to the server and writes an accepted pin into psilink.yaml.
    // Neither should happen on the way to telling an operator the run could
    // never have finished.
    try {
      assertSigningIdentityNamed(exchangeDataSpec.signing);
    } catch (err) {
      exitWithError(log, err, 64);
    }

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

    // termsIdentity is the identity this run PUTS IN THE AGREED TERMS, which is
    // what a partner verifies a signed receipt's certificate against. It comes
    // from --identity, else the loaded configuration's linkage_terms.identity,
    // and is absent when neither names this party: the terms then hold no
    // identity at all rather than a label the operator never chose. A blank flag
    // value is what a scripted `--identity "$ORG"` sends with ORG unset, so it
    // is treated as absent and leaves the configuration's own label standing.
    let termsIdentity: string | undefined;
    let flagIdentity: string | undefined;
    try {
      flagIdentity = optionalIdentity(options.identity);
    } catch (err) {
      // The one value the flag refuses rather than reads (the init template's
      // identity placeholder) is a local usage fault decided before anything is
      // sent, so it exits 64 here; the enclosing try has only a finally, so
      // an escaping refusal would reach the top-level printer and exit 1.
      exitWithError(log, err, 64);
    }
    if (flagIdentity !== undefined) {
      termsIdentity = flagIdentity;
      if (exchangeDataSpec.linkageTerms)
        exchangeDataSpec.linkageTerms = {
          ...exchangeDataSpec.linkageTerms,
          identity: flagIdentity,
        };
    } else {
      termsIdentity = exchangeDataSpec.linkageTerms?.identity;
    }

    let prepared: PreparedExchange;
    try {
      prepared = await prepareDataset(exchangeDataSpec, termsIdentity, input, {
        configPath: options.configFile,
        logFile,
      });
    } catch (err) {
      // A usage error (exit 64) -- the `-`-at-an-interactive-terminal rejection
      // openInputSource raises is a UsageError with no exitCode -- must map to
      // 64, not collapse to 69; a missing input file has its own exitCode 69.
      exitWithError(log, err, exitCodeForError(err));
    }

    // Load the signing identity from the path the pre-flight above established
    // the config names, before any credential, terms, or data are sent: a path
    // holding no identity file fails here (exit 64) rather than after the
    // handshake, and an identity bound to something other than this run's terms
    // identity is refused while the run can still be stopped rather than after
    // it has sent this party's data toward receipts the partner rejects. Both
    // refusals read this party's own configuration and its own identity file, so
    // they are decided ahead of the host-key step below and the transport its
    // first-use probe opens. `null` when signing is not configured for
    // certificate mode, which leaves the exchange unsigned.
    let signing: SigningPersist | null;
    try {
      signing = await resolveSigningPersist(
        exchangeDataSpec.signing,
        termsIdentity,
      );
    } catch (err) {
      exitWithError(log, err, exitCodeForError(err));
    }

    // Establish SSH host-key trust: on an unpinned sftp config this prompts and
    // pins on first interactive use, and fails closed (no prompt, no
    // auto-accept) on a non-interactive run. It is a no-op for a pinned config
    // or a non-sftp channel. It follows the dataset preparation and the signing
    // resolution above because the first-use probe opens a real transport to the
    // server, while every refusal those two can raise -- the linkage terms the
    // input cannot satisfy, an unconfirmed outbound payload, a signing identity
    // that is missing or bound to another party -- is decided from local inputs
    // alone; deciding those first is what keeps a refused run from connecting.
    try {
      await establishHostKeyTrust(connection, {
        verbosity,
        loggerName: "exchange",
        // The config is already on disk and exchange does not re-write it, so a
        // first-use pin is written in place now.
        persistence: { mode: "write-now", configPath: options.configFile },
      });
    } catch (err) {
      exitWithError(log, err, exitCodeForError(err));
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
        // exchange path; the trailing object holds the CLI-only sweep controls
        // and the --event-stream toggle, then the signed-receipt inputs.
        undefined,
        undefined,
        { sweepExchangeFiles, forceRetainSweep, eventStream },
        signing,
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
        sanitizeErrorForDisplay(err),
      );
    }
    if (advisory !== undefined) log.warn(advisory);

    if (exchangeError !== undefined)
      exitWithError(log, exchangeError, exitCodeForError(exchangeError));
  } finally {
    // Restore the loglevel factory (and close the log-file descriptor, for the
    // file sink) on the normal exit path. Writes are synchronous and already
    // durable, so exitWithError's process.exit (which bypasses this finally)
    // loses nothing -- this is only factory/descriptor cleanup.
    closeLogging();
  }
}
