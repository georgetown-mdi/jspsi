import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

import type { Argv, Arguments } from "yargs";
import logLibrary from "loglevel";

import {
  getLogger,
  loadCSVFile,
  prepareForExchange,
  inferMetadata,
  getDefaultLinkageTerms,
  getDefaultStandardization,
  inferDateFormat,
  normalizeFiledropPath,
  sanitizeErrorForDisplay,
  UsageError,
} from "@psilink/core";
import type {
  ConnectionConfig,
  ConnectionEndpoint,
  ExchangeSpec,
  ExchangeDataSpec,
  FileDropConnectionConfig,
  LinkageField,
  LinkageTerms,
  PreparedExchange,
  SFTPConnectionConfig,
  Standardization,
  WebRTCConnectionConfig,
} from "@psilink/core";

import {
  applyConnectionOverrides,
  saveConfig,
  type ConnectionOverrides,
  type ReconcileDiff,
  RECONCILE_UNSET,
  DEFAULT_CONFIG_PATH,
} from "../config";
import { detectFileConflicts } from "../fileUtils";
import { DEFAULT_KEY_PATH } from "../keyFile";
import { resolveConnectionCredentials } from "../util/atSignRefs";
import {
  durationFlagSeconds,
  LOG_LEVELS,
  singleValue,
  openInputSource,
} from "../util/cli";
import { DURATION_VALUE_HELP } from "../util/duration";
import { runProtocol, type AuthPersist } from "../protocol";
import {
  decodeUrlComponent,
  redactUrlCredentials,
} from "../util/connectionUrl";
import { channelFromURL } from "./zeroSetup";
import type { RecordOutput } from "../recordFile";

// The exchange-data portion of a spec: linkage terms (always present once
// resolved) plus the optional metadata and standardization. Distinct from
// core's ExchangeDataSpec, whose linkageTerms is Partial because it models the
// not-yet-resolved input to prepareForExchange; here resolution has happened.
export type ResolvedDataSpec = Omit<ExchangeSpec, "connection">;

// The connection channels the CLI can actually run an exchange over: runProtocol
// supports sftp and filedrop, and a webrtc URL is rejected upstream. Narrowing
// to this (rather than the full ConnectionConfig) keeps a webrtc config from
// reaching runOnlineBootstrap, where it would otherwise only fail at runtime.
export type RunnableConnectionConfig = Extract<
  ConnectionConfig,
  { channel: "sftp" | "filedrop" }
>;

// The placeholder host/username written into a config when the inviter did not
// supply a connection endpoint. Chosen to be obvious in a diff and to fail
// loudly (rather than silently connect somewhere) if the user runs `exchange`
// before editing them. The string is intentionally not a valid hostname.
const PLACEHOLDER_HOST = "REPLACE_WITH_SFTP_HOST";
const PLACEHOLDER_USERNAME = "REPLACE_WITH_SSH_USERNAME";

// Default time the inviter waits, from printing the invitation to receiving the
// partner's acceptance, before giving up. 15 minutes, per docs/SECURITY_DESIGN.md.
export const DEFAULT_ACCEPT_TIMEOUT_SECONDS = 15 * 60;

// --- URL / endpoint -> connection -------------------------------------------

/**
 * True when `value` parses as a URL whose scheme is one the CLI understands as
 * a transport (`sftp`, `ssh`, `ws`, `wss`, `file`). Used to tell an online
 * invocation (first positional is a server URL) from an offline one (first
 * positional is an input file or invitation string). Restricting to the known
 * schemes means a Windows path (`C:\data.csv`), an `@path` reference, a
 * base64url invitation, or a bare filename is never mistaken for a URL.
 *
 * @internal exported for testing
 */
export function looksLikeUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return ["sftp:", "ssh:", "ws:", "wss:", "file:"].includes(url.protocol);
}

/**
 * Build a connection config from a server URL, for the online invite/accept
 * paths. Mirrors the zero-setup mapping but is constrained to the channels the
 * CLI can actually run: a `webrtc` (ws/wss) URL or an unsupported scheme is a
 * usage error. The returned config carries no `authentication`; the caller adds
 * the shared secret separately for the handshake and never persists it to the
 * config.
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
  // preserved) -- no separate equality rule to drift from it. The `undefined`
  // branch is defensive only: a filedrop `path` is schema-required, so it does
  // not fire on a parsed config.
  const norm = (p: string | undefined): string | undefined =>
    p === undefined ? undefined : normalizeFiledropPath(p);
  return norm(a) === norm(b);
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

    // host/path -> conflict (which drop you are meeting at).
    if (!hostsEqual(have.host, want.host))
      conflicts.push({
        field: "connection.server.host",
        existing: have.host,
        incoming: want.host,
      });
    if (want.path !== undefined && !sftpPathsEqual(have.path, want.path))
      conflicts.push({
        field: "connection.server.path",
        existing: have.path ?? RECONCILE_UNSET,
        incoming: want.path,
      });

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
  } else if (target.channel === "filedrop") {
    // filedrop's only locator is the path -> conflict. No port/credentials apply.
    const havePath = (existing as FileDropConnectionConfig).path;
    if (!filedropPathsEqual(havePath, target.path))
      conflicts.push({
        field: "connection.path",
        existing: havePath ?? RECONCILE_UNSET,
        incoming: target.path,
      });
  }
  // webrtc never reaches here: connectionFromURL rejects a ws/wss URL before the
  // target is built, so `target` is only ever sftp/filedrop, and a webrtc
  // existing config is caught by the channel mismatch above.

  return { conflicts, warnings };
}

/**
 * Result of {@link connectionFromEndpoint}: the connection block to write into
 * the acceptor's config, and whether it was seeded from the invitation's
 * endpoint (so the caller can tailor the "you still need to ..." notice).
 */
