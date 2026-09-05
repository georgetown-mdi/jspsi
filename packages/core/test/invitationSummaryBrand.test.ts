import { describe, expect, test } from "vitest";

import {
  BEL,
  ESC,
  HOSTILE_IDENTITY,
  PRINTABLE_ASCII,
  RLO,
  hostileSource,
  hostileVariants,
} from "../src/consent/displayEscapingFixtures.js";
import { summarizeInvitation } from "../src/consent/invitationSummary.js";
import { sanitizeForDisplay } from "../src/utils/sanitizeForDisplay.js";
import { declaredPositions } from "./utils/declaredPositions.js";

import type {
  InvitationLegalAgreementSummary,
  InvitationSummary,
} from "../src/consent/invitationSummary.js";

/**
 * A linkage key's `id` holds the raw partner key name verbatim: it is the
 * stable identity per-key UI state is keyed by, and reaches no rendered text
 * or attribute. That claim is checked at each render boundary -- the web
 * app's browser consent-screen suite and the CLI's accept-prompt escaping
 * test -- not here. Matched by path, not key name, so a future `id` anywhere
 * else in the summary is still checked, not silently exempted.
 */
const RAW_KEY_IDENTITY = /^linkageKeys\[\d+\]\.id$/;

/**
 * Every string reachable in `value`, paired with the path it sits at.
 * Property names are visited alongside their values, so a summary field that
 * is a record keyed by partner text is covered too.
 *
 * Recursive, not a per-field enumeration, so a field added to the summary is
 * covered without being listed anywhere.
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

/**
 * A bound on the compiler-API walk the coverage test below runs, sized as a
 * safety check for a derivation that never returns, not as an assertion
 * about how fast a loaded machine can build a program: the walk creates a
 * whole `ts.Program` over the summary source, which costs seconds on an idle
 * container and several times that when the rest of the suite is competing
 * for the same cores.
 */
const TYPE_WALK_HANG_BACKSTOP_MS = 60_000;

/**
 * Every position a built summary actually holds a value at, normalized the way
 * {@link declaredPositions} normalizes a declared one. Presence is read from the
 * VALUE, not the key: the builder returns object literals that hold an absent
 * optional field as an explicit `undefined`, which occupies no position.
 */
function presentPositions(
  value: unknown,
  prefix = "",
  found: Set<string> = new Set(),
): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) presentPositions(entry, `${prefix}[]`, found);
    return found;
  }
  if (typeof value === "object" && value !== null)
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      const position = prefix === "" ? key : `${prefix}.${key}`;
      found.add(position);
      presentPositions(entry, position, found);
    }
  return found;
}

describe("the display-struct brand", () => {
  test("rejects an un-sanitized string in a display struct", () => {
    const raw: string = HOSTILE_IDENTITY;
    const agreement: InvitationLegalAgreementSummary = {
      // @ts-expect-error -- a field filled without the sanitize call
      reference: raw,
      purpose: sanitizeForDisplay(raw),
      expirationDate: sanitizeForDisplay("2027-12-31"),
    };
    expect(agreement.reference).toBe(raw);
  });

  test("rejects an un-sanitized string in each display struct that holds partner text", () => {
    const raw: string = HOSTILE_IDENTITY;
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
    const sanitized = sanitizeForDisplay(HOSTILE_IDENTITY);
    const invitingParty: InvitationSummary["invitingParty"] = sanitized;
    const agreement: InvitationLegalAgreementSummary = {
      reference: sanitized,
      purpose: sanitized,
      expirationDate: sanitized,
    };
    expect(invitingParty).toBe(agreement.reference);
  });

  test.each(hostileVariants)(
    "escapes every string in the summary a partner-controlled value reaches ($name)",
    ({ source }) => {
      const visited = displayStrings(summarizeInvitation(source));

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
    },
  );

  test(
    "reaches every optional position the summary declares",
    { timeout: TYPE_WALK_HANG_BACKSTOP_MS },
    () => {
      // An optional field added to a summary struct joins `declared.optional`
      // with no edit here, and fails below until a fixture populates it.
      const declared = declaredPositions({
        sourcePathFromCoreRoot: "src/consent/invitationSummary.ts",
        rootInterface: "InvitationSummary",
        stringIntersectionEndsPath: true,
      });
      const reached = new Set<string>();
      for (const variant of hostileVariants)
        for (const position of presentPositions(
          summarizeInvitation(variant.source),
        ))
          reached.add(position);

      // What makes the escaping walk above non-vacuous per position rather than
      // only in aggregate: an optional position no fixture populates holds nothing
      // for that walk to inspect, so it is named here instead of passing silently.
      expect(
        [...declared.optional]
          .filter((position) => !reached.has(position))
          .sort(),
      ).toEqual([]);

      // And the derivation cannot quietly stop short and shrink what the line above
      // demands: a position the fixtures reach but the type walk never named means
      // it failed to descend somewhere a value does.
      expect(
        [...reached].filter((position) => !declared.all.has(position)).sort(),
      ).toEqual([]);
    },
  );

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
