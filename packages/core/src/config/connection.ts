import { z } from "zod";
import { camelizeKeys } from "../utils/camelizeKeys.js";

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
 * Regex that a PAKE token must match: 43 base64url characters encoding exactly
 * 32 bytes. The final character encodes 4 data bits and 2 zero padding bits
 * (256 bits ÷ 6 = 42 full characters + 4 remaining data bits), constraining it
 * to the 16-character set `[AEIMQUYcgkosw048]`.
 */
export const PAKE_TOKEN_REGEX = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

// Shared Zod schema for the `pakeToken` field; reused by both Authentication
// and WebRTCAuthentication so the regex and error message stay in sync.
const pakeTokenSchema = z
  .string()
  .regex(
    PAKE_TOKEN_REGEX,
    "pakeToken must be a base64url-encoded 32-byte value (43 base64url " +
      "characters; final character must be in [AEIMQUYcgkosw048])",
  )
  .optional();

/**
 * Shared PAKE token for SPAKE2 mutual authentication. The token and its
 * expiration are stored in `.psilink.key` and injected at runtime; they never
 * appear in `psilink.yaml`.
 *
 * IMPORTANT: This type is the parse-time representation. `pakeToken` is
 * optional because a configuration file parsed in isolation may not yet
 * include a token. Before calling {@link authenticateConnection}, the caller
 * MUST populate `pakeToken` with a value matching {@link PAKE_TOKEN_REGEX};
 * the runtime check there rejects missing or malformed tokens with a tagged
 * recovery error, but the compile-time type does not enforce this.
 */
export interface Authentication {
  /**
   * Shared SPAKE2 token; loaded from `.psilink.key` at runtime and injected
   * into the connection config. Never written to `psilink.yaml`.
   *
   * Must be a base64url-encoded 32-byte value (exactly 43 characters from
   * `[A-Za-z0-9_-]`, with the final character constrained to
   * `[AEIMQUYcgkosw048]`).  Both invitation tokens and persistent (rotation)
   * tokens use this format; they differ only in whether `expires` is set.
   *
   * REQUIRED at the moment {@link authenticateConnection} is invoked, even
   * though the type marks it optional. The optionality exists only so that
   * intermediate parse states (config file loaded but key file not yet
   * injected) typecheck. Callers that bypass the CLI must ensure they
   * populate this field before calling the runtime API; otherwise
   * {@link authenticateConnection} throws a tagged validation error.
   */
  pakeToken?: string;
  /**
   * Expiration for this token (ISO 8601 datetime). The exchange is aborted
   * before the PAKE handshake if the current time is past this value.
   * Invitation tokens default to 1 hour; rotation-generated tokens carry none.
   */
  expires?: string;
}

const AuthenticationSchema: z.ZodType<Authentication> = z.object({
  pakeToken: pakeTokenSchema,
  expires: z.iso.datetime().optional(),
});

/**
 * WebRTC-specific authentication settings. Extends {@link Authentication} with
 * `role`, which is used to derive deterministic PeerJS peer IDs from the shared
 * token so both parties know each other's address without out-of-band
 * communication. Orthogonal to the PSI sender/receiver roles.
 */
export interface WebRTCAuthentication extends Authentication {
  /** `inviter` | `acceptor`; WebRTC only. */
  role?: "inviter" | "acceptor";
}

const WebRTCAuthenticationSchema: z.ZodType<WebRTCAuthentication> = z.object({
  pakeToken: pakeTokenSchema,
  expires: z.iso.datetime().optional(),
  role: z.enum(["inviter", "acceptor"]).optional(),
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
   * 3600000. The effective limit is the minimum of this and the remaining PAKE
   * token lifetime.
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
}

const FileSyncOptionsSchema: z.ZodType<FileSyncOptions> = z.object({
  ...sharedOptionsFields,
  pollIntervalMs: z.int().nonnegative().optional(),
  timestampInFilename: z.boolean().optional(),
});

// --- Connection config -------------------------------------------------------

/**
 * Connection configuration for a WebRTC exchange. `stun` and `turn` are
 * mutually exclusive with `iceProvision`.
 */
export interface WebRTCConnectionConfig {
  channel: "webrtc";
  server: WebRTCServer;
  authentication?: WebRTCAuthentication;
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
  authentication?: Authentication;
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
 * `.hello`/`.wave`/`.json` rendezvous protocol is identical to the SFTP
 * channel; no SSH connection is made. Use `file://` URLs with the CLI.
 *
 * PAKE authentication applies in the same way as the `sftp` channel: the
 * shared token in `.psilink.key` authenticates the exchange partner. This
 * matters because the remote end may be accessing the same storage over SFTP
 * rather than a local mount, so filesystem permissions alone do not guarantee
 * the partner's identity.
 */
export interface FileDropConnectionConfig {
  channel: "filedrop";
  /** Absolute path to the shared directory (Unix or Windows). */
  path: string;
  authentication?: Authentication;
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
  authentication: WebRTCAuthenticationSchema.optional(),
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
  authentication: AuthenticationSchema.optional(),
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
  authentication: AuthenticationSchema.optional(),
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
  );

// --- Parse -------------------------------------------------------------------

/**
 * Parse and validate a raw value as a {@link ConnectionConfig}.
 * Snake_case keys are converted to camelCase before validation, so JSON/YAML
 * from disk can be passed directly.
 *
 * Note: @-file references in credential fields (e.g. `pakeToken`, `password`,
 * `privateKey`) are not resolved here. Apply `readAtSignFile` (or equivalent)
 * to those fields before calling this function.
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
