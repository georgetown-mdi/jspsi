import { z } from "zod";
import { camelizeKeys } from "../utils/camelizeKeys.js";
import { randomBytes, toBase64Url } from "../utils/crypto.js";

// --- HTTP service authentication ---------------------------------------------

/**
 * Authentication credentials for an HTTP service (`server.provision`,
 * `iceProvision`, or `proxy`). Exactly one method may be specified; `username`
 * and `password` must appear together.
 */
export interface HttpAuth {
  /** Bearer token; @-file recommended. */
  bearer?: string;
  /** Username for HTTP Basic authentication. */
  username?: string;
  /** Password for HTTP Basic authentication; @-file recommended. */
  password?: string;
}

const HttpAuthSchema: z.ZodType<HttpAuth> = z
  .object({
    bearer: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
  })
  .refine((a) => (a.username !== undefined) === (a.password !== undefined), {
    message: "username and password must appear together",
  })
  .refine(
    (a) => [a.bearer, a.username].filter((v) => v !== undefined).length <= 1,
    { message: "at most one authentication method may be specified" },
  );

// --- Server provisioning -----------------------------------------------------

/**
 * An HTTP endpoint that provisions or wakes a supporting service before the
 * exchange begins. See EXCHANGE_SPEC.md §connection.server for lifecycle vs.
 * address-returning provisioning semantics.
 */
export interface ServerProvision {
  host: string;
  port?: number;
  path?: string;
  auth?: HttpAuth;
}

const ServerProvisionSchema: z.ZodType<ServerProvision> = z.object({
  host: z.string().min(1),
  port: z.int().min(0).max(65535).optional(),
  path: z.string().optional(),
  auth: HttpAuthSchema.optional(),
});

// --- Servers -----------------------------------------------------------------

/** PeerJS peer-coordination server for a WebRTC exchange. */
export interface WebRTCServer {
  host: string;
  port?: number;
  /** URL path for WebRTC signaling. */
  path?: string;
  username?: string;
  /** PeerJS API key for private servers; omit for public PeerJS servers. */
  key?: string;
  provision?: ServerProvision;
}

const WebRTCServerSchema: z.ZodType<WebRTCServer> = z.object({
  host: z.string().min(1),
  port: z.int().min(0).max(65535).optional(),
  path: z.string().optional(),
  username: z.string().optional(),
  key: z.string().optional(),
  provision: ServerProvisionSchema.optional(),
});

/**
 * SFTP host for an SFTP exchange. At most one primary authentication method
 * (`password` or `privateKey`) may be specified. `privateKeyPassphrase` and
 * `certificate` are companions to `privateKey` and are invalid without it.
 */
export interface SFTPServer {
  host: string;
  port?: number;
  /** Remote working directory. */
  path?: string;
  username?: string;
  /** Password authentication; @-file recommended. */
  password?: string;
  /** Path to SSH private key; @-file recommended. */
  privateKey?: string;
  /**
   * Passphrase for an encrypted private key; only valid with `privateKey`.
   */
  privateKeyPassphrase?: string;
  /**
   * SSH certificate for certificate-based auth; only valid with `privateKey`.
   */
  certificate?: string;
  /** Expected server host key fingerprint for host verification. */
  hostKeyFingerprint?: string;
  /** Path to a known_hosts file; alternative to `hostKeyFingerprint`. */
  knownHosts?: string;
  provision?: ServerProvision;
}

