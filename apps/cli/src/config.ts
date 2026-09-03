import fs from "node:fs";

import YAML from "yaml";
import type {
  CompatibilityMessageFragment,
  ConnectionConfig,
  ExchangeSpec,
  LinkageRuleSetReference,
  LinkageSetIdentity,
  LinkageTerms,
  Metadata,
  OutboundPayloadConsent,
  Standardization,
} from "@psilink/core";
import {
  bareTermsValue,
  canonicalString,
  CanonicalEncodingError,
  clipToRenderedCost,
  compatibilityMessage,
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  DEFAULT_LINKAGE_RULE_SET,
  DISPLAY_TRUNCATION_MARKER,
  isDrawnFromLinkageRuleSet,
  MAX_NESTING_DEPTH,
  NestingDepthExceededError,
  quoteTermsValue,
  quoteTermsValueList,
  redactAndSanitizeForDisplay,
  redactPrivateKeyMaterial,
  renderedDisplayCost,
  replaceControlCharactersForDisplay,
  ruleSetCitation,
  safeParseConnectionConfig,
  safeParseFileSyncOptions,
  safeParseLinkageTerms,
  safeParseMetadata,
  snakeizeKey,
  snakeizeKeys,
  StandardizationSchema,
  trimPartialControlCharacterMarker,
  UsageError,
  withRetainModeImplications,
} from "@psilink/core";

import { writeFileOwnerOnly } from "./fileUtils";
import { parseSensitiveYaml, editSensitiveYamlDocument } from "./sensitiveFile";

/**
 * Default path for the exchange config file written by the provisioning
 * commands (`invite`, `accept`, and a zero-setup run with `--save`). Matches
 * the default the `exchange` command reads from, so a config written here is
 * found without an explicit `--config-file`.
 */
export const DEFAULT_CONFIG_PATH = "./psilink.yaml";

/**
 * The server/credential overrides {@link applyConnectionOverrides} writes into a
 * connection's `connection.server` block (host/port/credentials) and its
 * channel directory paths -- WHERE the rendezvous is and HOW to authenticate to
 * it. This is one half of the {@link ConnectionOverrides} seam, mirroring the
 * config schema's `server` + path fields as distinct from the tuning/toggle
 * {@link ConnectionOptionsOverrides} that land in `connection.options`.
 *
 * Named "server", not "locator": this set is credential-BEARING
 * (username/password/private-key), so it is deliberately NOT the credential-free
 * `ConnectionEndpoint` "locator" an invitation may carry -- the same "server"
 * label {@link OfflineIgnoredServerOverrides} uses for exactly this set.
 */
export interface ConnectionServerOverrides {
  username?: string;
  password?: string;
  privateKey?: string;
  /**
   * Passphrase for an encrypted `privateKey`; a companion credential, invalid
   * without a private key (from this override or the base config). See
   * {@link applyConnectionOverrides}, which rejects it standalone.
   */
  privateKeyPassphrase?: string;
  /**
   * Answer the server's keyboard-interactive prompts with the password. Requires
   * a password (from this override or the base config); see
   * {@link applyConnectionOverrides}, which rejects it without one. sftp-only.
   */
  keyboardInteractive?: boolean;
  /**
   * Pre-pinned SSH host-key fingerprint (OpenSSH SHA256 format), from
   * `--server-host-key-fingerprint`; already `@file`-resolved and
   * format-validated by {@link hostKeyFingerprintFlag} before it reaches here.
   * Overwrites any fingerprint already on the base config -- an explicit CLI
   * pin is the operator's current word on the server's identity. Feeding it
   * into `connection.server.hostKeyFingerprint` lets `establishHostKeyTrust`
   * find a pin already set and skip the interactive prompt; the real connect
   * then verifies it exactly as a stored pin, so a wrong value still fails
   * closed. sftp-only.
   */
  hostKeyFingerprint?: string;
  port?: number;
  /**
   * Outbound (self-written) directory for a split-directory exchange. When set,
   * the connection's single shared directory (the server URL/positional path, or
   * the loaded config's `path`/`server.path`) becomes the inbound (peer-written)
   * directory and this value becomes the outbound; see
   * {@link applyConnectionOverrides}. Requires retain mode and only applies to
   * the file-sync channels (`sftp`, `filedrop`).
   */
  outboundPath?: string;
}

/**
 * The tuning/toggle overrides {@link applyConnectionOverrides} writes into a
 * connection's `connection.options` block: the SharedOptions timeouts/reconnect
 * bound applied on every channel (`connectionTimeout`, `peerTimeout`,
 * `maxReconnectAttempts`) and the FileSyncOptions poll interval / toggles gated
 * to the file-sync channels (`pollIntervalMs`, `locklessRendezvous`, `peerId`,
 * `retainFiles`, `timestampInFilename`). `connectionTimeout`/`peerTimeout` are in
 * seconds here and the apply step scales them to the schema's milliseconds;
 * `pollIntervalMs` is already in milliseconds (the poll interval is sub-second
 * capable, so it is not routed through a lossy seconds scale) and is applied
 * verbatim. This is the `connection.options` half of the
 * {@link ConnectionOverrides} seam, as distinct from the server/credential
 * {@link ConnectionServerOverrides}.
 */
export interface ConnectionOptionsOverrides {
  connectionTimeout?: number;
  peerTimeout?: number;
  /**
   * The `--polling-frequency` override, already in milliseconds, feeding the
   * connection's `pollIntervalMs`. A FileSyncOptions field, so it is applied only
   * on the file-sync channels (see {@link applyConnectionOverrides}).
   */
  pollIntervalMs?: number;
  maxReconnectAttempts?: number;
  locklessRendezvous?: boolean;
  peerId?: string;
  retainFiles?: boolean;
  timestampInFilename?: boolean;
  /**
   * The `--connection-per-poll` override, feeding the connection's
   * `connectionPerPoll`. SFTP-only (the ephemeral-session mode dials a real SFTP
   * socket), so {@link applyConnectionOverrides} applies it only on `sftp` and
   * drops it on `filedrop`, where the CLI reports it ignored.
   */
  connectionPerPoll?: boolean;
}

/**
 * CLI overrides applied to a base connection by {@link applyConnectionOverrides},
 * split along the same seam the config schema keeps: the server/credential set
 * (plus directory paths) that lands in `connection.server`
 * ({@link ConnectionServerOverrides}), and the tuning/toggle set that lands in
 * `connection.options` ({@link ConnectionOptionsOverrides}). Each sub-group is
 * optional and itself sparse; an absent group (or field) applies no override.
 */
export interface ConnectionOverrides {
  server?: ConnectionServerOverrides;
  options?: ConnectionOptionsOverrides;
}

export function applyConnectionOverrides(
  connection: ConnectionConfig,
  overrides: ConnectionOverrides,
): ConnectionConfig {
  const result = structuredClone(connection);
  // The override seam: the server/credential sub-group feeds connection.server
  // and the directory paths; the options sub-group feeds connection.options.
  // Default each to empty so an absent group simply applies nothing.
  const { server: serverOverrides = {}, options: optionsOverrides = {} } =
    overrides;

  // Tracks whether any override merged into result.server (or a directory split
  // ran below), so the single connection-wide re-validation near the end runs
  // exactly when an override could have introduced an invalid value -- e.g. an
  // out-of-range --server-port, or a --server-password paired with a privateKey
  // already in the base config -- not on an untouched, already-validated config.
  let serverModified = false;

  if (result.channel === "sftp") {
    const { server } = result;
    if (serverOverrides.username !== undefined)
      server.username = serverOverrides.username;
    if (serverOverrides.password !== undefined) {
      server.password = serverOverrides.password;
      serverModified = true;
    }
    if (serverOverrides.privateKey !== undefined) {
      server.privateKey = serverOverrides.privateKey;
      serverModified = true;
    }
    if (serverOverrides.privateKeyPassphrase !== undefined)
      server.privateKeyPassphrase = serverOverrides.privateKeyPassphrase;
    if (serverOverrides.keyboardInteractive !== undefined)
      server.keyboardInteractive = serverOverrides.keyboardInteractive;
    if (serverOverrides.hostKeyFingerprint !== undefined) {
      // A pre-pin overwrites any fingerprint already on the base config, list or
      // scalar: an explicit CLI pin is the operator's current word on the
      // server's identity, superseding whatever the config carried. The value
      // has already been @file-resolved and format-validated at the CLI parse
      // boundary (hostKeyFingerprintFlag), so it can be assigned as-is here; the
      // re-validation below re-checks it as part of the whole connection anyway.
      server.hostKeyFingerprint = serverOverrides.hostKeyFingerprint;
      serverModified = true;
    }
    if (serverOverrides.port !== undefined) {
      server.port = serverOverrides.port;
      serverModified = true;
    }

    // A passphrase decrypts an encrypted private key and is meaningless without
    // one. Reject it up front with a flag-named message rather than deferring to
    // the core schema's config-field wording (its "privateKeyPassphrase is only
    // valid with privateKey" refine, which this mirrors). The private key may
    // arrive from --server-private-key (applied just above) or already sit in the
    // loaded config; either satisfies the precondition.
    if (
      server.privateKeyPassphrase !== undefined &&
      server.privateKey === undefined
    )
      throw new UsageError(
        "--server-private-key-passphrase requires --server-private-key (or a " +
          "private_key in the configuration): a passphrase decrypts an " +
          "encrypted private key and has no effect without one.",
      );

    // keyboard-interactive answers the server's prompts with the password, so it
    // is meaningless without one. Reject it up front with a flag-named message
    // rather than deferring to the core schema's config-field wording (its
    // "keyboard_interactive requires password" refine, which this mirrors), since
    // the override is applied after the config was parsed and would otherwise not
    // be re-validated. The password may arrive from --server-password (applied
    // just above) or already sit in the loaded config.
    if (server.keyboardInteractive === true && server.password === undefined)
      throw new UsageError(
        "--server-keyboard-interactive requires --server-password (or a " +
          "password in the configuration): it answers the server's " +
          "keyboard-interactive prompts with that password and has no effect " +
          "without one.",
      );
  }

  // Tracks whether any override merged into result.options, so the single
  // re-validation below runs exactly when an override could have introduced an
  // invalid value -- not on an untouched, already-validated config.
  let optionsModified = false;

  if (
    optionsOverrides.peerTimeout !== undefined ||
    optionsOverrides.connectionTimeout !== undefined ||
    optionsOverrides.maxReconnectAttempts !== undefined
  ) {
    result.options = {
      ...result.options,
      ...(optionsOverrides.peerTimeout !== undefined && {
        peerTimeoutMs: optionsOverrides.peerTimeout * 1000,
      }),
      ...(optionsOverrides.connectionTimeout !== undefined && {
        serverConnectTimeoutMs: optionsOverrides.connectionTimeout * 1000,
      }),
      ...(optionsOverrides.maxReconnectAttempts !== undefined && {
        maxReconnectAttempts: optionsOverrides.maxReconnectAttempts,
      }),
    };
    optionsModified = true;
  }

  // pollIntervalMs, locklessRendezvous, peerId, retainFiles, and
  // timestampInFilename are FileSyncOptions fields; only apply them on channels
  // that use FileSyncConnection. The other overrides above (peerTimeout etc.) are
  // SharedOptions that apply to all channels including webrtc. pollIntervalMs is
  // applied verbatim -- it is already in milliseconds (see
  // ConnectionOptionsOverrides), unlike the seconds-scaled timeout fields.
  if (
    (result.channel === "sftp" || result.channel === "filedrop") &&
    (optionsOverrides.pollIntervalMs !== undefined ||
      optionsOverrides.locklessRendezvous !== undefined ||
      optionsOverrides.peerId !== undefined ||
      optionsOverrides.retainFiles !== undefined ||
      optionsOverrides.timestampInFilename !== undefined)
  ) {
    result.options = withRetainModeImplications({
      ...result.options,
      ...(optionsOverrides.pollIntervalMs !== undefined && {
        pollIntervalMs: optionsOverrides.pollIntervalMs,
      }),
      ...(optionsOverrides.locklessRendezvous !== undefined && {
        locklessRendezvous: optionsOverrides.locklessRendezvous,
      }),
      ...(optionsOverrides.peerId !== undefined && {
        peerId: optionsOverrides.peerId,
      }),
      ...(optionsOverrides.retainFiles !== undefined && {
        retainFiles: optionsOverrides.retainFiles,
      }),
      ...(optionsOverrides.timestampInFilename !== undefined && {
        timestampInFilename: optionsOverrides.timestampInFilename,
      }),
    });

    optionsModified = true;
  }

  // connectionPerPoll is SFTP-only: the ephemeral-session mode dials a real SFTP
  // socket, which filedrop's connectionless client lacks. Apply it only on sftp,
  // so a filedrop config never carries an inert setting; on filedrop it is dropped
  // and warnUnsupportedFileSyncFlags reports it ignored. Unlike the file-sync
  // block above (which spans sftp and filedrop), this is gated to sftp alone.
  if (
    result.channel === "sftp" &&
    optionsOverrides.connectionPerPoll !== undefined
  ) {
    result.options = {
      ...result.options,
      connectionPerPoll: optionsOverrides.connectionPerPoll,
    };
    optionsModified = true;
  }

  // Re-validate the merged options through FileSyncOptionsSchema once, whenever
  // any override touched them -- a SharedOptions/timeout field or a
  // FileSyncOptions field. A single validation point keeps the schema the sole
  // source of truth for every floor (peerTimeoutMs/serverConnectTimeoutMs
  // positivity, peer_id min length and its timestamp_in_filename dependency,
  // reserved values, the retain_files implications) and removes the asymmetry
  // where the timeout merge above would otherwise trust its inputs while the
  // FileSync merge re-parsed: neither block can now bypass a floor the schema
  // enforces, regardless of which override path reached the value.
  //
  // FileSyncOptionsSchema is a safe superset for validating a webrtc
  // SharedOptions object: each of its FileSyncOptions-only refines is guarded
  // by that field's own presence, so none can fire on options that carry none
  // of those fields, and the shared floors are checked identically on every
  // channel.
  if (optionsModified) {
    const validation = safeParseFileSyncOptions(result.options);
    if (!validation.success) {
      const message = validation.error.issues
        .map((i: { message: string }) => i.message)
        .join("; ");
      // An invalid option combination (from psilink.yaml or a CLI override) is
      // invalid caller configuration: a UsageError so the CLI exits 64, not 69.
      throw new UsageError(message);
    }
  }

  // --outbound-path: split the single shared directory into a separate inbound
  // (peer-written) and outbound (self-written) directory. The path source -- the
  // server URL/positional for the URL-driven commands, or the loaded config for
  // `exchange` -- supplies the inbound directory; this override supplies the
  // outbound. Applied here, the single chokepoint every bootstrap command routes
  // its connection through, so the four commands share one mapping rather than
  // re-deriving it per command. Only the file-sync channels carry a directory.
  if (serverOverrides.outboundPath !== undefined) {
    if (result.channel === "sftp") {
      const { server } = result;
      // An already-split config (inbound set) keeps its inbound; a shared config
      // contributes its `path`. The single `path` cannot coexist with the pair.
      server.inboundPath = server.inboundPath ?? server.path;
      server.outboundPath = serverOverrides.outboundPath;
      delete server.path;
      serverModified = true;
    } else if (result.channel === "filedrop") {
      result.inboundPath = result.inboundPath ?? result.path;
      result.outboundPath = serverOverrides.outboundPath;
      delete result.path;
      serverModified = true;
    } else {
      // webrtc has no directory, so the flag is meaningless there: refuse it
      // with a cause naming the channels that do carry one, rather than
      // silently dropping it the way the channel-gated overrides above are.
      throw new UsageError(
        "--outbound-path is only supported on the sftp and filedrop channels",
      );
    }

    // Retain mode is a hard precondition for a split directory. Fail fast with a
    // CLI-oriented message naming the flag, rather than letting the core schema
    // below reject it with its config-field message. retain_files is the merged
    // value: --retain-files (applied above) or, for `exchange`, the loaded
    // config. The else branch above threw for webrtc, so result is a file-sync
    // channel here; the channel test re-narrows for the options read.
    if (
      (result.channel === "sftp" || result.channel === "filedrop") &&
      result.options?.retainFiles !== true
    )
      throw new UsageError(
        "--outbound-path configures a separate outbound directory, which " +
          "requires retain mode; pass --retain-files (or set retain_files: " +
          "true in the configuration).",
      );
  }

  // Re-validate the merged connection through the core schema once, whenever an
  // override touched result.server or its directory paths -- a credential, the
  // port, or the outbound-path split. This is the connection-wide counterpart to
  // the options re-validation above: it runs on every path that can introduce an
  // invalid value (not only the --outbound-path branch), so an out-of-range
  // --server-port is caught here regardless of which other overrides accompany
  // it. The remaining outbound-path-specific rejections -- an inbound equal to
  // the outbound, a relative or unset filedrop path, the pair-set-together rule
  // -- surface from the same call with the same messages and rules the live
  // connection enforces, rather than being re-implemented here. The literal
  // `@path` credential refs a connection may still carry validate cleanly as
  // strings (resolved later, at live use).
  if (serverModified) {
    const connValidation = safeParseConnectionConfig(result);
    if (!connValidation.success)
      throw new UsageError(
        connValidation.error.issues.map((i) => i.message).join("; "),
      );
  }

  return result;
}

