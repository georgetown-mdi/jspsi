#!/usr/bin/env node
// Dependabot checklist-pin coverage check, run by static_checks.yaml on every PR.
//
// docs/spec/DEPENDENCY_PINS.md has an "Upgrading ..." section for every
// dependency this repository reaches past the public API of: the assumptions
// the code rests on and the procedure that re-verifies them before a bump
// merges. A checklist only fires if someone reads it, and a bump that arrives
// inside a batched Dependabot pull request beside a dozen routine ones is not
// read that way -- it is skimmed as routine, which is the whole point of
// batching it.
// .github/dependabot.yml holds those packages out of the batch, and the two
// files drift apart silently: a checklist added here reaches no config, and an
// exclude entry dropped there reads exactly like one that was never needed. So
// the coupling is a check rather than a habit.
//
// The same silence covers the property every one of those checklists assumes
// before any of that matters: that the package is pinned to the single version
// whose internals the assumptions were read off. A caret slipping into a manifest
// installs a later one with no pull request for anyone to hold the checklist
// against. So does a second manifest naming a different exact version: both
// declarations pin, and both look deliberate, but the checklist was worked
// through against one of the two internals now installed.
//
// The rules:
//
//   1. A package named by an "Upgrading ..." heading in
//      docs/spec/DEPENDENCY_PINS.md must be covered by the `exclude-patterns`
//      of every npm group in .github/dependabot.yml that would otherwise
//      swallow it -- a group whose `patterns` match the package without naming
//      it. Every group in the file, in whichever npm update block: the pins
//      document is repository-wide, so a batch raised by any block is one the
//      checklist is not read against.
//
//   2. That package must be declared by at least one manifest in this
//      workspace, and every manifest declaring it must declare an exact
//      version.
//
//   3. Those declarations must all name the same version.
//
//   4. A package literally named in one npm group's `patterns` must be
//      covered by the `exclude-patterns` of every other npm group in the same
//      update block that would otherwise swallow it -- the same "swallow"
//      reading as the first rule, applied between two groups instead of
//      between a checklist and a group. Adding a package to a reviewed
//      group's `patterns` and forgetting its exclusion elsewhere returns it to
//      whichever other group's batch would otherwise match it, silently. The
//      block bounds it because groups only compete for a bump inside the block
//      that raises the pull request; a group in another block takes nothing
//      away from this one's reviewed treatment.
//
// A group that names the package outright in its `patterns` is its deliberate
// reviewed treatment (`cryptographic`, `webrtc-stack`), not a batch it fell
// into, so it asks for no exclude entry there -- from either the first rule or
// the fourth. A group declaring no `patterns` at all matches every package
// (`non-critical`), so it always needs one.
//
// The heading convention this reads: an "Upgrading ..." heading ends in a
// parenthesised list of the npm packages the section covers, separated by " / "
// -- the spaces around the separator are what keep a scoped name's own slash
// intact. A heading naming none, or naming a token that is not an npm package
// name, fails the check rather than being passed over: a section no name can be
// read out of is a checklist nothing can be held against.
//
// Glob reading: `*` in a pattern matches any run of characters, the same
// reading scripts/check-dependabot-ignore-shape.mjs takes of a
// `dependency-name`, whose matcher this shares.
//
// Manifest reading: the root package.json plus every package.json its
// `workspaces` globs reach. A declaration is a key of `dependencies`,
// `devDependencies`, `optionalDependencies`, or `peerDependencies`, matched by
// its exact name -- `@types/ssh2` is a package of its own, reaches no internal,
// and has no checklist. Exact means a bare `major.minor.patch`, optionally
// including a prerelease or build suffix, and nothing else: a specifier that
// pins by another route (a `file:` tarball, a git commit, an `npm:` alias)
// fails here too, because whether such a route pins is a judgment per
// dependency rather than a pattern, and a checklist for one wants this rule
// widened deliberately. The third rule compares those specifiers as text over
// every declaration found, so two fields of one manifest disagreeing fails it
// exactly as two manifests do. The workspace set is expanded from those globs
// here rather than asked of npm; the test holds that expansion to the set npm
// itself recorded in package-lock.json, so a glob form read differently
// reddens there instead of silently shrinking the sweep.
//
// What this check does not cover:
//   - Which group a package lands in. Whether a bump belongs in a reviewed
//     group, and which one, is a judgment about what it must be reviewed
//     against; a package in no group at all still gets an individual pull
//     request, which satisfies the first rule above. Only the direction that
//     fails silently -- riding a batch -- is checked.
//   - Whether Dependabot resolves this config the way the first rule reads
//     it. The pattern and exclude lists are read as text; how the real tool
//     assigns a package matching several groups is not modelled here, which is
//     why what is asserted is the belt-and-braces entry the config already
//     writes by hand rather than a prediction of which pull request a bump
//     lands in.
//   - What is installed. The second and third rules read the specifiers the
//     manifests declare; package-lock.json and node_modules are read by no
//     rule, so a lockfile disagreeing with an exact declaration is `npm ci`'s
//     to catch.
//   - Whether the version pinned is the one the checklist's assumptions were read
//     off. That is what a bump's own review establishes; this holds only that
//     a single version is named for it to have been read off.
//   - The docker and github-actions update blocks, whose lists hold different
//     rationales; scripts/check-dependabot-ignore-shape.mjs owns the
//     github-actions ignore list. No rule reaches a pin in another ecosystem:
//     those hold a heading of another shape, which the extraction never
//     matches, and no npm manifest declares them.
//   - Whether a package that ought to hold an upgrade checklist has one. The
//     read runs from the document out to the config and the manifests, and
//     never back.
//   - A group `patterns` entry that contains a `*` inside an otherwise literal
//     name -- e.g. a scoped org wildcard. The fourth rule reads a `patterns`
//     entry as either a literal package name or the bare `*` npmGroups()
//     already normalizes an absent `patterns` key to; a glob of any other
//     shape is a package list this does not resolve to names, and the
//     package name it "otherwise swallows" would depend on the resolution,
//     so it throws rather than guessing.
//   - Which of two groups a package should be reviewed under, when its name
//     appears in more than one group's `patterns`. The fourth rule only
//     checks that a group whose own `patterns` do not name the package
//     excludes it if some other group's do.

import { globSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

// Dependabot's `dependency-name` and a group's `patterns` share one glob
// syntax, so the ignore-shape check's matcher serves both rather than being
// written twice.
import { coversAction as coversName } from "./check-dependabot-ignore-shape.mjs";
import { stripFences, UnterminatedFenceError } from "./lib/markdownFences.mjs";

const PINS_DOC = "docs/spec/DEPENDENCY_PINS.md";
const CONFIG_FILE = ".github/dependabot.yml";
const ROOT_MANIFEST = "package.json";
const ECOSYSTEM = "npm";
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const NUMBER = "(?:0|[1-9]\\d*)";
const DOTTED_TAIL = "(?:[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)";
const EXACT_VERSION = new RegExp(
  `^${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-${DOTTED_TAIL})?(?:\\+${DOTTED_TAIL})?$`,
);
const UPGRADE_HEADING = /^#{2,6}\s+(Upgrading\b.*?)\s*$/;
const HEADING_NAME_LIST = /\(([^()]*)\)$/;
const NAME_SEPARATOR = /\s+\/\s+/;
const NPM_PACKAGE_NAME =
  /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const HEADING_FORM =
  'Upgrading <what> (<package> / <package>) -- e.g. "Upgrading the SFTP Stack (ssh2 / ssh2-sftp-client)"';

/**
 * The upgrade checklists in the pins document, as `{heading, packages}` in
 * document order. `packages` is the parenthesised, " / "-separated list the
 * heading ends with; an empty one means the heading named no package in that
 * form. Throws UnterminatedFenceError when the document opens a fenced code
 * block that never closes: which headings are the document's own, rather than
 * a code sample's, is then unknown.
 */
export function upgradeSections(source) {
  return stripFences(source, PINS_DOC)
    .split("\n")
    .flatMap((line) => {
      const heading = UPGRADE_HEADING.exec(line);
      if (!heading) return [];
      const text = heading[1];
      const list = HEADING_NAME_LIST.exec(text);
      const packages = list
        ? list[1]
            .split(NAME_SEPARATOR)
            .map((name) => name.trim().replaceAll("`", ""))
            .filter((name) => name.length > 0)
        : [];
      return [{ heading: text, packages }];
    });
}

/**
 * Every upgrade checklist whose heading no package name can be read out of, as
 * message strings. Empty means each section names packages this check can hold
 * the config against.
 */
export function headingViolations(sections) {
  return sections.flatMap(({ heading, packages }) => {
    if (packages.length === 0) {
      return [
        `${PINS_DOC}: the "${heading}" section names no package in its heading, so nothing holds ${CONFIG_FILE} to keeping its bumps out of a batch. End the heading with the packages it covers: ${HEADING_FORM}.`,
      ];
    }
    return packages
      .filter((name) => !NPM_PACKAGE_NAME.test(name))
      .map(
        (name) =>
          `${PINS_DOC}: the "${heading}" section's heading lists "${name}", which is not an npm package name. The trailing parenthesised list names the packages the section covers and nothing else: ${HEADING_FORM}.`,
      );
  });
}

/**
 * The dependency groups the npm update blocks declare, as
 * `{block, name, patterns, excludePatterns}` in config order, or null when the
 * source has no npm block at all. `block` is the position of the update
 * block the group was declared in among the npm blocks, so a rule reading this
 * flattened list can still tell two blocks' groups apart. A group declaring no
 * `patterns` is read as matching everything, which is Dependabot's documented
 * default.
 */
export function npmGroups(source) {
  const updates = parse(source)?.updates;
  const blocks = (Array.isArray(updates) ? updates : []).filter(
    (candidate) => candidate?.["package-ecosystem"] === ECOSYSTEM,
  );
  if (blocks.length === 0) return null;
  return blocks.flatMap((block, position) => {
    const groups = block.groups;
    if (!groups || typeof groups !== "object") return [];
    return Object.entries(groups).map(([name, group]) => ({
      block: position,
      name,
      patterns: Array.isArray(group?.patterns) ? group.patterns : ["*"],
      excludePatterns: Array.isArray(group?.["exclude-patterns"])
        ? group["exclude-patterns"]
        : [],
    }));
  });
}

/**
 * Every way one of `candidates` would be swallowed without being excluded, as
 * the message `describe` renders for it. A candidate is
 * `{name, groups, ...context}`: the package name, the groups that must hold it
 * out, and whatever else its message needs; a group swallows the name when its
 * `patterns` match without naming it and no `exclude-patterns` entry covers
 * it. `describe` receives `{name, group, swallowing, ...context}`. Repeated
 * messages collapse, so the shared swallow reading behind the first and fourth
 * rules is written once.
 */
function swallowViolations(candidates, describe) {
  const messages = candidates.flatMap(({ name, groups, ...context }) =>
    groups.flatMap((group) => {
      if (group.patterns.includes(name)) return [];
      const swallowing = group.patterns.find((pattern) =>
        coversName(pattern, name),
      );
      if (swallowing === undefined) return [];
      if (group.excludePatterns.some((pattern) => coversName(pattern, name))) {
        return [];
      }
      return [describe({ name, group, swallowing, ...context })];
    }),
  );
  return [...new Set(messages)];
}

/**
 * Every checklist-holding package a group would swallow without excluding, as
 * message strings. Empty means no batched pull request can hold a bump whose
 * upgrade checklist is recorded in the pins document.
 */
export function coverageViolations(packages, groups) {
  return swallowViolations(
    packages.map((name) => ({ name, groups })),
    ({ name, group, swallowing }) =>
      `${PINS_DOC} carries an "Upgrading ..." checklist for ${name}, but the npm group "${group.name}" in ${CONFIG_FILE} matches it through pattern "${swallowing}" without naming it, and no exclude-patterns entry covers it -- a ${name} bump would arrive inside that group's batched pull request, where the checklist is not what gets read. Add "${name}" to that group's exclude-patterns, or name it in the group's patterns if that group is the reviewed treatment for it.`,
  );
}

/**
 * Every package literally named in one npm group's `patterns` that another
 * group in the same update block would swallow into its own batch without
 * excluding, as message strings naming the package, the group that names it,
 * and the group whose exclusion is missing. Two groups share an update block
 * when they hold the same `block` from npmGroups(); a group in another block
 * is never compared, competing for no pull request with this one. Empty means
 * every package a group names outright is held out of every other group in its
 * block that would otherwise match it. Throws when a `patterns` entry contains
 * a `*` inside an otherwise literal name -- npmGroups() already normalizes an
 * absent `patterns` key to the bare `*` this treats as "names no package"; a
 * glob of any other shape is a package list this does not resolve to names, so
 * it fails rather than silently passing the entry over.
 */
export function groupExclusionViolations(groups) {
  const named = groups.flatMap((namingGroup) =>
    namingGroup.patterns
      .filter((pattern) => pattern !== "*")
      .map((name) => ({ name, namingGroup })),
  );
  const wildcard = named.find(({ name }) => name.includes("*"));
  if (wildcard !== undefined) {
    throw new Error(
      `${CONFIG_FILE}: npm group "${wildcard.namingGroup.name}" names "${wildcard.name}" in its patterns, a glob shape groupExclusionViolations in scripts/check-dependabot-pin-coverage.mjs does not read as a package name. It reads a literal package name or the bare "*" match-everything default and refuses to guess at the rest. Teach groupExclusionViolations the shape, or name the package literally.`,
    );
  }
  return swallowViolations(
    named.map(({ name, namingGroup }) => ({
      name,
      namingGroup,
      groups: groups.filter((group) => group.block === namingGroup.block),
    })),
    ({ name, group, swallowing, namingGroup }) =>
      `${CONFIG_FILE}: npm group "${namingGroup.name}" names "${name}" in its patterns, but npm group "${group.name}" matches it through pattern "${swallowing}" with no exclude-patterns entry covering it -- a ${name} bump would arrive inside "${group.name}"'s batched pull request instead of "${namingGroup.name}"'s reviewed one. Add "${name}" to "${group.name}"'s exclude-patterns.`,
  );
}

/**
 * The manifests of this workspace, as repository-relative paths in sorted
 * order with the root manifest first, or null when the root manifest declares
 * its `workspaces` in a shape this does not read. `expand` resolves one glob to
 * the paths it reaches.
 */
export function manifestPaths(rootManifest, expand) {
  const globs = rootManifest?.workspaces;
  if (!Array.isArray(globs) || globs.some((glob) => typeof glob !== "string")) {
    return null;
  }
  const reached = globs
    .flatMap((glob) => expand(`${glob}/${ROOT_MANIFEST}`))
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => path !== ROOT_MANIFEST);
  return [ROOT_MANIFEST, ...[...new Set(reached)].sort()];
}

