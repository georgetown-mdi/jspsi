import { z } from "zod";
import {
  LinkageTermsSchema,
  MAX_NAME_LENGTH,
  MAX_PARAMS_ENTRIES,
  MAX_PAYLOAD_ENTRIES,
} from "./linkageTerms.js";
import type { LinkageTerms } from "./linkageTerms.js";
import { camelizeKeys } from "../utils/camelizeKeys.js";
import { SHARED_SECRET_REGEX } from "./connection.js";
import { sanitizeForDisplay } from "../utils/sanitizeForDisplay.js";
import { pathsResolveToSameDir } from "../utils/pathCompare.js";
import { parseBoundedJson } from "../utils/boundedJson.js";
import { fromBase64Url } from "../utils/crypto.js";
import { boundedArray } from "../utils/boundedArray.js";

// --- Connection endpoint -----------------------------------------------------

/**
 * A WebRTC signaling locator: where the acceptor reaches the PeerJS
 * peer-coordination server. Carries no PeerJS API key or other secret.
 */
export interface WebRTCEndpoint {
  channel: "webrtc";
  /** Non-empty hostname. The schema enforces the constraint the type cannot. */
  host: string;
  /** Reachable port, 1-65535 (integer). Enforced by the schema, not the type. */
  port?: number;
  /** URL path for WebRTC signaling; non-empty when present. */
  path?: string;
}

/** An SFTP locator: the host (and optional port and remote path) to reach. */
export interface SFTPEndpoint {
  channel: "sftp";
  /** Non-empty hostname. The schema enforces the constraint the type cannot. */
  host: string;
  /** Reachable port, 1-65535 (integer). Enforced by the schema, not the type. */
  port?: number;
  /** Remote working directory (shared mode); non-empty when present. */
  path?: string;
  /**
   * Inbound (peer-written) remote directory for a split-directory exchange, as
   * the INVITER sees it. The acceptor mirror-swaps the pair -- the inviter's
   * outbound becomes the acceptor's inbound and vice versa -- so the two parties
   * start as mirror images (the swap lives at the single consumer
   * `connectionFromEndpoint` in apps/cli). Carried as a pair with
   * {@link outboundPath}: both halves present or neither, and mutually exclusive
   * with {@link path}.
   */
  inboundPath?: string;
  /**
   * Outbound (self-written) remote directory for a split-directory exchange; the
   * companion to {@link inboundPath}.
   */
  outboundPath?: string;
}

/** A file-drop locator: the shared directory both parties rendezvous in. */
export interface FileDropEndpoint {
  channel: "filedrop";
  /**
   * Path to the shared directory; the inviter's own path, which the acceptor
   * may need to remap to its local mount. Mutually exclusive with the
   * {@link inboundPath}/{@link outboundPath} split pair; exactly one form is
   * present.
   */
  path?: string;
  /**
   * Inbound (peer-written) directory for a split-directory exchange, as the
   * INVITER sees it; the acceptor mirror-swaps the pair (see
   * {@link SFTPEndpoint.inboundPath}). Carried as a pair with
   * {@link outboundPath}; mutually exclusive with {@link path}.
   */
  inboundPath?: string;
  /**
   * Outbound (self-written) directory for a split-directory exchange; the
   * companion to {@link inboundPath}.
   */
  outboundPath?: string;
}

/**
 * A credential-free connection locator an invitation MAY carry so the acceptor
 * can reach the rendezvous point without separate out-of-band setup.
 * Discriminated by `channel`, mirroring `ConnectionConfig` in `connection.ts`.
 *
 * INVARIANT: an endpoint carries only a public locator (signaling URL, SFTP
 * host/port, file-drop path, or a split inbound/outbound directory pair) and
 * MUST NEVER carry credentials -- no password, private key, key file, or PeerJS
 * API key. The per-channel shapes have no
 * field for any of these, and {@link ConnectionEndpointSchema} rejects any
 * field outside the locator allowlist, so a credential cannot ride along. A
 * public locator is not a secret, so including it does not weaken the
 * invitation; see docs/SECURITY_DESIGN.md.
 */
export type ConnectionEndpoint =
  WebRTCEndpoint | SFTPEndpoint | FileDropEndpoint;

// Custom error for the strict-object guard below: any field outside a channel's
// locator allowlist is rejected rather than silently stripped. The message
// leads with the allowlist (so a benign extra field like `username` is not
// mischaracterized as an attempted credential) and names the kind of field the
// rule excludes as the reason it is strict, rather than emitting Zod's generic
// "Unrecognized key". The named fields are illustrative, not exhaustive: the
// binding rule is the allowlist (anything that is not one of a channel's locator
// fields -- channel/host/port/path, plus the inbound_path/outbound_path pair for
// sftp/filedrop -- is rejected), so the examples here and in the docs are
// representative and need not enumerate every connection field a future schema
// might add.
const endpointKeyError: z.core.$ZodErrorMap = (issue) => {
  if (issue.code === "unrecognized_keys") {
    // The rejected key names are partner-controlled (the inviter crafts the
    // token), and this message is surfaced to the accepting operator (the CLI
    // terminal or the web accept screen) via the shared describeDecodeError,
    // which relays the issue message as is. Escape each name so a key like
    // "\x1b[31m..." cannot inject terminal control/ANSI sequences or deceptive
    // Unicode.
    return (
      "a connection endpoint may carry only a credential-free locator (channel " +
      "plus host/port/path, or an inbound_path/outbound_path pair for a split " +
      "file-sync directory); every other field is rejected so that no " +
      "credential or server-identity material (such as a password, private " +
      "key, or host-key fingerprint) can ride along. Remove unexpected " +
      "field(s): " +
      issue.keys.map((k) => sanitizeForDisplay(k)).join(", ")
    );
  }
  // Returning undefined delegates to Zod's default error map (the documented
  // signal), so structural failures -- a missing required field, a type
  // mismatch, an unknown channel -- keep their default messages; only the
  // unrecognized-key case is customized here.
  return undefined;
};