const SFTPServerSchema: z.ZodType<SFTPServer> = z
  .object({
    host: z.string().min(1),
    port: z.int().min(0).max(65535).optional(),
    path: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    privateKey: z.string().optional(),
    privateKeyPassphrase: z.string().optional(),
    certificate: z.string().optional(),
    hostKeyFingerprint: z.string().optional(),
    knownHosts: z.string().optional(),
    provision: ServerProvisionSchema.optional(),
  })
  .refine(
    (s) =>
      [s.password, s.privateKey].filter((v) => v !== undefined).length <= 1,
    {
      message:
        "at most one primary authentication method may be specified " +
        "(password or privateKey)",
    },
  )
  .refine(
    (s) =>
      !(s.privateKeyPassphrase !== undefined && s.privateKey === undefined),
    {
      message: "privateKeyPassphrase is only valid with privateKey",
      path: ["privateKeyPassphrase"],
    },
  )
  .refine((s) => !(s.certificate !== undefined && s.privateKey === undefined), {
    message: "certificate is only valid with privateKey",
    path: ["certificate"],
  });

// --- Authentication ----------------------------------------------------------

/**
 * Regex that a shared secret must match: 43 base64url characters encoding exactly
 * 32 bytes. The final character encodes 4 data bits and 2 zero padding bits
 * (256 bits ÷ 6 = 42 full characters + 4 remaining data bits), constraining it
 * to the 16-character set `[AEIMQUYcgkosw048]`.
 */
export const SHARED_SECRET_REGEX = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/**
 * Generate a fresh shared secret: 32 cryptographically random bytes
 * (`crypto.getRandomValues`) encoded as base64url, always matching
 * {@link SHARED_SECRET_REGEX}. Co-located with that regex so the producer and
 * the format contract stay in sync.
 *
 * This is the single definition of secret generation, shared by the CLI
 * invitation flow and the web inviter rather than re-implemented in each. The
 * value it produces is the 256-bit short-lived setup secret the X25519 key
 * exchange consumes and, in the web rendezvous flow, the seed for the derived
 * peer id; it is rotated to a persistent secret on the first successful
 * handshake.
 */
export function generateSharedSecret(): string {
  return toBase64Url(randomBytes(32));
}

// Named const for the `sharedSecret` field schema so the regex and error
// message live in one place.
const sharedSecretSchema = z
  .string()
  .regex(
    SHARED_SECRET_REGEX,
    "sharedSecret must be a base64url-encoded 32-byte value (43 base64url " +
      "characters; final character must be in [AEIMQUYcgkosw048])",
  )
  .optional();

/**
 * Shared secret for mutual authentication via the X25519 key exchange. The
 * secret and its expiration are stored in `.psilink.key` and injected at
 * runtime; they never appear in `psilink.yaml`. This is the type of the
 * channel-agnostic top-level `authentication` block of an {@link ExchangeSpec}
 * (a sibling of `signing`); see exchangeSpec.ts and EXCHANGE_SPEC.md.
 *
 * IMPORTANT: This type is the parse-time representation. `sharedSecret` is
 * optional because a configuration file parsed in isolation may not yet
 * include a secret. Before calling {@link authenticateConnection}, the caller
 * MUST populate `sharedSecret` with a value matching {@link SHARED_SECRET_REGEX};
 * the runtime check there rejects missing or malformed secrets with a tagged
 * recovery error, but the compile-time type does not enforce this.
 */
export interface Authentication {
  /**
   * Shared secret; loaded from `.psilink.key` at runtime and injected
   * into the `authentication` block. Never written to `psilink.yaml`.
   *
   * Must be a base64url-encoded 32-byte value (exactly 43 characters from
   * `[A-Za-z0-9_-]`, with the final character constrained to
   * `[AEIMQUYcgkosw048]`).  Both invitation secrets and persistent (rotation)
   * secrets use this format; they differ only in whether `expires` is set.
   *
   * REQUIRED at the moment {@link authenticateConnection} is invoked, even
   * though the type marks it optional. The optionality exists only so that
   * intermediate parse states (config file loaded but key file not yet
   * injected) typecheck. Callers that bypass the CLI must ensure they
   * populate this field before calling the runtime API; otherwise
   * {@link authenticateConnection} throws a tagged validation error.
   */
  sharedSecret?: string;
  /**
   * Expiration for this token (ISO 8601 datetime). The exchange is aborted
   * before the key exchange if the current time is past this value.
   * Invitation tokens default to 1 hour; rotation-generated tokens carry none.
   */
  expires?: string;
}

