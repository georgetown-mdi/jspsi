import { Readable } from "node:stream";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  INVITATION_LIFETIME_SECONDS,
  MAX_INVITATION_LIFETIME_SECONDS,
  assertPayloadSendDisclosed,
  decodeInvitation,
  disclosedColumnNames,
  getDefaultLinkageTerms,
  inferMetadata,
  validateCompatibility,
} from "@psilink/core";

import {
  ACCEPT_ROUTE_PATH,
  InvitationFileError,
  deepLinkFor,
  generateInvitation,
  webrtcEndpointFromLocation,
} from "../../src/psi/invitation.js";
import { prepareAcceptedInvitation } from "../../src/psi/acceptInvitation.js";
import { summarizeInvitation } from "../../src/psi/invitationSummary.js";

import type { InvitationLocation } from "../../src/psi/invitation.js";

const location: InvitationLocation = {
  origin: "https://example.org:8443",
  hostname: "example.org",
  port: "8443",
};

// A CSV carrying every default linkage column, so the file-derived terms keep all
// the default keys -- the baseline that round-trips to the full default terms.
const ALL_COLUMNS_CSV =
  "ssn,ssn4,first_name,last_name,dob\n123456789,6789,Alice,Smith,1990-01-02\n";
// A partial CSV missing ssn4 (like test_data/fake_data_{1,2}.csv): keys that
// reference ssn4 drop out, the rest survive.
const PARTIAL_CSV =
  "ssn,first_name,last_name,dob\n123456789,Alice,Smith,1990-01-02\n";

/** A fresh readable CSV stream. `loadCSVFile` consumes its input once, so each
 * generateInvitation call needs its own stream; this is core's parse boundary in
 * the browser fed a Node stream here (papaparse parses both). */
function csvStream(content: string = ALL_COLUMNS_CSV): Readable {
  return Readable.from(content);
}

/** Pull the encoded token out of a deep-link's fragment. */
function tokenFromDeepLink(deepLink: string): string {
  return new URL(deepLink).hash.slice(1);
}

