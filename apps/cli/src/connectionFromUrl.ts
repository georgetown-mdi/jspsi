import { fileURLToPath } from "node:url";

import { UsageError } from "@psilink/core";
import type {
  ConnectionConfig,
  FileDropConnectionConfig,
  SFTPConnectionConfig,
  WebRTCConnectionConfig,
} from "@psilink/core";

import { applyConnectionOverrides, type ConnectionOverrides } from "./config";
import { brokerLocationFromConnection } from "./connection/webrtc/weriftPeer";
import { decodeUrlComponent, redactUrlCredentials } from "./util/connectionUrl";

// The channels connectionFromURL turns a URL into: file-sync only.
// `runProtocol` also runs webrtc, but a webrtc connection needs a `role`
// naming which end of the rendezvous this party is, and no URL states one.
// The commands that know their own end stamp it themselves
// (connectionFromEndpoint for accept, inviterConnectionFromURL for invite),
// so webrtc stays outside this type.
export type RunnableConnectionConfig = Extract<
  ConnectionConfig,
  { channel: "sftp" | "filedrop" }
>;

/**
 * The connection an online `psilink invite` builds from its URL: the file-sync
 * pair plus webrtc. Invite is the one URL-driven command that can stand up a
 * webrtc rendezvous, because it is the side that both takes the `inviter` end
 * and mints the invitation naming the coordination server for its partner.
 */
export type InviterConnectionConfig =
  RunnableConnectionConfig | WebRTCConnectionConfig;

/**
 * The refusal a `ws:`/`wss:` URL gets on the acceptance and zero-setup paths.
 *
 * The channel runs -- `psilink exchange` dispatches it -- but on these paths
 * not from a URL: the connection needs a `role` no URL has, and an acceptor's
 * comes from the invitation it was sent. The message names the routes that do
 * produce a webrtc connection, so this is not treated as "the CLI cannot do
 * WebRTC", which it can.
 */
export const WEBRTC_URL_REFUSED =
  "a ws:// or wss:// URL cannot be used here: this command runs a webrtc " +
  "exchange from a saved connection, not from a URL. 'psilink invite' takes " +
  "one and mints an invitation naming that coordination server; accepting an " +
  "invitation writes the connection block, and 'psilink exchange' then runs it.";

/**
 * The refusal a `ws:`/`wss:` URL naming anything past the broker's location
 * gets on the invite path.
 *
 * A webrtc URL names only where the coordination server is; the PeerJS API
 * key (`server.key`) and a username have no URL form the CLI reads, so
 * dropping one silently would dial under the default key and report only the
 * broker's own rejection later. See docs/CLI.md#inviting-over-webrtc.
 */
export const WEBRTC_URL_EXTRAS_REFUSED =
  "a ws:// or wss:// URL names only the coordination server's host, port, and " +
  "path; it cannot include a user, an API key, or any other query. For a " +
  "coordination server that needs a key, author `channel: webrtc` (with " +
  "`server.key`) in psilink.yaml and run 'psilink exchange'.";

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
 * Build a connection config from a server URL, for CLI paths with no end of a
 * rendezvous of their own (the online accept path and the zero-setup
 * exchange). Constrained to the file-sync channels: `webrtc` or an
 * unsupported scheme is a usage error; the online invite path goes through
 * {@link inviterConnectionFromURL} instead, which adds the webrtc channel.
 * The returned config has no `authentication` field; the caller adds the
 * shared secret separately and never persists it here. Overrides arrive
 * pre-built as {@link ConnectionOverrides}.
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

  if (channel !== "sftp") throw new UsageError(WEBRTC_URL_REFUSED);

  // Reject a credential-only or schemeless URL with no host (e.g. sftp:///path)
  // here, with a clear message, rather than passing host: "" through to a
  // connection attempt that fails obscurely later. Mirrors the filedrop branch's
  // host validation above. (redactUrlCredentials is defensive consistency: a
  // host-less URL cannot actually hold credentials -- the parser rejects
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

/**
 * Build the connection an online `psilink invite` runs on from its server URL:
 * {@link connectionFromURL}'s file-sync channels, plus a `ws:`/`wss:` URL as
 * the webrtc coordination server this party meets its partner through. The
 * caller stamps the `inviter` role (`withWebRTCPeerRole`) and mints the
 * invitation, whose credential-free endpoint states the same locator so the
 * acceptor reaches this coordination server rather than a hard-coded default.
 *
 * A webrtc URL maps scheme to `secure` (`wss:` leaves it unset, defaulting to
 * TLS; `ws:` sets it false) and its host, port, and path to the `server`
 * block the broker location resolves from; nothing else on the URL is read
 * (see {@link WEBRTC_URL_EXTRAS_REFUSED}).
 *
 * The mount point is always recorded, unlike the sftp branch's working
 * directory: a partner running a different client resolves an absent path to
 * ITS OWN default rather than this one's, so recording the value this CLI
 * resolves keeps the endpoint self-describing. See
 * docs/spec/WEBRTC_TRANSPORT.md#broker-socket.
 *
 * `ws:`/`wss:` are special schemes to the URL parser and `sftp:` is not, so
 * (unlike the sftp branch) the parse this receives always names a host and a
 * mount point; both are asserted in the unit suite against the parser itself,
 * not a reading of it.
 *
 * `brokerLocationFromConnection` resolves the connection before it is
 * returned, so a shape the dial would refuse is a usage error HERE, at the
 * mint boundary, not raised later inside the exchange. The warn callback is a
 * no-op: the plaintext advisory belongs to the run that dials; the inviting
 * command names the endpoint's own plaintext limitation itself.
 *
 * @internal exported for testing
 */
export function inviterConnectionFromURL(
  url: URL,
  overrides: ConnectionOverrides,
): InviterConnectionConfig {
  if (channelFromURL(url) !== "webrtc")
    return connectionFromURL(url, overrides);

  if (url.username || url.password || url.search || url.hash)
    throw new UsageError(WEBRTC_URL_EXTRAS_REFUSED);

  const base: WebRTCConnectionConfig = {
    channel: "webrtc",
    server: {
      host: decodeUrlComponent(url.hostname, url),
      // ws:/wss: are special schemes to the URL parser, so a port equal to the
      // scheme's default is already normalized away here and the connection's
      // own default (443 or 80, to match `secure`) covers it.
      port: url.port ? Number(url.port) : undefined,
      // The parser yields "/" for a bare-host URL, so this is always set (see
      // the doc comment on why the mount point is never left to a default).
      path: decodeUrlComponent(url.pathname, url),
      // Only the plaintext choice is recorded: leaving `secure` unset on a wss:
      // URL keeps the config's TLS default, which is what the field means when
      // omitted, rather than restating it.
      ...(url.protocol === "ws:" ? { secure: false } : {}),
    },
  };
  // applyConnectionOverrides applies the shared timeouts on every channel and
  // ignores the file-sync-only ones here; --outbound-path, which has no
  // meaning without a directory, is refused there rather than dropped. The
  // invite's --accept-timeout never arrives here: it bounds only the live
  // run, applied in runOnlineBootstrap.
  const connection = applyConnectionOverrides(
    base,
    overrides,
  ) as WebRTCConnectionConfig;
  brokerLocationFromConnection(connection.server, () => {});
  return connection;
}
