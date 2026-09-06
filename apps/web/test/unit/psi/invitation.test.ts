import { Readable } from "node:stream";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  FAN_OUT_FUNCTION_NAMES,
  INVITATION_LIFETIME_SECONDS,
  MAX_INVITATION_LIFETIME_SECONDS,
  MAX_NAME_LENGTH,
  assertPayloadSendDisclosed,
  decodeInvitation,
  disclosedColumnNames,
  getDefaultLinkageTerms,
  inferMetadata,
  summarizeInvitation,
  validateCompatibility,
} from "@psilink/core";
import { MAX_RAW_INVITATION_LENGTH } from "@psilink/core/testing";

import {
  ACCEPT_ROUTE_PATH,
  InvitationFileError,
  deepLinkFor,
  generateInvitation,
  tokenFromInput,
  webrtcEndpointFromLocation,
} from "../../../src/psi/invitation.js";
import { prepareAcceptedInvitation } from "../../../src/psi/acceptInvitation.js";

import type { InvitationLocation } from "../../../src/psi/invitation.js";

const location: InvitationLocation = {
  origin: "https://example.org:8443",
  hostname: "example.org",
  port: "8443",
};

// A CSV containing every default linkage column, so the file-derived terms keep all
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

/** The two split inbound/outbound rendezvous shapes, whose own shape puts every
 * connection built from them in retain mode whatever the caller's flag says. */
