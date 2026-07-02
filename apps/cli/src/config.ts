import fs from "node:fs";

import YAML from "yaml";
import type {
  ConnectionConfig,
  ExchangeSpec,
  LinkageTerms,
  Metadata,
  Standardization,
} from "@psilink/core";
import {
  canonicalString,
  CanonicalEncodingError,
  MAX_NESTING_DEPTH,
  NestingDepthExceededError,
  safeParseConnectionConfig,
  safeParseFileSyncOptions,
  safeParseLinkageTerms,
  safeParseMetadata,
  sanitizeForDisplay,
  snakeizeKeys,
  StandardizationSchema,
  UsageError,
} from "@psilink/core";

import { writeFileOwnerOnly } from "./fileUtils";
import { parseSensitiveYaml, editSensitiveYamlDocument } from "./sensitiveFile";

/**
 * Default path for the exchange config file written by the provisioning
 * commands (`invite`, `accept`, and `exchange --save`). Matches the default the
 * `exchange` command reads from, so a config written here is found without an
 * explicit `--config-file`.
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
 * `maxReconnectAttempts`) and the FileSyncOptions toggles gated to the file-sync
 * channels (`locklessRendezvous`, `peerId`, `retainFiles`,
 * `timestampInFilename`). `connectionTimeout`/`peerTimeout` are in seconds here;
 * the apply step scales them to the schema's milliseconds. This is the
 * `connection.options` half of the {@link ConnectionOverrides} seam, as distinct
 * from the server/credential {@link ConnectionServerOverrides}.
 */
export interface ConnectionOptionsOverrides {
  connectionTimeout?: number;
  peerTimeout?: number;
  maxReconnectAttempts?: number;
  locklessRendezvous?: boolean;
  peerId?: string;
  retainFiles?: boolean;
  timestampInFilename?: boolean;
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

  if (result.channel === "sftp") {
    const { server } = result;
    if (serverOverrides.username !== undefined)
      server.username = serverOverrides.username;
    if (serverOverrides.password !== undefined)
      server.password = serverOverrides.password;
    if (serverOverrides.privateKey !== undefined)
      server.privateKey = serverOverrides.privateKey;
    if (serverOverrides.port !== undefined) server.port = serverOverrides.port;
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

  // locklessRendezvous, peerId, retainFiles, and timestampInFilename are
  // FileSyncOptions fields; only apply them on channels that use
  // FileSyncConnection. The other overrides above (peerTimeout etc.) are
  // SharedOptions that apply to all channels including webrtc.
  if (
    (result.channel === "sftp" || result.channel === "filedrop") &&
    (optionsOverrides.locklessRendezvous !== undefined ||
      optionsOverrides.peerId !== undefined ||
      optionsOverrides.retainFiles !== undefined ||
      optionsOverrides.timestampInFilename !== undefined)
  ) {
    result.options = {
      ...result.options,
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
    };

    // retain_files implies lockless_rendezvous and timestamp_in_filename when
    // those are not yet set. This lets --retain-files alone suffice at the CLI.
    // An explicit false is left untouched so the schema refine can surface the
    // contradiction with a clear error message.
    if (result.options.retainFiles === true) {
      if (result.options.locklessRendezvous === undefined)
        result.options.locklessRendezvous = true;
      if (result.options.timestampInFilename === undefined)
        result.options.timestampInFilename = true;
    }

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
    } else if (result.channel === "filedrop") {
      result.inboundPath = result.inboundPath ?? result.path;
      result.outboundPath = serverOverrides.outboundPath;
      delete result.path;
    } else {
      // webrtc has no directory, so the flag is meaningless there. Only
      // `exchange` can reach this -- the URL-driven commands reject a webrtc URL
      // before overrides apply -- and its config is rejected as unsupported
      // shortly after; surface a precise cause here first.
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

    // Validate the assembled split through the core schema so the remaining
    // rejections -- an inbound equal to the outbound, a relative or unset
    // filedrop path, the pair-set-together rule -- surface with the same messages
    // and rules the live connection enforces, rather than being re-implemented
    // here. The literal `@path` credential refs a connection may still carry
    // validate cleanly as strings (resolved later, at live use).
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
   * `linkage_keys`, `connection.server.host`).
   */
  field: string;
  /** Rendering of the value in the pre-existing config; `(unset)` when absent. */
  existing: string;
  /** Rendering of the value the invitation or URL requires. */
  incoming: string;
}

/** Placeholder rendered for an absent value in a {@link ReconcileDiff}. */
export const RECONCILE_UNSET = "(unset)";

/**
 * Recursively NFC-normalize every string in a JSON-like value, preserving its
 * structure. Two Unicode-equivalent strings authored in different normalization
 * forms then compare equal -- consistent with core's NFC handling in
 * standardization -- so a hand-edited config is not falsely flagged as differing
 * from an invitation whose strings arrived in another form.
 *
 * Keys whose value is `undefined` are dropped, so an explicit `undefined` (which
 * an in-process object built by spread may carry, unlike a Zod-parsed one where
 * absent optionals are simply omitted) is treated as absent rather than handed
 * to {@link canonicalString}, which rejects it. Two values that differ only in
 * an absent vs explicitly-`undefined` optional therefore compare equal, matching
 * how the schema treats them.
 *
 * `depth` bounds the native recursion at the same {@link MAX_NESTING_DEPTH} the
 * camelize chokepoint applies on every linkage-terms parse path. Both sides now
 * reach this walk already depth-bounded: the invitation decode path normalizes
 * `transform.params` through the bounded `camelizeKeys` chokepoint (core's
 * invitation decode pre-pass), so a partner-controlled one-key-per-level
 * `params` is rejected at decode before it could reach here, and the
 * existing-config side is bounded the same way at load. This guard is the
 * reconcile walk's own backstop, kept because `nfcDeep` is an independent
 * recursion that must not rely on every caller having pre-bounded its input: an
 * unguarded deep value would overflow this walk with a `RangeError` the command
 * boundary maps to a generic internal-error exit (69), whereas rejecting at 256
 * yields a clean, terminal {@link NestingDepthExceededError} (a `UsageError`, CLI
 * exit 64) long before the overflow, with headroom far above any real config (the
 * deepest schema path is under a dozen levels, and `params` legitimately holds
 * shallow scalars). See docs/spec/CHANNEL_SECURITY.md.
 */
function nfcDeep(value: unknown, depth = 0): unknown {
  if (depth >= MAX_NESTING_DEPTH) throw new NestingDepthExceededError();
  if (typeof value === "string") return value.normalize("NFC");
  if (Array.isArray(value)) return value.map((v) => nfcDeep(v, depth + 1));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, nfcDeep(v, depth + 1)]),
    );
  return value;
}

