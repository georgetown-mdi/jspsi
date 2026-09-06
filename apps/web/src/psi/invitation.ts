import {
  INVITATION_LIFETIME_SECONDS,
  MAX_INVITATION_LIFETIME_SECONDS,
  assertFanOutImplemented,
  assertPayloadSendDisclosed,
  assertStandardizationMatchesTerms,
  assessLinkageSatisfiability,
  decideLinkageTermsVerdict,
  disclosedColumnNames,
  encodeInvitation,
  endpointRequiresRetainedFiles,
  generateSharedSecret,
  getDefaultLinkageTerms,
  inferMetadata,
  overlongDisclosedColumnPositions,
  stripInvitationWhitespace,
} from "@psilink/core";

import { emptyColumnPositions } from "./columnNames";
import { linkageRefusalFor } from "./linkageRefusal";
import { loadCSVFileOffMainThread } from "./workers/csvParseController";
import { payloadSendForMetadata } from "./metadataEditing";
import { standardizationForTerms } from "./authoring/advancedInviteTerms";

import type {
  CSVRow,
  ConnectionEndpoint,
  FileDropEndpoint,
  InvitationToken,
  LinkageTerms,
  Metadata,
  SFTPEndpoint,
  Standardization,
  WebRTCEndpoint,
} from "@psilink/core";

import type { LinkageRefusal } from "./linkageRefusal";

/**
 * The CSV input {@link generateInvitation} parses: exactly what
 * {@link loadCSVFileOffMainThread} (and core's `loadCSVFile` beneath it) accepts (a
 * browser `File` in production; a Node readable stream in tests). Derived from that
 * wrapper's own signature rather than importing papaparse's `LocalFile` directly, so
 * this module takes on no papaparse dependency beyond the one core already owns. */
type InvitationCSVInput = Parameters<typeof loadCSVFileOffMainThread>[0];

/**
 * Path a PeerJS client dials this app's signaling server at. Matches the dial
 * path used in `psi/rendezvous.ts` (`path: "/api/"`), which the server -- mounted
 * at `/api` by `apps/web/src/peerServer.ts` -- accepts. The acceptor reads this
 * off the endpoint and dials it the same way a client does, so it must be the
 * client's dial path (trailing slash included), not the server's mount path.
 */
const PEERJS_SIGNALING_PATH = "/api/";

/**
 * Route the deep-link targets: the acceptor's accept/reject consent screen. The
 * route itself -- decode, linkage-terms review, and the derived-id rendezvous --
 * is built by the accept route; this module only
 * constructs a URL that points at it. The token rides in the URL fragment (see
 * {@link deepLinkFor}), so the contract this constant encodes is "path plus
 * fragment", which the accept route must read in lockstep.
 */
export const ACCEPT_ROUTE_PATH = "/accept";

/**
 * The browser-location inputs an invitation needs: the deep-link origin and the
 * host/port the acceptor reaches the PeerJS signaling server at. Passed in rather
 * than read from `window` inside assembly so {@link generateInvitation} stays
 * pure and unit-testable; the caller supplies `window.location` values.
 */
export interface InvitationLocation {
  /** Deep-link origin, e.g. `https://example.org:3000` (no trailing slash). */
  origin: string;
  /** Hostname for the signaling endpoint, as `window.location.hostname`. */
  hostname: string;
  /** Port as `window.location.port` gives it: a string, `""` for the protocol default. */
  port: string;
}

/**
 * The result of composing an invitation from the inviter's file: the shareable
 * artifacts the inviter sends out-of-band ({@link encoded} / {@link deepLink}),
 * the secret and expiry that drive the rendezvous, and the linkage terms
 * embedded in the token plus the exact parsed rows those terms were derived
 * from, since the inviter runs its own half of the exchange right after.
 *
 * {@link encoded} and {@link deepLink} hold the same token and so decode
 * identically; {@link linkageTerms}, {@link rawRows}, and {@link columns} are
 * local data the inviter reuses to run the exchange and are NEVER shared (only
 * the terms ride inside the encoded token).
 */
