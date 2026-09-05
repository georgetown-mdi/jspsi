import { z } from "zod";
import { camelizeKeys } from "../utils/camelizeKeys.js";
import { safeParseCamelized } from "./safeParseCamelized.js";
import { randomBytes, toBase64Url } from "../utils/crypto.js";
import { pathsResolveToSameDir } from "../utils/pathCompare.js";

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
 * exchange begins. See EXCHANGE_REFERENCE.md section connection.server for lifecycle vs.
 * address-returning provisioning semantics.
 */
interface ServerProvision {
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
interface WebRTCServer {
  host: string;
  port?: number;
  /** URL path for WebRTC signaling. */
  path?: string;
  username?: string;
  /** PeerJS API key for private servers; omit for public PeerJS servers. */
  key?: string;
  /**
   * Whether the signaling socket uses TLS (`wss:`) rather than plain `ws:`.
   * Defaults to `true` when unset. Signaling sends the derived rendezvous ids
   * and both parties' candidate addresses, so set this to `false` only for a
   * broker reached with no network in between (a loopback or test broker),
   * never by leaving it unset. A browser peer has no equivalent field: it takes
   * the scheme from the page it was served over.
   */
  secure?: boolean;
  provision?: ServerProvision;
}

const WebRTCServerSchema: z.ZodType<WebRTCServer> = z.object({
  host: z.string().min(1),
  port: z.int().min(0).max(65535).optional(),
  path: z.string().optional(),
  username: z.string().optional(),
  key: z.string().optional(),
  secure: z.boolean().optional(),
  provision: ServerProvisionSchema.optional(),
});

/**
 * Regex matching a valid SSH host-key fingerprint in OpenSSH SHA256 format: the
 * `SHA256:` prefix followed by 43 unpadded standard base64 characters (alphabet
 * `[A-Za-z0-9+/]`, not base64url `[A-Za-z0-9_-]`). The final character encodes
 * the last 4 of 256 data bits plus 2 zero padding bits, so it is limited to a
 * 16-value set. A bare base64url value -- the shape of a signing
 * `partner_fingerprint` -- is detected separately to name the confusion.
 */
export const HOST_KEY_FINGERPRINT_REGEX =
  /^SHA256:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$/;

/**
 * SFTP host for an SFTP exchange. At most one primary authentication method
 * (`password` or `privateKey`) may be specified. `privateKeyPassphrase` is a
 * companion to `privateKey` and is invalid without it.
 */
interface SFTPServer {
  host: string;
  port?: number;
  /** Remote working directory (shared mode). */
  path?: string;
  /**
   * Inbound (peer-written) remote directory for a split-directory exchange:
   * this party reads the peer's files here and writes its own to
   * {@link outboundPath}. Set together with `outboundPath`; mutually exclusive
   * with `path`, and requires retain mode. Follows the same per-path rules as
   * `path` (absolute, relative, or unset are all permitted for SFTP), except
   * that both halves of the pair must be set.
   */
  inboundPath?: string;
  /**
   * Outbound (self-written) remote directory for a split-directory exchange;
   * the companion to {@link inboundPath}. Must differ from it.
   */
  outboundPath?: string;
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
   * Answers the server's `keyboard-interactive` prompts with the configured
   * `password`, in addition to the direct `password` method. Only valid with
   * `password`; boolean, default `false`. Use for a server that accepts
   * `keyboard-interactive` but not direct `password` auth. Every prompt gets
   * the same stored password, so it cannot satisfy a multi-prompt or
   * one-time-code challenge. See docs/EXCHANGE_REFERENCE.md.
   */
  keyboardInteractive?: boolean;
  /**
   * Expected server host-key fingerprint(s), OpenSSH SHA256 format (`SHA256:<43
   * base64 chars>`): a fingerprint or non-empty list. When set, every SFTP
   * connection on the CLI `sftp` channel requires the server's key to match one
   * of them or aborts. A list supports zero-downtime rotation: stage the new
   * key alongside the old, then drop the old entry after cutover. Each entry is
   * validated to canonical form; @-file supported per entry.
   */
  hostKeyFingerprint?: string | string[];
  provision?: ServerProvision;
}

// Shape of a signing partner_fingerprint (base64url, 43 chars, no prefix) --
// detected to name the confusion when an operator pastes one into
// host_key_fingerprint instead of an OpenSSH SHA256 fingerprint.
const SIGNING_FINGERPRINT_SHAPE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

const SFTPServerSchema: z.ZodType<SFTPServer> = z
  .object({
    host: z.string().min(1),
    port: z.int().min(0).max(65535).optional(),
    path: z.string().optional(),
    inboundPath: z.string().min(1).optional(),
    outboundPath: z.string().min(1).optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    privateKey: z.string().optional(),
    privateKeyPassphrase: z.string().optional(),
    keyboardInteractive: z.boolean().optional(),
    // Kept in the schema (not stripped by z.object()) so that a config that
    // supplies either field gets a clear rejection refine below rather than
    // silent discard. The transform at the end drops both before the output
    // reaches the SFTPServer interface type.
    certificate: z.string().optional(),
    // A single fingerprint or a non-empty list (zero-downtime rotation): the
    // base type stays loose (string or string[]) so the superRefine below can
    // emit the canonical-format and signing-confusion messages per entry and
    // reject an empty list with an actionable message, rather than Zod's generic
    // union/array errors.
    hostKeyFingerprint: z.union([z.string(), z.array(z.string())]).optional(),
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
  // keyboard_interactive answers the server's prompts with `password`, so it is
  // meaningless without one. Requiring password also makes it mutually exclusive
  // with privateKey by construction (the at-most-one-primary refine above already
  // forbids password+privateKey together), so no separate key check is needed.
  .refine(
    (s) => !(s.keyboardInteractive === true && s.password === undefined),
    {
      message:
        "keyboard_interactive requires password; it answers the server's " +
        "keyboard-interactive prompts with that password and has no effect " +
        "without one",
      path: ["keyboardInteractive"],
    },
  )
  .refine((s) => s.certificate === undefined, {
    message:
      "certificate is not yet supported; remove it from the config -- " +
      "SSH client-auth certificates are a planned feature and will be " +
      "accepted in a future release",
    path: ["certificate"],
  })
  .refine((s) => s.knownHosts === undefined, {
    message:
      "known_hosts is not yet implemented; use host_key_fingerprint to " +
      "pin the server's SSH host-key fingerprint instead",
    path: ["knownHosts"],
  })
  .superRefine((s, ctx) => {
    const fp = s.hostKeyFingerprint;
    if (fp === undefined) return;
    const list = Array.isArray(fp) ? fp : [fp];
    // An empty list pins no key and would refuse every connection -- a config
    // mistake better caught at parse than left as a silent no-pin posture at
    // connect time.
    if (list.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "host_key_fingerprint must list at least one fingerprint; an empty " +
          "list pins no key and would refuse every connection",
        path: ["hostKeyFingerprint"],
      });
      // Empty list fully diagnosed above; with no entries the per-entry loop
      // would be a no-op, so stop here rather than fall through to it.
      return;
    }
    list.forEach((entry, i) => {
      // Point a list entry's issue at its index so the operator can locate the
      // bad one; a scalar's issue stays on the field.
      const path: (string | number)[] = Array.isArray(fp)
        ? ["hostKeyFingerprint", i]
        : ["hostKeyFingerprint"];
      // A literal `@path` is an @-file reference resolved after parse (see
      // resolveConnectionAtSignRefs): the `@path` cannot match the SHA256:
      // format, so it is exempt here and the resolved file contents are
      // format-checked at resolution instead. The sibling @-file fields
      // (password, privateKey) have no format refine, so they pass parse the
      // same way.
      if (entry.startsWith("@")) return;
      if (SIGNING_FINGERPRINT_SHAPE.test(entry)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "host_key_fingerprint looks like a signing partner_fingerprint " +
            "(43 base64url characters, no prefix); SSH host-key fingerprints " +
            "use standard base64 (+ and / not _ and -) with a SHA256: prefix, " +
            "e.g. SHA256:abc...xyz",
          path,
        });
      } else if (!HOST_KEY_FINGERPRINT_REGEX.test(entry)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "host_key_fingerprint must be in OpenSSH SHA256 format: the " +
            "SHA256: prefix followed by 43 unpadded standard base64 characters",
          path,
        });
      }
    });
  })
  .transform(
    // Strip the detected-but-rejected fields so the output matches the
    // SFTPServer type, which does not declare them. The refines above ensure
    // neither field is set when the transform runs, since only a valid parse
    // reaches it.
    ({ certificate: _cert, knownHosts: _kh, ...rest }) => rest,
  );

