import fs from "node:fs";

import YAML from "yaml";
import type {
  ConnectionConfig,
  ExchangeSpec,
  LinkageTerms,
  Standardization,
} from "@psilink/core";
import {
  canonicalString,
  CanonicalEncodingError,
  safeParseFileSyncOptions,
  safeParseLinkageTerms,
  snakeizeKeys,
  StandardizationSchema,
  UsageError,
} from "@psilink/core";

import { writeFileOwnerOnly } from "./fileUtils";
import {
  parseSensitiveYaml,
  parseSensitiveYamlDocument,
  serializeSensitiveYamlDocument,
} from "./sensitiveFile";

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
 */
export function persistHostKeyFingerprint(
  configPath: string,
  fingerprint: string,
): void {
  // Parse, edit, and re-serialize through the sensitive-file chokepoint, which
  // closes the syntax-error, deferred-alias, and warning leak channels in one
  // place (see sensitiveFile.ts). The document model preserves the operator's
  // comments and key order on this surgical one-field write.
  const label = `config file ${configPath}`;
  const doc = parseSensitiveYamlDocument(
    fs.readFileSync(configPath, "utf8"),
    label,
  );
  // setIn creates the connection/server path nodes if absent; for an sftp config
  // loaded by the exchange command they already exist, so this updates the one
  // field. snake_case path matches the written convention (see saveConfig). A
  // config that parses but whose `connection`/`server` is a scalar or sequence
  // (not a mapping) makes setIn throw a YAML error naming the path key (not a
  // value), so it is safe to surface as the UsageError this function's contract
  // promises (mapped to exit 64) rather than an opaque library stack trace. On
  // the exchange call path the schema load has already rejected such a shape, so
  // this guards a hand-edit between load and write, or a caller that skips
  // validation.
  try {
    doc.setIn(["connection", "server", "host_key_fingerprint"], fingerprint);
  } catch (err) {
    throw new UsageError(
      `config file ${configPath} could not be updated to persist the host-key ` +
        `fingerprint (${err instanceof Error ? err.message : String(err)}); ` +
        `connection.server must be a mapping.`,
    );
  }
  const serialized = serializeSensitiveYamlDocument(doc, label);
  writeFileOwnerOnly(configPath, serialized);
}

// --- Config reader -----------------------------------------------------------

/**
 * The portion of a pre-existing config that `invite` uses as the source for an
 * invitation: the linkage terms (which the invitation carries) and the explicit
 * data standardization, if any (which the config-vs-input reconciliation honors
 * so an input column the standardization maps to a linkage field counts as
 * satisfying it). Metadata and the connection block are intentionally omitted --
 * `invite` does not use them.
 */
export interface ConfigLinkageSource {
  linkageTerms: LinkageTerms;
  /** The config's explicit `standardization` block, absent when not present. */
  standardization?: Standardization;
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
            const at = i.path.length > 0 ? `${i.path.join(".")}: ` : "";
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
              const at = i.path.length > 0 ? `${i.path.join(".")}: ` : "";
              return `${at}${i.message}`;
            })
            .join("; "),
      );
    standardization = stdResult.data;
  }

  return { linkageTerms: result.data, standardization };
}