/**
 * Generous upper bound on a connection endpoint `host`. The host is
 * partner-controlled (the inviter crafts the token), and for a WebRTC endpoint
 * it is where the acceptor's own browser aims its PeerJS signaling WebSocket, so
 * an unbounded value is a (low-severity) SSRF-shaped nuisance. A DNS FQDN is at
 * most 253 characters and an IPv6 literal far shorter; 256 admits every real
 * hostname or IP an inviter would legitimately emit while refusing a padded one.
 *
 * Length-only by design: a strict hostname/IP regex risks rejecting a legitimate
 * but unusual locator (an IPv6 literal, an internal name, a punycode IDN), and
 * the finding asks only for a length/format bound as cheap hardening. Applied to
 * both the WebRTC and SFTP endpoint hosts -- the finding named the WebRTC host
 * (the browser-SSRF vector), but the SFTP host is the identical
 * partner-controlled locator field, so neither is left unbounded.
 */
export const MAX_ENDPOINT_HOST_LENGTH = 256;

/**
 * Generous upper bound on a connection endpoint `path` -- the WebRTC signaling
 * URL path, the SFTP remote working directory, or the file-drop directory, all
 * partner-controlled. Anchored to POSIX `PATH_MAX` (4096): a filesystem path
 * cannot exceed it and a signaling URL path is far shorter, so 4096 admits any
 * real locator path while still refusing a padded one. Defense-in-depth beside
 * {@link MAX_ENDPOINT_HOST_LENGTH}, backed by {@link MAX_ENCODED_INVITATION_LENGTH}.
 */
export const MAX_ENDPOINT_PATH_LENGTH = 4096;

// Intentionally no z.ZodType<T> annotation on these members: z.discriminatedUnion
// requires a concrete ZodObject, and the annotation would widen them to
// ZodType<T> and break the union (same rationale as connection.ts). Strict
// objects enforce the locator allowlist, so any credential field is rejected;
// type safety is enforced at the ConnectionEndpointSchema level instead.
/**
 * The credential-free WebRTC signaling-locator schema: `channel`/`host`/`port`/
 * `path` only, `z.strictObject` so any field outside that allowlist -- a PeerJS
 * `key`, a `server.username`, a `turn` entry -- is rejected rather than
 * stripped. Exported (unlike its sftp/filedrop siblings) as the single locator
 * source of truth the exchange-file mint layer composes a webrtc connection
 * block from, so the invitation endpoint and the composed connection agree on
 * the credential-free shape by construction rather than by two parallel
 * definitions. See {@link WebRTCEndpoint} for the aligned interface and
 * `connectionFromLocator` in exchangeFile.ts for the consumer.
 */
export const WebRTCEndpointSchema = z.strictObject(
  {
    channel: z.literal("webrtc"),
    host: z.string().min(1).max(MAX_ENDPOINT_HOST_LENGTH),
    // A reachable rendezvous port is 1-65535. Port 0 means "let the OS assign
    // an ephemeral port" and can never be an address an acceptor connects to,
    // so the endpoint is deliberately stricter here than connection.ts (which
    // allows 0): an invitation locator must name a port a peer can reach.
    port: z.int().min(1).max(65535).optional(),
    // Non-empty when present: an empty path is a meaningless locator (a blank
    // signaling path), so omit the field rather than send "".
    path: z.string().min(1).max(MAX_ENDPOINT_PATH_LENGTH).optional(),
  },
  { error: endpointKeyError },
);

const SFTPEndpointSchema = z.strictObject(
  {
    channel: z.literal("sftp"),
    host: z.string().min(1).max(MAX_ENDPOINT_HOST_LENGTH),
    // >= 1: a locator must name a reachable port; see the WebRTCEndpointSchema
    // port note (0 is an OS-assigned ephemeral port, never a connect target).
    port: z.int().min(1).max(65535).optional(),
    // Non-empty when present: an empty remote working directory is meaningless;
    // omit the field instead of sending "".
    path: z.string().min(1).max(MAX_ENDPOINT_PATH_LENGTH).optional(),
    // The split-directory pair (the inviter's own inbound/outbound directories),
    // mirror-swapped by the acceptor. Non-empty like `path`; the directory-mode
    // refines on ConnectionEndpointSchema enforce both-or-neither, mutual
    // exclusion with `path`, and that the two differ. Only the absolute-path rule
    // stays deferred to connection.ts on the acceptor's final config -- it is a
    // per-party property (the acceptor remaps the inviter's paths), so the
    // inviter's absoluteness is not meaningful to the acceptor, exactly as the
    // single-`path` form defers it.
    inboundPath: z.string().min(1).max(MAX_ENDPOINT_PATH_LENGTH).optional(),
    outboundPath: z.string().min(1).max(MAX_ENDPOINT_PATH_LENGTH).optional(),
    // No `username` (or other identity/auth field) by design: those are not
    // part of a public locator. Like credentials, the acceptor configures the
    // SSH identity in the credential portion of its own connection block, so an
    // identity field is intentionally outside the locator allowlist and the
    // strict object rejects it.
  },
  { error: endpointKeyError },
);

// `path` (and each half of the split pair) is validated only as non-empty here,
// NOT as absolute the way FileDropConnectionConfigSchema in connection.ts is.
// Deliberate: a file-drop endpoint carries the inviter's own mount path, which
// the acceptor remaps to its local mount before use, so the inviter's path being
// absolute is not meaningful to the acceptor. The acceptor's final connection
// config is re-validated by connection.ts (which enforces absolute), so a bad
// absolute path is caught where it matters; duplicating that per-party rule here
// would be meaningless once the acceptor remaps the path. The endpoint's security
// invariant is "no credentials", not "absolute path". (Distinctness of the split
// halves, unlike absoluteness, survives the swap, so it IS enforced here by the
// directory-mode refines.) `path` is optional; the directory-mode refines
// require exactly one form (single path or the split pair).
const FileDropEndpointSchema = z.strictObject(
  {
    channel: z.literal("filedrop"),
    path: z.string().min(1).max(MAX_ENDPOINT_PATH_LENGTH).optional(),
    inboundPath: z.string().min(1).max(MAX_ENDPOINT_PATH_LENGTH).optional(),
    outboundPath: z.string().min(1).max(MAX_ENDPOINT_PATH_LENGTH).optional(),
  },
  { error: endpointKeyError },
);

