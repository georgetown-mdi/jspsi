import {
  INVITATION_LIFETIME_SECONDS,
  MAX_INVITATION_LIFETIME_SECONDS,
  assertPayloadSendDisclosed,
  assessLinkageSatisfiability,
  disclosedColumnNames,
  encodeInvitation,
  generateSharedSecret,
  getDefaultLinkageTerms,
  inferMetadata,
  loadCSVFile,
} from "@psilink/core";

import { emptyColumnPositions } from "./columnNames";
import { payloadSendForMetadata } from "./metadataEditing";

import type {
  InvitationToken,
  LinkageField,
  LinkageTerms,
  Metadata,
  Standardization,
  WebRTCEndpoint,
} from "@psilink/core";

/**
 * The CSV input {@link generateInvitation} parses: exactly what core's
 * {@link loadCSVFile} accepts (a browser `File` in production; a Node readable
 * stream in tests). Derived from `loadCSVFile`'s own signature rather than
 * importing papaparse's `LocalFile` directly, so this module takes on no
 * dependency papaparse beyond the one core already owns. */
export type InvitationCSVInput = Parameters<typeof loadCSVFile>[0];

/**
 * Path a PeerJS client dials this app's signaling server at. Matches the dial
 * path used in `psi/rendezvous.ts` (`path: "/api/"`), which the server -- mounted
 * at `/api` by `apps/web/src/peerServer.ts` -- accepts. The acceptor reads this off
 * the endpoint and dials it the same way a client does, so it must carry the
 * client's dial path (trailing slash included), not the server's mount path.
 */
const PEERJS_SIGNALING_PATH = "/api/";

/**
 * Route the deep-link targets: the acceptor's accept/reject consent screen. The
 * route itself -- decode, linkage-terms review, and the derived-id rendezvous --
 * is built by the web rendezvous task (item 196035727); this module only
 * constructs a URL that points at it. The token rides in the URL fragment (see
 * {@link deepLinkFor}), so the contract this constant encodes is "path plus
 * fragment", which 196035727 must read in lockstep.
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
 * the secret and expiry that drive the rendezvous, and -- because the inviter
 * runs its own half of the exchange right after -- the linkage terms embedded in
 * the token plus the exact parsed rows those terms were derived from.
 *
 * {@link encoded} and {@link deepLink} carry the same token and so decode
 * identically; {@link linkageTerms}, {@link rawRows}, and {@link columns} are
 * local data the inviter reuses to run the exchange and are NEVER shared (only the
 * terms ride inside the encoded token).
 */
export interface GeneratedInvitation {
  /** The encoded invitation string -- the bare-string copy artifact. */
  encoded: string;
  /**
   * Deep-link URL `<origin>/accept#<encoded>` -- the URL copy artifact. The
   * token rides in the fragment, never a query parameter, so this confidential
   * value (it carries the setup secret and seeds the rendezvous id) is not sent
   * to the server and stays out of access logs and Referer headers; see
   * docs/SECURITY_DESIGN.md, "Invitation contents and confidentiality".
   */
  deepLink: string;
  /**
   * The fresh shared secret embedded in the token. Returned so the inviter can
   * derive its own rendezvous peer id and listen on it (the acceptor derives the
   * same id from the same secret carried in the invitation). It is the value
   * already inside `encoded`, surfaced here rather than re-decoded; it stays in
   * the browser and is never sent to a backend.
   */
  sharedSecret: string;
  /**
   * The token's bounded expiry (ISO 8601), surfaced beside `sharedSecret` so the
   * inviter can thread it into the authenticated key exchange's expiry guards
   * (its `expires !== undefined` gate then arms the in-handshake check). It is
   * the value already inside `encoded`. Always set: {@link generateInvitation}
   * mints a bounded lifetime onto every invitation.
   */
  expires: string;
  /**
   * The linkage terms embedded in the token, derived from the inviter's file
   * (inferred metadata -> default terms filtered to the keys the columns can
   * satisfy). Returned so the inviter's own exchange reuses THIS object verbatim
   * rather than re-deriving from the file: the embedded terms and the terms the
   * inviter's exchange runs on must be one and the same, or the partner adopts a
   * set that diverges from the inviter's and the terms-compatibility handshake
   * fails (the bug this flow fixes). Local: present inside `encoded` too, but
   * surfaced here so the exchange need not re-decode it.
   */
  linkageTerms: LinkageTerms;
  /**
   * The parsed CSV rows {@link linkageTerms} was derived from, returned so the
   * inviter's exchange runs on the exact data with no re-parse and no second file
   * prompt. Local-only: the rows are never encoded into the token or shared.
   */
  rawRows: Array<Record<string, string>>;
  /** The CSV column names, paired with {@link rawRows} -- the two inputs the
   * inviter's exchange feeds to `prepareForExchange`. Local-only. */
  columns: Array<string>;
  /**
   * The inviter's edited per-party column metadata, from the Advanced-options
   * editor. Threaded into the inviter's own `prepareForExchange` (never encoded in
   * the token), so its disclosure choices govern what the inviter sends and its
   * column->type bindings match the run that the authored keys were derived from.
   * Absent on the quick path, where metadata is inferred from the columns
   * downstream as before. Local-only.
   */
  metadata?: Metadata;
  /**
   * The inviter's authored per-party standardization, from the Advanced-options
   * editor's data-prep workbench. Paired with {@link metadata} and threaded into
   * the inviter's own `prepareForExchange` (never embedded in the token), so the
   * cleaning -- and the per-field input-column binding that lets two fields of one
   * semantic type bind to distinct columns -- matches the run the authored fields
   * were derived from. Absent on the quick path, where standardization is inferred
   * downstream. Local-only.
   */
  standardization?: Standardization;
}

