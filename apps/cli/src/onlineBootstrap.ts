import type { Arguments } from "yargs";

import {
  getLogger,
  loadCSVFile,
  loadCSVColumnSample,
  INFER_DATE_SCAN_CAP,
  prepareForExchange,
  inferMetadata,
  getDefaultLinkageTerms,
  getDefaultStandardization,
  columnValues,
  inferDateFormat,
  LinkageStrategySchema,
  MAX_ENDPOINT_HOST_LENGTH,
  MAX_ENDPOINT_PATH_LENGTH,
  MAX_PAYLOAD_ENTRIES,
  safeParseConnectionConfig,
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
  PreparedExchange,
  SFTPConnectionConfig,
  WebRTCConnectionConfig,
} from "@psilink/core";

import { saveConfig } from "./config";
import { detectFileConflicts } from "./fileUtils";
import { resolveConnectionCredentials } from "./util/atSignRefs";
import { establishHostKeyTrust, type HostKeyPersistence } from "./hostKeyTrust";
import { openInputSource, singleValue } from "./util/cli";
import { runProtocol, type AuthPersist } from "./protocol";
import type { RunnableConnectionConfig } from "./connectionFromUrl";
import type { RecordOutput } from "./recordFile";

// The exchange-data portion of a spec: linkage terms (always present once
// resolved) plus the optional metadata and standardization. Distinct from
// core's ExchangeDataSpec, whose linkageTerms is Partial because it models the
// not-yet-resolved input to prepareForExchange; here resolution has happened.
export type ResolvedDataSpec = Omit<ExchangeSpec, "connection">;

// The placeholder host/username written into a config when the inviter did not
// supply a connection endpoint. Chosen to be obvious in a diff and to fail
// loudly (rather than silently connect somewhere) if the user runs `exchange`
// before editing them. The string is intentionally not a valid hostname.
const PLACEHOLDER_HOST = "REPLACE_WITH_SFTP_HOST";
const PLACEHOLDER_USERNAME = "REPLACE_WITH_SSH_USERNAME";

