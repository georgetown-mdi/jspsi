import crypto from "node:crypto";
import fs from "node:fs";
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
  UsageError,
} from "@psilink/core";
import type {
  ConnectionConfig,
  ConnectionEndpoint,
  ExchangeSpec,
  ExchangeDataSpec,
  FileDropConnectionConfig,
  LinkageTerms,
  PreparedExchange,
  SFTPConnectionConfig,
  WebRTCConnectionConfig,
} from "@psilink/core";

import {
  applyConnectionOverrides,
  saveConfig,
  type ConnectionOverrides,
  type ReconcileDiff,
  DEFAULT_CONFIG_PATH,
} from "../config";
import { detectFileConflicts } from "../fileUtils";
import { DEFAULT_KEY_PATH } from "../keyFile";
import { resolveAtSignRefs } from "../util/atSignRefs";
import { LOG_LEVELS, validateInputFile } from "../util/cli";
import { runProtocol, type ProtocolConnectionConfig } from "../protocol";
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
 * Render a URL as a string with any embedded credentials (the userinfo
 * component) removed, for echoing in a user-facing hint. `URL.href` preserves an
 * embedded password, which must never reach the terminal, logs, or shell
 * history; the partner supplies their own credentials, so the username is
 * dropped too and only the locator remains.
 *
 * @internal exported for testing
 */
export function redactUrlCredentials(url: URL): string {
  const safe = new URL(url.href);
  safe.username = "";
  safe.password = "";
  return safe.href;
}

/**
 * Build a connection config from a server URL, for the online invite/accept
 * paths. Mirrors the zero-setup mapping but is constrained to the channels the
 * CLI can actually run: a `webrtc` (ws/wss) URL or an unsupported scheme is a
 * usage error. The returned config carries no `authentication`; the caller adds
 * the PAKE token separately for the handshake and never persists it to the
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
      host: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      username: url.username || undefined,
      password: url.password || undefined,
      // A bare-host URL (sftp://host or sftp://host/) leaves the remote path
      // unset so the server's default working directory is used, rather than
      // pinning it to the filesystem root.
      path: url.pathname && url.pathname !== "/" ? url.pathname : undefined,
    },
  };
  return applyConnectionOverrides(base, overrides) as RunnableConnectionConfig;
}

/**
 * Compare a pre-existing config's connection block against an online accept's
 * URL, returning the explicit-field disagreements that must abort the
 * acceptance. Only fields the URL states explicitly are compared (docs/CLI.md
 * "Online acceptance"): the channel (from the scheme) and, for sftp, the host
 * always; the port, path, and username/password only when the URL carries them.
 * A credential the URL omits is never a conflict -- the acceptor supplies their
 * own. A channel mismatch short-circuits the rest, since the per-channel fields
 * are not comparable across channels.
 *
 * Compares against the URL directly (not a {@link connectionFromURL} result):
 * that builder leaves an unspecified port/path `undefined`, which a naive
 * field-by-field diff would read as "URL requires unset" and wrongly flag
 * against a config that does set them. The URL's own `port`/`pathname` tell us
 * which fields were explicit.
 *
 * @internal exported for testing
 */
