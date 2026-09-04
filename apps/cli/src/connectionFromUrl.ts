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

// The connection channels connectionFromURL turns a URL into: the file-sync
// pair. `runProtocol` also runs webrtc, but a webrtc connection needs
// a `role` that says which end of the rendezvous this party is, and no URL
// carries one. The commands that know their own end supply it themselves --
// `psilink accept` from an invitation endpoint (connectionFromEndpoint) and
// `psilink invite` from its own URL (inviterConnectionFromURL, which stamps
// `inviter`) -- so the channel stays outside this builder's range and cannot
// reach a command that would have no end to register under.
export type RunnableConnectionConfig = Extract<
  ConnectionConfig,
  { channel: "sftp" | "filedrop" }
>;

/**
 * The connection an online `psilink invite` builds from its URL: the file-sync
 * pair plus webrtc. Invite is the one URL-driven command that can stand up a
 * webrtc rendezvous, because it is the side that both takes the `inviter` end
 * and mints the invitation carrying the coordination server for its partner.
 */
export type InviterConnectionConfig =
  RunnableConnectionConfig | WebRTCConnectionConfig;

/**
 * The refusal a `ws:`/`wss:` URL gets on the acceptance and zero-setup paths.
 *
 * The channel runs -- `psilink exchange` dispatches it -- but on these paths not
 * from a URL: the connection needs a `role` no URL carries, and an acceptor's
 * comes from the invitation it was sent. The message names the routes that do
 * produce a webrtc connection, so this does not read as "the CLI cannot do
 * WebRTC", which it can.
 */
export const WEBRTC_URL_REFUSED =
  "a ws:// or wss:// URL cannot be used here: this command runs a webrtc " +
  "exchange from a saved connection, not from a URL. 'psilink invite' takes " +
  "one and mints an invitation naming that coordination server; accepting an " +
  "invitation writes the connection block, and 'psilink exchange' then runs it.";

/**
 * The refusal a `ws:`/`wss:` URL carrying anything past the broker's location
 * gets on the invite path.
 *
 * A webrtc URL names where the coordination server is and nothing else: the
 * PeerJS API key is a `server.key` on the connection block, and neither it nor a
 * username has a URL form the CLI reads. Dropping such a component silently
 * would leave the run dialing under the default key and report only the
 * broker's own rejection later, so a URL carrying userinfo, a query, or a
 * fragment is refused where it was typed.
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
 * Build a connection config from a server URL, for the CLI paths that map a URL
 * to a connection and take no end of a rendezvous of their own (the online
 * accept path and the zero-setup exchange). Constrained to the file-sync
 * channels: a `webrtc` (ws/wss) URL or an unsupported scheme is a usage error.
 * The online invite path goes through {@link inviterConnectionFromURL}, which
 * adds the webrtc channel over this. The returned config carries no
 * `authentication`; the caller adds the shared secret separately for the
 * handshake and never persists it to the config.
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

  if (channel !== "sftp") throw new UsageError(WEBRTC_URL_REFUSED);

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

/**
 * Build the connection an online `psilink invite` runs on from its server URL:
 * {@link connectionFromURL}'s file-sync channels, plus a `ws:`/`wss:` URL as the
 * webrtc coordination server this party will meet its partner through. The
 * caller stamps the `inviter` role (withWebRTCPeerRole) and mints the
 * invitation, whose credential-free endpoint carries the same locator so the
 * acceptor reaches this coordination server rather than a hard-coded default.
 *
 * A webrtc URL maps scheme to `secure` (`wss:` leaves the field unset, whose
 * default is TLS; `ws:` sets it false, which the dial then warns about), and its
 * host, port, and path to the `server` block the broker location resolves from.
 * Nothing else on the URL is read: see {@link WEBRTC_URL_EXTRAS_REFUSED}.
 *
 * The mount point is always recorded, unlike the sftp branch's remote working
 * directory: the invitation minted from this connection carries the endpoint a
 * PARTNER seeds its own connection from, and a partner running a different
 * client resolves an absent path to that client's own default rather than to
 * this one's. The browser app defaults it to its own broker mount (`/api/`)
 * while the CLI defaults it to `/`, so a locator that named none would send the
 * two to different sockets. Recording the value this CLI itself resolves keeps
 * the endpoint self-describing and leaves no default to disagree about.
 *
 * There is no host check to match the sftp branch's, because `ws:`/`wss:` are
 * SPECIAL schemes to the URL parser and `sftp:` is not: a special-scheme URL
 * with nothing where the host goes fails to parse at all, and one written with
 * an empty authority takes its first path segment as the host instead, and its
 * `pathname` is never empty. The parse this receives therefore always names a
 * host and a mount point (both asserted in the unit suite, against the parser
 * itself rather than a reading of it).
 *
 * The connection is resolved through `brokerLocationFromConnection` before it is
 * returned, so every shape the dial would refuse -- an undialable port, or a
 * delimiter that percent-encoding carried past the checks above and into the
 * host or path -- is a usage error HERE, at the mint boundary, rather than one
 * raised inside the exchange after the invitation has reached stdout. The warn
 * callback is a no-op: the plaintext advisory belongs to the run that dials, and
 * the inviting command names the endpoint's own plaintext limitation itself.
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