// --- Authentication ----------------------------------------------------------

/**
 * Regex that a shared secret must match: 43 base64url characters encoding exactly
 * 32 bytes. The final character encodes 4 data bits and 2 zero padding bits
 * (256 bits / 6 = 42 full characters + 4 remaining data bits), constraining it
 * to the 16-character set `[AEIMQUYcgkosw048]`.
 */
export const SHARED_SECRET_REGEX = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/**
 * Generates a fresh shared secret: 32 cryptographically random bytes
 * (`crypto.getRandomValues`) encoded as base64url, matching
 * {@link SHARED_SECRET_REGEX}. The single definition of secret generation,
 * shared by the CLI and web inviters. It is the 256-bit short-lived setup
 * secret the P-256 key exchange consumes, and in the web flow the seed for
 * the derived peer id, rotated to a persistent secret at first handshake.
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
 * Shared secret for mutual authentication via the P-256 key exchange, stored
 * with expiration in `.psilink.key`, injected at runtime -- never in
 * `psilink.yaml` (the top-level `authentication` block on
 * {@link ExchangeSpec}). `sharedSecret` is optional: a config parsed alone may
 * lack one. Before calling {@link authenticateConnection}, populate it with a
 * value matching {@link SHARED_SECRET_REGEX} -- enforced there at runtime, not
 * by this type.
 */