export interface SeededConnection {
  connection: ConnectionConfig;
  /** True when seeded from an invitation endpoint; false for a placeholder. */
  seeded: boolean;
}

/**
 * Build the connection block for a config written without a server URL (the
 * offline accept path, and the offline invite path). When the invitation
 * carries a credential-free `connectionEndpoint`, seed the locator from it and
 * mark the credential field with a `REPLACE_WITH_...` placeholder for the user
 * to fill in (the endpoint never carries credentials, by construction). When it
 * does not, write a clearly-marked `sftp` placeholder the user replaces wholesale.
 *
 * The endpoint's `path` is the inviter's own (for `filedrop`, possibly a mount
 * the acceptor must remap); it is written verbatim for the user to review.
 *
 * @internal exported for testing
 */
export function connectionFromEndpoint(
  endpoint: ConnectionEndpoint | undefined,
): SeededConnection {
  if (endpoint === undefined) {
    const connection: SFTPConnectionConfig = {
      channel: "sftp",
      server: { host: PLACEHOLDER_HOST, username: PLACEHOLDER_USERNAME },
    };
    return { connection, seeded: false };
  }

  switch (endpoint.channel) {
    case "sftp": {
      const connection: SFTPConnectionConfig = {
        channel: "sftp",
        server: {
          host: endpoint.host,
          port: endpoint.port,
          path: endpoint.path,
          // The endpoint never carries credentials; mark the field the user
          // must supply (a password or private key is added via @path).
          username: PLACEHOLDER_USERNAME,
        },
      };
      return { connection, seeded: true };
    }
    case "filedrop": {
      const connection: FileDropConnectionConfig = {
        channel: "filedrop",
        path: endpoint.path,
      };
      return { connection, seeded: true };
    }
    case "webrtc": {
      // The CLI cannot yet run a webrtc exchange, but the config is written
      // faithfully so the locator is preserved for when it can (and for the
      // web app). webrtc needs no credential placeholder: it authenticates
      // from the shared secret, not a username/password.
      const connection: WebRTCConnectionConfig = {
        channel: "webrtc",
        server: {
          host: endpoint.host,
          port: endpoint.port,
          path: endpoint.path,
        },
      };
      return { connection, seeded: true };
    }
  }
}

// --- shared secret --------------------------------------------------------------

// Secret generation lives in @psilink/core (one definition shared with the web
// inviter, per the CONTRIBUTING rule against re-implementing crypto helpers);
// re-exported here so the CLI's invitation call sites keep importing it from this
// module.
export { generateSharedSecret } from "@psilink/core";

/** ISO 8601 datetime `durationSeconds` from now, for an invitation's `expires`. */
export function expiresFromNow(durationSeconds: number): string {
  return new Date(Date.now() + durationSeconds * 1000).toISOString();
}

// --- Input data --------------------------------------------------------------

/**
 * Load and parse a CSV input into raw rows and column names. `input` is a file
 * path or `-` for stdin; the caller gates stdin via `allowStdin` because the two
 * commands sharing this loader differ on it -- `invite` supports `-`, `accept`
 * rejects it (it reads its confirmation prompt from stdin). Defaults to stdin
 * disabled so the shared loader never enables it unconditionally.
 */
export async function loadInputRows(
  input: string,
  { allowStdin = false }: { allowStdin?: boolean } = {},
): Promise<{ rawRows: Array<Record<string, string>>; columns: string[] }> {
  const csvResult = await loadCSVFile(openInputSource(input, { allowStdin }));
  return {
    rawRows: csvResult.data as Array<Record<string, string>>,
    columns: csvResult.meta.fields ?? [],
  };
}

/**
 * Resolve the exchange-data portion of a config.
 *
 * - With input rows: infer metadata, then either infer linkage terms (invite,
 *   `terms` undefined) or use the supplied terms (accept). Standardization is
 *   inferred best-effort; if the input columns cannot satisfy the terms'
 *   linkage keys, a warning is collected and standardization (and metadata) are
 *   omitted so the user can adjust their data -- the linkage terms are still
 *   written.
 * - Without input rows (accept with no input file): `terms` is required and the
 *   spec is just those terms.
 */