/**
 * Logs a one-time reminder, on the file-sync channels only, that retain mode is
 * a bilateral agreement with no negotiation: this party has it enabled (with the
 * `lockless_rendezvous` and `timestamp_in_filename` it implies), and the peer
 * must set all three identically. A `retain_files` or `lockless_rendezvous`
 * mismatch is detected at rendezvous and fails fast on both sides with a clear
 * error naming each side's setting (`timestamp_in_filename` is not advertised,
 * but it cannot diverge independently of `retain_files`). Shared by the
 * `exchange` and `zero-setup` commands so the wording cannot drift between them.
 */
export function announceRetainMode(
  connection: ConnectionConfig,
  log: { info: (message: string) => void },
): void {
  if (
    (connection.channel === "sftp" || connection.channel === "filedrop") &&
    connection.options?.retainFiles === true
  ) {
    log.info(
      "retain mode is enabled, with lockless_rendezvous and " +
        "timestamp_in_filename; the peer must set all three identically " +
        "(these flags are not negotiated).",
    );
  }
}

/**
 * Validates the CLI-only entry-sweep flags. `--force-retain-sweep` is an
 * escalation of `--sweep-exchange-files`, never a standalone control: passing it
 * on its own is a {@link UsageError} (CLI exit 64) so it cannot be left set as a
 * permanent "always force" habit. Whether retain is actually "in play" is a
 * runtime property of the directory (the PEER may be the retain party), so it is
 * NOT checked here -- the connection's pre-sweep inspection enforces that. Shared
 * by the `exchange` and `zero-setup` commands so the rule cannot drift.
 */
export function assertRetainSweepGuard(
  sweepExchangeFiles: boolean,
  forceRetainSweep: boolean,
): void {
  if (forceRetainSweep && !sweepExchangeFiles)
    throw new UsageError(
      "--force-retain-sweep requires --sweep-exchange-files; it escalates the " +
        "sweep to wipe a retain-mode transcript and is meaningless on its own.",
    );
}

// --- Reconciliation (pre-existing config vs invitation / URL) ----------------

/**
 * One field that disagrees between a pre-existing configuration file and the
 * source it is reconciled against -- an invitation's linkage terms, or (for the
 * connection block, online) an accept URL. Collected into the user-facing
 * "resolve the conflict" error so the user sees exactly what differs.
 */
export interface ReconcileDiff {
  /**
   * snake_case field path as it appears in `psilink.yaml` (e.g. `algorithm`,
   * `linkage_keys`, `connection.server.host`). First-party text: every producer
   * supplies a literal, and it is what the conflict line's own structure is
   * built from.
   */
  field: string;
  /**
   * Rendering of the value in the pre-existing config; `(unset)` when absent.
   *
   * A fragment rather than a `string`, so a value somebody else chose cannot be
   * interpolated into a conflict line without passing the delimiting seam
   * ({@link reconcileDiffValue} and the renderers beside it, over core's
   * `quoteTermsValue`). Both sides carry chosen bytes -- the invitation's on the
   * incoming side, and on the existing side too wherever an earlier acceptance
   * adopted the inviter's terms into the kept config -- so neither side is
   * exempt. See {@link formatReconcileDiffs} for what the brand does not cover.
   */
  existing: CompatibilityMessageFragment;
  /** Rendering of the value the invitation or URL requires. */
  incoming: CompatibilityMessageFragment;
  /**
   * How each side is fitted where the line's slot cannot hold it whole.
   *
   * Absent where a side is ONE delimited run, which has nothing inside it to
   * partition: the slot's clip degrades that run and takes nothing else with it.
   * Supplied where a side is a CLAUSE -- several chosen values inside
   * first-party structure -- so the slot's share is divided among those values
   * rather than spent left to right on the first of them, which would delete the
   * structure standing behind it (see {@link reconcileClause}).
   */
  fit?: ReconcileDiffFit;
}

/**
 * The two sides of one conflict line as claims on the block's budget.
 *
 * Carried BESIDE the sides rather than in place of them, and produced by the one
 * composition that produced those sides ({@link reconcileClause}), so a fitted
 * side cannot describe a different clause than the unfitted one it replaces.
 */
export interface ReconcileDiffFit {
  existing: ReconcileSideFit;
  incoming: ReconcileSideFit;
}

/**
 * What one side of a conflict line needs, what it cannot go below, and how it
 * renders at what it is given.
 *
 * The two measurements are what makes the block's allocation NEED-AWARE rather
 * than count-driven ({@link formatReconcileDiffs}): a side takes only `need`,
 * and what it leaves is available to the sides that exceed their share, so the
 * count of disagreeing fields no longer decides on its own whether any value is
 * shown.
 */
export interface ReconcileSideFit {
  /** Rendered cost of this side whole, which is all it can ever spend. */
  need: number;
  /**
   * Least this side can be given and still read as what it is. A side given
   * less than the smaller of this and its `need` is not fitted at all: its LINE
   * names its field and drops both values, which costs the operator less than a
   * clause cut back to punctuation and truncation markers.
   */
  minimum: number;
  /** This side rendered into `budget`. */
  fit: (budget: number) => string;
}

/** Placeholder rendered for an absent value in a {@link ReconcileDiff}. */
export const RECONCILE_UNSET = compatibilityMessage`(unset)`;

/**
 * One value somebody else chose, TREATED for a reconcile conflict line: redacted
 * as private-key material, then rendered as one delimited run through core's
 * terms-value seam.
 *
 * Redaction comes first because the display boundary's private-key rule is
 * fail-closed past a `BEGIN` marker carrying no `END` -- it replaces from the
 * marker to the end of the cause-chain link -- and the whole reconcile refusal
 * is one link, so a marker planted in a linkage-field name would otherwise
 * consume every conflict line composed behind it. Redacting where the value is
 * interpolated bounds that rule to the fragment that carried the marker (see
 * {@link redactPrivateKeyMaterial}).
 *
 * Delimiting answers the other half, which redaction and the display escape both
 * pass over: a conflict line is first-party prose an operator reads as psilink's
 * own -- `linkage_keys: existing X vs required Y` -- and a value of
 * `A vs required B` is printable ASCII throughout, so nothing at the display
 * boundary rewrites it. The seam's doubling grammar makes a value unable to
 * terminate its own run, so it reads as content rather than as structure the
 * refusal asserted.
 *
 * The seam's control-character treatment answers the same half one level up,
 * where this block's structure is a `\n` rather than a printable connective: the
 * whole refusal is escaped as ONE link, so the block's own line breaks reach the
 * operator as the escape's `\xHH` and a value's own would reach them as the same
 * token. Treated, that token is the composition's alone (see
 * {@link replaceControlCharactersForDisplay}).
 *
 * None of the three passes is escaping: the run's bytes stay raw for the single
 * escape the display sink applies (CONTRIBUTING.md, Operator-facing escaping),
 * and the seam emits only printable ASCII, which that escape passes through
 * unchanged.
 */
export function reconcileDiffValue(
  value: string,
): CompatibilityMessageFragment {
  return quoteTermsValue(redactPrivateKeyMaterial(value));
}

/**
 * The same treatment for a value the linkage-terms schema constrains to a shape
 * no clause boundary is made of -- a semver string, an ISO date -- which core's
 * checked bare form renders undelimited so the common line reads as prose. The
 * check runs on the value in hand, so a value that does not meet the shape falls
 * back to the delimited form rather than being trusted for its field's sake.
 */
function reconcileDiffBareValue(value: string): CompatibilityMessageFragment {
  return bareTermsValue(redactPrivateKeyMaterial(value));
}

const DISPLAY_TRUNCATION_MARKER_COST = renderedDisplayCost(
  DISPLAY_TRUNCATION_MARKER,
);

/**
 * The delimiter core's seam wraps a terms value in and doubles inside one, read
 * off the seam rather than restated, so the fit below cannot drift from the
 * grammar it has to preserve.
 */
const TERMS_VALUE_DELIMITER = quoteTermsValue("")[0];

const TERMS_VALUE_DELIMITER_COST = renderedDisplayCost(TERMS_VALUE_DELIMITER);

/**
 * Fit a composed conflict-line fragment to `budget`, cutting the VALUE inside a
 * delimited run rather than the run's rendering: the cut never falls between the
 * two characters of a doubled delimiter, and a cut that lands inside a run
 * delimits what it kept -- truncation marker inside -- rather than leaving the
 * run open.
 *
 * This is the treatment's own order (redact, clip, delimit) carried to where the
 * composition happens, and it is what keeps the seam's guarantee over a fitted
 * line: the run structure an operator reads is the structure this module
 * composed, at any budget and for any value width. Core's
 * {@link clipToRenderedCost} cuts the rendered form instead, so a value the
 * partner sized to land the cut mid-run leaves that run open and everything
 * composed after it on the line -- the clause's next value, the other side of
 * the line -- reads at the opposite run parity from the one it was composed at.
 *
 * The doubling is why the clip cannot simply be moved ahead of the delimiting: a
 * raw prefix measured against the budget renders WIDER once its delimiters are
 * doubled back in. Charging each doubled pair as it is kept is that same clip,
 * costed at what the run renders to.
 *
 * The seam's control-character markers are the other unit a cut may not fall
 * inside, and they are backed off out of the kept prefix
 * ({@link trimPartialControlCharacterMarker}) before the marker and any closing
 * delimiter are appended -- so the budget bounds this rather than being met by
 * it, and the run the walk above ended in is still the run this closes.
 */