export interface GeneratedInvitation {
  /** The encoded invitation string -- the bare-string copy artifact. */
  encoded: string;
  /**
   * Deep-link URL `<origin>/accept#<encoded>` -- the URL copy artifact. The
   * token rides in the fragment, never a query parameter, so this confidential
   * value (it holds the setup secret and seeds the rendezvous id) is not sent
   * to the server and stays out of access logs and Referer headers; see
   * docs/SECURITY_DESIGN.md, "Invitation contents and confidentiality".
   */
  deepLink: string;
  /**
   * The fresh shared secret embedded in the token. Returned so the inviter can
   * derive its own rendezvous peer id and listen on it (the acceptor derives
   * the same id from the same secret held in the invitation). It is the value
   * already inside `encoded`, exposed here rather than re-decoded; it stays in
   * the browser and is never sent to a backend.
   */
  sharedSecret: string;
  /**
   * The token's bounded expiry (ISO 8601), exposed beside `sharedSecret` so the
   * inviter can thread it into the authenticated key exchange's expiry guards
   * (its `expires !== undefined` gate then arms the in-handshake check). It is
   * the value already inside `encoded`. Always set: {@link generateInvitation}
   * mints a bounded lifetime onto every invitation.
   */
  expires: string;
  /**
   * The linkage terms embedded in the token, derived from the inviter's file
   * (inferred metadata -> default terms filtered to the keys the columns can
   * satisfy). Returned so the inviter's own exchange reuses THIS object
   * verbatim rather than re-deriving from the file: the embedded terms and the
   * terms the inviter's exchange runs on must be one and the same, or the
   * terms-compatibility handshake with the partner fails. Local: present
   * inside `encoded` too, but exposed here so the exchange need not re-decode
   * it.
   */
  linkageTerms: LinkageTerms;
  /**
   * The parsed CSV rows {@link linkageTerms} was derived from, returned so the
   * inviter's exchange runs on the exact data with no re-parse and no second file
   * prompt. Local-only: the rows are never encoded into the token or shared.
   */
  rawRows: Array<CSVRow>;
  /** The CSV column names, paired with {@link rawRows} -- the two inputs the
   * inviter's exchange feeds to `prepareForExchange`. Local-only. */
  columns: Array<string>;
  /**
   * The inviter's edited per-party column metadata, from the console's Matching
   * & sharing section. Threaded into the inviter's own `prepareForExchange`
   * (never encoded in the token), so its disclosure choices govern what the
   * inviter sends and its column->type bindings match the run the authored
   * keys were derived from. Absent on the quick path, where metadata is
   * inferred from the columns downstream. Local-only.
   */
  metadata?: Metadata;
  /**
   * The inviter's authored per-party standardization, from the console's
   * Cleaning tab, RECONCILED to {@link linkageTerms}. Paired with
   * {@link metadata} and threaded into the inviter's own `prepareForExchange`
   * (never embedded in the token), so the cleaning -- including the per-field
   * input-column binding that lets two fields of one semantic type bind to
   * distinct columns -- matches the run the authored fields were derived
   * from. Absent on the quick path, where standardization is inferred
   * downstream. Local-only.
   *
   * Reconciled rather than held verbatim, since the draft keeps a disabled
   * key's cleaning so re-enabling restores it; a stored verbatim copy would be
   * refused as contradicting its terms when replayed. Every transform output
   * here names a field `linkageTerms` declares, checked at the mint.
   */
  standardization?: Standardization;
  /**
   * The disclosed-column subset the token holds -- the value already inside
   * `encoded`, exposed so a persisting caller (the managed-exchange deposit)
   * records the SAME send-side commitment the token published rather than
   * re-deriving one that could drift. Always set, including the EMPTY set (a
   * strict "sends nothing" commitment, not the absent/lazy case); see
   * docs/spec/FILE_SYNC.md, "Which mint paths persist disclosedPayloadColumns".
   */
  disclosedPayloadColumns: Array<string>;
}

