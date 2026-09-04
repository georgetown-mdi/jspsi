import type { Argv, Arguments } from "yargs";
import fs from "node:fs";

import {
  getLogger,
  prepareForExchange,
  sanitizeErrorForDisplay,
  UsageError,
} from "@psilink/core";
import type {
  ConnectionConfig,
  ExchangeBootstrapResult,
  ExchangeSpec,
  LinkageStrategy,
  PreparedExchange,
} from "@psilink/core";

import {
  announceRetainMode,
  assertRetainSweepGuard,
  saveConfig,
  DEFAULT_CONFIG_PATH,
} from "../config";
import { openEventStream, reportPersistenceLoss } from "../eventStream";
import { detectFileConflicts, expandTilde } from "../fileUtils";
import { DEFAULT_KEY_PATH } from "../keyFile";
import { optionalIdentity } from "../partyIdentity";
import { resolveRecordOutput } from "../recordFile";
import {
  applyConnectionCredentials,
  readConnectionCredentials,
} from "../util/atSignRefs";
import { establishHostKeyTrust } from "../hostKeyTrust";
import {
  configureLogging,
  exitCodeForError,
  exitWithError,
  parseOrExit,
} from "../util/cli";
import { channelFromURL, connectionFromURL } from "../connectionFromUrl";
import {
  addCommonBootstrapOptions,
  connectionOverridesFrom,
  parseCommonBootstrapArgs,
  warnConnectionPerPollShortInterval,
  warnLowPollingFrequency,
  warnUnsupportedFileSyncFlags,
  type CommonBootstrapOptions,
  type ConnectionOverrideOptions,
} from "../optionDefinitions";
import {
  loadInputRows,
  observedReceivedColumnsForSave,
  parseLinkageStrategyFlag,
  singlePassDisclosureNotice,
  withLinkageStrategy,
} from "../onlineBootstrap";
import {
  runProtocol,
  WEBRTC_RENDEZVOUS_SECRET_REQUIRED,
  type ProtocolConnectionConfig,
} from "../protocol";
import {
  assertNoProvisionConflicts,
  provisionConfigAndKey,
  provisionLeftConfigOnDisk,
} from "./provision";
import { warnOnValueConstraints } from "./valueConstraintWarnings";

// channelFromURL is used by the handler's pre-connection flag-warning path (and
// by zeroSetup.test.ts); re-export it so both keep importing it from this module.
export { channelFromURL };