export function buildDataSpec(args: {
  terms?: LinkageTerms;
  identity: string;
  rows?: { rawRows: Array<Record<string, string>>; columns: string[] };
}): { dataSpec: ResolvedDataSpec; warnings: string[] } {
  const { terms, identity, rows } = args;
  const warnings: string[] = [];

  if (rows === undefined) {
    if (terms === undefined)
      // Unreachable through the CLI (offline invite always has input, accept
      // always has terms); guards a future caller against an empty spec.
      throw new Error("buildDataSpec requires either terms or input rows");
    return { dataSpec: { linkageTerms: terms }, warnings };
  }

  const metadata = inferMetadata(rows.columns);
  const linkageTerms = terms ?? getDefaultLinkageTerms(identity, metadata);

  const dobCol = metadata.find((c) => c.type === "dateOfBirth");
  const dateInputFormat =
    dobCol !== undefined
      ? inferDateFormat(rows.rawRows.map((r) => r[dobCol.name] ?? ""))
      : undefined;

  try {
    const standardization = getDefaultStandardization(metadata, linkageTerms, {
      dateInputFormat,
    });
    return { dataSpec: { linkageTerms, metadata, standardization }, warnings };
  } catch (err) {
    // The input columns cannot be standardized to satisfy the linkage keys
    // (only reachable when the terms come from an invitation, not when they are
    // inferred from this same input). Keep the terms; drop the unusable
    // metadata/standardization and let the user adapt their data.
    warnings.push(
      "input columns may not satisfy the invitation's linkage keys: " +
        (err instanceof Error ? err.message : String(err)) +
        "; writing the config without metadata or standardization",
    );
    return { dataSpec: { linkageTerms }, warnings };
  }
}

/**
 * The linkage fields in `terms` that the input `columns` cannot satisfy through
 * the available data standardizations, for `invite`'s config-vs-input
 * reconciliation. This mirrors how {@link buildStandardizedDataset} resolves a
 * linkage field to an input column at exchange time: a field is producible when
 *
 * 1. the config carries an explicit `standardization` for it whose source input
 *    column is present (an explicit transformation is the most direct available
 *    standardization), OR
 * 2. the field has NO explicit standardization and the input has a column whose
 *    inferred semantic type matches the field's type (the default pipeline /
 *    identity transform).
 *
 * An explicit standardization preempts the type fallback at exchange time:
 * {@link buildStandardizedDataset} binds the field to the named input column and
 * skips identity-by-type resolution whether or not that column exists. So a field
 * whose explicit source column is absent is unsatisfiable even when a same-typed
 * column is present -- the exchange would bind it to the missing column and emit
 * no values. The type-match basis (2) is sound because a `LinkageField`'s type is
 * restricted to the standardizable semantic types -- the `other`/`identifier`
 * types `inferMetadata` assigns to unrecognized input columns can appear in the
 * input's type set but never as a linkage-field type (the schema rejects them),
 * and every permitted field type has a default pipeline. An empty result means
 * every configured field can be produced; a non-empty result names the fields
 * that cannot, so the caller can reject the input and say which keys it failed to
 * satisfy.
 *
 * @internal exported for testing
 */
export function unsatisfiedLinkageFields(
  columns: string[],
  terms: LinkageTerms,
  standardization?: Standardization,
): LinkageField[] {
  const present = new Set(columns);
  const inputTypes = new Set(inferMetadata(columns).map((c) => c.type));
  // Field name -> the input column its explicit standardization reads. The schema
  // permits at most one transformation per output, so a Map is exact. A field
  // present here is resolved by the explicit transformation at exchange time
  // (which preempts the type fallback), so it is producible iff that column
  // exists; a field absent here falls back to semantic-type coverage.
  const explicitInput = new Map(
    (standardization ?? []).map((t) => [t.output, t.input]),
  );
  return terms.linkageFields.filter((f) => {
    const mapped = explicitInput.get(f.name);
    if (mapped !== undefined) return !present.has(mapped);
    return !inputTypes.has(f.type);
  });
}

/** Build a {@link PreparedExchange} for an online run from a resolved spec. */
export async function prepareForOnlineExchange(
  dataSpec: ResolvedDataSpec,
  identity: string,
  rows: { rawRows: Array<Record<string, string>>; columns: string[] },
): Promise<PreparedExchange> {
  const prepared = prepareForExchange(
    dataSpec as ExchangeDataSpec,
    identity,
    rows.rawRows,
    rows.columns,
  );
  const log = getLogger("psilink");
  for (const warning of prepared.warnings)
    log.warn("cleaning configuration issue:", warning);
  return prepared;
}

