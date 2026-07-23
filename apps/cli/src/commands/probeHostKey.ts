import type { Argv, Arguments } from "yargs";
import logLibrary from "loglevel";

import {
  FileSyncConnection,
  HOST_KEY_FINGERPRINT_REGEX,
  UsageError,
  sanitizeForDisplay,
} from "@psilink/core";
import type { PresentedHostKey, SFTPConnectionConfig } from "@psilink/core";

import { channelFromURL } from "../connectionFromUrl";
import { SSH2SFTPClientAdapter } from "../connection/ssh2SftpAdapter";
import {
  decodeUrlComponent,
  redactUrlCredentials,
} from "../util/connectionUrl";
import {
  configureLogging,
  durationFlagSeconds,
  exitWithError,
  LOG_LEVELS,
  parseOrExit,
  singleValue,
} from "../util/cli";

// `psilink probe-host-key` is the ssh-keyscan analogue: it connects only far
// enough to read the SFTP server's presented host key, then refuses the
// connection before any credential is offered (see
// FileSyncConnection.probeHostKeyFingerprint / sftpSession.ts). It prints the
// observed fingerprint so it can be compared out-of-band against the value the
// server operator published and pinned as connection.server.host_key_fingerprint.
// It NEVER establishes trust on its own: reading a key over the same untrusted
// network the exchange will use is not a substitute for verifying it. The
// console spawns this command's --json form to fill its host-key pin field.

/**
 * The single external effect the probe performs, injectable so the URL/format
 * glue is unit-testable without a live server.
 * @internal
 */
export interface ProbeHostKeyDeps {
  /** Connect just far enough to read the server's host key, then refuse (see
   * {@link FileSyncConnection.probeHostKeyFingerprint}). */
  probe: (
    config: SFTPConnectionConfig,
    verbosity: number,
  ) => Promise<PresentedHostKey>;
}

const REAL_DEPS: ProbeHostKeyDeps = {
  probe: (config, verbosity) =>
    new FileSyncConnection(new SSH2SFTPClientAdapter({ verbosity }), {
      verbose: verbosity,
    }).probeHostKeyFingerprint(config),
};

export function builder(cmd: Argv): Argv {
  return cmd
    .usage("Usage: $0 probe-host-key SFTP_URL [options]")
    .positional("sftp-url", {
      type: "string",
      describe: "sftp://host[:port] server to read the host key from",
      demandOption: true,
    })
    .option("connect-timeout", {
      type: "string",
      describe:
        "how long to wait for the connection before giving up (e.g. 10s); " +
        "enforced as the SSH ready timeout",
    })
    .option("json", {
      type: "boolean",
      default: false,
      describe:
        "print one line of machine-readable JSON " +
        '({"fingerprint":"SHA256:...","key_type":"..."}) on stdout instead ' +
        "of the human-readable summary",
    })
    .option("log-level", {
      type: "string",
      describe: "silent | error | warn | info | debug | trace; default=info",
    })
    .option("log-file", {
      type: "string",
      describe:
        "append all log output to this file instead of the terminal; the " +
        "parent directory must already exist",
    })
    .option("verbose", {
      alias: "v",
      type: "count",
      describe:
        "generate additional logging information for sub-libraries at all " +
        "logging levels",
    });
}

/**
 * A fixed placeholder username the probe connects with. ssh2 requires a username
 * string at `connect()` time (a client-side precondition), but the value is only
 * sent in the SSH userauth phase -- which the host-key verifier aborts BEFORE, by
 * calling `verify(false)` at host-key verification -- so it never reaches the
 * server. A neutral placeholder rather than a real account keeps even a
 * hypothetical from carrying the operator's identity.
 */
const PROBE_USERNAME = "psilink-host-key-probe";

/**
 * Build the minimal probe connection from an `sftp://host[:port]` URL: host and
 * port only, plus a placeholder {@link PROBE_USERNAME} (ssh2 requires a username
 * to connect, but the probe aborts before it is sent) and the connect timeout as
 * `serverConnectTimeoutMs` (enforced by ssh2 as `readyTimeout`). It carries NO
 * credential and no username FROM THE URL -- the host-key verifier refuses before
 * authenticating, so none is ever needed, and omitting the credential keeps the
 * probe from parsing an (unresolved) one. A non-sftp scheme, an unparseable URL,
 * or a host-less URL is a {@link UsageError} (exit 64), never a transport failure.
 * Reuses the URL-handling primitives the connection builders share so the
 * scheme/host rules cannot drift.
 *
 * @internal exported for testing
 */
export function buildProbeConfig(
  rawUrl: string,
  connectTimeoutSeconds: number | undefined,
): SFTPConnectionConfig {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UsageError(
      `could not parse ${rawUrl} as a URL; expected sftp://host[:port]`,
    );
  }
  // channelFromURL maps the scheme to a channel (throwing a UsageError for a
  // truly-unknown scheme); ws/file map to webrtc/filedrop, which this command
  // does not probe, so anything but sftp is rejected here with a clear message.
  if (channelFromURL(url) !== "sftp")
    throw new UsageError(
      `probe-host-key requires an sftp:// URL; got ` +
        `${redactUrlCredentials(url)}`,
    );
  if (!url.hostname)
    throw new UsageError(
      `sftp URL must include a host (e.g. sftp://host); got ` +
        `${redactUrlCredentials(url)}`,
    );
  const port = url.port ? Number(url.port) : undefined;
  return {
    channel: "sftp",
    server: {
      host: decodeUrlComponent(url.hostname, url),
      ...(port !== undefined ? { port } : {}),
      username: PROBE_USERNAME,
    },
    ...(connectTimeoutSeconds !== undefined
      ? { options: { serverConnectTimeoutMs: connectTimeoutSeconds * 1000 } }
      : {}),
  };
}