const SPLIT_FILEDROP_ENDPOINT = {
  channel: "filedrop",
  inboundPath: "/mnt/share/in",
  outboundPath: "/mnt/share/out",
} as const;
const SPLIT_SFTP_ENDPOINT = {
  channel: "sftp",
  host: "sftp.example.org",
  inboundPath: "/exchanges/in",
  outboundPath: "/exchanges/out",
} as const;

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
    // The file contains every default column, so the file-derived terms equal the
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
    // No credential rides along: the endpoint contains only the public locator
    // keys (the type admits no credential field; the strict schema rejects one).
    const serialized = JSON.stringify(token.connectionEndpoint);
    expect(serialized).not.toContain("username");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("private_key");
  });

  test("declares retain mode on the token when the exchange runs it", async () => {
    // The console mints the file-sync invitations, so it is where the partner's
    // consent display gets told the exchange leaves a permanent transcript.
    const { encoded } = await generateInvitation({
      inviterName: "County Health Dept",
      file: csvStream(),
      location,
      connectionEndpoint: { channel: "filedrop", path: "/mnt/share/drop" },
      retainsFiles: true,
    });
    const token = await decodeInvitation(encoded);
    expect(token.inviterRetainsFiles).toBe(true);
  });

  test.each([
    { label: "delete mode", params: { retainsFiles: false } },
    { label: "an unstated mode", params: {} },
  ])("declares nothing for $label", async ({ params }) => {
    // Neither is a claim that the exchange cleans up after itself, so neither
    // reaches the token: an absent field states nothing, which is the accurate
    // answer for a webrtc mint (a channel with no retain mode) as well.
    const { encoded } = await generateInvitation({
      inviterName: "County Health Dept",
      file: csvStream(),
      location,
      connectionEndpoint: { channel: "filedrop", path: "/mnt/share/drop" },
      ...params,
    });
    const token = await decodeInvitation(encoded);
    expect(token.inviterRetainsFiles).toBeUndefined();
  });

  test.each([
    {
      label: "a split filedrop endpoint",
      endpoint: SPLIT_FILEDROP_ENDPOINT,
      declaration: true,
    },
    {
      label: "a split sftp endpoint",
      endpoint: SPLIT_SFTP_ENDPOINT,
      declaration: true,
    },
    {
      label: "a shared-directory filedrop endpoint",
      endpoint: { channel: "filedrop", path: "/mnt/share/drop" },
      declaration: undefined,
    },
    {
      label: "a webrtc endpoint",
      endpoint: { channel: "webrtc" },
      declaration: undefined,
    },
  ] as const)(
    "derives the declaration from $label minted with the flag omitted",
    async ({ endpoint, declaration }) => {
      // The split pair puts every connection built from it in retain mode, so
      // the mint states the retention a caller left out rather than refusing
      // the token. The other two shapes have no retention to derive from, so an
      // omitted flag still declares nothing.
      const { encoded } = await generateInvitation({
        inviterName: "County Health Dept",
        file: csvStream(),
        location,
        connectionEndpoint: endpoint,
      });
      const token = await decodeInvitation(encoded);
      expect(token.inviterRetainsFiles).toBe(declaration);
    },
  );

  test.each([
    { label: "filedrop", endpoint: SPLIT_FILEDROP_ENDPOINT },
    { label: "sftp", endpoint: SPLIT_SFTP_ENDPOINT },
  ] as const)(
    "declares retention for a split $label endpoint minted with the flag false",
    async ({ endpoint }) => {
      // The shape wins over the flag: a caller stating delete mode beside a
      // rendezvous no run of it can be in delete mode for still mints the
      // declaration, rather than the token stating a mode the endpoint
      // contradicts.
      const { encoded } = await generateInvitation({
        inviterName: "County Health Dept",
        file: csvStream(),
        location,
        connectionEndpoint: endpoint,
        retainsFiles: false,
      });
      const token = await decodeInvitation(encoded);
      expect(token.inviterRetainsFiles).toBe(true);
    },
  );

  test("refuses a retain declaration on the default webrtc mint", async () => {
    // The schema's guard, reached through generateInvitation: retain mode is a
    // file-sync setting the webrtc channel does not have, so a caller passing
    // the pair is refused rather than minting a token stating a mode no run
    // could be in.
    await expect(
      generateInvitation({
        inviterName: "County Health Dept",
        file: csvStream(),
        location,
        retainsFiles: true,
      }),
    ).rejects.toThrow(/not valid for a webrtc/);
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
      inferMetadata(["ssn", "first_name", "last_name", "dob"], []),
    );
    const token = await decodeInvitation(result.encoded);
    expect(token.linkageTerms).toStrictEqual(expected);
    // It is filtered, not the full default set: fewer keys, and none of
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

    // The returned terms object IS the embedded one, exposed for the inviter's
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
    const metadata = inferMetadata(
      ["ssn", "first_name", "last_name", "dob"],
      [],
    ).map((c) =>
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
    // The acceptor adopts the invitation's terms, so an embedded set diverging from
    // what the inviter runs would make the terms-compat handshake reject. The
    // inviter both embeds and runs THESE terms, and the acceptor adopts them (its
    // own identity substituted), so the two sides have an identical key set.
    const { linkageTerms } = await generateInvitation({
      inviterName: "Inviter",
      file: csvStream(PARTIAL_CSV),
      location,
    });
    const acceptorAdopted = { ...linkageTerms, identity: "Acceptor" };
    expect(validateCompatibility(linkageTerms, acceptorAdopted).errors).toEqual(
      [],
    );

    // Contrast: had the invitation embedded the UNFILTERED defaults while the
    // inviter ran the file-filtered set, the key sets would differ and the
    // handshake would reject.
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
      inferMetadata(["ssn", "ssn4", "first_name", "last_name", "dob"], []),
    );
    const authored = { ...base, linkageKeys: base.linkageKeys.slice(0, 1) };

    const { encoded, linkageTerms } = await generateInvitation({
      inviterName: "ignored-name",
      file: csvStream(ALL_COLUMNS_CSV),
      location,
      linkageTerms: authored,
    });

    const token = await decodeInvitation(encoded);
    expect(token.linkageTerms).toStrictEqual(authored);
    // The returned object is the embedded one, for the inviter's own exchange.
    expect(linkageTerms).toStrictEqual(authored);
    // The default derivation is skipped: the file contains every default column,
    // so the quick path would have embedded the full multi-key set.
    expect(token.linkageTerms.linkageKeys).toHaveLength(1);
    expect(token.linkageTerms.linkageKeys.length).toBeLessThan(
      getDefaultLinkageTerms(
        "ignored-name",
        inferMetadata(["ssn", "ssn4", "first_name", "last_name", "dob"], []),
      ).linkageKeys.length,
    );
    // inviterName is not consulted for the identity when terms are authored.
    expect(token.linkageTerms.identity).toBe("Authored Org");
  });

  test("fails closed when authored terms no column can satisfy reach the mint", async () => {
    // A defense-in-depth safety check on the mint boundary: even if the
    // editor's gate were bypassed, authored terms whose every key references a
    // field the file cannot produce must not mint a token (it would run to a
    // silent empty result). The only key needs ssn4; PARTIAL_CSV has no ssn4
    // column.
    const base = getDefaultLinkageTerms(
      "Org",
      inferMetadata(["ssn", "ssn4", "first_name", "last_name", "dob"], []),
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

  test("fails closed when the file covers only SOME of the authored keys", async () => {
    // The mint is held to the rule the inviter's own run is: every declared key.
    // Minting here would seal a token the partner accepts and the inviter's own run
    // then refuses -- discovered after the accept, when the terms are already
    // settled. The full default set needs ssn4; PARTIAL_CSV covers everything else.
    const full = getDefaultLinkageTerms(
      "Org",
      inferMetadata(["ssn", "ssn4", "first_name", "last_name", "dob"], []),
    );
    const error = await generateInvitation({
      inviterName: "Org",
      file: csvStream(PARTIAL_CSV),
      location,
      linkageTerms: full,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InvitationFileError);
    const failure = (error as InvitationFileError).failure;
    expect(failure.kind).toBe("unlinkable");
    if (failure.kind !== "unlinkable") throw new Error("unreachable");
    expect(failure.refusal.kind).toBe("shortfall");
    if (failure.refusal.kind !== "shortfall") throw new Error("unreachable");
    // The base message is the log line for every "unlinkable" refusal, so it must
    // hold for a file that satisfies some keys, not only one that satisfies none.
    expect((error as InvitationFileError).message).toBe(
      "invitation file cannot satisfy the linkage terms",
    );
    // Some keys ARE producible, which is exactly what a per-key threshold would
    // have passed on.
    expect(failure.refusal.verdict.unsatisfiableKeys.length).toBeGreaterThan(0);
    expect(
      failure.refusal.verdict.keys.length -
        failure.refusal.verdict.unsatisfiableKeys.length,
    ).toBeGreaterThan(0);
  });

  test("fails closed on an authored key whose cleaning drops every record", async () => {
    // Shape-satisfiable and still dead: the columns are all present, but the
    // declared parse_date can never yield a value, so the key contributes nothing.
    // Its remedy is a correction to the terms, not a different file, and the mint
    // says so before a partner has accepted anything.
    const base = getDefaultLinkageTerms(
      "Org",
      inferMetadata(["first_name", "last_name", "dob"], []),
    );
    const deadTerms = {
      ...base,
      linkageFields: [{ name: "dob", type: "date_of_birth" as const }],
      linkageKeys: [
        {
          name: "dob-only",
          elements: [
            {
              field: "dob",
              transform: [
                { function: "parse_date", params: { inputFormat: "MM/DD" } },
              ],
            },
          ],
        },
      ],
    };
    const error = await generateInvitation({
      inviterName: "Org",
      file: csvStream("first_name,last_name,dob\nAlice,Smith,1990-01-02\n"),
      location,
      linkageTerms: deadTerms,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InvitationFileError);
    const failure = (error as InvitationFileError).failure;
    expect(failure.kind).toBe("unlinkable");
    if (failure.kind !== "unlinkable") throw new Error("unreachable");
    expect(failure.refusal.kind).toBe("shortfall");
    if (failure.refusal.kind !== "shortfall") throw new Error("unreachable");
    expect(failure.refusal.verdict.deadKeys.map((key) => key.name)).toEqual([
      "dob-only",
    ]);
  });

  test("fails closed on an authored key whose substring window reads nothing", async () => {
    // The other value-independent drop, and the one an operator reaches by
    // clearing a bound mid-edit: the declared window opens at no value length, so
    // the key nulls every row -- for the partner as much as for this file, since
    // the terms are hashed into the agreement the acceptor cannot edit. The mint
    // is the last point either party holds a control over it.
    const base = getDefaultLinkageTerms(
      "Org",
      inferMetadata(["first_name", "last_name", "dob"], []),
    );
    const keyedOnWindow = (params: Record<string, unknown>) => ({
      ...base,
      linkageFields: [{ name: "first_name", type: "first_name" as const }],
      linkageKeys: [
        {
          name: "fn-only",
          elements: [
            {
              field: "first_name",
              transform: [{ function: "substring", params }],
            },
          ],
        },
      ],
    });
    const inviterFile = () =>
      csvStream("first_name,last_name,dob\nAlice,Smith,1990-01-02\n");

    // The assumption the refusal is measured against: with a window that opens,
    // these terms and this file mint, so what closes the mint below is the
    // window and not the fixture.
    await expect(
      generateInvitation({
        inviterName: "Org",
        file: inviterFile(),
        location,
        linkageTerms: keyedOnWindow({ start: 1, length: 3 }),
      }),
    ).resolves.toBeDefined();

    const error = await generateInvitation({
      inviterName: "Org",
      file: inviterFile(),
      location,
      linkageTerms: keyedOnWindow({ length: 3 }),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InvitationFileError);
    const failure = (error as InvitationFileError).failure;
    expect(failure.kind).toBe("unlinkable");
    if (failure.kind !== "unlinkable") throw new Error("unreachable");
    expect(failure.refusal.kind).toBe("shortfall");
    if (failure.refusal.kind !== "shortfall") throw new Error("unreachable");
    // Dead rather than short of columns: the file contains what the key names, so
    // the remedy is a corrected transform, not a different file.
    expect(failure.refusal.verdict.deadKeys.map((key) => key.name)).toEqual([
      "fn-only",
    ]);
    expect(failure.refusal.verdict.unsatisfiableKeys).toHaveLength(0);
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
      sanitizedPositions: [],
    });
  });

  test("an unnamed column the strip produced reports its sanitized position", async () => {
    // The mint's own re-parse is a refusal seat too: a header made only of
    // text-direction characters strips to the empty name, and the failure carries
    // the sanitation positions so the alert states that cause rather than a
    // trailing comma.
    const STRIPPED_TO_EMPTY_CSV =
      "ssn,first_name,last_name,dob,\u202e\u2069\n" +
      "123456789,Alice,Smith,1990-01-02,x\n";
    const error = await generateInvitation({
      inviterName: "Org",
      file: csvStream(STRIPPED_TO_EMPTY_CSV),
      location,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvitationFileError);
    expect((error as InvitationFileError).failure).toEqual({
      kind: "unnameable",
      positions: [5],
      sanitizedPositions: [5],
    });
  });

  // A name at the ceiling is legitimate and must mint; one code unit past it
  // cannot be held -- the payload frame and the exchange record both refuse it.
  const AT_CEILING = "a".repeat(MAX_NAME_LENGTH);
  const PAST_CEILING = AT_CEILING + "a";

  /** A linkable CSV whose last column holds `name`, which the quick path infers
   * as an `other` column and therefore sends. */
  function csvSending(name: string): string {
    return (
      `ssn,first_name,last_name,dob,${name}\n` +
      "123456789,Alice,Smith,1990-01-02,vip\n"
    );
  }

  test("rejects a sent column name past the length ceiling as an overlong InvitationFileError", async () => {
    // The mint boundary is where an oversized header is caught: the quick path
    // infers metadata from the CSV, which no schema bounds, so without this the
    // name reaches PayloadColumnSchema's .max at encode as a raw ZodError the UI
    // flattens into its generic retry dead-end -- and the partner's parse would be
    // the first real enforcement, after the frame was sent.
    const error = await generateInvitation({
      inviterName: "Org",
      file: csvStream(csvSending(PAST_CEILING)),
      location,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvitationFileError);
    expect((error as InvitationFileError).failure).toEqual({
      kind: "overlong",
      positions: [5],
    });
  });

  test("mints a sent column name exactly at the length ceiling", async () => {
    const { encoded } = await generateInvitation({
      inviterName: "Org",
      file: csvStream(csvSending(AT_CEILING)),
      location,
    });
    const token = await decodeInvitation(encoded);
    expect(token.disclosedPayloadColumns).toEqual([AT_CEILING]);
  });

  test("counts the ceiling in UTF-16 code units, as the wire and record bounds do", async () => {
    // A name of MAX_NAME_LENGTH astral characters is under the ceiling on a
    // code-point count (the count ColumnName's display cut uses) and over it on
    // the count every wire-and-record bound uses. The mint refuses it, so
    // nothing this gate passes is refused later by the partner.
    const astral = "\u{1D54F}".repeat(MAX_NAME_LENGTH);
    expect([...astral].length).toBe(MAX_NAME_LENGTH);
    expect(astral.length).toBe(MAX_NAME_LENGTH * 2);
    const error = await generateInvitation({
      inviterName: "Org",
      file: csvStream(csvSending(astral)),
      location,
    }).catch((e: unknown) => e);
    expect((error as InvitationFileError).failure).toEqual({
      kind: "overlong",
      positions: [5],
    });
  });

  test("mints an over-long column name the metadata does not send", async () => {
    // The scope of the bound: an oversized header is fully usable for matching and
    // ignoring, so only a name that is actually disclosed refuses the mint.
    const metadata = inferMetadata(
      ["ssn", "first_name", "last_name", "dob", PAST_CEILING],
      [],
    ).map((column) =>
      column.name === PAST_CEILING
        ? { ...column, role: "ignored" as const, isPayload: false }
        : column,
    );
    const { encoded } = await generateInvitation({
      inviterName: "Org",
      file: csvStream(csvSending(PAST_CEILING)),
      location,
      linkageTerms: getDefaultLinkageTerms("Org", metadata),
      metadata,
    });
    const token = await decodeInvitation(encoded);
    expect(token.disclosedPayloadColumns).toEqual([]);
  });

  test("fails closed when authored terms over-declare payload.send at the mint", async () => {
    // Defense-in-depth safety check: the Advanced editor authors no payload
    // block today, so this can only be constructed by hand, to prove the mint
    // boundary rejects an over-declaring payload.send rather than letting the
    // token and the partner's consent screen hold a column the metadata gates
    // off. `ssn` is a linkage column (isPayload:false), so it is not disclosed
    // and may not be declared.
    const metadata = inferMetadata(
      ["ssn", "first_name", "last_name", "dob"],
      [],
    );
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

  // The mint-boundary fan-out safety check, over the default (cascade) terms,
  // which match one value per record and so refuse a fan-out. These hand-built
  // shapes stand in for a caller that reaches the mint without going through
  // the editor's Generate gate, so no invitation for an exchange core already
  // refuses ever reaches a partner. The function comes from core's own list,
  // so a fan-out function added there is covered here.
  const [fanOutFunction] = FAN_OUT_FUNCTION_NAMES;
  const fanOutStep = { function: fanOutFunction, params: { delimiter: "-" } };

  test("refuses to mint when a linkage-key element transform fans out", async () => {
    const metadata = inferMetadata(
      ["ssn", "first_name", "last_name", "dob"],
      [],
    );
    const base = getDefaultLinkageTerms("Org", metadata);
    const fanning = {
      ...base,
      linkageKeys: base.linkageKeys.map((key, i) =>
        i === 0
          ? {
              ...key,
              elements: key.elements.map((element, j) =>
                j === 0 ? { ...element, transform: [fanOutStep] } : element,
              ),
            }
          : key,
      ),
    };

    await expect(
      generateInvitation({
        inviterName: "Org",
        file: csvStream(PARTIAL_CSV),
        location,
        linkageTerms: fanning,
        metadata,
      }),
    ).rejects.toThrow(
      /fan-out matching runs under the single-pass linkage strategy only/,
    );
  });

  test("refuses to mint when the authored standardization fans out", async () => {
    const metadata = inferMetadata(
      ["ssn", "first_name", "last_name", "dob"],
      [],
    );
    await expect(
      generateInvitation({
        inviterName: "Org",
        file: csvStream(PARTIAL_CSV),
        location,
        linkageTerms: getDefaultLinkageTerms("Org", metadata),
        metadata,
        standardization: [
          { output: "last_name", input: "last_name", steps: [fanOutStep] },
        ],
      }),
    ).rejects.toThrow(
      /fan-out matching runs under the single-pass linkage strategy only/,
    );
  });

  // A linkable CSV (ssn + names + dob give satisfiable keys) that ALSO contains
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
    const disclosed = disclosedColumnNames(
      inferMetadata(DISCLOSING_COLUMNS, []),
    );
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
    // The returned terms (the inviter runs its own exchange on these) have the
    // same authored send.
    expect(linkageTerms.payload?.send?.map((c) => c.name)).toEqual(disclosed);
    // It cannot trip core's over-declaration reject: the send equals the disclosed
    // set core gates transmission on, asserted against the same inferred metadata
    // the inviter's exchange falls back to.
    expect(() =>
      assertPayloadSendDisclosed(
        token.linkageTerms.payload,
        inferMetadata(DISCLOSING_COLUMNS, []),
        token.linkageTerms.output,
      ),
    ).not.toThrow();

    // The partner's consent screen reads its payload entries from the token via
    // summarizeInvitation (the same boundary the Advanced path's authored send
    // flows through). Feed the quick-path token through it to pin that the disclosed
    // columns show up as payload entries the partner sees before consenting -- the
    // acceptance criterion that closes the quick-path declaration/consent gap. Plain
    // ASCII names pass through sanitizeForDisplay unchanged.
    const summary = summarizeInvitation(token);
    expect(summary.payload?.send).toEqual(disclosed);
    expect(summary.payload?.receive).toEqual([]);
  });

  test("quick path holds the disclosed-columns subset on the token", async () => {
    const disclosed = disclosedColumnNames(
      inferMetadata(DISCLOSING_COLUMNS, []),
    );
    const result = await generateInvitation({
      inviterName: "Org",
      file: csvStream(DISCLOSING_CSV),
      location,
    });
    const token = await decodeInvitation(result.encoded);
    // The dedicated wire field holds exactly what preparePayload transmits.
    expect(token.disclosedPayloadColumns).toEqual(disclosed);
    // The exposed field is the token's value, so a persisting caller (the
    // managed-exchange deposit) records the same commitment the token published.
    expect(result.disclosedPayloadColumns).toEqual(
      token.disclosedPayloadColumns,
    );
  });

  test("quick path holds an empty disclosed subset when the file discloses nothing", async () => {
    // The web inviter always knows its metadata, so the field is always present --
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

  test("quick path authors no payload when the file discloses no column", async () => {
    // ALL_COLUMNS_CSV is all linkage-typed columns: the inferred metadata discloses
    // nothing, so no (empty) payload block is authored.
    expect(
      disclosedColumnNames(
        inferMetadata(["ssn", "ssn4", "first_name", "last_name", "dob"], []),
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
    // token, exposed (not re-decoded) so the inviter threads it into the
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
    // it cannot produce, so the derivation narrows the built-in set all the way to
    // no key -- the refusal core's own verdict raises for terms declaring none.
    const err: unknown = await generateInvitation({
      inviterName: "County Health Dept",
      file: csvStream("notes\nhello\n"),
      location,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InvitationFileError);
    const failure = (err as InvitationFileError).failure;
    expect(failure.kind).toBe("unlinkable");
    if (failure.kind !== "unlinkable") throw new Error("unreachable");
    expect(failure.refusal.kind).toBe("no-linkable-key");
    if (failure.refusal.kind !== "no-linkable-key")
      throw new Error("unreachable");
    // It names the default field types the file lacks (assessed against the full
    // defaults, which the filtered embed terms no longer declare).
    const missingTypes = failure.refusal.missingFields.map((f) => f.type);
    expect(missingTypes).toContain("ssn");
    expect(missingTypes).toContain("first_name");
    expect(missingTypes).toContain("date_of_birth");
  });

  test("rejects a column-less file, not fooled by the empty-metadata all-keys fallback", async () => {
    // The subtle case the block must catch: with no columns, getDefaultLinkageTerms
    // falls back to ALL keys (its metadata is empty), so the embedded set declares
    // keys -- and none of them is producible, which core's verdict grades as a
    // shortfall rather than as terms declaring nothing. So an empty CSV is refused,
    // and every default field is named as unproducible.
    const err: unknown = await generateInvitation({
      inviterName: "County Health Dept",
      file: csvStream(""),
      location,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InvitationFileError);
    const failure = (err as InvitationFileError).failure;
    expect(failure.kind).toBe("unlinkable");
    if (failure.kind !== "unlinkable") throw new Error("unreachable");
    expect(failure.refusal.kind).toBe("shortfall");
    if (failure.refusal.kind !== "shortfall") throw new Error("unreachable");
    expect(
      failure.refusal.verdict.unsatisfiedFields.map((f) => f.type),
    ).toEqual(
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
    // future-expiry safety check. The lifetime bound is checked before the
    // file is parsed, so a fresh valid stream is supplied but never consumed.
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
    // generateInvitation must not be able to mint an effectively-permanent
    // token, so a value past the ceiling is rejected up front with the bound's
    // own cause.
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

describe("tokenFromInput", () => {
  test("joins a bare code a mail client hard-wrapped", () => {
    expect(tokenFromInput("  TOKEN\n123  4\r\n56  ")).toBe("TOKEN123456");
  });

  test("joins a deep link whose fragment was wrapped", () => {
    expect(tokenFromInput("https://example.org/accept#TOKEN\n  123\t456")).toBe(
      "TOKEN123456",
    );
  });

  test("a whitespace-only paste is no token at all", () => {
    expect(tokenFromInput("  \n\t ")).toBe("");
  });

  test("an over-bound paste does not throw and still returns a string", () => {
    const oversized = "a".repeat(MAX_RAW_INVITATION_LENGTH + 1);
    expect(() => tokenFromInput(oversized)).not.toThrow();
    expect(typeof tokenFromInput(oversized)).toBe("string");
  });

  test("a wrapped paste of a real invitation still decodes", async () => {
    const { encoded, sharedSecret } = await generateInvitation({
      inviterName: "County Health Dept",
      file: csvStream(),
      location,
    });
    const wrapped = `${encoded.slice(0, 25)}\n  ${encoded.slice(25)}`;
    const decoded = await decodeInvitation(tokenFromInput(wrapped));
    expect(decoded.sharedSecret).toBe(sharedSecret);
  });

  test("an NBSP-wrapped, hard-wrapped paste decodes to the same token", async () => {
    // The same construction the CLI argv and @-file tests drive through
    // decodeAndValidateInvitation: leading/trailing U+00A0, an interior
    // U+2028, and a hard wrap.
    const { encoded, sharedSecret } = await generateInvitation({
      inviterName: "County Health Dept",
      file: csvStream(),
      location,
    });
    const wrapped =
      `\u00a0${encoded.slice(0, 30)}\n  ${encoded.slice(30, 60)}` +
      `\u2028${encoded.slice(60)}\u00a0`;
    const decoded = await decodeInvitation(tokenFromInput(wrapped));
    expect(decoded.sharedSecret).toBe(sharedSecret);
  });
});
