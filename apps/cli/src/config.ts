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
 * channel directory paths. Paired with the tuning/toggle
 * {@link ConnectionOptionsOverrides}, which lands in `connection.options`,
 * inside {@link ConnectionOverrides}.
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
   * format-validated by {@link hostKeyFingerprintFlag}. Overwrites any
   * fingerprint already on the base config. A wrong value still fails closed
   * at the real connect. sftp-only.
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
 * connection's `connection.options` block: SharedOptions timeouts/reconnect
 * bounds on every channel, and FileSyncOptions poll interval/toggles gated to
 * `sftp`/`filedrop`. `connectionTimeout`/`peerTimeout` are in seconds here and
 * scaled to the schema's milliseconds; `pollIntervalMs` is already in
 * milliseconds and applied verbatim. Paired with
 * {@link ConnectionServerOverrides} inside {@link ConnectionOverrides}.
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
 * CLI overrides applied to a base connection by {@link applyConnectionOverrides}:
 * the server/credential set (plus directory paths) that lands in
 * `connection.server` ({@link ConnectionServerOverrides}), and the tuning/toggle
 * set that lands in `connection.options` ({@link ConnectionOptionsOverrides}).
 * Each sub-group is optional and itself sparse; an absent group or field applies
 * no override.
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
  // Default each sub-group to empty so an absent group applies no override.
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
      // Already @file-resolved and format-validated at the CLI parse boundary
      // (hostKeyFingerprintFlag), so it can be assigned as-is; the
      // re-validation below re-checks it as part of the whole connection.
      server.hostKeyFingerprint = serverOverrides.hostKeyFingerprint;
      serverModified = true;
    }
    if (serverOverrides.port !== undefined) {
      server.port = serverOverrides.port;
      serverModified = true;
    }

    // A passphrase decrypts an encrypted private key and is meaningless
    // without one; reject it up front with a flag-named message rather than
    // the core schema's generic one. The key may come from
    // --server-private-key or the loaded config.
    if (
      server.privateKeyPassphrase !== undefined &&
      server.privateKey === undefined
    )
      throw new UsageError(
        "--server-private-key-passphrase requires --server-private-key (or a " +
          "private_key in the configuration): a passphrase decrypts an " +
          "encrypted private key and has no effect without one.",
      );

    // keyboard-interactive answers the server's prompts with the password, so
    // it is meaningless without one; reject it up front with a flag-named
    // message, since the override is applied after the config was parsed and
    // would otherwise go unchecked. The password may come from
    // --server-password or the loaded config.
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

  // These are FileSyncOptions fields, applied only on channels that use
  // FileSyncConnection; the overrides above are SharedOptions, applying to
  // every channel including webrtc. pollIntervalMs is applied verbatim -- it
  // is already in milliseconds, unlike the seconds-scaled timeout fields.
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
  // so a filedrop config never holds an inert setting; on filedrop it is dropped
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
  // any override touched them, so no override path can bypass a floor the
  // schema enforces (timeout positivity, peer_id constraints, retain_files
  // implications). FileSyncOptionsSchema also safely validates a webrtc
  // SharedOptions object: each FileSyncOptions-only refine is guarded by that
  // field's own presence.
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

  // --outbound-path splits the single shared directory into separate inbound
  // (peer-written) and outbound (self-written) directories. Applied here, the
  // one chokepoint every bootstrap command routes its connection through.
  // Only the file-sync channels have a directory.
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
      // with a cause naming the channels that do have one, rather than
      // silently dropping it the way the channel-gated overrides above are.
      throw new UsageError(
        "--outbound-path is only supported on the sftp and filedrop channels",
      );
    }

    // Retain mode is a hard precondition for a split directory; fail fast with
    // a flag-named message rather than the core schema's generic one. The
    // else branch above threw for webrtc, so result is a file-sync channel
    // here; the channel test re-narrows for the options read.
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

  // Re-validate the merged connection through the core schema once, whenever
  // an override touched result.server or its directory paths, so every path
  // that can introduce an invalid value is caught here. The
  // outbound-path-specific rejections come from the same call with the same
  // messages the live connection enforces. A literal `@path` credential ref
  // validates cleanly as a string (resolved later, at live use).
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
 * Logs a one-time reminder, on the file-sync channels only, that retain mode
 * is a bilateral agreement with no negotiation: this party has it enabled
 * (with the `lockless_rendezvous` and `timestamp_in_filename` it implies),
 * and the peer must set all three identically. A `retain_files` or
 * `lockless_rendezvous` mismatch fails fast at rendezvous on both sides;
 * `timestamp_in_filename` is not advertised but cannot diverge on its own.
 * Shared by `exchange` and `zero-setup` so the wording cannot drift.
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
 * escalation of `--sweep-exchange-files`, never standalone: passing it alone
 * is a {@link UsageError} (exit 64). Whether retain is actually in play is a
 * runtime property of the directory, checked instead by the connection's
 * pre-sweep inspection. Shared by `exchange` and `zero-setup`.
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
   * A fragment rather than a `string`, so a value cannot be interpolated into
   * a conflict line without passing through {@link reconcileDiffValue} (or a
   * renderer beside it) first.
   */
  existing: CompatibilityMessageFragment;
  /** Rendering of the value the invitation or URL requires. */
  incoming: CompatibilityMessageFragment;
  /**
   * How each side is fitted where the line's slot cannot hold it whole.
   *
   * Absent when a side is one delimited run: the slot's clip degrades that
   * run directly. Supplied when a side is a CLAUSE -- several values inside
   * first-party structure -- so the slot's share divides among those values
   * instead of being spent left to right on the first of them (see
   * {@link reconcileClause}).
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
   * Least this side can be given and still display as what it is. A side given
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
 * One value somebody else chose, treated for a reconcile conflict line:
 * redacted as private-key material, then delimited as one run through core's
 * terms-value grammar. Redaction runs on the individual value, before
 * composition: the display boundary's private-key rule is fail-closed from a
 * `BEGIN` marker to the end of the whole composed link, so redacting only the
 * final message would let one marker consume every line behind it. Delimiting
 * keeps a value from forging the line's own structure or line breaks; neither
 * pass is the display escape itself, which the sink still applies once where
 * the message is shown.
 */