/**
 * Canonical (RFC 8785) encoding of a value after NFC-normalizing its strings,
 * for an order-stable, Unicode-insensitive structural equality check. The
 * canonical encoder sorts object keys, so property-insertion order does not
 * affect the result; array order is preserved, so the caller pre-sorts any list
 * whose order is not significant.
 *
 * No key-casing fold is applied: `transform.params` keys (the only ones whose
 * form could vary) are normalized to camelCase upstream on every parse path that
 * produces these terms -- the existing config at load, and the invitation's
 * adopted terms at decode (core's invitation decode pre-pass) -- so both sides
 * reach this compare in the one camelCase form.
 */
function nfcCanonical(value: unknown): string {
  return canonicalString(nfcDeep(value));
}

/** Render the identifiers of a list of named entries (linkage fields/keys,
 *  payload columns) for a diff line, in the order given. */
function renderNames(list: ReadonlyArray<{ name: string }>): string {
  return `[${list.map((e) => e.name).join(", ")}]`;
}

/**
 * When the two rendered sides of a diff come out identical despite a canonical
 * difference -- a name-only rendering of values that share every name but differ
 * in a sub-field (a linkage field/key's type/constraints/`swap`, a payload
 * column's description) -- fall back to the full JSON of each value, so the
 * conflict message shows what actually differs instead of two identical-looking
 * summaries. The JSON is raw, not NFC-folded, so the user sees the stored values
 * to edit.
 */
function disambiguate(
  existingRendered: string,
  incomingRendered: string,
  existingValue: unknown,
  incomingValue: unknown,
): { existing: string; incoming: string } {
  if (existingRendered === incomingRendered)
    return {
      existing: JSON.stringify(existingValue),
      incoming: JSON.stringify(incomingValue),
    };
  return { existing: existingRendered, incoming: incomingRendered };
}

/** Render the existing/incoming sides of a structural-list (linkage fields/keys)
 *  conflict: names when the lists differ by name, else the full JSON. */