// --- Online exchange ---------------------------------------------------------

/**
 * Run the connect -> key exchange -> exchange path shared by online invite
 * and online accept, persisting the config at the moment the handshake
 * succeeds. `runProtocol` opens the connection, completes the handshake with
 * `sharedSecret`/`expires`, writes the rotated (persistent, no-expiry) token to
 * `keyPath`, then -- via the `onAuthenticated` post-handshake hook passed below
 * -- writes the config, and finally runs the exchange.
 *
 * Persisting from the hook (rather than after `runProtocol` returns) means a
 * handshake that succeeds but whose data exchange then fails leaves both the
 * rotated key and the config on disk, so the recurring-exchange setup is
 * recoverable without re-inviting. A handshake that never succeeds (declined,
 * expired, or unreachable partner) never reaches the hook, so it still leaves
 * no config behind. A failure of the config write itself is non-fatal: the
 * exchange still runs (see `onAuthenticated`), and the error -- already logged
 * by `runProtocol` -- is returned as `configWriteError` so the caller can report
 * the truthful outcome instead of claiming the config was saved.
 *
 * When the exchange itself fails after the config was already written, this
 * function logs that the config and key are on disk -- so the user retries with
 * `psilink exchange` rather than re-inviting -- and then rejects with the
 * exchange error (the handler's error path surfaces the error itself). The note
 * is logged only when the config write actually succeeded, so a hook failure
 * followed by an exchange failure never claims a config that is not there.
 *
 * The persisted config carries the plain `connection` (no `authentication`);
 * `saveConfig` strips any shared-secret material regardless, so moving the write
 * into the hook changes only when the config is persisted, not what is persisted.
 *
 * With `reuseExistingConfig`, the config write is skipped entirely: the accept
 * path has already reconciled a pre-existing config against the invitation and
 * the URL and keeps it untouched (the rotated key is still saved by
 * `runProtocol`). Otherwise the hook re-gates the config path immediately before
 * writing -- so a config that appeared between the pre-network conflict check
 * and this write is not silently overwritten, matching the offline path's
 * `provisionConfigAndKey` re-gate -- and surfaces a conflict as a non-fatal
 * `configWriteError` rather than aborting the already-completed exchange.
 */