/**
 * Schema for the top-level `authentication` block, exported so
 * {@link ExchangeSpecSchema} can embed it as a sibling of `signing`. Field-shape
 * validation only; the injected fields (`sharedSecret`/`expires`) come from
 * `.psilink.key` and are warn-and-stripped if set in YAML (see the CLI loader).
 */
export const AuthenticationSchema: z.ZodType<Authentication> = z.object({
  sharedSecret: sharedSecretSchema,
  expires: z.iso.datetime().optional(),
});

// --- TURN and ICE (WebRTC only) ----------------------------------------------

/**
 * A TURN server used when a direct peer-to-peer connection cannot be
 * established.
 */
export interface TurnServer {
  /** TURN server URI (`turn:` or `turns:`). */
  url: string;
  username: string;
  /** TURN credential; @-file recommended. */
  credential: string;
  /**
   * `password` (default) | `hmac-sha1` for time-limited shared-secret
   * credentials.
   */
  credentialType?: "password" | "hmac-sha1";
}

const TurnServerSchema: z.ZodType<TurnServer> = z.object({
  url: z.string().regex(/^turns?:/, "TURN URL must begin with turn: or turns:"),
  username: z.string().min(1),
  credential: z.string().min(1),
  credentialType: z.enum(["password", "hmac-sha1"]).optional(),
});

/**
 * A provisioning endpoint returning a combined set of ICE servers (STUN +
 * TURN) for the current exchange. Mutually exclusive with `stun` and `turn`.
 */
export interface IceProvision {
  host: string;
  port?: number;
  path?: string;
  auth?: HttpAuth;
}

const IceProvisionSchema: z.ZodType<IceProvision> = z.object({
  host: z.string().min(1),
  port: z.int().min(0).max(65535).optional(),
  path: z.string().optional(),
  auth: HttpAuthSchema.optional(),
});

// --- SFTP proxy --------------------------------------------------------------

/**
 * A WebSocket-to-TCP proxy tunneling the SFTP connection through HTTPS.
 * Required for browser clients; CLI clients connect natively and omit this.
 * The two parties' configs may therefore differ here even when connecting to
 * the same server.
 */
export interface SFTPProxy {
  host: string;
  port?: number;
  path?: string;
  auth?: HttpAuth;
}

const SFTPProxySchema: z.ZodType<SFTPProxy> = z.object({
  host: z.string().min(1),
  port: z.int().min(0).max(65535).optional(),
  path: z.string().optional(),
  auth: HttpAuthSchema.optional(),
});

// --- Options -----------------------------------------------------------------

/**
 * Channel-agnostic tuning parameters shared by all connection types.
 */
export interface SharedOptions {
  /**
   * Total milliseconds to wait for the partner before giving up; default:
   * 3600000. The effective limit is the minimum of this and the remaining
   * shared-secret lifetime.
   */
  peerTimeoutMs?: number;
  /**
   * Milliseconds to wait per connection attempt to the primary exchange server;
   * default: 30000. For channels that retry (e.g. `sftp` and `filedrop`), this
   * limit applies to each attempt individually, not to the total across all
   * attempts. Retry delays between attempts are not counted against this
   * budget.
   */
  serverConnectTimeoutMs?: number;
  /** Maximum reconnect attempts before giving up; default: 3. */
  maxReconnectAttempts?: number;
}

const sharedOptionsFields = {
  peerTimeoutMs: z.int().nonnegative().optional(),
  serverConnectTimeoutMs: z.int().nonnegative().optional(),
  maxReconnectAttempts: z.int().nonnegative().optional(),
};

const SharedOptionsSchema: z.ZodType<SharedOptions> =
  z.object(sharedOptionsFields);