export function reconcileDiffValue(
  value: string,
): CompatibilityMessageFragment {
  return quoteTermsValue(redactPrivateKeyMaterial(value));
}

/**
 * The same treatment for a value the linkage-terms schema constrains to a shape
 * no clause boundary is made of -- a semver string, an ISO date -- which core's
 * checked bare form renders undelimited so the common line displays as prose. The
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
 * The delimiter core's terms-value grammar wraps a value in and doubles
 * inside one, read off that grammar rather than restated, so the fit below
 * cannot drift from it.
 */
const TERMS_VALUE_DELIMITER = quoteTermsValue("")[0];

const TERMS_VALUE_DELIMITER_COST = renderedDisplayCost(TERMS_VALUE_DELIMITER);

/**
 * Fit a composed conflict-line fragment to `budget`, cutting the VALUE inside
 * a delimited run rather than the run's rendering: a cut never falls between
 * the two characters of a doubled delimiter, and a cut inside a run closes it
 * (truncation marker, then delimiter) rather than leaving it open. Unlike
 * core's {@link clipToRenderedCost}, which cuts the rendered form and can
 * leave a run open mid-cut, misreading everything composed after it at the
 * wrong run parity. A partial control-character marker is trimmed off the
 * kept prefix ({@link trimPartialControlCharacterMarker}) before the closing
 * marker and delimiter are appended.
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
 * Least a conflict line may spend on ONE of its two values while still
 * showing any of that value's own bytes. A fitted value pays for its
 * delimiters and, when cut, the truncation marker; below this floor a side
 * renders as punctuation and a marker with nothing of the value inside. A
 * line whose sides cannot both reach this is named without its values
 * instead ({@link formatReconcileDiffs}).
 */
const RECONCILE_MIN_VALUE_BUDGET = 32;

/**
 * The same floor for ONE value inside a clause. Sized off the truncation
 * marker's own cost: at or below it a clipped value renders as a run with
 * nothing of its own inside. Smaller than the whole-side floor above, since a
 * clause fits several values into a slot sized for one side.
 */
const RECONCILE_MIN_CLAUSE_VALUE_BUDGET = DISPLAY_TRUNCATION_MARKER_COST + 8;

