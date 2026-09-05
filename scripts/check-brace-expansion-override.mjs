#!/usr/bin/env node
// brace-expansion override redundancy check, run by static_checks.yaml on every
// PR.
//
// The root package.json holds an override on `brace-expansion` so that every
// requirer of it resolves to a line the advisory it answers has a patch for.
// docs/spec/DEPENDENCY_PINS.md records why it is there and what it costs: a
// dev-scoped `invalid` edge that refuses a dev-inclusive `npm sbom`, and a
// latent API-incompatible major under every requirer whose declared range the
// override overrules. Both costs are paid for as long as the override stands,
// and its exit condition -- no requirer left that caps below the overridden
// line -- is reached by an upstream release rather than by anything in this
// repo. Left to prose it would be reached and not noticed.
//
// So this fails once the override has nothing left to overrule: the override
// stands, and no `brace-expansion` range the committed lockfile declares
// excludes the version that lockfile installs. That is the state in which every
// requirer would get a satisfying version with the override gone, and the block
// is dead weight.
//
// What it reads: the root package.json's `overrides` and the committed
// package-lock.json. Files only -- no registry, no install, no network.
//
// What it cannot see:
//   - It reports what the committed lockfile DECLARES, not what npm would
//     resolve with the override removed. Only npm can answer that, so a removal
//     this check greenlights is still confirmed by regenerating the lockfile and
//     running `npm audit --package-lock-only` against the regenerated tree.
//   - It reads declared ranges and does not model npm's resolver. It does not
//     work out which installed copy any one edge resolves to, so it names the
//     ranges that cap below the installed version rather than the edges npm
//     would report `invalid`.
//   - It reads a narrow semver subset -- comparator sets over `^`, `~`, `=`,
//     `<`, `<=`, `>`, `>=`, a bare version and the `x`/`*` wildcards, joined by
//     `||`. Every other spelling, a hyphen range and anything holding a
//     prerelease among them, is REFUSED by name rather than read, so an
//     unmodeled form costs a red check naming the form to model here and never a
//     verdict read off a range this could not evaluate. The subset it does read
//     is held to node-semver's own answers rather than to this reading of the
//     grammar: re-drive it against `semver.satisfies` over every range the
//     committed lockfile declares before widening or altering a comparator.
//   - It identifies an installed copy by the directory it sits in and an edge by
//     the name it is declared under. npm's alias form
//     (`some-key: "npm:brace-expansion@range"`) parts both from the package's own
//     identity, which the lockfile then holds in the entry's `name` field
//     alone, so an alias tying `brace-expansion` to another name -- in either
//     direction -- is REFUSED by name rather than read. An alias between two
//     other packages, the shape the committed tree already holds, is left
//     alone.
//   - It reads the override's presence, not its spec: any `overrides` entry on
//     the name stands, whatever form it takes.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE = "brace-expansion";

const NM = "node_modules/";
const ALIAS_PREFIX = "npm:";
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const NUMERIC = /^(?:0|[1-9]\d*)$/;
const WILDCARD = /^[xX*]$/;
const PLAIN_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

/**
 * A version or partial version as a `[major, minor, patch]` triple, with `null`
 * standing for a segment left off or spelled as a wildcard, or null when the
 * text is not one this check reads. A trailing-only wildcard is what npm itself
 * accepts as an X-range; a numeric segment after a wildcard (`1.x.2`) is refused
 * rather than silently widened.
 */
export function parsePartial(text) {
  const bare = text.startsWith("v") ? text.slice(1) : text;
  if (bare === "") return null;
  const segments = bare.split(".");
  if (segments.length > 3) return null;
  const parts = [];
  let wild = false;
  for (const segment of segments) {
    if (WILDCARD.test(segment)) {
      wild = true;
      parts.push(null);
      continue;
    }
    if (wild || !NUMERIC.test(segment)) return null;
    parts.push(Number(segment));
  }
  while (parts.length < 3) parts.push(null);
  return parts;
}

const order = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const atLeast = (bound) => (version) => order(version, bound) >= 0;
const below = (bound) => (version) => order(version, bound) < 0;
const within = (lower, upper) => (version) =>
  order(version, lower) >= 0 && order(version, upper) < 0;

/**
 * One comparator as a predicate over a `[major, minor, patch]` version, or null
 * when it is a spelling this check does not read.
 */