/** Why {@link generateInvitation} refused to mint an invitation for the given
 * file. Every variant is user-actionable -- the inviter can choose another file, or
 * change which columns it sends -- and every one is thrown BEFORE any shared secret
 * is generated, so a rejected file never yields a token. Anything else
 * {@link generateInvitation} throws (a schema/encoding error, an SSR misuse) is an
 * internal fault, not one of these. */
export type InvitationFileFailure =
  | {
      /** The CSV could not be read or parsed. */
      kind: "unreadable";
      /** The underlying read/parse error, for the caller to show (sanitized)
       * and to log. */
      cause: unknown;
    }
  | {
      /** The file cannot satisfy every linkage key the minted terms declare, so
       * the exchange the token sets up would be refused at its own run boundary --
       * after the partner has accepted. The same rule every console pre-launch seat
       * and core's `assertLinkageTermsSatisfiable` hold the input to. */
      kind: "unlinkable";
      /** Why, in the shape the operator-facing alert is total over. */
      refusal: LinkageRefusal;
    }
  | {
      /** The CSV header holds one or more empty (zero-length) column names -- a
       * trailing comma, a blank cell, or a leading delimiter produces an unnamed
       * (`""`) column. Core's {@link inferMetadata} rejects it at intake, and the
       * payload schema's `name` `.min(1)` would otherwise reject it only as a raw
       * ZodError at encode (the generic retry dead-end); refused here EARLY so the
       * caller can show a clear, actionable error. */
      kind: "unnameable";
      /** The 1-based positions of the empty-named columns, for the operator-facing
       * message (see {@link unnameableColumnsAlert}). */
      positions: Array<number>;
    }
  | {
      /** A column marked to send has a name longer than `MAX_NAME_LENGTH`. The
       * name rides the payload frame to the partner, whose parse refuses it,
       * and `PayloadColumnSchema.name` would otherwise reject it here only as
       * a raw ZodError at encode (the generic retry dead-end); refused with a
       * typed failure so the caller can show a clear, actionable error. Scoped
       * to the disclosed set: an oversized name on a column that is not sent
       * goes nowhere and blocks nothing. */
      kind: "overlong";
      /** The 1-based positions of the offending columns, for the operator-facing
       * message (see {@link overlongColumnsAlert}). The offending NAME is never
       * included: it is longer than the message that would show it. */
      positions: Array<number>;
    };

/**
 * Thrown by {@link generateInvitation} when the inviter's file cannot back an
 * invitation, BEFORE the shared secret is minted. {@link failure} discriminates
 * the user-actionable cause so the caller can show the right guidance; the base
 * `message` is a fixed, non-sensitive summary suitable for a log line.
 */
export class InvitationFileError extends Error {
  readonly failure: InvitationFileFailure;
  constructor(failure: InvitationFileFailure) {
    super(
      failure.kind === "unreadable"
        ? "invitation file could not be read"
        : failure.kind === "unlinkable"
          ? "invitation file cannot satisfy the linkage terms"
          : failure.kind === "overlong"
            ? "invitation file sends an over-long column name"
            : "invitation file has an empty column name",
    );
    this.name = "InvitationFileError";
    this.failure = failure;
  }
}

/**
 * Build the credential-free WebRTC signaling locator the acceptor uses to
 * reach this app's PeerJS server, from the inviter's browser location.
 * Mirrors the acceptor's dial-location handling (`psi/rendezvous.ts`):
 * `localhost` is normalized to a loopback literal a peer can dial, and a
 * default-port location omits the port. The endpoint schema requires a
 * reachable 1-65535 port when present; a blank or out-of-range port is
 * dropped.
 */
export function webrtcEndpointFromLocation(loc: {
  hostname: string;
  port: string;
}): WebRTCEndpoint {
  const host = loc.hostname === "localhost" ? "127.0.0.1" : loc.hostname;
  const endpoint: WebRTCEndpoint = {
    channel: "webrtc",
    host,
    path: PEERJS_SIGNALING_PATH,
  };
  // Number() rather than parseInt: a non-numeric port like "8080abc" becomes NaN
  // and is dropped instead of being truncated to 8080, and an empty default-port
  // location becomes 0, which the `>= 1` guard rejects -- so the port is omitted.
  const port = Number(loc.port);
  if (Number.isInteger(port) && port >= 1 && port <= 65535)
    endpoint.port = port;
  return endpoint;
}