export async function runOnlineBootstrap(params: {
  connection: RunnableConnectionConfig;
  dataSpec: ResolvedDataSpec;
  prepared: PreparedExchange;
  sharedSecret: string;
  expires: string | undefined;
  keyPath: string;
  configPath: string;
  output: string | undefined;
  verbosity: number;
  loggerName: string;
  recordOutput?: RecordOutput;
  /** Keep a pre-existing, already-reconciled config: skip the config write. */
  reuseExistingConfig?: boolean;
}): Promise<{ configWriteError?: unknown }> {
  // `connection` is already narrowed to the channels runProtocol supports
  // (RunnableConnectionConfig); authentication is passed to runProtocol on its
  // own parameter rather than embedded in the connection config.
  const auth: AuthPersist = {
    sharedSecret: params.sharedSecret,
    expires: params.expires,
    keyFilePath: params.keyPath,
  };

  // Resolve `@path` credential refs for the live connection only. params.connection
  // keeps the `@path` so the saveConfig in the hook below persists the reference,
  // not the secret -- the @path is re-resolved at the next `psilink exchange`'s
  // config load. A missing or unreadable referenced file is a UsageError (exit
  // 64) surfaced here, before the connection is opened. The cast restores the
  // RunnableConnectionConfig narrowing the resolver widens to ConnectionConfig;
  // it is safe because the resolver preserves the channel (it only reads the SFTP
  // credential fields).
  const liveConnection = resolveConnectionCredentials(
    params.connection,
  ) as RunnableConnectionConfig;

  // Set inside the hook once saveConfig returns, so the catch below can tell a
  // "config is on disk, retry without re-inviting" recovery from a run where the
  // config write never succeeded (hook threw, or handshake never reached it).
  let configWritten = false;
  // Set at the very top of the hook, before the reuse early-return. runProtocol
  // saves the rotated key immediately before invoking onAuthenticated, so
  // reaching the hook is proof the key is on disk. The reuse branch keeps a
  // pre-existing config and writes no fresh one (configWritten stays false), so
  // without this flag the catch below could not tell a reuse run whose handshake
  // succeeded (key saved) from one that failed pre-handshake (no key) -- and
  // would falsely promise `psilink exchange` recovery in the latter.
  let keyPersisted = false;
  try {
    const { onAuthenticatedError } = await runProtocol(
      liveConnection,
      auth,
      params.prepared,
      params.output,
      params.verbosity,
      params.loggerName,
      params.recordOutput,
      // saveIntent: the zero-setup `--save` bootstrap is meaningful only on the
      // unauthenticated path; this is an authenticated exchange, so leave it unset.
      undefined,
      // Persist the configuration exactly at acceptance: runProtocol invokes this
      // once, after the rotated token is saved to the key file and before the
      // data exchange begins. Writing here (rather than after runProtocol
      // returns) means a handshake success followed by a data-exchange failure
      // leaves both the rotated key and the config on disk -- no re-invite needed
      // to recover.
      //
      // saveConfig is synchronous, so `configWritten` is set only after the write
      // has completed and a failed write throws before it -- which is what
      // runProtocol's onAuthenticatedError and the catch below depend on.
      // runProtocol awaits this hook's return, so if saveConfig is ever made
      // async the fix is to make this hook `async` and `await` the call: an
      // awaited promise is handled correctly. The trap is an UNawaited async
      // saveConfig -- the hook would return (and set `configWritten`) before the
      // write settles, so a rejected write would resolve cleanly and masquerade
      // as a success.
      () => {
        // Reaching the hook means runProtocol already saved the rotated key
        // (it does so immediately before this call). Record that before the
        // reuse early-return so the recovery message below is gated on the key
        // actually being on disk.
        keyPersisted = true;
        if (params.reuseExistingConfig) {
          // The reconcile check already confirmed the pre-existing config agrees
          // with the invitation and URL; keep it untouched. The rotated key is
          // saved by runProtocol above; nothing is written here, so
          // `configWritten` stays false (no fresh config was persisted).
          //
          // Unlike the offline path (provisionConfigAndKey re-gates the config's
          // presence before writing the key) and the non-reuse branch below
          // (which re-gates before saveConfig), there is deliberately no config
          // re-gate here: runProtocol already rotated and saved the key before
          // invoking this hook, so a config deleted during the handshake window
          // is unpreventable -- a check here could only re-report the orphan, not
          // avoid it. That window is the documented immaterial single-user TOCTOU
          // (see assertNoProvisionConflicts), so it is left as-is.
          return;
        }
        // Re-gate immediately before writing: a config that appeared between the
        // pre-network conflict check and now must not be silently overwritten,
        // consistent with the offline path's provisionConfigAndKey re-gate. The
        // handshake has already succeeded and the rotated key is saved, so this
        // throw becomes a non-fatal configWriteError (caught by runProtocol's
        // hook handling) rather than aborting the completed exchange.
        if (detectFileConflicts([params.configPath]).length > 0)
          throw new UsageError(
            `refusing to overwrite ${params.configPath}: a file appeared there ` +
              "after the initial conflict check. The exchange completed and the " +
              "rotated key was saved; move or remove that file (or pass " +
              "--config-file), then rerun 'psilink exchange' to recover without " +
              "re-inviting.",
          );
        saveConfig(params.configPath, {
          connection: params.connection,
          ...params.dataSpec,
        });
        configWritten = true;
      },
    );

    // onAuthenticatedError is the config-write failure, if any: the hook is just
    // the saveConfig call above, so surface it under a name the caller speaks.
    return { configWriteError: onAuthenticatedError };
  } catch (err) {
    // The exchange failed after a successful handshake. When BOTH the config and
    // the rotated key are on disk, tell the user so they retry with `psilink
    // exchange` instead of re-inviting, the exact recovery this bootstrap exists
    // to make possible. Logged at error level (matching runProtocol's rotation
    // advisory) so it stays visible alongside the error the handler then reports.
    // Both files must actually be present: a fresh run needs `configWritten` (the
    // hook persisted the config, which implies the key was already saved); a
    // reuse run keeps the pre-existing config but still needs `keyPersisted`,
    // since a pre-handshake failure (declined, expired, unreachable) never saves
    // the rotated key -- promising `psilink exchange` there would point at a key
    // that does not exist. A hook failure (config not written) likewise leaves
    // `configWritten` false, so it never claims a config that is not there.
    if (configWritten || (params.reuseExistingConfig && keyPersisted))
      getLogger(params.loggerName).error(
        `the configuration at ${params.configPath} and the rotated key at ` +
          `${params.keyPath} are on disk; retry with 'psilink exchange' to ` +
          `recover without re-inviting.`,
      );
    throw err;
  }
}

/**
 * Log the post-exchange outcome of an online invite/accept run. On a clean run
 * both files were written. When a pre-existing config was reused
 * (`reuseExistingConfig`), only the rotated key was saved and the config was
 * left untouched, so the message reflects that rather than claiming a fresh
 * write. When the config write failed at acceptance (`configWriteError` set),
 * the rotated key was still saved but the config was not, so the message must
 * not claim otherwise -- the underlying error was already logged at error level
 * by `runProtocol`, so this only corrects the summary and points back to it. The
 * failure summary is logged at `error` level, not `warn`, so it (and its
 * actionable recovery instruction) stays visible at `--log-level=error`, where
 * the error it references is also shown.
 */
