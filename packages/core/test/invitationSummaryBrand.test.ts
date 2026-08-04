import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import ts from "typescript";

import {
  BEL,
  ESC,
  PRINTABLE_ASCII,
  RLO,
  hostileSource,
  hostileTerms,
  hostileVariants,
} from "../src/displayEscapingFixtures.js";
import { summarizeInvitation } from "../src/invitationSummary.js";
import { sanitizeForDisplay } from "../src/utils/sanitizeForDisplay.js";

import type {
  InvitationLegalAgreementSummary,
  InvitationSummary,
} from "../src/invitationSummary.js";

/**
 * The one position the walk below skips: a linkage key's `id` carries the raw
 * partner key name verbatim, as the stable identity per-key UI state is keyed
 * by, and reaches no rendered text or attribute -- that claim is checked at each
 * render boundary (the web app's browser consent-screen suite and the CLI's
 * accept-prompt escaping test), not asserted here.
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

/** Absolute path of a repository file named relative to this test. */
function repoPath(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}

const SUMMARY_SOURCE = repoPath("../src/invitationSummary.ts");
const SUMMARY_ROOT = "InvitationSummary";
const CORE_ROOT = repoPath("../");

/**
 * Type flags carrying no properties of their own, so a position of that type is
 * where a path ends. `VoidLike` covers the `undefined` an optional property's
 * union carries.
 */
const STRUCTURELESS_TYPE =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.VoidLike |
  ts.TypeFlags.Null |
  ts.TypeFlags.Never |
  ts.TypeFlags.Any |
  ts.TypeFlags.Unknown;

/**
 * Whether a path ends at this type. A `Displayable` is `string` intersected with
 * a phantom brand property, so an intersection carrying a string constituent ends
 * a path like a bare string does -- descending into the brand would invent a
 * position no value ever holds.
 */
function endsPath(type: ts.Type): boolean {
  if ((type.flags & STRUCTURELESS_TYPE) !== 0) return true;
  return (
    type.isIntersection() &&
    type.types.some((member) => (member.flags & ts.TypeFlags.StringLike) !== 0)
  );
}

/**
 * Every property path {@link InvitationSummary} and the summary structs nested
 * under it declare, read from those declarations with the compiler API at test
 * time and normalized the way {@link presentPositions} normalizes an observed
 * one: array and tuple indices collapse to `[]`, so a path reads
 * `linkageKeys[].elements[].transforms[].effect`. `optional` is the subset
 * declared `?` -- the positions that hold nothing unless a fixture reaches them,
 * and so the ones the escaping walk says nothing about until one does.
 *
 * Derived rather than listed here for the same reason the walk is recursive: an
 * optional field added to a summary struct joins this set with no edit to this
 * file, and fails the coverage check until a fixture populates it. A list would
 * only ever cover what someone remembered to add to it.
 */
function declaredSummaryPositions(): {
  all: Set<string>;
  optional: Set<string>;
} {
  const configPath = repoPath("../tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error !== undefined)
    throw new Error(`cannot read ${configPath} for the summary derivation`);
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    CORE_ROOT,
  );
  const program = ts.createProgram({
    rootNames: [SUMMARY_SOURCE],
    options: { ...parsed.options, noEmit: true },
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(SUMMARY_SOURCE);
  if (source === undefined)
    throw new Error(`${SUMMARY_SOURCE} is not in the program`);
  const root = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === SUMMARY_ROOT,
  );
  if (root === undefined)
    throw new Error(`${SUMMARY_ROOT} is not declared in ${SUMMARY_SOURCE}`);

  const all = new Set<string>();
  const optional = new Set<string>();

  // `enclosing` is the chain of struct types the current path runs through, so a
  // summary struct that ever nests itself terminates instead of descending
  // forever; every other repetition is a distinct path and is walked.
  const collect = (
    type: ts.Type,
    prefix: string,
    enclosing: ReadonlySet<ts.Type>,
  ): void => {
    for (const property of type.getProperties()) {
      const declaration =
        property.valueDeclaration ?? property.declarations?.[0];
      if (declaration === undefined)
        throw new Error(`no declaration for ${prefix}.${property.name}`);
      const position =
        prefix === "" ? property.name : `${prefix}.${property.name}`;
      all.add(position);
      if ((property.flags & ts.SymbolFlags.Optional) !== 0)
        optional.add(position);
      descend(
        checker.getTypeOfSymbolAtLocation(property, declaration),
        position,
        enclosing,
      );
    }
  };

  const descend = (
    type: ts.Type,
    position: string,
    enclosing: ReadonlySet<ts.Type>,
  ): void => {
    if (endsPath(type) || enclosing.has(type)) return;
    if (type.isUnion()) {
      for (const member of type.types) descend(member, position, enclosing);
      return;
    }
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      for (const element of checker.getTypeArguments(type as ts.TypeReference))
        descend(element, `${position}[]`, enclosing);
      return;
    }
    if (type.isIntersection()) {
      for (const member of type.types) descend(member, position, enclosing);
      return;
    }
    collect(type, position, new Set(enclosing).add(type));
  };

  descend(checker.getTypeAtLocation(root.name), "", new Set());
  return { all, optional };
}

/**
 * Every position a built summary actually holds a value at, normalized the way
 * {@link declaredSummaryPositions} normalizes a declared one. Presence is read
 * from the VALUE, not the key: the builder returns object literals that carry an
 * absent optional field as an explicit `undefined`, which occupies no position.
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

  test("reaches every optional position the summary declares", () => {
    const declared = declaredSummaryPositions();
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