/**
 * Every declaration the given `{path, manifest}` pairs make of one of
 * `packages`, as `{path, field, name, specifier}` in manifest then field order.
 */
export function packageDeclarations(packages, manifests) {
  const wanted = new Set(packages);
  return manifests.flatMap(({ path, manifest }) =>
    DEPENDENCY_FIELDS.flatMap((field) =>
      Object.entries(manifest?.[field] ?? {})
        .filter(([name]) => wanted.has(name))
        .map(([name, specifier]) => ({ path, field, name, specifier })),
    ),
  );
}

/**
 * Every checklist-holding package this workspace declares at something other
 * than an exact version, and every one it declares nowhere at all, as message
 * strings. Empty means each checklist covers a package pinned to one version.
 */
export function exactnessViolations(packages, declarations) {
  const undeclared = packages
    .filter((name) => !declarations.some((entry) => entry.name === name))
    .map(
      (name) =>
        `${PINS_DOC} carries an "Upgrading ..." checklist for ${name}, but no manifest in this workspace declares it, so no version of it is pinned here for the checklist's premises to rest on. Either the dependency is gone and the checklist goes with it, or its heading misspells the package name.`,
    );
  const inexact = declarations
    .filter(({ specifier }) => !EXACT_VERSION.test(specifier))
    .map(
      ({ path, field, name, specifier }) =>
        `${path} (${field}) declares ${name} as ${JSON.stringify(specifier)}, which is not a bare major.minor.patch version. ${PINS_DOC} carries an "Upgrading ..." checklist for ${name}, whose premises were read off one version's internals; a specifier admitting another lets that one install without the checklist being worked through. Pin the exact version, or retire the checklist if those internals are no longer load-bearing.`,
    );
  return [...undeclared, ...inexact];
}