export function logOnlineBootstrapOutcome(
  log: ReturnType<typeof getLogger>,
  params: {
    configFile: string;
    keyFile: string;
    configWriteError?: unknown;
    reuseExistingConfig?: boolean;
  },
): void {
  if (params.reuseExistingConfig && params.configWriteError === undefined) {
    // Reuse skips the config write, so there is normally no configWriteError; the
    // existing config stands and only the rotated key was saved. The
    // `configWriteError === undefined` guard makes that invariant explicit: a
    // contradictory error here is not swallowed as success but falls through to
    // the error branch below.
    log.info(
      `exchange complete; reused the existing configuration at ` +
        `${params.configFile} and saved the rotated key to ${params.keyFile}. ` +
        `Keep the key file private.`,
    );
    return;
  }
  if (params.configWriteError === undefined) {
    log.info(
      `exchange complete; saved config to ${params.configFile} and the ` +
        `rotated key to ${params.keyFile}. Keep the key file private.`,
    );
    return;
  }
  log.error(
    `exchange complete and the rotated key was saved to ${params.keyFile}, ` +
      `but the configuration could not be written to ${params.configFile} ` +
      `(its cause was logged when the write failed). The rotated key is saved, ` +
      `so you do not need to re-invite: recreate ${params.configFile} to match ` +
      `your connection and linkage settings before running a recurring ` +
      `'psilink exchange'. Keep the key file private.`,
  );
}

// --- Confirmation prompt -----------------------------------------------------

/**
 * Prompt the user to confirm on the terminal, returning true only on an
 * explicit yes. Anything else (including EOF or a non-interactive stdin)
 * defaults to no. Prompts on stderr so stdout stays reserved for exchange
 * results.
 */
export async function promptConfirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    // `rl.question()` never settles when stdin reaches EOF (a closed or
    // piped-empty stdin) -- a long-standing readline/promises behavior
    // (nodejs/node#53497). Race it against the interface's "close" event (which
    // does fire on EOF) so a closed stdin deterministically resolves to "no"
    // instead of leaving the promise pending -- which today exits silently via
    // event-loop drain and would deadlock outright if any handle were open here.
    const answer = await new Promise<string>((resolve) => {
      rl.once("close", () => resolve(""));
      void rl.question(`${question} [y/N] `).then(resolve, () => resolve(""));
    });
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

// --- Command execution -------------------------------------------------------

/**
 * Run a command body, mapping any thrown error to a process exit: a
 * {@link UsageError} to EX_USAGE (64), otherwise the error's own numeric
 * `exitCode` or EX_UNAVAILABLE (69). This is the single error->exit boundary for
 * the bootstrap commands; routing the whole handler body through it -- including
 * option parsing and the accept confirmation prompt -- means a thrown or
 * rejected step exits cleanly rather than crashing with an unhandled rejection.
 * The `?? exitCode` rung is load-bearing: `openInputSource` and `buildDataSpec`
 * throw plain `Error`s carrying `exitCode`, so a missing input file keeps its own
 * exit code rather than collapsing to 69.
 *
 * The error logger is created from `loggerName` lazily in the catch, so the body
 * is free to apply the configured log level (via `setDefaultLevel`) before
 * creating its own logger -- loglevel binds a logger's level at creation, so the
 * body's logger must be made after the level is set. `process.exit` is typed
 * `never`, so values produced inside `body` keep their definite-assignment
 * narrowing.
 */
export async function runOrExit(
  loggerName: string,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (err) {
    getLogger(loggerName).error(sanitizeErrorForDisplay(err));
    process.exit(
      err instanceof UsageError
        ? 64
        : ((err as { exitCode?: number }).exitCode ?? 69),
    );
  }
}

// --- Shared CLI options ------------------------------------------------------

/**
 * Per-command overrides for the descriptions of the common bootstrap options
 * whose accurate wording is command-specific -- chiefly whether the config/key
 * files are written or read, and whether the `server-*` (and `peer-id`)
 * overrides apply to a connection URL or to a loaded config. Keyed by the yargs
 * option name; an absent key keeps the default (`invite`/`accept`) wording. Only
 * the describe text varies -- the option name, type, alias, and default live
 * once in {@link addCommonBootstrapOptions}, so a new common flag is added there
 * alone and appears in every command.
 */
export type CommonBootstrapDescribeOverrides = Partial<
  Record<
    | "config-file"
    | "key-file"
    | "server-port"
    | "server-username"
    | "server-password"
    | "server-private-key"
    | "peer-id"
    | "timestamp-in-filename"
    | "retain-files",
    string
  >
>;

/**
 * Add the options common to the bootstrap-style commands (config/key paths,
 * identity, SFTP credential overrides, connection/exchange tuning, logging,
 * recording). Positionals and command-specific options (`accept-timeout` for
 * `invite`, `save`/sweep controls for `zero-setup`/`exchange`) are added by each
 * command's own builder. `describe` lets a command supply accurate wording for
 * the few options whose meaning differs from the `invite`/`accept` default --
 * e.g. `exchange` reads a config and has no URL, so its `server-*` text names
 * the config rather than the URL.
 */