export function parseComparator(operator, text) {
  const parts = parsePartial(text);
  if (parts === null) return null;
  const [major, minor, patch] = parts;
  const anyVersion = () => true;

  if (operator === "" || operator === "=") {
    if (major === null) return anyVersion;
    if (minor === null) return within([major, 0, 0], [major + 1, 0, 0]);
    if (patch === null) return within([major, minor, 0], [major, minor + 1, 0]);
    return (version) => order(version, parts) === 0;
  }

  if (operator === "^") {
    if (major === null) return anyVersion;
    const lower = [major, minor ?? 0, patch ?? 0];
    if (major > 0) return within(lower, [major + 1, 0, 0]);
    if (minor === null) return within(lower, [1, 0, 0]);
    if (minor > 0) return within(lower, [0, minor + 1, 0]);
    if (patch === null) return within(lower, [0, 1, 0]);
    return within(lower, [0, 0, patch + 1]);
  }

  if (operator === "~") {
    if (major === null) return anyVersion;
    if (minor === null) return within([major, 0, 0], [major + 1, 0, 0]);
    const lower = [major, minor, patch ?? 0];
    return within(lower, [major, minor + 1, 0]);
  }

  // An inequality reads its partial as the span the partial names, so `>1.2` is
  // `>=1.3.0` and `<=1.2` is `<1.3.0`. Against a full version that span is the
  // version itself, and the release just past it is the next patch -- which
  // holds only because the target compared against has no prerelease.
  if (major === null) return null;
  const lower = [major, minor ?? 0, patch ?? 0];
  const past =
    minor === null
      ? [major + 1, 0, 0]
      : patch === null
        ? [major, minor + 1, 0]
        : [major, minor, patch + 1];
  if (operator === ">=") return atLeast(lower);
  if (operator === ">") return atLeast(past);
  if (operator === "<") return below(lower);
  if (operator === "<=") return below(past);
  return null;
}

const COMPARATOR = /^(\^|~|>=|<=|>|<|=)?\s*(\S+)\s*/;

/**
 * The comparators of one space-joined set, as predicates, or null when any of
 * them is unread. An empty set matches every version, as npm reads it.
 */
export function parseComparatorSet(text) {
  let rest = text.trim();
  const comparators = [];
  while (rest.length > 0) {
    const match = COMPARATOR.exec(rest);
    if (match === null) return null;
    const comparator = parseComparator(match[1] ?? "", match[2]);
    if (comparator === null) return null;
    comparators.push(comparator);
    rest = rest.slice(match[0].length);
  }
  return comparators;
}

/**
 * Whether `range` admits `version` -- true, false, or null when the range is a
 * spelling this check refuses to read. `version` is a plain `major.minor.patch`
 * string.
 */
export function admits(range, version) {
  if (typeof range !== "string") return null;
  const target = parsePartial(version);
  if (target === null || target.includes(null)) return null;
  const sets = range.split("||").map(parseComparatorSet);
  if (sets.some((set) => set === null)) return null;
  return sets.some((set) => set.every((comparator) => comparator(target)));
}

/** The directory name a lockfile entry installs under. */
const installedAs = (path) =>
  path.includes(NM) ? path.slice(path.lastIndexOf(NM) + NM.length) : path;

/**
 * The package an `npm:` alias spec names, which is everything before the `@`
 * that opens its range. A scoped name's own leading `@` is not that separator,
 * and a spec naming no range is the package name entire.
 */
const aliasTarget = (spec) => {
  const rest = spec.slice(ALIAS_PREFIX.length);
  const separator = rest.lastIndexOf("@");
  return separator > 0 ? rest.slice(0, separator) : rest;
};

/**
 * Every record in which the committed lockfile ties `PACKAGE` to a name that is
 * not its own, in either direction: an entry whose `name` field disagrees with
 * the directory it installs under, and a dependency map's `npm:` alias spec
 * whose key disagrees with the package it names. An aliased install holds its
 * true identity in that `name` field alone, so neither the directory nor the map
 * key can see it, and both are what the rest of this check reads by. An alias
 * between two packages that are neither of them `PACKAGE` is none of this
 * check's business.
 */
export function aliasedIdentities(lock) {
  const aliased = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    const directory = installedAs(path);
    const name = entry?.name;
    if (
      typeof name === "string" &&
      name !== directory &&
      (name === PACKAGE || directory === PACKAGE)
    ) {
      aliased.push({ path, name, directory });
    }
    for (const field of DEPENDENCY_FIELDS) {
      for (const [dependency, range] of Object.entries(entry?.[field] ?? {})) {
        if (typeof range !== "string" || !range.startsWith(ALIAS_PREFIX)) {
          continue;
        }
        const target = aliasTarget(range);
        if (
          target !== dependency &&
          (target === PACKAGE || dependency === PACKAGE)
        ) {
          aliased.push({ path, field, dependency, range });
        }
      }
    }
  }
  return aliased;
}

/**
 * Every version the committed lockfile installs in a `PACKAGE` directory,
 * deduplicated.
 */
export function installedVersions(lock) {
  const versions = new Set();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (installedAs(path) === PACKAGE && typeof entry?.version === "string") {
      versions.add(entry.version);
    }
  }
  return [...versions].sort();
}

