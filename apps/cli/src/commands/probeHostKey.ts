import type { Argv, Arguments } from "yargs";

import {
  FileSyncConnection,
  HOST_KEY_FINGERPRINT_REGEX,
  UsageError,
  redactAndSanitizeForDisplay,
} from "@psilink/core";
import type { PresentedHostKey, SFTPConnectionConfig } from "@psilink/core";
import type { PeerIdentificationDiagnosis } from "../connection/sftpPeerIdentification";

import { channelFromURL } from "../connectionFromUrl";
import { SSH2SFTPClientAdapter } from "../connection/ssh2SftpAdapter";
import { peerIdentificationDiagnosisOf } from "../connection/sftpPeerIdentification";
import {
  decodeUrlComponent,
  redactUrlCredentials,
} from "../util/connectionUrl";
import {
  configureLogging,
  durationFlagSeconds,
  exitWithError,
  logLevelFlag,
  parseOrExit,
  singleValue,
} from "../util/cli";
import { asciiSafeJsonLine } from "../util/jsonLine";
import { addLoggingOptions } from "../optionDefinitions";

// `psilink probe-host-key` is the ssh-keyscan analogue: it connects only far
// enough to read the SFTP server's presented host key, then refuses before any
// credential is offered (see FileSyncConnection.probeHostKeyFingerprint). It
// establishes no trust on its own -- reading a key over the same untrusted
// network the exchange will use is not a substitute for verifying it. Full
// behavior: docs/CLI.md, "Reading a host key with probe-host-key".

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
  // A dial that dies before the peer identifies itself as an SSH server is
  // diagnosed by the adapter this probe dials through, which is the single point
  // every dial passes -- see connection/sftpPeerIdentification.
  probe: (config, verbosity) =>
    new FileSyncConnection(new SSH2SFTPClientAdapter({ verbosity }), {
      verbose: verbosity,
    }).probeHostKeyFingerprint(config),
};