export function addCommonBootstrapOptions(
  cmd: Argv,
  describe: CommonBootstrapDescribeOverrides = {},
): Argv {
  return cmd
    .option("config-file", {
      type: "string",
      describe:
        describe["config-file"] ??
        `where to write psilink.yaml (default: ${DEFAULT_CONFIG_PATH})`,
    })
    .option("key-file", {
      type: "string",
      describe:
        describe["key-file"] ??
        `where to write .psilink.key (default: ${DEFAULT_KEY_PATH})`,
    })
    .option("identity", {
      type: "string",
      describe: "identity string for this party (name, org, contact)",
    })
    .option("server-port", {
      type: "number",
      describe:
        describe["server-port"] ?? "server port; overrides the port in URL",
    })
    .option("server-username", {
      type: "string",
      describe:
        describe["server-username"] ??
        "server username; overrides the username in URL",
    })
    .option("server-password", {
      type: "string",
      describe:
        describe["server-password"] ??
        "server password; use @path to read from file; overrides the " +
          "password in URL",
    })
    .option("server-private-key", {
      type: "string",
      describe:
        describe["server-private-key"] ??
        "SSH private key; use @path to read from file",
    })
    .option("connection-timeout", {
      type: "string",
      describe:
        "how long to wait when connecting to the primary exchange server. " +
        DURATION_VALUE_HELP,
    })
    .option("peer-timeout", {
      alias: "t",
      type: "string",
      describe:
        "how long to wait for the peer before giving up. " +
        DURATION_VALUE_HELP,
    })
    .option("max-reconnect-attempts", {
      type: "number",
      describe: "maximum reconnection attempts before giving up; default: 3",
    })
    .option("log-level", {
      type: "string",
      describe: "silent | error | warn | info | debug | trace; default=info",
    })
    .option("log-file", {
      type: "string",
      describe:
        "append all log output to this file instead of the terminal; the " +
        "parent directory must already exist",
    })
    .option("record", {
      type: "boolean",
      default: true,
      describe:
        "after a successful exchange, write a self-attested audit record (a " +
        "local artifact, not a signed receipt) and its private opening file; " +
        "use --no-record to skip",
    })
    .option("record-file", {
      type: "string",
      describe:
        "path for the audit record (default: ./psilink-record-<timestamp>." +
        "json); the private opening data is written alongside it as " +
        "<name>.opening.json",
    })
    .option("lockless-rendezvous", {
      type: "boolean",
      describe:
        "use the ack-handshake rendezvous instead of the atomic lock-file " +
        "race; required on sync-mediated transports that lack atomic " +
        "exclusive-create or deletion visibility during rendezvous. Both " +
        "parties must set this flag identically",
    })
    .option("peer-id", {
      type: "string",
      describe:
        describe["peer-id"] ??
        "stable identifier for this party; appears in filenames and logs. " +
          "Requires timestamp_in_filename: true. Both parties must use " +
          "distinct ids",
    })
    .option("timestamp-in-filename", {
      type: "boolean",
      describe:
        describe["timestamp-in-filename"] ??
        "encode a UTC timestamp and per-session counter in each outgoing " +
          "message filename; --retain-files implies it. Both parties must use " +
          "the same value",
    })
    .option("retain-files", {
      type: "boolean",
      describe:
        describe["retain-files"] ??
        "keep all exchange files as a permanent transcript instead of " +
          "deleting them after consumption. Requires --timestamp-in-filename. " +
          "Both parties must set this flag identically",
    })
    .option("verbose", {
      alias: "v",
      type: "count",
      describe:
        "generate additional logging information for sub-libraries at all " +
        "logging levels",
    });
}

/** The options common to `invite` and `accept`, parsed from yargs `Arguments`. */
export interface CommonBootstrapOptions {
  configFile: string;
  keyFile: string;
  identity?: string;
  serverPort?: number;
  serverUsername?: string;
  serverPassword?: string;
  serverPrivateKey?: string;
  connectionTimeout?: number;
  peerTimeout?: number;
  maxReconnectAttempts?: number;
  locklessRendezvous?: boolean;
  peerId?: string;
  timestampInFilename?: boolean;
  retainFiles?: boolean;
  record: boolean;
  recordFile?: string;
  logLevel: logLibrary.LogLevelNumbers;
  logFile?: string;
  verbosity: number;
}