/**
 * Every range the committed lockfile declares under the `PACKAGE` key, as
 * `{path, field, range}`.
 */
export function declaredRanges(lock) {
  const ranges = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    for (const field of DEPENDENCY_FIELDS) {
      const range = entry?.[field]?.[PACKAGE];
      if (range !== undefined) ranges.push({ path, field, range });
    }
  }
  return ranges;
}

const describe = ({ path, field, range }) =>
  `${path || "<root>"} (${field}) declares ${JSON.stringify(range)}`;

const describeAlias = (alias) =>
  alias.field === undefined
    ? `${alias.path || "<root>"} installs ${JSON.stringify(alias.name)} under the name ${JSON.stringify(alias.directory)}`
    : `${alias.path || "<root>"} (${alias.field}) declares ${JSON.stringify(alias.dependency)} as ${JSON.stringify(alias.range)}`;

const DROP_IT = [
  `The root "${PACKAGE}" override is dead weight: drop it from package.json,`,
  `regenerate the lockfile, confirm the advisory it answered stays clear with`,
  `\`npm audit --package-lock-only\` against the regenerated tree, and retire the`,
  `"The ${PACKAGE} advisory is fixed by a root override" section of`,
  `docs/spec/DEPENDENCY_PINS.md along with it.`,
].join(" ");

const refusal = (reason) =>
  `${reason} -- model that shape in scripts/check-brace-expansion-override.mjs before this check can answer for it.`;

/**
 * The check's verdict over a root manifest and a committed lockfile:
 * `{ok, lines}`, where `lines` is what the run prints either way.
 */
export function assess(manifest, lock) {
  const overrides = manifest?.overrides ?? {};
  if (!Object.hasOwn(overrides, PACKAGE)) {
    return {
      ok: true,
      lines: [
        `No root "${PACKAGE}" override stands, so there is no redundancy to watch for.`,
      ],
    };
  }
  if (lock?.packages === undefined) {
    return {
      ok: false,
      lines: [
        refusal(
          "the lockfile carries no `packages` map, so nothing here can be read from it",
        ),
      ],
    };
  }

  const aliased = aliasedIdentities(lock);
  if (aliased.length > 0) {
    return {
      ok: false,
      lines: [
        refusal(
          `${aliased.length} lockfile record${aliased.length === 1 ? "" : "s"} tie${aliased.length === 1 ? "s" : ""} ${PACKAGE} to another name through an npm alias, and this check reads a copy by the directory it installs in and an edge by the name it is declared under`,
        ),
        ...aliased.map(describeAlias),
      ],
    };
  }

  const installed = installedVersions(lock);
  if (installed.length === 0) {
    return {
      ok: false,
      lines: [
        `The lockfile installs no ${PACKAGE} at all, so the override rewrites nothing.`,
        DROP_IT,
      ],
    };
  }
  if (installed.length > 1) {
    return {
      ok: false,
      lines: [
        refusal(
          `the lockfile installs ${installed.length} versions of ${PACKAGE} (${installed.join(", ")}), so a range excluding one of them may still admit another and "capped below the override" has no single answer`,
        ),
      ],
    };
  }
  const [target] = installed;
  if (!PLAIN_VERSION.test(target)) {
    return {
      ok: false,
      lines: [
        refusal(
          `the lockfile installs ${PACKAGE}@${target}, and this check compares against a plain major.minor.patch version only`,
        ),
      ],
    };
  }

  const declared = declaredRanges(lock);
  const unread = declared.filter((edge) => admits(edge.range, target) === null);
  if (unread.length > 0) {
    return {
      ok: false,
      lines: [
        refusal(
          `${unread.length} declared ${PACKAGE} range${unread.length === 1 ? " is" : "s are"} spelled in a form this check does not read`,
        ),
        ...unread.map(describe),
      ],
    };
  }

  const capped = declared.filter(
    (edge) => admits(edge.range, target) === false,
  );
  if (capped.length === 0) {
    return {
      ok: false,
      lines: [
        `Every ${PACKAGE} range the committed lockfile declares admits ${PACKAGE}@${target}, the version it installs, so the override overrules nothing.`,
        DROP_IT,
        `What that rests on is the lockfile's declarations, not npm's resolution without the override -- regenerating and auditing is what settles the removal.`,
      ],
    };
  }

  return {
    ok: true,
    lines: [
      `${PACKAGE} override check passed: ${capped.length} of ${declared.length} declared ranges exclude ${PACKAGE}@${target}, the version the lockfile installs, so the override still overrules a requirer.`,
      ...capped.map(describe),
    ],
  };
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const read = (name) => JSON.parse(readFileSync(resolve(root, name), "utf8"));
  const { ok, lines } = assess(read("package.json"), read("package-lock.json"));
  for (const line of lines) (ok ? console.log : console.error)(line);
  if (!ok) process.exit(1);
}