export interface Authentication {
  /**
   * Shared secret; loaded from `.psilink.key` at runtime and injected into the
   * `authentication` block, never written to `psilink.yaml`. Must be a
   * base64url-encoded 32-byte value (43 characters from `[A-Za-z0-9_-]`, final
   * character in `[AEIMQUYcgkosw048]`). Invitation secrets and persistent
   * (rotation) secrets share this format, differing only in the accompanying
   * {@link expires}.
   */
  sharedSecret?: string;
  /**
   * Expiration for this token (ISO 8601 datetime), or absent for a persistent
   * token with no maximum age. The exchange aborts before the key exchange, and
   * again after it (catching a lapse during the round-trip), once the current
   * time passes this value. Written by two sources -- an invitation's bounded
   * lifetime (default 1 hour) or a {@link tokenMaxAgeDays} stamp on a rotated
   * token -- which core does not distinguish: both mean the same expiry and
   * recover the same way (re-invite).
   */
  expires?: string;
  /**
   * Operator policy: maximum age, in days, to stamp onto a rotated token. A
   * successful exchange records `expires` = rotation time + `tokenMaxAgeDays`
   * days into `.psilink.key`, so a dormant partnership cannot hold a valid
   * token indefinitely; omitted means no expiry (the default). Unlike
   * `sharedSecret`/`expires`, this is operator-authored in `psilink.yaml`. A
   * positive integer bounded by {@link MAX_TOKEN_MAX_AGE_DAYS}, computed at
   * rotation time (in the CLI), not at parse time.
   */
  tokenMaxAgeDays?: number;
}

/**
 * Upper bound on {@link Authentication.tokenMaxAgeDays} (~100 years). Not a
 * policy statement -- realistic max-age is far smaller (the sibling invitation
 * lifetime caps at 1 year) -- but a sanity ceiling: it keeps `now +
 * tokenMaxAgeDays` days within the representable `Date` range (a 4-digit ISO
 * year), so an overflowing value cannot reach the rotation write path and throw
 * there, after the partner has already completed the handshake.
 */
export const MAX_TOKEN_MAX_AGE_DAYS = 36500;

/**
 * Schema for the top-level `authentication` block, embedded by
 * {@link ExchangeSpecSchema} as a sibling of `signing`. The injected fields
 * (`sharedSecret`/`expires`) come from `.psilink.key` and are warn-and-stripped
 * if set in YAML by the CLI loader, which strips them before this schema runs.
 * `strictObject`, unlike the sibling spec blocks: a misspelled
 * `tokenMaxAgeDays` -- a security control -- must reject at parse, not silently
 * drop and disable itself.
 */
export const AuthenticationSchema: z.ZodType<Authentication> = z.strictObject({
  sharedSecret: sharedSecretSchema,
  expires: z.iso.datetime().optional(),
  tokenMaxAgeDays: z.int().positive().max(MAX_TOKEN_MAX_AGE_DAYS).optional(),
});

// --- TURN and ICE (WebRTC only) ----------------------------------------------

