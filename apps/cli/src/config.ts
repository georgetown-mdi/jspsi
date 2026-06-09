import YAML from "yaml";
import type {
  ConnectionConfig,
  ExchangeSpec,
  LinkageTerms,
} from "@psilink/core";
import {
  canonicalString,
  CanonicalEncodingError,
  OPAQUE_VALUE_KEYS,
  safeParseFileSyncOptions,
  UsageError,
} from "@psilink/core";

import { writeFileOwnerOnly } from "./fileUtils";

/**
 * Default path for the exchange config file written by the provisioning
 * commands (`invite`, `accept`, and `exchange --save`). Matches the default the
 * `exchange` command reads from, so a config written here is found without an
 * explicit `--config-file`.
 */
export const DEFAULT_CONFIG_PATH = "./psilink.yaml";

export interface ConnectionOverrides {
  connectionTimeout?: number;
  peerTimeout?: number;
  maxReconnectAttempts?: number;
  serverUsername?: string;
  serverPassword?: string;
  serverPrivateKey?: string;
  serverPort?: number;
  locklessRendezvous?: boolean;
  peerId?: string;
  retainFiles?: boolean;
  timestampInFilename?: boolean;
}

export function applyConnectionOverrides(
  connection: ConnectionConfig,
  overrides: ConnectionOverrides,
): ConnectionConfig {
  const result = structuredClone(connection);

  if (result.channel === "sftp") {
    const { server } = result;
    if (overrides.serverUsername !== undefined)
      server.username = overrides.serverUsername;
    if (overrides.serverPassword !== undefined)
      server.password = overrides.serverPassword;
    if (overrides.serverPrivateKey !== undefined)
      server.privateKey = overrides.serverPrivateKey;
    if (overrides.serverPort !== undefined) server.port = overrides.serverPort;
  }

  if (
    overrides.peerTimeout !== undefined ||
    overrides.connectionTimeout !== undefined ||
    overrides.maxReconnectAttempts !== undefined
  ) {
    result.options = {
      ...result.options,
      ...(overrides.peerTimeout !== undefined && {
        peerTimeoutMs: overrides.peerTimeout * 1000,
      }),
      ...(overrides.connectionTimeout !== undefined && {
        serverConnectTimeoutMs: overrides.connectionTimeout * 1000,
      }),
      ...(overrides.maxReconnectAttempts !== undefined && {
        maxReconnectAttempts: overrides.maxReconnectAttempts,
      }),
    };
  }

  // locklessRendezvous, peerId, retainFiles, and timestampInFilename are
  // FileSyncOptions fields; only apply them on channels that use
  // FileSyncConnection. The other overrides above (peerTimeout etc.) are
  // SharedOptions that apply to all channels including webrtc.
  if (
    (result.channel === "sftp" || result.channel === "filedrop") &&
    (overrides.locklessRendezvous !== undefined ||
      overrides.peerId !== undefined ||
      overrides.retainFiles !== undefined ||
      overrides.timestampInFilename !== undefined)
  ) {
    result.options = {
      ...result.options,
      ...(overrides.locklessRendezvous !== undefined && {
        locklessRendezvous: overrides.locklessRendezvous,
      }),
      ...(overrides.peerId !== undefined && {
        peerId: overrides.peerId,
      }),
      ...(overrides.retainFiles !== undefined && {
        retainFiles: overrides.retainFiles,
      }),
      ...(overrides.timestampInFilename !== undefined && {
        timestampInFilename: overrides.timestampInFilename,
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

    // Re-validate the merged options through FileSyncOptionsSchema so that
    // all constraints (min length, timestampInFilename dependency, reserved
    // values) are enforced from one place rather than mirrored here.
    // Re-validate whenever any FileSyncOptions field is overridden, not just
    // peerId/retainFiles, so future cross-field constraints on locklessRendezvous
    // are not silently bypassed.
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
 */
function nfcDeep(value: unknown): unknown {
  if (typeof value === "string") return value.normalize("NFC");
  if (Array.isArray(value)) return value.map(nfcDeep);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, nfcDeep(v)]),
    );
  return value;
}

/**
 * Canonical (RFC 8785) encoding of a value after NFC-normalizing its strings,
 * for an order-stable, Unicode-insensitive structural equality check. The
 * canonical encoder sorts object keys, so property-insertion order does not
 * affect the result; array order is preserved, so the caller pre-sorts any list
 * whose order is not significant.
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
 * algorithm, linkage fields and keys, legal agreement, and payload -- must
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

  // version and algorithm are compared by raw equality rather than the
  // nfcCanonical fold used for the user-authored name fields below. Both are
  // schema-constrained to ASCII -- version to a semver string (/^\d+\.\d+\.\d+$/)
  // and algorithm to a fixed enum ("psi" | "psi-c") -- so neither can ever differ
  // by Unicode normalization form, and the NFC fold would be a no-op. (Semver
  // range matching, as opposed to exact equality, is a cross-cutting concern that
  // belongs in core's validateCompatibility, which also compares version exactly.)
  if (existing.version !== incoming.version)
    add("version", existing.version, incoming.version);
  if (existing.algorithm !== incoming.algorithm)
    add("algorithm", existing.algorithm, incoming.algorithm);
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
 */
export function formatReconcileDiffs(diffs: ReconcileDiff[]): string {
  return diffs
    .map(
      (d) => `  - ${d.field}: existing ${d.existing} vs required ${d.incoming}`,
    )
    .join("\n");
}

// --- Config writer -----------------------------------------------------------

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/**
 * Recursively rewrites object keys from camelCase to snake_case. The inverse of
 * core's `camelizeKeys` for the keys the exchange schema uses: every config key
 * originates as snake_case, so write-then-read round-trips unchanged (the
 * round-trip is covered by a test). It is not a general camelCase inverse -- an
 * embedded acronym such as `URL` would snakeize to `u_r_l` -- but no such key
 * occurs in the schema. Only keys are rewritten; string values (e.g. the
 * `firstName` in `type: firstName`) are left verbatim, matching the read path.
 *
 * Opaque-value maps (`OPAQUE_VALUE_KEYS`, currently `connection.provider_options`)
 * are skipped symmetrically with `camelizeKeys`: the map's own key is snakeized,
 * but its contents are left verbatim so a user-authored key (snake or camel)
 * survives byte-for-byte to disk and back. The shared `OPAQUE_VALUE_KEYS` set
 * keeps the read and write paths excluding exactly the same subtrees, preserving
 * the write -> read round-trip invariant. Function-specific `params` blocks are
 * NOT opaque -- they are psilink's own vocabulary and stay normalized.
 *
 * The opaque check consults the raw key directly (`OPAQUE_VALUE_KEYS.has(k)`),
 * with no casing normalization. This is correct, and the asymmetry with
 * `camelizeKeys` -- which normalizes via its own `snakeToCamel` before the same
 * check -- is deliberate, because the two functions have different input
 * domains. `camelizeKeys` reads user YAML whose key casing is unknown
 * (conventionally snake_case), so it must normalize to the canonical camelCase
 * form first. `snakeizeKeys` is only ever called by `saveConfig` on a typed
 * `ExchangeSpec`, whose opaque key is always the camelCase `providerOptions`, so
 * the raw key already matches the camelCase-keyed set and normalizing would be
 * dead code. Re-introducing a `snakeToCamel` helper here to force symmetry would
 * duplicate core's private copy across the package boundary -- the CLI builds
 * against core's dist, so the two cannot share a private helper without widening
 * core's export surface -- and a silent drift between the copies would break the
 * very round-trip invariant the shared set exists to guarantee.
 */
function snakeizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeizeKeys);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) =>
        // Raw-key check: `k` is already canonical camelCase here (a typed
        // ExchangeSpec from saveConfig), so the opaque key matches the
        // camelCase-keyed set as-is -- see the note above on why this writer
        // does not normalize.
        OPAQUE_VALUE_KEYS.has(k)
          ? [camelToSnake(k), v]
          : [camelToSnake(k), snakeizeKeys(v)],
      ),
    );
  return value;
}