/**
 * Every checklist-holding package this workspace declares at more than one
 * version, as message strings naming each declaration and its specifier. Empty
 * means each checklist covers one version wherever the package is declared.
 */
export function versionAgreementViolations(packages, declarations) {
  return packages.flatMap((name) => {
    const declared = declarations.filter((entry) => entry.name === name);
    const versions = new Set(declared.map(({ specifier }) => specifier));
    if (versions.size < 2) return [];
    const listing = declared
      .map(
        ({ path, field, specifier }) =>
          `${path} (${field}) ${JSON.stringify(specifier)}`,
      )
      .join(", ");
    return [
      `This workspace declares ${name} at ${versions.size} different versions: ${listing}. ${PINS_DOC} carries an "Upgrading ..." checklist for ${name}, whose premises were read off one version's internals; a manifest naming another installs internals the checklist was never worked through against. Declare one version everywhere, or retire the checklist if those internals are no longer load-bearing.`,
    ];
  });
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let sections;
  try {
    sections = upgradeSections(readFileSync(resolve(root, PINS_DOC), "utf8"));
  } catch (error) {
    if (!(error instanceof UnterminatedFenceError)) throw error;
    console.error(
      `Dependabot checklist-pin coverage check failed: ${error.message}`,
    );
    process.exit(1);
  }
  if (sections.length === 0) {
    console.error(
      `${PINS_DOC}: no "Upgrading ..." heading matched -- either the upgrade checklists were removed, in which case delete this check, or the extraction rotted; fix scripts/check-dependabot-pin-coverage.mjs`,
    );
    process.exit(1);
  }
  const malformed = headingViolations(sections);
  if (malformed.length > 0) {
    for (const violation of malformed) console.error(violation);
    process.exit(1);
  }
  const groups = npmGroups(readFileSync(resolve(root, CONFIG_FILE), "utf8"));
  if (groups === null) {
    console.error(
      `${CONFIG_FILE}: no ${ECOSYSTEM} update block matched -- either Dependabot no longer covers npm packages, in which case delete this check, or the extraction rotted; fix scripts/check-dependabot-pin-coverage.mjs`,
    );
    process.exit(1);
  }
  if (groups.length === 0) {
    console.error(
      `${CONFIG_FILE}: the ${ECOSYSTEM} update block declares no groups -- with nothing batching bumps there is nothing for this check to hold, so delete it, or fix the extraction in scripts/check-dependabot-pin-coverage.mjs`,
    );
    process.exit(1);
  }
  let groupExclusions;
  try {
    groupExclusions = groupExclusionViolations(groups);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  if (groupExclusions.length > 0) {
    for (const violation of groupExclusions) console.error(violation);
    process.exit(1);
  }
  const packages = [...new Set(sections.flatMap(({ packages }) => packages))];
  const violations = coverageViolations(packages, groups);
  if (violations.length > 0) {
    for (const violation of violations) console.error(violation);
    process.exit(1);
  }
  const readJson = (path) =>
    JSON.parse(readFileSync(resolve(root, path), "utf8"));
  const paths = manifestPaths(readJson(ROOT_MANIFEST), (glob) =>
    globSync(glob, { cwd: root }),
  );
  if (paths === null) {
    console.error(
      `${ROOT_MANIFEST}: no "workspaces" list of globs matched -- either this repository is no longer an npm workspace, in which case reduce this check to the root manifest, or the extraction rotted; fix scripts/check-dependabot-pin-coverage.mjs`,
    );
    process.exit(1);
  }
  const declarations = packageDeclarations(
    packages,
    paths.map((path) => ({ path, manifest: readJson(path) })),
  );
  const inexact = exactnessViolations(packages, declarations);
  if (inexact.length > 0) {
    for (const violation of inexact) console.error(violation);
    process.exit(1);
  }
  const disagreeing = versionAgreementViolations(packages, declarations);
  if (disagreeing.length > 0) {
    for (const violation of disagreeing) console.error(violation);
    process.exit(1);
  }
  const count = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const groupNamed = new Set(
    groups.flatMap((group) =>
      group.patterns.filter((pattern) => pattern !== "*"),
    ),
  );
  console.log(
    `Dependabot checklist-pin coverage check passed: ${count(packages.length, "package")} named by ${count(sections.length, "upgrade checklist")} in ${PINS_DOC}, checked against ${count(groups.length, "npm group")} in ${CONFIG_FILE} and each pinned to one version by ${count(declarations.length, "declaration")} across ${count(paths.length, "manifest")}. ${count(groupNamed.size, "package")} named outright in a group's patterns ${groupNamed.size === 1 ? "is" : "are"} held out of every other group in its update block that would otherwise batch it.`,
  );
}
