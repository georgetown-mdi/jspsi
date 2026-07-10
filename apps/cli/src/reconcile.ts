import { normalizeFiledropPath } from "@psilink/core";
import type {
  ConnectionConfig,
  FileDropConnectionConfig,
  SFTPConnectionConfig,
} from "@psilink/core";

import { RECONCILE_UNSET, type ReconcileDiff } from "./config";
import type { RunnableConnectionConfig } from "./connectionFromUrl";

// The port an SFTP connection uses when the config sets none (ssh2's default).
// A config with no port and a target stating this value describe the same
// endpoint, so the reconcile must not flag that as a divergence.
const DEFAULT_SFTP_PORT = 22;

// Two hosts are the same endpoint regardless of case (DNS is case-insensitive),
// so compare them case-folded. Paths are compared the way the live connection
// will treat them, so the reconcile does not abort on a difference the
// connection would not see -- but the two channels normalize differently, so
// each has its own comparator. FileSyncConnection.open strips at most one
// trailing slash from an sftp remote path, while a filedrop path additionally
// has backslashes folded to forward slashes and ALL trailing slashes stripped.
function hostsEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
function sftpPathsEqual(a: string | undefined, b: string | undefined): boolean {
  const strip = (p: string | undefined): string | undefined =>
    p !== undefined && p.endsWith("/") ? p.slice(0, -1) : p;
  return strip(a) === strip(b);
}
function filedropPathsEqual(
  a: string | undefined,
  b: string | undefined,
): boolean {
  // Normalize both sides through the connection's own normalizer, so the diff's
  // verdict is exactly what the live filedrop connection would open (backslashes
  // folded to forward slashes, all trailing slashes stripped, root-like paths
  // preserved) -- no separate equality rule to drift from it. Either operand may
  // be undefined: a split-directory config (inbound_path/outbound_path) carries
  // no `path`, and a shared config carries no inbound/outbound, so undefined
  // legitimately arrives. pushDirectoryConflicts calls this once per locator it
  // compares (the single `path`, or each half of the split pair).
  const norm = (p: string | undefined): string | undefined =>
    p === undefined ? undefined : normalizeFiledropPath(p);
  return norm(a) === norm(b);
}

/**
 * Append the directory-locator conflicts for a file-sync channel. A directory is
 * given either as a single shared path or as the split inbound/outbound pair;
 * this compares whichever form the `target` uses, so a split target is reconciled
 * pair-wise and a shared target by its single path (matching how the live
 * connection resolves each). An existing config in the other form differs in the
 * compared field (its value is unset), so a shared-vs-split mismatch is a
 * conflict like any other. `pathsEqual` is the channel's own path comparator and
 * `field` renders a config key to its snake_case message path. Only fields the
 * target actually sets are compared, so a locator the target leaves unset is not
 * a disagreement with whatever the config holds.
 */
function pushDirectoryConflicts(
  conflicts: ReconcileDiff[],
  have: { path?: string; inboundPath?: string; outboundPath?: string },
  want: { path?: string; inboundPath?: string; outboundPath?: string },
  pathsEqual: (a: string | undefined, b: string | undefined) => boolean,
  field: (key: "path" | "inbound_path" | "outbound_path") => string,
): void {
  // When the existing config is in the OTHER directory form than the target, the
  // compared field is genuinely unset on the existing side -- but a bare
  // "(unset)" hides the locator the config DOES hold in its own form, which an
  // operator reads as "my config names no directory at all". Annotate the unset
  // side with that locator so the conflict shows both forms. Only invoked when
  // the field being rendered is actually unset, so it never fires for a
  // same-form mismatch (where the existing value is shown directly).
  const existingHint = (): string => {
    if (have.path !== undefined)
      return `${RECONCILE_UNSET} (the config uses a single shared path ${have.path})`;
    if (have.inboundPath !== undefined || have.outboundPath !== undefined)
      return (
        `${RECONCILE_UNSET} (the config uses a split inbound_path ` +
        `${have.inboundPath ?? RECONCILE_UNSET}, outbound_path ` +
        `${have.outboundPath ?? RECONCILE_UNSET})`
      );
    return RECONCILE_UNSET;
  };

  const split =
    want.inboundPath !== undefined || want.outboundPath !== undefined;
  if (split) {
    if (
      want.inboundPath !== undefined &&
      !pathsEqual(have.inboundPath, want.inboundPath)
    )
      conflicts.push({
        field: field("inbound_path"),
        existing: have.inboundPath ?? existingHint(),
        incoming: want.inboundPath,
      });
    if (
      want.outboundPath !== undefined &&
      !pathsEqual(have.outboundPath, want.outboundPath)
    )
      conflicts.push({
        field: field("outbound_path"),
        existing: have.outboundPath ?? existingHint(),
        incoming: want.outboundPath,
      });
    return;
  }
  if (want.path !== undefined && !pathsEqual(have.path, want.path))
    conflicts.push({
      field: field("path"),
      existing: have.path ?? existingHint(),
      incoming: want.path,
    });
}

