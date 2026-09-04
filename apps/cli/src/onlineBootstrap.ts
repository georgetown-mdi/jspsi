import type { Arguments } from "yargs";

import {
  endpointRequiresRetainedFiles,
  getLogger,
  loadCSVFile,
  prepareForExchange,
  inferMetadata,
  getDefaultLinkageTerms,
  getDefaultStandardization,
  columnValues,
  inferDateFormat,
  LinkageStrategySchema,
  MAX_PAYLOAD_ENTRIES,
  PLACEHOLDER_SFTP_HOST,
  PLACEHOLDER_SSH_USERNAME,
  safeParseConnectionConfig,
  sanitizeErrorForDisplay,
  UsageError,
} from "@psilink/core";
import type {
  ConnectionConfig,
  ConnectionEndpoint,
  CSVRow,
  ExchangeSpec,
  ExchangeDataSpec,
  FileDropConnectionConfig,
  FileSyncOptions,
  LinkageStrategy,
  LinkageTerms,
  OutboundPayloadConsent,
  PreparedExchange,
  SFTPConnectionConfig,
  WebRTCConnectionConfig,
} from "@psilink/core";

import {
  applyConnectionOverrides,
  persistExpectedPartnerDeduplicate,
  persistExpectedPayloadColumns,
  persistOutboundPayloadConsent,
  saveConfig,
} from "./config";
import { detectFileConflicts } from "./fileUtils";
import { openEventStream, reportPersistenceLoss } from "./eventStream";
import {
  applyConnectionCredentials,
  readConnectionCredentials,
} from "./util/atSignRefs";
import { establishHostKeyTrust, type HostKeyPersistence } from "./hostKeyTrust";
import { openInputSource } from "./util/dataIo";
import { singleValue } from "./util/flags";
import {
  runProtocol,
  type AuthPersist,
  type ProtocolConnectionConfig,
} from "./protocol";
import type { RunnableConnectionConfig } from "./connectionFromUrl";
import type { RecordOutput } from "./recordFile";

/**
 * The exchange-data portion of a spec: linkage terms (always present once
 * resolved) plus the optional metadata and standardization. Distinct from
 * core's ExchangeDataSpec, whose linkageTerms is Partial because it models the
 * not-yet-resolved input to prepareForExchange; here resolution has happened.
 */
export type ResolvedDataSpec = Omit<ExchangeSpec, "connection">;

// Options seeded onto a connection built from a split-directory endpoint: split
// configuration requires retain mode, which requires lockless rendezvous and
// timestamped filenames (enforced by core's ConnectionConfig schema), and retain
// mode is bilateral, so a mirrored acceptor needs the same trio. Seeded exactly
// where core's `endpointRequiresRetainedFiles` says retention applies, the same
// predicate the acceptance display states the retention on.
const SPLIT_SEED_OPTIONS: FileSyncOptions = {
  retainFiles: true,
  locklessRendezvous: true,
  timestampInFilename: true,
};

/**
 * Default time the inviter waits, from printing the invitation to receiving the
 * partner's acceptance, before giving up. 15 minutes, per docs/SECURITY_DESIGN.md.
 */
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
 * has a credential-free `connectionEndpoint`, seed the locator from it and
 * mark the credential field with a `REPLACE_WITH_...` placeholder for the user
 * to fill in (the endpoint type declares no credential field, and core's strict
 * endpoint schema rejects a document holding one). When it does not, write a
 * clearly-marked `sftp` placeholder the user replaces wholesale.
 *
 * The endpoint's `path` is the inviter's own (for `filedrop`, possibly a mount
 * the acceptor must remap); it is written verbatim for the user to review.
 *
 * Split-directory endpoints (sftp/filedrop holding an inbound/outbound pair) are
 * mirror-swapped here -- the inviter's outbound becomes this acceptor's inbound
 * and vice versa -- so the two parties start as mirror images and an operator can
 * keep a fixed mount layout while the invite conveys the role swap. This is the
 * single swap site (the offline invite path calls this with `undefined`, so it
 * never reaches a seeded branch and cannot double-swap). The swapped paths are
 * the inviter's own strings: the role assignment is exact, but the concrete
 * paths, host, and channel remain the operator's to reconcile, as for the single
 * `path` form. Split mode requires retain mode, so {@link SPLIT_SEED_OPTIONS} is
 * seeded alongside the pair. The pair is always whole here: the endpoint schema
 * rejects a half pair, and this runs only on a decoded (validated) endpoint.
 *
 * @internal exported for testing
 */