function fitToRenderedCostClosingRuns(text: string, budget: number): string {
  if (renderedDisplayCost(text) <= budget) return text;
  const units = Array.from(text);
  let kept = "";
  let cost = 0;
  let insideRun = false;
  let index = 0;
  while (index < units.length) {
    const unit = units[index];
    const delimiter = unit === TERMS_VALUE_DELIMITER;
    const doubled: boolean =
      delimiter && insideRun && units[index + 1] === TERMS_VALUE_DELIMITER;
    const taken = doubled ? unit + unit : unit;
    const nextInsideRun: boolean =
      delimiter && !doubled ? !insideRun : insideRun;
    const spent = cost + renderedDisplayCost(taken);
    // What closing this cut costs is reserved before the unit is kept, so the
    // run this enters is one the budget can still close.
    const closing = nextInsideRun ? TERMS_VALUE_DELIMITER_COST : 0;
    if (spent + DISPLAY_TRUNCATION_MARKER_COST + closing > budget) break;
    kept += taken;
    cost = spent;
    insideRun = nextInsideRun;
    index += doubled ? 2 : 1;
  }
  return `${trimPartialControlCharacterMarker(kept)}${DISPLAY_TRUNCATION_MARKER}${insideRun ? TERMS_VALUE_DELIMITER : ""}`;
}

/**
 * Least a conflict line may spend on ONE of its two values while still showing
 * any of that value's own bytes.
 *
 * A fitted value pays for its delimiters and, when the fit cuts it, for the
 * truncation marker, so below this a side renders as punctuation and a marker
 * with nothing of the value left inside. A line whose sides cannot both be given
 * this much is named without its values instead ({@link formatReconcileDiffs}),
 * which is the honest reading of "there is no room for this line's values" and
 * costs the operator less than a marker.
 */
const RECONCILE_MIN_VALUE_BUDGET = 32;

/**
 * The same floor for ONE value inside a clause, which pays for the marker out of
 * its own share the way a whole side does.
 *
 * Sized off the marker rather than restated, because what makes a share useless
 * is that the marker consumes it: at or below the marker's cost a clipped value
 * renders as a run with nothing of its own inside, so a clause given the count
 * of its values times this floor still shows some of every value's own bytes.
 * Smaller than the whole-side floor above, since a clause fits several values
 * into a slot sized for one side and the alternative is dropping the line's
 * values entirely.
 */
const RECONCILE_MIN_CLAUSE_VALUE_BUDGET = DISPLAY_TRUNCATION_MARKER_COST + 8;

/**
 * Divide `budget` among claims of the given `needs`, need-aware: a claim takes
 * only what it needs, and what it leaves is available to the claims that exceed
 * an equal share, so a constraint falls only on the claims too wide for the room
 * -- never on a claim that was already going to fit.
 *
 * Serving the claims in ascending order is what settles that in one pass: every
 * claim still unserved is at least as wide as the one being served, so an equal
 * share of what remains is the most the current claim can take without stranding
 * one behind it, and a claim narrower than that share hands the difference on.
 */
function allocateByNeed(needs: readonly number[], budget: number): number[] {
  const shares = needs.map(() => 0);
  const ascending = needs
    .map((_, index) => index)
    .sort((a, b) => needs[a] - needs[b]);
  let remaining = Math.max(0, budget);
  for (let served = 0; served < ascending.length; served += 1) {
    const share = Math.floor(remaining / (ascending.length - served));
    if (needs[ascending[served]] > share) {
      // Every claim still unserved is at least this wide, so they are all
      // constrained and all take the same share. What the division leaves over
      // goes unspent rather than to whichever claim happened to be served last:
      // two claims of equal need are two claims that fit alike, and a line whose
      // two sides differ by the odd character left over is a line whose sides
      // were cut at different points for no reason the operator can see.
      for (let rest = served; rest < ascending.length; rest += 1)
        shares[ascending[rest]] = share;
      break;
    }
    shares[ascending[served]] = needs[ascending[served]];
    remaining -= needs[ascending[served]];
  }
  return shares;
}

/**
 * One side of a conflict line built from more than one value: the clause whole,
 * what it claims on the block's budget, and the same clause fitted to a budget.
 */
export interface ReconcileClause extends ReconcileSideFit {
  /** Every value at its full width, for a slot that can hold them. */
  text: CompatibilityMessageFragment;
}

/**
 * Compose a conflict line's side as a tagged template, keeping the values apart
 * from the first-party spans around them so a slot too small for the whole
 * clause can be divided among the VALUES.
 *
 * This is the provenance partition {@link formatReconcileDiffs} applies between
 * lines, carried one level down into a line: the clause's own spans are
 * first-party copy, measured where they stand, and what the slot leaves is
 * shared out among the values it names by the same need-aware rule the block
 * applies between sides, so a version of five characters cannot hold a quarter
 * of the slot away from the name beside it. Clipping the composed clause instead
 * spends the slot left to right, so the first value takes all of it and the
 * connective, the values behind it, and the clause's second half are deleted -- a
 * partner-chosen set name at the schema's length would leave the operator a
 * citation with no version, no `over`, and no field set on either side.
 * Sub-partitioned, degradation happens INSIDE a value: at any share the clause
 * still reads as a name, a version, the connective, and the other half, however
 * little of each survives.
 *
 * A share too small for its value degrades that value's own bytes and nothing
 * around them: the fit cuts inside the run and delimits what it kept
 * ({@link fitToRenderedCostClosingRuns}), so no cut can leave a run open for the
 * clause's next value -- or for the other side of the line -- to be read inside.
 * The fitted form is a plain string rather than a fragment because it is
 * composed by concatenation rather than through core's tagged template; what
 * holds the run structure over it is a check on the rendered lines
 * (`apps/cli/test/unit/config.test.ts`).
 */
export function reconcileClause(
  fixedSpans: TemplateStringsArray,
  ...values: readonly CompatibilityMessageFragment[]
): ReconcileClause {
  const structureCost = renderedDisplayCost(fixedSpans.join(""));
  const needs = values.map((value) => renderedDisplayCost(value));
  return {
    text: compatibilityMessage(fixedSpans, ...values),
    need: needs.reduce((total, need) => total + need, structureCost),
    // The spans do not shrink and every value the clause names has to stay
    // visible inside them, so this is what the clause structurally is. A value
    // already narrower than the floor asks for its own width instead, which is
    // the same rule the block applies to a side.
    minimum: needs.reduce(
      (total, need) =>
        total + Math.min(need, RECONCILE_MIN_CLAUSE_VALUE_BUDGET),
      structureCost,
    ),
    fit: (budget: number): string => {
      const shares = allocateByNeed(needs, Math.max(0, budget - structureCost));
      let composed: string = fixedSpans[0];
      for (let index = 0; index < values.length; index += 1)
        composed +=
          fitToRenderedCostClosingRuns(values[index], shares[index]) +
          fixedSpans[index + 1];
      // A share below what the marker and the run's own delimiters cost leaves
      // a clipped value wider than its share, so the composed clause is held to
      // the slot it was given rather than to the sum of the parts it fitted. The
      // block's floor keeps a fitted line off that shape; this is the backstop
      // under a budget reached some other way.
      return fitToRenderedCostClosingRuns(composed, budget);
    },
  };
}

/**
 * One delimited run as a clause side, for a conflict line whose OTHER side is a
 * clause: the line's fit covers both sides, and this one has nothing inside it
 * to partition -- the slot's clip degrades the single run and takes nothing else
 * with it.
 */
export function reconcileValueClause(value: string): ReconcileClause {
  const text = reconcileDiffValue(value);
  return {
    text,
    need: renderedDisplayCost(text),
    minimum: RECONCILE_MIN_VALUE_BUDGET,
    fit: (budget: number): string => fitToRenderedCostClosingRuns(text, budget),
  };
}

/**
 * The side of a conflict on an OPTIONAL block that names no chosen value at all,
 * as a clause -- so a line whose other side is one can carry a fit for both of
 * its sides. Nothing here to sub-partition: the placeholder is first-party copy,
 * so it asks for exactly its own width and is held to the slot it was given.
 */
const RECONCILE_ABSENT_CLAUSE: ReconcileClause = {
  text: RECONCILE_UNSET,
  need: renderedDisplayCost(RECONCILE_UNSET),
  minimum: renderedDisplayCost(RECONCILE_UNSET),
  fit: (budget: number): string =>
    fitToRenderedCostClosingRuns(RECONCILE_UNSET, budget),
};

/**
 * One conflict line whose two sides are clauses: the sides themselves, and the
 * per-side fit beside them.
 *
 * Both come from the composition that produced the sides
 * ({@link reconcileClause}), which is what keeps a fitted side an account of the
 * same clause the unfitted one is.
 */
export function reconcileClauseConflict(
  existing: ReconcileClause,
  incoming: ReconcileClause,
): Omit<ReconcileDiff, "field"> {
  return {
    existing: existing.text,
    incoming: incoming.text,
    fit: { existing, incoming },
  };
}

/**
 * Recursively drop every key whose value is `undefined` from a JSON-like value,
 * preserving the rest of its structure. An explicit `undefined` (which an
 * in-process object built by spread may carry, unlike a Zod-parsed one where
 * absent optionals are simply omitted) is treated as absent rather than handed
 * to {@link canonicalString}, which rejects it. Two values that differ only in
 * an absent vs explicitly-`undefined` optional therefore compare equal, matching
 * how the schema treats them.
 *
 * Strings are carried through untouched, normalization form included: the
 * equality this feeds is byte-exact, because that is the predicate core holds
 * the same values to (see {@link diffLinkageTerms}).
 *
 * `depth` bounds the native recursion at the same {@link MAX_NESTING_DEPTH} the
 * camelize chokepoint applies on every linkage-terms parse path. Both sides
 * reach this walk already depth-bounded: the invitation decode path normalizes
 * `transform.params` through the bounded `camelizeKeys` chokepoint (core's
 * invitation decode pre-pass), so a partner-controlled one-key-per-level
 * `params` is rejected at decode before it could reach here, and the
 * existing-config side is bounded the same way at load. This guard is the
 * reconcile walk's own backstop, kept because the walk is an independent
 * recursion that must not rely on every caller having pre-bounded its input: an
 * unguarded deep value would overflow it with a `RangeError` the command
 * boundary maps to a generic internal-error exit (69), whereas rejecting at 256
 * yields a clean, terminal {@link NestingDepthExceededError} (a `UsageError`, CLI
 * exit 64) long before the overflow, with headroom far above any real config (the
 * deepest schema path is under a dozen levels, and `params` legitimately holds
 * shallow scalars). See docs/spec/CHANNEL_SECURITY.md.
 */
function withoutUndefinedDeep(value: unknown, depth = 0): unknown {
  if (depth >= MAX_NESTING_DEPTH) throw new NestingDepthExceededError();
  if (Array.isArray(value))
    return value.map((v) => withoutUndefinedDeep(v, depth + 1));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, withoutUndefinedDeep(v, depth + 1)]),
    );
  return value;
}

/**
 * Canonical (RFC 8785) encoding of a value for the reconcile's structural
 * equality check, byte-exact over the strings inside it. The canonical encoder
 * sorts object keys, so property-insertion order does not affect the result;
 * array order is preserved, so the caller pre-sorts any list whose order is not
 * significant.
 *
 * No key-casing fold is applied: `transform.params` keys (the only ones whose
 * form could vary) are normalized to camelCase upstream on every parse path that
 * produces these terms -- the existing config at load, and the invitation's
 * adopted terms at decode (core's invitation decode pre-pass) -- so both sides
 * reach this compare in the one camelCase form.
 */
function reconcileCanonical(value: unknown): string {
  return canonicalString(withoutUndefinedDeep(value));
}

/**
 * Render the identifiers of a list of named entries (linkage fields/keys,
 * payload columns) for a diff line, in the order given.
 *
 * Each name is delimited on its own rather than the joined list being delimited
 * once, so the rendered list shows the same partition the byte-exact,
 * element-wise comparison used to decide the conflict: one entry named `a,b`
 * renders as one run where two entries named `a` and `b` render as two.
 */
function renderNames(
  list: ReadonlyArray<{ name: string }>,
): CompatibilityMessageFragment {
  return compatibilityMessage`[${quoteTermsValueList(
    list.map((e) => redactPrivateKeyMaterial(e.name)),
  )}]`;
}

/**
 * When the two rendered sides of a diff come out identical despite a canonical
 * difference -- a name-only rendering of values that share every name but differ
 * in a sub-field (a linkage field/key's type/constraints/`swap`, a payload
 * column's description) -- fall back to the full JSON of each value, so the
 * conflict message shows what actually differs instead of two identical-looking
 * summaries. The JSON is of whatever the caller hands it, not the form the
 * comparison encoded, so the user sees the stored values to edit.
 *
 * The fallback's JSON carries the same chosen bytes the name-only rendering
 * withheld, so it takes the same treatment ({@link reconcileDiffValue}) -- over the
 * serialized text rather than value by value, which reaches a name nested
 * anywhere inside the structure. Rendering it raw here would put back on the
 * message the marker and the clause forgery the summary form took out of it.
 */