/**
 * Directory-mode fields for the file-sync endpoint channels (sftp/filedrop): the
 * single shared `path` versus the split `inboundPath`/`outboundPath` pair.
 * Returns undefined for webrtc (no directory), which the directory-mode refines
 * skip. Mirrors `fileSyncPathMode` in connection.ts so an endpoint and a
 * connection config validate the directory form by the same shape.
 */
function endpointDirMode(
  endpoint: ConnectionEndpoint,
): { path?: string; inboundPath?: string; outboundPath?: string } | undefined {
  if (endpoint.channel === "sftp" || endpoint.channel === "filedrop")
    return {
      path: endpoint.path,
      inboundPath: endpoint.inboundPath,
      outboundPath: endpoint.outboundPath,
    };
  return undefined;
}

/**
 * Whether an endpoint's SHAPE puts every connection built from it in retain mode:
 * true for a file-sync endpoint carrying the split inbound/outbound directory
 * pair, false for a single shared directory, a webrtc endpoint, or no endpoint
 * at all.
 *
 * A split directory cannot be configured without retain mode --
 * `ConnectionConfigSchema` (connection.ts) refuses the pair unless `retain_files`
 * is true, so the acceptor's own accept path seeds the retain trio onto the
 * connection it builds from such an endpoint. The derivation is from the shape,
 * not from {@link InvitationToken.inviterRetainsFiles}: an acceptor reaching a
 * split rendezvous runs in retain mode whether or not the token declared it,
 * which is why the consent summary states the retention on this predicate as well
 * as on the declaration. Both the seeding and the display read this one function,
 * so what an acceptor is put into and what it is shown cannot drift apart.
 */
export function endpointRequiresRetainedFiles(
  endpoint: ConnectionEndpoint | undefined,
): boolean {
  if (endpoint === undefined) return false;
  // The pair is given whole or not at all (the refine below), so the inbound half
  // decides for a decoded endpoint; endpointDirMode returns undefined for webrtc,
  // which has no directory to split.
  return endpointDirMode(endpoint)?.inboundPath !== undefined;
}

const ConnectionEndpointSchema: z.ZodType<ConnectionEndpoint> = z
  .discriminatedUnion("channel", [
    WebRTCEndpointSchema,
    SFTPEndpointSchema,
    FileDropEndpointSchema,
  ])
  // The split inbound/outbound pair is given whole or not at all: a lone half
  // cannot be mirror-swapped into a usable pair. Mirrors the same rule in
  // connection.ts so the endpoint and the connection config agree on the form.
  .refine(
    (endpoint) => {
      const m = endpointDirMode(endpoint);
      if (m === undefined) return true;
      return (m.inboundPath !== undefined) === (m.outboundPath !== undefined);
    },
    {
      message:
        "inbound_path and outbound_path must be set together; a split " +
        "directory endpoint needs both halves",
    },
  )
  // The two halves must differ. Unlike absoluteness (a per-party property the
  // acceptor remaps, left to connection.ts), distinctness survives the mirror
  // swap -- equal inviter halves yield equal acceptor halves -- so enforcing it
  // here fails a malformed split at decode rather than later at the acceptor's
  // exchange load. Same rule and function (pathsResolveToSameDir) connection.ts
  // applies to the final config, so the endpoint and the connection agree.
  .refine(
    (endpoint) => {
      const m = endpointDirMode(endpoint);
      if (
        m === undefined ||
        m.inboundPath === undefined ||
        m.outboundPath === undefined
      )
        return true;
      return !pathsResolveToSameDir(m.inboundPath, m.outboundPath);
    },
    {
      message:
        "inbound_path and outbound_path on a connection endpoint must differ",
    },
  )
  // A directory is named in one form or the other, never both.
  .refine(
    (endpoint) => {
      const m = endpointDirMode(endpoint);
      if (m === undefined) return true;
      const hasPair =
        m.inboundPath !== undefined || m.outboundPath !== undefined;
      return !(m.path !== undefined && hasPair);
    },
    {
      message:
        "set either a single path or the inbound_path/outbound_path pair on a " +
        "connection endpoint, not both",
    },
  )
  // filedrop must name a directory in one form or the other; sftp may leave all
  // three unset (the SFTP login-home shared directory), as in connection.ts.
  .refine(
    (endpoint) => {
      if (endpoint.channel !== "filedrop") return true;
      const hasPair =
        endpoint.inboundPath !== undefined &&
        endpoint.outboundPath !== undefined;
      return endpoint.path !== undefined || hasPair;
    },
    {
      message:
        "a filedrop endpoint requires a directory: set path, or both " +
        "inbound_path and outbound_path",
    },
  );

// --- Token -------------------------------------------------------------------

/**
 * The invitation token passed from inviter to acceptor out-of-band.
 * Carries linkage terms and a short-lived shared-secret credential, and MAY carry a
 * credential-free connection endpoint (see {@link ConnectionEndpoint}) so the
 * acceptor can reach the rendezvous point without separate out-of-band setup.
 *
 * The endpoint is a public locator only: the token MUST NEVER carry connection
 * credentials (password, private key, key file, PeerJS API key). Each party
 * still configures the credential portion of its own `connection` block
 * independently. Because the token carries the established shared secret -- and,
 * for the web flow, the rendezvous derived from it -- the encoded invitation is
 * confidential and must be forwarded only over a trusted out-of-band channel;
 * see docs/SECURITY_DESIGN.md.
 */
