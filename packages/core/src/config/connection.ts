import { z } from "zod";
import { camelizeKeys } from "../utils/camelizeKeys.js";

// ─── HTTP service authentication ─────────────────────────────────────────────

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

// ─── Server provisioning ─────────────────────────────────────────────────────

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

// ─── Servers ─────────────────────────────────────────────────────────────────

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

// ─── Authentication ──────────────────────────────────────────────────────────

/**
 * Shared PAKE token for SPAKE2 mutual authentication. The token is
 * automatically rotated after each successful exchange; @-file recommended for
 * `pakeToken`.
 */
export interface Authentication {
  /** Shared SPAKE2 token; @-file recommended. */
  pakeToken: string;
  /**
   * WebRTC only. `invitor` or `acceptor`; used to derive deterministic PeerJS
   * peer IDs from the shared token so both parties know each other's address
   * without out-of-band communication. Orthogonal to the PSI sender/receiver
   * roles.
   */
  role?: "invitor" | "acceptor";
  /**
   * Expiration for this token (ISO 8601 datetime). The exchange is aborted
   * before the PAKE handshake if the current time is past this value.
   * Invitation tokens default to 1 hour; rotation-generated tokens carry none.
   */
  expires?: string;
}

const AuthenticationSchema: z.ZodType<Authentication> = z.object({
  pakeToken: z.string().min(1),
  role: z.enum(["invitor", "acceptor"]).optional(),
  expires: z.iso.datetime().optional(),
});

// ─── TURN and ICE (WebRTC only) ───────────────────────────────────────────────

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

// ─── SFTP proxy ───────────────────────────────────────────────────────────────

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

// ─── Options ─────────────────────────────────────────────────────────────────

/** WebRTC-specific tuning parameters. */
export interface WebRTCOptions {
  /** Milliseconds to wait for ICE candidate gathering; default: 5000. */
  iceTimeoutMs?: number;
  /** Maximum data-channel message size in bytes; default: 65536. */
  maxMessageSize?: number;
}

const WebRTCOptionsSchema: z.ZodType<WebRTCOptions> = z.object({
  iceTimeoutMs: z.int().nonnegative().optional(),
  maxMessageSize: z.int().positive().optional(),
});

/** SFTP-specific tuning parameters. */
export interface SFTPOptions {
  /**
   * Milliseconds between checks for the partner's uploaded file; default:
   * 30000.
   */
  pollIntervalMs?: number;
  /**
   * Total milliseconds to wait for the partner before giving up;
   * default: 3600000.
   */
  pollTimeoutMs?: number;
  /** Enable SSH compression; default: false. */
  compression?: boolean;
  /** Bytes per read/write chunk; default: 32768. */
  transferChunkSize?: number;
}

const SFTPOptionsSchema: z.ZodType<SFTPOptions> = z.object({
  pollIntervalMs: z.int().nonnegative().optional(),
  pollTimeoutMs: z.int().nonnegative().optional(),
  compression: z.boolean().optional(),
  transferChunkSize: z.int().positive().optional(),
});

// ─── Connection config ────────────────────────────────────────────────────────

/**
 * Connection configuration for a WebRTC exchange. `stun` and `turn` are
 * mutually exclusive with `iceProvision`.
 */
export interface WebRTCConnectionConfig {
  channel: "webrtc";
  server: WebRTCServer;
  authentication?: Authentication;
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
  options?: WebRTCOptions;
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
  options?: SFTPOptions;
  /**
   * Opaque key-value map passed verbatim to the underlying transport library.
   * @-file pathing is supported.
   */
  providerOptions?: Record<string, unknown>;
}

/** Connection configuration for an exchange. Discriminated by `channel`. */
export type ConnectionConfig = WebRTCConnectionConfig | SFTPConnectionConfig;

const WebRTCConnectionConfigSchema = z.object({
  channel: z.literal("webrtc"),
  server: WebRTCServerSchema,
  authentication: AuthenticationSchema.optional(),
  stun: z
    .array(
      z.string().regex(/^stuns?:/, "STUN URI must begin with stun: or stuns:"),
    )
    .optional(),
  turn: z.array(TurnServerSchema).optional(),
  iceProvision: IceProvisionSchema.optional(),
  options: WebRTCOptionsSchema.optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
});

const SFTPConnectionConfigSchema = z.object({
  channel: z.literal("sftp"),
  server: SFTPServerSchema,
  authentication: AuthenticationSchema.optional(),
  proxy: SFTPProxySchema.optional(),
  options: SFTPOptionsSchema.optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
});

export const ConnectionConfigSchema: z.ZodType<ConnectionConfig> = z
  .discriminatedUnion("channel", [
    WebRTCConnectionConfigSchema,
    SFTPConnectionConfigSchema,
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

// ─── Parse ────────────────────────────────────────────────────────────────────

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