export function builder(cmd: Argv): Argv {
  const beforeLogging = cmd
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
        "of the human-readable summary. A dial that failed because something " +
        "other than an SSH server answered the port prints a diagnosis line " +
        '({"diagnosis":"non_ssh"|"closed_unanswered", ...}) on stdout before ' +
        "exiting 69, so a caller that discards stderr still gets the cause",
    });
  return addLoggingOptions(beforeLogging).option("verbose", {
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
 * hypothetical from exposing the operator's identity.
 */
const PROBE_USERNAME = "psilink-host-key-probe";

/**
 * Build the minimal probe connection from an `sftp://host[:port]` URL: host,
 * port, a placeholder {@link PROBE_USERNAME}, and the connect timeout as
 * `serverConnectTimeoutMs`. It includes NO credential and no username FROM THE
 * URL -- the host-key verifier refuses before authenticating, so none is ever
 * sent, and omitting it avoids parsing an unresolved one. A non-sftp scheme, an
 * unparseable URL, or a host-less URL is a {@link UsageError} (exit 64), never a
 * transport failure, reusing the URL-handling primitives the connection
 * builders share so the scheme/host rules cannot drift.
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
 * ordinary input -- reported as a transport-class failure rather than silently
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
 * form the console consumes. `keyType` is the server's choice within core's
 * charset and length bound, so it is included as a JSON string value and
 * re-validated at the console's trust boundary; the line rides
 * {@link asciiSafeJsonLine} like every machine line this command emits, so a
 * bound that ever admitted a byte outside printable ASCII could still not put
 * one on a terminal. */
function probeJsonLine(presented: PresentedHostKey): string {
  return asciiSafeJsonLine({
    fingerprint: presented.fingerprint,
    key_type: presented.keyType,
  });
}

/**
 * The single stdout line the `--json` form emits for a dial that died before
 * the peer identified itself: the classification and, for a peer that answered
 * with something, the shape and the first bytes it sent. `diagnosis` is the
 * discriminant key -- the success line never includes it, so the two shapes
 * are never read for one another.
 *
 * The excerpt is untrusted bytes, already redacted of private-key material and
 * bounded where it is produced (`classifyPeerAnswer`, `PEER_EXCERPT_MAX_BYTES`
 * in connection/sftpPeerIdentification) and emitted through
 * {@link asciiSafeJsonLine}. Its escapes are JSON's own, not a display
 * boundary: a consumer parses back the peer's bytes unchanged, and one that
 * renders the excerpt to a human still escapes it once at that sink (see
 * docs/spec/CHANNEL_SECURITY.md, "SFTP host-key verification", and
 * CONTRIBUTING.md, Operator-facing escaping).
 *
 * @internal exported for testing
 */
export function probeDiagnosisJsonLine(
  diagnosis: PeerIdentificationDiagnosis,
): string {
  return asciiSafeJsonLine(
    diagnosis.kind === "closed-unanswered"
      ? { diagnosis: "closed_unanswered" }
      : {
          diagnosis: "non_ssh",
          shape: diagnosis.shape,
          excerpt: diagnosis.excerpt,
        },
  );
}

/** The human-readable summary, mirroring the trust-prompt copy in
 * hostKeyTrust.ts. `keyType` is the server's choice within core's bound, so it
 * is escaped before display like sftpSession.ts; the fingerprint is base64
 * and format-validated, and the host -- already a bare address -- is escaped
 * defensively too, both ahead of the out-of-band verification step so neither
 * depends on the log sink's own pass. */
function probeHumanSummary(host: string, presented: PresentedHostKey): string {
  return (
    `${redactAndSanitizeForDisplay(host)} presented a ` +
    `${redactAndSanitizeForDisplay(presented.keyType)} host key with ` +
    `fingerprint ${presented.fingerprint}. Verify it matches the server's ` +
    `published fingerprint out-of-band before pinning it.`
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
  const logLevel = parseOrExit(() => logLevelFlag(argv));
  const { log, close: closeLogging } = parseOrExit(() =>
    configureLogging({
      logLevel,
      logFile: singleValue(argv, "log-file") as string | undefined,
      name: "probe-host-key",
    }),
  );

  const json = argv["json"] === true;
  try {
    // singleValue and durationFlagSeconds raise a flag-named UsageError (exit 64)
    // on a repeated or malformed flag; buildProbeConfig raises one on a bad URL.
    const result = await probeHostKeyLines({
      sftpUrl: singleValue(argv, "sftp-url") as string,
      connectTimeoutSeconds: durationFlagSeconds(argv, "connect-timeout"),
      json,
      verbosity: (argv["verbose"] as number | undefined) ?? 0,
    });
    // The --json line is the command's sole result, so it goes to stdout via
    // console.log (like `psilink fingerprint`), keeping a capture/pipe clean; the
    // human summary is a diagnostic and routes through the logger to stderr.
    if (result.stdout !== undefined) console.log(result.stdout);
    if (result.summary !== undefined) log.info(result.summary);
  } catch (err) {
    // The dial's own diagnosis of a peer that never identified itself goes to
    // stdout on the --json path, where the exit-69 result would otherwise be
    // indistinguishable from an unreachable host: a machine consumer discards
    // stderr precisely because it can hold server-controlled bytes, so the
    // classification and the bounded excerpt need a route of their own. The
    // human path keeps reading it off the rendered cause chain below.
    const diagnosis = json ? peerIdentificationDiagnosisOf(err) : undefined;
    if (diagnosis !== undefined) console.log(probeDiagnosisJsonLine(diagnosis));
    // A UsageError (bad URL/scheme, malformed flag) is exit 64; anything else --
    // a transport failure, or a non-canonical fingerprint -- is exit 69, matching
    // the exchange command's mapping (probeHostKey.test.ts, "exit mapping: a
    // non-sftp URL rejects UsageError (64)" and "exit mapping: a transport
    // failure rejects a plain Error (69)").
    exitWithError(log, err, err instanceof UsageError ? 64 : 69);
  } finally {
    closeLogging();
  }
}