/** Why {@link generateInvitation} refused to mint an invitation for the given
 * file. Both variants are user-actionable -- the inviter can choose another file
 * -- and both are thrown BEFORE any shared secret is generated, so a rejected
 * file never yields a token. Anything else {@link generateInvitation} throws (a
 * schema/encoding error, an SSR misuse) is an internal fault, not one of these. */
export type InvitationFileFailure =
  | {
      /** The CSV could not be read or parsed. */
      kind: "unreadable";
      /** The underlying read/parse error, for the caller to surface (sanitized)
       * and to log. */
      cause: unknown;
    }
  | {
      /** The file's columns satisfy none of the default linkage keys, so no
       * exchange could ever match -- the same zero-key condition the acceptor's
       * pre-flight blocks on (`satisfiableKeyCount === 0`). */
      kind: "unlinkable";
      /** The default linkage fields the file cannot produce, so the caller can
       * name the missing field types to the inviter. */
      unsatisfied: Array<LinkageField>;
    }
  | {
      /** The CSV header carries one or more empty (zero-length) column names -- a
       * trailing comma, a blank cell, or a leading delimiter produces an unnamed
       * (`""`) column. Core's {@link inferMetadata} rejects it at intake, and the
       * payload schema's `name` `.min(1)` would otherwise reject it only as a raw
       * ZodError at encode (the generic retry dead-end); refused here EARLY so the
       * caller can show a clear, actionable error. */
      kind: "unnameable";
      /** The 1-based positions of the empty-named columns, for the operator-facing
       * message (see {@link unnameableColumnsAlert}). */
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
          ? "invitation file satisfies no linkage keys"
          : "invitation file has an empty column name",
    );
    this.name = "InvitationFileError";
    this.failure = failure;
  }
}

/**
 * Build the credential-free WebRTC signaling locator the acceptor uses to reach
 * this app's PeerJS server, from the inviter's browser location. Mirrors the
 * acceptor's dial-location handling (`psi/rendezvous.ts`): `localhost` is
 * normalized to a loopback literal a peer can dial, and a default-port location
 * omits the port. The endpoint schema requires a reachable 1-65535 port when
 * present, so a blank or out-of-range port is dropped rather than encoded as a
 * meaningless locator.
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

/** Build the deep-link URL carrying `encoded` in the fragment (see
 * {@link GeneratedInvitation.deepLink} for why the fragment, not a query). */
export function deepLinkFor(origin: string, encoded: string): string {
  return `${origin}${ACCEPT_ROUTE_PATH}#${encoded}`;
}

/**
 * The disclosed-columns subset to carry on the token for this metadata: the
 * column names `disclosedColumnNames` selects (exactly what `preparePayload`
 * transmits), or undefined when nothing is disclosed -- the field is then omitted
 * and the acceptor receives no payload regardless, so a declared empty set could
 * never differ from what it gets. See the InvitationToken field.
 */
function disclosedColumnsForToken(
  metadata: Metadata,
): Array<string> | undefined {
  const columns = disclosedColumnNames(metadata);
  return columns.length > 0 ? columns : undefined;
}