/**
 * Serialize an {@link ExchangeSpec} and write it to `configPath` as snake_case
 * YAML, owner-read-only -- a config may carry inline SFTP credentials
 * (`server.password`, `server.privateKey`), so it gets the same `0600` / ACL
 * protection as the key file via {@link writeFileOwnerOnly}.
 *
 * The PAKE token and its expiration live only in the key file and never belong
 * in the config; they are stripped from `connection.authentication` here even
 * if a caller leaves them populated, so the secret cannot be duplicated onto
 * disk (and cannot go stale after token rotation). The caller's spec is not
 * mutated.
 *
 * Does not guard against overwriting an existing file; callers provision through
 * `provisionConfigAndKey`, which runs the conflict gate first.
 */
export function saveConfig(configPath: string, spec: ExchangeSpec): void {
  const sanitized = structuredClone(spec);
  const auth = sanitized.connection.authentication;
  if (auth) {
    delete auth.pakeToken;
    delete auth.expires;
    // Drop the container if those were its only keys, so the config carries no
    // noisy empty `authentication: {}` block. WebRTC's `role` (the only other
    // field) keeps it non-empty when present.
    if (Object.keys(auth).length === 0)
      delete sanitized.connection.authentication;
  }
  writeFileOwnerOnly(configPath, YAML.stringify(snakeizeKeys(sanitized)));
}