/** Build the deep-link URL with `encoded` in the fragment (see
 * {@link GeneratedInvitation.deepLink} for why the fragment, not a query). */
export function deepLinkFor(origin: string, encoded: string): string {
  return `${origin}${ACCEPT_ROUTE_PATH}#${encoded}`;
}

/**
 * Peel the encoded invitation token out of what the acceptor pasted -- the
 * inverse of {@link deepLinkFor}. A deep-link URL holds the token in its
 * fragment (`<origin>${ACCEPT_ROUTE_PATH}#<token>`), so everything after the
 * first `#` is the token; a bare code has no `#` and is used as-is.
 *
 * The extracted token is passed through `stripInvitationWhitespace`, which
 * strips line breaks only up to its raw-length bound; past that bound it hands
 * the input on unchanged, and `decodeInvitation` refuses it by length at
 * `/accept`.
 */
export function tokenFromInput(input: string): string {
  const trimmed = input.trim();
  const hash = trimmed.indexOf("#");
  const token = hash === -1 ? trimmed : trimmed.slice(hash + 1);
  return stripInvitationWhitespace(token);
}

/**
 * The connection-endpoint an invitation should hold. Defaults to the app's own
 * WebRTC signaling locator, built from {@link InvitationLocation}; a caller
 * composing a file-drop or SFTP exchange instead supplies an explicit
 * {@link SFTPEndpoint} or {@link FileDropEndpoint} holding only authored
 * locator fields.
 *
 * The channel-specific variants hold only locator fields by construction (the
 * endpoint types have no credential field), so the credential-free invariant
 * holds regardless of channel. `encodeInvitation` re-validates the whole token
 * through the strict endpoint schema, so a malformed locator or any smuggled
 * unknown key is rejected at mint -- this request is not a second, weaker
 * gate.
 */
export type ConnectionEndpointRequest =
  { channel: "webrtc" } | SFTPEndpoint | FileDropEndpoint;

/**
 * Resolve a {@link ConnectionEndpointRequest} to the {@link ConnectionEndpoint}
 * the token holds. The webrtc request is built from the inviter's browser
 * {@link InvitationLocation}; an sftp/filedrop request passes through verbatim
 * (its locator fields were authored by the caller). No credential can appear
 * in any branch -- the endpoint types admit none -- and `encodeInvitation`
 * validates the result through the strict endpoint schema regardless.
 */
function resolveConnectionEndpoint(
  request: ConnectionEndpointRequest,
  location: InvitationLocation,
): ConnectionEndpoint {
  if (request.channel === "webrtc") return webrtcEndpointFromLocation(location);
  return request;
}

/**
 * Generate a fresh single-use invitation from the inviter's CSV: a new shared
 * secret, the linkage terms derived from the file, and this app's PeerJS
 * endpoint, encoded to a string and also wrapped as a deep-link URL. Each call
 * mints a new secret, superseding any prior unsent invitation.
 *
 * This is the inviter's CSV-parse boundary. It embeds the derived terms in the
 * token AND returns them with the parsed rows: the inviter's own exchange must
 * run on this same returned `linkageTerms` object and `rawRows`/`columns`, so
 * the embedded terms the acceptor adopts and the terms the inviter runs on are
 * one and the same. `metadata` and `standardization` are per-party and local
 * -- never embedded in the token.
 *
 * Fails closed BEFORE minting the secret (see the @throws below): no token is
 * ever produced for an unreadable or unlinkable file.
 *
 * @throws {InvitationFileError} when the file is unreadable, unlinkable, contains an
 *                               unnamed column, or sends one whose name is too long
 *                               to hold (all before any secret is minted).
 * @throws {UsageError} (from core) when authored terms declare a `payload.send`
 *                      that does not match the edited metadata's disclosed set, so
 *                      the token and the partner's consent screen cannot misstate
 *                      what is sent. A mint-boundary safety check --
 *                      `prepareForExchange`'s identical check runs too late for the
 *                      consent surface.
 * @throws {UsageError} (from core) when the terms' element transforms or the
 *                      authored standardization declare a step that expands one
 *                      value into several match candidates, which the run refuses
 *                      -- likewise before any secret is minted.
 * @throws {StandardizationTermsError} (from core) when the authored
 *                      standardization, reconciled to the emitted terms, still
 *                      contradicts them -- an unknown step function, the class the
 *                      reconciliation does not cover. The check every persisting
 *                      caller inherits (see {@link GeneratedInvitation.standardization}).
 */