/**
 * Divide `budget` among claims of the given `needs`, need-aware: a claim
 * takes only what it needs, and what it leaves is available to claims that
 * exceed an equal share, so the constraint falls only on claims too wide for
 * the room. Serving claims in ascending order decides this in one pass:
 * every claim still unserved is at least as wide as the one being served.
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
      // Every claim still unserved is at least this wide, so they all take the
      // same share; what the division leaves over goes unspent rather than to
      // whichever claim was served last, so two claims of equal need render
      // alike.
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
 * Compose a conflict line's side as a tagged template, keeping the values
 * apart from the first-party spans around them so a slot too small for the
 * whole clause is divided among the VALUES, not spent left to right (which
 * would delete the connective and everything behind the first value). A
 * share too small for its value degrades only that value's own bytes: the
 * fit cuts inside the run and delimits what it kept
 * ({@link fitToRenderedCostClosingRuns}). The fitted form is a plain string,
 * not a fragment, since it is composed by concatenation; a test over the
 * rendered lines holds the run structure instead (config.test.ts).
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
      // A share below what the marker and delimiters cost leaves a clipped
      // value wider than its share, so the composed clause is held to the
      // slot it was given. This is a fallback for a budget reached some other
      // way; the block's own floor keeps a fitted line off that shape.
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
 * as a clause -- so a line whose other side is one can hold a fit for both of
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
 * Recursively drop every key whose value is `undefined` from a JSON-like
 * value, preserving the rest of its structure, so an absent key and an
 * explicitly-`undefined` one compare equal to {@link canonicalString} (which
 * rejects `undefined`). Strings pass through untouched, normalization form
 * included, since the compare this feeds is byte-exact (see
 * {@link diffLinkageTerms}).
 *
 * `depth` bounds the native recursion at {@link MAX_NESTING_DEPTH}. Both
 * sides reach this walk already depth-bounded upstream, but this is the
 * walk's own check: an unguarded deep value overflows with an uncaught
 * `RangeError` instead of the clean {@link NestingDepthExceededError}
 * (`UsageError`, exit 64) this raises well ahead of the real limit. See
 * docs/spec/CHANNEL_SECURITY.md.
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
 * equality check, byte-exact over the strings inside it. Object keys are
 * sorted; array order is preserved, so the caller pre-sorts any list whose
 * order is not significant.
 *
 * No key-casing fold is applied: `transform.params` keys are normalized to
 * camelCase upstream on every parse path that produces these terms, so both
 * sides reach this compare already in that form.
 */
function reconcileCanonical(value: unknown): string {
  return canonicalString(withoutUndefinedDeep(value));
}

/**
 * Render the identifiers of a list of named entries (linkage fields/keys,
 * payload columns) for a diff line, in the order given. Each name is
 * delimited on its own rather than the joined list once, so `a,b` as one
 * entry renders differently from `a` and `b` as two.
 */
function renderNames(
  list: ReadonlyArray<{ name: string }>,
): CompatibilityMessageFragment {
  return compatibilityMessage`[${quoteTermsValueList(
    list.map((e) => redactPrivateKeyMaterial(e.name)),
  )}]`;
}

/**
 * When the two rendered sides of a diff come out identical despite a
 * canonical difference -- e.g. values sharing every name but differing in a
 * sub-field -- fall back to the full JSON of each value, so the conflict
 * message shows what actually differs. The JSON is of whatever the caller
 * hands it, not the form the comparison encoded, so the user sees the stored
 * values to edit. It takes the same treatment as the summary form
 * ({@link reconcileDiffValue}), over the serialized text rather than value by
 * value.
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
 * Render a rule-set citation for a diff line, keys first -- the order core's
 * own mismatch message and the drift warning both use, so the two accounts
 * of one citation cannot drift apart on how a name is delimited. Unescaped,
 * unlike {@link describeRuleSetCitation}: a diff line is composed into a
 * {@link UsageError} and escaped once where it is shown. All four values
 * stand in ONE clause rather than two nested halves, so the
 * {@link reconcileClause} sub-partition runs once rather than dividing a
 * quarter share twice over.
 */
function renderRuleSetCitation(
  reference: LinkageRuleSetReference,
): ReconcileClause {
  return reconcileClause`${reconcileDiffValue(reference.keySet.name)} ${reconcileDiffBareValue(reference.keySet.version)} over ${reconcileDiffValue(reference.fieldSet.name)} ${reconcileDiffBareValue(reference.fieldSet.version)}`;
}