function disambiguate(
  existingRendered: CompatibilityMessageFragment,
  incomingRendered: CompatibilityMessageFragment,
  existingValue: unknown,
  incomingValue: unknown,
): {
  existing: CompatibilityMessageFragment;
  incoming: CompatibilityMessageFragment;
} {
  if (existingRendered === incomingRendered)
    return {
      existing: reconcileDiffValue(JSON.stringify(existingValue)),
      incoming: reconcileDiffValue(JSON.stringify(incomingValue)),
    };
  return { existing: existingRendered, incoming: incomingRendered };
}

/** Render the existing/incoming sides of a structural-list (linkage fields/keys)
 *  conflict: names when the lists differ by name, else the full JSON. */
function renderStructural(
  existing: ReadonlyArray<{ name: string }>,
  incoming: ReadonlyArray<{ name: string }>,
): {
  existing: CompatibilityMessageFragment;
  incoming: CompatibilityMessageFragment;
} {
  return disambiguate(
    renderNames(existing),
    renderNames(incoming),
    existing,
    incoming,
  );
}

/**
 * Render a rule-set citation for a diff line, keys first -- the order core's own
 * mismatch message and the drift warning both render the pair in, and built from
 * the same seam, so the two accounts of one citation cannot drift apart on how a
 * name is delimited. Unescaped, unlike {@link describeRuleSetCitation}, whose
 * sink is a `log.warn`: a diff line is composed into a {@link UsageError} and
 * escaped once where it is shown.
 *
 * All four values stand in ONE clause rather than two halves composed together,
 * because the sub-partition the fit runs is over the values a clause names
 * ({@link reconcileClause}): as two nested halves the outer clause would divide
 * its slot between the halves and each half would then divide again, giving the
 * name and the version of each side a quarter of the slot the same way, but only
 * after two rounds of the marker's own cost. One clause of four values is the
 * same share arithmetic charged once.
 */
function renderRuleSetCitation(
  reference: LinkageRuleSetReference,
): ReconcileClause {
  return reconcileClause`${reconcileDiffValue(reference.keySet.name)} ${reconcileDiffBareValue(reference.keySet.version)} over ${reconcileDiffValue(reference.fieldSet.name)} ${reconcileDiffBareValue(reference.fieldSet.version)}`;
}

/**
 * The two sides of a `linkage_rule_set` conflict, each as its clause.
 *
 * No full-detail fallback beside it, unlike the structural lists: the clause is
 * built from delimited runs and a checked bare form, which no two different
 * citations can spell alike, so two clauses that read the same are two citations
 * whose difference redaction took out -- and the full detail of those same
 * values, redacted the same way, would read alike too. The pair that reaches
 * that state is reported by {@link formatReconcileDiffs}, which is where the fit
 * that can also collapse a pair happens; this renderer is deliberately not a
 * second place that decides it.
 */
function renderRuleSetCitationConflict(
  existing: LinkageRuleSetReference,
  incoming: LinkageRuleSetReference,
): Omit<ReconcileDiff, "field"> {
  return reconcileClauseConflict(
    renderRuleSetCitation(existing),
    renderRuleSetCitation(incoming),
  );
}

/**
 * Compare a pre-existing config's linkage terms against the terms an acceptance
 * would adopt from the invitation, returning the mandatory disagreements that
 * must abort the acceptance and the soft mismatches that only warn.
 *
 * This is an equality check ("do these describe the same exchange agreement?"),
 * NOT the cross-party {@link validateCompatibility} (which checks that two
 * different parties' terms work together). Reusing the existing config must not
 * silently change what was agreed, so the agreement-defining fields -- version,
 * algorithm, the linkage strategy, linkage fields and keys, the rule-set
 * citation (where both sides declare one), legal agreement, and payload -- must
 * match.
 *
 * The per-party fields are excluded, because each party legitimately holds its
 * own value (per the LinkageTerms consistency model): `identity` (the holding
 * party's name), `output` (an each-party preference the protocol checks as a
 * complementary *mirror*, not an equality, in `validateCompatibility` -- so two
 * compatible parties have unequal output blocks), and `deduplicate` (a per-party
 * flag with no cross-party check at all). Comparing any of these by equality
 * against the invitation's copy -- which carries the *inviter's* per-party
 * choices -- would falsely reject a valid existing config; genuine output
 * incompatibility is caught against the live partner at exchange time. `date` is
 * soft (a mismatch warns rather than aborts, matching `validateCompatibility`).
 * Ordering follows what each structural field's own order means: linkage fields
 * are pre-sorted by name on both sides (their array order is not significant),
 * linkage keys are compared in place (their order is).
 *
 * The rule-set citation is compared ONLY where both sides declare one, which is
 * `validateCompatibility`'s rule for it rather than a second one invented here:
 * a side declaring none is not held to the other's citation, so a kept config
 * citing nothing against an invitation that cites (or the reverse) reconciles
 * cleanly. Where both cite, a difference is a conflict on the same footing as
 * the other agreement-defining fields -- the exchange would otherwise abort
 * mid-run on `validateCompatibility`'s "linkage rule set mismatch", after the
 * reconcile had reported the config as matching.
 *
 * Every value compared here is compared BYTE-EXACT, by canonical form or (for a
 * schema-constrained scalar) by string equality, because that is the predicate
 * `validateCompatibility` applies to the same values: core holds linkage fields,
 * linkage keys, and the citation to `canonicalString` equality and the legal
 * agreement and payload column names to string equality, so a pair differing
 * only in Unicode normalization form is a mismatch on every one of them.
 * Folding two such values together here would report the reuse clean and then
 * abort every run mid-exchange on it, with the partner keeping the invitation's
 * spelling. Reported at accept instead, the operator can still settle the
 * spelling with the inviting party, or accept onto a fresh config. Matching the
 * gate (both sides declare a citation) without matching the predicate would
 * leave that gap open on the field the gate was written for.
 *
 * On the PAYLOAD alone this compare is STRICTER than core, which reads only the
 * column names its send/receive mirror cross-checks: a column's `description`
 * takes part in the whole-object compare here and is never read there. On the
 * legal agreement the two are EQUALLY strict -- the object is compared whole
 * here, and `validateCompatibility` cross-checks each of its fields, a parity
 * `test/unit/config.test.ts` holds field by field rather than leaving to this
 * sentence. The extra strictness on the payload answers the question this
 * compare asks, which is whether the document being reused is the one the
 * acceptance adopts; in that direction it only refuses a reuse the operator can
 * still make onto a fresh config, and it cannot pass terms the exchange would
 * then refuse.
 */
export function diffLinkageTerms(
  existing: LinkageTerms,
  incoming: LinkageTerms,
): { conflicts: ReconcileDiff[]; warnings: string[] } {
  const conflicts: ReconcileDiff[] = [];
  const warnings: string[] = [];
  const add = (
    field: string,
    a: CompatibilityMessageFragment,
    b: CompatibilityMessageFragment,
  ): void => {
    conflicts.push({ field, existing: a, incoming: b });
  };

  // canonicalString rejects values it cannot encode -- e.g. an integer outside
  // the JSON-safe range in a transform param, which the `z.unknown()` params
  // record lets through. Wrap the canonical comparison (mirroring core's
  // validateCompatibility, which wraps the same primitive) so such a value does
  // not abort the reconcile with a raw encoding error -- which would otherwise
  // reject even two IDENTICAL configs. When a side cannot be encoded the equality
  // cannot be decided here, so warn and do not treat it as a conflict: the
  // cross-party validateCompatibility re-checks compatibility at exchange setup
  // and surfaces an un-encodable value as a hard error there, so reuse stays
  // backstopped.
  //
  // Only CanonicalEncodingError is softened to a warning. The undefined-pruning
  // walk's own depth guard can also throw NestingDepthExceededError, and that is
  // deliberately left to propagate as the terminal exit-64 usage error established
  // for a pathological token -- a too-deep structure is rejected, not
  // reconciled-and-deferred the way an un-encodable value is. Both sides are
  // depth-bounded upstream (the invitation's params at decode, the config at
  // load), so this backstop is not normally reachable; it stays because
  // withoutUndefinedDeep is an independent recursion that must not depend on its
  // callers (see withoutUndefinedDeep).
  const canonicalDiffers = (a: unknown, b: unknown, label: string): boolean => {
    let ca: string;
    let cb: string;
    try {
      ca = reconcileCanonical(a);
      cb = reconcileCanonical(b);
    } catch (err) {
      if (err instanceof CanonicalEncodingError) {
        warnings.push(
          `the ${label} could not be compared against the configuration ` +
            "because a value is outside the JSON-safe range; verify it manually " +
            "(the exchange re-checks compatibility before running)",
        );
        return false;
      }
      throw err;
    }
    return ca !== cb;
  };

  // version, algorithm, and linkageStrategy are compared by string equality
  // rather than through the canonical encoder used below. All three are
  // schema-constrained scalars -- version to a semver string
  // (/^\d+\.\d+\.\d+$/), algorithm to a fixed enum ("psi" | "psi-c"), and
  // linkageStrategy to a fixed enum ("cascade" | "single-pass") -- so the
  // encoding of each is the string itself, and this is the byte-exact equality
  // core's validateCompatibility compares them by. (Semver range matching, as
  // opposed to exact equality, is a cross-cutting concern that belongs in core's
  // validateCompatibility, which also compares version exactly.)
  if (existing.version !== incoming.version)
    add(
      "version",
      reconcileDiffBareValue(existing.version),
      reconcileDiffBareValue(incoming.version),
    );
  if (existing.algorithm !== incoming.algorithm)
    add(
      "algorithm",
      reconcileDiffValue(existing.algorithm),
      reconcileDiffValue(incoming.algorithm),
    );
  // linkageStrategy is mandatory-consistency exactly like algorithm (core's
  // validateCompatibility aborts on a mismatch), so a reused config whose strategy
  // differs from the invitation's is a conflict, not a silent reuse: without this
  // the reconcile would report "matches" and keep a config whose linkage_strategy
  // differs from the one the acceptor was shown on the consent prompt, so the
  // later `psilink exchange` could run a strategy -- and a disclosure tradeoff --
  // the operator never consented to (it would abort against the live partner, but
  // only after the false "matches" assurance). Surfaced as a `single-pass`
  // disclosure surface, so the reused config and the consented strategy stay
  // identical.
  if (existing.linkageStrategy !== incoming.linkageStrategy)
    add(
      "linkage_strategy",
      reconcileDiffValue(existing.linkageStrategy),
      reconcileDiffValue(incoming.linkageStrategy),
    );

  // Sort linkage fields by name (their order is not significant) before the
  // canonical compare; compare linkage keys in place (their order is). The
  // comparator is core's own -- the raw name, ordered by UTF-16 code unit, not
  // localeCompare -- so the two sides reach the byte-exact compare below in the
  // order validateCompatibility would put them in, and a field set that agrees
  // there agrees here rather than differing over which side sorted how.
  const byName = (a: { name: string }, b: { name: string }): number =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  const existingFields = [...existing.linkageFields].sort(byName);
  const incomingFields = [...incoming.linkageFields].sort(byName);
  if (canonicalDiffers(existingFields, incomingFields, "linkage fields")) {
    const r = renderStructural(existingFields, incomingFields);
    add("linkage_fields", r.existing, r.incoming);
  }

  if (
    canonicalDiffers(existing.linkageKeys, incoming.linkageKeys, "linkage keys")
  ) {
    const r = renderStructural(existing.linkageKeys, incoming.linkageKeys);
    add("linkage_keys", r.existing, r.incoming);
  }

  // Only where BOTH sides cite, which is validateCompatibility's own gate for
  // the citation rather than a second rule invented here (see the doc comment).
  if (
    existing.linkageRuleSet !== undefined &&
    incoming.linkageRuleSet !== undefined &&
    canonicalDiffers(
      existing.linkageRuleSet,
      incoming.linkageRuleSet,
      "linkage rule set",
    )
  ) {
    conflicts.push({
      field: "linkage_rule_set",
      ...renderRuleSetCitationConflict(
        existing.linkageRuleSet,
        incoming.linkageRuleSet,
      ),
    });
  }

  // The reference is partner-chosen free text and the expiration date is
  // schema-constrained, so each takes the form its own shape earns rather than
  // the pair being delimited once: a reference reading `X (expires 2030-01-01)`
  // cannot then be mistaken for the clause this line composes around it. Two
  // values inside first-party copy is a clause, so the slot divides between them
  // (reconcileClause): a reference at the schema's length degrades itself rather
  // than deleting the expiry -- which is both the half the two sides may be
  // differing in and the half an operator can check against their own copy.
  const renderAgreement = (
    la: LinkageTerms["legalAgreement"],
  ): ReconcileClause =>
    la === undefined
      ? RECONCILE_ABSENT_CLAUSE
      : reconcileClause`${reconcileDiffValue(la.reference)} (expires ${reconcileDiffBareValue(la.expirationDate)})`;
  if (
    canonicalDiffers(
      existing.legalAgreement ?? null,
      incoming.legalAgreement ?? null,
      "legal agreement",
    )
  )
    conflicts.push({
      field: "legal_agreement",
      ...reconcileClauseConflict(
        renderAgreement(existing.legalAgreement),
        renderAgreement(incoming.legalAgreement),
      ),
    });

  const renderPayload = (
    p: LinkageTerms["payload"],
  ): CompatibilityMessageFragment =>
    p === undefined
      ? RECONCILE_UNSET
      : compatibilityMessage`send=${renderNames(p.send ?? [])} receive=${renderNames(p.receive ?? [])}`;
  if (
    canonicalDiffers(
      existing.payload ?? null,
      incoming.payload ?? null,
      "payload",
    )
  ) {
    const r = disambiguate(
      renderPayload(existing.payload),
      renderPayload(incoming.payload),
      existing.payload ?? null,
      incoming.payload ?? null,
    );
    add("payload", r.existing, r.incoming);
  }

  if (existing.date !== incoming.date)
    warnings.push(
      `the existing config's linkage-terms date (${existing.date}) differs from ` +
        `the invitation's (${incoming.date}); one copy may be stale`,
    );

  return { conflicts, warnings };
}