/**
 * Compare a pre-existing config's connection block against the connection the
 * online accept will actually use -- the {@link connectionFromURL} result, i.e.
 * the accept URL with any `--server-*` overrides already applied -- splitting
 * the disagreements into those that must abort the acceptance (`conflicts`) and
 * those that only warn (`warnings`).
 *
 * Comparing against that built `target` connection, rather than re-deriving the
 * effective values from the URL here, is deliberate: the diff's verdict then
 * matches what the live exchange does field for field. It cannot affirm a "match"
 * the connection later contradicts, and it inherits `connectionFromURL`'s own
 * encoding handling for free (so when that builder is taught to percent-decode
 * the path/userinfo, this comparison decodes with it).
 *
 * The split follows where vs how you reach the rendezvous. `host` and `path`
 * identify *which* drop you are meeting at; a mismatch there is almost always a
 * wrong-invitation or wrong-config paste, so it is a conflict and aborts before
 * any acceptance is sent. The channel (protocol), port, and credentials are
 * *how* you reach the same drop and are legitimately variable -- e.g. a file-sync
 * drop reached via `file://` by one party and `sftp://` by another, an alternate
 * SSH port or tunnel, or a different account -- so a mismatch warns and the run
 * proceeds: the live exchange uses the target, and the saved config is left
 * unchanged. Only fields the target actually sets are compared: a port, path, or
 * credential the target leaves unset (the URL omitted it and no override
 * supplied it) is not a disagreement with whatever the config holds. host is
 * compared case-insensitively and paths ignoring a trailing slash, matching how
 * DNS and FileSyncConnection treat them. Credential values are never echoed in a
 * warning -- a password or key in a log is a leak -- so those warnings report
 * only that the value differs. A channel mismatch short-circuits the per-channel
 * fields, which are not comparable across channels.
 *
 * @internal exported for testing
 */
export function diffConnectionAgainstTarget(
  existing: ConnectionConfig,
  target: RunnableConnectionConfig,
): { conflicts: ReconcileDiff[]; warnings: string[] } {
  const conflicts: ReconcileDiff[] = [];
  const warnings: string[] = [];

  if (existing.channel !== target.channel) {
    warnings.push(
      `channel: specified ${target.channel}, saved ${existing.channel}`,
    );
    return { conflicts, warnings };
  }

  if (target.channel === "sftp") {
    // Safe: existing.channel === target.channel === "sftp".
    const have = (existing as SFTPConnectionConfig).server;
    const want = target.server;

    // host/path -> conflict (which drop you are meeting at). The directory is the
    // single shared `server.path` or the split inbound/outbound pair, compared in
    // whichever form the target uses.
    if (!hostsEqual(have.host, want.host))
      conflicts.push({
        field: "connection.server.host",
        existing: have.host,
        incoming: want.host,
      });
    pushDirectoryConflicts(
      conflicts,
      have,
      want,
      sftpPathsEqual,
      (key) => `connection.server.${key}`,
    );

    // port -> warn (how you reach the same host). An unset config port means the
    // SFTP default, so a target restating that default is not a divergence.
    if (
      want.port !== undefined &&
      want.port !== (have.port ?? DEFAULT_SFTP_PORT)
    )
      warnings.push(
        `port: specified ${want.port}, saved ${have.port ?? "unset"}`,
      );

    // credentials -> warn, value never echoed.
    if (want.username !== undefined && want.username !== have.username)
      warnings.push("username: differs from the saved value");
    if (want.password !== undefined && want.password !== have.password)
      warnings.push("password: differs from the saved value");
    if (want.privateKey !== undefined && want.privateKey !== have.privateKey)
      warnings.push("private key: differs from the saved value");
    if (
      want.privateKeyPassphrase !== undefined &&
      want.privateKeyPassphrase !== have.privateKeyPassphrase
    )
      warnings.push("private key passphrase: differs from the saved value");
    // keyboard_interactive is a non-secret auth toggle (settable only via
    // --server-keyboard-interactive, never from a URL), so its values are echoed
    // like the port above rather than redacted like the credentials; the
    // `!== undefined` guard keeps it silent unless the override actually set it.
    if (
      want.keyboardInteractive !== undefined &&
      want.keyboardInteractive !== have.keyboardInteractive
    )
      warnings.push(
        `keyboard-interactive: specified ${want.keyboardInteractive}, saved ` +
          `${have.keyboardInteractive ?? "unset"}`,
      );
  } else if (target.channel === "filedrop") {
    // filedrop's only locator is the directory -> conflict. No port/credentials
    // apply. The directory is the single shared `path` or the split
    // inbound/outbound pair, compared in whichever form the target uses.
    pushDirectoryConflicts(
      conflicts,
      existing as FileDropConnectionConfig,
      target,
      filedropPathsEqual,
      (key) => `connection.${key}`,
    );
  }
  // webrtc never reaches here: connectionFromURL rejects a ws/wss URL before the
  // target is built, so `target` is only ever sftp/filedrop, and a webrtc
  // existing config is caught by the channel mismatch above.

  return { conflicts, warnings };
}
