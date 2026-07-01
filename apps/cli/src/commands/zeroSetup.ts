import type { Argv, Arguments } from "yargs";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { userInfo } from "node:os";

import {
  getLogger,
  loadCSVFile,
  prepareForExchange,
  UsageError,
} from "@psilink/core";
import type {
  ConnectionConfig,
  ExchangeBootstrapResult,
  ExchangeSpec,
  FileDropConnectionConfig,
  LinkageStrategy,
  SFTPConnectionConfig,
  PreparedExchange,
} from "@psilink/core";

import {
  applyConnectionOverrides,
  announceRetainMode,
  assertRetainSweepGuard,
  saveConfig,
  DEFAULT_CONFIG_PATH,
} from "../config";
import { detectFileConflicts, expandTilde } from "../fileUtils";
import { DEFAULT_KEY_PATH } from "../keyFile";
import { resolveRecordOutput } from "../recordFile";
import { resolveConnectionCredentials } from "../util/atSignRefs";
import { establishHostKeyTrust } from "../hostKeyTrust";
import {
  configureLogging,
  exitWithError,
  parseOrExit,
  openInputSource,
} from "../util/cli";
import {
  addCommonBootstrapOptions,
  connectionOverridesFrom,
  observedReceivedColumnsForSave,
  parseCommonBootstrapArgs,
  parseLinkageStrategyFlag,
  singlePassDisclosureNotice,
  warnUnsupportedFileSyncFlags,
  withLinkageStrategy,
  type CommonBootstrapOptions,
} from "./bootstrap";
import { runProtocol, type ProtocolConnectionConfig } from "../protocol";
import { assertNoProvisionConflicts, provisionConfigAndKey } from "./provision";
import { warnOnValueConstraints } from "./valueConstraintWarnings";
import {
  decodeUrlComponent,
  redactUrlCredentials,
} from "../util/connectionUrl";

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
    })
    .option("linkage-strategy", {
      type: "string",
      describe:
        "how the agreed linkage keys are run on the wire (default: cascade). " +
        "cascade runs one dependent PSI round per key; single-pass batches " +
        "every key into one exchange for a constant round-trip count, at the " +
        "cost of disclosing your full per-key value structure to the receiver " +
        "-- a consented disclosure tradeoff, not a free speed-up (see " +
        "docs/EXCHANGE_REFERENCE.md, linkage_terms.linkage_strategy). Both " +
        "parties must select the same value or the exchange aborts.",
    })
    .demand(1);
}

// --- Argument parsing --------------------------------------------------------

// The common bootstrap options plus the zero-setup-specific positionals, the
// --save flag, and the CLI-only sweep controls. record/recordFile/logLevel/
// verbosity come from CommonBootstrapOptions.
interface ZeroSetupArgs extends CommonBootstrapOptions {
  positionals: Array<string | number>;
  save: boolean;
  // CLI-only sweep controls (see protocol.FileSyncRuntimeOptions). Excluded from
  // ZeroSetupOptions below so they never reach createConnection / the config
  // schema.
  sweepExchangeFiles: boolean;
  forceRetainSweep: boolean;
  // The operator's --linkage-strategy selection, applied to the terms this
  // command authors from its input (see prepareDataset). Excluded from
  // ZeroSetupOptions below: it shapes the linkage terms, not the connection.
  linkageStrategy?: LinkageStrategy;
}

type ZeroSetupOptions = Omit<
  ZeroSetupArgs,
  | "positionals"
  | "logLevel"
  | "logFile"
  | "verbosity"
  | "sweepExchangeFiles"
  | "forceRetainSweep"
  | "linkageStrategy"
  | "record"
  | "recordFile"
>;