/** Tuning parameters shared by file-based channels (`sftp` and `filedrop`). */
export interface FileSyncOptions extends SharedOptions {
  /**
   * Milliseconds between checks for the partner's uploaded file; default:
   * 100.
   */
  pollIntervalMs?: number;
  /**
   * When `true`, each outgoing message filename also encodes a UTC timestamp
   * and a per-session sequence number, so filename-based logging can capture
   * when a file was written even in sync-mediated environments where the sync
   * tool stamps files with the transfer time rather than the original creation
   * time; default: `false`. With it unset, message filenames carry only the
   * declared byte count (`<id>-<byteCount>.json`).
   */
  timestampInFilename?: boolean;
  /**
   * When `true`, the rendezvous handshake uses an ack-handshake barrier
   * instead of the atomic-exclusive-create lock-file race. Both parties must
   * set this identically; the value is advertised in the hello payload and a
   * mismatch fails fast at rendezvous, symmetrically on both parties, with a
   * usage error naming each side's setting (rather than stalling until the
   * peer timeout).
   *
   * Intended for sync-mediated transports (e.g. a cloud-sync service
   * reconciling two local directories) where `createExclusive` lacks
   * atomicity or deletion has high propagation latency. Delete still works
   * on these transports — cleanup via `safeDelete` succeeds eventually —
   * but arrival order cannot be determined by an atomic exclusive-create.
   * This option is **not** intended for transports that genuinely cannot
   * delete; handshake files must be removable at `close()` time or they
   * accumulate and block future sessions.
   *
   * Default: `false`.
   */
  locklessRendezvous?: boolean;
  /**
   * A stable, human-readable identifier for this party on the file-sync
   * transport. Appears in every filename this party writes (hello, message,
   * ack) and in server-side logs and transcripts. When unset, a UUID is
   * generated at construction time.
   *
   * Requires `timestampInFilename: true`. A reused stable id across sessions
   * in the same directory (without a timestamp segment) could collide with a
   * leftover file from a crashed prior session, causing phantom message
   * detection via `hasOutstandingMessage`.
   *
   * The two parties must use distinct ids, and neither may be the other's id
   * extended by `-` (e.g. `"site"` and `"site-2"` are rejected at rendezvous
   * because `"site-2".startsWith("site-")` breaks prefix routing). Spaces
   * and `-` are permitted within an id. The value `"temp"` is reserved.
   * Filesystem-unsafe characters (`/` and NUL on all platforms; `<`, `>`,
   * `:`, `"`, `\`, `|`, `?`, `*` on Windows NTFS) are not validated but may
   * cause errors at the transport layer.
   */
  peerId?: string;
  /**
   * When `true`, the receiver writes a zero-length acknowledgment marker after
   * consuming each message, and the sender gates its next `send()` on that
   * marker rather than waiting for its own file to be deleted. No exchange file
   * is deleted as a protocol step; the shared directory becomes a permanent
   * transcript. Default: `false`.
   *
   * Intended for sync-mediated transports that do not propagate deletions
   * (where the delete-as-signal protocol would stall indefinitely) and for
   * audit/transcript retention use cases.
   *
   * Both parties must set this flag identically; the value is advertised in
   * the hello payload and a mismatch fails fast at rendezvous, symmetrically
   * on both parties, with a usage error naming each side's setting (rather
   * than stalling until the peer timeout). Requires
   * `timestampInFilename: true` -- without it, every message from the same
   * party collides on filename and a retained transcript would overwrite
   * itself. Also requires `locklessRendezvous: true` -- lock rendezvous is
   * delete-based and cannot produce the whole-directory no-delete transcript
   * retain mode guarantees.
   *
   * A fresh directory is required for each exchange and is enforced:
   * `synchronize()` throws a `UsageError` if any message or ack-marker files
   * from a prior session are present in the directory.
   */
  retainFiles?: boolean;
  /**
   * How to handle a file that appears in the shared directory *during* the
   * message loop and is neither recognized as part of this exchange nor a
   * known transient (an in-flight `temp-*.tmp` write). Directory exclusivity
   * is a stated precondition (see EXCHANGE_SPEC.md "Directory exclusivity"),
   * so such a file usually means the directory is being shared with another
   * process or session, or a sync tool produced a conflict copy or partial
   * download.
   *
   * - `error`: fail the exchange with a usage error (exit 64) naming the file
   *   and the directory path.
   * - `warn`: log the file once per distinct name and continue.
   * - `ignore`: skip silently (the pre-existing behavior).
   *
   * **Local, not bilateral.** Detecting a foreign file is a local observation
   * of one's own directory view; it needs no peer agreement and carries none
   * of the mismatch-stall risk of `lockless_rendezvous`/`retain_files`. The
   * two parties may run different values.
   *
   * When unset, the effective default is mode-coupled: `error` on plain
   * delete-mode transports (ordinary `sftp`/`filedrop`), and `warn` when
   * `retain_files` or `lockless_rendezvous` is set -- those flags signal a
   * sync-mediated transport that legitimately produces transient conflict
   * copies and partial downloads mid-session, where a hard fail would abort
   * exactly the exchanges retain mode targets. An explicit value always
   * overrides the mode-coupled default.
   *
   * This setting governs foreign-file detection only. A peer-prefixed file
   * that is a malformed *protocol* file (a message-shaped name a correctly
   * configured peer cannot produce) is always reported, regardless of this
   * setting.
   *
   * Default: `error` (plain) / `warn` (sync-mediated), as above.
   */
  unexpectedFiles?: "error" | "warn" | "ignore";
}

