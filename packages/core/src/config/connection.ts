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
 * Regex matching a valid SSH host-key fingerprint in OpenSSH SHA256 format:
 * the `SHA256:` prefix followed by 43 unpadded standard base64 characters
 * (alphabet `[A-Za-z0-9+/]`, NOT base64url `[A-Za-z0-9_-]`). The final
 * character is constrained to the 16 values whose low 2 bits are zero
 * (32 bytes * 8 = 256 bits / 6 = 42 full characters + 4 remaining data bits;
 * the last character's two unused low bits must be zero in the canonical
 * encoding). A bare base64url value -- the shape of a signing
 * `partner_fingerprint` -- is detected separately to name the confusion.
 */
export const HOST_KEY_FINGERPRINT_REGEX =
  /^SHA256:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$/;

/**
 * SFTP host for an SFTP exchange. At most one primary authentication method
 * (`password` or `privateKey`) may be specified. `privateKeyPassphrase` is a
 * companion to `privateKey` and is invalid without it.
 */
export interface SFTPServer {
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
   * Answer the server's `keyboard-interactive` authentication prompts with the
   * configured `password`, in addition to offering the direct `password`
   * method. Only valid with `password`; a `boolean` defaulting to `false`.
   *
   * Enable this for a server that disables the SSH `password` authentication
   * method but accepts `keyboard-interactive` -- the same password, collected
   * over a different SSH auth method (the server sends a prompt the client
   * answers, rather than the client offering the password directly). Every
   * prompt the server sends is answered with the same configured password, so it
   * does not satisfy a multi-prompt or one-time-code challenge; those cannot be
   * answered from a single stored secret. See docs/EXCHANGE_REFERENCE.md
   * (connection.server).
   */
  keyboardInteractive?: boolean;
  /**
   * Expected server host-key fingerprint(s) in OpenSSH SHA256 format
   * (`SHA256:<43 standard base64 chars>`): a single fingerprint, or a non-empty
   * list of them. When set, every SFTP connection on the CLI `sftp` channel
   * verifies the server presents a host key matching ANY listed fingerprint
   * before authentication; a key matching none aborts the connection. A list
   * gives zero-downtime host-key rotation -- stage the incoming key alongside
   * the current one during the rekey window so either is accepted with no failed
   * exchange in between, then drop the old entry after the cutover. Each entry is
   * validated to canonical OpenSSH SHA256 form. @-file supported (per entry).
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
    // mistake to surface at parse, not a silent no-pin posture at connect time.
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
      // (password, privateKey) carry no format refine, so they pass parse the
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
    // Strip the detected-but-rejected fields so the output matches SFTPServer,
    // which no longer declares them. The refines above ensure neither reaches
    // here with a non-undefined value; the transform only runs on a valid parse.
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
 * (a sibling of `signing`); see exchangeSpec.ts and EXCHANGE_REFERENCE.md.
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
   * secrets use this format; they differ only in the {@link expires} that
   * accompanies them (see that field for how its two sources are treated).
   */
  sharedSecret?: string;
  /**
   * Expiration for this token (ISO 8601 datetime), or absent for a persistent
   * token with no maximum age. The exchange is aborted before the key exchange
   * -- and again after it, catching a lapse during the round-trip -- if the
   * current time is past this value. This one field is written by two sources,
   * an invitation's bounded lifetime (default 1 hour) and a
   * {@link tokenMaxAgeDays} stamp on a rotated token, which core deliberately
   * does not distinguish: expiry means the same thing, and recovers the same
   * way (re-invite), for both. See docs/SECURITY_DESIGN.md ("Two sources, one
   * `expires`").
   */
  expires?: string;
  /**
   * Operator-policy: maximum age, in days, to stamp onto a rotated token. When
   * set, a successful exchange records `expires` = (rotation time) +
   * `tokenMaxAgeDays` days into `.psilink.key`, so a dormant partnership cannot
   * hold a valid token indefinitely between exchanges; when omitted, rotated
   * tokens carry no expiry (the default). Unlike `sharedSecret`/`expires` this
   * is operator-authored in `psilink.yaml`, not key-file-injected. A positive
   * integer, bounded above by {@link MAX_TOKEN_MAX_AGE_DAYS}; the expiry stamp is
   * computed at rotation time (in the CLI), not at config-parse time.
   */
  tokenMaxAgeDays?: number;
}

/**
 * Upper bound on {@link Authentication.tokenMaxAgeDays} (~100 years). Not a
 * policy statement -- any realistic max-age is far smaller (the sibling
 * invitation lifetime is capped at 1 year) -- but a sanity ceiling: it keeps the
 * rotation-time stamp `now + tokenMaxAgeDays` days within the representable
 * `Date` range (and a 4-digit ISO year), so a value large enough to overflow that
 * range cannot reach the rotation write path and throw there, after a handshake
 * the partner has already completed, with no clear cause.
 */