/**
 * A TURN server used when a direct peer-to-peer connection cannot be
 * established.
 */
interface TurnServer {
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
interface IceProvision {
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
interface SFTPProxy {
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
interface SharedOptions {
  /**
   * Total milliseconds to wait for the partner before giving up; default:
   * 3600000. Must be a positive integer: it is the per-await peer-inactivity
   * liveness budget, so a zero value would fire every transport await
   * immediately and disable the liveness control. The effective limit is the
   * minimum of this and the remaining shared-secret lifetime.
   */
  peerTimeoutMs?: number;
  /**
   * Milliseconds to wait per connection attempt to the primary exchange server;
   * default 30000. Must be a positive integer: zero is not a meaningful "no
   * timeout" here -- on `filedrop` it times out the local-FS connect probe
   * immediately against a healthy mount, and on `sftp` it disables ssh2's
   * connect-establishment timeout (which arms only when positive). For a
   * retrying channel (`sftp`, `filedrop`) this applies per attempt, not to the
   * total, and retry delays are not counted against it.
   *
   * Stays optional in the type despite the schema's
   * {@link DEFAULT_SERVER_CONNECT_TIMEOUT_MS} `.default()`: this type covers
   * both the caller-supplied input (field may be omitted) and the parsed
   * output, and an omitted `options` block leaves it `undefined` regardless of
   * the default. Consumers treat it as possibly unset and apply the same
   * constant themselves at the connect sites (see fileSyncConnection).
   */
  serverConnectTimeoutMs?: number;
  /** Maximum reconnect attempts before giving up; default: 3. */
  maxReconnectAttempts?: number;
}

/**
 * Default per-attempt connect timeout (30000 ms) applied to
 * {@link SharedOptions.serverConnectTimeoutMs} when unset -- at the schema
 * boundary, and reused as the fallback at the SFTP and filedrop connect sites
 * for a config with no `options` block at all, so the documented 30000 ms
 * deadline always holds rather than `sftp` silently falling back to ssh2's
 * shorter (~20s) `readyTimeout`.
 */
export const DEFAULT_SERVER_CONNECT_TIMEOUT_MS = 30000;

/**
 * Default number of reconnect attempts after a transient connection failure when
 * the connection options do not set `maxReconnectAttempts`. Exported for the same
 * reason as {@link DEFAULT_SERVER_CONNECT_TIMEOUT_MS}; bounded above by
 * {@link MAX_RECONNECT_ATTEMPTS}.
 */
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 3;

/**
 * Sanity ceiling, in seconds, for a coordination timeout an operator states:
 * seven days. Each capped flag (`--connection-timeout`, `--peer-timeout`,
 * `--accept-timeout`) rejects an over-ceiling value with a flag-named usage
 * error before any side effect. A usability cap, not a security control: the
 * accept window is independently bounded by the invitation token's own
 * lifetime. Defined in core, like {@link MAX_RECONNECT_ATTEMPTS}, because both
 * the CLI's duration-flag parser and the console's authoring surface must agree
 * on it.
 */
export const MAX_TIMEOUT_SECONDS = 7 * 24 * 60 * 60;

/**
 * Upper bound on {@link SharedOptions.maxReconnectAttempts}: 604800 attempts --
 * the connect-retry loop's 1-second inter-attempt delay times
 * {@link MAX_TIMEOUT_SECONDS} (604800 s), so the count cannot outlast that same
 * ~7-day wall clock against a fast-refusing endpoint (ECONNREFUSED on sftp,
 * EACCES/ENOENT on filedrop). Bounds only that fast-fail case: a
 * slow-but-answering endpoint is already held per-attempt by
 * `serverConnectTimeoutMs`. Defined in core because both the schema's `.max()`
 * and the CLI's `nonNegativeIntFlag` parse guard must agree on it. An
 * over-ceiling value is rejected as a `UsageError` (exit 64) from either
 * `psilink.yaml` or `--max-reconnect-attempts`.
 */
export const MAX_RECONNECT_ATTEMPTS = 7 * 24 * 60 * 60;

const sharedOptionsFields = {
  // positive, not nonnegative: peerTimeoutMs is the per-await liveness budget,
  // so a zero would fire every transport await immediately and disable the
  // liveness control (the CLI's --peer-timeout already rejects zero; this closes
  // the same hole on the config/programmatic path).
  peerTimeoutMs: z.int().positive().optional(),
  // positive for the same reason: zero disables the filedrop connect probe and
  // ssh2's readyTimeout (armed only when > 0); --connection-timeout already
  // rejects zero. Defaulted (not just optional) so an unset value resolves to
  // DEFAULT_SERVER_CONNECT_TIMEOUT_MS at the schema boundary, applied uniformly
  // for sftp and filedrop. Fires only when the options object is present but
  // the field is absent; an omitted options block is covered by the same
  // constant at the connect sites in fileSyncConnection.
  serverConnectTimeoutMs: z
    .int()
    .positive()
    .default(DEFAULT_SERVER_CONNECT_TIMEOUT_MS),
  // nonnegative, not positive: zero is meaningful here -- "connect once, do not
  // reconnect" -- so it stays valid. Capped by MAX_RECONNECT_ATTEMPTS: the
  // connect-retry loop paces at a fixed 1s floor, so an unbounded count is a
  // wall-clock self-DoS. The CLI boundary (nonNegativeIntFlag) applies the same
  // ceiling, so the parse guard and this re-validation agree.
  maxReconnectAttempts: z
    .int()
    .nonnegative()
    .max(MAX_RECONNECT_ATTEMPTS)
    .optional(),
};

const SharedOptionsSchema: z.ZodType<SharedOptions> =
  z.object(sharedOptionsFields);

/** Tuning parameters shared by file-based channels (`sftp` and `filedrop`). */
export interface FileSyncOptions extends SharedOptions {
  /**
   * Milliseconds between checks for the partner's uploaded file. Must be a
   * positive integer: `0` is not "as fast as possible" but a `setTimeout(0)`
   * hot poll that busy-loops directory listings (a self-inflicted flood), so
   * the schema rejects it. When unset, the connection applies
   * `DEFAULT_POLLING_FREQUENCY_MS` (5000); see that constant in
   * `fileSyncConnection.ts`.
   */
  pollIntervalMs?: number;
  /**
   * When `true`, each outgoing message filename also encodes a UTC timestamp
   * and a per-session sequence number, so filename-based logging can capture
   * when a file was written even in sync-mediated environments where the sync
   * tool stamps files with the transfer time rather than the original creation
   * time; default: `false`. With it unset, message filenames have only the
   * declared byte count (`<id>-<byteCount>.json`).
   */
  timestampInFilename?: boolean;
  /**
   * When `true`, the rendezvous handshake uses an ack-handshake barrier instead
   * of the atomic-exclusive-create lock-file race. Both parties must set this
   * identically: it is advertised in the hello payload, and a mismatch fails
   * fast at rendezvous with a usage error naming each side's setting, rather
   * than stalling until the peer timeout.
   *
   * Intended for sync-mediated transports (e.g. a cloud-sync service
   * reconciling two local directories) where `createExclusive` lacks atomicity
   * or deletion has high propagation latency; delete still works eventually via
   * `safeDelete`, but arrival order cannot be determined from an atomic
   * exclusive-create. Not for a transport that cannot delete at all: handshake
   * files must be removable at `close()` or they accumulate and block future
   * sessions. Default `false`.
   */
  locklessRendezvous?: boolean;
  /**
   * A stable, human-readable identifier for this party on the file-sync
   * transport. Appears in every filename this party writes (hello, message,
   * ack) and in server-side logs and transcripts. Requires
   * `timestampInFilename: true`: a reused stable id across sessions could
   * otherwise collide with a leftover file from a crashed prior session,
   * causing phantom message detection via `hasOutstandingMessage`. Unset
   * generates a UUID at construction time.
   *
   * The two parties must use distinct ids, and neither may be the other's id
   * extended by `-` (`"site"` and `"site-2"` are rejected:
   * `"site-2".startsWith("site-")` breaks prefix routing). Spaces and `-` are
   * otherwise permitted; `"temp"` is reserved. Filesystem-unsafe characters
   * (`/` and NUL everywhere; `<>:"\|?*` on Windows NTFS) are not validated but
   * may error at the transport layer.
   */
  peerId?: string;
  /**
   * When `true`, the receiver writes a zero-length acknowledgment marker after
   * consuming each message, and the sender gates its next `send()` on that
   * marker rather than on its own file's deletion. No exchange file is deleted
   * as a protocol step, so the shared directory becomes a permanent transcript.
   * Default `false`. Intended for sync-mediated transports that do not
   * propagate deletions, and for audit/transcript retention.
   *
   * Both parties must set this identically: advertised in the hello payload, a
   * mismatch fails fast at rendezvous with a usage error naming each side's
   * setting. Requires `timestampInFilename: true` (otherwise same-party
   * messages collide on filename and overwrite the transcript) and
   * `locklessRendezvous: true` (lock rendezvous is delete-based and cannot
   * produce a no-delete transcript).
   *
   * A fresh directory is required per exchange: `synchronize()` throws a
   * `UsageError` if a message or ack-marker file from a prior session is
   * present.
   */
  retainFiles?: boolean;
  /**
   * How to handle a file that appears in the shared directory *during* the
   * message loop and is neither part of this exchange nor a known transient (an
   * in-flight `temp-*.tmp` write). Directory exclusivity is a stated
   * precondition (EXCHANGE_REFERENCE.md, "Directory exclusivity"), so such a
   * file usually means another process or session is sharing the directory, or
   * a sync tool produced a conflict copy or partial download.
   *
   * - `error`: fail the exchange with a usage error (exit 64) naming the file
   *   and the directory path.
   * - `warn`: log the file once per distinct name and continue.
   * - `ignore`: skip silently.
   *
   * **Local, not bilateral.** Detecting a foreign file is a local observation
   * of one's own directory view; it needs no peer agreement and has none of
   * the mismatch-stall risk of `lockless_rendezvous`/`retain_files`. The two
   * parties may run different values.
   *
   * When unset, the default is mode-coupled: `error` on a plain delete-mode
   * transport (`sftp`/`filedrop`), `warn` when `retain_files` or
   * `lockless_rendezvous` is set (those flags signal a sync-mediated transport
   * that legitimately produces transient conflicts and partial downloads
   * mid-session). An explicit value overrides the default.
   *
   * Governs foreign-file detection only: a peer-prefixed file that is a
   * malformed *protocol* file (a message-shaped name a correctly configured
   * peer cannot produce) is always reported, regardless of this setting.
   */
  unexpectedFiles?: "error" | "warn" | "ignore";
  /**
   * When `true`, the SFTP transport opens a fresh SFTP session at the start of
   * each poll cycle and releases it before the loop goes idle again, instead of
   * holding one for the whole exchange. Use it when the partner's server caps
   * session lifetime and the exchange spans many idle poll gaps; pair it with a
   * long `poll_interval_ms`, since a full SSH handshake per cycle is wasteful
   * at a seconds-scale interval. Default `false`.
   *
   * **Local, not bilateral.** How one party dials changes nothing on the wire
   * or in the shared directory state machine: it is not advertised in the hello
   * and cannot trigger a mismatch. One party may cycle its session while the
   * other holds one.
   *
   * **SFTP-only.** Only the SFTP adapter holds a socket; the file-drop client
   * is already connectionless, so the flag has no effect there. A filedrop
   * config holding it is accepted but inert; the CLI warns it is ignored off
   * `sftp`.
   */
  connectionPerPoll?: boolean;
}

/**
 * Millisecond threshold below which a {@link FileSyncOptions.pollIntervalMs}
 * draws the anti-flood advisory. One second: below it a sub-second poll hammers
 * the shared directory with listings and can trip a server's anti-flood/DoS
 * protection and drop the connection.
 *
 * Advisory, never a bound: {@link FileSyncOptionsSchema} floors the field at 1,
 * not here, since a demo against a controlled server may legitimately poll at
 * ~100ms. Defined in core because both the CLI's `--polling-frequency` warning
 * and the console's authoring-time advisory must name the same threshold.
 */
export const LOW_POLLING_FREQUENCY_WARN_MS = 1000;

/**
 * Millisecond threshold below which pairing
 * {@link FileSyncOptions.connectionPerPoll} with the effective poll interval
 * draws the wasteful-dialing advisory. One minute: a full SSH handshake per
 * cycle is negligible at the minutes-scale interval the mode is meant for, but
 * wasteful at a seconds-scale one; the mode exists to survive a server
 * session-lifetime cap across long idle gaps, so it is only sane paired with a
 * long interval (docs/notes/connection-per-poll-sftp.md).
 *
 * Higher than {@link LOW_POLLING_FREQUENCY_WARN_MS}, which flags an
 * aggressively low poll for anti-flood reasons; this flags a poll merely too
 * short to justify per-cycle dialing. Advisory and shared for the same reasons.
 */
export const CONNECTION_PER_POLL_SHORT_INTERVAL_WARN_MS = 60_000;

const FileSyncOptionsSchema: z.ZodType<FileSyncOptions> = z
  .object({
    ...sharedOptionsFields,
    // positive, NOT nonnegative: 0 is a setTimeout(0) hot poll that busy-loops
    // directory listings (a self-inflicted flood), never a meaningful "no delay".
    pollIntervalMs: z.int().positive().optional(),
    timestampInFilename: z.boolean().optional(),
    locklessRendezvous: z.boolean().optional(),
    peerId: z.string().min(1).optional(),
    retainFiles: z.boolean().optional(),
    unexpectedFiles: z.enum(["error", "warn", "ignore"]).optional(),
    connectionPerPoll: z.boolean().optional(),
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
   * from the shared secret, so both parties reach each other with no
   * out-of-band address exchange. A peer-addressing concern, not a PSI
   * sender/receiver role, hence its home here rather than the top-level
   * `authentication` block. The CLI transport reads it: the two parties must
   * disagree, since each registers under the id the other dials.
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
  /**
   * Absolute path to the shared directory (Unix or Windows) used in shared
   * mode. Mutually exclusive with the {@link inboundPath}/{@link outboundPath}
   * pair; exactly one of the two forms must be given.
   */
  path?: string;
  /**
   * Absolute path to the inbound (peer-written) directory for a split-directory
   * exchange: this party reads the peer's files here and writes its own to
   * {@link outboundPath}. Set together with `outboundPath`; mutually exclusive
   * with `path`, and requires retain mode.
   */
  inboundPath?: string;
  /**
   * Absolute path to the outbound (self-written) directory for a
   * split-directory exchange; the companion to {@link inboundPath}. Must differ
   * from it.
   */
  outboundPath?: string;
  options?: FileSyncOptions;
  // No providerOptions: LocalFSClient has no underlying transport library to
  // pass opaque options to, unlike SSH2SFTPClientAdapter.
}

/** Connection configuration for an exchange. Discriminated by `channel`. */
export type ConnectionConfig =
  WebRTCConnectionConfig | SFTPConnectionConfig | FileDropConnectionConfig;

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

// An absolute filedrop directory path: Unix/UNC-forward-slash, a Windows drive
// letter (C:\ or C:/), or a Windows UNC (\\server\share). Shared by the single
// `path` and both halves of the split inbound/outbound pair so all three follow
// the identical absolute-path rule.
const filedropPathSchema = z
  .string()
  .min(1)
  .refine(
    (p) =>
      p.startsWith("/") || // Unix or UNC with forward slashes
      /^[A-Za-z]:[/\\]/.test(p) ||
      p.startsWith("\\\\"),
    { message: "path must be an absolute path" },
  );

const FileDropConnectionConfigSchema = z.object({
  channel: z.literal("filedrop"),
  path: filedropPathSchema.optional(),
  inboundPath: filedropPathSchema.optional(),
  outboundPath: filedropPathSchema.optional(),
  options: FileSyncOptionsSchema.optional(),
});

/**
 * Extracts the directory-mode fields for the file-based channels: the single
 * shared directory (`path` for filedrop, `server.path` for sftp) versus the
 * split `inboundPath`/`outboundPath` pair, plus whether retain mode is set.
 * Returns `undefined` for webrtc, which the path-mode refines below skip.
 * Shared so filedrop (top-level path) and sftp (path under `server`) are
 * validated by one set of rules.
 */
function fileSyncPathMode(conn: ConnectionConfig):
  | {
      path?: string;
      inboundPath?: string;
      outboundPath?: string;
      retain: boolean;
    }
  | undefined {
  if (conn.channel === "filedrop")
    return {
      path: conn.path,
      inboundPath: conn.inboundPath,
      outboundPath: conn.outboundPath,
      retain: conn.options?.retainFiles === true,
    };
  if (conn.channel === "sftp")
    return {
      path: conn.server.path,
      inboundPath: conn.server.inboundPath,
      outboundPath: conn.server.outboundPath,
      retain: conn.options?.retainFiles === true,
    };
  return undefined;
}

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
  // File-sync directory mode (filedrop and sftp). A directory is given either
  // as a single shared path or as a split inbound/outbound pair, never both and
  // never just one half; a configured outbound directory (split mode) requires
  // retain mode; and the two directories must differ. These are validated once
  // here, against fileSyncPathMode(), so both channels obey the same rules.
  .refine(
    (conn) => {
      const m = fileSyncPathMode(conn);
      if (m === undefined) return true;
      const hasPair =
        m.inboundPath !== undefined || m.outboundPath !== undefined;
      return !(m.path !== undefined && hasPair);
    },
    {
      message:
        "set either a single shared directory (path / server.path) or the " +
        "inbound_path/outbound_path pair, not both",
    },
  )
  .refine(
    (conn) => {
      const m = fileSyncPathMode(conn);
      if (m === undefined) return true;
      return (m.inboundPath !== undefined) === (m.outboundPath !== undefined);
    },
    {
      message:
        "inbound_path and outbound_path must be set together; a split " +
        "directory needs both halves",
    },
  )
  .refine(
    (conn) => {
      const m = fileSyncPathMode(conn);
      if (
        m === undefined ||
        m.inboundPath === undefined ||
        m.outboundPath === undefined
      )
        return true;
      // Reject not only byte-identical paths but any pair that resolves to the
      // same directory (redundant slashes, "." segments, trailing slash), using
      // the very rule each channel's open() applies -- so the schema and the
      // live connection agree on what counts as a distinct outbound directory.
      return !pathsResolveToSameDir(m.inboundPath, m.outboundPath);
    },
    { message: "inbound_path and outbound_path must differ" },
  )
  .refine(
    (conn) => {
      const m = fileSyncPathMode(conn);
      if (m === undefined) return true;
      const split = m.inboundPath !== undefined && m.outboundPath !== undefined;
      return !split || m.retain;
    },
    {
      message:
        "a separate outbound directory (inbound_path/outbound_path) requires " +
        "retain_files: true",
    },
  )
  // filedrop must name a directory in one form or the other; sftp may leave all
  // three unset (the SFTP login-home shared directory).
  .refine(
    (conn) => {
      if (conn.channel !== "filedrop") return true;
      const split =
        conn.inboundPath !== undefined && conn.outboundPath !== undefined;
      return conn.path !== undefined || split;
    },
    {
      message:
        "filedrop requires a directory: set path, or both inbound_path and " +
        "outbound_path",
    },
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

/**
 * Non-throwing version of {@link parseConnectionConfig}. Honors the "safe"
 * contract for the {@link camelizeKeys} bounds too -- see
 * {@link safeParseCamelized}.
 */
export function safeParseConnectionConfig(raw: unknown) {
  return safeParseCamelized(ConnectionConfigSchema, raw);
}

/**
 * Parse and validate a raw value as {@link FileSyncOptions}, without throwing.
 * Snake_case keys are converted to camelCase before validation; already-
 * camelCase objects (e.g. from {@link applyConnectionOverrides}) are accepted
 * unchanged. Honors the "safe" contract for the {@link camelizeKeys} bounds too
 * -- see {@link safeParseCamelized}.
 */
export function safeParseFileSyncOptions(raw: unknown) {
  return safeParseCamelized(FileSyncOptionsSchema, raw);
}

/**
 * Resolves retain mode's implications on a {@link FileSyncOptions} block:
 * `retainFiles: true` turns on `locklessRendezvous` and `timestampInFilename`
 * when the caller left either unset, so stating retain alone is enough. An
 * explicit `false` is left untouched, so the contradiction reaches
 * {@link FileSyncOptionsSchema}'s refines rather than being silently corrected;
 * callers still validate the result.
 *
 * The single home for the implication: the CLI's `--retain-files` and the
 * console's authoring surface both call it rather than restating the rule, so
 * the trio a composed config holds does not depend on which surface wrote it.
 * Returns the argument unchanged when retain mode is off or both implications
 * are already stated.
 */
export function withRetainModeImplications<T extends FileSyncOptions>(
  options: T,
): T {
  if (options.retainFiles !== true) return options;
  if (
    options.locklessRendezvous !== undefined &&
    options.timestampInFilename !== undefined
  )
    return options;
  return {
    ...options,
    ...(options.locklessRendezvous === undefined
      ? { locklessRendezvous: true }
      : {}),
    ...(options.timestampInFilename === undefined
      ? { timestampInFilename: true }
      : {}),
  };
}