const FileSyncOptionsSchema: z.ZodType<FileSyncOptions> = z
  .object({
    ...sharedOptionsFields,
    pollIntervalMs: z.int().nonnegative().optional(),
    timestampInFilename: z.boolean().optional(),
    locklessRendezvous: z.boolean().optional(),
    peerId: z.string().min(1).optional(),
    retainFiles: z.boolean().optional(),
    unexpectedFiles: z.enum(["error", "warn", "ignore"]).optional(),
  })
  .refine((opts) => !opts.peerId || opts.timestampInFilename === true, {
    message:
      "peer_id requires timestamp_in_filename: true; without it, a reused " +
      "stable id can collide with a leftover file from a crashed prior " +
      "session, causing phantom message detection",
    path: ["peerId"],
  })
  .refine((opts) => opts.peerId !== "temp", {
    message:
      "peer_id 'temp' is reserved; the lockless rendezvous upload glob " +
      "('<myId>-*') would capture in-flight 'temp-*.tmp' writes",
    path: ["peerId"],
  })
  .refine((opts) => !opts.retainFiles || opts.timestampInFilename === true, {
    message:
      "retain_files requires timestamp_in_filename: true; without it, every " +
      "message from the same party shares a filename and a retained transcript " +
      "would overwrite itself",
    path: ["retainFiles"],
  })
  .refine((opts) => !opts.retainFiles || opts.locklessRendezvous === true, {
    message:
      "retain_files requires lockless_rendezvous: true; lock rendezvous is " +
      "delete-based (the joiner deletes the peer hello as a role-assignment " +
      "signal) and cannot produce the whole-directory no-delete transcript " +
      "retain mode guarantees",
    path: ["retainFiles"],
  });

// --- Connection config -------------------------------------------------------

/**
 * Connection configuration for a WebRTC exchange. `stun` and `turn` are
 * mutually exclusive with `iceProvision`.
 */