export interface InvitationToken {
  /**
   * Token format version. Increment only on an *incompatible* format change --
   * one an existing decoder could not read correctly. Adding an optional field
   * at THIS top level is backward compatible (an older decoder validates with a
   * non-strict `z.object` and simply ignores the field), so it does not bump the
   * version.
   *
   * The per-channel endpoint sub-schemas are `z.strictObject`, so an older
   * decoder REJECTS (it does not ignore) any field added to one of them: an
   * endpoint-shape addition is in principle an incompatible change. The
   * split-directory `inbound_path`/`outbound_path` pair was nonetheless added to
   * the sftp and filedrop endpoint shapes WITHOUT bumping the version -- a
   * deliberate one-time decision taken while psilink is pre-release with no
   * decoder deployed in the field. With no released consumer, no decoder can
   * observe the incompatibility, so a bump would only churn the version for no
   * reader. A strict-endpoint addition made AFTER a release ships must bump the
   * version (or otherwise stage compat). See docs/spec/FILE_SYNC.md.
   */
  version: "1";
  linkageTerms: LinkageTerms;
  /**
   * Short-lived setup secret, rotated to a persistent shared secret on first
   * successful exchange.
   */
  sharedSecret: string;
  /** ISO 8601 datetime after which this token is rejected at accept time. */
  expires?: string;
  /**
   * Optional credential-free connection locator (see
   * {@link ConnectionEndpoint}). Never carries credentials.
   */
  connectionEndpoint?: ConnectionEndpoint;
  /**
   * The inviter's disclosed-columns subset: exactly the column names the
   * acceptor will RECEIVE for matched records -- the set the inviter's
   * `disclosedColumnNames(metadata)` / `isDisclosedToPartner` predicate gathers
   * and `preparePayload` transmits. Carried so the acceptor's consent display
   * and its runtime lock-in derive from the wire's own transmission predicate
   * rather than from a separately-authored `terms.payload.send` dictionary each
   * mint path must remember to write; the displayed/consented set then cannot
   * diverge from the bytes that flow.
   *
   * The names are in the INVITER's column namespace and the acceptor reasons
   * about them as "what I will receive" -- NOT as its own `payload.send` (the
   * acceptor's `payload.send` is the inviter's `receive` mirrored into the
   * acceptor's namespace; see `deriveAcceptedLinkageTerms`). Only the
   * consent-relevant disclosed subset is carried -- linkage/identifier/ignored
   * columns that are not transmitted are not included and do not leave the
   * inviter's machine.
   *
   * Optional. Omitted ONLY on a mint path that does not know its metadata, and
   * then the acceptor reconciles lazily from the first transmission. When the
   * metadata IS known the subset is carried verbatim, INCLUDING the empty set when
   * nothing is disclosed -- an empty set is NOT the lazy case: it LOCKS IN "receive
   * nothing," so a later non-empty payload aborts. Whenever present (empty or not)
   * it locks in the acceptor's expectation: a received payload whose column set
   * differs aborts the exchange as a protocol error (the party promised one set and
   * delivered another). Only an OMITTED (undefined) field is lazy. See
   * {@link reconcileReceivedPayload}.
   */
  disclosedPayloadColumns?: string[];
  /**
   * The inviting party's declaration that its exchange runs in retain mode --
   * `connection.options.retain_files`, under which no exchange file is deleted as
   * a protocol step and the rendezvous location becomes a permanent transcript
   * (docs/spec/FILE_SYNC.md). Carried so an acceptor is told before it consents,
   * rather than by a failed run or by an accept kit the inviter may not send.
   *
   * A DECLARATION, never a setting. Nothing on the accept path reads it into a
   * connection: the accepting party still chooses its own half, and a
   * disagreement fast-fails at the hello (`BilateralModeMismatchError`) exactly
   * as it does for an invitation carrying no declaration at all. Disclosing a
   * bilateral flag is not negotiating one; see docs/spec/FILE_SYNC.md
   * ("Bilateral configuration: detect and fail, never negotiate").
   *
   * Absence is "nothing declared", not "delete mode": a mint path may have no
   * settled connection to read (an offline invite whose connection block is still
   * a placeholder scaffold), the channel may have no retain mode at all
   * (`webrtc`), or the token may predate this field. A `false` from a foreign
   * implementation decodes and states nothing, which is what both acceptance
   * surfaces render for it -- the `retainedFiles` entry of `consentFacts.ts`
   * carries why the negative is not a claim either.
   *
   * Two pairings {@link InvitationTokenSchema} refuses outright, at encode and at
   * decode alike, each stating a mode no run of the token could be in: a `true`
   * beside a `webrtc` endpoint, and a `false` beside a split-directory endpoint
   * whose shape ({@link endpointRequiresRetainedFiles}) contradicts it. A third
   * rule binds a MINT alone -- see {@link MintedInvitationTokenSchema}, which is
   * why "psilink emits the declaration wherever the endpoint's shape requires
   * retention" is a check rather than a claim made here.
   *
   * `lockless_rendezvous` is equally bilateral and equally fast-failing and is
   * deliberately NOT carried: nothing about it changes what an acceptor consents
   * to, and the token's declaration list is held to facts with consent weight.
   */
  inviterRetainsFiles?: boolean;
}

// The params width bound the decode fold carries, mirrored from linkageTerms.ts's
// PARAMS_WIDTH_BOUND (kept module-private there, so the bound and the schema below
// both stay off @psilink/core's wholesale public export). Both derive the value
// from the one shared MAX_PARAMS_ENTRIES constant, so they cannot drift: an
// over-MAX_PARAMS_ENTRIES params record is left verbatim by the camelize pre-pass
// and rejected by the schema's own count refine, not rewritten key by key.
const PARAMS_WIDTH_BOUND: ReadonlyMap<string, number> = new Map([
  ["params", MAX_PARAMS_ENTRIES],
]);