export const MAX_TOKEN_MAX_AGE_DAYS = 36500;

/**
 * Schema for the top-level `authentication` block, exported so
 * {@link ExchangeSpecSchema} can embed it as a sibling of `signing`. Field-shape
 * validation only; the injected fields (`sharedSecret`/`expires`) come from
 * `.psilink.key` and are warn-and-stripped if set in YAML (see the CLI loader).
 *
 * `strictObject` (unlike the sibling spec blocks, which strip): a misspelled
 * operator-policy key here is rejected at parse time rather than silently
 * dropped. `tokenMaxAgeDays` is a security control, and a typo that strip would
 * discard would silently disable max-age enforcement with no signal; failing
 * closed forces the operator to fix the key before any exchange runs. The
 * injected fields are removed by the loader's warn-and-strip before this schema
 * sees them, so strictness never rejects a key-file value. See EXCHANGE_REFERENCE.md
 * ("Authentication").
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
   * 3600000. Must be a positive integer: it is the per-await peer-inactivity
   * liveness budget, so a zero value would fire every transport await
   * immediately and disable the liveness control. The effective limit is the
   * minimum of this and the remaining shared-secret lifetime.
   */
  peerTimeoutMs?: number;
  /**
   * Milliseconds to wait per connection attempt to the primary exchange server;
   * default: 30000. Must be a positive integer: a zero is not a meaningful
   * "no timeout" sentinel here -- on `filedrop` it makes the local-FS connect
   * probe time out immediately against a healthy mount, and on `sftp` it
   * disables ssh2's connect-establishment timeout entirely (it arms only when
   * positive). For channels that retry (e.g. `sftp` and `filedrop`), this limit
   * applies to each attempt individually, not to the total across all attempts.
   * Retry delays between attempts are not counted against this budget.
   *
   * Stays optional despite the schema applying {@link DEFAULT_SERVER_CONNECT_TIMEOUT_MS}
   * as a `.default()`: this type is both the caller-supplied input shape (where
   * the field may be omitted) and the parsed output, and an entirely omitted
   * `options` block leaves it `undefined` regardless of the field default. The
   * `z.ZodType<SharedOptions>` annotation therefore does not narrow it to a
   * required `number`; consumers treat it as possibly-unset and apply the same
   * constant at the connect sites (see fileSyncConnection).
   */
  serverConnectTimeoutMs?: number;
  /** Maximum reconnect attempts before giving up; default: 3. */
  maxReconnectAttempts?: number;
}

/**
 * Default per-attempt connect timeout (30000 ms) applied to
 * {@link SharedOptions.serverConnectTimeoutMs} when the operator leaves it
 * unset. Applied at the schema boundary (so the parsed config carries the value
 * uniformly across channels) and reused as the fallback at the SFTP and filedrop
 * connect sites for a config built without an `options` block at all, so the
 * documented 30000 ms per-attempt deadline always holds rather than the `sftp`
 * path silently falling back to ssh2's shorter (~20s) internal `readyTimeout`.
 * See docs/EXCHANGE_REFERENCE.md and docs/spec/CHANNEL_SECURITY.md.
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
 * Upper bound on {@link SharedOptions.maxReconnectAttempts}: 604800 attempts.
 * Derived, not arbitrary -- it is the connect-retry phase's existing wall-clock
 * ceiling expressed as a count. The connect-retry loop (`retryPromise` at every
 * connect site) spaces attempts with a fixed 1-second inter-attempt delay --
 * `maxReconnectAttempts` delays across `maxReconnectAttempts + 1` attempts -- so
 * against an endpoint that refuses fast the attempts themselves are ~instant and
 * the wall clock is essentially the delay total, about `maxReconnectAttempts`
 * seconds. The largest count whose delay total stays within the CLI's 7-day
 * timeout ceiling (`MAX_TIMEOUT_SECONDS` = 604800 s, the sanity cap the duration
 * flags already enforce) is therefore `604800 s / 1 s = 604800`. Bounding the
 * count here bounds the fast-fail connect phase to that same ~7-day wall clock
 * the timeouts speak, instead of letting a fat-fingered value near
 * `Number.MAX_SAFE_INTEGER` become a linear self-inflicted hang against an
 * endpoint that refuses fast (ECONNREFUSED on sftp, EACCES/ENOENT on filedrop --
 * exactly the fast transients the retry budget exists to ride out).
 *
 * This bounds a proxy: it caps the count, which equals wall-clock only at the
 * 1-second inter-attempt floor (the fast-fail case this footgun is about). It
 * does NOT tightly bound a slow-but-answering endpoint, whose attempts each run
 * up to `serverConnectTimeoutMs`; that case is already held per-attempt by
 * `serverConnectTimeoutMs` and is left to a wall-clock deadline should it ever
 * prove to matter. Defined in core (not the CLI, where `MAX_TIMEOUT_SECONDS`
 * lives) because both validation boundaries that must agree on this field consume
 * it -- the schema `.max()` below and the CLI's `nonNegativeIntFlag` parse guard,
 * which imports it -- and core cannot import from the CLI. An over-ceiling value
 * is rejected with a flag-named `UsageError` (exit 64) whether it arrives from
 * `psilink.yaml` or `--max-reconnect-attempts`. See docs/spec/CHANNEL_SECURITY.md.
 */