export interface WebRTCConnectionConfig {
  channel: "webrtc";
  server: WebRTCServer;
  /**
   * `inviter` | `acceptor`. Derives this party's deterministic PeerJS peer ID
   * from the shared secret so both parties reach each other without an
   * out-of-band address exchange. A peer-addressing/transport concern -- hence
   * its home on the WebRTC connection config rather than the channel-agnostic
   * top-level `authentication` block -- and orthogonal to the PSI
   * sender/receiver roles. Currently schema-only: not yet consumed by transport
   * logic (see the Web Exchange Rework / CLI WebRTC Transport items).
   */
  role?: "inviter" | "acceptor";
  /**
   * STUN servers for ICE candidate gathering; each entry is a `stun:` or
   * `stuns:` URI.
   */
  stun?: string[];
  /** TURN servers for relaying when no direct path can be found. */
  turn?: TurnServer[];
  /**
   * ICE credential API returning combined STUN + TURN servers.
   * Mutually exclusive with `stun` and `turn`.
   */
  iceProvision?: IceProvision;
  options?: SharedOptions;
  /**
   * Opaque key-value map passed verbatim to the underlying transport library.
   * Keys and values are defined by the connection implementation package.
   * @-file pathing is supported.
   */
  providerOptions?: Record<string, unknown>;
}

/** Connection configuration for an SFTP exchange. */
export interface SFTPConnectionConfig {
  channel: "sftp";
  server: SFTPServer;
  /**
   * WebSocket-to-TCP proxy for browser clients. CLI clients omit this and
   * connect natively.
   */
  proxy?: SFTPProxy;
  options?: FileSyncOptions;
  /**
   * Opaque key-value map passed verbatim to the underlying transport library.
   * @-file pathing is supported.
   */
  providerOptions?: Record<string, unknown>;
}

/**
 * Connection configuration for an exchange over a locally-mounted folder.
 * Both parties must have read/write access to the same directory (e.g. a
 * network share mounted by IT that is backed by an SFTP server). The
 * `-hello.json`/`-lock.json`/message-`.json` protocol is identical to the SFTP
 * channel; no SSH connection is made. Use `file://` URLs with the CLI.
 *
 * Shared-secret authentication applies in the same way as the `sftp` channel:
 * the shared secret in `.psilink.key` authenticates the exchange partner. This
 * matters because the remote end may be accessing the same storage over SFTP
 * rather than a local mount, so filesystem permissions alone do not guarantee
 * the partner's identity.
 */
export interface FileDropConnectionConfig {
  channel: "filedrop";
  /** Absolute path to the shared directory (Unix or Windows). */
  path: string;
  options?: FileSyncOptions;
  // No providerOptions: LocalFSClient has no underlying transport library to
  // pass opaque options to, unlike SSH2SFTPClientAdapter.
}

/** Connection configuration for an exchange. Discriminated by `channel`. */
export type ConnectionConfig =
  | WebRTCConnectionConfig
  | SFTPConnectionConfig
  | FileDropConnectionConfig;

// These intermediate schemas are intentionally left without z.ZodType<T>
// annotations: z.discriminatedUnion requires a concrete ZodObject, and the
// explicit annotation would widen the type to ZodType<T>, breaking it.
// Type safety is enforced at the ConnectionConfigSchema level instead.
const WebRTCConnectionConfigSchema = z.object({
  channel: z.literal("webrtc"),
  server: WebRTCServerSchema,
  role: z.enum(["inviter", "acceptor"]).optional(),
  stun: z
    .array(
      z.string().regex(/^stuns?:/, "STUN URI must begin with stun: or stuns:"),
    )
    .optional(),
  turn: z.array(TurnServerSchema).optional(),
  iceProvision: IceProvisionSchema.optional(),
  options: SharedOptionsSchema.optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
});

const SFTPConnectionConfigSchema = z.object({
  channel: z.literal("sftp"),
  server: SFTPServerSchema,
  proxy: SFTPProxySchema.optional(),
  options: FileSyncOptionsSchema.optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
});

const FileDropConnectionConfigSchema = z.object({
  channel: z.literal("filedrop"),
  path: z
    .string()
    .min(1)
    .refine(
      (p) =>
        p.startsWith("/") || // Unix or UNC with forward slashes
        /^[A-Za-z]:[/\\]/.test(p) || // Windows drive letter (C:\ or C:/)
        p.startsWith("\\\\"), // Windows UNC (\\server\share)
      { message: "path must be an absolute path" },
    ),
  options: FileSyncOptionsSchema.optional(),
});