/**
 * {@link LinkageTermsSchema} preceded by the shared {@link camelizeKeys} pre-pass
 * (carrying the {@link MAX_PARAMS_ENTRIES} params width bound), so a decoded token's
 * value is folded to the canonical camelCase key form BEFORE it is validated --
 * exactly as `parseLinkageTerms` does for the config-load and post-handshake wire
 * paths. This is the decode chokepoint for the casing asymmetry: the bare schema
 * leaves `transform.params` keys verbatim (`z.unknown()` content with no key-form
 * constraint), so without this a token's params would stay snake_case while the
 * same agreement loaded from config or received off the wire is camelCase --
 * desyncing the canonical comparison, the agreed-terms hash (`computeTermsHash`),
 * and the standardization runtime (which reads `params.inputFormat`). Folding here
 * makes "a decoded token's `transform.params` is camelCase" a structural invariant.
 *
 * The pre-pass runs BEFORE validation, and that ordering is load-bearing: the
 * per-step length screens (`parse_date` / `pad_left` refines on `TransformStep`,
 * and the raw-pattern length cap) and the dialect-conformance gate on
 * {@link LinkageTermsSchema} read their inputs at the camelCase param names
 * (`inputFormat`, `length`, `pattern`). A snake_case-params token validated first
 * and folded after would evade the screen keyed on a multi-word name (an
 * `input_format` slipping the format-length cap), then activate the unscreened
 * value once camelized downstream -- a DoS bound bypass. Folding first runs every
 * screen on the normalized form. The
 * pre-pass is bounded: it throws NestingDepthExceededError / NodeCountExceededError
 * (UsageError subclasses, fixed input-free messages) on a pathologically deep or
 * wide `params`; the throw propagates from {@link InvitationTokenSchema}'s `.parse`
 * for {@link decodeInvitation} / {@link encodeInvitation} to surface as a clean
 * bounded rejection.
 *
 * The accepted-token SET widens only as the config path's already does: a
 * snake_case STRUCTURAL key (e.g. `linkage_fields`) now folds and validates rather
 * than being rejected, matching how a hand-authored config is read. Only the
 * linkage-terms field is wrapped, so the token's other fields and the strict
 * connection-endpoint credential allowlist are unaffected.
 *
 * Module-private by design: a `z.preprocess` that throws does not honor the
 * non-throwing contract a `.safeParse()` implies (Zod does not trap a preprocessor
 * throw), so keeping this schema off `@psilink/core`'s public export means no
 * external caller can reach a schema whose `.safeParse()` would surprise them with
 * a throw. Its only consumer is {@link InvitationTokenSchema}, which uses `.parse()`;
 * code needing a non-throwing linkage-terms parse uses `safeParseLinkageTerms`.
 */
const InvitationLinkageTermsSchema: z.ZodType<LinkageTerms> = z.preprocess(
  (raw) => camelizeKeys(raw, PARAMS_WIDTH_BOUND),
  LinkageTermsSchema,
);

const InvitationTokenBodySchema = z.object({
  version: z.literal("1"),
  // InvitationLinkageTermsSchema, not the bare LinkageTermsSchema: it camelizes
  // transform.params keys (and runs the length and dialect screens on the
  // normalized form) before validating, the one place the invitation path would
  // otherwise leave params verbatim. See its doc for why the fold must precede
  // validation.
  linkageTerms: InvitationLinkageTermsSchema,
  sharedSecret: z
    .string()
    .regex(
      SHARED_SECRET_REGEX,
      "invitation sharedSecret must be a base64url-encoded 32-byte value " +
        "(43 base64url characters; final character must be in " +
        "[AEIMQUYcgkosw048])",
    ),
  expires: z.iso.datetime().optional(),
  connectionEndpoint: ConnectionEndpointSchema.optional(),
  // The inviter's disclosed-columns subset (see the interface field). Each name
  // is bounded to the same MAX_NAME_LENGTH ceiling and the count to the same
  // MAX_PAYLOAD_ENTRIES cap a `payload.send`/`receive` list carries, since this
  // is the same disclosed set those would name; the whole token is already
  // structurally bounded by parseBoundedJson at decode, so boundedArray here is
  // defense-in-depth on the field. Names are partner-controlled (the inviter
  // crafts the token) and are routed through sanitizeForDisplay wherever they
  // reach a consent surface or a diagnostic. The `.min(1)` floor rejects an empty
  // name, matching the metadata/payload name floors -- an honest inviter derives
  // these from metadata whose names are already non-empty. There is deliberately
  // no array-level minimum: an empty array is MEANINGFUL -- it is the strict
  // "receive nothing" lock-in carried when an inviter that knows its metadata
  // discloses no payload column, which reconcileReceivedPayload enforces (a later
  // non-empty payload aborts) -- so it must not be rejected at decode. Only an
  // OMITTED field reconciles lazily.
  disclosedPayloadColumns: boundedArray(
    z.string().min(1).max(MAX_NAME_LENGTH),
    MAX_PAYLOAD_ENTRIES,
    `disclosedPayloadColumns must not exceed ${MAX_PAYLOAD_ENTRIES} entries`,
  ).optional(),
  // The inviter's retain-mode declaration (see the interface field). A plain
  // optional boolean at the top level, so an older decoder's non-strict z.object
  // ignores it rather than rejecting the token -- the backward-compatible shape
  // the `version` policy above describes, the same one disclosedPayloadColumns
  // took. No default is applied: absence must stay distinguishable from a
  // declared value, since it means "nothing declared" rather than "delete mode".
  inviterRetainsFiles: z.boolean().optional(),
});