// Options seeded onto a connection built from a split-directory endpoint. A
// split configuration requires retain mode, which in turn requires lockless
// rendezvous and timestamped filenames (enforced by core's ConnectionConfig
// schema). An inviter only holds a split config while running retain mode, and
// retain mode is a bilateral setting, so an acceptor mirrored from a split
// endpoint needs the same trio. Seeding it makes the written connection block a
// runnable split-exchange starting point rather than one the operator must
// remember to complete before `psilink exchange` would validate.
const SPLIT_SEED_OPTIONS: FileSyncOptions = {
  retainFiles: true,
  locklessRendezvous: true,
  timestampInFilename: true,
};

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
 * Split-directory endpoints (sftp/filedrop carrying an inbound/outbound pair) are
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
      server: { host: PLACEHOLDER_HOST, username: PLACEHOLDER_USERNAME },
    };
    return { connection, seeded: false };
  }

  switch (endpoint.channel) {
    case "sftp": {
      if (endpoint.inboundPath !== undefined) {
        // Split-directory endpoint: mirror-swap the inviter's pair (inviter's
        // outbound -> this acceptor's inbound, inviter's inbound -> outbound).
        const connection: SFTPConnectionConfig = {
          channel: "sftp",
          server: {
            host: endpoint.host,
            port: endpoint.port,
            inboundPath: endpoint.outboundPath,
            outboundPath: endpoint.inboundPath,
            // The endpoint never carries credentials; mark the field the user
            // must supply (a password or private key is added via @path).
            username: PLACEHOLDER_USERNAME,
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
          // The endpoint never carries credentials; mark the field the user
          // must supply (a password or private key is added via @path).
          username: PLACEHOLDER_USERNAME,
        },
      };
      return { connection, seeded: true };
    }
    case "filedrop": {
      if (endpoint.inboundPath !== undefined) {
        // Split-directory endpoint: mirror-swap the inviter's pair (see the sftp
        // branch). filedrop carries no credentials, so no placeholder is needed.
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
        // undefined path reach connection.ts as an opaque schema failure.
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
 * Online accept carries two sources of connection truth: the typed URL (with any
 * `--server-*` overrides) gives the reachable target -- channel, host, port,
 * credentials -- and the credential-free endpoint gives the split-directory role
 * mapping the inviter is running. When the endpoint names a split pair, graft
 * that pair (mirror-swapped: inviter outbound -> acceptor inbound, and vice
 * versa) and the {@link SPLIT_SEED_OPTIONS} retain trio a split exchange requires
 * onto the URL-built connection, so the acceptor need not retype the mirrored
 * roles. The swap is applied by delegating to {@link connectionFromEndpoint} (the
 * single swap site) and lifting only its directory pair out, so the direction is
 * never re-implemented here nor double-applied.
 *
 * The split pair fully replaces the URL's single directory (an sftp/filedrop URL
 * path): a split role mapping is exactly what a single URL path cannot express,
 * and letting the URL path win for the inbound leg would break the mirror (the
 * acceptor must read where the inviter writes). Host, port, credentials, and the
 * channel stay the URL's -- the endpoint is credential-free, and in a bridged
 * topology the acceptor's reachable host (and even its transport) may differ from
 * the inviter's -- so the endpoint's path strings are placed per the URL's
 * channel. Any URL-derived `options` (timeouts) are preserved, with the retain
 * trio merged on top. The caller skips this entirely when `--outbound-path` was
 * passed (that explicit override wins).
 *
 * A no-op (returns the URL connection unchanged, `appliedSplitDirectories:
 * false`) when there is no endpoint, the endpoint is webrtc, or it carries a
 * single shared `path` rather than a split pair -- so a non-split invitation
 * leaves the online path exactly as it was.
 *
 * @internal exported for testing
 */
export function applyEndpointSplitDirectories(
  urlConnection: RunnableConnectionConfig,
  endpoint: ConnectionEndpoint | undefined,
): EndpointSplitMerge {
  if (
    endpoint === undefined ||
    endpoint.channel === "webrtc" ||
    endpoint.inboundPath === undefined
  )
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

  // The grafted split form carries invariants the plain shared connection does
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
 * Build the credential-free {@link ConnectionEndpoint} an online invitation
 * carries, from the connection the inviter is actually using (the
 * {@link connectionFromURL} result, with any `--server-*`/`--outbound-path`
 * overrides already applied). This is the producer inverse of
 * {@link connectionFromEndpoint}: it copies only the public locator
 * (host/port/path, or the split inbound/outbound pair) and NEVER a credential --
 * the endpoint type has no field for a password, private key, key-file path, or
 * username, and the strict endpoint schema rejects one besides, so credential
 * material cannot ride along by construction (the security invariant this task
 * exists to honor on the producer side).
 *
 * The split inbound/outbound pair is emitted VERBATIM -- the inviter's own
 * inbound stays inbound, its outbound stays outbound. The mirror swap that makes
 * the two parties images of each other lives solely at the accept-side
 * {@link connectionFromEndpoint}; swapping here too would double-swap and undo
 * it. A shared (single-`path`) connection emits a single `path` as before.
 * Guarding on `inboundPath` is enough to read `outboundPath`: the connection
 * reaching here is built and schema-validated, whose both-or-neither refine
 * rejects a half pair, so the pair is always whole (the same invariant
 * {@link connectionFromEndpoint} relies on the other direction -- `outboundPath`
 * is statically `string | undefined` but is never undefined once `inboundPath`
 * is set).
 *
 * Scoped to the file-sync channels by the {@link RunnableConnectionConfig}
 * parameter: a webrtc locator is the follow-up's producer (item 202482411,
 * blocked on the CLI gaining a webrtc transport), so webrtc never reaches here.
 *
 * `port` is carried only when it is a reachable 1-65535 value. Port 0 is the one
 * port the connection schema permits but the endpoint schema rejects (it is an
 * OS-assigned ephemeral port, never a connect target), so it is dropped rather
 * than emitted as a locator the partner could not dial -- and rather than
 * failing the whole invite when the endpoint is encoded. Mirrors
 * `webrtcEndpointFromLocation`'s port guard in the web inviter.
 *
 * A host or path longer than the endpoint schema allows
 * ({@link MAX_ENDPOINT_HOST_LENGTH} / {@link MAX_ENDPOINT_PATH_LENGTH}) is the
 * other connection-permits / endpoint-rejects mismatch (the connection schema
 * bounds neither by length). It is degenerate inviter input -- a real hostname
 * is <= 253 and a path <= PATH_MAX -- and is rejected here as a
 * {@link UsageError} naming the field, rather than dropped (truncating a locator
 * would change where the partner connects) or left to surface as an opaque
 * ZodError at encode.
 *
 * @internal exported for testing
 */
export function endpointFromConnection(
  connection: RunnableConnectionConfig,
): ConnectionEndpoint {
  // Keep a port only when it is a reachable 1-65535 value the endpoint schema
  // accepts; drop port 0 (see the doc comment) so encoding never fails on it.
  const reachablePort = (port: number | undefined): number | undefined =>
    port !== undefined && Number.isInteger(port) && port >= 1 && port <= 65535
      ? port
      : undefined;

  // Reject a locator longer than the endpoint schema permits with a clear,
  // field-named UsageError, rather than letting encodeInvitation reject it as an
  // opaque ZodError downstream (see the doc comment). A no-op for an unset field,
  // so each branch may check every locator field and only the present ones fire.
  const requireFits = (
    label: string,
    value: string | undefined,
    max: number,
  ): void => {
    if (value !== undefined && value.length > max)
      throw new UsageError(
        `${label} is too long to carry in an invitation connection endpoint ` +
          `(${value.length} > ${max} characters)`,
      );
  };

  if (connection.channel === "sftp") {
    const { server } = connection;
    requireFits("connection host", server.host, MAX_ENDPOINT_HOST_LENGTH);
    requireFits("connection path", server.path, MAX_ENDPOINT_PATH_LENGTH);
    requireFits("inbound_path", server.inboundPath, MAX_ENDPOINT_PATH_LENGTH);
    requireFits("outbound_path", server.outboundPath, MAX_ENDPOINT_PATH_LENGTH);
    if (server.inboundPath !== undefined)
      // Split-directory connection: emit the inviter's pair verbatim (the
      // acceptor mirror-swaps it at connectionFromEndpoint; do not pre-swap).
      return {
        channel: "sftp",
        host: server.host,
        port: reachablePort(server.port),
        inboundPath: server.inboundPath,
        outboundPath: server.outboundPath,
      };
    return {
      channel: "sftp",
      host: server.host,
      port: reachablePort(server.port),
      // Shared mode: the inviter's remote working directory (omitted for a
      // bare-host connection, which uses the server's default directory).
      path: server.path,
    };
  }

  // filedrop: the locator is the directory only -- no host/port/credentials.
  requireFits("connection path", connection.path, MAX_ENDPOINT_PATH_LENGTH);
  requireFits("inbound_path", connection.inboundPath, MAX_ENDPOINT_PATH_LENGTH);
  requireFits(
    "outbound_path",
    connection.outboundPath,
    MAX_ENDPOINT_PATH_LENGTH,
  );
  if (connection.inboundPath !== undefined)
    // Split-directory connection: emit the pair verbatim (swapped by the
    // acceptor, as in the sftp branch above).
    return {
      channel: "filedrop",
      inboundPath: connection.inboundPath,
      outboundPath: connection.outboundPath,
    };
  return {
    channel: "filedrop",
    path: connection.path,
  };
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
 * commands sharing this loader differ on it -- `invite` supports `-`, and
 * `accept` rejects it unless `--consent-to-terms` skips the confirmation prompt
 * that otherwise owns stdin. Defaults to stdin disabled so the shared loader never
 * enables it unconditionally.
 */
export async function loadInputRows(
  input: string,
  { allowStdin = false }: { allowStdin?: boolean } = {},
): Promise<{ rawRows: Array<CSVRow>; columns: string[] }> {
  const csvResult = await loadCSVFile(openInputSource(input, { allowStdin }));
  return {
    rawRows: csvResult.data,
    columns: csvResult.meta.fields ?? [],
  };
}

/**
 * Load only what `init`'s inference needs from a CSV -- the column header names
 * and a bounded sample of the date-of-birth column -- instead of the full row set
 * {@link loadInputRows} reads. `init` infers column metadata and linkage fields
 * from the header alone and the date-input format from the DOB column, and never
 * consumes any other row data, so this caps `init`'s peak memory at one parse
 * chunk rather than letting it scale with the input file (board item 206482800).
 *
 * The result is shaped exactly as {@link loadInputRows}'s -- `{ rawRows, columns
 * }` -- so it drops straight into {@link buildDataSpec} unchanged, keeping `init`
 * on the same inference path as `invite`/`accept` (matching their inferred terms
 * is a design goal). The trick is that `buildDataSpec` reads `rawRows` for one
 * purpose only: the DOB column's values, fed to {@link inferDateFormat}. So
 * `rawRows` here holds just that column's bounded sample, projected to one-field
 * records keyed by the DOB column name. The bound is exact, not heuristic: the
 * sample caps at {@link INFER_DATE_SCAN_CAP} non-empty values, the same cap
 * `inferDateFormat` stops its own scan at, so the date format inferred from the
 * sample is identical to one inferred from a full read.
 *
 * The DOB column is resolved by running {@link inferMetadata} over the header --
 * the same resolution `buildDataSpec` repeats internally, so the column the sample
 * is keyed on always matches the one `buildDataSpec` reads. The loader reports the
 * column it sampled, so that resolution runs once. When no DOB column is inferred,
 * the sample is empty and `rawRows` is empty (only the header was read).
 */
export async function loadInputRowsForInference(
  input: string,
  { allowStdin = false }: { allowStdin?: boolean } = {},
): Promise<{ rawRows: Array<CSVRow>; columns: string[] }> {
  const { columns, sampledColumn, sample } = await loadCSVColumnSample(
    openInputSource(input, { allowStdin }),
    (cols) => inferMetadata(cols).find((c) => c.type === "date_of_birth")?.name,
    INFER_DATE_SCAN_CAP,
  );
  const rawRows =
    sampledColumn !== undefined
      ? sample.map((value) => ({ [sampledColumn]: value }))
      : [];
  return { rawRows, columns };
}

// --- Linkage strategy selection ----------------------------------------------

/**
 * Apply the operator-selected linkage strategy onto CLI-authored default terms.
 * A no-op when `strategy` is undefined (the operator did not pass
 * `--linkage-strategy`, so the schema default the factory already set --
 * `cascade` -- stands) or when it already equals the terms' current value;
 * since CLI-authored default terms carry `cascade`, in practice only an explicit
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
 * The note surfaced when `single-pass` is selected (on the authoring side) or
 * carried by an invitation (on the accepting consent prompt): single-pass is a
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
    "single-pass linkage discloses the sender's full per-key value structure " +
    "to the receiver: the receiver observes matches on less precise keys that " +
    "cascade would have filtered out before exchanging them. The matched " +
    "result is unchanged -- this is a consented disclosure tradeoff for a " +
    "round-trip count that stays constant as keys are added, not a free " +
    "speed-up. See docs/EXCHANGE_REFERENCE.md (linkage_terms.linkage_strategy)."
  );
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
 *
 * `linkageStrategy`, when given, is applied ONLY to terms this function authors
 * from the defaults (the invite infer-from-input and online paths, where `terms`
 * is absent); it is the operator's `--linkage-strategy` selection. When `terms`
 * is supplied (accept derives them from the invitation, which already carries the
 * agreed strategy), the selection is not applied -- the partner's choice stands.
 * Absent (or `cascade`) leaves the default strategy untouched, so omitting the
 * selection is byte-identical to before the flag existed.
 */
export function buildDataSpec(args: {
  terms?: LinkageTerms;
  identity: string;
  rows?: { rawRows: Array<CSVRow>; columns: string[] };
  linkageStrategy?: LinkageStrategy;
}): { dataSpec: ResolvedDataSpec; warnings: string[] } {
  const { terms, identity, rows, linkageStrategy } = args;
  const warnings: string[] = [];

  if (rows === undefined) {
    if (terms === undefined)
      // Unreachable through the CLI (offline invite always has input, accept
      // always has terms); guards a future caller against an empty spec.
      throw new Error("buildDataSpec requires either terms or input rows");
    return { dataSpec: { linkageTerms: terms }, warnings };
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
    dobCol !== undefined
      ? inferDateFormat(columnValues(rows.rawRows, dobCol.name))
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

// Lifted into @psilink/core so the web acceptor and the CLI accept path share
// one detector; re-exported here for invite.ts (which imports from this module)
// and for backwards compatibility.
export { unsatisfiedLinkageFields } from "@psilink/core";

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
 * The received-payload lock-in to persist from an OBSERVED first exchange, or
 * `undefined` to persist nothing (leaving the field absent so the recurring path
 * reconciles lazily). A party that learns its received-payload set only by
 * observation -- the online inviter (its received set is whatever the acceptor
 * transmits, unknown until the first run) and a zero-setup `--save` party --
 * crystallizes that observed set into the saved config's `expectedPayloadColumns`
 * so a later recurring `psilink exchange` fails closed on a divergent received
 * payload ({@link reconcileReceivedPayload}). It is the observe-by-first-exchange
 * counterpart to the acceptor's up-front token lock-in (which learns the set at
 * invitation time and needs no observation).
 *
 * An EMPTY observation is deliberately NOT persisted: the partner transmits an
 * empty payload BOTH when it discloses nothing AND when the first exchange simply
 * had zero matched rows ({@link preparePayload} returns a no-data message in both
 * cases), and the two are indistinguishable on the receive side. Persisting `[]`
 * -- a strict "receive nothing" lock-in -- would abort an otherwise-honest later
 * run that does match and carries the partner's real columns. So an empty
 * observation stays lazy; a partner that starts transmitting columns later is
 * then accepted, which does not widen disclosure (each sender's own
 * `isDisclosedToPartner` metadata still governs what leaves its machine --
 * receiving is not disclosing). Only a NON-EMPTY observation, an unambiguous
 * agreed set, is crystallized.
 *
 * An observation of MORE than `MAX_PAYLOAD_ENTRIES` columns is likewise dropped
 * (stays lazy). The received-payload wire schema bounds each column NAME's length
 * but not the column COUNT (only the frame size does), whereas the persisted
 * `expectedPayloadColumns` field is bounded to `MAX_PAYLOAD_ENTRIES` on reload.
 * Persisting an over-cap observed set would write a config this party can no
 * longer load (the next `psilink exchange` would reject it, exit 64) -- a
 * self-inflicted brick a wide (honest or hostile) partner payload could trigger.
 * Truncating instead is wrong: a persisted subset would then diverge from the
 * partner's full re-transmitted set and false-abort every recurring run. Staying
 * lazy keeps the config loadable and degrades to the pre-crystallization behavior
 * (which never widens disclosure). The offline-accept/token path cannot hit this
 * because the invitation bounds its disclosed-columns subset to the same cap at
 * intake; this observe-on-save path is the first writer whose source is unbounded.
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
   * The received-payload column set the online ACCEPTOR consented to UP FRONT from
   * the invitation token (`token.disclosedPayloadColumns`), to persist into the
   * freshly-written config's `expectedPayloadColumns` so a later recurring `psilink
   * exchange` fails closed on a divergent received payload (reconcileReceivedPayload)
   * -- the online sibling of the offline-accept persistence. Unlike
   * `persistObservedReceivedPayload` (the inviter's
   * observe-then-persist, which learns its set only AFTER the exchange and writes it
   * in a SECOND post-exchange write), this set is known BEFORE the exchange, so it
   * rides the acceptance hook's FIRST write. An empty array is a real "receive
   * nothing" lock-in (a later non-empty payload aborts), mirroring the offline path
   * -- distinct from the observe path, which drops an ambiguous empty observation;
   * `undefined` persists no field, leaving the recurring path to reconcile lazily.
   * No-op on the reuse path, which writes no fresh config. The invitation bounds this
   * set to `MAX_PAYLOAD_ENTRIES` at intake, so it needs no cap check here (unlike the
   * observe path's unbounded source).
   */
  expectedReceivedPayloadColumns?: string[];
}): Promise<{ configWriteError?: unknown }> {
  // The two received-payload persistence inputs are mutually exclusive by design:
  // the online ACCEPTOR passes expectedReceivedPayloadColumns (its set is known up
  // front from the token, folded into the hook's first write), while the online
  // INVITER and the zero-setup --save party pass persistObservedReceivedPayload
  // (their set is learned only by observation, crystallized in a second write after
  // the exchange). No caller sets both; this encodes that invariant as a check
  // rather than caller discipline, because if both were set the observe-on-save
  // second write would silently clobber the acceptor's up-front token lock-in.
  if (
    params.persistObservedReceivedPayload &&
    params.expectedReceivedPayloadColumns !== undefined
  )
    throw new Error(
      "runOnlineBootstrap received both expectedReceivedPayloadColumns (the " +
        "acceptor's up-front token lock-in) and persistObservedReceivedPayload " +
        "(the inviter's observe-on-save); these are mutually exclusive.",
    );

  // `connection` is already narrowed to the channels runProtocol supports
  // (RunnableConnectionConfig); authentication is passed to runProtocol on its
  // own parameter rather than embedded in the connection config.
  const auth: AuthPersist = {
    sharedSecret: params.sharedSecret,
    expires: params.expires,
    keyFilePath: params.keyPath,
  };

  // Establish first-use SSH host-key trust before connecting, on the ORIGINAL
  // params.connection so the pin reaches both the live connect (via the clone
  // below) and the persisted config. A pinned connection is a no-op; an unpinned
  // one prompts on a TTY (online invite/accept are interactive) and fails closed
  // otherwise. When reusing a pre-existing config the post-handshake hook does
  // not re-write it, so the pin is written in place now (write-now); a fresh
  // config instead carries the mutation into its saveConfig (save-with-config).
  //
  // On the fresh (save-with-config) path the pin is persisted ONLY by that
  // post-handshake saveConfig, so a handshake or exchange failure before the hook
  // fires leaves the confirmed pin unwritten and the next attempt re-prompts.
  // That is consistent with this bootstrap's all-or-nothing semantics: a fresh
  // setup that does not reach acceptance leaves no config behind at all, so
  // re-confirming the host key on retry is expected, not a regression (and the
  // re-prompt still fails closed, so trust is never silently downgraded).
  const hostKeyPersistence: HostKeyPersistence = params.reuseExistingConfig
    ? { mode: "write-now", configPath: params.configPath }
    : { mode: "save-with-config", configPath: params.configPath };
  await establishHostKeyTrust(params.connection, {
    verbosity: params.verbosity,
    loggerName: params.loggerName,
    persistence: hostKeyPersistence,
  });

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
          // The online ACCEPTOR's up-front token lock-in rides this first write:
          // the set is known before the exchange (unlike the inviter's observed set,
          // written in the second write below). Folded with the same `!== undefined`
          // discriminant the offline-accept path uses -- an empty array is a real
          // "receive nothing" lock-in, only an absent set stays lazy.
          ...(params.expectedReceivedPayloadColumns !== undefined
            ? { expectedPayloadColumns: params.expectedReceivedPayloadColumns }
            : {}),
        });
        configWritten = true;
      },
    );
    // observedReceivedPayloadColumns is what this party received during the
    // completed exchange (undefined on a signal-interrupted run); it feeds the
    // observe-then-persist crystallization below.
    const { onAuthenticatedError, observedReceivedPayloadColumns } = runResult;

    // Crystallize the OBSERVED received-payload set into the freshly-written
    // config so a later recurring `psilink exchange` fails closed on a divergent
    // payload (reconcileReceivedPayload). This is a SECOND write, deliberately
    // distinct from the hook's: the hook persists at acceptance, BEFORE the data
    // exchange, so the received set is unknown to it; the set is known only after
    // runProtocol returns the completed exchange's observation. Moving the whole
    // write here instead is not an option -- it would forfeit the recovery
    // guarantee that a handshake-then-exchange failure still leaves a config on
    // disk. Gated on: persistObservedReceivedPayload (only the inviter, which
    // learns its received set by observation; the online accept path knows its set
    // up front from the token and does not pass this), configWritten (a fresh
    // config the hook actually wrote -- never the reuse path, which keeps the
    // operator's config untouched, nor a hook that failed), and a non-empty
    // observation (observedReceivedColumnsForSave drops the ambiguous empty case).
    // Unlike the hook's first saveConfig this write is deliberately NOT preceded by
    // a detectFileConflicts re-gate: it overwrites the config THIS run wrote at
    // acceptance, so a conflict check would always fire on our own just-written
    // file. The "do not clobber the operator's config" gate already ran at that
    // first write -- configWritten is true only if it passed -- so re-gating here
    // would add nothing but a spurious self-conflict.
    // Non-fatal: the config is already on disk from the hook, so a failure here
    // only leaves the recurring path reconciling lazily -- its prior behavior --
    // and must not fail the already-completed exchange.
    if (params.persistObservedReceivedPayload && configWritten) {
      const observedLockIn = observedReceivedColumnsForSave(
        observedReceivedPayloadColumns,
      );
      if (observedLockIn !== undefined) {
        try {
          saveConfig(params.configPath, {
            connection: params.connection,
            ...params.dataSpec,
            expectedPayloadColumns: observedLockIn,
          });
        } catch (err) {
          getLogger(params.loggerName).warn(
            `the exchange succeeded and ${params.configPath} was written, but ` +
              "recording the observed received-payload columns for fail-closed " +
              "recurring enforcement failed; the next 'psilink exchange' will " +
              "reconcile the received payload lazily: " +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      }
    }

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