/**
 * Generate a fresh single-use invitation from the inviter's CSV: a new shared
 * secret, the linkage terms derived from the file, and this app's PeerJS
 * endpoint, encoded to a string and also wrapped as a deep-link URL. Each call
 * mints a new secret, so calling it again supersedes any prior unsent invitation
 * -- a fresh secret means a fresh derived rendezvous id, and there is no
 * expectation that one invitation supports more than one exchange.
 *
 * This is the inviter's CSV-parse boundary: it parses `file` (via core's
 * {@link loadCSVFile}), infers column metadata, and derives the linkage terms
 * from it -- {@link getDefaultLinkageTerms} filtered to the keys the columns can
 * satisfy, plus a `payload.send` declaring the columns the inferred metadata
 * discloses -- then embeds exactly those terms in the token AND returns them with
 * the parsed rows. The inviter's own exchange must run on this same returned
 * `linkageTerms` object and `rawRows`/`columns`: a file is required at invite
 * time precisely so the embedded terms (which the acceptor adopts) and the terms
 * the inviter runs on are one and the same. The quick path leaves metadata and
 * standardization to per-CSV inference; the Advanced-options editor may supply
 * both (`metadata`/`standardization`), authored against this file's columns, and
 * they are threaded into the inviter's own exchange and the satisfiability
 * re-check -- never embedded in the token (they are per-party and local).
 *
 * Fails closed BEFORE minting the secret: a file that cannot be read/parsed, or
 * whose columns satisfy zero linkage keys, throws an {@link InvitationFileError}
 * (the latter mirroring the acceptor pre-flight's `satisfiableKeyCount === 0`
 * block and naming the unproducible fields) so no token is ever produced for an
 * unreadable or unlinkable file.
 *
 * The token carries a bounded `expires` (default {@link INVITATION_LIFETIME_SECONDS},
 * one hour) so an intercepted invitation has a finite misuse window. The acceptor
 * enforces it (`prepareAcceptedInvitation` rejects a token whose `expires` is at
 * or before the accept instant), and both sides read the same ISO-8601 `expires`,
 * so the bound the inviter sets is the bound the acceptor honors.
 *
 * Makes no network request: the encoded invitation is the rendezvous, so the
 * inviter never contacts a session backend (`/api/psi/*`).
 *
 * @throws {InvitationFileError} when the file is unreadable or unlinkable (before
 *                               any secret is minted).
 * @throws {UsageError} (from core) when authored terms declare a `payload.send`
 *                      column the edited metadata does not transmit, so the token
 *                      and the partner's consent screen cannot over-declare. The
 *                      Advanced editor derives `payload.send` from the disclosed
 *                      columns, so its send is structurally a subset of what
 *                      metadata transmits and this never fires on editor output;
 *                      it is the mint-boundary backstop (against a regression or a
 *                      non-editor caller), since `prepareForExchange`'s identical
 *                      check runs too late for the consent surface.
 */