const InvitationTokenSchema: z.ZodType<InvitationToken> =
  InvitationTokenBodySchema
    // A retain declaration on a webrtc endpoint is refused rather than displayed:
    // `retain_files` is a file-sync option that the webrtc channel does not have
    // (ConnectionConfigSchema in connection.ts rejects it on that channel for the
    // same reason), so a token pairing the two states a mode no run of it could
    // be in. Refusing at the schema means a mint path cannot stamp the pair by
    // mistake and a decoder cannot surface one for consent. A token with no
    // endpoint at all is unconstrained: the offline file-sync invite carries the
    // declaration with no locator beside it.
    .refine(
      (token) =>
        token.connectionEndpoint?.channel !== "webrtc" ||
        token.inviterRetainsFiles !== true,
      {
        message:
          "inviterRetainsFiles is not valid for a webrtc connection endpoint; " +
          "retain mode is a file-sync setting the webrtc channel does not have",
        path: ["inviterRetainsFiles"],
      },
    )
    // The mirror refusal on the file-sync side. A split inbound/outbound endpoint
    // requires retain mode of every connection built from it -- read through
    // `endpointRequiresRetainedFiles`, the same predicate the accept path's own
    // seeding reads -- so a token pairing that endpoint with an explicit `false`
    // states a mode no run of it could be in, exactly as a `true` on webrtc does.
    // Refusing here keeps a mint path from stamping the pair and a decoder from
    // surfacing one, rather than leaving the consent summary's OR to render the
    // safe side over a declaration the shape contradicts. Scoped to the explicit
    // negative: an omitted field on the same endpoint is "nothing declared", the
    // case the summary's second ground exists to cover, so it stays valid.
    .refine(
      (token) =>
        !endpointRequiresRetainedFiles(token.connectionEndpoint) ||
        token.inviterRetainsFiles !== false,
      {
        message:
          "inviterRetainsFiles cannot be false for a connection endpoint " +
          "carrying the inbound_path/outbound_path pair; a split directory " +
          "requires retain mode of every connection built from it",
        path: ["inviterRetainsFiles"],
      },
    );

/**
 * {@link InvitationTokenSchema} plus the one rule that binds a MINT and not a
 * decode: a token carrying a split `inboundPath`/`outboundPath` endpoint must
 * declare `inviterRetainsFiles: true`.
 *
 * Every connection built from that endpoint runs in retain mode
 * ({@link endpointRequiresRetainedFiles}), so an invitation emitting one while
 * leaving the retention undeclared offers the partner a permanent transcript that
 * only the locator's shape reveals -- and any artifact composed from the
 * declaration rather than from the shape (an accept kit's file-handling
 * disclosure among them) then states nothing. This is the executable form of that
 * invariant, at the single seam every mint path reaches, so no producer has to
 * restate it as a gate of its own.
 *
 * Mint-only, and deliberately NOT a tightening of
 * {@link InvitationTokenSchema}: an omitted declaration beside a split endpoint
 * remains a valid token to DECODE, because absence means "nothing declared" and
 * every psilink read path derives the retention from the endpoint's shape rather
 * than from the declaration (`summarizeInvitation` ORs
 * {@link endpointRequiresRetainedFiles} into its retained-files disclosure, and
 * the accept paths seed the retain trio from the same predicate). Refusing it at
 * decode would reject, on a public protocol surface, a foreign token psilink
 * already handles and displays correctly.
 */
const MintedInvitationTokenSchema: z.ZodType<InvitationToken> =
  InvitationTokenSchema.refine(
    (token) =>
      !endpointRequiresRetainedFiles(token.connectionEndpoint) ||
      token.inviterRetainsFiles === true,
    {
      message:
        "inviterRetainsFiles must be true on an invitation carrying a " +
        "connection endpoint with the inbound_path/outbound_path pair; a " +
        "split directory puts every connection built from it in retain mode, " +
        "so the invitation must declare the retention it hands the acceptor",
      path: ["inviterRetainsFiles"],
    },
  );

// --- Lifetime policy ---------------------------------------------------------

/**
 * Default invitation lifetime in seconds: one hour. An invitation minted with no
 * explicit lifetime takes this bound, per the "default expiration window of 1
 * hour" in docs/SECURITY_DESIGN.md. Both inviters -- the CLI's `psilink invite`
 * and the web app -- reference this one value so their defaults cannot drift.
 */
export const INVITATION_LIFETIME_SECONDS = 60 * 60;

/**
 * Hard upper bound on an invitation lifetime in seconds: one year. The setup
 * secret an invitation carries is short-lived by design, so a lifetime override
 * is capped here -- a deliberately generous ceiling (recurring exchanges may run
 * only monthly, and an invitation may need to outlast operational breakage before
 * a re-invite), but a hard one, so an erroneous override cannot make the secret
 * effectively permanent and defeat the bounded-lifetime property. See
 * docs/SECURITY_DESIGN.md. Both inviters reference this one value; each rejects an
 * over-ceiling lifetime up front, with a surface-specific error, before minting.
 * This is a bound on the chosen lifetime at the call site, not a check inside
 * {@link encodeInvitation} (which validates only that `expires` is in the future).
 */
export const MAX_INVITATION_LIFETIME_SECONDS = 365 * 24 * 60 * 60;

// --- Base64url helpers -------------------------------------------------------

