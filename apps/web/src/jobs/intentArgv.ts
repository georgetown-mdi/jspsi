import { pathToFileURL } from "node:url";

import { isAdmissiblePeerId } from "@jobs/intentSchemas";

import { composeSftpConfigDocument } from "./intentConfig";

import type { JobSftpServerEntry } from "./sftpServer";

import type { JobExchangeOptions } from "./intentSchemas";

// The placeholder host the URL is seeded with, distinguished from a real host so a
// setter no-op (which leaves this value in place) is detectable. `.invalid` is a
// reserved TLD (RFC 6761), so it is never a legitimately authored server.
const ZERO_SETUP_URL_SENTINEL_HOST = "host.invalid";

/**
 * Build the `sftp://` URL a zero-setup job's CLI drives, from the authored
 * server entry's host, port, and remote directory. The host, port, and path go
 * through the WHATWG {@link URL} object (never string concatenation) so each
 * component is encoded correctly; a bare IPv6 literal is bracketed first, since
 * the hostname setter silently rejects an unbracketed one.
 *
 * A split-directory entry puts its INBOUND half on the URL: `--outbound-path`
 * (emitted alongside by {@link zeroSetupSftpArgv}) takes the URL's path as
 * the inbound directory and supplies the outbound one.
 *
 * The composed `url.hostname` -- the WHATWG-canonical form -- is adopted as
 * the host, rather than requiring it to equal the input verbatim: the
 * setter safely canonicalizes a non-canonical or uppercase-hex IPv6 literal
 * (`2001:0db8::0001` -> `[2001:db8::1]`) or an IDN host it percent-encodes.
 * It also silently TRUNCATES at a URL-significant delimiter (`foo#bar` ->
 * `foo`) and NO-OPS on a host it cannot parse (leaving the sentinel) --
 * either could point the exchange at the wrong server. Truncation is closed
 * off upstream: `isBareSftpHost` (`@psi/sftpHost`) rejects every truncating
 * character (`#`, `?`, `\`, `%`) plus userinfo, path, and whitespace, so a
 * host reaching here can differ from the input only by safe
 * canonicalization. A total drop -- an empty hostname or the untouched
 * sentinel -- is the one alteration still possible here, and is a
 * compose-time error. Credentials never ride the URL -- they are
 * `--server-*` flags built by {@link zeroSetupSftpArgv} -- so no secret
 * byte is ever URL-encoded here.
 */
function buildZeroSetupSftpUrl(serverEntry: JobSftpServerEntry): string {
  const hostForUrl =
    serverEntry.host.includes(":") && !serverEntry.host.startsWith("[")
      ? `[${serverEntry.host}]`
      : serverEntry.host;
  const url = new URL(`sftp://${ZERO_SETUP_URL_SENTINEL_HOST}`);
  url.hostname = hostForUrl;
  if (url.hostname === "" || url.hostname === ZERO_SETUP_URL_SENTINEL_HOST)
    throw new Error(
      "could not encode the authored sftp host into a URL for a zero-setup " +
        "exchange",
    );
  if (serverEntry.port !== undefined) url.port = String(serverEntry.port);
  const urlPath = serverEntry.inboundPath ?? serverEntry.path;
  if (urlPath !== undefined) url.pathname = urlPath;
  return url.href;
}

/**
 * Map the operator-authored SFTP server entry to the connection portion of a
 * zero-setup CLI argv: the `sftp://` URL positional plus the `--server-*` flags.
 * The argv analog of {@link composeSftpConfigDocument} -- it draws every field from
 * the server entry, contributing nothing from the client.
 *
 * Credentials are emitted as single `--server-<field>=@path` tokens with
 * the `@path` string verbatim (the same `@path` the entry holds), never a
 * resolved secret: the CLI child resolves the reference at live-use, so no
 * secret byte is ever on argv. Every value-bearing flag uses the `=value`
 * form so a value beginning with `-` cannot be misparsed by yargs as its
 * own flag. The primary credential (`password` or `private_key`) is picked
 * exactly as {@link composeSftpConfigDocument} lets core pick it -- at most
 * one -- with the optional passphrase (`@path`) and keyboard-interactive
 * toggle alongside.
 *
 * A split-directory entry adds `--outbound-path`, the CLI's own name for
 * the same split: the URL holds the inbound half (see
 * {@link buildZeroSetupSftpUrl}) and this flag the outbound one. The CLI's
 * guard on that flag holds the run to retain mode, which
 * {@link zeroSetupOptionsArgv} emits from the operator's own file-handling
 * choice.
 *
 * The host-key fingerprint is mandatory and always emitted: a zero-setup
 * run has no TTY, so trust-on-first-use is impossible and the pin is the
 * only host-key defense. The CLI flag is single-valued, so a
 * multi-fingerprint entry (an `Array`) is a compose-time error rather than
 * a silently dropped pin.
 */