/**
 * What the operator's own configuration path may render to at the head of the
 * reconciliation refusal.
 *
 * The path is the operator's own -- a `--config-file` value or the built-in
 * default -- so this is not an adversary's budget; it is the second half of a
 * partition BY PROVENANCE, which is what keeps one chooser from spending
 * another's room. Nothing bounds the path's length, and it is composed ahead of
 * everything else in the message, so leaving it unfitted would let a long path
 * (or a path whose bytes escape wide at the display boundary) crowd out the
 * conflict detail and the recovery step behind it.
 *
 * Sized well above any path a real run carries and below what would leave the
 * diff block without room; a longer one is clipped rather than dropped, since a
 * path an operator can still recognize the tail of is worth more here than the
 * few characters the clip saves.
 */
const RECONCILE_CONFIG_PATH_BUDGET = 128;

/** First-party spans a conflict line is built from, measured rather than
 *  restated wherever the budget arithmetic needs their cost. */
const RECONCILE_LINE_PREFIX = "  - ";
const RECONCILE_LINE_EXISTING = ": existing ";
const RECONCILE_LINE_INCOMING = " vs required ";

/**
 * Explains a line whose two sides read alike -- what a pair differing only
 * inside redacted or clipped bytes comes to -- once for the block rather than
 * once per line.
 *
 * Both sides are still shown as they fitted, rather than the second being
 * replaced by fixed text saying it matched the first: what the two sides DO
 * share is the operator's whole reading of a value the display cannot show them,
 * and a standin deletes it from the side that could have carried it. Its cost is
 * taken out of the block's budget before the values are re-fitted against it, so
 * saying this never costs the line that needed it.
 */
const RECONCILE_WITHHELD_NOTE =
  "  (two sides that read alike differ only inside what this display withheld: " +
  "bytes redacted as private-key material, or clipped for length)";

/**
 * Explains a line the block named without its values, so a bare field name does
 * not read as a field with nothing to say about it -- beside lines that carry
 * both their values, or as the whole block when the room reaches no line's.
 *
 * States the reason a line came to that, which is why it is one notice rather
 * than one per shape: what the block ran out of is room against the WIDTH the
 * values asked for, whether that was one wide line among short ones or a field
 * list long enough to leave nothing for any of them. Truncation eats conflict
 * detail here, which is the whole point of composing the recovery step ahead of
 * this block (see {@link reconcileConflictMessage}).
 */
const RECONCILE_NAMED_ONLY_NOTE =
  "  (a field named above without its values has values too wide for the room " +
  "this message has left; every line names a field whose values differ)";

/**
 * The most the notices below a block can cost it, which is what the last layout
 * pass reserves so it cannot need more than it was given.
 */
const RECONCILE_NOTICE_RESERVE_CEILING = renderedDisplayCost(
  `\n${RECONCILE_NAMED_ONLY_NOTE}\n${RECONCILE_WITHHELD_NOTE}`,
);

/**
 * Render a list of {@link ReconcileDiff} as an indented, human-readable block
 * for a reconciliation error message, fitted so its rendered cost at the display
 * boundary is at most `budget`.
 *
 * Both sides of every line carry bytes somebody else chose -- the invitation's
 * linkage field and key names, its rule-set citation and legal-agreement
 * reference, and (for an online split accept) the inviter's own
 * `inbound_path`/`outbound_path` from the connection endpoint -- and each has
 * already been redacted and delimited by the producer that composed it
 * ({@link reconcileDiffValue}). They are interpolated RAW: the display boundary
 * escapes the whole message once where it is shown. That is also why the `\n`
 * this block separates its lines with is structure only the block can place --
 * the escape renders it and a value's own line break alike, and the treatment at
 * the seam is what leaves the rendered token unshared.
 *
 * What this adds is the LENGTH half. The schema bounds those values by code
 * point, which is not a display bound -- one code point escapes to as many as
 * ten characters -- and it bounds a name list at 256 entries, so a single
 * conflict line can render past the whole budget the renderer gives the one link
 * this message is. The budget is therefore shared out, and shared out by NEED:
 * every line is charged the first-party skeleton it is named by, each side is
 * measured at what it would actually render to, and what a short value does not
 * take is available to the long value beside it. A constraint then falls only on
 * the sides too wide for the room -- eight ordinary disagreements are eight
 * lines carrying both their values, however many of them there are, because
 * counting them was never what decided it. A slot whose side is a clause of
 * several values shares its slot out among those values by the same rule
 * ({@link reconcileClause}), so what a slot too small to hold everything
 * degrades is a value rather than the clause structure standing behind it.
 *
 * Where a side cannot be given the least it can read as -- a delimited run
 * showing some of its own bytes, or a clause showing some of every value it
 * names inside its own connectives -- that LINE names its field and drops both
 * values, and a first-party notice under the block says so. Degrading the line
 * whole is what keeps the alternative off the message: a clause cut back to a
 * column of truncation markers, or to a name with the connective and the second
 * half deleted behind it. Every disagreeing field is named whatever becomes of
 * its values, because a field an operator is never told about is a difference
 * they cannot go and resolve.
 *
 * The cut lands wherever `budget` falls, and where that is inside a delimited
 * run it cuts the value and delimits what it kept, marker inside
 * ({@link fitToRenderedCostClosingRuns}). So the runs a fitted line shows are
 * the runs this composition placed, at every budget and every value width: a
 * value cannot be sized to land the cut where its own bytes would take over the
 * closing of a run, and nothing composed after a cut value -- the clause's next
 * value, the other side of the line -- can be read at a run parity it was not
 * composed at. That is held by a check over the rendered lines rather than by
 * this paragraph (`apps/cli/test/unit/config.test.ts`).
 *
 * One property is recorded rather than closed: the marker is plain ASCII the
 * escape passes through, and it stands inside the cut value's own run, which is
 * where a value spelling its text would put it -- so a value can claim a cut
 * that did not happen. What an operator can rely on is the marker's ABSENCE.
 *
 * @internal exported for testing; `reconcileConflictMessage` is the caller.
 */
export function formatReconcileDiffs(
  diffs: ReconcileDiff[],
  budget: number,
): string {
  if (diffs.length === 0) return "";

  const nameOnly = (d: ReconcileDiff): string =>
    `${RECONCILE_LINE_PREFIX}${d.field}`;
  // Charged with the line break that follows it, which the display escape widens
  // like any other control character rather than carrying at its own width. Its
  // field name is what a line costs even after its values are dropped, so it is
  // taken off the top rather than shared out.
  const nameCost = diffs.reduce(
    (total, d) => total + renderedDisplayCost(`${nameOnly(d)}\n`),
    0,
  );
  // What a line pays on top of its name for carrying values at all.
  const valueSkeletonCost = renderedDisplayCost(
    `${RECONCILE_LINE_EXISTING}${RECONCILE_LINE_INCOMING}`,
  );

  // A side that composed no fit is ONE delimited run, which asks for its own
  // width and cannot go below what shows any of its bytes.
  const sideOf = (
    side: CompatibilityMessageFragment,
    fit: ReconcileSideFit | undefined,
  ): ReconcileSideFit =>
    fit ?? {
      need: renderedDisplayCost(side),
      minimum: RECONCILE_MIN_VALUE_BUDGET,
      fit: (slot: number): string => fitToRenderedCostClosingRuns(side, slot),
    };
  // A side already narrower than its own floor asks for its width, not the
  // floor: it renders whole at what it asked for.
  const floorOf = (side: ReconcileSideFit): number =>
    Math.min(side.need, side.minimum);
  const lines = diffs.map((d) => {
    const existing = sideOf(d.existing, d.fit?.existing);
    const incoming = sideOf(d.incoming, d.fit?.incoming);
    return {
      diff: d,
      existing,
      incoming,
      floor: valueSkeletonCost + floorOf(existing) + floorOf(incoming),
    };
  });

  const layOut = (reserved: number): { block: string; noticeCost: number } => {
    const pool = budget - reserved - nameCost;
    // Cheapest first, which shows values on as many lines as the room admits;
    // ascending order also means the first line that does not fit settles every
    // line behind it, each of which asks for at least as much.
    const shown = new Set<number>();
    let claimed = 0;
    for (const index of lines
      .map((_, position) => position)
      .sort((a, b) => lines[a].floor - lines[b].floor)) {
      if (claimed + lines[index].floor > pool) break;
      shown.add(index);
      claimed += lines[index].floor;
    }

    // Every shown side holds its floor, and what is left over is shared out
    // among the sides that asked for more than one by the same need-aware rule.
    const shownLines = lines.filter((_, index) => shown.has(index));
    const surplus = allocateByNeed(
      shownLines.flatMap((line) => [
        line.existing.need - floorOf(line.existing),
        line.incoming.need - floorOf(line.incoming),
      ]),
      pool - claimed,
    );

    let withheld = false;
    let dropped = 0;
    let position = 0;
    const rendered = lines.map((line, index) => {
      if (!shown.has(index)) {
        dropped += 1;
        return nameOnly(line.diff);
      }
      const existing = line.existing.fit(
        floorOf(line.existing) + surplus[position * 2],
      );
      const incoming = line.incoming.fit(
        floorOf(line.incoming) + surplus[position * 2 + 1],
      );
      position += 1;
      if (existing === incoming) withheld = true;
      return (
        `${nameOnly(line.diff)}${RECONCILE_LINE_EXISTING}${existing}` +
        `${RECONCILE_LINE_INCOMING}${incoming}`
      );
    });

    const notices: string[] = [];
    if (dropped > 0) notices.push(RECONCILE_NAMED_ONLY_NOTE);
    if (withheld) notices.push(RECONCILE_WITHHELD_NOTE);
    return {
      block: [...rendered, ...notices].join("\n"),
      noticeCost: notices.reduce(
        (total, notice) => total + renderedDisplayCost(`\n${notice}`),
        0,
      ),
    };
  };

  // A notice's own cost comes out of the values' share rather than out of the
  // budget the layout already spent, so the explanation cannot be what pushes
  // the block past its bound. Which notices a layout needs is only known once it
  // is laid out, so a layout needing more than it reserved is laid out again
  // under what it needed; the last reservation is the most any layout can need,
  // which is what settles this rather than a further pass.
  let reserved = 0;
  let attempt = layOut(reserved);
  if (attempt.noticeCost > reserved) {
    reserved = attempt.noticeCost;
    attempt = layOut(reserved);
  }
  if (attempt.noticeCost > reserved)
    attempt = layOut(RECONCILE_NOTICE_RESERVE_CEILING);
  // The arithmetic above holds the block inside `budget` for every shape reached
  // today, which a test pins by asserting no line of a worst-case message is
  // cut. This is the backstop under it: a producer that adds a wider first-party
  // skeleton, or a field-name list past what the notices can absorb, is bounded
  // here rather than silently spending the recovery step's room.
  return fitToRenderedCostClosingRuns(attempt.block, budget);
}

/**
 * The refusal `psilink accept` raises when a pre-existing configuration
 * disagrees with the invitation (and, online, the connection URL): what
 * disagreed, and what the operator does about it, composed to one display link.
 *
 * The recovery step is composed AHEAD of the diff block, and this is the whole
 * reason the composition lives here rather than at the throw site. The display
 * boundary caps a link at {@link COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH} and drops
 * the tail, so whatever is last is what a cut deletes -- and the step the
 * operator has to act on is the one part of this message they cannot reconstruct
 * from their own config. Putting the conflict detail last makes truncation eat
 * detail, which they can go and read in the two documents themselves.
 *
 * The budget is then partitioned by WHO CHOSE THE BYTES, the discipline the SFTP
 * host-key refusals apply for the same reason: first-party copy is measured
 * where it stands, the operator's own configuration path is fitted to
 * {@link RECONCILE_CONFIG_PATH_BUDGET}, and the diff block is handed exactly
 * what remains ({@link formatReconcileDiffs}), inside which each chooser's
 * values get an equal share. So no chooser can spend a budget that is not their
 * own, and the fixed copy's own fit is held by measurement -- pinned by a test
 * that fails if this message's copy grows past what the cap admits.
 *
 * `against` and `retryWith` are the caller's first-party copy naming what the
 * configuration was compared against and how to retry; they are measured here
 * rather than assumed, so the block's share follows the wording rather than a
 * restatement of it.
 *
 * The path takes the block's per-value treatments in the block's own order --
 * redacted, then its control characters replaced, then fitted -- though it is the
 * operator's own value rather than a chooser this message defends against. The
 * uniformity is the point: "this fragment is the operator's, so it may keep a
 * line break" is a premise about provenance that no check holds and a later
 * caller silently breaks, and treating it costs a path that has none nothing.
 */