export const ConnectionConfigSchema: z.ZodType<ConnectionConfig> = z
  .discriminatedUnion("channel", [
    WebRTCConnectionConfigSchema,
    SFTPConnectionConfigSchema,
    FileDropConnectionConfigSchema,
  ])
  .refine(
    (conn) =>
      !(
        conn.channel === "webrtc" &&
        conn.iceProvision !== undefined &&
        (conn.stun !== undefined || conn.turn !== undefined)
      ),
    { message: "iceProvision is mutually exclusive with stun and turn" },
  )
  // Defense-in-depth: locklessRendezvous is a FileSyncOptions field and
  // cannot be expressed on a webrtc config through the discriminated union
  // (webrtc uses SharedOptions, not FileSyncOptions). This refine guards the
  // path anyway so a future schema change cannot silently accept it.
  .refine(
    (conn) =>
      !(
        conn.channel === "webrtc" &&
        (conn.options as FileSyncOptions | undefined)?.locklessRendezvous
      ),
    { message: "locklessRendezvous is not valid for the webrtc channel" },
  )
  // Defense-in-depth: peerId is a FileSyncOptions field and cannot be
  // expressed on a webrtc config through the discriminated union (webrtc uses
  // SharedOptions, not FileSyncOptions). This refine guards the path anyway
  // so a future schema change cannot silently accept it.
  .refine(
    (conn) =>
      !(
        conn.channel === "webrtc" &&
        (conn.options as FileSyncOptions | undefined)?.peerId !== undefined
      ),
    { message: "peer_id is not valid for the webrtc channel" },
  )
  // Defense-in-depth: retainFiles is a FileSyncOptions field and cannot be
  // expressed on a webrtc config through the discriminated union (webrtc uses
  // SharedOptions, not FileSyncOptions). This refine guards the path anyway
  // so a future schema change cannot silently accept it; the path is not
  // reachable through the current union.
  .refine(
    (conn) =>
      !(
        conn.channel === "webrtc" &&
        (conn.options as FileSyncOptions | undefined)?.retainFiles
      ),
    { message: "retain_files is not valid for the webrtc channel" },
  );

// --- Parse -------------------------------------------------------------------

/**
 * Parse and validate a raw value as a {@link ConnectionConfig}.
 * Snake_case keys are converted to camelCase before validation, so JSON/YAML
 * from disk can be passed directly.
 *
 * Note: @-file references in credential fields (e.g. `password`, `privateKey`)
 * are not resolved here. Apply `readAtSignFile` (or equivalent) to those fields
 * before calling this function.
 *
 * @throws {ZodError} if validation fails.
 */
export function parseConnectionConfig(raw: unknown): ConnectionConfig {
  return ConnectionConfigSchema.parse(camelizeKeys(raw));
}

/** Non-throwing version of {@link parseConnectionConfig}. */
export function safeParseConnectionConfig(raw: unknown) {
  return ConnectionConfigSchema.safeParse(camelizeKeys(raw));
}

/**
 * Parse and validate a raw value as {@link FileSyncOptions}.
 * Snake_case keys are converted to camelCase before validation; already-
 * camelCase objects (e.g. from {@link applyConnectionOverrides}) are accepted
 * unchanged.
 *
 * @throws {ZodError} if validation fails.
 */
export function parseFileSyncOptions(raw: unknown): FileSyncOptions {
  return FileSyncOptionsSchema.parse(camelizeKeys(raw));
}

/** Non-throwing version of {@link parseFileSyncOptions}. */
export function safeParseFileSyncOptions(raw: unknown) {
  return FileSyncOptionsSchema.safeParse(camelizeKeys(raw));
}