/**
 * The two sides of a `linkage_rule_set` conflict, each as its clause.
 *
 * No full-detail fallback beside it, unlike the structural lists: the clause
 * is built from delimited runs and a checked bare form, which no two
 * different citations can spell alike, so two clauses that read the same are
 * citations whose difference redaction took out. {@link formatReconcileDiffs}
 * is where a pair that reads alike is reported.
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
 * Compare a pre-existing config's linkage terms against the terms an
 * acceptance would adopt from the invitation, returning the mandatory
 * disagreements that must abort the acceptance and the soft mismatches that
 * only warn.
 *
 * This is an equality check ("do these describe the same exchange
 * agreement?"), not the cross-party {@link validateCompatibility} (which
 * checks that two different parties' terms work together). The
 * agreement-defining fields -- version, algorithm, linkage strategy, linkage
 * fields and keys, the rule-set citation (where both sides declare one),
 * legal agreement, and payload -- must match; per-party fields (`identity`,
 * `output`, `deduplicate`) are excluded, since each party legitimately holds
 * its own value. `date` is soft, matching `validateCompatibility`.
 *
 * Every value is compared BYTE-EXACT (canonical form, or string equality for
 * a schema-constrained scalar), matching the predicate `validateCompatibility`
 * applies to the same values -- so a pair differing only in Unicode
 * normalization is a mismatch here too, reported at accept rather than
 * aborting mid-exchange later. On the payload this compare is stricter than
 * core (a column's `description` takes part here; core cross-checks only
 * names), an asymmetry that only refuses a reuse the operator can still make
 * onto a fresh config.
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

  // canonicalString rejects a value it cannot encode (e.g. an integer outside
  // the JSON-safe range in a transform param). Wrapped so an un-encodable
  // value warns rather than aborting the reconcile on two otherwise-identical
  // configs; validateCompatibility re-checks compatibility at exchange setup
  // and reports it there as a hard error.
  //
  // Only CanonicalEncodingError is softened. NestingDepthExceededError from
  // withoutUndefinedDeep's own depth guard is left to propagate as the
  // terminal usage error for a pathological token, not reconciled-and-deferred.
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

  // version, algorithm, and linkageStrategy compare by string equality, not
  // the canonical encoder below: all three are schema-constrained scalars
  // (semver, and two fixed enums), so each one's encoding is the string
  // itself -- the same byte-exact equality validateCompatibility uses.
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
  // linkageStrategy is mandatory-consistency like algorithm
  // (validateCompatibility aborts on a mismatch): without this check a reused
  // config could silently diverge from the strategy the acceptor consented
  // to, and the later exchange would abort against the partner only after a
  // false "matches" assurance here.
  if (existing.linkageStrategy !== incoming.linkageStrategy)
    add(
      "linkage_strategy",
      reconcileDiffValue(existing.linkageStrategy),
      reconcileDiffValue(incoming.linkageStrategy),
    );

  // Sort linkage fields by name (order not significant) before comparing;
  // compare linkage keys in place (order is significant). The comparator is
  // core's own -- raw name, UTF-16 code unit order, not localeCompare -- so
  // both sides reach the compare in the order validateCompatibility uses.
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
  // schema-constrained, so each takes the form its own shape earns, as a
  // clause: a slot too small divides between the two values rather than
  // deleting the expiry.
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
 * What the operator's own configuration path may render to at the head of
 * the reconciliation refusal. Fitted so a long path (or one whose bytes
 * escape wide at the display boundary) cannot crowd out the conflict detail
 * and recovery step behind it. Sized well above any real path and below what
 * would leave the diff block without room; a longer path is clipped rather
 * than dropped.
 */
const RECONCILE_CONFIG_PATH_BUDGET = 128;

/** First-party spans a conflict line is built from, measured rather than
 *  restated wherever the budget arithmetic needs their cost. */
const RECONCILE_LINE_PREFIX = "  - ";
const RECONCILE_LINE_EXISTING = ": existing ";
const RECONCILE_LINE_INCOMING = " vs required ";

/**
 * Explains a line whose two sides read alike -- what a pair differing only
 * inside redacted or clipped bytes comes to -- once for the block rather
 * than once per line. Both sides are still shown as they fitted rather than
 * a standin replacing the second, since that would delete the operator's own
 * reading of a value the display cannot show. Its cost comes out of the
 * block's budget before the values are re-fitted, so this note never costs
 * the line that needed it.
 */
const RECONCILE_WITHHELD_NOTE =
  "  (two sides that read alike differ only inside what this display withheld: " +
  "bytes redacted as private-key material, or clipped for length)";