export function zeroSetupSftpArgv(
  serverEntry: JobSftpServerEntry,
): Array<string> {
  const argv: Array<string> = [buildZeroSetupSftpUrl(serverEntry)];
  if (serverEntry.outboundPath !== undefined)
    argv.push(`--outbound-path=${serverEntry.outboundPath}`);
  if (serverEntry.username !== undefined)
    argv.push(`--server-username=${serverEntry.username}`);
  if (serverEntry.password !== undefined)
    argv.push(`--server-password=${serverEntry.password}`);
  else if (serverEntry.privateKey !== undefined)
    argv.push(`--server-private-key=${serverEntry.privateKey}`);
  if (serverEntry.privateKeyPassphrase !== undefined)
    argv.push(
      `--server-private-key-passphrase=${serverEntry.privateKeyPassphrase}`,
    );
  if (serverEntry.keyboardInteractive === true)
    argv.push("--server-keyboard-interactive");
  if (Array.isArray(serverEntry.hostKeyFingerprint))
    throw new Error(
      "a zero-setup exchange cannot pin more than one host-key fingerprint; " +
        "the CLI --server-host-key-fingerprint flag is single-valued",
    );
  argv.push(`--server-host-key-fingerprint=${serverEntry.hostKeyFingerprint}`);
  return argv;
}

/**
 * Map the operator-configured rendezvous directory to the connection portion
 * of a filedrop zero-setup CLI argv: a single `file://` URL positional.
 * Built through {@link pathToFileURL} from the server-side directory, so no
 * client string is ever a path. The filedrop channel has no host or
 * credential, so this is the whole connection.
 *
 * A split-provisioned console adds `--outbound-path`, the CLI's own name
 * for the same split: the positional holds the inbound leg (which the CLI
 * maps to `inbound_path`) and this flag the outbound one, as the plain
 * absolute directory rather than a `file://` URL. The CLI's guard on that
 * flag holds the run to retain mode, which {@link zeroSetupOptionsArgv}
 * emits from the operator's file-handling choice. The `=value` form
 * matches every other value-bearing flag, so a directory beginning with
 * `-` cannot be misparsed by yargs as its own flag.
 */
export function zeroSetupFiledropArgv(
  rendezvousDir: string,
  outboundRendezvousDir?: string,
): Array<string> {
  const argv = [pathToFileURL(rendezvousDir).href];
  if (outboundRendezvousDir !== undefined)
    argv.push(`--outbound-path=${outboundRendezvousDir}`);
  return argv;
}

/**
 * Map the intent's tuning options to their CLI flags, the zero-setup argv's
 * counterpart to the exchange mode's composed `options` block. A zero-setup
 * run composes no config document, so these flags are the only route the
 * operator's authored choices have into the child; every field the
 * zero-setup arms admit has one here (see
 * the zero-setup options schema in `./intentSchemas`).
 *
 * Only an enabled toggle is emitted: each of the three booleans is `false`
 * by default in core, and a zero-setup run loads no configuration file for
 * a flag to override, so an explicitly-off toggle and an unset one select
 * the same behaviour. `peerId` rides a single `--peer-id=<value>` token and
 * reaches this point only through {@link isAdmissiblePeerId}, so it is a
 * bare label -- never a path, a separator, or a flag-shaped value.
 *
 * The durations are emitted in the units each flag's own grammar takes:
 * `--polling-frequency` accepts a millisecond suffix and holds the interval
 * verbatim, while the two coarse-duration flags take a second-or-coarser
 * unit and so hold whole seconds -- exact, because the zero-setup arms
 * admit only a whole-second value for them.
 */
export function zeroSetupOptionsArgv(
  options: JobExchangeOptions | undefined,
): Array<string> {
  if (options === undefined) return [];
  const argv: Array<string> = [];
  if (options.retainFiles === true) argv.push("--retain-files");
  if (options.locklessRendezvous === true) argv.push("--lockless-rendezvous");
  if (options.timestampInFilename === true)
    argv.push("--timestamp-in-filename");
  if (options.peerId !== undefined) argv.push(`--peer-id=${options.peerId}`);
  if (options.pollIntervalMs !== undefined)
    argv.push(`--polling-frequency=${options.pollIntervalMs}ms`);
  if (options.peerTimeoutMs !== undefined)
    argv.push(`--peer-timeout=${options.peerTimeoutMs / 1000}s`);
  if (options.serverConnectTimeoutMs !== undefined)
    argv.push(`--connection-timeout=${options.serverConnectTimeoutMs / 1000}s`);
  if (options.maxReconnectAttempts !== undefined)
    argv.push(`--max-reconnect-attempts=${options.maxReconnectAttempts}`);
  if (options.connectionPerPoll === true) argv.push("--connection-per-poll");
  return argv;
}