export function reconcileConflictMessage(params: {
  configPath: string;
  against: string;
  retryWith: string;
  diffs: ReconcileDiff[];
}): string {
  const { against, retryWith, diffs } = params;
  const configPath = clipToRenderedCost(
    replaceControlCharactersForDisplay(
      redactPrivateKeyMaterial(params.configPath),
    ),
    RECONCILE_CONFIG_PATH_BUDGET,
  );
  const head =
    `the configuration file at ${configPath} disagrees with ${against}. ` +
    `Resolve the differences below (or pass --config-file to write elsewhere), ` +
    `then retry with ${retryWith}. The differences:\n`;
  return (
    head +
    formatReconcileDiffs(
      diffs,
      Math.max(
        0,
        COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH - renderedDisplayCost(head),
      ),
    )
  );
}

// --- Config writer -----------------------------------------------------------

/**
 * Serialize an {@link ExchangeSpec} and write it to `configPath` as snake_case
 * YAML, owner-read-only -- a config may carry an SFTP credential: a literal
 * `server.password`/`server.privateKey` is a secret at rest, while an `@path`-
 * supplied one is preserved as the reference, not inlined. Either way it gets the
 * same `0600` / ACL protection as the key file via {@link writeFileOwnerOnly}.
 *
 * The shared secret and its expiration live only in the key file and never belong
 * in the config; they are stripped from the top-level `authentication` block here
 * even if a caller leaves them populated, so the secret cannot be duplicated onto
 * disk (and cannot go stale after token rotation). The caller's spec is not
 * mutated.
 *
 * Does not guard against overwriting an existing file; callers provision through
 * `provisionConfigAndKey`, which runs the conflict gate first.
 */
export function saveConfig(configPath: string, spec: ExchangeSpec): void {
  const sanitized = structuredClone(spec);
  const auth = sanitized.authentication;
  if (auth) {
    delete auth.sharedSecret;
    delete auth.expires;
    // Drop the container if those were its only keys, so the config carries no
    // noisy empty `authentication: {}` block. Operator-policy fields (e.g.
    // token_max_age_days) keep it non-empty when present.
    if (Object.keys(auth).length === 0) delete sanitized.authentication;
  }
  writeFileOwnerOnly(configPath, YAML.stringify(snakeizeKeys(sanitized)));
}

/**
 * Write (or overwrite) `connection.server.host_key_fingerprint` in an existing
 * `psilink.yaml`, used to persist a host-key pin established interactively on
 * first use. Unlike {@link saveConfig}, which re-serializes the whole spec, this
 * edits the file in place through the YAML document model so the operator's
 * comments, key order, and formatting survive -- the config is a hand-authored,
 * commented file, and a first-use pin should add one field, not rewrite it.
 *
 * The pin is a non-secret public fingerprint, but the file is rewritten with the
 * same owner-only permissions {@link saveConfig} uses (a config may carry an SFTP
 * credential). The fingerprint key is written snake_case to match the on-disk
 * convention. Throws if the file cannot be read or parsed -- the caller has just
 * loaded the same file, so a failure here is unexpected and must not be silently
 * swallowed (it would leave the operator believing the pin was saved).
 *
 * Fails closed on a non-sftp config: a host-key fingerprint is an sftp-only pin
 * (`connection.server` is the sftp shape), so a `connection.channel` other than
 * `sftp` is rejected with a {@link UsageError} before anything is written
 * (config.test.ts, "persistHostKeyFingerprint rejects a non-sftp config and
 * leaves the file untouched"). The sole caller {@link establishHostKeyTrust}
 * returns off sftp before reaching it (hostKeyTrust.test.ts, "is a no-op for a
 * non-sftp channel"), so the guard holds the invariant at the function itself,
 * for a direct caller that would otherwise synthesize a bogus pin and a `server`
 * mapping a filedrop/webrtc schema does not expect.
 */
export function persistHostKeyFingerprint(
  configPath: string,
  fingerprint: string,
): void {
  // Parse, edit, and re-serialize through the sensitive-file chokepoint, which
  // closes the syntax-error, deferred-alias, and warning leak channels in one
  // place and keeps the live document inside that module (see sensitiveFile.ts).
  // The document model preserves the operator's comments and key order on this
  // surgical one-field write.
  const serialized = editSensitiveYamlDocument(
    fs.readFileSync(configPath, "utf8"),
    `config file ${configPath}`,
    (doc) => {
      // Read the channel discriminant off the parsed document (not a
      // schema-loaded spec) and reject anything but sftp before the write, so
      // the function -- not its caller -- holds the sftp-only invariant. The
      // channel is a non-secret discriminant; echo it (sanitized for display,
      // as the rest of this trust flow treats config-derived values -- see
      // hostKeyTrust.ts) so the operator sees which channel was rejected. A
      // missing or non-scalar channel is reported generically rather than
      // echoed. getIn does not resolve aliases, so an alias-spelled channel (or
      // an aliased connection block) reads as a non-string node and is rejected
      // even when it would resolve to sftp -- the safe direction (refuse, not
      // mis-pin), and not a form a hand-authored config uses. Resolving it
      // would mean materializing the document, which this module avoids.
      const channel = doc.getIn(["connection", "channel"]);
      if (channel !== "sftp") {
        const found =
          typeof channel === "string" ? `"${channel}"` : "absent or non-scalar";
        throw new UsageError(
          `config file ${configPath} has a non-sftp connection.channel ` +
            `(${found}); a host-key fingerprint is an sftp-only pin and must ` +
            `not be written to a non-sftp config.`,
        );
      }
      // setIn creates the connection/server path nodes if absent; for an sftp
      // config loaded by the exchange command they already exist, so this updates
      // the one field. snake_case path matches the written convention (see
      // saveConfig). A config that parses but whose `connection`/`server` is a
      // scalar or sequence (not a mapping) makes setIn throw a YAML error naming
      // the path key (not a value), so it is safe to surface as the UsageError
      // this function's contract promises (mapped to exit 64) rather than an
      // opaque library stack trace. On the exchange call path the schema load has
      // already rejected such a shape, so this guards a hand-edit between load and
      // write, or a caller that skips validation.
      try {
        doc.setIn(
          ["connection", "server", "host_key_fingerprint"],
          fingerprint,
        );
      } catch (err) {
        throw new UsageError(
          `config file ${configPath} could not be updated to persist the ` +
            `host-key fingerprint (${err instanceof Error ? err.message : String(err)}); ` +
            `connection.server must be a mapping.`,
        );
      }
    },
  );
  writeFileOwnerOnly(configPath, serialized);
}

/**
 * Write, overwrite, or remove the top-level `disclosed_payload_columns` in an
 * existing `psilink.yaml`. This is the SEND-side disclosure commitment (this
 * party's own column namespace): the set it published on the invitation it just
 * (re-)minted, which a later recurring `psilink exchange` verifies its current
 * metadata still discloses ({@link assertDisclosureMatchesCommitment} in core).
 *
 * Used by the offline invite-from-config / re-invite path, which reuses the
 * operator's existing config rather than rewriting it. Like
 * {@link persistHostKeyFingerprint} -- and unlike {@link saveConfig}, which
 * re-serializes the whole spec and would strip comments -- this edits the file in
 * place through the YAML document model so the operator's comments, key order, and
 * formatting survive: the commitment is one machine-managed field, not operator
 * prose. Binding this write to every (re-)mint is what keeps the commitment from
 * going stale relative to the token the partner locked in (a re-invite over
 * drifted metadata refreshes it here; an exchange with no re-invite keeps the
 * prior commitment and fails fast on drift).
 *
 * `columns === undefined` REMOVES the field (deleteIn), never leaves a stale value:
 * a config whose metadata is unknown at mint publishes no disclosed subset (the
 * acceptor reconciles lazily), so any commitment previously recorded must be
 * cleared rather than silently retained. An empty array is written verbatim -- a
 * strict "disclose nothing" commitment, distinct from absent.
 *
 * The columns are this party's own (metadata-derived), non-secret, but the file is
 * rewritten with the same owner-only permissions {@link saveConfig} uses (a config
 * may carry an SFTP credential). The key is written snake_case to match the
 * on-disk convention. Throws if the file cannot be read or parsed -- the caller
 * has just read the same file, so a failure here is unexpected and must not be
 * silently swallowed (it would leave the operator believing the commitment was
 * recorded).
 */
export function persistDisclosedPayloadColumns(
  configPath: string,
  columns: string[] | undefined,
): void {
  // Parse, edit, and re-serialize through the sensitive-file chokepoint (see
  // persistHostKeyFingerprint), preserving the operator's comments and key order
  // on this surgical one-field write.
  const serialized = editSensitiveYamlDocument(
    fs.readFileSync(configPath, "utf8"),
    `config file ${configPath}`,
    (doc) => {
      if (columns === undefined) {
        // No commitment on record for this mint: remove any stale field rather
        // than leave a value the current metadata no longer backs.
        doc.deleteIn(["disclosed_payload_columns"]);
        return;
      }
      // createNode turns the JS array into a proper YAML sequence node (a bare
      // value is not reliably wrapped by setIn across versions); setIn creates or
      // overwrites the single top-level key, leaving everything else untouched.
      doc.setIn(["disclosed_payload_columns"], doc.createNode(columns));
    },
  );
  writeFileOwnerOnly(configPath, serialized);
}

/**
 * Write, overwrite, or remove the top-level `expected_payload_columns` in an
 * existing `psilink.yaml`. This is the RECEIVE-side consent lock-in (the
 * PARTNER's column namespace): the disclosed subset the operator consented to on
 * the acceptance it just made, which a later recurring `psilink exchange` holds
 * the received payload to ({@link reconcileReceivedPayload} in core).
 *
 * Used by both accept-reuse paths -- offline, and the online hook's reuse
 * branch -- which keep the operator's existing config rather than rewriting
 * it. Like {@link persistDisclosedPayloadColumns}
 * -- its send-side twin -- and unlike {@link saveConfig}, which re-serializes the
 * whole spec and would strip comments, this edits the file in place through the
 * YAML document model so the operator's comments, key order, and formatting
 * survive: the lock-in is one machine-managed field, not operator prose. Binding
 * this write to the accept-reuse path is what keeps the consent record from going
 * stale relative to what the operator consented to on the latest acceptance (a
 * re-accept over a changed disclosed set refreshes it here; an exchange with no
 * re-accept keeps the prior lock-in).
 *
 * `columns === undefined` REMOVES the field (deleteIn), never leaves a stale
 * value: an acceptance whose invitation carried no disclosed subset (an older or
 * metadata-unknown mint) records no consented set (the exchange reconciles
 * lazily), so any lock-in previously recorded must be cleared rather than
 * silently retained. An empty array is written verbatim -- a strict "receive
 * nothing" consent, distinct from absent.
 *
 * The columns are the partner's (token-derived), non-secret, but the file is
 * rewritten with the same owner-only permissions {@link saveConfig} uses (a
 * config may carry an SFTP credential). The key is written snake_case to match
 * the on-disk convention. Throws if the file cannot be read or parsed -- the
 * caller has just reconciled the same file, so a failure here is unexpected and
 * must not be silently swallowed (it would leave the operator believing the
 * lock-in was refreshed).
 */
export function persistExpectedPayloadColumns(
  configPath: string,
  columns: string[] | undefined,
): void {
  // Parse, edit, and re-serialize through the sensitive-file chokepoint (see
  // persistHostKeyFingerprint), preserving the operator's comments and key order
  // on this surgical one-field write.
  const serialized = editSensitiveYamlDocument(
    fs.readFileSync(configPath, "utf8"),
    `config file ${configPath}`,
    (doc) => {
      if (columns === undefined) {
        // No consented subset on record for this acceptance: remove any stale
        // field rather than leave a value the latest consent no longer backs.
        doc.deleteIn(["expected_payload_columns"]);
        return;
      }
      // createNode turns the JS array into a proper YAML sequence node (a bare
      // value is not reliably wrapped by setIn across versions); setIn creates or
      // overwrites the single top-level key, leaving everything else untouched.
      doc.setIn(["expected_payload_columns"], doc.createNode(columns));
    },
  );
  writeFileOwnerOnly(configPath, serialized);
}