export function connectionFromEndpoint(
  endpoint: ConnectionEndpoint | undefined,
): SeededConnection {
  if (endpoint === undefined) {
    const connection: SFTPConnectionConfig = {
      channel: "sftp",
      server: {
        host: PLACEHOLDER_SFTP_HOST,
        username: PLACEHOLDER_SSH_USERNAME,
      },
    };
    return { connection, seeded: false };
  }

  switch (endpoint.channel) {
    case "sftp": {
      if (endpointRequiresRetainedFiles(endpoint)) {
        // Split-directory endpoint: mirror-swap the inviter's pair (inviter's
        // outbound -> this acceptor's inbound, inviter's inbound -> outbound).
        const connection: SFTPConnectionConfig = {
          channel: "sftp",
          server: {
            host: endpoint.host,
            port: endpoint.port,
            inboundPath: endpoint.outboundPath,
            outboundPath: endpoint.inboundPath,
            // The endpoint never holds credentials; mark the field the user
            // must supply (a password or private key is added via @path).
            username: PLACEHOLDER_SSH_USERNAME,
          },
          options: SPLIT_SEED_OPTIONS,
        };
        return { connection, seeded: true };
      }
      const connection: SFTPConnectionConfig = {
        channel: "sftp",
        server: {
          host: endpoint.host,
          port: endpoint.port,
          path: endpoint.path,
          // The endpoint never holds credentials; mark the field the user
          // must supply (a password or private key is added via @path).
          username: PLACEHOLDER_SSH_USERNAME,
        },
      };
      return { connection, seeded: true };
    }
    case "filedrop": {
      if (endpointRequiresRetainedFiles(endpoint)) {
        // Split-directory endpoint: mirror-swap the inviter's pair (see the sftp
        // branch). filedrop holds no credentials, so no placeholder is needed.
        const connection: FileDropConnectionConfig = {
          channel: "filedrop",
          inboundPath: endpoint.outboundPath,
          outboundPath: endpoint.inboundPath,
          options: SPLIT_SEED_OPTIONS,
        };
        return { connection, seeded: true };
      }
      if (endpoint.path === undefined)
        // Unreachable for a decoded endpoint: the schema requires a filedrop
        // endpoint to name a directory in one form (path, or the split pair
        // handled above), but `path` is optional in the type, so guard a caller
        // that bypasses decode with a clear error here rather than letting an
        // undefined path reach connection.ts as an opaque schema failure
        // (onlineBootstrap.test.ts, "connectionFromEndpoint: throws on a
        // filedrop endpoint naming no directory").
        throw new Error(
          "filedrop endpoint has neither a path nor a split " +
            "inbound_path/outbound_path pair",
        );
      const connection: FileDropConnectionConfig = {
        channel: "filedrop",
        path: endpoint.path,
      };
      return { connection, seeded: true };
    }
    case "webrtc": {
      // No `role` here: an invitation's locator says where the coordination
      // server is, never which end of the rendezvous this party is. The caller
      // stamps it (withWebRTCPeerRole), and `psilink exchange` refuses a
      // connection that reaches it without one (see webRtcDialFrom). webrtc
      // needs no credential placeholder either -- it authenticates from the
      // shared secret, not a username/password.
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

/**
 * Read the split inbound/outbound directory pair off a file-sync connection,
 * regardless of which channel holds it (sftp keeps the pair under `server`,
 * filedrop at the top level). Empty for a shared (single-path) or webrtc
 * connection. Used to lift the mirror-swapped pair out of a
 * {@link connectionFromEndpoint} result so {@link applyEndpointSplitDirectories}
 * can graft it onto the URL-built connection without re-implementing the swap.
 */
function splitDirectoriesOf(connection: ConnectionConfig): {
  inboundPath?: string;
  outboundPath?: string;
} {
  if (connection.channel === "sftp")
    return {
      inboundPath: connection.server.inboundPath,
      outboundPath: connection.server.outboundPath,
    };
  if (connection.channel === "filedrop")
    return {
      inboundPath: connection.inboundPath,
      outboundPath: connection.outboundPath,
    };
  return {};
}

/**
 * Result of {@link applyEndpointSplitDirectories}: the connection the online
 * accept will use, and whether an invitation endpoint's split pair supplied its
 * directory roles (so the caller can note the seeding before the prompt).
 */
export interface EndpointSplitMerge {
  connection: RunnableConnectionConfig;
  /** True when a split endpoint seeded the inbound/outbound roles. */
  appliedSplitDirectories: boolean;
}

/**
 * Seed an ONLINE acceptor's split inbound/outbound directories from the
 * invitation's connection endpoint -- the online counterpart to what the offline
 * accept path gets directly from {@link connectionFromEndpoint}.
 *
 * Merges the typed URL (channel, host, port, credentials) with the
 * credential-free endpoint's split-directory role mapping: when the endpoint
 * names a split pair, grafts the mirror-swapped pair (via
 * {@link connectionFromEndpoint}, the single swap site) and the
 * {@link SPLIT_SEED_OPTIONS} retain trio onto the URL-built connection,
 * replacing its single directory; host, port, credentials, and channel stay the
 * URL's. URL-derived `options` are preserved, with the retain trio merged on
 * top. Skipped when `--outbound-path` was passed (that explicit override wins).
 *
 * A no-op (`appliedSplitDirectories: false`) with no endpoint, a webrtc
 * endpoint, or a single shared `path` rather than a split pair.
 *
 * @internal exported for testing
 */
export function applyEndpointSplitDirectories(
  urlConnection: RunnableConnectionConfig,
  endpoint: ConnectionEndpoint | undefined,
): EndpointSplitMerge {
  // The undefined half is spelled out rather than left to the predicate (which
  // answers false for it too) so the endpoint stays narrowed for the delegation
  // below; the shape test itself is the predicate's alone.
  if (endpoint === undefined || !endpointRequiresRetainedFiles(endpoint))
    return { connection: urlConnection, appliedSplitDirectories: false };

  // connectionFromEndpoint performs the one mirror swap; take only its swapped
  // directory pair (the inviter's host/placeholder credentials it also seeds are
  // not used online -- those come from the acceptor's own URL).
  const { inboundPath, outboundPath } = splitDirectoriesOf(
    connectionFromEndpoint(endpoint).connection,
  );

  const result = structuredClone(urlConnection);
  // Retain mode (with the lockless rendezvous + timestamped names it implies) is
  // mandatory for a split directory; merge it over any URL-derived options rather
  // than replacing them, so a --connection-timeout etc. set on the URL survives.
  const options: FileSyncOptions = { ...result.options, ...SPLIT_SEED_OPTIONS };
  // Place the swapped pair per the URL's channel. Explicit per-channel branches
  // (matching diffConnectionAgainstTarget) rather than a bare else, so a future
  // RunnableConnectionConfig channel falls through to fail the schema validation
  // below instead of silently writing filedrop-shaped fields onto it.
  if (result.channel === "sftp") {
    delete result.server.path;
    result.server.inboundPath = inboundPath;
    result.server.outboundPath = outboundPath;
  } else if (result.channel === "filedrop") {
    delete result.path;
    result.inboundPath = inboundPath;
    result.outboundPath = outboundPath;
  }
  result.options = options;

  // The grafted split form has invariants the plain shared connection does
  // not (a filedrop pair must be absolute; the pair is set together and differs).
  // Validate once -- mirroring applyConnectionOverrides' --outbound-path assembly
  // -- so a degenerate endpoint fails here, before any network activity, with the
  // schema's own messages rather than as an opaque connect error later.
  const validation = safeParseConnectionConfig(result);
  if (!validation.success)
    throw new UsageError(
      validation.error.issues.map((i) => i.message).join("; "),
    );

  return { connection: result, appliedSplitDirectories: true };
}

// --- connection -> endpoint (producer) --------------------------------------

/**
 * The credential-free connection-endpoint producer lives in @psilink/core (one
 * definition shared with the web mint layer, next to the endpoint schemas);
 * re-exported here so the CLI's invitation call sites keep importing it from
 * this module. Its EndpointSourceConnectionConfig parameter is structurally the
 * CLI's ProtocolConnectionConfig (both narrow ConnectionConfig to the three
 * channels an exchange runs on), so the invite-side callers pass their
 * connection unchanged.
 */
export { endpointFromConnection } from "@psilink/core";

// --- shared secret --------------------------------------------------------------

/**
 * Secret generation lives in @psilink/core (one definition shared with the web
 * inviter, per the CONTRIBUTING rule against re-implementing crypto helpers);
 * re-exported here so the CLI's invitation call sites keep importing it from this
 * module.
 */
export { generateSharedSecret } from "@psilink/core";

/** ISO 8601 datetime `durationSeconds` from now, for an invitation's `expires`. */
export function expiresFromNow(durationSeconds: number): string {
  return new Date(Date.now() + durationSeconds * 1000).toISOString();
}

// --- Input data --------------------------------------------------------------

/**
 * Load and parse a CSV input into raw rows and column names -- the one loader
 * every command that reads an exchange INPUT goes through (`invite`, `accept`,
 * `exchange`, `zero-setup`), so the data-level gate below cannot be forgotten at a
 * call site. `input` is a file path or `-` for stdin; the caller gates stdin via
 * `allowStdin` because the commands sharing this loader differ on it -- `invite`,
 * `exchange`, and `zero-setup` support `-`, and `accept` rejects it unless
 * `--consent-to-terms` skips the confirmation prompt that otherwise owns stdin.
 * Defaults to stdin disabled so the shared loader never enables it
 * unconditionally.
 *
 * A row-level parse fault rejects inside `loadCSVFile` (a `CsvRowParseError`,
 * which is a `UsageError` -> exit 64). A dataset with no data rows is refused
 * here, before any exchange work, since it is not a parse failure and every
 * stage downstream would otherwise accept it as a real, if empty, run (see the
 * thrown message below); the refusal is unconditional rather than a warning.
 *
 * `verify-receipt` does NOT come through here: its result CSV is legitimately
 * empty for a zero-match exchange.
 */
export async function loadInputRows(
  input: string,
  { allowStdin = false }: { allowStdin?: boolean } = {},
): Promise<{ rawRows: Array<CSVRow>; columns: string[] }> {
  const csvResult = await loadCSVFile(openInputSource(input, { allowStdin }));
  if (csvResult.data.length === 0)
    throw new UsageError(
      `${describeInputSource(input)} has no data rows. An exchange over an ` +
        "empty dataset writes an empty result indistinguishable from a real " +
        "non-match, so it is refused here; check the export that produced the " +
        "file.",
    );
  return {
    rawRows: csvResult.data,
    columns: csvResult.meta.fields ?? [],
  };
}

/** Name an input in a refusal message: a path as given, or stdin as what it is. */
function describeInputSource(input: string): string {
  return input === "-" ? "the CSV read from stdin" : `the CSV input ${input}`;
}

// --- Linkage strategy selection ----------------------------------------------

/**
 * Apply the operator-selected linkage strategy onto CLI-authored default terms.
 * A no-op when `strategy` is undefined (the operator did not pass
 * `--linkage-strategy`, so the schema default the factory already set --
 * `cascade` -- stands) or when it already equals the terms' current value;
 * since CLI-authored default terms have `cascade`, in practice only an explicit
 * `single-pass` selection changes anything. Returns a fresh object so the
 * caller's input is not mutated. Shared by the two CLI commands that author fresh
 * terms (`invite` via {@link buildDataSpec}, `zero-setup` over its prepared
 * terms) so the selection is applied one way.
 */
export function withLinkageStrategy(
  terms: LinkageTerms,
  strategy: LinkageStrategy | undefined,
): LinkageTerms {
  if (strategy === undefined || strategy === terms.linkageStrategy)
    return terms;
  return { ...terms, linkageStrategy: strategy };
}

/**
 * Parse the optional `--linkage-strategy` flag to a validated
 * {@link LinkageStrategy}, or `undefined` when the operator did not select one
 * (the caller then leaves the authored terms at their `cascade` default). A
 * repeated flag is rejected by {@link singleValue} before its array value could
 * reach the enum check, and an unrecognized value is a clean {@link UsageError}
 * (exit 64), the same shape the CLI rejects other bad enum flags with (e.g.
 * `--log-level`). The rejected value is echoed verbatim like that path -- it is
 * the operator's own argument, not partner-controlled.
 */
export function parseLinkageStrategyFlag(
  argv: Arguments,
): LinkageStrategy | undefined {
  const raw = singleValue(argv, "linkage-strategy") as string | undefined;
  if (raw === undefined) return undefined;
  const parsed = LinkageStrategySchema.safeParse(raw);
  if (!parsed.success)
    throw new UsageError(
      `unrecognized linkage-strategy: ${raw}; expected cascade or single-pass`,
    );
  return parsed.data;
}

/**
 * The note shown when `single-pass` is selected (on the authoring side) or
 * included in an invitation (on the accepting consent prompt): single-pass is a
 * consented disclosure tradeoff, not a free speed-up. It discloses the sender's
 * full per-key value structure to the receiver -- the receiver observes matches
 * on less precise keys the cascade would have filtered out -- in exchange for a
 * round-trip count constant in the number of keys. The matched result is
 * identical either way. Shared by `invite` (selection time) and `accept`
 * (consent prompt) so the operator and the partner read the same framing, and
 * points at the operator-facing reference, not the internal design note.
 */
export function singlePassDisclosureNotice(): string {
  return (
    "single-pass linkage means one of you sends the other everything it " +
    "prepared for every linkage key at once, so that party also sees matches " +
    "on the weaker keys, not only the strongest. Which of you sends is " +
    "decided when the exchange runs, so it may be you. The matched result is " +
    "the same either way; what differs is how much your partner can observe " +
    "while it runs -- a consented disclosure tradeoff for a round-trip count " +
    "that stays constant as keys are added, not a free speed-up. See " +
    "https://github.com/georgetown-mdi/jspsi/blob/main/docs/" +
    "EXCHANGE_REFERENCE.md (linkage_terms.linkage_strategy)."
  );
}

/**
 * Resolve the exchange-data portion of a config.
 *
 * - With input rows: infer metadata, then either infer linkage terms (invite,
 *   `terms` undefined) or use the supplied terms (accept), and derive the default
 *   standardization over both; the spec includes all three. A linkage field the
 *   input columns cannot bind simply gets no transformation, and naming those
 *   fields to the operator belongs to the satisfiability pre-flight
 *   (`checkLinkageSatisfiability`), which runs before this.
 * - Without input rows (accept with no input file): `terms` is required and the
 *   spec is just those terms.
 *
 * `linkageStrategy`, when given, is applied ONLY to terms this function authors
 * from the defaults (the invite infer-from-input and online paths, where `terms`
 * is absent); it is the operator's `--linkage-strategy` selection. When `terms`
 * is supplied (accept derives them from the invitation, which already has the
 * agreed strategy), the selection is not applied -- the partner's choice stands.
 * Absent (or `cascade`) leaves the default strategy untouched, so omitting the
 * selection is byte-identical to before the flag existed.
 *
 * `dateInputFormat`, when given, is the DOB date-input format the caller already
 * inferred (via `inferDateInputFormatFromSource`, from a bounded sample) and
 * short-circuits this function's own inference from `rawRows`. `init` uses it
 * because its bounded read has no full row set to scan; the invite/accept paths
 * omit it and this function infers the format from their full `rawRows` exactly as
 * before -- so the parameter is additive and behavior-preserving for them.
 */
export function buildDataSpec(args: {
  terms?: LinkageTerms;
  identity: string;
  rows?: { rawRows: Array<CSVRow>; columns: string[] };
  dateInputFormat?: string;
  linkageStrategy?: LinkageStrategy;
}): ResolvedDataSpec {
  const { terms, identity, rows, linkageStrategy } = args;

  if (rows === undefined) {
    if (terms === undefined)
      // Unreachable through the CLI (offline invite always has input, accept
      // always has terms); guards a direct caller against an empty spec
      // (onlineBootstrap.test.ts, "buildDataSpec: neither terms nor input rows
      // is refused rather than yielding an empty spec").
      throw new Error("buildDataSpec requires either terms or input rows");
    return { linkageTerms: terms };
  }

  const metadata = inferMetadata(rows.columns);
  const linkageTerms =
    terms ??
    withLinkageStrategy(
      getDefaultLinkageTerms(identity, metadata),
      linkageStrategy,
    );

  const dobCol = metadata.find((c) => c.type === "date_of_birth");
  const dateInputFormat =
    args.dateInputFormat ??
    (dobCol !== undefined
      ? inferDateFormat(columnValues(rows.rawRows, dobCol.name))
      : undefined);

  const standardization = getDefaultStandardization(metadata, linkageTerms, {
    dateInputFormat,
  });
  return { linkageTerms, metadata, standardization };
}

/** Build a {@link PreparedExchange} for an online run from a resolved spec. */
export function prepareForOnlineExchange(
  dataSpec: ResolvedDataSpec,
  identity: string,
  rows: { rawRows: Array<CSVRow>; columns: string[] },
): PreparedExchange {
  return prepareForExchange(
    dataSpec as ExchangeDataSpec,
    identity,
    rows.rawRows,
    rows.columns,
  );
}

/**
 * The received-payload commitment to persist from an OBSERVED first exchange, or
 * `undefined` to persist nothing (leaving the field absent so the recurring path
 * reconciles lazily). A party that learns its received-payload set only by
 * observation -- the online inviter (unknown until the acceptor transmits it)
 * and a zero-setup `--save` party -- crystallizes that observed set into the
 * saved config's `expectedPayloadColumns` so a later recurring `psilink
 * exchange` fails closed on a divergent received payload
 * ({@link reconcileReceivedPayload}); the observe-by-first-exchange counterpart
 * to the acceptor's up-front token commitment.
 *
 * An empty observation is not persisted (stays lazy): an empty payload is
 * ambiguous between disclosing nothing and a zero-match exchange, and persisting
 * it as a "receive nothing" commitment would abort an otherwise-honest later run
 * that does match. A later non-empty observation is then accepted without
 * widening disclosure -- receiving is not disclosing. Only a non-empty,
 * unambiguous observation is crystallized.
 *
 * An observation of more than `MAX_PAYLOAD_ENTRIES` columns is also dropped
 * (stays lazy): persisting it would write a config this party can no longer
 * load, and truncating would diverge from the partner's full re-transmitted set
 * and false-abort the recurring run. The offline-accept/token path cannot hit
 * this cap: its disclosed-columns subset is already bounded at intake, unlike
 * this observe-on-save path's unbounded source.
 *
 * @internal exported for testing
 */
export function observedReceivedColumnsForSave(
  observed: string[] | undefined,
): string[] | undefined {
  if (observed === undefined || observed.length === 0) return undefined;
  if (observed.length > MAX_PAYLOAD_ENTRIES) return undefined;
  return observed;
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
 * Persisting from the hook (not after `runProtocol` returns) means a handshake
 * that succeeds but whose data exchange then fails still leaves both the
 * rotated key and the config on disk, recoverable without re-inviting; a
 * handshake that never succeeds never reaches the hook, so it leaves no config.
 * A config-write failure is non-fatal -- the exchange still runs -- and is
 * returned as `configWriteError` rather than claiming the config was saved.
 *
 * Every persistence this path can lose without losing the exchange -- that
 * config write, the reuse path's two consent-record refreshes, and the
 * post-exchange observed-payload crystallization -- reports through
 * {@link reportPersistenceLoss}: the human log states the cause, the
 * machine-interface stream sends a `warning`, and the process exits
 * `PERSISTENCE_LOSS_EXIT_CODE` rather than a clean 0 an unattended
 * supervisor would read as a fully provisioned setup.
 *
 * When the exchange itself fails after the config was already written, this
 * function logs that the config and key are on disk -- so the user retries with
 * `psilink exchange` rather than re-inviting -- and then rejects with the
 * exchange error (the handler's error path reports the error itself). The note
 * is logged only when the config write actually succeeded, so a hook failure
 * followed by an exchange failure never claims a config that is not there.
 *
 * The persisted config holds the plain `connection` (no `authentication`);
 * `saveConfig` strips any shared-secret material regardless. A budget that
 * bounds this run alone (`runOnlyPeerTimeoutSeconds`) is applied to the live
 * connection below and to nothing else, so it reaches neither write.
 *
 * With `reuseExistingConfig`, the config write is skipped: the accept path has
 * already reconciled a pre-existing config against the invitation and the URL,
 * so its connection, linkage, and operator content stand (the rotated key is
 * still saved by `runProtocol`). The acceptance's own machine-managed consent
 * records -- the received-payload commitment and the outbound-payload consent --
 * are the exception, refreshed surgically in place. Otherwise the hook re-gates
 * the config path immediately before writing, matching the offline path's
 * `provisionConfigAndKey` re-gate, and reports a conflict as a non-fatal
 * `configWriteError` rather than aborting the already-completed exchange.
 */
export async function runOnlineBootstrap(params: {
  connection: ProtocolConnectionConfig;
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
  /**
   * `--event-stream`: emit the opt-in NDJSON machine-interface stream on fd 3
   * for the online exchange (see protocol.FileSyncRuntimeOptions and
   * docs/spec/CLI_EVENTS.md). Threaded straight to runProtocol, which runs the
   * fail-closed fd-3 preflight before opening the connection. Undefined/false on
   * the offline invite/accept paths, which never reach runProtocol.
   */
  eventStream?: boolean;
  /**
   * Keep a pre-existing, already-reconciled config: skip the config write, and
   * refresh only the acceptance's machine-managed consent records in place.
   */
  reuseExistingConfig?: boolean;
  /**
   * Crystallize the received-payload set this party OBSERVES during the exchange
   * into the freshly-written config's `expectedPayloadColumns`, so a later
   * recurring `psilink exchange` fails closed on a divergent payload. Passed by
   * the online INVITER, whose received set is unknown until the acceptor
   * transmits it (the lazy receive-side fill-to-disk this closes). The online
   * ACCEPTOR does not pass it: it learns its received set up front from the
   * invitation token and enforces that in memory for its single run. No-op unless
   * a fresh config was actually written (never the reuse path). See the
   * post-exchange second write below and {@link observedReceivedColumnsForSave}.
   */
  persistObservedReceivedPayload?: boolean;
  /**
   * The online ACCEPTOR's received-payload commitment for THIS acceptance: the
   * set it consented to UP FRONT from the invitation token
   * (`token.disclosedPayloadColumns`), recorded as the config's
   * `expectedPayloadColumns` so a later recurring `psilink exchange` fails closed
   * on a divergent received payload (reconcileReceivedPayload) -- the online
   * sibling of the offline-accept persistence. Unlike
   * `persistObservedReceivedPayload` (the inviter's observe-then-persist, in a
   * SECOND post-exchange write), this set is known BEFORE the exchange, so it
   * rides the acceptance hook's FIRST write on a fresh config and a surgical
   * in-place refresh of the kept config on the reuse path.
   *
   * The WRAPPER's presence -- not the columns inside it -- marks a caller that
   * owns this field. `consentedColumns: undefined` is an acceptance whose
   * invitation had no disclosed subset (an older or metadata-unknown mint): it
   * records no field on a fresh config and REMOVES a stale one under reuse,
   * leaving the recurring path to reconcile lazily. An absent parameter is a
   * caller with no commitment of its own (the online INVITER, whose received set
   * is learned by observation). An empty array is a real "receive nothing"
   * commitment (a later non-empty payload aborts), mirroring the offline path --
   * distinct from the observe path, which drops an ambiguous empty observation.
   * The invitation bounds this set to `MAX_PAYLOAD_ENTRIES` at intake, so it
   * needs no cap check here.
   */
  receivedPayloadLockIn?: { consentedColumns: string[] | undefined };
  /**
   * The ACCEPTOR's consent to its OWN outbound payload set, to persist into the
   * freshly-written config so a later recurring `psilink exchange` sends exactly
   * the columns consented to here or stops to ask (assertOutboundPayloadConsented).
   * The send-side counterpart of `receivedPayloadLockIn` above, and known
   * at the same moment -- what the acceptance displayed -- so it rides the same
   * first write. `undefined` persists no field, which is the online INVITER (its
   * own set is authored at mint and pinned as `disclosedPayloadColumns`) and an
   * acceptance that transmits nothing to its partner. On the reuse path the
   * record is refreshed in place on the kept config, beside the
   * `receivedPayloadLockIn` refresh.
   */
  outboundPayloadConsent?: OutboundPayloadConsent;
  /**
   * The online ACCEPTOR's terms-side commitment for THIS acceptance: the
   * `deduplicate` the invitation declared for the INVITING party's own side
   * (`token.linkageTerms.deduplicate`), recorded as the config's
   * `expectedPartnerDeduplicate` so a later recurring `psilink exchange` refuses a
   * partner presenting any other value at the terms exchange
   * (assertPresentedDeduplicateMatchesInvitation) -- the online sibling of the
   * offline-accept persistence, and the terms-side twin of
   * `receivedPayloadLockIn` above. Rides the same first write on a fresh config
   * and the same surgical in-place refresh of the kept config on the reuse path.
   *
   * `undefined` is a caller with no declaration to bind -- the online INVITER,
   * which accepted nothing -- and persists no field, leaving whatever the config
   * already has. The linkage-terms schema makes `deduplicate` mandatory, so an
   * acceptance always passes a boolean and never lands the config unbound.
   */
  expectedPartnerDeduplicate?: boolean;
  /**
   * The peer budget THIS run alone is bounded by, in seconds: the online
   * inviter's `--accept-timeout`, which bounds its wait at the rendezvous and the
   * peer waits of the exchange that follows. Applied to the live connection here
   * and to nothing that is written, so the configuration this bootstrap saves
   * has only the budget its `connection` already holds -- the operator's own
   * `--peer-timeout`, or none, in which case a later recurring `psilink exchange`
   * takes the documented `peer_timeout_ms` default rather than a wait sized for
   * one interactive setup. Absent for a caller whose run budget and persisted
   * budget are the same value (the online acceptor), which needs no override.
   */
  runOnlyPeerTimeoutSeconds?: number;
}): Promise<{ configWriteError?: unknown }> {
  // The two received-payload persistence inputs are mutually exclusive: the
  // online ACCEPTOR passes receivedPayloadLockIn (known up front from the
  // token), while the online INVITER and the zero-setup --save party pass
  // persistObservedReceivedPayload (learned only by observation). Encoded as a
  // check, not caller discipline, since both would let the observe-on-save
  // second write clobber the acceptor's up-front commitment.
  if (
    params.persistObservedReceivedPayload &&
    params.receivedPayloadLockIn !== undefined
  )
    throw new Error(
      "runOnlineBootstrap received both receivedPayloadLockIn (the acceptor's " +
        "up-front token lock-in) and persistObservedReceivedPayload (the " +
        "inviter's observe-on-save); these are mutually exclusive.",
    );

  // `connection` is already narrowed to the channels runProtocol supports
  // (ProtocolConnectionConfig); authentication is passed to runProtocol on its
  // own parameter rather than embedded in the connection config.
  const auth: AuthPersist = {
    sharedSecret: params.sharedSecret,
    expires: params.expires,
    keyFilePath: params.keyPath,
  };

  // Read the files any `@path` credential ref names, holding the values aside
  // rather than applying them: params.connection must keep the reference so the
  // saveConfig in the hook below persists it and not the secret. A missing,
  // unreadable, or empty referenced file is a UsageError (exit 64) decided from
  // this party's own filesystem, so it is checked here rather than after the
  // host-key step below, whose first-use probe opens a real transport to the
  // server.
  const credentials = readConnectionCredentials(params.connection);

  // Establish first-use SSH host-key trust before connecting, on the ORIGINAL
  // params.connection so the pin reaches both the live connect (via the clone
  // below) and the persisted config. A pinned connection is a no-op; an unpinned
  // one prompts on a TTY (online invite/accept are interactive) and fails closed
  // otherwise. When reusing a pre-existing config the post-handshake hook does
  // not re-write it, so the pin is written in place now (write-now); a fresh
  // config instead defers the mutation to its saveConfig (save-with-config), so a
  // failure before that hook fires leaves the pin unwritten and the next attempt
  // re-prompts (still failing closed, never silently downgraded).
  const hostKeyPersistence: HostKeyPersistence = params.reuseExistingConfig
    ? { mode: "write-now", configPath: params.configPath }
    : { mode: "save-with-config", configPath: params.configPath };
  await establishHostKeyTrust(params.connection, {
    verbosity: params.verbosity,
    loggerName: params.loggerName,
    persistence: hostKeyPersistence,
  });

  // The connection this run dials: params.connection with the credential values
  // read above applied and this run's own peer budget on top; params.connection
  // itself keeps neither, so the saveConfig in the hook below persists the
  // `@path` reference (not the secret) and no run-only wait. Cloned HERE rather
  // than at the read, so the host-key step's just-written pin rides into the
  // live connect. The budget goes through applyConnectionOverrides for its
  // cloning: required because the credential application returns a non-sftp
  // connection as-is, and mutating that would put the run-only budget straight
  // into what is persisted. The cast is safe: it only restores the
  // ProtocolConnectionConfig narrowing that both widen to ConnectionConfig, and
  // neither changes the channel.
  const liveConnection = applyConnectionOverrides(
    applyConnectionCredentials(params.connection, credentials),
    { options: { peerTimeout: params.runOnlyPeerTimeoutSeconds } },
  ) as ProtocolConnectionConfig;

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
  // Open the machine-interface stream here rather than leaving it to runProtocol:
  // this bootstrap's own persistence losses (both hooks below) must ride the
  // same fd-3 channel as the run's terminal result event, and runProtocol drives
  // the emitter but does not hand it to a hook, so reporting a loss means
  // holding the object here and passing it in. Opened immediately before
  // runProtocol -- after this command's host-key trust and credential
  // resolution, before any connection of the exchange's own -- so the
  // fail-closed fd-3 preflight still lands at the same point of the run.
  const eventStream = openEventStream(params.eventStream);
  try {
    const runResult = await runProtocol(
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
      // has completed, and a failed write throws before it -- what runProtocol's
      // onAuthenticatedError and the catch below depend on. If saveConfig is ever
      // made async, this hook must become `async` and `await` the call: an
      // unawaited async saveConfig would set `configWritten` before the write
      // settles, so a rejected write would resolve cleanly and masquerade as a
      // success.
      () => {
        // Reaching the hook means runProtocol already saved the rotated key
        // (it does so immediately before this call). Record that before the
        // reuse early-return so the recovery message below is gated on the key
        // actually being on disk.
        keyPersisted = true;
        if (params.reuseExistingConfig) {
          // The reconcile check already confirmed the pre-existing config agrees
          // with the invitation and URL; its connection and linkage blocks are
          // kept untouched. The rotated key is saved by runProtocol above; no
          // fresh config is written here, so `configWritten` stays false.
          //
          // The two machine-managed consent records are the exception, each
          // refreshed surgically in place: leaving a prior acceptance's value
          // stale would false-abort the next recurring exchange against an
          // honest partner (the received commitment) or block a set the operator
          // never declined (the outbound record). Each is gated on its own
          // caller's input and caught independently, so one failure neither
          // skips the other nor is fatal -- the kept config retains its prior
          // state, and runProtocol treats a hook throw as non-fatal.
          //
          // The received commitment follows the ACCEPTANCE's decision, so its
          // gate is the presence of a commitment at all: consented columns of
          // undefined is a subset-less invitation, which REMOVES a stale field
          // rather than leave a set this acceptance did not consent to, while a
          // caller that owns no commitment (the inviter, which learns its
          // received set by observation) never reaches this write.
          if (params.receivedPayloadLockIn !== undefined) {
            try {
              persistExpectedPayloadColumns(
                params.configPath,
                params.receivedPayloadLockIn.consentedColumns,
              );
            } catch (err) {
              const notice =
                `the exchange continues and the existing configuration at ` +
                `${params.configPath} stands, but recording the columns you ` +
                `consented to receive in it failed; the next 'psilink ` +
                `exchange' holds the received payload to the set that ` +
                `configuration already records, and checks it against no ` +
                `consented set if it records none`;
              getLogger(params.loggerName).warn(
                `${notice}: ${sanitizeErrorForDisplay(err)}`,
              );
              reportPersistenceLoss(notice, eventStream);
            }
          }
          // The outbound record's removal case follows the KEPT config's own
          // output terms rather than this parameter being absent: the caller
          // derives the reuse-path value from those terms (the accept handler's
          // reuse derivation), so undefined here means that config itself does
          // not transmit -- a leftover record is then inert against those same
          // terms -- and the record is left as it stands.
          if (params.outboundPayloadConsent !== undefined) {
            try {
              persistOutboundPayloadConsent(
                params.configPath,
                params.outboundPayloadConsent,
              );
            } catch (err) {
              const notice =
                `the exchange continues and the existing configuration at ` +
                `${params.configPath} stands, but recording your ` +
                `outbound-column confirmation in it failed; the next ` +
                `'psilink exchange' compares against the previously ` +
                `recorded set and will show the columns and ask again if ` +
                `they differ`;
              getLogger(params.loggerName).warn(
                `${notice}: ${sanitizeErrorForDisplay(err)}`,
              );
              reportPersistenceLoss(notice, eventStream);
            }
          }
          // The terms-side commitment is refreshed on the same gate as the
          // received one: its presence marks an acceptance, whose declaration
          // the operator has just consented to, while the inviter never reaches
          // this write.
          if (params.expectedPartnerDeduplicate !== undefined) {
            try {
              persistExpectedPartnerDeduplicate(
                params.configPath,
                params.expectedPartnerDeduplicate,
              );
            } catch (err) {
              const notice =
                `the exchange continues and the existing configuration at ` +
                `${params.configPath} stands, but recording the duplicate ` +
                `matching your partner declared in it failed; the next ` +
                `'psilink exchange' holds your partner to the value that ` +
                `configuration already records, and to no value if it records ` +
                `none`;
              getLogger(params.loggerName).warn(
                `${notice}: ${sanitizeErrorForDisplay(err)}`,
              );
              reportPersistenceLoss(notice, eventStream);
            }
          }
          // Unlike the offline path and the non-reuse branch below, there is no
          // config re-gate here: runProtocol already rotated and saved the key
          // before invoking this hook, so a config deleted during the handshake
          // window is unpreventable. That window is the documented immaterial
          // single-user TOCTOU (see assertNoProvisionConflicts).
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
          // The online ACCEPTOR's up-front token commitment rides this first
          // write: the set is known before the exchange (unlike the inviter's
          // observed set, written in the second write below). Folded on the
          // consented columns with the same `!== undefined` discriminant the
          // offline-accept path uses -- an empty array is a real "receive
          // nothing" commitment, only an absent set stays lazy.
          ...(params.receivedPayloadLockIn?.consentedColumns !== undefined
            ? {
                expectedPayloadColumns:
                  params.receivedPayloadLockIn.consentedColumns,
              }
            : {}),
          // The acceptor's own outbound-set consent rides the same write, from the
          // same moment: the set was displayed and consented to before this
          // handshake, so it is known here exactly as the received commitment above is.
          ...(params.outboundPayloadConsent !== undefined
            ? { outboundPayloadConsent: params.outboundPayloadConsent }
            : {}),
          // The acceptance's terms-side commitment, from that same moment: the
          // invitation declared the inviter's cardinality side and the consent
          // surface stated it, so a later recurring run refuses a partner
          // presenting anything else. Absent for the inviter, which accepted no
          // declaration.
          ...(params.expectedPartnerDeduplicate !== undefined
            ? { expectedPartnerDeduplicate: params.expectedPartnerDeduplicate }
            : {}),
        });
        configWritten = true;
      },
      // The online invite/accept run no file-sync entry-sweep (the sweep flags are
      // exchange/zero-setup only), so the trailing runtime object holds the
      // machine stream this bootstrap opened above (undefined when the flag is
      // off, which is runProtocol's own "no stream" state) and this bootstrap's
      // own last write.
      {
        eventStream,
        // Crystallize the OBSERVED received-payload set into the freshly-written
        // config so a later recurring `psilink exchange` fails closed on a
        // divergent payload (reconcileReceivedPayload). A SECOND write, distinct
        // from the acceptance hook's (which persists BEFORE the data exchange,
        // when the received set is unknown). Rides runProtocol's pre-terminal
        // hook, not a run after runProtocol returns, so the loss below is
        // reported BEFORE the run's terminal event -- the last point a
        // supervisor reading fd 3 will see it.
        //
        // Gated on: persistObservedReceivedPayload (only the inviter; the online
        // accept path knows its set up front and does not pass this),
        // configWritten (a fresh config the hook actually wrote -- never reuse,
        // whose in-place refreshes leave it false, nor a failed hook), and a
        // non-empty observation (observedReceivedColumnsForSave drops the
        // ambiguous empty case).
        //
        // Unlike the acceptance hook's saveConfig, this write has no
        // detectFileConflicts re-gate: it overwrites the config THIS run just
        // wrote, so a conflict check would always self-fire. The "do not clobber
        // the operator's config" gate already ran at that first write --
        // configWritten is true only if it passed.
        //
        // Non-fatal: the config is already on disk from the acceptance hook, so a
        // failure here only leaves the recurring path reconciling lazily -- its
        // prior behavior -- and must not fail the already-completed exchange.
        onOutputComplete: ({ observedReceivedPayloadColumns }) => {
          if (!params.persistObservedReceivedPayload || !configWritten) return;
          const observedLockIn = observedReceivedColumnsForSave(
            observedReceivedPayloadColumns,
          );
          if (observedLockIn === undefined) return;
          try {
            saveConfig(params.configPath, {
              connection: params.connection,
              ...params.dataSpec,
              expectedPayloadColumns: observedLockIn,
              // Included in this second full-spec write too: it re-serializes
              // the config the acceptance hook wrote, so omitting it would
              // silently drop a recorded outbound consent and leave the next run
              // ungated. No caller sets both today (this path is the inviter's),
              // so it needs no guard.
              ...(params.outboundPayloadConsent !== undefined
                ? { outboundPayloadConsent: params.outboundPayloadConsent }
                : {}),
              // Included for the same reason as the outbound consent above:
              // omitting it from this re-serialized write would drop a recorded
              // terms-side binding and leave the next run holding the partner to
              // nothing.
              ...(params.expectedPartnerDeduplicate !== undefined
                ? {
                    expectedPartnerDeduplicate:
                      params.expectedPartnerDeduplicate,
                  }
                : {}),
            });
          } catch (err) {
            const notice =
              `the exchange succeeded and ${params.configPath} was written, but ` +
              "recording the observed received-payload columns for fail-closed " +
              "recurring enforcement failed; the next 'psilink exchange' will " +
              "reconcile the received payload lazily";
            getLogger(params.loggerName).warn(
              `${notice}: ${sanitizeErrorForDisplay(err)}`,
            );
            reportPersistenceLoss(notice, eventStream);
          }
        },
      },
    );

    // onAuthenticatedError is the config-write failure, if any: the acceptance
    // hook is just the saveConfig call above, so report it under a name the
    // caller speaks.
    return { configWriteError: runResult.onAuthenticatedError };
  } catch (err) {
    // The exchange failed after a successful handshake. When BOTH the config and
    // the rotated key are on disk, tell the user so they retry with `psilink
    // exchange` instead of re-inviting. Logged at error level so it stays
    // visible alongside the error the handler then reports. Both files must
    // actually be present: a fresh run needs `configWritten`; a reuse run needs
    // `keyPersisted`, since a pre-handshake failure never saves the rotated key
    // (onlineBootstrap.test.ts, "runOnlineBootstrap with reuseExistingConfig
    // does not log a recovery note when the handshake fails before the key is
    // saved").
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
 * (`reuseExistingConfig`), the message reflects that: the rotated key was saved
 * and the config was kept, refreshed only in its machine-managed consent
 * records. When the config write failed at acceptance (`configWriteError` set),
 * the rotated key was still saved but the config was not; the underlying error
 * was already logged at error level by `runProtocol`, so this only corrects the
 * summary and points back to it. The failure summary is logged at `error`, not
 * `warn`, so it stays visible alongside the error it references.
 *
 * This is the human summary only: it moves no process state. The exit code a
 * wrapper gates on to catch a half-provisioned setup (a rotated key with no
 * configuration) is `PERSISTENCE_LOSS_EXIT_CODE`, set by `runProtocol` at the
 * failure itself, not by this function.
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