export async function generateInvitation(params: {
  inviterName: string;
  /** The inviter's CSV; parsed here (see the function summary -- this is the
   * parse boundary). The terms are derived from its columns. */
  file: InvitationCSVInput;
  location: InvitationLocation;
  /**
   * Invitation lifetime in seconds; defaults to {@link INVITATION_LIFETIME_SECONDS}
   * (one hour) and must be in the range `(0, {@link MAX_INVITATION_LIFETIME_SECONDS}]`
   * (up to one year). The quick path omits it and takes the default; the Advanced-
   * options editor passes the inviter's chosen lifetime. The bounds are enforced
   * here so that seam cannot mint an unbounded token.
   */
  lifetimeSeconds?: number;
  /**
   * Authored linkage terms to embed, from the Advanced-options editor. When
   * supplied they are embedded VERBATIM: the editor seeded them from this file's
   * columns, validated them through {@link safeParseLinkageTerms}, and confirmed
   * at least one key is satisfiable, so the default-terms derivation is skipped
   * and `inviterName` is not consulted for the terms (the authored terms carry
   * their own `identity`). The file is still parsed -- for the `rawRows`/`columns`
   * the inviter's own exchange runs on, and for a fail-closed satisfiability
   * re-check against these exact terms. Omitted on the quick path, where the terms
   * are derived from the file's columns as before.
   */
  linkageTerms?: LinkageTerms;
  /**
   * The inviter's edited column metadata from the Advanced-options editor, paired
   * with `linkageTerms`. Returned on {@link GeneratedInvitation} and threaded into
   * the inviter's own exchange (never embedded in the token); the fail-closed
   * satisfiability re-check binds against it too, so the verdict matches the run.
   * Omitted on the quick path, where metadata is inferred downstream.
   */
  metadata?: Metadata;
  /**
   * The inviter's authored per-party standardization from the Advanced-options
   * data-prep workbench, paired with `metadata`/`linkageTerms`. Returned on
   * {@link GeneratedInvitation} for the inviter's own exchange and threaded into
   * the fail-closed satisfiability re-check (which binds against it, mirroring how
   * `metadata` already does), so the verdict matches the run that produces the
   * authored fields' keys. Never embedded in the token. Omitted on the quick path,
   * where standardization is inferred downstream.
   */
  standardization?: Standardization;
}): Promise<GeneratedInvitation> {
  const {
    inviterName,
    file,
    location,
    lifetimeSeconds = INVITATION_LIFETIME_SECONDS,
  } = params;

  // Bound the selected lifetime up front, where the cause is clear, rather than
  // leaving it to encodeInvitation's "expires must be in the future" backstop
  // (which catches only a non-positive net lifetime, and reports the wrong-looking
  // reason). Mirrors the CLI's two up-front rejections in validateInvite
  // (apps/cli/src/commands/invite.ts): a non-positive lifetime, and one past the
  // one-year ceiling. The ceiling is the security invariant that keeps the seam
  // from minting an effectively-permanent token; see MAX_INVITATION_LIFETIME_SECONDS.
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
  // file aborts with no token. loadCSVFile rejects only on a read/stream error (a
  // malformed-but-readable CSV resolves with rows); wrap that into the typed
  // user-actionable failure.
  let rawRows: Array<Record<string, string>>;
  let columns: Array<string>;
  try {
    const csvResult = await loadCSVFile(file);
    rawRows = csvResult.data as Array<Record<string, string>>;
    columns = csvResult.meta.fields ?? [];
  } catch (cause) {
    throw new InvitationFileError({ kind: "unreadable", cause });
  }

  // Refuse an unnamed-column header before any inference or minting. inferMetadata
  // (the quick path) and assessLinkageSatisfiability below both reject an empty
  // name by throwing a raw UsageError, and the authored path would carry a `""`
  // column into payload.send and bottom out in PayloadColumnSchema's name `.min(1)`
  // ZodError at encode -- both of which the UI flattens into its generic retry
  // dead-end. Surface the typed, user-actionable failure here instead, the same
  // "reject early with a clear error" intake philosophy the unreadable/unlinkable
  // gates follow.
  const emptyPositions = emptyColumnPositions(columns);
  if (emptyPositions.length > 0)
    throw new InvitationFileError({
      kind: "unnameable",
      positions: emptyPositions,
    });

  // The terms to embed. The Advanced-options editor's authored terms are embedded
  // verbatim; the quick path derives them from the file's columns (inferred
  // metadata filters the default keys to those the columns can satisfy -- the same
  // filter the inviter's own exchange would otherwise re-derive -- and authors a
  // payload.send for the columns that metadata discloses, below). standardization
  // is left to CSV inference downstream in both cases.
  // The columns this party will transmit for matched records, carried on the
  // token so the acceptor's consent screen and runtime lock-in derive from the
  // wire's own disclosure predicate (disclosedColumnNames) rather than the
  // separately-authored payload.send dictionary. Computed over the same metadata
  // the inviter's own exchange uses -- the Advanced editor's edited metadata, or
  // (quick path, and the editor when it authored none) the metadata inferred from
  // the columns -- so the declared set equals what preparePayload transmits.
  let disclosedPayloadColumns: Array<string> | undefined;
  let linkageTerms: LinkageTerms;
  if (params.linkageTerms !== undefined) {
    linkageTerms = params.linkageTerms;
    // The mint boundary stays fail-closed even though the editor already gates on
    // satisfiability: a set whose every key references a field the columns cannot
    // produce would run to the silent empty result the quick path's block exists
    // to prevent. Assess against the AUTHORED terms themselves (not the full
    // defaults) so the verdict matches the keys actually embedded; the editor
    // dropped the unproducible defaults, so a zero here means a genuinely
    // unlinkable file rather than a filtered-away default.
    const { unsatisfied, satisfiableKeyCount } = assessLinkageSatisfiability(
      columns,
      linkageTerms,
      params.standardization,
      params.metadata,
    );
    if (satisfiableKeyCount === 0)
      throw new InvitationFileError({ kind: "unlinkable", unsatisfied });
    // Reject an over-declaring payload.send before the token is minted, so the
    // partner's consent screen never carries a column this party's metadata gates
    // off. The Advanced editor derives payload.send from the disclosed columns, so
    // its send is structurally a subset and this is a defense-in-depth backstop
    // (against a regression or a non-editor caller) rather than a gate the editor
    // reaches; it runs here because the exchange-time check in prepareForExchange
    // runs too late for the consent surface. The quick path (else) authors its own
    // payload from the inferred metadata and runs the same backstop there.
    if (params.metadata !== undefined)
      assertPayloadSendDisclosed(linkageTerms.payload, params.metadata);
    disclosedPayloadColumns = disclosedColumnsForToken(
      params.metadata ?? inferMetadata(columns),
    );
  } else {
    const metadata = inferMetadata(columns);
    linkageTerms = getDefaultLinkageTerms(inviterName, metadata);

    // Block a file that satisfies no linkage key, mirroring the acceptor pre-flight
    // (FileAcquire): with zero satisfiable keys the exchange would emit no key
    // strings and yield a silent empty result. Gate on the detector's
    // satisfiableKeyCount, NOT on linkageTerms.linkageKeys.length: the two agree for
    // a file with columns, but getDefaultLinkageTerms falls back to ALL keys when
    // its metadata is empty (a column-less file), so the embedded set's key count
    // would be non-zero there and miss the block, while the detector counts actual
    // column producibility and correctly reports zero. Assess against the FULL
    // default terms (every default field declared) rather than the filtered
    // `linkageTerms`, so the block can name the field types the file lacks -- the
    // filtered set no longer declares the dropped fields.
    const { unsatisfied, satisfiableKeyCount } = assessLinkageSatisfiability(
      columns,
      getDefaultLinkageTerms(inviterName),
    );
    if (satisfiableKeyCount === 0)
      throw new InvitationFileError({ kind: "unlinkable", unsatisfied });

    // Author the payload data dictionary (terms.payload.send) for what the quick
    // path already transmits -- the columns the inferred metadata discloses -- the
    // quick-path analogue of the Advanced editor's authored send (item 202741998).
    // payloadSendForMetadata derives the send from the SAME inferMetadata(columns)
    // the inviter's own exchange falls back to (no authored metadata travels on the
    // quick path), so the declaration equals disclosedColumnNames over that metadata
    // and the partner's consent screen, the token, and the exchange record carry
    // exactly what leaves the machine. This declares what already flows; it starts
    // and stops sending nothing. `receive` stays unauthored (the inviter does not
    // know the partner's schema; reconciliation is lazy). When nothing is disclosed
    // the helper returns undefined and no empty payload block is minted (assigning
    // it would leave a `payload: undefined` key, diverging from the default terms).
    const payload = payloadSendForMetadata(metadata);
    if (payload !== undefined) linkageTerms.payload = payload;
    disclosedPayloadColumns = disclosedColumnsForToken(metadata);
    // Mint-boundary backstop, mirroring the authored path above: the send is a
    // subset of (equal to) the disclosed set by construction, so this never throws
    // on quick-path output, but it keeps the consent surface honest as an executable
    // check rather than a comment, and runs before prepareForExchange (which checks
    // the same invariant too late for the token's consent screen).
    assertPayloadSendDisclosed(linkageTerms.payload, metadata);
  }

  // Bound the token's lifetime so an intercepted invitation cannot be accepted
  // indefinitely. Measured from the current instant, so the lifetime clock starts
  // when the token is minted; the CLI mints `expires` the same way (expiresFromNow
  // in apps/cli/src/commands/bootstrap.ts). encodeInvitation re-checks the result
  // is in the future as a backstop.
  const expires = new Date(Date.now() + lifetimeSeconds * 1000).toISOString();
  const sharedSecret = generateSharedSecret();
  const token: InvitationToken = {
    version: "1",
    linkageTerms,
    sharedSecret,
    expires,
    connectionEndpoint: webrtcEndpointFromLocation(location),
    disclosedPayloadColumns,
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
    standardization: params.standardization,
  };
}