/**
 * Write, overwrite, or remove the top-level `outbound_payload_consent` in an
 * existing `psilink.yaml`. This is this party's consent to its OWN outbound set
 * (its own column namespace): the columns it confirmed it sends to the partner for
 * matched records, or the `pending` marker recorded when an acceptance could not
 * resolve them yet. A later `psilink exchange` holds the set it would actually
 * transmit to this record ({@link assertOutboundPayloadConsented} in core).
 *
 * Used by the two paths that keep an existing config rather than writing a fresh
 * one -- the accept-reuse path, and the run that resolves and confirms a `pending`
 * record in place. Like {@link persistDisclosedPayloadColumns} and
 * {@link persistExpectedPayloadColumns} -- and unlike {@link saveConfig}, which
 * re-serializes the whole spec and would strip comments -- this edits the file in
 * place through the YAML document model so the operator's comments, key order, and
 * formatting survive: the record is one machine-managed field, not operator prose.
 *
 * `consent === undefined` REMOVES the field (deleteIn), never leaves a stale
 * value: an acceptance that transmits nothing to the partner records no consent
 * (there is no disclosure to consent to), so any record from a prior acceptance
 * must be cleared rather than silently retained and later enforced against a
 * different set.
 *
 * The columns are this party's own (metadata-derived), non-secret, but the file is
 * rewritten with the same owner-only permissions {@link saveConfig} uses (a config
 * may carry an SFTP credential). The keys are written snake_case to match the
 * on-disk convention; `status` and `columns` are single words either way. Throws if
 * the file cannot be read or parsed -- the caller has just read the same file, so a
 * failure here is unexpected and must not be silently swallowed (it would leave the
 * operator believing their confirmation was recorded, and be asked again next run).
 */
export function persistOutboundPayloadConsent(
  configPath: string,
  consent: OutboundPayloadConsent | undefined,
): void {
  // Parse, edit, and re-serialize through the sensitive-file chokepoint (see
  // persistHostKeyFingerprint), preserving the operator's comments and key order
  // on this surgical one-field write.
  const serialized = editSensitiveYamlDocument(
    fs.readFileSync(configPath, "utf8"),
    `config file ${configPath}`,
    (doc) => {
      if (consent === undefined) {
        doc.deleteIn(["outbound_payload_consent"]);
        return;
      }
      // createNode turns the JS object into a proper YAML mapping node (a bare
      // value is not reliably wrapped by setIn across versions); setIn creates or
      // overwrites the single top-level key, leaving everything else untouched.
      doc.setIn(["outbound_payload_consent"], doc.createNode(consent));
    },
  );
  writeFileOwnerOnly(configPath, serialized);
}

/**
 * Write or overwrite the top-level `expected_partner_deduplicate` in an existing
 * `psilink.yaml`. This is the TERMS-side consent lock-in: the `deduplicate` the
 * accepted invitation declared for the INVITING party's own side, which a later
 * `psilink exchange` holds the value the partner presents at the terms exchange
 * to ({@link assertPresentedDeduplicateMatchesInvitation} in core), refusing a
 * contradiction before any key or payload moves.
 *
 * The terms-side twin of {@link persistExpectedPayloadColumns}, written by the
 * same accept-reuse paths -- offline, and the online hook's reuse branch -- and
 * for the same reason: they keep the operator's existing config rather than
 * rewriting it, so like the payload lock-in this edits the file in place through
 * the YAML document model, preserving comments, key order, and formatting.
 * Binding the write to the accept-reuse path is what keeps the declaration from
 * lagging the latest acceptance (a re-accept over a changed declaration refreshes
 * it here).
 *
 * Takes a plain `boolean`: an acceptance always has a declaration to record --
 * `deduplicate` is mandatory on the linkage-terms schema -- so there is no
 * removal to express. The absent field is the state of a config no acceptance
 * stands behind, reached by never writing one rather than by clearing one.
 *
 * The value is a schema boolean, not partner free text, but the file is rewritten
 * with the same owner-only permissions {@link saveConfig} uses (a config may carry
 * an SFTP credential). The key is written snake_case to match the on-disk
 * convention. Throws if the file cannot be read or parsed -- the caller has just
 * reconciled the same file, so a failure here is unexpected and must not be
 * silently swallowed (it would leave the operator believing the binding was
 * refreshed).
 */
export function persistExpectedPartnerDeduplicate(
  configPath: string,
  declared: boolean,
): void {
  // Parse, edit, and re-serialize through the sensitive-file chokepoint (see
  // persistHostKeyFingerprint), preserving the operator's comments and key order
  // on this surgical one-field write.
  const serialized = editSensitiveYamlDocument(
    fs.readFileSync(configPath, "utf8"),
    `config file ${configPath}`,
    (doc) => {
      doc.setIn(["expected_partner_deduplicate"], declared);
    },
  );
  writeFileOwnerOnly(configPath, serialized);
}

// --- Config reader -----------------------------------------------------------

/**
 * The portion of a pre-existing config that `invite` uses as the source for an
 * invitation: the linkage terms (which the invitation carries) and the explicit
 * data standardization and metadata, if any (which the config-vs-input
 * reconciliation honors so it resolves columns to linkage fields exactly as the
 * eventual exchange does), plus the one connection fact the invitation declares.
 * The connection block itself is intentionally omitted -- `invite` does not build
 * a connection from it.
 */
export interface ConfigLinkageSource {
  linkageTerms: LinkageTerms;
  /** The config's explicit `standardization` block, absent when not present. */
  standardization?: Standardization;
  /**
   * The config's explicit `metadata` block, absent when not present. Forwarded
   * to the satisfiability check so it resolves the type fallback against the same
   * column types the exchange does -- without it, a config that retypes a column
   * (e.g. names a non-standard column as an `ssn`, or types an inferred column
   * away) would be checked against name inference and could mint an invitation
   * for an input the exchange cannot actually satisfy.
   */
  metadata?: Metadata;
  /**
   * Whether the config's connection block has retain mode on
   * (`connection.options.retain_files: true`), which the minted invitation
   * declares to the partner as a consent fact -- the exchange this config runs
   * leaves a permanent transcript at the rendezvous location.
   *
   * Read as that ONE boolean at its fixed path, never by validating the
   * connection block: the block is deliberately left unparsed here so an
   * unfinished or still-placeholder one does not block generating an invitation,
   * and a single boolean read keeps that contract. Anything other than a literal
   * `true` -- absent, false, a non-boolean, no connection block at all -- reads
   * as false, which declares nothing rather than declaring delete mode, as does
   * a `webrtc` connection, a channel with no retain mode to declare.
   */
  retainsFiles: boolean;
  /**
   * Whether an acceptance stands behind the config's linkage terms, for the
   * readers that report on the citation those terms carry. Read as the single
   * presence check {@link linkageTermsStandingOf} describes, at the top-level key
   * rather than through the spec schema, for the reason `retainsFiles` is read
   * that way: the rest of the file is deliberately left unparsed here.
   */
  linkageTermsStanding: LinkageTermsStanding;
}

/**
 * What reading a config file yielded for a caller that wants its linkage terms:
 * no file at the path, a file that defines no `linkage_terms` block, or the
 * loaded source. The two absences are separate outcomes because what each one
 * means belongs to the caller -- `invite` treats a config defining no terms as a
 * broken invitation source, while `verify-receipt` reads the same file for its
 * `signing.partner_fingerprint` and proceeds without terms.
 */
export type ConfigLinkageSourceResult =
  | { status: "no-config-file" }
  | { status: "no-linkage-terms" }
  | { status: "loaded"; source: ConfigLinkageSource };

/**
 * Render a config block's schema issues as `<key path>: <reason>` clauses, so the
 * operator can locate each offending field, mirroring accept's decode-error
 * formatting. Each path is relative to the block it came from.
 *
 * `keys` says how the block was parsed, which is what decides the spelling the
 * path is named in. A block parsed through `camelizeKeys` (`camelized`) yields
 * issue paths in camelCase while the file writes those keys in snake_case, so
 * each segment is put back through {@link snakeizeKey} -- the same rewrite
 * {@link saveConfig}'s writer uses -- and the message names the key the file
 * contains. A block whose schema parses the on-disk form directly (`as-written`)
 * is named verbatim: its paths already carry the file's own spelling, and a
 * rewrite there would mis-name a free-form key the operator spelled with capitals
 * of their own.
 *
 * A camelized path STOPS at a `params` segment, naming the block and not the key
 * inside it. That rewrite is exact only for a key the camelize pass built, and
 * the one free-form record the schema carries -- a transform's `params` -- holds
 * the author's own key: the camelized `EvilKey` is what a file writing either
 * `_evil_key` or `EvilKey` arrives as, so the two on-disk spellings are no longer
 * distinguishable here and naming either one names a key some file does not
 * contain. Everything before the segment is fixed schema structure, which is what
 * still locates the problem. The web importer's terms reader truncates the same
 * path for its own reason (that key can be partner-supplied and its contract is
 * value-free); an unbounded free-form key is also the one fragment here that
 * could spend a whole rendered link on its own.
 */
function describeSchemaIssues(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
  keys: "camelized" | "as-written",
): string {
  return issues
    .map((issue) => {
      const paramsIndex =
        keys === "camelized" ? issue.path.indexOf("params") : -1;
      const path =
        paramsIndex >= 0 ? issue.path.slice(0, paramsIndex + 1) : issue.path;
      // A Zod issue path is PropertyKey[], and Array.join throws a TypeError on a
      // symbol segment where String() renders it, so this map is a guard rather
      // than a redundant coercion: an error-formatting path must not fail while
      // reporting.
      const segments = path.map((segment) =>
        keys === "camelized" ? snakeizeKey(String(segment)) : String(segment),
      );
      const at = segments.length > 0 ? `${segments.join(".")}: ` : "";
      return `${at}${issue.message}`;
    })
    .join("; ");
}

/**
 * Read the linkage-terms source from a config file, reporting a missing file and
 * a config that defines no `linkage_terms` as distinct outcomes instead of one
 * absence and one throw, so each caller attributes them in its own terms.
 *
 * Only the `linkage_terms`, `standardization`, and `metadata` blocks are parsed
 * and validated. The connection block is deliberately not among them, so a
 * still-placeholder or otherwise unfinished one does not fail the read.
 *
 * Every other defect -- a file that exists but cannot be read, YAML that is not
 * a mapping, an invalid `linkage_terms`, `standardization`, or `metadata` block
 * -- is a {@link UsageError}: a config present at the path is treated as
 * intentional, so a broken one is surfaced for the user to fix. Mirrors
 * {@link saveConfig}'s snake_case-on-disk convention -- the top-level keys are
 * read as either `linkage_terms`/`standardization` (the written form) or their
 * camelCase spellings, and `safeParseLinkageTerms` camelizes the nested keys.
 */