/**
 * Explains a line the block named without its values, so a bare field name
 * does not look as though nothing differs -- beside lines carrying both
 * their values, or as the whole block when no line got room. Truncation
 * eats conflict detail here, which is why the recovery step is composed
 * ahead of this block (see {@link reconcileConflictMessage}).
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
 * for a reconciliation error message, fitted so its rendered cost at the
 * display boundary is at most `budget`.
 *
 * Both sides of every line hold bytes somebody else chose, already redacted
 * and delimited by the producer that composed it ({@link reconcileDiffValue}).
 * They are interpolated RAW: the display boundary escapes the whole message
 * once where it is shown, including the block's own `\n` line breaks.
 *
 * The budget is shared out by NEED, not by count: every line is charged its
 * first-party skeleton, each side is measured at what it would actually
 * render to, and what a short value does not take is available to a longer
 * one beside it -- so a constraint falls only on the sides too wide for the
 * room. A clause side sub-partitions its own slot among its values the same
 * way ({@link reconcileClause}). A side that cannot be given the least it
 * can display as drops both of that LINE's values, naming only the field,
 * with a first-party notice under the block explaining why.
 *
 * A cut always lands inside a delimited run closed properly (marker inside,
 * per {@link fitToRenderedCostClosingRuns}), which a check over the rendered
 * lines holds (`apps/cli/test/unit/config.test.ts`) rather than this comment.
 * The one property recorded rather than closed: the marker is plain ASCII a
 * value could also spell, so a value can claim a cut that did not happen --
 * what an operator can rely on is the marker's ABSENCE.
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
    // ascending order also means the first line that does not fit decides
    // every line behind it, each of which asks for at least as much.
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

  // A notice's own cost comes out of the values' share rather than the budget
  // already spent, so the explanation cannot push the block past its bound.
  // Which notices are needed is only known once laid out, so a layout
  // needing more than it reserved is laid out again under what it needed.
  let reserved = 0;
  let attempt = layOut(reserved);
  if (attempt.noticeCost > reserved) {
    reserved = attempt.noticeCost;
    attempt = layOut(reserved);
  }
  if (attempt.noticeCost > reserved)
    attempt = layOut(RECONCILE_NOTICE_RESERVE_CEILING);
  // The arithmetic above holds the block inside `budget` for every shape
  // reached today, pinned by a test asserting no line of a worst-case
  // message is cut. This is the fallback under it: a wider first-party
  // skeleton or field-name list is bounded here rather than silently
  // spending the recovery step's room.
  return fitToRenderedCostClosingRuns(attempt.block, budget);
}

/**
 * The refusal `psilink accept` raises when a pre-existing configuration
 * disagrees with the invitation (and, online, the connection URL): what
 * disagreed, and what the operator does about it, composed to one display
 * link.
 *
 * The recovery step is composed AHEAD of the diff block: the display
 * boundary caps a link and drops the tail, and the recovery step is the one
 * part the operator cannot reconstruct from their own config, so truncation
 * should eat conflict detail instead.
 *
 * The budget is partitioned by WHO CHOSE THE BYTES: first-party copy is
 * measured where it stands, the operator's own configuration path is fitted
 * to {@link RECONCILE_CONFIG_PATH_BUDGET}, and the diff block gets exactly
 * what remains ({@link formatReconcileDiffs}). The path takes the same
 * redact/replace/fit treatment as a chooser's value even though it is the
 * operator's own, so no later caller can assume a fragment is exempt from
 * that treatment because of its provenance.
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
 * Serialize an {@link ExchangeSpec} and write it to `configPath` as
 * snake_case YAML, owner-read-only -- a config may hold an SFTP credential.
 * Gets the same `0600`/ACL protection as the key file via
 * {@link writeFileOwnerOnly}.
 *
 * The shared secret and its expiration live only in the key file: they are
 * stripped from the top-level `authentication` block here even if the
 * caller left them populated, so the secret cannot be duplicated onto disk.
 * The caller's spec is not mutated.
 *
 * Does not guard against overwriting an existing file; callers provision
 * through `provisionConfigAndKey`, which runs the conflict gate first.
 */
export function saveConfig(configPath: string, spec: ExchangeSpec): void {
  const sanitized = structuredClone(spec);
  const auth = sanitized.authentication;
  if (auth) {
    delete auth.sharedSecret;
    delete auth.expires;
    // Drop the container if those were its only keys, so the config holds no
    // noisy empty `authentication: {}` block. Operator-policy fields (e.g.
    // token_max_age_days) keep it non-empty when present.
    if (Object.keys(auth).length === 0) delete sanitized.authentication;
  }
  writeFileOwnerOnly(configPath, YAML.stringify(snakeizeKeys(sanitized)));
}