export async function generateInvitation(params: {
  inviterName: string;
  /** The inviter's CSV; parsed here (see the function summary -- this is the
   * parse boundary). The terms are derived from its columns. Exactly one of `file`
   * or `profiledColumns` is set. */
  file?: InvitationCSVInput;
  /**
   * The column names profiled server-side for a console server-job transport
   * -- the alternative to `file`. When supplied, the invitation binds to
   * THESE columns (with the authored terms / metadata / standardization)
   * WITHOUT re-parsing a File: on the console the file is never read in the
   * browser. The fail-closed satisfiability re-check stays columns-based.
   * The returned `rawRows` are empty on this path. Exactly one of `file` or
   * `profiledColumns` must be set.
   */
  profiledColumns?: Array<string>;
  location: InvitationLocation;
  /**
   * Invitation lifetime in seconds; defaults to
   * {@link INVITATION_LIFETIME_SECONDS} (one hour) and must be in the range
   * `(0, {@link MAX_INVITATION_LIFETIME_SECONDS}]` (up to one year). The quick
   * path omits it and takes the default; the inviter console passes the
   * inviter's chosen lifetime. The bounds are enforced here so this function
   * cannot mint an unbounded token.
   */
  lifetimeSeconds?: number;
  /**
   * Authored linkage terms to embed, from the AdvancedInvite model
   * (`buildAdvancedTerms`). When supplied they are embedded VERBATIM: the
   * model seeded them from this file's columns, validated them through
   * {@link safeParseLinkageTerms}, and confirmed at least one key is
   * satisfiable, so the default-terms derivation is skipped and
   * `inviterName` is not consulted (the authored terms hold their own
   * `identity`). The file is still parsed, for `rawRows`/`columns` and for a
   * fail-closed satisfiability re-check against these exact terms. Omitted
   * on the quick path, where the terms are derived from the file's columns.
   */
  linkageTerms?: LinkageTerms;
  /**
   * The inviter's edited column metadata from the console's Matching & sharing
   * section, paired
   * with `linkageTerms`. Returned on {@link GeneratedInvitation} and threaded into
   * the inviter's own exchange (never embedded in the token); the fail-closed
   * satisfiability re-check binds against it too, so the verdict matches the run.
   * Omitted on the quick path, where metadata is inferred downstream.
   */
  metadata?: Metadata;
  /**
   * The inviter's authored per-party standardization from the console's
   * Cleaning tab, paired with `metadata`/`linkageTerms`. Returned on
   * {@link GeneratedInvitation} -- reconciled to the emitted terms -- for the
   * inviter's own exchange, and threaded into the fail-closed satisfiability
   * re-check so the verdict matches the run that produces the authored
   * fields' keys. Never embedded in the token. Omitted on the quick path,
   * where standardization is inferred downstream.
   */
  standardization?: Standardization;
  /**
   * The connection endpoint the token holds. Defaults to
   * `{ channel: "webrtc" }`, which builds this app's PeerJS signaling locator
   * from `location`, so a caller that omits this mints a webrtc invitation. A
   * caller composing a file-drop or SFTP exchange supplies an explicit
   * sftp/filedrop endpoint holding only authored locator fields; the
   * credential-free invariant holds either way (see
   * {@link ConnectionEndpointRequest}).
   */
  connectionEndpoint?: ConnectionEndpointRequest;
  /**
   * Whether the exchange this invitation is for runs in retain mode -- the
   * inviter's own `retain_files`, under which nothing is deleted and the
   * rendezvous location becomes a permanent transcript. Held on the token as
   * `inviterRetainsFiles` so the partner's acceptance display states it
   * before they consent; a declaration only, applied by nothing on the
   * accept side.
   *
   * Passed only for a file-sync exchange whose options the caller has
   * resolved. Omitted (or false) declares nothing rather than declaring
   * delete mode; a webrtc mint (no retain mode) leaves it alone, and the
   * token schema refuses the pair outright.
   *
   * This flag ADDS to the resolved endpoint's own shape, which is the other
   * ground for the declaration: a split `inbound_path`/`outbound_path`
   * endpoint puts every connection built from it in retain mode
   * (`endpointRequiresRetainedFiles`), so the mint declares the retention
   * whether or not the caller passed the flag.
   */
  retainsFiles?: boolean;
}): Promise<GeneratedInvitation> {
  const {
    inviterName,
    file,
    profiledColumns,
    location,
    lifetimeSeconds = INVITATION_LIFETIME_SECONDS,
    connectionEndpoint = { channel: "webrtc" },
    retainsFiles = false,
  } = params;

  // Exactly one input source: a browser File to parse, or the console's
  // server-side profiled columns to bind directly. Neither and both are misuse.
  if ((file === undefined) === (profiledColumns === undefined))
    throw new Error(
      "generateInvitation requires exactly one of file or profiledColumns",
    );

  // Bound the selected lifetime up front, before encodeInvitation's "expires
  // must be in the future" check, which only catches a non-positive net
  // lifetime. Mirrors the CLI's two up-front rejections in validateInvite
  // (apps/cli/src/commands/invite.ts): a non-positive lifetime, and one past
  // the one-year ceiling -- the invariant that keeps this function from
  // minting an effectively-permanent token; see
  // MAX_INVITATION_LIFETIME_SECONDS.
  if (!Number.isFinite(lifetimeSeconds) || lifetimeSeconds <= 0)
    throw new Error(
      "invitation lifetimeSeconds must be a finite, positive number of seconds",
    );
  if (lifetimeSeconds > MAX_INVITATION_LIFETIME_SECONDS)
    throw new Error(
      "invitation lifetimeSeconds must not exceed " +
        `${MAX_INVITATION_LIFETIME_SECONDS} seconds (one year)`,
    );

  // Parse the inviter's CSV here, before anything is minted, so an unreadable
  // file aborts with no token. loadCSVFileOffMainThread rejects on a
  // read/stream error and on a row-level parse fault (an unterminated quote,
  // a row whose field count differs from the header); wrap either into the
  // typed user-actionable failure. On the console's profiled-columns path
  // there is no file to read: the columns are bound directly and no rows are
  // produced.
  let rawRows: Array<CSVRow>;
  let columns: Array<string>;
  if (file !== undefined) {
    try {
      const csvResult = await loadCSVFileOffMainThread(file);
      rawRows = csvResult.data;
      columns = csvResult.meta.fields ?? [];
    } catch (cause) {
      throw new InvitationFileError({ kind: "unreadable", cause });
    }
  } else {
    rawRows = [];
    columns = profiledColumns ?? [];
  }

  // Refuse an unnamed-column header before any inference or minting.
  // inferMetadata (the quick path) and the linkage grading below both reject
  // an empty name by throwing a raw UsageError, and the authored path would
  // put a `""` column into payload.send and bottom out in
  // PayloadColumnSchema's name `.min(1)` ZodError at encode -- both of which
  // the UI flattens into its generic retry dead-end. Show the typed,
  // user-actionable failure here instead.
  const emptyPositions = emptyColumnPositions(columns);
  if (emptyPositions.length > 0)
    throw new InvitationFileError({
      kind: "unnameable",
      positions: emptyPositions,
    });

  // The terms to embed. The AdvancedInvite model's authored terms are
  // embedded verbatim; the quick path derives them from the file's columns
  // (inferred metadata filters the default keys to those the columns can
  // satisfy, and authors a payload.send for the columns that metadata
  // discloses, below). standardization is left to CSV inference downstream
  // in both cases.
  //
  // disclosedPayloadColumns is the disclosed set the token holds. Always
  // set, including the EMPTY set when nothing is disclosed -- an empty set
  // is a constraint (it locks the acceptor in to "receive nothing"), not the
  // absent/lazy case.
  let disclosedPayloadColumns: Array<string>;
  let linkageTerms: LinkageTerms;
  // The metadata whose marks decide what is disclosed, kept beside the derived set
  // so the mint-boundary bound below reads the same columns the send does.
  let disclosureMetadata: Metadata;
  if (params.linkageTerms !== undefined) {
    linkageTerms = params.linkageTerms;
    // The mint boundary stays fail-closed even though the editor already
    // gates on satisfiability: a set holding a key the columns cannot
    // produce, or one whose cleaning drops every record, mints a token whose
    // own exchange the run boundary refuses -- after the partner has
    // accepted it. Grade the AUTHORED terms (not the full defaults) with the
    // authored standardization and metadata, the same three inputs the
    // inviter's own run is graded on.
    const verdict = decideLinkageTermsVerdict(
      columns,
      linkageTerms,
      params.standardization,
      params.metadata,
    );
    const refusal = linkageRefusalFor(verdict, verdict.unsatisfiedFields);
    if (refusal !== undefined)
      throw new InvitationFileError({ kind: "unlinkable", refusal });
    // Reject a payload.send that does not match the disclosed set before the
    // token is minted, so the partner's consent screen never misstates what
    // is sent. The AdvancedInvite model derives payload.send from the
    // disclosed columns, so this is a defense-in-depth safety check (against
    // a regression or a non-editor caller): the exchange-time check in
    // prepareForExchange runs too late for the consent surface. The quick
    // path (else) authors its own payload from the inferred metadata and
    // runs the same check there.
    if (params.metadata !== undefined)
      assertPayloadSendDisclosed(
        linkageTerms.payload,
        params.metadata,
        linkageTerms.output,
      );
    disclosureMetadata = params.metadata ?? inferMetadata(columns);
    disclosedPayloadColumns = disclosedColumnNames(disclosureMetadata);
  } else {
    const metadata = inferMetadata(columns);
    disclosureMetadata = metadata;
    linkageTerms = getDefaultLinkageTerms(inviterName, metadata);

    // Block a file the minted terms cannot be run against, the same rule the
    // inviter's own run boundary applies. Grade the EMBEDDED terms rather than
    // the full default set: the derivation narrows the built-in keys to the
    // ones the columns support, and narrowing all the way to no key is a
    // refusal in its own right (a column-less file reaches it the other way,
    // since getDefaultLinkageTerms falls back to ALL keys on empty metadata,
    // none of them producible). The missing field types the alert names come
    // from the FULL default terms, since the narrowed set no longer declares
    // the fields it dropped.
    const refusal = linkageRefusalFor(
      decideLinkageTermsVerdict(columns, linkageTerms, undefined, metadata),
      assessLinkageSatisfiability(columns, getDefaultLinkageTerms(inviterName))
        .unsatisfied,
    );
    if (refusal !== undefined)
      throw new InvitationFileError({ kind: "unlinkable", refusal });

    // Author terms.payload.send from the same inferMetadata(columns) the inviter's
    // own exchange falls back to on the quick path, so the declaration equals the
    // disclosed set that leaves the machine. When nothing is disclosed the helper
    // returns undefined and no empty payload block is minted (assigning it would
    // leave a `payload: undefined` key, diverging from the default terms).
    const payload = payloadSendForMetadata(metadata);
    if (payload !== undefined) linkageTerms.payload = payload;
    disclosedPayloadColumns = disclosedColumnNames(metadata);
    // Mint-boundary safety check keeping the consent surface accurate -- runs
    // before prepareForExchange, which checks the same invariant too late for
    // the token.
    assertPayloadSendDisclosed(
      linkageTerms.payload,
      metadata,
      linkageTerms.output,
    );
  }

  // Refuse a disclosed column whose name is too long, before the secret is
  // minted. The quick path infers its metadata from the CSV header, which no
  // schema bounds, so the name would otherwise reach PayloadColumnSchema's
  // `.max` at encode as a raw ZodError the UI flattens into its generic retry
  // dead-end -- and a caller authoring its own terms without the editor's
  // gate would mint a token naming a column the exchange cannot accept. Show
  // the typed, user-actionable failure here, as the empty-name gate above
  // does.
  const overlongPositions =
    overlongDisclosedColumnPositions(disclosureMetadata);
  if (overlongPositions.length > 0)
    throw new InvitationFileError({
      kind: "overlong",
      positions: overlongPositions,
    });

  // Fail closed, before the token is minted, on terms or a standardization
  // that declares a step expanding one value into several match candidates
  // under a strategy that matches one value per record
  // (assertFanOutImplemented, which prepareForExchange applies too late, at
  // exchange time, for an invitation already sent). The CLI's config-source
  // mint runs the same check. The editor's Generate gate is wider and fires
  // first on the paths it covers; this is the mint-boundary safety check the
  // quick path and any non-editor caller reach, covering the embedded terms'
  // element transforms and this party's own authored cleaning.
  assertFanOutImplemented(linkageTerms, params.standardization);

  // The per-party cleaning this mint stands behind, reconciled ONCE to the
  // terms it embeds: every surface that keeps a copy of a mint -- the
  // managed-exchange record a scheduled re-run replays, the CLI exchange file
  // the save path writes, the console's server-job config -- reads it from
  // here and hands it to `prepareForExchange` with no check of its own in
  // between. The editor's draft keeps a disabled key's cleaning so
  // re-enabling restores it, so the reconciliation belongs at the mint
  // rather than at each surface that reads one. The assertion fails here,
  // before a secret is minted, rather than at the operator's next unattended
  // run.
  const standardization =
    params.standardization === undefined
      ? undefined
      : standardizationForTerms(params.standardization, linkageTerms);
  if (standardization !== undefined)
    assertStandardizationMatchesTerms(standardization, linkageTerms);

  // Bound the token's lifetime so an intercepted invitation cannot be
  // accepted indefinitely. Measured from the current instant, so the
  // lifetime clock starts when the token is minted; the CLI mints `expires`
  // the same way (expiresFromNow in apps/cli/src/commands/bootstrap.ts).
  // encodeInvitation re-checks the result is in the future as a safety
  // check.
  const expires = new Date(Date.now() + lifetimeSeconds * 1000).toISOString();
  const sharedSecret = generateSharedSecret();
  const resolvedEndpoint = resolveConnectionEndpoint(
    connectionEndpoint,
    location,
  );
  // Two grounds, ORed so the declaration cannot contradict the endpoint the
  // token holds: the caller's resolved `retain_files`, and the endpoint's own
  // shape -- a split inbound/outbound rendezvous runs in retain mode whatever
  // the caller passed, and `encodeInvitation` refuses a mint emitting one that
  // leaves the retention undeclared. The shape ground never fires on webrtc,
  // which has no directory to split.
  const declaresRetainedFiles =
    retainsFiles || endpointRequiresRetainedFiles(resolvedEndpoint);
  const token: InvitationToken = {
    version: "1",
    linkageTerms,
    sharedSecret,
    expires,
    connectionEndpoint: resolvedEndpoint,
    disclosedPayloadColumns,
    ...(declaresRetainedFiles ? { inviterRetainsFiles: true } : {}),
  };

  const encoded = await encodeInvitation(token);
  return {
    encoded,
    deepLink: deepLinkFor(location.origin, encoded),
    sharedSecret,
    expires,
    linkageTerms,
    rawRows,
    columns,
    metadata: params.metadata,
    standardization,
    disclosedPayloadColumns,
  };
}