describe("generateInvitation", () => {
  test("round-trips through decodeInvitation with secret, terms, and endpoint intact", async () => {
    const inviterName = "County Health Dept";
    const { encoded } = await generateInvitation({
      inviterName,
      file: csvStream(),
      location,
    });

    const token = await decodeInvitation(encoded);

    expect(token.version).toBe("1");
    // The secret is a base64url-encoded 32-byte value (43 chars, last in the
    // padding-constrained set); see SHARED_SECRET_REGEX in core.
    expect(token.sharedSecret).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
    // The file carries every default column, so the file-derived terms equal the
    // full default set keyed on the inviter's name -- real terms, not a placeholder.
    expect(token.linkageTerms).toStrictEqual(
      getDefaultLinkageTerms(inviterName),
    );
    expect(token.linkageTerms.identity).toBe(inviterName);
    expect(token.linkageTerms.linkageKeys.length).toBeGreaterThan(0);
    expect(token.connectionEndpoint).toStrictEqual({
      channel: "webrtc",
      host: "example.org",
      port: 8443,
      path: "/api/",
    });
  });

  test("defaults to a webrtc endpoint when no connectionEndpoint is requested", async () => {
    // The existing call sites omit connectionEndpoint, so the default path must
    // still embed the app's own webrtc signaling locator, unchanged.
    const { encoded } = await generateInvitation({
      inviterName: "County Health Dept",
      file: csvStream(),
      location,
    });
    const token = await decodeInvitation(encoded);
    expect(token.connectionEndpoint).toStrictEqual({
      channel: "webrtc",
      host: "example.org",
      port: 8443,
      path: "/api/",
    });
  });

  test("embeds a credential-free sftp endpoint when one is requested", async () => {
    const { encoded } = await generateInvitation({
      inviterName: "County Health Dept",
      file: csvStream(),
      location,
      connectionEndpoint: {
        channel: "sftp",
        host: "sftp.example.org",
        port: 2222,
        path: "/exchanges/drop",
      },
    });
    const token = await decodeInvitation(encoded);
    // The requested sftp locator rides the token, not the location's webrtc one.
    expect(token.connectionEndpoint).toStrictEqual({
      channel: "sftp",
      host: "sftp.example.org",
      port: 2222,
      path: "/exchanges/drop",
    });
    // No credential rides along: the endpoint carries only the public locator
    // keys (the type admits no credential field; the strict schema rejects one).
    const serialized = JSON.stringify(token.connectionEndpoint);
    expect(serialized).not.toContain("username");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("private_key");
  });

  test("embeds a filedrop endpoint when one is requested", async () => {
    const { encoded } = await generateInvitation({
      inviterName: "County Health Dept",
      file: csvStream(),
      location,
      connectionEndpoint: { channel: "filedrop", path: "/mnt/share/drop" },
    });
    const token = await decodeInvitation(encoded);
    expect(token.connectionEndpoint).toStrictEqual({
      channel: "filedrop",
      path: "/mnt/share/drop",
    });
  });

  test("derives and embeds terms filtered to the keys the file can satisfy", async () => {
    const inviterName = "County Health Dept";
    const result = await generateInvitation({
      inviterName,
      file: csvStream(PARTIAL_CSV),
      location,
    });

    // The embedded terms are the defaults filtered to the file's columns
    // (inferred metadata -> default terms): a CSV without ssn4 drops every
    // ssn4-keyed combination.
    const expected = getDefaultLinkageTerms(
      inviterName,
      inferMetadata(["ssn", "first_name", "last_name", "dob"]),
    );
    const token = await decodeInvitation(result.encoded);
    expect(token.linkageTerms).toStrictEqual(expected);
    // It is genuinely filtered, not the full default set: fewer keys, and none of
    // the dropped ssn4 keys remain.
    expect(token.linkageTerms.linkageKeys.length).toBeGreaterThan(0);
    expect(token.linkageTerms.linkageKeys.length).toBeLessThan(
      getDefaultLinkageTerms(inviterName).linkageKeys.length,
    );
    expect(
      token.linkageTerms.linkageKeys.some((k) =>
        k.elements.some((e) => e.field === "ssn4"),
      ),
    ).toBe(false);

    // The returned terms object IS the embedded one, surfaced for the inviter's
    // own exchange to reuse verbatim (no re-derivation).
    expect(result.linkageTerms).toStrictEqual(token.linkageTerms);
  });

  test("returns the exact parsed rows and columns the terms came from", async () => {
    const { rawRows, columns } = await generateInvitation({
      inviterName: "County Health Dept",
      file: csvStream(PARTIAL_CSV),
      location,
    });

    // The inviter's exchange runs on these directly -- no re-parse, no second
    // file prompt.
    expect(columns).toEqual(["ssn", "first_name", "last_name", "dob"]);
    expect(rawRows).toEqual([
      {
        ssn: "123456789",
        first_name: "Alice",
        last_name: "Smith",
        dob: "1990-01-02",
      },
    ]);
  });

  test("threads the inviter's edited metadata to the result, never into the token", async () => {
    // The Advanced editor passes its edited metadata alongside the authored terms;
    // marking first_name as sent makes the metadata distinctive.
    const metadata = inferMetadata([
      "ssn",
      "first_name",
      "last_name",
      "dob",
    ]).map((c) =>
      c.name === "first_name"
        ? { ...c, role: "payload" as const, isPayload: true }
        : c,
    );
    const result = await generateInvitation({
      inviterName: "Org",
      file: csvStream(PARTIAL_CSV),
      location,
      linkageTerms: getDefaultLinkageTerms("Org", metadata),
      metadata,
    });
    // Returned so the inviter's own exchange binds and discloses on it...
    expect(result.metadata).toEqual(metadata);
    // ...but it is per-party and local: never embedded in the encoded token.
    const token = await decodeInvitation(result.encoded);
    expect("metadata" in token).toBe(false);
  });

  test("a partial-column invitation stays terms-compatible with the acceptor it produces", async () => {
    // The bug this flow fixes: the acceptor adopts the invitation's terms, so if
    // the embedded set diverged from what the inviter runs, the terms-compat
    // handshake would reject. Now the inviter both embeds and runs THESE terms,
    // and the acceptor adopts them (its own identity substituted), so the two
    // sides carry an identical key set.
    const { linkageTerms } = await generateInvitation({
      inviterName: "Inviter",
      file: csvStream(PARTIAL_CSV),
      location,
    });
    const acceptorAdopted = { ...linkageTerms, identity: "Acceptor" };
    expect(validateCompatibility(linkageTerms, acceptorAdopted).errors).toEqual(
      [],
    );

    // Contrast: had the invitation embedded the UNFILTERED defaults (the pre-fix
    // behavior) while the inviter ran the file-filtered set, the key sets would
    // differ and the handshake would reject.
    const unfilteredAcceptor = {
      ...getDefaultLinkageTerms("Inviter"),
      identity: "Acceptor",
    };
    expect(
      validateCompatibility(linkageTerms, unfilteredAcceptor).errors,
    ).not.toEqual([]);
  });

  test("embeds authored linkageTerms verbatim and round-trips them unchanged", async () => {
    // The Advanced-options editor authors a set the quick path would not derive
    // for this file (a single key, a different identity), and supplies it. It
    // must be embedded as-is -- no default derivation, and inviterName not
    // consulted for the terms' identity.
    const base = getDefaultLinkageTerms(
      "Authored Org",
      inferMetadata(["ssn", "ssn4", "first_name", "last_name", "dob"]),
    );
    const authored = { ...base, linkageKeys: base.linkageKeys.slice(0, 1) };

    const { encoded, linkageTerms } = await generateInvitation({
      inviterName: "ignored-name",
      file: csvStream(ALL_COLUMNS_CSV),
      location,
      linkageTerms: authored,
    });

    const token = await decodeInvitation(encoded);
    // (f) authored terms round-trip through generateInvitation and decode back equal.
    expect(token.linkageTerms).toStrictEqual(authored);
    // The returned object is the embedded one, for the inviter's own exchange.
    expect(linkageTerms).toStrictEqual(authored);
    // The default derivation is skipped: the file carries every default column,
    // so the quick path would have embedded the full multi-key set.
    expect(token.linkageTerms.linkageKeys).toHaveLength(1);
    expect(token.linkageTerms.linkageKeys.length).toBeLessThan(
      getDefaultLinkageTerms(
        "ignored-name",
        inferMetadata(["ssn", "ssn4", "first_name", "last_name", "dob"]),
      ).linkageKeys.length,
    );
    // inviterName is not consulted for the identity when terms are authored.
    expect(token.linkageTerms.identity).toBe("Authored Org");
  });

  test("fails closed when authored terms no column can satisfy reach the mint", async () => {
    // A defense-in-depth backstop on the mint boundary: even if the editor's gate
    // were bypassed, authored terms whose every key references a field the file
    // cannot produce must not mint a token (it would run to a silent empty
    // result). The only key needs ssn4; PARTIAL_CSV has no ssn4 column.
    const base = getDefaultLinkageTerms(
      "Org",
      inferMetadata(["ssn", "ssn4", "first_name", "last_name", "dob"]),
    );
    const ssn4Key = base.linkageKeys.find((k) =>
      k.elements.some((e) => e.field === "ssn4"),
    );
    expect(ssn4Key).toBeDefined();
    const needsSsn4 = { ...base, linkageKeys: [ssn4Key!] };

    await expect(
      generateInvitation({
        inviterName: "Org",
        file: csvStream(PARTIAL_CSV),
        location,
        linkageTerms: needsSsn4,
      }),
    ).rejects.toBeInstanceOf(InvitationFileError);
  });

  test("rejects an unnamed column header early as an unnameable InvitationFileError", async () => {
    // A trailing comma in the header yields an unnamed ("") column. The quick path
    // must reject it early as a typed, user-actionable InvitationFileError (kind
    // "unnameable", naming the 1-based position) rather than letting inferMetadata's
    // raw UsageError -- or the payload schema's name .min(1) ZodError at encode --
    // bottom out in the UI's generic "please try again" retry dead-end.
    const EMPTY_HEADER_CSV =
      "ssn,first_name,last_name,dob,\n123456789,Alice,Smith,1990-01-02,\n";
    const error = await generateInvitation({
      inviterName: "Org",
      file: csvStream(EMPTY_HEADER_CSV),
      location,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvitationFileError);
    expect((error as InvitationFileError).failure).toEqual({
      kind: "unnameable",
      positions: [5],
    });
  });

  test("fails closed when authored terms over-declare payload.send at the mint", async () => {
    // Defense-in-depth backstop: the Advanced editor authors no payload block
    // today, so this cannot fire from the UI until payload authoring lands (item
    // 202741998). Constructed by hand here to prove the mint boundary rejects an
    // over-declaring payload.send rather than letting the token and the partner's
    // consent screen carry a column the metadata gates off. `ssn` is a linkage
    // column (isPayload:false), so it is not disclosed and may not be declared.
    const metadata = inferMetadata(["ssn", "first_name", "last_name", "dob"]);
    const authored = {
      ...getDefaultLinkageTerms("Org", metadata),
      payload: { send: [{ name: "ssn" }] },
    };

    await expect(
      generateInvitation({
        inviterName: "Org",
        file: csvStream(PARTIAL_CSV),
        location,
        linkageTerms: authored,
        metadata,
      }),
    ).rejects.toThrow(/does not transmit/);
  });

  // A linkable CSV (ssn + names + dob give satisfiable keys) that ALSO carries
  // columns the quick path discloses: `notes` infers as an `other` column (role
  // payload), and `member_id` infers as a single row-identifier left isPayload, so
  // both are transmitted -- exactly the two inferred-disclosure shapes the quick
  // path must now declare.
  const DISCLOSING_COLUMNS = [
    "ssn",
    "first_name",
    "last_name",
    "dob",
    "notes",
    "member_id",
  ];
  const DISCLOSING_CSV =
    "ssn,first_name,last_name,dob,notes,member_id\n" +
    "123456789,Alice,Smith,1990-01-02,vip,M001\n";

  test("quick path authors payload.send equal to the inferred metadata's disclosed columns", async () => {
    const inviterName = "County Health Dept";
    const disclosed = disclosedColumnNames(inferMetadata(DISCLOSING_COLUMNS));
    // An inferred "other" column (notes) and an _id row-identifier (member_id),
    // both still transmitted by the quick path.
    expect(disclosed).toEqual(["notes", "member_id"]);

    const { encoded, linkageTerms } = await generateInvitation({
      inviterName,
      file: csvStream(DISCLOSING_CSV),
      location,
    });
    const token = await decodeInvitation(encoded);

    // The token's payload.send enumerates exactly the disclosed columns, derived
    // from the same predicate the wire transmits on -- so it cannot over- or
    // under-state what leaves the machine. receive is never authored (lazy).
    expect(token.linkageTerms.payload?.send?.map((c) => c.name)).toEqual(
      disclosed,
    );
    expect(token.linkageTerms.payload?.receive).toBeUndefined();
    // The returned terms (the inviter runs its own exchange on these) carry the
    // same authored send.
    expect(linkageTerms.payload?.send?.map((c) => c.name)).toEqual(disclosed);
    // It cannot trip core's over-declaration reject: the send equals the disclosed
    // set core gates transmission on, asserted against the same inferred metadata
    // the inviter's exchange falls back to.
    expect(() =>
      assertPayloadSendDisclosed(
        token.linkageTerms.payload,
        inferMetadata(DISCLOSING_COLUMNS),
      ),
    ).not.toThrow();

    // The partner's consent screen reads its payload entries from the token via
    // summarizeInvitation (the same boundary the Advanced path's authored send
    // flows through). Feed the quick-path token through it to pin that the disclosed
    // columns surface as payload entries the partner sees before consenting -- the
    // acceptance criterion that closes the quick-path declaration/consent gap. Plain
    // ASCII names pass through sanitizeForDisplay unchanged.
    const summary = summarizeInvitation(token);
    expect(summary.payload?.send).toEqual(disclosed);
    expect(summary.payload?.receive).toEqual([]);
  });

  test("quick path carries the disclosed-columns subset on the token", async () => {
    const disclosed = disclosedColumnNames(inferMetadata(DISCLOSING_COLUMNS));
    const result = await generateInvitation({
      inviterName: "Org",
      file: csvStream(DISCLOSING_CSV),
      location,
    });
    const token = await decodeInvitation(result.encoded);
    // The dedicated wire field carries exactly what preparePayload transmits.
    expect(token.disclosedPayloadColumns).toEqual(disclosed);
    // The surfaced field is the token's value, so a persisting caller (the
    // managed-exchange deposit) records the same commitment the token published.
    expect(result.disclosedPayloadColumns).toEqual(
      token.disclosedPayloadColumns,
    );
  });

  test("quick path carries an empty disclosed subset when the file discloses nothing", async () => {
    // The web inviter always knows its metadata, so the field is always carried --
    // here the EMPTY set, which locks the acceptor in to "receive nothing" (a later
    // non-empty payload aborts) rather than reconciling lazily.
    const result = await generateInvitation({
      inviterName: "Org",
      file: csvStream(ALL_COLUMNS_CSV),
      location,
    });
    const token = await decodeInvitation(result.encoded);
    expect(token.disclosedPayloadColumns).toEqual([]);
    expect(result.disclosedPayloadColumns).toEqual([]);
  });

  test("summarizeInvitation derives the received set from the carried subset with no payload.send authored", () => {
    // A CLI-style invitation: the terms author no payload block, but the token
    // carries the disclosed-columns subset. The acceptor's consent display must
    // derive the columns-it-will-receive from that carried set -- the same
    // predicate the wire transmits on -- not from the (absent) payload.send. This
    // is the under-declaration gap the dedicated field closes, and the no-drift
    // invariant: the displayed set equals the transmitted set over one metadata.
    const metadata = inferMetadata(DISCLOSING_COLUMNS);
    const disclosed = disclosedColumnNames(metadata);
    const terms = getDefaultLinkageTerms("Inviter", metadata);
    expect(terms.payload).toBeUndefined();
    const summary = summarizeInvitation({
      linkageTerms: terms,
      disclosedPayloadColumns: disclosed,
    });
    expect(summary.payload?.send).toEqual(disclosed);
  });

  test("summarizeInvitation shows no received columns when nothing is carried or authored", () => {
    const terms = getDefaultLinkageTerms(
      "Inviter",
      inferMetadata(["ssn", "first_name", "last_name", "dob"]),
    );
    const summary = summarizeInvitation({ linkageTerms: terms });
    expect(summary.payload).toBeUndefined();
  });

  test("summarizeInvitation surfaces an empty carried subset as a declared 'receive nothing'", () => {
    // The web inviter always carries the disclosed subset, possibly empty. An empty
    // carried set is the strict "receive nothing" lock-in (a later non-empty payload
    // aborts), NOT the lazy case -- so the section is rendered with an empty,
    // DECLARED send (the renderer shows "(none)"), distinct from a lazy/absent set
    // which suppresses the section. This keeps the consent screen and the runtime
    // enforcement aligned.
    const terms = getDefaultLinkageTerms(
      "Inviter",
      inferMetadata(["ssn", "first_name", "last_name", "dob"]),
    );
    const summary = summarizeInvitation({
      linkageTerms: terms,
      disclosedPayloadColumns: [],
    });
    expect(summary.payload).toEqual({
      send: [],
      sendDeclared: true,
      receive: [],
      receiveDeclared: false,
    });
  });

  test("summarizeInvitation surfaces an authored empty payload.receive as a declared request", () => {
    // The receive-side mirror of the declared-empty send case above: an authored
    // `payload.receive: []` is the strict "the acceptor sends nothing" assertion,
    // distinct from an absent receive (lazy). It must surface as a DECLARED receive
    // (receiveDeclared true, receive empty -> the renderer shows "(none)") so the
    // consent screen does not collapse it with the lazy case the way it once did.
    const terms = getDefaultLinkageTerms(
      "Inviter",
      inferMetadata(["ssn", "first_name", "last_name", "dob"]),
    );
    const summary = summarizeInvitation({
      linkageTerms: { ...terms, payload: { receive: [] } },
    });
    expect(summary.payload).toEqual({
      send: [],
      sendDeclared: false,
      receive: [],
      receiveDeclared: true,
    });
  });

  test("summarizeInvitation suppresses the payload section for a lazy (absent) subset", () => {
    // No carried subset and no authored payload.send: the send side is lazy (the
    // inviter sends whatever its metadata discloses, nothing declared up front), so
    // the section is omitted -- distinct from the declared-empty case above.
    const terms = getDefaultLinkageTerms(
      "Inviter",
      inferMetadata(["ssn", "first_name", "last_name", "dob"]),
    );
    const summary = summarizeInvitation({ linkageTerms: terms });
    expect(summary.payload).toBeUndefined();
  });

  test("quick path authors no payload when the file discloses no column", async () => {
    // ALL_COLUMNS_CSV is all linkage-typed columns: the inferred metadata discloses
    // nothing, so no (empty) payload block is authored.
    expect(
      disclosedColumnNames(
        inferMetadata(["ssn", "ssn4", "first_name", "last_name", "dob"]),
      ),
    ).toEqual([]);
    const { encoded, linkageTerms } = await generateInvitation({
      inviterName: "Org",
      file: csvStream(ALL_COLUMNS_CSV),
      location,
    });
    const token = await decodeInvitation(encoded);
    expect(token.linkageTerms.payload).toBeUndefined();
    // No `payload: undefined` key either -- the returned terms equal the bare
    // defaults, so the inviter's own exchange sees no payload to reconcile.
    expect("payload" in linkageTerms).toBe(false);
  });

  test("the quick path's authored payload reconciles with a lazy acceptor", async () => {
    const { linkageTerms } = await generateInvitation({
      inviterName: "Inviter",
      file: csvStream(DISCLOSING_CSV),
      location,
    });
    expect(linkageTerms.payload?.send?.map((c) => c.name)).toEqual([
      "notes",
      "member_id",
    ]);

    // A lazy acceptor declares no payload.receive expectation (it does not know it
    // will receive these columns), so the reconcile takes whatever the inviter
    // sends -- both directions of validateCompatibility pass with no payload error.
    const lazyAcceptor = { ...linkageTerms, identity: "Acceptor" };
    delete (lazyAcceptor as { payload?: unknown }).payload;
    expect(validateCompatibility(linkageTerms, lazyAcceptor).errors).toEqual(
      [],
    );
    expect(validateCompatibility(lazyAcceptor, linkageTerms).errors).toEqual(
      [],
    );

    // And the strict mirror -- an acceptor that adopts the inviter's send into its
    // own receive (the deriveAcceptedLinkageTerms shape) -- agrees too.
    const mirrorAcceptor = {
      ...linkageTerms,
      identity: "Acceptor",
      payload: { receive: linkageTerms.payload?.send },
    };
    expect(validateCompatibility(linkageTerms, mirrorAcceptor).errors).toEqual(
      [],
    );
    expect(validateCompatibility(mirrorAcceptor, linkageTerms).errors).toEqual(
      [],
    );
  });

  test("returns the embedded shared secret so the inviter can derive its id", async () => {
    const { encoded, sharedSecret } = await generateInvitation({
      inviterName: "County Health Dept",
      file: csvStream(),
      location,
    });

    // The returned secret is exactly the one inside the encoded token: the
    // inviter derives its rendezvous peer id from it without re-decoding.
    const token = await decodeInvitation(encoded);
    expect(sharedSecret).toBe(token.sharedSecret);
  });

  test("returns the embedded expires so the inviter can arm the handshake expiry guards", async () => {
    const { encoded, expires } = await generateInvitation({
      inviterName: "County Health Dept",
      file: csvStream(),
      location,
    });

    // The returned expires is exactly the bounded value inside the encoded
    // token, surfaced (not re-decoded) so the inviter threads it into the
    // authenticated key exchange alongside the secret. Always present: every
    // generated invitation is bounded.
    const token = await decodeInvitation(encoded);
    expect(expires).toBeDefined();
    expect(expires).toBe(token.expires);
  });

  test("two successive generations yield different secrets (so different derived ids)", async () => {
    const inviterName = "County Health Dept";
    const first = await generateInvitation({
      inviterName,
      file: csvStream(),
      location,
    });
    const second = await generateInvitation({
      inviterName,
      file: csvStream(),
      location,
    });

    const a = await decodeInvitation(first.encoded);
    const b = await decodeInvitation(second.encoded);

    expect(a.sharedSecret).not.toBe(b.sharedSecret);
    expect(first.encoded).not.toBe(second.encoded);
  });

  test("the deep-link and the bare string decode to identical tokens", async () => {
    const { encoded, deepLink } = await generateInvitation({
      inviterName: "County Health Dept",
      file: csvStream(),
      location,
    });

    expect(tokenFromDeepLink(deepLink)).toBe(encoded);
    const fromBare = await decodeInvitation(encoded);
    const fromLink = await decodeInvitation(tokenFromDeepLink(deepLink));
    expect(fromLink).toStrictEqual(fromBare);
  });

  test("the deep-link targets the /accept route with the token in the fragment", async () => {
    const { encoded, deepLink } = await generateInvitation({
      inviterName: "County Health Dept",
      file: csvStream(),
      location,
    });

    const url = new URL(deepLink);
    expect(url.origin).toBe(location.origin);
    expect(url.pathname).toBe(ACCEPT_ROUTE_PATH);
    // Token in the fragment, not the query: never sent to the server.
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#${encoded}`);
  });

  describe("issues no /api/psi/* (or any) network call", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    test("does not fetch when generating an invitation", async () => {
      vi.stubGlobal("fetch", vi.fn());

      await generateInvitation({
        inviterName: "County Health Dept",
        file: csvStream(),
        location,
      });

      expect(fetch).not.toHaveBeenCalled();
    });
  });
});