function toBase64Url(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// --- Encode / Decode ---------------------------------------------------------

// 4 bytes always encodes to exactly 6 unpadded base64url characters (3 bytes ->
// 4 chars, 1 byte -> 2 chars)
const CHECKSUM_CHARS = 6;

/**
 * Generous upper bound on the length of an encoded invitation string accepted by
 * {@link decodeInvitation}, enforced at the decode boundary BEFORE the string is
 * base64-decoded, hashed, JSON-parsed, or schema-validated. The 4-byte checksum
 * detects transcription errors only -- anyone can recompute it over a crafted
 * payload (see {@link decodeInvitation}) -- so it is no barrier to an oversized
 * token; this cap is. A maximal real invitation (full linkage terms, an
 * endpoint, an expiry) encodes to a few KiB, and the web flow's URL-length limit
 * caps it besides; 64 KiB is an order of magnitude above any legitimate token
 * yet refuses the multi-megabyte payload a checksum-valid token could otherwise
 * carry. This is the boundary that transitively bounds every untrusted field at
 * decode, so no per-field check has to do oversized-input work; the per-field
 * `.max()` bounds in linkageTerms.ts are defense-in-depth atop it.
 * {@link encodeInvitation} enforces the same cap on its output, so psilink never
 * produces a token it could not itself decode.
 */
export const MAX_ENCODED_INVITATION_LENGTH = 64 * 1024;

/**
 * Bound on a RAW pasted invitation string, checked by
 * {@link stripInvitationWhitespace} before it does any stripping work. A
 * hard-wrapped token adds well under 5% whitespace, so double
 * {@link MAX_ENCODED_INVITATION_LENGTH} stays generous while keeping the strip
 * itself bounded work rather than unbounded work ahead of the decode boundary.
 */
export const MAX_RAW_INVITATION_LENGTH = 2 * MAX_ENCODED_INVITATION_LENGTH;

/**
 * Serializes an {@link InvitationToken} as a base64url string with a
 * 4-byte truncated-SHA-256 checksum appended for transcription-error
 * detection. The checksum provides no security guarantee; the key exchange handles
 * authentication.
 *
 * This is the mint seam every psilink invitation is emitted through, so it
 * validates against {@link MintedInvitationTokenSchema} -- strictly stronger than
 * the schema {@link decodeInvitation} parses, by the split-endpoint retain
 * declaration it requires. Producing a token psilink would not itself emit is
 * refused here rather than at each caller's own gate.
 *
 * Uses `btoa`/`atob` and `globalThis.crypto.subtle.digest`
 * (Node.js 19+ / all modern browsers).
 *
 * @throws {Error} if `expires` is set to a time that is not in the future, or if
 *   the encoded token exceeds {@link MAX_ENCODED_INVITATION_LENGTH} (a token that
 *   could not be decoded; fires only on a programming error, not a real config).
 * @throws {ZodError} if the token fails {@link MintedInvitationTokenSchema}.
 * @throws {NestingDepthExceededError|NodeCountExceededError} if the token's
 *   `transform.params` is too deeply nested or too wide for the bounded camelCase
 *   pre-pass `InvitationLinkageTermsSchema` runs while validating (the same
 *   schema {@link decodeInvitation} parses through). Reachable only via a
 *   type-bypassed `token`, since a well-typed {@link InvitationToken} carries an
 *   already-structured `params`; both are `UsageError` subclasses.
 */
export async function encodeInvitation(
  token: InvitationToken,
): Promise<string> {
  // Serialize the PARSE RESULT, not the original token. The top-level schema is
  // non-strict (decode must stay forward-compatible: an older decoder ignores a
  // newer token's added field, per the `version` policy), which means a caller
  // who bypasses the types -- e.g. `x as unknown as InvitationToken` -- could
  // otherwise carry an extra top-level field into the invitation verbatim. Zod
  // strips unknown keys on parse, so serializing `validated` makes "only the
  // schema's fields are encoded" a structural guarantee rather than one that
  // rests on TypeScript. (Endpoint sub-schemas are strict, so a credential on
  // the endpoint is already rejected, not merely stripped.)
  const validated = MintedInvitationTokenSchema.parse(token);
  if (
    validated.expires !== undefined &&
    new Date(validated.expires) <= new Date()
  ) {
    throw new Error("invitation expires must be in the future");
  }
  const bytes = new TextEncoder().encode(JSON.stringify(validated));
  const body = toBase64Url(bytes);
  const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const checksum = toBase64Url(new Uint8Array(hashBuf).slice(0, 4));
  const encoded = body + checksum;
  // Symmetric with decodeInvitation's boundary cap: fields all within their
  // per-field bounds can still, in aggregate, encode past
  // MAX_ENCODED_INVITATION_LENGTH, and the far end would then reject the token at
  // its decode boundary. Refuse to produce it here so the failure surfaces on the
  // inviter's own side with a clear cause rather than at the partner's decode. In
  // practice this fires only on a programming error, never a real config.
  if (encoded.length > MAX_ENCODED_INVITATION_LENGTH) {
    throw new Error(
      "encoded invitation exceeds the maximum length of " +
        `${MAX_ENCODED_INVITATION_LENGTH} characters`,
    );
  }
  return encoded;
}

/**
 * Removes every character in the ECMAScript `\s` class (the `WhiteSpace` and
 * `LineTerminator` code points `String.prototype.trim` strips at the edges,
 * including the non-ASCII ones such as U+00A0 and U+2028) from a pasted
 * invitation string, at every position -- interior as well as leading and
 * trailing.
 *
 * The normalization the web lobby's paste-to-navigate helper and the CLI
 * accept seam each apply before {@link decodeInvitation}, which holds a strict
 * base64url alphabet; the web's hash-fragment decode path does not apply it
 * and decodes unstripped. A token pasted out of a
 * hard-wrapped email or chat message carries line breaks and indentation the
 * wrapping introduced, not anything the inviter encoded, and would otherwise
 * be refused for them. Stripping the full `\s` class rather than only the
 * ASCII subset keeps this one implementation in agreement with the seams that
 * call `String.prototype.trim` ahead of it (the web paste and the CLI
 * `@`-file reference both do), so a token carrying trim-set whitespace decodes
 * the same way through every delivery, CLI argv included.
 *
 * When `input.length` exceeds {@link MAX_RAW_INVITATION_LENGTH}, `input` is
 * returned unchanged -- no strip work runs -- so the caller's own decode
 * boundary ({@link decodeInvitation}'s {@link MAX_ENCODED_INVITATION_LENGTH}
 * check) is what refuses an oversized paste, with its own precise message.
 * This function never throws.
 */
export function stripInvitationWhitespace(input: string): string {
  if (input.length > MAX_RAW_INVITATION_LENGTH) {
    return input;
  }
  return input.replace(/\s+/g, "");
}

/**
 * Decodes an invitation string produced by {@link encodeInvitation}, verifying
 * the checksum and validating the payload against the {@link InvitationToken}
 * schema.
 *
 * Uses `btoa`/`atob` and `globalThis.crypto.subtle.digest`
 * (Node.js 19+ / all modern browsers).
 *
 * Does not check whether the token has expired; callers are responsible
 * for comparing `token.expires` against the current time (see
 * {@link isInvitationExpired}).
 *
 * @throws {Error} if the string exceeds {@link MAX_ENCODED_INVITATION_LENGTH}
 *   (checked at the boundary before any other work), is too short to carry a
 *   checksum, fails the checksum, or is invalid base64url.
 * @throws {ZodError} on schema validation failure.
 * @throws {NestingDepthExceededError|NodeCountExceededError} if the token's
 *   `transform.params` is too deeply nested or too wide for the bounded camelCase
 *   pre-pass `InvitationLinkageTermsSchema` runs before validating; both are
 *   `UsageError` subclasses a caller surfaces as a clean bounded rejection.
 */
export async function decodeInvitation(
  encoded: string,
): Promise<InvitationToken> {
  // Refuse an oversized payload at the boundary, before any base64-decode, hash,
  // or schema work. The checksum gates none of this (it is a transcription-error
  // detector with no security guarantee), so this cap is the only thing that
  // stops a checksum-valid multi-megabyte token; see MAX_ENCODED_INVITATION_LENGTH.
  if (encoded.length > MAX_ENCODED_INVITATION_LENGTH) {
    throw new Error(
      "invitation string exceeds the maximum length of " +
        `${MAX_ENCODED_INVITATION_LENGTH} characters`,
    );
  }
  if (encoded.length <= CHECKSUM_CHARS) {
    throw new Error("invitation string is too short");
  }
  const body = encoded.slice(0, -CHECKSUM_CHARS);
  const receivedChecksum = encoded.slice(-CHECKSUM_CHARS);

  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64Url(body);
  } catch {
    // The fixed string rather than the primitive's own message, the same
    // swallow the JSON parse below applies: nothing derived from a
    // partner-supplied body reaches an operator-facing display through this
    // rejection.
    throw new Error("invitation string is not valid base64url");
  }
  const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const expectedChecksum = toBase64Url(new Uint8Array(hashBuf).slice(0, 4));

  if (receivedChecksum !== expectedChecksum) {
    throw new Error("invitation checksum mismatch");
  }

  let raw: unknown;
  try {
    // The chokepoint structurally bounds the token before JSON.parse (a wide
    // object / long array would otherwise crash the parser uncatchably) and
    // fatal-decodes the UTF-8; a structural or decode/parse failure surfaces
    // here as the same fixed-text rejection.
    raw = parseBoundedJson(bytes);
  } catch {
    throw new Error("invitation payload is not valid JSON");
  }
  // InvitationTokenSchema normalizes transform.params key casing to camelCase as
  // it validates (via InvitationLinkageTermsSchema), so a decoded token's params
  // match the form every other parse path produces -- the decode chokepoint for
  // the casing asymmetry. See InvitationLinkageTermsSchema for why.
  return InvitationTokenSchema.parse(raw);
}