/**
 * Confirm the presented fingerprint is in canonical OpenSSH SHA256 form before
 * it is printed. `computeHostKeyFingerprint` already produces this shape, so a
 * value that fails here is an anomaly (a corrupt or subverted probe result), not
 * ordinary input -- surfaced as a transport-class failure rather than silently
 * emitted.
 */
function assertCanonicalFingerprint(presented: PresentedHostKey): void {
  if (!HOST_KEY_FINGERPRINT_REGEX.test(presented.fingerprint))
    throw new Error(
      "the server's presented host-key fingerprint is not in canonical " +
        "OpenSSH SHA256 form",
    );
}

/** The single stdout line the `--json` form emits: snake_case keys, the machine
 * form the console consumes. `keyType` is server-controlled bytes, so it is
 * carried as a JSON string value (JSON encoding escapes any control byte) and
 * re-validated at the console's trust boundary. */
function probeJsonLine(presented: PresentedHostKey): string {
  return JSON.stringify({
    fingerprint: presented.fingerprint,
    key_type: presented.keyType,
  });
}

/** The human-readable summary, mirroring the trust-prompt copy in
 * hostKeyTrust.ts. `keyType` is decoded straight from the server-controlled key
 * blob, so it is escaped before display, exactly as sftpSession.ts treats it;
 * the fingerprint is base64 and format-validated, and the host is already a bare
 * address but is escaped defensively too. */
function probeHumanSummary(host: string, presented: PresentedHostKey): string {
  return (
    `${sanitizeForDisplay(host)} presented a ` +
    `${sanitizeForDisplay(presented.keyType)} host key with fingerprint ` +
    `${presented.fingerprint}. Verify it matches the server's published ` +
    `fingerprint out-of-band before pinning it.`
  );
}

/**
 * Probe the server and produce the line(s) to emit, without printing or exiting:
 * the `--json` stdout line, or the human summary. Throws a {@link UsageError}
 * (bad URL/scheme) or a plain {@link Error} (a transport failure, or a
 * non-canonical fingerprint) which the handler maps to exit 64 or 69. Deps are
 * injectable so the URL/format/validation glue is exercised without a live
 * server.
 *
 * @internal exported for testing
 */
export async function probeHostKeyLines(
  args: {
    sftpUrl: string;
    connectTimeoutSeconds: number | undefined;
    json: boolean;
    verbosity: number;
  },
  deps: ProbeHostKeyDeps = REAL_DEPS,
): Promise<{ stdout?: string; summary?: string }> {
  const config = buildProbeConfig(args.sftpUrl, args.connectTimeoutSeconds);
  const presented = await deps.probe(config, args.verbosity);
  // Validate before either output path so a non-canonical value never reaches
  // stdout (where the console would ingest it) or the terminal.
  assertCanonicalFingerprint(presented);
  return args.json
    ? { stdout: probeJsonLine(presented) }
    : { summary: probeHumanSummary(config.server.host, presented) };
}

export async function handler(argv: Arguments): Promise<void> {
  // Resolve and apply the log level before the logger exists (a bad --log-level
  // or a repeated --log-file is a UsageError mapped to stderr + exit 64 here),
  // the same bootstrap boundary as `psilink fingerprint`.
  const logLevel = parseOrExit((): logLibrary.LogLevelNumbers => {
    const raw = (
      (singleValue(argv, "log-level") as string | undefined) || "info"
    ).toLowerCase();
    const resolved = LOG_LEVELS[raw];
    if (resolved === undefined)
      throw new UsageError(`unrecognized log-level: ${argv["log-level"]}`);
    return resolved;
  });
  const { log, close: closeLogging } = parseOrExit(() =>
    configureLogging({
      logLevel,
      logFile: singleValue(argv, "log-file") as string | undefined,
      name: "probe-host-key",
    }),
  );

  try {
    // singleValue and durationFlagSeconds raise a flag-named UsageError (exit 64)
    // on a repeated or malformed flag; buildProbeConfig raises one on a bad URL.
    const result = await probeHostKeyLines({
      sftpUrl: singleValue(argv, "sftp-url") as string,
      connectTimeoutSeconds: durationFlagSeconds(argv, "connect-timeout"),
      json: argv["json"] === true,
      verbosity: (argv["verbose"] as number | undefined) ?? 0,
    });
    // The --json line is the command's sole result, so it goes to stdout via
    // console.log (like `psilink fingerprint`), keeping a capture/pipe clean; the
    // human summary is a diagnostic and routes through the logger to stderr.
    if (result.stdout !== undefined) console.log(result.stdout);
    if (result.summary !== undefined) log.info(result.summary);
  } catch (err) {
    // A UsageError (bad URL/scheme, malformed flag) is exit 64; a transport
    // failure -- unreachable host, refused connection, timeout -- or a
    // non-canonical fingerprint is exit 69, matching the exchange command's
    // mapping.
    exitWithError(log, err, err instanceof UsageError ? 64 : 69);
  } finally {
    closeLogging();
  }
}