export const MAX_RECONNECT_ATTEMPTS = 7 * 24 * 60 * 60;

const sharedOptionsFields = {
  // positive, not nonnegative: peerTimeoutMs is the per-await liveness budget,
  // so a zero would fire every transport await immediately and disable the
  // liveness control (the CLI's --peer-timeout already rejects zero; this closes
  // the same hole on the config/programmatic path).
  peerTimeoutMs: z.int().positive().optional(),
  // positive for the same reason: a zero serverConnectTimeoutMs is not a
  // meaningful "no timeout" -- it times out the filedrop local-FS connect probe
  // immediately and disables ssh2's connect readyTimeout (armed only when > 0).
  // The CLI's --connection-timeout already rejects zero. Defaulted (not just
  // optional) so an unset value resolves to DEFAULT_SERVER_CONNECT_TIMEOUT_MS at
  // the schema boundary -- the documented 30000 ms deadline -- carried uniformly
  // for sftp and filedrop instead of leaving the sftp path on ssh2's ~20s
  // default. The default fires only when the options object is present but the
  // field is absent; an entirely omitted options block is covered by the same
  // constant at the connect sites in fileSyncConnection.
  serverConnectTimeoutMs: z
    .int()
    .positive()
    .default(DEFAULT_SERVER_CONNECT_TIMEOUT_MS),
  // nonnegative, NOT positive: zero is meaningful here -- "connect once, do not
  // reconnect" -- so it stays a valid value. Capped above by
  // MAX_RECONNECT_ATTEMPTS: the connect-retry loop paces at a fixed 1s floor, so
  // an unbounded count is a wall-clock self-DoS; the cap bounds it to the same
  // 7-day ceiling the timeout flags enforce (see MAX_RECONNECT_ATTEMPTS). The CLI
  // boundary (nonNegativeIntFlag) applies the same ceiling, so the parse guard
  // and this merged-options re-validation agree, as they do on the floor.
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
   * positive integer: `0` is not "as fast as possible" but a `setTimeout(0)` hot
   * poll that busy-loops directory listings against the server (a self-inflicted
   * flood), so the schema rejects it. When unset, the connection applies
   * `DEFAULT_POLLING_FREQUENCY_MS` (5000) -- a conservative default that stays
   * within SFTP servers' anti-flood limits; see that constant in
   * `fileSyncConnection.ts` for the rationale.
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
   * on these transports -- cleanup via `safeDelete` succeeds eventually --
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
   * is a stated precondition (see EXCHANGE_REFERENCE.md "Directory exclusivity"),
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
  /**
   * When `true`, the SFTP transport opens a fresh SFTP session at the start of
   * each poll cycle and releases it before the loop goes idle again, instead of
   * holding one session for the whole exchange. A session then needs only survive
   * one cycle's seconds, so it never reaches a server's maximum-session-duration
   * or idle cap. Use it when the partner's SFTP server caps session lifetime and
   * a single exchange spans many idle poll gaps (a slow, once-an-hour-reconciling
   * peer); pair it with a long `poll_interval_ms`, since a full SSH handshake per
   * cycle is wasteful at a seconds-scale interval. Default: `false`.
   *
   * **Local, not bilateral.** How one party dials changes nothing on the wire or
   * in the shared directory state machine, so the peer neither observes nor cares:
   * it is NOT advertised in the hello and cannot trigger a mismatch. One party may
   * cycle its session while the other holds one, with no rendezvous fast-fail. It
   * is in the family of the unilateral `unexpected_files` policy, not the bilateral
   * `retain_files`/`lockless_rendezvous` axes.
   *
   * **SFTP-only.** Only the SFTP adapter holds a socket; the file-drop client is
   * already connectionless, so the flag has no effect there. It stays a
   * FileSyncOptions field for schema uniformity; a filedrop config carrying it is
   * accepted but inert, and the CLI warns that it is ignored off `sftp`.
   */
  connectionPerPoll?: boolean;
}

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
      /^[A-Za-z]:[/\\]/.test(p) || // Windows drive letter (C:\ or C:/)
      p.startsWith("\\\\"), // Windows UNC (\\server\share)
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

/**
 * Non-throwing version of {@link parseFileSyncOptions}. Honors the "safe"
 * contract for the {@link camelizeKeys} bounds too -- see
 * {@link safeParseCamelized}.
 */
export function safeParseFileSyncOptions(raw: unknown) {
  return safeParseCamelized(FileSyncOptionsSchema, raw);
}
