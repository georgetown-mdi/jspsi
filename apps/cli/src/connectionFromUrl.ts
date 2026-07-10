import { fileURLToPath } from "node:url";

import { UsageError } from "@psilink/core";
import type {
  ConnectionConfig,
  FileDropConnectionConfig,
  SFTPConnectionConfig,
} from "@psilink/core";

import { applyConnectionOverrides, type ConnectionOverrides } from "./config";
import { decodeUrlComponent, redactUrlCredentials } from "./util/connectionUrl";

// The connection channels the CLI can actually run an exchange over: runProtocol
// supports sftp and filedrop, and a webrtc URL is rejected upstream. Narrowing
// to this (rather than the full ConnectionConfig) keeps a webrtc config from
// reaching runOnlineBootstrap, where it would otherwise only fail at runtime.
export type RunnableConnectionConfig = Extract<
  ConnectionConfig,
  { channel: "sftp" | "filedrop" }
>;

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

/**
 * Build a connection config from a server URL, for every CLI path that maps a
 * URL to a connection (the online invite/accept paths and the zero-setup
 * exchange). Constrained to the channels the CLI can actually run: a `webrtc`
 * (ws/wss) URL or an unsupported scheme is a usage error. The returned config
 * carries no `authentication`; the caller adds the shared secret separately for
 * the handshake and never persists it to the config.
 *
 * The `--server-*`/`--outbound-path`/tuning overrides arrive pre-built as
 * {@link ConnectionOverrides}: the caller fans its parsed CLI options into that
 * shape (`connectionOverridesFrom`) at the call site, so this stays free of any
 * CLI option-field names.
 *
 * @internal exported for testing
 */
export function connectionFromURL(
  url: URL,
  overrides: ConnectionOverrides,
): RunnableConnectionConfig {
  const channel = channelFromURL(url);

  if (channel === "filedrop") {
    if (url.hostname && url.hostname !== "localhost")
      throw new UsageError(
        `file:// URLs must use three slashes (e.g. file:///mnt/share/drop) ` +
          `or file://localhost/path; got: ${redactUrlCredentials(url)}`,
      );
    const base: FileDropConnectionConfig = {
      channel: "filedrop",
      path: fileURLToPath(url),
    };
    // applyConnectionOverrides ignores the server-* fields on a filedrop
    // connection, so the full override set is safe here -- only the shared and
    // file-sync options take effect.
    return applyConnectionOverrides(
      base,
      overrides,
    ) as RunnableConnectionConfig;
  }

  if (channel !== "sftp")
    throw new UsageError(`${channel} channel not yet supported in the CLI`);

  // Reject a credential-only or schemeless URL with no host (e.g. sftp:///path)
  // here, with a clear message, rather than passing host: "" through to a
  // connection attempt that fails obscurely later. Mirrors the filedrop branch's
  // host validation above. (redactUrlCredentials is defensive consistency: a
  // host-less URL cannot actually carry credentials -- the parser rejects
  // userinfo without a host -- but URLs are always echoed through the redactor.)
  if (!url.hostname)
    throw new UsageError(
      `sftp URL must include a host (e.g. sftp://host/path); got: ` +
        redactUrlCredentials(url),
    );

  const base: SFTPConnectionConfig = {
    channel: "sftp",
    server: {
      host: decodeUrlComponent(url.hostname, url),
      port: url.port ? Number(url.port) : undefined,
      username: url.username
        ? decodeUrlComponent(url.username, url)
        : undefined,
      password: url.password
        ? decodeUrlComponent(url.password, url)
        : undefined,
      // A bare-host URL (sftp://host or sftp://host/) leaves the remote path
      // unset so the server's default working directory is used, rather than
      // pinning it to the filesystem root.
      path:
        url.pathname && url.pathname !== "/"
          ? decodeUrlComponent(url.pathname, url)
          : undefined,
    },
  };
  return applyConnectionOverrides(base, overrides) as RunnableConnectionConfig;
}