describe("generateInvitation from profiled columns (console path)", () => {
  const ALL_COLUMNS = ["ssn", "ssn4", "first_name", "last_name", "dob"];

  test("binds the same terms as parsing the same columns, with no rawRows", async () => {
    const inviterName = "County Health Dept";
    const fromColumns = await generateInvitation({
      inviterName,
      profiledColumns: ALL_COLUMNS,
      location,
    });
    const fromFile = await generateInvitation({
      inviterName,
      file: csvStream(),
      location,
    });

    const columnsToken = await decodeInvitation(fromColumns.encoded);
    // Columns-derived terms equal the file-derived terms (the quick path infers
    // metadata from columns either way).
    expect(columnsToken.linkageTerms).toStrictEqual(fromFile.linkageTerms);
    expect(fromColumns.columns).toEqual(ALL_COLUMNS);
    // No rows are produced on this path -- the console browser-transport run that
    // would consume them does not exist.
    expect(fromColumns.rawRows).toEqual([]);
  });

  test("keeps the columns-based satisfiability re-check: an unlinkable column set is refused", async () => {
    // A column set that satisfies no default linkage key -- no name, dob, ssn, etc.
    const error: unknown = await generateInvitation({
      inviterName: "Org",
      profiledColumns: ["member_id", "notes"],
      location,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvitationFileError);
    expect((error as InvitationFileError).failure.kind).toBe("unlinkable");
  });

  test("rejects supplying neither file nor profiledColumns", async () => {
    const error: unknown = await generateInvitation({
      inviterName: "Org",
      location,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "exactly one of file or profiledColumns",
    );
  });

  test("rejects supplying both file and profiledColumns", async () => {
    const error: unknown = await generateInvitation({
      inviterName: "Org",
      file: csvStream(),
      profiledColumns: ALL_COLUMNS,
      location,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "exactly one of file or profiledColumns",
    );
  });
});

describe("generateInvitation fail-closed before mint", () => {
  test("rejects an unreadable file with an InvitationFileError (no token minted)", async () => {
    // A stream that errors on read stands in for an unreadable file. The failure
    // is thrown before the secret is generated, so no invitation is produced.
    const erroring = new Readable({
      read() {
        this.destroy(new Error("read failed"));
      },
    });
    const err: unknown = await generateInvitation({
      inviterName: "County Health Dept",
      file: erroring,
      location,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InvitationFileError);
    expect((err as InvitationFileError).failure.kind).toBe("unreadable");
  });

  test("rejects a file that satisfies zero linkage keys, naming the missing fields", async () => {
    // A CSV with no linkage-typed columns: every default key references a field
    // it cannot produce, so no key survives -- the same satisfiableKeyCount === 0
    // block the acceptor pre-flight enforces.
    const err: unknown = await generateInvitation({
      inviterName: "County Health Dept",
      file: csvStream("notes\nhello\n"),
      location,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InvitationFileError);
    const failure = (err as InvitationFileError).failure;
    expect(failure.kind).toBe("unlinkable");
    if (failure.kind !== "unlinkable") throw new Error("unreachable");
    // It names the default field types the file lacks (assessed against the full
    // defaults, which the filtered embed terms no longer declare).
    const missingTypes = failure.unsatisfied.map((f) => f.type);
    expect(missingTypes).toContain("ssn");
    expect(missingTypes).toContain("first_name");
    expect(missingTypes).toContain("date_of_birth");
  });

  test("rejects a column-less file, not fooled by the empty-metadata all-keys fallback", async () => {
    // The subtle case the block must catch: with no columns, getDefaultLinkageTerms
    // falls back to ALL keys (its metadata is empty), so the embedded set's key
    // count is non-zero -- but the satisfiability detector counts zero producible
    // keys, and that is what the block gates on. So an empty CSV is refused, and
    // every default field is named as unproducible.
    const err: unknown = await generateInvitation({
      inviterName: "County Health Dept",
      file: csvStream(""),
      location,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InvitationFileError);
    const failure = (err as InvitationFileError).failure;
    expect(failure.kind).toBe("unlinkable");
    if (failure.kind !== "unlinkable") throw new Error("unreachable");
    expect(failure.unsatisfied.map((f) => f.type)).toEqual(
      expect.arrayContaining([
        "ssn",
        "ssn4",
        "first_name",
        "last_name",
        "date_of_birth",
      ]),
    );
  });
});

describe("generateInvitation expiry", () => {
  /**
   * Read the token's `expires` as epoch ms, asserting it is present. The
   * generator measures the lifetime from its own `Date.now()` (not an injected
   * clock -- encodeInvitation re-checks `expires` against the live clock, so a
   * second injectable clock could not be honored), so callers bracket the call
   * with their own before/after window rather than assert an exact instant.
   */
  async function expiresMsOf(encoded: string): Promise<number> {
    const token = await decodeInvitation(encoded);
    expect(token.expires).toBeDefined();
    return new Date(token.expires ?? "").getTime();
  }

  test("mints a non-empty `expires`, one hour (the default) ahead of generation", async () => {
    const before = Date.now();
    const { encoded } = await generateInvitation({
      inviterName: "County Health Dept",
      file: csvStream(),
      location,
    });
    const after = Date.now();

    // The generation instant lies in [before, after], so the default-lifetime
    // expiry lies in that window shifted forward by one hour.
    const expiresMs = await expiresMsOf(encoded);
    const lifetimeMs = INVITATION_LIFETIME_SECONDS * 1000;
    expect(expiresMs).toBeGreaterThanOrEqual(before + lifetimeMs);
    expect(expiresMs).toBeLessThanOrEqual(after + lifetimeMs);
  });

  test("an explicit lifetimeSeconds sets `expires` to that many seconds ahead", async () => {
    const lifetimeSeconds = 30 * 60;
    const before = Date.now();
    const { encoded } = await generateInvitation({
      inviterName: "County Health Dept",
      file: csvStream(),
      location,
      lifetimeSeconds,
    });
    const after = Date.now();

    const expiresMs = await expiresMsOf(encoded);
    const lifetimeMs = lifetimeSeconds * 1000;
    expect(expiresMs).toBeGreaterThanOrEqual(before + lifetimeMs);
    expect(expiresMs).toBeLessThanOrEqual(after + lifetimeMs);
  });

  test("rejects a non-positive (or non-finite) lifetimeSeconds at entry, before encoding", async () => {
    // Caught here with a clear cause rather than at encodeInvitation's
    // future-expiry backstop. The lifetime bound is checked before the file is
    // parsed, so a fresh valid stream is supplied but never consumed.
    for (const lifetimeSeconds of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      await expect(
        generateInvitation({
          inviterName: "County Health Dept",
          file: csvStream(),
          location,
          lifetimeSeconds,
        }),
      ).rejects.toThrow(/positive number of seconds/i);
    }
  });

  test("rejects a lifetimeSeconds past the one-year ceiling, before encoding", async () => {
    // The seam must not be able to mint an effectively-permanent token, so a
    // value past the ceiling is rejected up front with the bound's own cause.
    await expect(
      generateInvitation({
        inviterName: "County Health Dept",
        file: csvStream(),
        location,
        lifetimeSeconds: MAX_INVITATION_LIFETIME_SECONDS + 1,
      }),
    ).rejects.toThrow(/must not exceed/i);
  });

  test("accepts a lifetimeSeconds exactly at the ceiling", async () => {
    // The bound is inclusive: one year to the second is allowed.
    const before = Date.now();
    const { encoded } = await generateInvitation({
      inviterName: "County Health Dept",
      file: csvStream(),
      location,
      lifetimeSeconds: MAX_INVITATION_LIFETIME_SECONDS,
    });
    const after = Date.now();

    const expiresMs = await expiresMsOf(encoded);
    const lifetimeMs = MAX_INVITATION_LIFETIME_SECONDS * 1000;
    expect(expiresMs).toBeGreaterThanOrEqual(before + lifetimeMs);
    expect(expiresMs).toBeLessThanOrEqual(after + lifetimeMs);
  });

  test("the minted token is honored by the acceptor before expiry and rejected at it", async () => {
    // The two sides must agree on the same `expires` semantics: the inviter sets
    // the bound here, and prepareAcceptedInvitation (the acceptor) enforces it.
    // Read the actual minted expiry rather than recompute it, since the generator
    // measures from its own clock.
    const { encoded } = await generateInvitation({
      inviterName: "County Health Dept",
      file: csvStream(),
      location,
    });
    const expiresAt = new Date(await expiresMsOf(encoded));

    // A second before expiry: the acceptor proceeds to the WebRTC endpoint.
    await expect(
      prepareAcceptedInvitation(encoded, {
        now: new Date(expiresAt.getTime() - 1000),
        profile: "hosted",
      }),
    ).resolves.toMatchObject({ endpoint: { channel: "webrtc" } });

    // At the expiry instant: the acceptor fails closed (its `<=` boundary), so a
    // token accepted at or after `expires` is rejected.
    await expect(
      prepareAcceptedInvitation(encoded, { now: expiresAt, profile: "hosted" }),
    ).rejects.toThrow(/expired/i);
  });
});

describe("webrtcEndpointFromLocation", () => {
  test("normalizes localhost to a loopback literal a peer can dial", () => {
    expect(
      webrtcEndpointFromLocation({ hostname: "localhost", port: "3000" }),
    ).toStrictEqual({
      channel: "webrtc",
      host: "127.0.0.1",
      port: 3000,
      path: "/api/",
    });
  });

  test("omits the port for a default-port (empty) location", () => {
    expect(
      webrtcEndpointFromLocation({ hostname: "example.org", port: "" }),
    ).toStrictEqual({ channel: "webrtc", host: "example.org", path: "/api/" });
  });

  test("drops an out-of-range port rather than encoding a meaningless locator", () => {
    // Port 0 is the OS "assign an ephemeral port" sentinel, never a connect
    // target; the endpoint schema rejects it, so it is not encoded.
    expect(
      webrtcEndpointFromLocation({ hostname: "example.org", port: "0" }),
    ).toStrictEqual({ channel: "webrtc", host: "example.org", path: "/api/" });
  });

  test("drops a non-numeric port rather than truncating it", () => {
    // Number() yields NaN for "8080abc" (parseInt would truncate to 8080), so a
    // malformed port is omitted, not silently encoded as a wrong locator.
    expect(
      webrtcEndpointFromLocation({ hostname: "example.org", port: "8080abc" }),
    ).toStrictEqual({ channel: "webrtc", host: "example.org", path: "/api/" });
  });
});

describe("deepLinkFor", () => {
  test("places the token in the fragment of the /accept route", () => {
    expect(deepLinkFor("https://example.org", "TOKEN123")).toBe(
      "https://example.org/accept#TOKEN123",
    );
    expect(ACCEPT_ROUTE_PATH).toBe("/accept");
  });
});