/** Parse the {@link CommonBootstrapOptions} from yargs `Arguments`. */
export function parseCommonBootstrapArgs(
  argv: Arguments,
): CommonBootstrapOptions {
  const rawLogLevel = (
    (singleValue(argv, "log-level") as string | undefined) || "info"
  ).toLowerCase();
  const logLevel = LOG_LEVELS[rawLogLevel];
  if (logLevel === undefined)
    throw new UsageError(`unrecognized log-level: ${argv["log-level"]}`);

  // Each single-value (string/number) option is read through singleValue so a
  // repeated flag is rejected with a clean usage error before its array value
  // reaches a cast that lies about the type. The boolean and count options
  // (lockless-rendezvous, timestamp-in-filename, retain-files, record, verbose)
  // keep their plain casts: a repeat is valid for them.
  return {
    configFile:
      (singleValue(argv, "config-file") as string | undefined) ??
      DEFAULT_CONFIG_PATH,
    keyFile:
      (singleValue(argv, "key-file") as string | undefined) ?? DEFAULT_KEY_PATH,
    identity: singleValue(argv, "identity") as string | undefined,
    serverPort: singleValue(argv, "server-port") as number | undefined,
    serverUsername: singleValue(argv, "server-username") as string | undefined,
    // Credential values are carried through verbatim; an `@path` ref is read only
    // at the live-use boundary (resolveConnectionCredentials in
    // runOnlineBootstrap), so a persisted config keeps the `@path`, not the
    // resolved secret.
    serverPassword: singleValue(argv, "server-password") as string | undefined,
    serverPrivateKey: singleValue(argv, "server-private-key") as
      | string
      | undefined,
    connectionTimeout: durationFlagSeconds(argv, "connection-timeout"),
    peerTimeout: durationFlagSeconds(argv, "peer-timeout"),
    maxReconnectAttempts: singleValue(argv, "max-reconnect-attempts") as
      | number
      | undefined,
    locklessRendezvous: argv["lockless-rendezvous"] as boolean | undefined,
    peerId: singleValue(argv, "peer-id") as string | undefined,
    timestampInFilename: argv["timestamp-in-filename"] as boolean | undefined,
    retainFiles: argv["retain-files"] as boolean | undefined,
    // yargs sets `record` to false on --no-record and true by the option's
    // default otherwise, so it is always a boolean here.
    record: argv["record"] as boolean,
    recordFile: singleValue(argv, "record-file") as string | undefined,
    logLevel,
    logFile: singleValue(argv, "log-file") as string | undefined,
    verbosity: (argv["verbose"] as number | undefined) ?? 0,
  };
}

/**
 * The subset of parsed common options {@link connectionOverridesFrom} reads. A
 * `Pick` rather than the full {@link CommonBootstrapOptions} so the command
 * `Options` shapes that carry only the override fields (exchange's, zero-setup's)
 * also satisfy it; the full options object is assignable to it too.
 */
export type ConnectionOverrideOptions = Pick<
  CommonBootstrapOptions,
  | "connectionTimeout"
  | "peerTimeout"
  | "maxReconnectAttempts"
  | "serverUsername"
  | "serverPassword"
  | "serverPrivateKey"
  | "serverPort"
  | "locklessRendezvous"
  | "peerId"
  | "timestampInFilename"
  | "retainFiles"
>;

/** Map the parsed common options to the connection-override shape. */
export function connectionOverridesFrom(
  options: ConnectionOverrideOptions,
  extra: { peerTimeout?: number } = {},
): ConnectionOverrides {
  return {
    connectionTimeout: options.connectionTimeout,
    peerTimeout: extra.peerTimeout ?? options.peerTimeout,
    maxReconnectAttempts: options.maxReconnectAttempts,
    serverUsername: options.serverUsername,
    serverPassword: options.serverPassword,
    serverPrivateKey: options.serverPrivateKey,
    serverPort: options.serverPort,
    locklessRendezvous: options.locklessRendezvous,
    peerId: options.peerId,
    timestampInFilename: options.timestampInFilename,
    retainFiles: options.retainFiles,
  };
}

/**
 * Warn that the file-sync-only flags (`--lockless-rendezvous`, `--retain-files`)
 * have no effect on a channel that is not `sftp` or `filedrop`, naming whichever
 * flags the caller actually set. The channel is taken as input so the one helper
 * serves both call sites: `exchange` derives it from the loaded connection
 * (post-override), `zero-setup` from the server URL (pre-connection). A file-sync
 * channel warns for neither flag. Shared so the wording cannot drift between the
 * two commands.
 */
export function warnUnsupportedFileSyncFlags(
  channel: ConnectionConfig["channel"],
  flags: { locklessRendezvous?: boolean; retainFiles?: boolean },
  log: { warn: (message: string) => void },
): void {
  if (channel === "sftp" || channel === "filedrop") return;
  if (flags.locklessRendezvous === true)
    log.warn(
      `--lockless-rendezvous has no effect on the ${channel} channel and will ` +
        "be ignored; it is only supported on sftp and filedrop",
    );
  if (flags.retainFiles === true)
    log.warn(
      `--retain-files has no effect on the ${channel} channel and will be ` +
        "ignored; it is only supported on sftp and filedrop",
    );
}