/**
 * Write (or overwrite) `connection.server.host_key_fingerprint` in an
 * existing `psilink.yaml`, used to persist a host-key pin established
 * interactively on first use. Unlike {@link saveConfig}, this edits the file
 * in place through the YAML document model so the operator's comments, key
 * order, and formatting survive.
 *
 * Rewritten with the same owner-only permissions {@link saveConfig} uses.
 * Throws if the file cannot be read or parsed, since the caller just loaded
 * it and a silent failure would leave the operator believing the pin was
 * saved.
 *
 * Fails closed on a non-sftp config: a host-key fingerprint is an sftp-only
 * pin, so any other `connection.channel` is rejected with a
 * {@link UsageError} before anything is written (config.test.ts).
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
      // schema-loaded spec) and reject anything but sftp before the write.
      // getIn does not resolve aliases, so an alias-spelled channel is
      // treated as a non-string node and is rejected even when it would
      // resolve to sftp -- the safe direction, and not a form a
      // hand-authored config uses.
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
      // setIn creates the connection/server path nodes if absent; for an
      // sftp config loaded by the exchange command they already exist. A
      // `connection`/`server` that is a scalar or sequence, not a mapping,
      // makes setIn throw a YAML error, reported here as a UsageError rather
      // than an opaque library stack trace.
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
 * Write, overwrite, or remove the top-level `disclosed_payload_columns` in
 * an existing `psilink.yaml`: the SEND-side disclosure commitment (this
 * party's own column namespace) that a later recurring `psilink exchange`
 * verifies its current metadata still discloses
 * ({@link assertDisclosureMatchesCommitment} in core).
 *
 * Used by the offline invite-from-config / re-invite path. Like
 * {@link persistHostKeyFingerprint}, this edits the file in place through
 * the YAML document model so the operator's comments, key order, and
 * formatting survive.
 *
 * `columns === undefined` removes the field rather than leaving a stale
 * value; an empty array is written verbatim, a strict "disclose nothing"
 * commitment distinct from absent.
 *
 * Rewritten with the same owner-only permissions {@link saveConfig} uses.
 * Throws if the file cannot be read or parsed, since the caller just read it
 * and a silent failure would leave the operator believing the commitment was
 * recorded.
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
 * existing `psilink.yaml`: the RECEIVE-side consent commitment (the
 * PARTNER's column namespace) that a later recurring `psilink exchange`
 * holds the received payload to ({@link reconcileReceivedPayload} in core).
 *
 * Used by both accept-reuse paths (offline, and the online hook's reuse
 * branch). Like {@link persistDisclosedPayloadColumns}, its send-side twin,
 * this edits the file in place through the YAML document model so the
 * operator's comments, key order, and formatting survive.
 *
 * `columns === undefined` removes the field rather than leaving a stale
 * value; an empty array is written verbatim, a strict "receive nothing"
 * consent distinct from absent.
 *
 * Rewritten with the same owner-only permissions {@link saveConfig} uses.
 * Throws if the file cannot be read or parsed, since the caller just
 * reconciled it and a silent failure would leave the operator believing the
 * commitment was refreshed.
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
 * existing `psilink.yaml`: this party's consent to its OWN outbound set (or
 * the `pending` marker recorded when an acceptance could not resolve it
 * yet), which a later `psilink exchange` holds the transmitted set to
 * ({@link assertOutboundPayloadConsented} in core).
 *
 * Used by the accept-reuse path and the run that resolves and confirms a
 * `pending` record in place. Like {@link persistDisclosedPayloadColumns},
 * this edits the file in place through the YAML document model so the
 * operator's comments, key order, and formatting survive.
 *
 * `consent === undefined` removes the field rather than leaving a stale
 * value: an acceptance transmitting nothing records no consent.
 *
 * Rewritten with the same owner-only permissions {@link saveConfig} uses.
 * Throws if the file cannot be read or parsed, since the caller just read
 * it and a silent failure would leave the operator believing their
 * confirmation was recorded.
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
 * Write or overwrite the top-level `expected_partner_deduplicate` in an
 * existing `psilink.yaml`: the TERMS-side consent commitment, the
 * `deduplicate` the accepted invitation declared for the inviting party's
 * own side, which a later `psilink exchange` holds the partner's presented
 * value to ({@link assertPresentedDeduplicateMatchesInvitation} in core),
 * refusing a contradiction before any key or payload moves.
 *
 * The terms-side twin of {@link persistExpectedPayloadColumns}, written by
 * the same accept-reuse paths, editing the file in place the same way.
 *
 * Takes a plain `boolean`: `deduplicate` is mandatory on the linkage-terms
 * schema, so an acceptance always has a declaration to record and there is
 * no removal to express.
 *
 * Rewritten with the same owner-only permissions {@link saveConfig} uses.
 * Throws if the file cannot be read or parsed, since the caller just
 * reconciled it and a silent failure would leave the operator believing the
 * commitment was refreshed.
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
 * The portion of a pre-existing config that `invite` uses as the source for
 * an invitation: the linkage terms, the explicit data standardization and
 * metadata if any, plus the one connection fact the invitation declares. The
 * connection block itself is omitted -- `invite` does not build a connection
 * from it.
 */