export function diffConnectionAgainstUrl(
  existing: ConnectionConfig,
  url: URL,
): ReconcileDiff[] {
  const diffs: ReconcileDiff[] = [];
  const channel = channelFromURL(url);
  if (existing.channel !== channel) {
    diffs.push({
      field: "connection.channel",
      existing: existing.channel,
      incoming: channel,
    });
    return diffs;
  }

  const cmp = (field: string, have: string | undefined, want: string): void => {
    if (have !== want)
      diffs.push({ field, existing: have ?? "(unset)", incoming: want });
  };

  if (channel === "sftp") {
    const { server } = existing as SFTPConnectionConfig;
    cmp("connection.server.host", server.host, url.hostname);
    // port/path/credentials are compared only when the URL states them; an
    // omitted field is not a disagreement with whatever the config holds.
    if (url.port)
      cmp("connection.server.port", server.port?.toString(), url.port);
    const urlPath =
      url.pathname && url.pathname !== "/" ? url.pathname : undefined;
    if (urlPath !== undefined)
      cmp("connection.server.path", server.path, urlPath);
    if (url.username)
      cmp("connection.server.username", server.username, url.username);
    if (url.password)
      cmp("connection.server.password", server.password, url.password);
  } else if (channel === "filedrop") {
    cmp(
      "connection.path",
      (existing as FileDropConnectionConfig).path,
      fileURLToPath(url),
    );
  }
  // webrtc never reaches here on an online accept: connectionFromURL rejects a
  // ws/wss URL before the connection is built, and a webrtc existing config
  // against an sftp/filedrop URL is caught by the channel mismatch above.

  return diffs;
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
      // from the PAKE token, not a username/password.
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

// --- PAKE token --------------------------------------------------------------

/**
 * Generate a fresh invitation PAKE token: a base64url-encoded 32 random bytes,
 * matching `PAKE_TOKEN_REGEX`. The rotation token derived after the first
 * successful handshake replaces it; this is only the short-lived setup credential.
 */
export function generatePakeToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** ISO 8601 datetime `durationSeconds` from now, for an invitation's `expires`. */
export function expiresFromNow(durationSeconds: number): string {
  return new Date(Date.now() + durationSeconds * 1000).toISOString();
}

// --- Input data --------------------------------------------------------------

/** Load and parse a CSV input file into raw rows and column names. */
export async function loadInputRows(
  input: string,
): Promise<{ rawRows: Array<Record<string, string>>; columns: string[] }> {
  validateInputFile(input);
  const csvResult = await loadCSVFile(fs.createReadStream(input));
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
 * Run the connect -> SPAKE2 handshake -> exchange path shared by online invite
 * and online accept, persisting the config at the moment the handshake
 * succeeds. `runProtocol` opens the connection, completes the handshake with
 * `pakeToken`/`expires`, writes the rotated (persistent, no-expiry) token to
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
 * `saveConfig` strips any PAKE material regardless, so moving the write into the
 * hook changes only when the config is persisted, not what is persisted.
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
  pakeToken: string;
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
  // (RunnableConnectionConfig), so this cast only adds the `authentication`
  // field; it bridges the spread of a discriminated union to the union target,
  // not a channel-safety hole.
  const connWithAuth: ProtocolConnectionConfig = {
    ...params.connection,
    authentication: {
      pakeToken: params.pakeToken,
      expires: params.expires,
      keyFilePath: params.keyPath,
    },
  } as ProtocolConnectionConfig;

  // Set inside the hook once saveConfig returns, so the catch below can tell a
  // "config is on disk, retry without re-inviting" recovery from a run where the
  // config write never succeeded (hook threw, or handshake never reached it).
  let configWritten = false;
  try {
    const { onAuthenticatedError } = await runProtocol(
      connWithAuth,
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
        if (params.reuseExistingConfig) {
          // The reconcile check already confirmed the pre-existing config agrees
          // with the invitation and URL; keep it untouched. The rotated key is
          // saved by runProtocol above; nothing is written here, so
          // `configWritten` stays false (no fresh config was persisted).
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
    // The exchange failed after a successful handshake. When the config is on
    // disk -- freshly written by the hook, or a reused pre-existing one -- tell
    // the user it (and the rotated key) are there so they retry with `psilink
    // exchange` instead of re-inviting, the exact recovery this bootstrap exists
    // to make possible. Logged at error level (matching runProtocol's rotation
    // advisory) so it stays visible alongside the error the handler then reports.
    // Only when the config is actually on disk: a hook failure (config not
    // written) must not claim otherwise.
    if (configWritten || params.reuseExistingConfig)
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
  if (params.reuseExistingConfig) {
    // Reuse implies the config write was skipped, so there is no configWriteError
    // to report; the existing config stands and only the rotated key was saved.
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
 * The `?? exitCode` rung is load-bearing: `validateInputFile` and `buildDataSpec`
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
    getLogger(loggerName).error(
      err instanceof Error ? err.message : String(err),
    );
    process.exit(
      err instanceof UsageError
        ? 64
        : ((err as { exitCode?: number }).exitCode ?? 69),
    );
  }
}

// --- Shared CLI options ------------------------------------------------------

/**
 * Add the options common to `invite` and `accept` (config/key paths, identity,
 * SFTP credential overrides, connection/exchange tuning, logging, recording).
 * Positionals and `accept-timeout` (invite-only) are added by each command's
 * own builder.
 */
export function addCommonBootstrapOptions(cmd: Argv): Argv {
  return cmd
    .option("config-file", {
      type: "string",
      describe: `where to write psilink.yaml (default: ${DEFAULT_CONFIG_PATH})`,
    })
    .option("key-file", {
      type: "string",
      describe: `where to write .psilink.key (default: ${DEFAULT_KEY_PATH})`,
    })
    .option("identity", {
      type: "string",
      describe: "identity string for this party (name, org, contact)",
    })
    .option("server-port", {
      type: "number",
      describe: "server port; overrides the port in URL",
    })
    .option("server-username", {
      type: "string",
      describe: "server username; overrides the username in URL",
    })
    .option("server-password", {
      type: "string",
      describe:
        "server password; use @path to read from file; overrides the " +
        "password in URL",
    })
    .option("server-private-key", {
      type: "string",
      describe: "SSH private key; use @path to read from file",
    })
    .option("connection-timeout", {
      type: "number",
      describe: "seconds to wait when connecting to primary exchange server",
    })
    .option("peer-timeout", {
      alias: "t",
      type: "number",
      describe: "seconds to wait for peer before giving up",
    })
    .option("max-reconnect-attempts", {
      type: "number",
      describe: "maximum reconnection attempts before giving up; default: 3",
    })
    .option("log-level", {
      type: "string",
      describe: "silent | error | warn | info | debug | trace; default=info",
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
        "stable identifier for this party; appears in filenames and logs. " +
        "Requires timestamp_in_filename: true. Both parties must use " +
        "distinct ids",
    })
    .option("timestamp-in-filename", {
      type: "boolean",
      describe:
        "encode a UTC timestamp and per-session counter in each outgoing " +
        "message filename; --retain-files implies it. Both parties must use " +
        "the same value",
    })
    .option("retain-files", {
      type: "boolean",
      describe:
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
  verbosity: number;
}

/** Parse the {@link CommonBootstrapOptions} from yargs `Arguments`. */
export function parseCommonBootstrapArgs(
  argv: Arguments,
): CommonBootstrapOptions {
  const rawLogLevel = (
    (argv["log-level"] as string | undefined) || "info"
  ).toLowerCase();
  const logLevel = LOG_LEVELS[rawLogLevel];
  if (logLevel === undefined)
    throw new UsageError(`unrecognized log-level: ${argv["log-level"]}`);

  return {
    configFile:
      (argv["config-file"] as string | undefined) ?? DEFAULT_CONFIG_PATH,
    keyFile: (argv["key-file"] as string | undefined) ?? DEFAULT_KEY_PATH,
    identity: argv["identity"] as string | undefined,
    serverPort: argv["server-port"] as number | undefined,
    serverUsername: argv["server-username"] as string | undefined,
    serverPassword: resolveAtSignRefs(
      argv["server-password"] as string | undefined,
    ) as string | undefined,
    serverPrivateKey: resolveAtSignRefs(
      argv["server-private-key"] as string | undefined,
    ) as string | undefined,
    connectionTimeout: argv["connection-timeout"] as number | undefined,
    peerTimeout: argv["peer-timeout"] as number | undefined,
    maxReconnectAttempts: argv["max-reconnect-attempts"] as number | undefined,
    locklessRendezvous: argv["lockless-rendezvous"] as boolean | undefined,
    peerId: argv["peer-id"] as string | undefined,
    timestampInFilename: argv["timestamp-in-filename"] as boolean | undefined,
    retainFiles: argv["retain-files"] as boolean | undefined,
    // yargs sets `record` to false on --no-record and true by the option's
    // default otherwise, so it is always a boolean here.
    record: argv["record"] as boolean,
    recordFile: argv["record-file"] as string | undefined,
    logLevel,
    verbosity: (argv["verbose"] as number | undefined) ?? 0,
  };
}

/** Map the parsed common options to the connection-override shape. */
export function connectionOverridesFrom(
  options: CommonBootstrapOptions,
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