/**
 * The verdict {@link hasExpiryInstantPassed} returns for an `expires` it cannot
 * parse: `"fail-closed"` treats the value as already passed, `"fail-open"` as
 * not passed. The safe direction belongs to what the bound governs, not to the
 * comparison, so a caller states one explicitly.
 */
export type UnparseableExpiryVerdict = "fail-closed" | "fail-open";

/**
 * Whether the ISO 8601 instant `expires` has passed as of `now`: `true` when
 * `expires` is present and at or before `now`; `false` when it is absent (no
 * bound in force) or is a valid instant still in the future. The comparison is
 * at-or-before, so a bound equal to `now` has already passed -- it is never
 * valid for one last instant.
 *
 * The shared comparison behind the invitation acceptors and the web app's
 * managed-exchange surfaces: a caller decides whether an `expires` bound has run
 * out through this rather than parsing the instant itself, so two surfaces
 * cannot drift apart on the boundary or on a malformed value.
 *
 * `onUnparseable` has no default. `new Date(...)` yields `NaN` for a value it
 * cannot parse and a bare `<=` against `NaN` is `false`, so an unparseable bound
 * reads as not-passed unless a caller decides otherwise; requiring the verdict
 * puts that decision at the call site, where what the bound governs is visible.
 */
export function hasExpiryInstantPassed(
  expires: string | undefined,
  now: Date,
  { onUnparseable }: { onUnparseable: UnparseableExpiryVerdict },
): boolean {
  if (expires === undefined) return false;
  const expiresMs = new Date(expires).getTime();
  if (Number.isNaN(expiresMs)) return onUnparseable === "fail-closed";
  return expiresMs <= now.getTime();
}

/**
 * Whether an invitation must be rejected on expiry grounds at `now`:
 * `true` when `expires` is present and at or before `now`, OR present but
 * unparseable; `false` when `expires` is absent (an unbounded token) or is a
 * valid instant still in the future.
 *
 * Fails closed on the boundary and on a malformed value: an `expires` equal to
 * `now` is already expired (never valid for one last instant), and an
 * unparseable `expires` is rejected rather than honored. The malformed case is
 * defense in depth: {@link decodeInvitation}'s schema already rejects a non-ISO
 * `expires`, so a token reaching here through decode never carries one -- but
 * every acceptor fails closed on its own, not only by relying on that upstream
 * gate. Shared by the CLI and web acceptors so both enforce identical semantics.
 */
export function isInvitationExpired(
  expires: string | undefined,
  now: Date = new Date(),
): boolean {
  return hasExpiryInstantPassed(expires, now, { onUnparseable: "fail-closed" });
}