function parseArgs(argv: Arguments): ZeroSetupArgs {
  // Parse the common options through the shared parser (the same singleValue
  // repeat-rejection and log-level validation invite/accept use), then layer the
  // zero-setup-specific handling on top. Unlike exchange, an `@path` credential
  // ref is carried through verbatim (not resolved at parse time) and read only at
  // the live-use boundary (resolveConnectionCredentials in the handler), so a
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

// --- Positional parsing ------------------------------------------------------

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

// --- Connection config from URL ----------------------------------------------

/**
 * Maps a server URL protocol to a connection channel identifier.
 * @internal exported for testing
 */
export function channelFromURL(url: URL): ConnectionConfig["channel"] {
  switch (url.protocol) {
    case "sftp:":
    case "ssh:":
      return "sftp";
    case "ws:":
    case "wss:":
      return "webrtc";
    case "file:":
      return "filedrop";
    default:
      // Invalid caller input (exit 64), not a transport failure.
      throw new UsageError(
        `unsupported URL scheme: ${url.protocol}; expected sftp://, ` +
          "ssh://, ws://, wss://, or file://",
      );
  }
}

/** @internal */
export function createConnection(
  server: URL,
  options: ZeroSetupOptions,
): ConnectionConfig {
  const channel = channelFromURL(server);

  if (channel === "filedrop") {
    if (server.hostname && server.hostname !== "localhost") {
      throw new UsageError(
        `file:// URLs must use three slashes (e.g. file:///mnt/share/drop) ` +
          `or file://localhost/path; got: ${redactUrlCredentials(server)}`,
      );
    }
    const base: FileDropConnectionConfig = {
      channel: "filedrop",
      path: fileURLToPath(server),
    };
    // applyConnectionOverrides ignores the server-* fields on a filedrop
    // connection, so the full override set from connectionOverridesFrom is safe
    // here -- only the shared and file-sync options take effect.
    return applyConnectionOverrides(base, connectionOverridesFrom(options));
  }

  if (channel !== "sftp")
    throw new UsageError(`${channel} channel not yet supported in the CLI`);

  const base: SFTPConnectionConfig = {
    channel: "sftp",
    server: {
      host: decodeUrlComponent(server.hostname, server),
      port: server.port ? Number(server.port) : undefined,
      username: server.username
        ? decodeUrlComponent(server.username, server)
        : undefined,
      password: server.password
        ? decodeUrlComponent(server.password, server)
        : undefined,
      // A bare-host URL (sftp://host or sftp://host/) leaves the remote path
      // unset, matching connectionFromURL so both URL-to-config builders agree
      // on the same input rather than this twin pinning the filesystem root.
      path:
        server.pathname && server.pathname !== "/"
          ? decodeUrlComponent(server.pathname, server)
          : undefined,
    },
  };

  return applyConnectionOverrides(base, connectionOverridesFrom(options));
}

// --- Data preparation --------------------------------------------------------

async function prepareDataset(
  identity: string,
  input: string,
  linkageStrategy: LinkageStrategy | undefined,
): Promise<PreparedExchange> {
  const log = getLogger("psilink");

  const csvResult = await loadCSVFile(
    openInputSource(input, { allowStdin: true }),
  );
  const rawRows = csvResult.data as Array<Record<string, string>>;
  const prepared = prepareForExchange(
    {},
    identity,
    rawRows,
    csvResult.meta.fields ?? [],
  );
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
  for (const warning of prepared.warnings)
    log.warn("cleaning configuration issue:", warning);
  warnOnValueConstraints(prepared, log);
  return prepared;
}

// --- Save bootstrap ----------------------------------------------------------

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
          "the pre-flight check; move or remove it and re-run with --save",
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

// --- Handler -----------------------------------------------------------------

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
    // if the channel is not yet supported. The channel is derived from the URL
    // here (pre-connection); an unknown scheme is swallowed because
    // createConnection surfaces it below.
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
        },
        log,
      );

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
      // Establish first-use SSH host-key trust on the ORIGINAL `connection`
      // (before the clone below), so the pin reaches both the live connect and,
      // under --save, the persisted config (finalizeBootstrap saves this same
      // object). A pinned connection is a no-op; an unpinned one prompts on a TTY
      // and fails closed otherwise. With --save the pin is saved with the config;
      // without it the key is trusted for this one-off exchange only.
      await establishHostKeyTrust(connection, {
        verbosity,
        loggerName: "psilink",
        persistence: options.save
          ? { mode: "save-with-config", configPath: options.configFile }
          : { mode: "ephemeral" },
      });
      // `connection` keeps any `@path` credential ref so finalizeBootstrap's save
      // persists the reference, not the secret; `liveConnection` resolves it for
      // the exchange itself. A missing or unreadable `@path` file is a UsageError
      // here (exit 64), before any network activity.
      liveConnection = resolveConnectionCredentials(connection);
      const identity = options.identity ?? userInfo().username;
      prepared = await prepareDataset(identity, input, linkageStrategy);
    } catch (err) {
      // A bad URL scheme or unsupported channel is a usage error (exit 64);
      // prepareDataset failures carry their own exitCode; otherwise exit 69.
      exitWithError(
        log,
        err,
        err instanceof UsageError
          ? 64
          : ((err as { exitCode?: number }).exitCode ?? 69),
      );
    }

    announceRetainMode(connection, log);

    let runResult: Awaited<ReturnType<typeof runProtocol>>;
    try {
      // Cast: `liveConnection` is `ConnectionConfig` (which includes the webrtc
      // channel), so TypeScript cannot verify it fits `ProtocolConnectionConfig`
      // (constrained to sftp and filedrop). The double cast through `unknown` is
      // intentional; the channel guard inside `runProtocol` rejects unsupported
      // channels at runtime.
      // auth: null is the explicit opt-out that tells runProtocol to proceed
      // without authentication and without a warning.
      runResult = await runProtocol(
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
        // exchange advertises it to the partner and, when both saved, returns the
        // established secret on runResult.bootstrap. Pass the raw boolean, never
        // `options.save || undefined`: a non-saving party (options.save === false)
        // must still receive a defined bootstrap so finalizeBootstrap can emit the
        // "your partner wanted to save" notice. Collapsing false to undefined
        // would route it through the interrupt guard below and silently swallow
        // that notice. The wire is unaffected either way -- the save field only
        // rides the terms frame when intent is true (see exchangeTerms).
        options.save,
        // onAuthenticated is undefined on the unauthenticated zero-setup path; the
        // trailing object carries the CLI-only sweep controls.
        undefined,
        { sweepExchangeFiles, forceRetainSweep },
      );
    } catch (err) {
      exitWithError(log, err, err instanceof UsageError ? 64 : 69);
    }

    const { bootstrap, observedReceivedPayloadColumns } = runResult;
    // bootstrap is undefined only when a signal cut the run short and the process
    // is already exiting; there is nothing to save or announce in that case.
    if (bootstrap === undefined) return;

    // The exchange has already succeeded and written its output by this point, so
    // a provisioning failure here (a config/key conflict that appeared in the
    // post-exchange window, or a disk error) cannot undo the linkage -- but it
    // must still exit cleanly with a diagnostic rather than crash as an unhandled
    // rejection. A conflict is a UsageError (exit 64); anything else exits 69.
    try {
      finalizeBootstrap({
        save: options.save,
        bootstrap,
        // Record the received-payload set observed in this first exchange so a
        // later `psilink exchange` on the saved config fails closed on a divergent
        // payload; buildSaveSpec drops the ambiguous empty observation and stays
        // lazy. Only persisted when this party actually saves (finalizeBootstrap).
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
      exitWithError(log, err, err instanceof UsageError ? 64 : 69);
    }
  } finally {
    // Restore the loglevel factory (and close the log-file descriptor, for the
    // file sink) on the normal exit path (including the early return above).
    // Writes are synchronous and already durable, so exitWithError's process.exit
    // (which bypasses this finally) loses nothing -- this is only
    // factory/descriptor cleanup.
    closeLogging();
  }
}