export function readConfigLinkageSource(
  configPath: string,
): ConfigLinkageSourceResult {
  // Read, then parse through the sensitive-file chokepoint. A read failure
  // carries only a path and errno (ENOENT means no config, not an error here); a
  // YAML parse can echo source bytes (an inline credential), so it routes through
  // parseSensitiveYaml, which reports path-only (see sensitiveFile.ts).
  let source: string;
  try {
    source = fs.readFileSync(configPath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { status: "no-config-file" };
    throw new UsageError(
      `config file ${configPath} could not be read: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  const raw = parseSensitiveYaml(source, `config file ${configPath}`);

  // A top-level YAML mapping is required. Exclude an array (also
  // `typeof === "object"`) and a scalar explicitly, so a malformed config is
  // reported as such rather than misattributed to a missing `linkage_terms`
  // block (an array has no such key, so it would otherwise fall through below).
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new UsageError(
      `config file ${configPath} is not a valid configuration object ` +
        "(expected a YAML mapping at the top level)",
    );
  const obj = raw as Record<string, unknown>;
  const rawTerms = obj["linkage_terms"] ?? obj["linkageTerms"];
  if (rawTerms === undefined) return { status: "no-linkage-terms" };

  const result = safeParseLinkageTerms(rawTerms);
  if (!result.success)
    throw new UsageError(
      `config file ${configPath} has invalid linkage_terms: ` +
        describeSchemaIssues(result.error.issues, "camelized"),
    );

  // The explicit standardization is optional. Its `output`/`input`/`steps` keys
  // are single words (snake == camel) and `params` is free-form, so the schema
  // parses the on-disk form without camelizing. An invalid block is surfaced as
  // a usage error, like invalid linkage_terms above.
  const rawStd = obj["standardization"];
  let standardization: Standardization | undefined;
  if (rawStd !== undefined) {
    const stdResult = StandardizationSchema.safeParse(rawStd);
    if (!stdResult.success)
      throw new UsageError(
        `config file ${configPath} has invalid standardization: ` +
          describeSchemaIssues(stdResult.error.issues, "as-written"),
      );
    standardization = stdResult.data;
  }

  // The explicit metadata is optional. safeParseMetadata camelizes the on-disk
  // snake_case keys (e.g. `is_payload`) before validating, like linkage_terms
  // above. An invalid block is surfaced as a usage error rather than silently
  // dropped, so the satisfiability check cannot fall back to name inference on a
  // config the operator believes types its columns explicitly.
  const rawMetadata = obj["metadata"];
  let metadata: Metadata | undefined;
  if (rawMetadata !== undefined) {
    const metaResult = safeParseMetadata(rawMetadata);
    if (!metaResult.success)
      throw new UsageError(
        `config file ${configPath} has invalid metadata: ` +
          describeSchemaIssues(metaResult.error.issues, "camelized"),
      );
    metadata = metaResult.data;
  }

  return {
    status: "loaded",
    source: {
      linkageTerms: result.data,
      standardization,
      metadata,
      retainsFiles: readRetainFilesDeclaration(obj),
      linkageTermsStanding: readLinkageTermsStanding(obj),
    },
  };
}

/**
 * The standing of a loaded config's terms, read from the presence of a top-level
 * `expected_partner_deduplicate` at its fixed key so the rest of the file stays
 * unparsed here (the reason {@link readRetainFilesDeclaration} reads its own key
 * that way). Both spellings are accepted for the reason the top-level keys above
 * accept both: `saveConfig` writes snake_case, but a hand-authored config may
 * carry either.
 *
 * Presence alone decides it, on {@link linkageTermsStandingOf}'s rule that the
 * record says an acceptance happened rather than what was agreed. `psilink
 * accept` writes only a boolean, so any other value is an operator's edit of a
 * machine-written record -- but the record still stands there, and reading it as
 * an acceptance is what points that operator at settling the citation with their
 * partner rather than at rewriting terms both parties hold. A value the strict
 * paths refuse is refused there, by core's schema, on the commands that build an
 * exchange from the file.
 */
function readLinkageTermsStanding(
  obj: Record<string, unknown>,
): LinkageTermsStanding {
  const declared =
    obj["expected_partner_deduplicate"] ?? obj["expectedPartnerDeduplicate"];
  return declared === undefined ? "held-alone" : "accepted-with-partner";
}

/**
 * The config's `connection.options.retain_files`, read as a single boolean at its
 * fixed path so a still-placeholder connection block is not validated on the way
 * (see {@link ConfigLinkageSource.retainsFiles}). Both key spellings are accepted
 * for the same reason the top-level keys above are: `saveConfig` writes
 * snake_case, but a hand-authored config may carry either.
 *
 * Only a literal `true` reads as a declaration. Every other shape -- absent,
 * false, a non-boolean, a non-object `connection` or `options` -- yields false,
 * which the invitation carries as no declaration at all rather than as a claim
 * that the exchange deletes its files.
 *
 * A `webrtc` connection declares nothing whatever its options say: retain mode is
 * a file-sync setting the webrtc channel does not have, and the channel check
 * below is the gate that keeps it off a partner's consent screen -- not a
 * downstream schema refusal. `ConnectionConfigSchema` does not refuse the pair: a
 * webrtc connection's `options` parses through `SharedOptionsSchema`, which
 * declares no `retainFiles` field, so the value is silently dropped rather than
 * rejected, and a hand-authored config pairing `channel: webrtc` with
 * `options: {retain_files: true}` loads successfully and runs in delete mode.
 * What blocks the pairing at psilink's own authoring sites -- `saveConfig` and
 * every other in-repo writer of a webrtc connection -- is the type system, not a
 * runtime check: `WebRTCConnectionConfig.options` is typed `SharedOptions`, which
 * has no `retainFiles` member. That protection does not reach a hand-authored
 * file, which is what this function's own gate is for.
 */
function readRetainFilesDeclaration(config: Record<string, unknown>): boolean {
  const connection = config["connection"];
  if (connection === null || typeof connection !== "object") return false;
  const block = connection as Record<string, unknown>;
  if (block["channel"] === "webrtc") return false;
  const options = block["options"];
  if (options === null || typeof options !== "object") return false;
  const entry = options as Record<string, unknown>;
  return entry["retain_files"] === true || entry["retainFiles"] === true;
}

/**
 * The linkage-terms source for `invite`'s config-as-source path: the config named
 * at `configPath`, or `undefined` when no file exists there (the caller then falls
 * back to inferring terms from an input file).
 *
 * A config present at the path is the authoritative source of the invitation's
 * linkage terms, so one that defines none cannot serve as that source and is a
 * {@link UsageError} rather than a silent fall-through to input inference.
 * `invite` builds no connection from the block (the config persists for a later
 * `psilink exchange` to read and validate), so an unfinished one must not block
 * generating an invitation -- {@link readConfigLinkageSource}, which carries the
 * rest of the reading contract, leaves it unvalidated and takes from outside the
 * terms only the `retain_files` boolean the invitation declares and the
 * `expected_partner_deduplicate` record the terms' standing is read from.
 */
export function loadConfigLinkageSource(
  configPath: string,
): ConfigLinkageSource | undefined {
  const result = readConfigLinkageSource(configPath);
  if (result.status === "no-config-file") return undefined;
  if (result.status === "no-linkage-terms")
    throw new UsageError(
      `config file ${configPath} has no linkage_terms and cannot be used as ` +
        "the source for an invitation; supply an input file or a configuration " +
        "that defines linkage terms",
    );
  return result.source;
}

// --- Rule-set citation drift -------------------------------------------------

/**
 * One half of a rule-set citation -- a set's name and content version -- for the
 * drift warning, which names a half on its own wherever it reports on that half
 * alone.
 *
 * The names are free text whoever authored the config chose, and a `log.warn` is
 * their sink (a value that never becomes an `Error` is escaped at the call site
 * that shows it), so each is escaped here. The pair then renders through core's
 * terms-value seam ({@link ruleSetCitation}) -- the same grammar core's own
 * rule-set mismatch message and both consent surfaces use -- which is what makes
 * the name's boundaries readable, the escape having preserved every printable
 * ASCII character a name could forge the clause's structure with.
 *
 * Escaping BEFORE delimiting, not after: the escape truncates its output, and a
 * truncation applied to an already-delimited run could take the closing
 * delimiter off it.
 */
function describeRuleSetHalf(identity: LinkageSetIdentity): string {
  return ruleSetCitation(
    redactAndSanitizeForDisplay(identity.name),
    redactAndSanitizeForDisplay(identity.version),
  );
}

/**
 * A rule-set citation as one clause, keys first -- the keys are the specific
 * artifact and the fields the substrate they are built from -- matching the
 * order the invitation display and core's mismatch message render the pair in.
 */
function describeRuleSetCitation(reference: LinkageRuleSetReference): string {
  return (
    `${describeRuleSetHalf(reference.keySet)} over ` +
    `${describeRuleSetHalf(reference.fieldSet)}`
  );
}

/**
 * Whether an acceptance stands behind a config's linkage terms, which is what
 * decides the remedy the drift warning can honestly offer for the citation those
 * terms carry.
 *
 * - `held-alone` -- no acceptance stands behind them, so they bind this party
 *   only and both remedies are open: drop a citation the rules no longer earn,
 *   or put the cited set's rules back.
 * - `accepted-with-partner` -- an acceptance put them under agreement with an
 *   inviting party, whether by adopting that party's terms verbatim onto a fresh
 *   config or by reconciling a kept one against the invitation. Editing the
 *   rules to match the citation would take them out of that agreement, and the
 *   exchange would refuse them against the partner still running the originals.
 */
export type LinkageTermsStanding = "held-alone" | "accepted-with-partner";

/**
 * What a command can offer its operator besides settling a drifted citation with
 * the party whose acceptance stands behind the terms. Only the
 * `accepted-with-partner` reading takes it: terms no acceptance stands behind
 * are the operator's own either way.
 *
 * - `decline-to-reuse` -- the command is putting the agreed terms to use
 *   (accepting against them, running an exchange on them, verifying a receipt
 *   with them), so the operator can leave them and start from terms that carry
 *   no claim they cannot support.
 * - `author-fresh-terms` -- the command is minting an invitation FROM those
 *   terms, where declining to reuse them is not the choice on offer: the
 *   operator is authoring a new document and can author its terms instead of
 *   carrying the accepted ones onto it.
 */
export type CitationDriftAlternative =
  "decline-to-reuse" | "author-fresh-terms";

/**
 * Whether an acceptance stands behind a loaded config's linkage terms, read from
 * `expected_partner_deduplicate`. `psilink accept` records the invitation's
 * declared partner cardinality on every config it writes AND on every config it
 * reuses, and nothing else writes one, so its presence is exactly the mark of a
 * config an acceptance stands behind. That the absent field is the state of a
 * config no acceptance stands behind is
 * {@link persistExpectedPartnerDeduplicate}'s own contract, which this reads
 * rather than restates.
 *
 * Both of its values read the same way: the record says an acceptance happened,
 * not what was agreed.
 */
export function linkageTermsStandingOf(
  spec: Pick<ExchangeSpec, "expectedPartnerDeduplicate">,
): LinkageTermsStanding {
  return spec.expectedPartnerDeduplicate === undefined
    ? "held-alone"
    : "accepted-with-partner";
}

/**
 * Warn when a loaded config's `linkage_terms.linkage_rule_set` cites a set this
 * build ships over rules that are not drawn from it: the state a hand edit to
 * `linkage_fields` or `linkage_keys` leaves behind, since nothing on the CLI
 * re-decides the citation the config was written with. Left unreported, that
 * citation travels onto the invitation and into both parties' exchange records
 * claiming a provenance the rules no longer have.
 *
 * Only a half this build can RESOLVE is judged. A citation naming a set psilink
 * does not ship states nothing checkable here -- there is no content behind the
 * name to compare the rules against -- so that half is passed over, and a
 * citation whose halves both name a foreign set reports nothing at all. The two
 * halves are resolved separately for the reason the design names and versions
 * them separately: pairing one built-in name with a foreign one must not buy the
 * built-in half a pass it could not earn alone.
 *
 * Warns rather than refuses. The config is the operator's own file, the citation
 * is display-and-record only (it never selects or alters matching), and the
 * exchange that follows is the one the declared fields and keys describe either
 * way -- so this reports a claim that has drifted from its rules, and the command
 * proceeds.
 *
 * `standing` decides the remedy, because the two cases have different ones to
 * offer (see {@link LinkageTermsStanding}). Terms an acceptance stands behind are
 * agreed with the inviting party: telling that operator to restore the cited
 * set's rules would edit terms both parties already hold, and the exchange would
 * then abort against the partner that still runs the originals -- so that
 * reading offers settling the citation with that party, and does not address the
 * operator as the author of either side. `alternative` names what that operator
 * can do instead of settling, which is the command's to say rather than this
 * function's: the wording is one source here, and only the tail varies (see
 * {@link CitationDriftAlternative}).
 *
 * Each drifted half is reported against the set that half cites, never against
 * "the citation": only a resolvable half is judged, so a citation pairing a
 * built-in half with a foreign one would otherwise read as though this build
 * shipped the foreign half too.
 */
export function warnOnLinkageRuleSetCitationDrift(
  terms: Pick<LinkageTerms, "linkageRuleSet" | "linkageFields" | "linkageKeys">,
  configPath: string,
  log: { warn: (message: string) => void },
  standing: LinkageTermsStanding,
  alternative: CitationDriftAlternative,
): void {
  const cited = terms.linkageRuleSet;
  if (cited === undefined) return;

  const shipped = DEFAULT_LINKAGE_RULE_SET;
  const namesShippedSet = (
    citedHalf: LinkageSetIdentity,
    shippedHalf: LinkageSetIdentity,
  ): boolean =>
    citedHalf.name === shippedHalf.name &&
    citedHalf.version === shippedHalf.version;

  // Each half is judged on its own by handing the predicate that half's shipped
  // declarations over rules that carry nothing on the other side. An empty list
  // runs neither of the predicate's two loops, so the half not under test cannot
  // decide the answer -- which a self-comparison (declaring the config's own
  // rules for that half) would not guarantee, since a value the canonical encoder
  // rejects fails even against itself.
  const drifted: string[] = [];
  const reportDrift = (field: string, citedHalf: LinkageSetIdentity): void => {
    drifted.push(
      `its ${field} are not drawn from the ` +
        `${describeRuleSetHalf(citedHalf)} this build ships`,
    );
  };
  if (
    namesShippedSet(cited.fieldSet, shipped.reference.fieldSet) &&
    !isDrawnFromLinkageRuleSet(
      {
        reference: cited,
        linkageFields: shipped.linkageFields,
        linkageKeys: [],
      },
      { linkageFields: terms.linkageFields, linkageKeys: [] },
    )
  )
    reportDrift("linkage_fields", cited.fieldSet);
  if (
    namesShippedSet(cited.keySet, shipped.reference.keySet) &&
    !isDrawnFromLinkageRuleSet(
      { reference: cited, linkageFields: [], linkageKeys: shipped.linkageKeys },
      { linkageFields: [], linkageKeys: terms.linkageKeys },
    )
  )
    reportDrift("linkage_keys", cited.keySet);
  if (drifted.length === 0) return;

  const consequence =
    standing === "accepted-with-partner"
      ? "The citation is recorded in both parties' exchange records, where it " +
        "claims a provenance these rules do not have. An acceptance stands " +
        "behind these terms, so they are not yours alone to correct: editing " +
        "the rules to match the citation would take them out of agreement " +
        "with the inviting party, and the exchange would refuse them. " +
        (alternative === "author-fresh-terms"
          ? "Settle the citation with that party, or author fresh terms for " +
            "this invitation."
          : "Settle the citation with that party and accept again, or decline " +
            "to reuse these terms.")
      : "The citation travels onto the invitation, the accepting party's " +
        "terms review, and both parties' exchange records, where it claims a " +
        "provenance these rules do not have. Omit linkage_rule_set for rules " +
        "you author yourself, or restore the rules the cited set declares.";

  log.warn(
    `${configPath}: linkage_terms.linkage_rule_set cites ` +
      `${describeRuleSetCitation(cited)}, but ${drifted.join(", and ")}. ` +
      consequence,
  );
}