export interface ConfigLinkageSource {
  linkageTerms: LinkageTerms;
  /** The config's explicit `standardization` block, absent when not present. */
  standardization?: Standardization;
  /**
   * The config's explicit `metadata` block, absent when not present.
   * Forwarded to the satisfiability check so it resolves the type fallback
   * against the same column types the exchange does -- without it, a config
   * that retypes a column could mint an invitation for an input the exchange
   * cannot actually satisfy.
   */
  metadata?: Metadata;
  /**
   * Whether the config's connection block has retain mode on
   * (`connection.options.retain_files: true`), which the minted invitation
   * declares to the partner as a consent fact.
   *
   * Read as that ONE boolean at its fixed path, never by validating the
   * connection block, so an unfinished or placeholder one does not block
   * generating an invitation. Anything other than a literal `true` counts
   * as false, including a `webrtc` connection.
   */
  retainsFiles: boolean;
  /**
   * Whether an acceptance stands behind the config's linkage terms, for
   * readers that report on the citation those terms hold. Read as the
   * single presence check {@link linkageTermsStandingOf} describes, at the
   * top-level key rather than through the spec schema.
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
 * Render a config block's schema issues as `<key path>: <reason>` clauses,
 * so the operator can locate each offending field, mirroring accept's
 * decode-error formatting.
 *
 * `keys` says how the block was parsed. A block parsed through
 * `camelizeKeys` (`camelized`) yields issue paths in camelCase while the
 * file writes snake_case, so each segment is put back through
 * {@link snakeizeKey}. A block whose schema parses the on-disk form directly
 * (`as-written`) is named verbatim.
 *
 * A camelized path STOPS at a `params` segment, naming the block rather than
 * the key inside it: that free-form record holds the author's own key, and
 * the camelized form of two different on-disk spellings can collide.
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
 * Read the linkage-terms source from a config file, reporting a missing file
 * and a config that defines no `linkage_terms` as distinct outcomes, so each
 * caller attributes them in its own terms.
 *
 * Only the `linkage_terms`, `standardization`, and `metadata` blocks are
 * parsed and validated; the connection block is excluded by design, so a
 * still-placeholder one does not fail the read.
 *
 * Every other defect is a {@link UsageError}: a config present at the path
 * is treated as intentional, so a broken one is reported for the user to
 * fix. Top-level keys are read as either the written snake_case form or
 * their camelCase spelling.
 */
export function readConfigLinkageSource(
  configPath: string,
): ConfigLinkageSourceResult {
  // Read, then parse through the sensitive-file chokepoint. A read failure
  // holds only a path and errno (ENOENT means no config, not an error here); a
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
  // parses the on-disk form without camelizing. An invalid block is reported
  // as a usage error, like invalid linkage_terms above.
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
  // above. An invalid block is reported as a usage error rather than silently
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
 * The standing of a loaded config's terms, read from the presence of a
 * top-level `expected_partner_deduplicate` at its fixed key, unparsed for
 * the same reason {@link readRetainFilesDeclaration} reads its own key that
 * way. Both spellings are accepted, matching `saveConfig`'s snake_case
 * write.
 *
 * Presence alone decides it, on {@link linkageTermsStandingOf}'s rule that
 * the record says an acceptance happened rather than what was agreed. A
 * value the strict paths refuse is refused there, by core's schema, on the
 * commands that build an exchange from the file.
 */
function readLinkageTermsStanding(
  obj: Record<string, unknown>,
): LinkageTermsStanding {
  const declared =
    obj["expected_partner_deduplicate"] ?? obj["expectedPartnerDeduplicate"];
  return declared === undefined ? "held-alone" : "accepted-with-partner";
}

/**
 * The config's `connection.options.retain_files`, read as a single boolean
 * at its fixed path so a still-placeholder connection block is not
 * validated on the way (see {@link ConfigLinkageSource.retainsFiles}). Both
 * key spellings are accepted, matching `saveConfig`'s snake_case write.
 *
 * Only a literal `true` counts as a declaration; every other shape yields
 * false.
 *
 * A `webrtc` connection declares nothing whatever its options say. This is
 * a runtime gate, not a schema refusal: `SharedOptionsSchema` silently
 * drops an unknown `retainFiles` on a webrtc connection's `options` rather
 * than rejecting it, so a hand-authored config pairing `channel: webrtc`
 * with `retain_files: true` loads successfully. In-repo writers are held to
 * this by the type system instead (`WebRTCConnectionConfig.options` has no
 * `retainFiles` member); that protection does not reach a hand-authored
 * file, which is what this function's own check is for.
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
 * The linkage-terms source for `invite`'s config-as-source path: the config
 * named at `configPath`, or `undefined` when no file exists there (the
 * caller then falls back to inferring terms from an input file).
 *
 * A config present at the path is the authoritative source of the
 * invitation's linkage terms, so one that defines none cannot serve as that
 * source and is a {@link UsageError} rather than a silent fall-through to
 * input inference.
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
 * One half of a rule-set citation -- a set's name and content version -- for
 * the drift warning, which names a half on its own wherever it reports on
 * that half alone.
 *
 * The names are free text the config author chose, and `log.warn` is their
 * sink, so each is escaped here before rendering through core's terms-value
 * grammar ({@link ruleSetCitation}) -- the same grammar core's own mismatch
 * message and both consent surfaces use. Escaping BEFORE delimiting:
 * escaping after could truncate a value and take the closing delimiter off
 * it.
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
 * Whether an acceptance stands behind a config's linkage terms, which
 * decides the remedy the drift warning can accurately offer for the
 * citation those terms hold.
 *
 * - `held-alone` -- no acceptance stands behind them, so both remedies are
 *   open: drop a citation the rules no longer earn, or put the cited set's
 *   rules back.
 * - `accepted-with-partner` -- an acceptance put them under agreement with
 *   an inviting party. Editing the rules to match the citation would take
 *   them out of that agreement, and the exchange would refuse them against
 *   the partner still running the originals.
 */
export type LinkageTermsStanding = "held-alone" | "accepted-with-partner";

/**
 * What a command can offer its operator besides settling a drifted citation
 * with the party whose acceptance stands behind the terms. Only the
 * `accepted-with-partner` reading takes it.
 *
 * - `decline-to-reuse` -- the command is putting the agreed terms to use, so
 *   the operator can leave them and start from terms that hold no claim
 *   they cannot support.
 * - `author-fresh-terms` -- the command is minting an invitation FROM those
 *   terms, so the operator can author fresh ones instead of carrying the
 *   accepted ones onto it.
 */
export type CitationDriftAlternative =
  "decline-to-reuse" | "author-fresh-terms";

/**
 * Whether an acceptance stands behind a loaded config's linkage terms, read
 * from `expected_partner_deduplicate`. `psilink accept` writes this field on
 * every config it writes or reuses, and nothing else writes one, so its
 * presence is exactly the mark of a config an acceptance stands behind (see
 * {@link persistExpectedPartnerDeduplicate}). Both values read the same
 * way: the record says an acceptance happened, not what was agreed.
 */
export function linkageTermsStandingOf(
  spec: Pick<ExchangeSpec, "expectedPartnerDeduplicate">,
): LinkageTermsStanding {
  return spec.expectedPartnerDeduplicate === undefined
    ? "held-alone"
    : "accepted-with-partner";
}

/**
 * Warn when a loaded config's `linkage_terms.linkage_rule_set` cites a set
 * this build ships over rules that are not drawn from it -- the state a
 * hand edit to `linkage_fields` or `linkage_keys` leaves behind. Left
 * unreported, that citation travels onto the invitation and both parties'
 * exchange records claiming a provenance the rules no longer have.
 *
 * Only a half this build can RESOLVE is judged: a citation naming a set
 * psilink does not ship has no content here to compare the rules against,
 * so that half is passed over, and each half is judged separately so a
 * foreign half cannot buy the built-in half a pass.
 *
 * Warns rather than refuses: the citation is display-and-record only, and
 * the exchange runs on the declared fields and keys either way.
 *
 * `standing` decides the remedy wording (see {@link LinkageTermsStanding}):
 * terms an acceptance stands behind are agreed with the inviting party, so
 * restoring the cited set's rules would edit terms both parties hold and
 * the exchange would then abort against the partner. `alternative` names
 * what that operator can do instead of settling (see
 * {@link CitationDriftAlternative}).
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

  // Each half is judged by handing the predicate that half's shipped
  // declarations over rules with nothing on the other side: an empty list
  // runs neither of the predicate's loops, so the half not under test
  // cannot decide the answer.
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
      ? "The citation is recorded in both parties' exchange records, so it " +
        "credits a source these rules did not come from. An acceptance stands " +
        "behind these terms, so they are not yours alone to correct: editing " +
        "the rules to match the citation would take them out of agreement " +
        "with the inviting party, and the exchange would refuse them. " +
        (alternative === "author-fresh-terms"
          ? "Agree the citation with that party, or author fresh terms for " +
            "this invitation."
          : "Agree the citation with that party and accept again, or decline " +
            "to reuse these terms.")
      : "This citation is copied into the invitation, into the terms your " +
        "partner reviews, and into both parties' exchange records, so it " +
        "credits a source these rules did not come from. Remove " +
        "linkage_rule_set if you wrote these rules yourself, or restore the " +
        "rules the cited set defines.";

  log.warn(
    `${configPath}: linkage_terms.linkage_rule_set cites ` +
      `${describeRuleSetCitation(cited)}, but ${drifted.join(", and ")}. ` +
      consequence,
  );
}