function renderStructural(
  existing: ReadonlyArray<{ name: string }>,
  incoming: ReadonlyArray<{ name: string }>,
): { existing: string; incoming: string } {
  return disambiguate(
    renderNames(existing),
    renderNames(incoming),
    existing,
    incoming,
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
 * algorithm, the linkage strategy, linkage fields and keys, legal agreement, and
 * payload -- must match.
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
 * Structural fields are compared by NFC-normalized canonical form: linkage
 * fields order-insensitively (their array order is not significant), linkage
 * keys in place (their order is significant).
 */
export function diffLinkageTerms(
  existing: LinkageTerms,
  incoming: LinkageTerms,
): { conflicts: ReconcileDiff[]; warnings: string[] } {
  const conflicts: ReconcileDiff[] = [];
  const warnings: string[] = [];
  const add = (field: string, a: string, b: string): void => {
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
  // Only CanonicalEncodingError is softened to a warning. nfcDeep's own depth
  // guard can also throw NestingDepthExceededError, and that is deliberately left
  // to propagate as the terminal exit-64 usage error item 202775336 established
  // for a pathological token -- a too-deep structure is rejected, not
  // reconciled-and-deferred the way an un-encodable value is. Both sides are now
  // depth-bounded upstream (the invitation's params at decode, the config at
  // load), so this backstop is not normally reachable; it stays because nfcDeep
  // is an independent recursion that must not depend on its callers (see nfcDeep).
  const canonicalDiffers = (a: unknown, b: unknown, label: string): boolean => {
    let ca: string;
    let cb: string;
    try {
      ca = nfcCanonical(a);
      cb = nfcCanonical(b);
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

  // version, algorithm, and linkageStrategy are compared by raw equality rather
  // than the nfcCanonical fold used for the user-authored name fields below. All
  // three are schema-constrained to ASCII -- version to a semver string
  // (/^\d+\.\d+\.\d+$/), algorithm to a fixed enum ("psi" | "psi-c"), and
  // linkageStrategy to a fixed enum ("cascade" | "single-pass") -- so none can
  // ever differ by Unicode normalization form, and the NFC fold would be a no-op.
  // (Semver range matching, as opposed to exact equality, is a cross-cutting
  // concern that belongs in core's validateCompatibility, which also compares
  // version exactly.)
  if (existing.version !== incoming.version)
    add("version", existing.version, incoming.version);
  if (existing.algorithm !== incoming.algorithm)
    add("algorithm", existing.algorithm, incoming.algorithm);
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
    add("linkage_strategy", existing.linkageStrategy, incoming.linkageStrategy);
  // `output` and `deduplicate` are per-party (see this function's doc comment),
  // so they are intentionally not compared here.

  // Sort linkage fields by name (their order is not significant) before the
  // canonical compare; compare linkage keys in place (their order is). Sort on
  // the NFC-normalized name so the order agrees with the NFC fold the canonical
  // compare applies -- otherwise two field sets equal up to normalization could
  // sort differently (e.g. one party authored a name in NFD, the other in NFC)
  // and register as a false conflict.
  const byName = (a: { name: string }, b: { name: string }): number => {
    const x = a.name.normalize("NFC");
    const y = b.name.normalize("NFC");
    return x < y ? -1 : x > y ? 1 : 0;
  };
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

  const renderAgreement = (la: LinkageTerms["legalAgreement"]): string =>
    la === undefined
      ? RECONCILE_UNSET
      : `${la.reference} (expires ${la.expirationDate})`;
  if (
    canonicalDiffers(
      existing.legalAgreement ?? null,
      incoming.legalAgreement ?? null,
      "legal agreement",
    )
  )
    add(
      "legal_agreement",
      renderAgreement(existing.legalAgreement),
      renderAgreement(incoming.legalAgreement),
    );

  const renderPayload = (p: LinkageTerms["payload"]): string =>
    p === undefined
      ? RECONCILE_UNSET
      : `send=${renderNames(p.send ?? [])} receive=${renderNames(p.receive ?? [])}`;
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
 * Render a list of {@link ReconcileDiff} as an indented, human-readable block
 * for a reconciliation error message.
 *
 * The rendered values are escaped through {@link sanitizeForDisplay}: both sides
 * can carry partner-controlled, attacker-shaped strings -- the invitation's
 * linkage field/key names, and (for an online split accept) the inviter's own
 * `inbound_path`/`outbound_path` from the connection endpoint -- and this block
 * is printed to the acceptor's terminal before acceptance, so an unescaped value
 * could inject control/ANSI sequences or spoof a log line. The `field` is a
 * static, code-built path, so it is left as is. Ordinary values pass through
 * unchanged.
 */
export function formatReconcileDiffs(diffs: ReconcileDiff[]): string {
  return diffs
    .map(
      (d) =>
        `  - ${d.field}: existing ${sanitizeForDisplay(d.existing)} vs ` +
        `required ${sanitizeForDisplay(d.incoming)}`,
    )
    .join("\n");
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
 * `sftp` is rejected with a {@link UsageError} before anything is written. The
 * sole caller {@link establishHostKeyTrust} already no-ops off sftp, so this
 * never fires today; it enforces the invariant at the function for a future
 * direct caller that would otherwise synthesize a bogus pin and a `server`
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
          typeof channel === "string"
            ? `"${sanitizeForDisplay(channel)}"`
            : "absent or non-scalar";
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

// --- Config reader -----------------------------------------------------------

/**
 * The portion of a pre-existing config that `invite` uses as the source for an
 * invitation: the linkage terms (which the invitation carries) and the explicit
 * data standardization and metadata, if any (which the config-vs-input
 * reconciliation honors so it resolves columns to linkage fields exactly as the
 * eventual exchange does). The connection block is intentionally omitted --
 * `invite` does not use it.
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
}

/**
 * Read the linkage-terms source from a pre-existing config file, for `invite`'s
 * config-as-source path. Returns `undefined` when no file exists at `configPath`
 * (the caller then falls back to inferring terms from an input file).
 *
 * Only the `linkage_terms` and `standardization` blocks are parsed and
 * validated: a config present at the target path is the authoritative source of
 * the invitation's linkage terms, but `invite` never uses the connection (the
 * config persists for a later `psilink exchange` to read and validate), so a
 * still-placeholder or otherwise unfinished connection block must not block
 * generating an invitation.
 *
 * A file that exists but cannot be read, is not valid YAML, carries no valid
 * `linkage_terms`, or carries an invalid `standardization` is a {@link UsageError}
 * rather than a silent fall-through to input inference: a config present at the
 * path is treated as intentional, so a broken one is surfaced for the user to
 * fix. Mirrors {@link saveConfig}'s snake_case-on-disk convention -- the
 * top-level keys are read as either `linkage_terms`/`standardization` (the
 * written form) or their camelCase spellings, and `safeParseLinkageTerms`
 * camelizes the nested keys.
 */
export function loadConfigLinkageSource(
  configPath: string,
): ConfigLinkageSource | undefined {
  // Read, then parse through the sensitive-file chokepoint. A read failure
  // carries only a path and errno (ENOENT means no config, not an error here); a
  // YAML parse can echo source bytes (an inline credential), so it routes through
  // parseSensitiveYaml, which reports path-only (see sensitiveFile.ts).
  let source: string;
  try {
    source = fs.readFileSync(configPath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
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
  if (rawTerms === undefined)
    throw new UsageError(
      `config file ${configPath} has no linkage_terms and cannot be used as ` +
        "the source for an invitation; supply an input file or a configuration " +
        "that defines linkage terms",
    );

  const result = safeParseLinkageTerms(rawTerms);
  if (!result.success)
    throw new UsageError(
      `config file ${configPath} has invalid linkage_terms: ` +
        result.error.issues
          .map((i) => {
            // Prefix each issue with its field path (e.g. "linkageKeys.0.name")
            // so the user can locate the offending field, mirroring accept's
            // decode-error formatting. The path is relative to linkage_terms.
            // Escape each path segment through sanitizeForDisplay before joining,
            // matching describeDecodeError's contract: harden the path components
            // this formatter owns, relay the issue message unchanged.
            const at =
              i.path.length > 0
                ? `${i.path.map((p) => sanitizeForDisplay(String(p))).join(".")}: `
                : "";
            return `${at}${i.message}`;
          })
          .join("; "),
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
          stdResult.error.issues
            .map((i) => {
              // Escape each path segment, like the linkage_terms branch above.
              const at =
                i.path.length > 0
                  ? `${i.path.map((p) => sanitizeForDisplay(String(p))).join(".")}: `
                  : "";
              return `${at}${i.message}`;
            })
            .join("; "),
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
          metaResult.error.issues
            .map((i) => {
              // Escape each path segment, like the linkage_terms branch above.
              const at =
                i.path.length > 0
                  ? `${i.path.map((p) => sanitizeForDisplay(String(p))).join(".")}: `
                  : "";
              return `${at}${i.message}`;
            })
            .join("; "),
      );
    metadata = metaResult.data;
  }

  return { linkageTerms: result.data, standardization, metadata };
}