export function builder(cmd: Argv): Argv {
  return addCommonBootstrapOptions(
    cmd
      .usage(
        "Usage:\n" +
          "  $0 [--save] [options] URL INPUT_FILE [OUTPUT_FILE]\n\n" +
          "Arguments:\n" +
          "  URL          server URL (sftp:// or ws://)\n" +
          "  INPUT_FILE   CSV to link; use `-` to read from stdin\n" +
          "  OUTPUT_FILE  where to write results; defaults to stdout\n\n" +
          "Both parties run this command against the same server URL. Linkage\n" +
          "terms are inferred from each party's input file. No configuration\n" +
          "files are required or written by default.",
      )
      .option("save", {
        type: "boolean",
        default: false,
        describe:
          "save exchange config and establish a shared secret for future " +
          "recurring exchanges",
      }),
    // The config/key files are written only under --save; the longer file-sync
    // describe text matches exchange's. The server-* / peer-id defaults (URL-
    // sourced) already fit zero-setup, so only these differ from the shared text.
    {
      "config-file":
        "where to write psilink.yaml when --save is given (default: " +
        DEFAULT_CONFIG_PATH +
        ")",
      "key-file":
        "where to write .psilink.key when --save is given (default: " +
        DEFAULT_KEY_PATH +
        ")",
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
    .option("linkage-strategy", {
      type: "string",
      describe:
        "how the agreed linkage keys are run on the wire (default: cascade). " +
        "cascade runs one dependent PSI round per key; single-pass batches " +
        "every key into one exchange for a constant round-trip count, at the " +
        "cost of disclosing your full per-key value structure to the receiver " +
        "-- a consented disclosure tradeoff, not a free speed-up. Both " +
        "parties must select the same value or the exchange aborts. See " +
        "https://github.com/georgetown-mdi/jspsi/blob/main/docs/" +
        "EXCHANGE_REFERENCE.md (linkage_terms.linkage_strategy).",
    })
    .demand(1);
}

// The common bootstrap options plus the zero-setup-specific positionals, the
// --save flag, and the CLI-only sweep controls. record/recordFile/logLevel/
// verbosity come from CommonBootstrapOptions. The connection-override subset the
// handler feeds to createConnection is CommonBootstrapOptions' server-*/tuning
// fields (a superset of ConnectionOverrideOptions); the fields below are excluded
// from that path -- the CLI-only sweep controls never reach the config schema,
// and --linkage-strategy shapes the linkage terms, not the connection.
interface ZeroSetupArgs extends CommonBootstrapOptions {
  positionals: Array<string | number>;
  save: boolean;
  // CLI-only sweep controls (see protocol.FileSyncRuntimeOptions).
  sweepExchangeFiles: boolean;
  forceRetainSweep: boolean;
  // The operator's --linkage-strategy selection, applied to the terms this
  // command authors from its input (see prepareDataset).
  linkageStrategy?: LinkageStrategy;
}

function parseArgs(argv: Arguments): ZeroSetupArgs {
  // Parse the common options through the shared parser (the same singleValue
  // repeat-rejection and log-level validation invite/accept use), then layer the
  // zero-setup-specific handling on top. Unlike exchange, an `@path` credential
  // ref is carried through verbatim (not resolved at parse time) and read only at
  // the live-use boundary (readConnectionCredentials in the handler), so a
  // persisted config keeps the `@path` rather than the resolved secret.
  const common = parseCommonBootstrapArgs(argv);
  return {
    ...common,
    // Local filesystem paths accept a leading `~`.
    configFile: expandTilde(common.configFile),
    keyFile: expandTilde(common.keyFile),
    recordFile: expandTilde(common.recordFile),
    // zero-setup-specific positionals and flags.
    positionals: argv._,
    save: (argv["save"] as boolean | undefined) ?? false,
    // CLI-only, never persisted: resolve to a definite boolean here since there
    // is no config layer to merge with (unlike the file-sync flags above).
    sweepExchangeFiles:
      (argv["sweep-exchange-files"] as boolean | undefined) ?? false,
    forceRetainSweep:
      (argv["force-retain-sweep"] as boolean | undefined) ?? false,
    // Validated to the enum here (inside parseArgs -> parseOrExit), so an unknown
    // value is a clean usage error (exit 64) before any side effect; singleValue
    // rejects a repeat first. Undefined when unset, leaving the cascade default.
    linkageStrategy: parseLinkageStrategyFlag(argv),
  };
}

function tryParseURL(raw: string, errorMsg: string): URL {
  try {
    return new URL(raw);
  } catch (cause) {
    // Object.assign rather than `new Error(msg, { cause })`: the second-arg
    // ErrorOptions form requires lib ES2022, but the runtime preserves the
    // assigned property either way.
    throw Object.assign(new Error(errorMsg), { cause });
  }
}

/**
 * Resolves the positional CLI arguments to a server URL, input path, and
 * optional output path. Throws with a user-facing message on bad input.
 * @internal exported for testing
 */
export function resolvePositionals(positionals: Array<unknown>): {
  server: URL;
  input: string;
  output: string | undefined;
} {
  const arg0 = String(positionals[0]);
  const arg1 =
    positionals[1] !== undefined ? String(positionals[1]) : undefined;
  const arg2 =
    positionals[2] !== undefined ? String(positionals[2]) : undefined;

  if (arg1 === undefined) {
    // Single positional: might be a file (user forgot the subcommand) or a URL
    // with no input file.
    if (fs.existsSync(arg0)) {
      throw new Error(
        "input file provided without a server URL; " +
          "did you mean 'psilink exchange INPUT_FILE'?",
      );
    }
    throw new Error(
      "input file not specified; usage: psilink URL INPUT_FILE [OUTPUT_FILE]",
    );
  }

  const server = tryParseURL(
    arg0,
    // Do not interpolate the raw input: a malformed but credential-bearing URL
    // (e.g. a mistyped port on sftp://user:secret@host) reaches here, and the
    // message surfaces to the terminal and any --log-file. Unlike the redacted
    // file:// case below, the input failed to parse, so there is no URL to route
    // through redactUrlCredentials; drop it entirely. The usage hint stands in
    // for the offending value, which the operator just typed.
    "unable to parse server URL; usage: psilink URL INPUT_FILE [OUTPUT_FILE]",
  );
  return { server, input: arg1, output: arg2 };
}

/**
 * Build the zero-setup connection from a server URL. A thin adapter over the
 * shared {@link connectionFromURL} domain builder: it fans this command's parsed
 * options into the structured {@link ConnectionOverrides} shape at the call site
 * (the domain builder takes the pre-built overrides, never the CLI option bag),
 * so the URL-to-config mapping -- percent-decoding, the bare-host path guard, the
 * filedrop non-localhost and host-less-sftp rejections -- lives in one place
 * shared with invite/accept. Widens the builder's {@link RunnableConnectionConfig}
 * back to {@link ConnectionConfig} for the handler, which casts to
 * {@link ProtocolConnectionConfig} at the runProtocol boundary.
 *
 * @internal exported for testing
 */
export function createConnection(
  server: URL,
  options: ConnectionOverrideOptions,
): ConnectionConfig {
  return connectionFromURL(server, connectionOverridesFrom(options));
}

async function prepareDataset(
  identity: string | undefined,
  input: string,
  linkageStrategy: LinkageStrategy | undefined,
): Promise<PreparedExchange> {
  const log = getLogger("psilink");

  const { rawRows, columns } = await loadInputRows(input, {
    allowStdin: true,
  });
  const prepared = prepareForExchange({}, identity, rawRows, columns);
  // Apply the operator's --linkage-strategy onto the terms prepareForExchange
  // authored from the input (a no-op for the cascade default), so it rides into
  // both the exchange and the --save spec. The strategy does not affect the
  // standardization/dataset prepareForExchange already built, so reshaping the
  // terms here is safe. Surface the disclosure tradeoff at selection, mirroring
  // invite; zero-setup never sources terms from a config, so the note always
  // reflects what is used.
  prepared.linkageTerms = withLinkageStrategy(
    prepared.linkageTerms,
    linkageStrategy,
  );
  if (linkageStrategy === "single-pass") log.info(singlePassDisclosureNotice());
  warnOnValueConstraints(prepared, log);
  return prepared;
}

/**
 * Build the {@link ExchangeSpec} a `--save` zero-setup exchange persists: the
 * connection actually used plus the inferred linkage terms and metadata.
 * Standardization is omitted -- `psilink exchange` re-infers it from the input
 * file on load (the same inference that already succeeded here), so the saved
 * config stays minimal. The connection carries whatever credentials the URL or
 * --server-* flags supplied; `saveConfig` writes it owner-read-only.
 *
 * `observedReceivedColumns` is the received-payload set this party observed in the
 * exchange (from {@link runProtocol}'s result). When non-empty it is recorded as
 * `expectedPayloadColumns` so a later recurring `psilink exchange` fails closed on
 * a divergent received payload; an empty or absent observation records nothing and
 * stays lazy (see {@link observedReceivedColumnsForSave} for why an empty
 * observation must not be persisted).
 *
 * @internal exported for testing
 */
export function buildSaveSpec(
  connection: ConnectionConfig,
  prepared: PreparedExchange,
  observedReceivedColumns?: string[],
): ExchangeSpec {
  const expectedPayloadColumns = observedReceivedColumnsForSave(
    observedReceivedColumns,
  );
  return {
    connection,
    linkageTerms: prepared.linkageTerms,
    metadata: prepared.metadata,
    ...(expectedPayloadColumns !== undefined ? { expectedPayloadColumns } : {}),
  };
}

/**
 * Apply the `--save` bootstrap outcome after a successful zero-setup exchange:
 * persist config/key as appropriate and emit the matching notice. It performs no
 * network I/O -- only provisioning-layer writes and logging -- so it is unit
 * tested directly. Conflict detection already ran up front in the handler (via
 * {@link assertNoProvisionConflicts}); the both-saved path re-checks through
 * {@link provisionConfigAndKey}, and the config-only path writes through
 * {@link saveConfig}, the same writer that helper uses.
 *
 * The four cases mirror docs/SECURITY_DESIGN.md "Bootstrapping a shared secret":
 * we-saved + both-saved (write config + key), we-saved + partner-did-not (write
 * config only, instruct to invite), we-did-not-save + partner-did (save nothing,
 * explain), and neither-saved (the standard recurring-exchange hint).
 *
 * A throw from here does not fail the run: the exchange it follows has already
 * completed, so the handler reports the failure as a persistence loss on both
 * machine channels. An error raised here therefore steers the operator to
 * `psilink invite` rather than to a re-run, which would conduct a second
 * exchange.
 *
 * @internal exported for testing
 */
export function finalizeBootstrap(params: {
  save: boolean;
  bootstrap: ExchangeBootstrapResult;
  spec: ExchangeSpec;
  configFile: string;
  keyFile: string;
  log: { info: (message: string) => void };
}): void {
  const { save, bootstrap, spec, configFile, keyFile, log } = params;

  // Invariant guard: a shared secret is established only when both parties pass
  // --save, so a secret reaching here with save === false is an internal
  // contradiction (the secret frame is gated on this party's own intent in
  // runExchange). Fail loudly rather than silently discard a negotiated secret.
  if (!save && bootstrap.sharedSecret !== undefined)
    throw new Error(
      "internal error: a shared secret was established but this party did not " +
        "opt to save; refusing to silently discard it",
    );

  if (save) {
    if (bootstrap.sharedSecret !== undefined) {
      // Both parties saved: the initiator generated the secret and the responder
      // received it, so both persist the same config and key.
      const { configPath, keyPath } = provisionConfigAndKey(
        spec,
        { sharedSecret: bootstrap.sharedSecret },
        { configPath: configFile, keyPath: keyFile },
      );
      log.info(
        `established a shared secret with your partner; wrote config to ` +
          `${configPath} and key file to ${keyPath}. Keep the key file ` +
          `private. Run 'psilink exchange' for future exchanges with this ` +
          `partner.`,
      );
      return;
    }
    // We saved but the partner did not: there is no secret, so persist the
    // config alone (no key file) and steer the user to the invitation flow.
    // Re-check for a config conflict before writing: the both-saved branch gets
    // this from provisionConfigAndKey, but this branch writes through saveConfig
    // directly. The up-front gate ran before the network round-trip, so a file
    // that appeared at the path in that window must abort here rather than
    // clobber the user's configuration -- the same "never clobber a half-finished
    // bootstrap" intent as the pre-flight check. Only configFile is re-checked,
    // not keyFile: this branch writes no key file, so gating on a path it will
    // not touch would reject a write that is safe. The asymmetry with the
    // pre-flight (which reserves both) is deliberate -- the pre-flight cannot yet
    // know the partner declined to save, whereas here that is settled.
    const conflicts = detectFileConflicts([configFile]);
    if (conflicts.length > 0)
      throw new UsageError(
        `refusing to overwrite ${conflicts.join(", ")}, which appeared after ` +
          "the pre-flight check; the exchange itself completed, so move or " +
          "remove that file (or pass --config-file) and run 'psilink invite' " +
          "to set up the recurring exchange rather than re-running this one",
      );
    saveConfig(configFile, spec);
    log.info(
      `your partner did not also choose to save, so no shared secret was ` +
        `established. Wrote config to ${configFile} (no key file). To set up ` +
        `a recurring exchange, run 'psilink invite' and share the invitation ` +
        `with your partner.`,
    );
    return;
  }

  if (bootstrap.partnerSaveIntent) {
    // The partner wants a recurring exchange but we did not pass --save, so
    // nothing was saved on our end.
    log.info(
      "your partner is trying to establish a recurring exchange, but you did " +
        "not pass --save, so nothing was saved on your end. Wait for an " +
        "invitation from your partner ('psilink accept'), or coordinate to " +
        "re-run this exchange with --save on both sides.",
    );
    return;
  }

  log.info(
    "To establish a recurring exchange with this partner, run 'psilink " +
      "invite URL INPUT_FILE' and share the invitation string, or coordinate " +
      "with your partner to re-run with --save.",
  );
}

/**
 * The persistence-loss notice a `--save` bootstrap that did not reach disk
 * reports on the machine-interface stream, naming the files this run was asked
 * to write: both parties saving provisions a config and a key file, a partner
 * that declined to save leaves the config alone, and a party that passed no
 * `--save` writes nothing at all (see {@link finalizeBootstrap}). The CAUSE is
 * deliberately absent -- it goes to the human log beside the call, because the
 * emitter escapes its message exactly once and pre-rendered error text would
 * reach a supervisor double-escaped.
 *
 * `configLeftOnDisk` is the both-saved corner where the config was written, the
 * key file then failed, and the rollback of that config failed too
 * ({@link provisionLeftConfigOnDisk}): the file is on disk, so the notice names
 * it as written and steers the operator past the conflict it would otherwise
 * hit on the `psilink invite` this very notice advises.
 */
function unsavedBootstrapNotice(params: {
  save: boolean;
  sharedSecret: string | undefined;
  configLeftOnDisk: boolean;
  configFile: string;
  keyFile: string;
}): string {
  if (!params.save)
    return (
      "the exchange completed and its results are written, but the " +
      "post-exchange bootstrap step did not complete; this run was asked to " +
      "save nothing, and the exchange must not be re-run"
    );
  if (params.configLeftOnDisk)
    return (
      `the exchange completed and its results are written, but the key file ` +
      `at ${params.keyFile} did not reach disk, so no recurring exchange is ` +
      `set up; the configuration at ${params.configFile} was written and ` +
      `could not be removed, so move or remove it, then run 'psilink invite' ` +
      `and share the invitation with your partner -- do not re-run this ` +
      `exchange`
    );
  const files =
    params.sharedSecret !== undefined
      ? `the configuration at ${params.configFile} and the key file at ` +
        `${params.keyFile}`
      : `the configuration at ${params.configFile}`;
  return (
    `the exchange completed and its results are written, but ${files} did ` +
    "not reach disk, so no recurring exchange is set up; do not re-run this " +
    "exchange -- run 'psilink invite' and share the invitation with your " +
    "partner instead"
  );
}

export async function handler(argv: Arguments): Promise<void> {
  // parseArgs resolves the log level and reads every option, so it runs before
  // the logger exists. parseOrExit reports its usage errors -- a repeated
  // single-value flag or an unrecognized log-level -- on stderr and exits 64,
  // and lets any other (unexpected) failure propagate to the top-level handler.
  const parsed = parseOrExit(() => parseArgs(argv));
  const {
    positionals,
    logLevel,
    logFile,
    verbosity,
    sweepExchangeFiles,
    forceRetainSweep,
    eventStream,
    linkageStrategy,
    ...options
  } = parsed;

  // Install the sink, apply the level, and build getLogger("psilink") through the
  // shared configureLogging helper (in that order, so the logger inherits the
  // sink): the file sink when --log-file is given, otherwise the default stderr
  // sink. A missing parent directory (configureLogFile) is a UsageError reported
  // on stderr and mapped to exit 64 by parseOrExit here.
  const { log, close: closeLogging } = parseOrExit(() =>
    configureLogging({ logLevel, logFile, name: "psilink" }),
  );

  try {
    try {
      assertRetainSweepGuard(sweepExchangeFiles, forceRetainSweep);
    } catch (err) {
      exitWithError(log, err, 64);
    }

    log.warn(
      "WARNING: this exchange relies on transport-layer authentication only. " +
        "You must trust the server administrator. " +
        "Run 'psilink invite' / 'psilink accept' to establish a recurring " +
        "exchange with application-layer encryption.",
    );

    let resolved: ReturnType<typeof resolvePositionals>;
    try {
      resolved = resolvePositionals(positionals);
    } catch (err) {
      exitWithError(log, err, 64);
    }

    const { server, input, output } = resolved;

    // Warn before createConnection can throw so the user sees the flag issue even
    // if the channel is refused. The channel is derived from the URL here
    // (pre-connection); an unknown scheme is swallowed because createConnection
    // surfaces it below.
    let channel: ConnectionConfig["channel"] | undefined;
    try {
      channel = channelFromURL(server);
    } catch {
      // Unknown URL scheme; createConnection handles this.
    }
    if (channel !== undefined)
      warnUnsupportedFileSyncFlags(
        channel,
        {
          locklessRendezvous: options.locklessRendezvous,
          retainFiles: options.retainFiles,
          pollingFrequencyMs: options.pollingFrequencyMs,
          connectionPerPoll: options.connectionPerPoll,
        },
        log,
      );
    // Warn when the --polling-frequency override is set aggressively low (a
    // sub-second poll can trip an SFTP server's anti-flood protection); no-op when
    // the flag was not passed. Pass the resolved channel so this is silent on a
    // non-file-sync (or unresolved) channel, where the override is dropped and
    // warnUnsupportedFileSyncFlags above emits the ignored-flag warning instead.
    warnLowPollingFrequency(channel, options.pollingFrequencyMs, log);
    // Warn when --connection-per-poll is paired with a short poll interval. The
    // zero-setup connection is built from the URL with no loaded config, so the
    // CLI flag and override are the effective mode and interval here.
    warnConnectionPerPollShortInterval(
      channel,
      options.connectionPerPoll,
      options.pollingFrequencyMs,
      log,
    );

    // A zero-setup exchange over webrtc is refused for the reason it cannot
    // work, rather than as an unsupported channel: the two parties find each
    // other at signaling ids derived from a shared secret, and a zero-setup
    // exchange is defined by not having one. Raised here, before any file
    // conflict check or dataset read, so nothing is done on the way to it.
    if (channel === "webrtc")
      exitWithError(log, new UsageError(WEBRTC_RENDEZVOUS_SECRET_REQUIRED), 64);

    // Detect a pre-existing config/key before any network activity. With --save,
    // a target that already exists is an error -- a half-finished bootstrap must
    // never clobber a user's configuration -- and the check runs up front so it
    // aborts before a connection is opened. Without --save, no files are written,
    // so an existing config/key is merely ignored; warn and point at the command
    // that would use it (docs/CLI.md "Zero-setup exchange").
    //
    // Both paths are reserved here even though the partner-did-not-save branch
    // ends up writing only the config: whether a key file is written depends on
    // the partner's intent, which is not known until after the terms round-trip.
    // Reserving both up front fails fast on an existing key file rather than
    // discovering the conflict post-exchange, where the secret has already crossed
    // the wire and the only recovery is a re-invite. The conservative gate trades a
    // rare false block (a stale key file plus a partner who declines to save) for
    // never stranding a half-saved bootstrap, and matches docs/CLI.md (an existing
    // config OR key with --save is an error).
    if (options.save) {
      try {
        assertNoProvisionConflicts({
          configPath: options.configFile,
          keyPath: options.keyFile,
        });
      } catch (err) {
        exitWithError(log, err, 64);
      }
    } else {
      const existing = detectFileConflicts([
        options.configFile,
        options.keyFile,
      ]);
      if (existing.length > 0) {
        const noun = existing.length === 1 ? "file" : "files";
        log.warn(
          `existing ${noun} ${existing.join(", ")} will be ignored by this ` +
            "zero-setup exchange; to use saved configuration and key material, " +
            "run 'psilink exchange' instead",
        );
      }
    }

    let connection: ConnectionConfig;
    let liveConnection: ConnectionConfig;
    let prepared: PreparedExchange;
    try {
      connection = createConnection(server, options);
      // The quick path asks nothing and requires nothing: `--identity` rides
      // into the terms when it names this party, and the terms carry none when
      // it does not. A blank value is what a scripted `--identity "$ORG"` sends
      // with ORG unset, so it reads as absent rather than as an empty label.
      prepared = await prepareDataset(
        optionalIdentity(options.identity),
        input,
        linkageStrategy,
      );
      // Read the files any `@path` credential ref names, holding the values
      // aside rather than applying them: `connection` must keep the reference so
      // finalizeBootstrap's save persists it and not the secret. A missing,
      // unreadable, or empty referenced file is a UsageError (exit 64) decided
      // from this party's own filesystem, so it is settled here rather than
      // after the host-key step below has contacted the server.
      const credentials = readConnectionCredentials(connection);
      // Establish first-use SSH host-key trust on the ORIGINAL `connection`
      // (before the clone below), so the pin reaches both the live connect and,
      // under --save, the persisted config (finalizeBootstrap saves this same
      // object). A pinned connection is a no-op; an unpinned one prompts on a TTY
      // and fails closed otherwise. With --save the pin is saved with the config;
      // without it the key is trusted for this one-off exchange only. It follows
      // the preparation and the credential read above because the first-use probe
      // opens a real transport to the server, while every refusal those two can
      // raise -- an unreadable or unparsable CSV, a dataset core refuses to
      // prepare, a credential @path naming a file that is not there -- is decided
      // from this party's own input alone; deciding those first is what keeps a
      // refused run from connecting.
      await establishHostKeyTrust(connection, {
        verbosity,
        loggerName: "psilink",
        persistence: options.save
          ? { mode: "save-with-config", configPath: options.configFile }
          : { mode: "ephemeral" },
      });
      // The connection the exchange dials: the original cloned AFTER the host-key
      // step, so any just-confirmed pin rides along, with the credential values
      // read above applied to the clone alone.
      liveConnection = applyConnectionCredentials(connection, credentials);
    } catch (err) {
      // A bad URL scheme or unsupported channel is a usage error (exit 64);
      // prepareDataset failures carry their own exitCode; otherwise exit 69.
      exitWithError(log, err, exitCodeForError(err));
    }

    announceRetainMode(connection, log);

    try {
      // The --save bootstrap persists from the onOutputComplete hook below and
      // reports what it loses on the machine-interface stream, so this command
      // opens that stream itself and hands runProtocol the emitter rather than
      // the flag: both sources then ride the one stream that carries the run's
      // terminal event. openEventStream runs the same fail-closed fd-3 preflight
      // runProtocol would have run, at the same point in the run, so an unwired
      // descriptor stays a usage error (exit 64) raised before any connection is
      // opened and after the command-level work ahead of it (see
      // docs/spec/CLI_EVENTS.md).
      const eventStreamEmitter = openEventStream(eventStream);
      // Cast: `liveConnection` is `ConnectionConfig` (which includes the webrtc
      // channel), so TypeScript cannot verify it fits `ProtocolConnectionConfig`
      // (constrained to sftp and filedrop). The double cast through `unknown` is
      // intentional; the channel guard inside `runProtocol` rejects unsupported
      // channels at runtime.
      // auth: null is the explicit opt-out that tells runProtocol to proceed
      // without authentication and without a warning.
      await runProtocol(
        liveConnection as unknown as ProtocolConnectionConfig,
        null,
        prepared,
        output,
        verbosity,
        "psilink",
        resolveRecordOutput({
          enabled: options.record,
          recordFile: options.recordFile,
        }),
        // Carry this party's --save intent into the in-band bootstrap. The
        // exchange advertises it to the partner and, when both saved, hands the
        // established secret to the hook below. Pass the raw boolean, never
        // `options.save || undefined`: a non-saving party (options.save === false)
        // must still receive a defined bootstrap so finalizeBootstrap can emit the
        // "your partner wanted to save" notice. Collapsing false to undefined
        // would leave the hook with nothing to act on and silently swallow that
        // notice. The wire is unaffected either way -- the save field only rides
        // the terms frame when intent is true (see exchangeTerms).
        options.save,
        // onAuthenticated is undefined on the unauthenticated zero-setup path; the
        // trailing object carries the CLI-only sweep controls, the stream opened
        // above, and this command's own post-exchange persistence.
        undefined,
        {
          sweepExchangeFiles,
          forceRetainSweep,
          eventStream: eventStreamEmitter,
          // The --save provisioning, run inside runProtocol's frame rather than
          // after it returns so that a loss is reported BEFORE the terminal event
          // -- the only ordering a supervisor that stops reading there observes.
          onOutputComplete: ({ bootstrap, observedReceivedPayloadColumns }) => {
            try {
              // The hook runs only on the fully-completed path, and this command
              // always passes a boolean --save intent, so an absent bootstrap
              // result is an internal contradiction rather than the interrupt it
              // marks on the returned result. Fail it into the report below
              // instead of skipping the save in silence.
              if (bootstrap === undefined)
                throw new Error(
                  "internal error: the completed exchange returned no " +
                    "bootstrap result, though a --save intent was passed",
                );
              finalizeBootstrap({
                save: options.save,
                bootstrap,
                // Record the received-payload set observed in this first exchange
                // so a later `psilink exchange` on the saved config fails closed
                // on a divergent payload; buildSaveSpec drops the ambiguous empty
                // observation and stays lazy. Only persisted when this party
                // actually saves (finalizeBootstrap).
                spec: buildSaveSpec(
                  connection,
                  prepared,
                  observedReceivedPayloadColumns,
                ),
                configFile: options.configFile,
                keyFile: options.keyFile,
                log,
              });
            } catch (err) {
              // The exchange has already succeeded and written its output, so a
              // failure here cannot undo the linkage: what is lost is the
              // recurring-exchange setup, which is the persistence-loss class,
              // not a transport failure a supervisor should retry -- a retried
              // zero-setup run conducts a second exchange and re-sends this
              // party's records. The config conflict that appeared after the
              // pre-flight takes the same report rather than its own usage code:
              // the pre-flight passed when the run began, so there is nothing
              // about the invocation for the operator to correct, and 64 would
              // invite that same re-run.
              const notice = unsavedBootstrapNotice({
                save: options.save,
                sharedSecret: bootstrap?.sharedSecret,
                configLeftOnDisk: provisionLeftConfigOnDisk(err),
                configFile: options.configFile,
                keyFile: options.keyFile,
              });
              log.error(`${notice}: ${sanitizeErrorForDisplay(err)}`);
              reportPersistenceLoss(notice, eventStreamEmitter);
            }
          },
        },
      );
    } catch (err) {
      exitWithError(log, err, exitCodeForError(err));
    }
  } finally {
    // Restore the loglevel factory (and close the log-file descriptor, for the
    // file sink) on the normal exit path, including a run that took a
    // persistence loss and returns with the exit code already set.
    // Writes are synchronous and already durable, so exitWithError's process.exit
    // (which bypasses this finally) loses nothing -- this is only
    // factory/descriptor cleanup.
    closeLogging();
  }
}
