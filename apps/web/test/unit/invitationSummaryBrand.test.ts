import { describe, expect, test } from "vitest";

import { sanitizeForDisplay } from "@psilink/core";

import { summarizeInvitation } from "@psi/invitationSummary";

import {
  BEL,
  ESC,
  PRINTABLE_ASCII,
  RLO,
  hostileSource,
  hostileTerms,
} from "../utils/displayEscapingFixtures";

import type {
  InvitationLegalAgreementSummary,
  InvitationSummary,
} from "@psi/invitationSummary";

/**
 * The one position the walk below skips: a linkage key's `id` carries the raw
 * partner key name verbatim, as the stable identity per-key UI state is keyed
 * by, and reaches no rendered text or attribute -- that claim is checked at the
 * render boundary (test/browser/invitationTerms.test.ts), not asserted here.
 * Matched by PATH rather than by key name, so a future `id` anywhere else in the
 * summary is checked rather than silently exempted too.
 */
const RAW_KEY_IDENTITY = /^linkageKeys\[\d+\]\.id$/;

/**
 * Every string reachable in `value`, paired with the path it sits at. Property
 * names are visited alongside their values, so a summary field that is a record
 * keyed by partner text is covered as well.
 *
 * Recursive rather than a per-field enumeration: a field added to the summary is
 * checked without being listed anywhere, which is the whole point -- an
 * enumeration only ever covers what someone remembered to add to it.
 */
function displayStrings(
  value: unknown,
  path = "",
): Array<{ path: string; value: string }> {
  if (typeof value === "string")
    return RAW_KEY_IDENTITY.test(path) ? [] : [{ path, value }];
  if (Array.isArray(value))
    return value.flatMap((entry, index) =>
      displayStrings(entry, `${path}[${index}]`),
    );
  if (typeof value === "object" && value !== null)
    return Object.entries(value).flatMap(([key, entry]) => {
      const keyPath = path === "" ? key : `${path}.${key}`;
      return [
        { path: `${keyPath} (property name)`, value: key },
        ...displayStrings(entry, keyPath),
      ];
    });
  return [];
}

describe("the display-struct brand", () => {
  test("rejects an un-sanitized string in a display struct", () => {
    const raw: string = hostileTerms.identity;
    const agreement: InvitationLegalAgreementSummary = {
      // @ts-expect-error -- a field filled without the sanitize call
      reference: raw,
      purpose: sanitizeForDisplay(raw),
      expirationDate: sanitizeForDisplay("2027-12-31"),
    };
    expect(agreement.reference).toBe(raw);
  });

  test("rejects an un-sanitized string in each display struct that carries partner text", () => {
    const raw: string = hostileTerms.identity;
    // @ts-expect-error -- the inviter's self-asserted identity
    const invitingParty: InvitationSummary["invitingParty"] = raw;
    // @ts-expect-error -- a linkage key's partner-authored name
    const keyName: InvitationSummary["linkageKeys"][number]["name"] = raw;
    // @ts-expect-error -- a transform's partner-declared function name
    const transformFunction: InvitationSummary["linkageKeys"][number]["elements"][number]["transforms"][number]["function"] =
      raw;
    // @ts-expect-error -- a partner-authored allowed-character class
    const allowedCharacters: InvitationSummary["linkageFields"][number]["allowedCharacters"] =
      raw;
    // @ts-expect-error -- a declared payload column name
    const payloadColumn: NonNullable<
      InvitationSummary["payload"]
    >["send"][number] = raw;
    expect([
      invitingParty,
      keyName,
      transformFunction,
      allowedCharacters,
      payloadColumn,
    ]).toEqual([raw, raw, raw, raw, raw]);
  });

  test("accepts a sanitizeForDisplay return value", () => {
    const sanitized = sanitizeForDisplay(hostileTerms.identity);
    const invitingParty: InvitationSummary["invitingParty"] = sanitized;
    const agreement: InvitationLegalAgreementSummary = {
      reference: sanitized,
      purpose: sanitized,
      expirationDate: sanitized,
    };
    expect(invitingParty).toBe(agreement.reference);
  });

  test("escapes every string in the summary a partner-controlled value reaches", () => {
    const visited = displayStrings(summarizeInvitation(hostileSource));

    // Guard against a vacuous pass, without an enumeration to maintain: the walk
    // must have reached the nested structs, and must have found each of the
    // fixture's hostile code points in the escaped form sanitizeForDisplay
    // produces -- so a summary that collapsed, or one built from a fixture whose
    // partner text never flowed through, fails here rather than satisfying the
    // assertion below by having nothing to check.
    expect(visited.length).toBeGreaterThan(20);
    for (const hostile of [ESC, RLO, BEL]) {
      const escaped = sanitizeForDisplay(hostile);
      expect(
        visited.filter((visit) => visit.value.includes(escaped)).length,
      ).toBeGreaterThan(0);
    }

    // Every string in the whole summary, at whatever depth and whether its field
    // is declared Displayable or plain `string`: a field added to the summary and
    // filled from partner text is caught here with nothing to add to a list.
    expect(
      visited.filter((visit) => !PRINTABLE_ASCII.test(visit.value)),
    ).toEqual([]);
  });

  test("stays a plain string at the renderer, needing no cast or unwrapping", () => {
    const summary = summarizeInvitation(hostileSource);
    // The shapes a renderer uses: JSX text children, joins, interpolation, and
    // handing a field to something typed `string`.
    const children: Array<string> = [summary.invitingParty];
    const joined: string = summary.matchedFields.join(", ");
    const heading = `Proposed by ${summary.invitingParty}`;
    const measured: number = summary.invitingParty.length;
    expect(children[0]).toBe(summary.invitingParty);
    expect(joined).toContain("last name");
    expect(heading.startsWith("Proposed by Acme")).toBe(true);
    expect(measured).toBe(summary.invitingParty.length);
  });
});
