#!/usr/bin/env node
// Dependabot checklist-pin coverage check, run by static_checks.yaml on every PR.
//
// docs/spec/DEPENDENCY_PINS.md carries an "Upgrading ..." section for every
// dependency this repository reaches past the public API of: the premises the
// code rests on and the procedure that re-verifies them before a bump merges. A
// checklist only fires if someone reads it, and a bump that arrives inside a
// batched Dependabot pull request beside a dozen routine ones is not read that
// way -- it is skimmed as routine, which is the whole point of batching it.
// .github/dependabot.yml holds those packages out of the batch, and the two
// files drift apart silently: a checklist added here reaches no config, and an
// exclude entry dropped there reads exactly like one that was never needed. So
// the coupling is a check rather than a habit.
//
// The rule:
//
//   A package named by an "Upgrading ..." heading in
//   docs/spec/DEPENDENCY_PINS.md must be covered by the `exclude-patterns` of
//   every npm group in .github/dependabot.yml that would otherwise swallow it
//   -- a group whose `patterns` match the package without naming it.
//
// A group that names the package outright in its `patterns` is its deliberate
// reviewed treatment (`cryptographic`, `webrtc-stack`), not a batch it fell
// into, so it asks for no exclude entry. A group declaring no `patterns` at all
// matches every package (`non-critical`), so it always does.
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
// What this check does not cover:
//   - Which group a package lands in. Whether a bump belongs in a reviewed
//     group, and which one, is a judgment about what it must be reviewed
//     against; a package in no group at all still gets an individual pull
//     request, which satisfies the rule above. Only the direction that fails
//     silently -- riding a batch -- is checked.
//   - Whether Dependabot resolves this config the way the rule reads it. The
//     pattern and exclude lists are read as text; how the real tool assigns a
//     package matching several groups is not modelled here, which is why what
//     is asserted is the belt-and-braces entry the config already writes by
//     hand rather than a prediction of which pull request a bump lands in.
//   - Pin exactness. No manifest is read, so whether a package carries an exact
//     version or a range is outside this, and a comment anywhere calling a
//     package exact-pinned is not held by it.
//   - The docker and github-actions update blocks, whose lists carry different
//     rationales; scripts/check-dependabot-ignore-shape.mjs owns the
//     github-actions ignore list.
//   - Whether a package that ought to carry an upgrade checklist has one. The
//     read runs from the document to the config and never back.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

// Dependabot's `dependency-name` and a group's `patterns` share one glob
// syntax, so the ignore-shape check's matcher serves both rather than being
// written twice.
import { coversAction as coversName } from "./check-dependabot-ignore-shape.mjs";
import { stripFences } from "./lib/markdownFences.mjs";

const PINS_DOC = "docs/spec/DEPENDENCY_PINS.md";
const CONFIG_FILE = ".github/dependabot.yml";
const ECOSYSTEM = "npm";
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
 * form.
 */
export function upgradeSections(source) {
  return stripFences(source)
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
 * `{name, patterns, excludePatterns}` in config order, or null when the source
 * carries no npm block at all. A group declaring no `patterns` is read as
 * matching everything, which is Dependabot's documented default.
 */
export function npmGroups(source) {
  const updates = parse(source)?.updates;
  const blocks = (Array.isArray(updates) ? updates : []).filter(
    (candidate) => candidate?.["package-ecosystem"] === ECOSYSTEM,
  );
  if (blocks.length === 0) return null;
  return blocks.flatMap((block) => {
    const groups = block.groups;
    if (!groups || typeof groups !== "object") return [];
    return Object.entries(groups).map(([name, group]) => ({
      name,
      patterns: Array.isArray(group?.patterns) ? group.patterns : ["*"],
      excludePatterns: Array.isArray(group?.["exclude-patterns"])
        ? group["exclude-patterns"]
        : [],
    }));
  });
}

/**
 * Every checklist-carrying package a group would swallow without excluding, as
 * message strings. Empty means no batched pull request can carry a bump whose
 * upgrade checklist is recorded in the pins document.
 */
export function coverageViolations(packages, groups) {
  const messages = packages.flatMap((name) =>
    groups.flatMap((group) => {
      if (group.patterns.includes(name)) return [];
      const swallowing = group.patterns.find((pattern) =>
        coversName(pattern, name),
      );
      if (swallowing === undefined) return [];
      if (group.excludePatterns.some((pattern) => coversName(pattern, name))) {
        return [];
      }
      return [
        `${PINS_DOC} carries an "Upgrading ..." checklist for ${name}, but the npm group "${group.name}" in ${CONFIG_FILE} matches it through pattern "${swallowing}" without naming it, and no exclude-patterns entry covers it -- a ${name} bump would arrive inside that group's batched pull request, where the checklist is not what gets read. Add "${name}" to that group's exclude-patterns, or name it in the group's patterns if that group is the reviewed treatment for it.`,
      ];
    }),
  );
  return [...new Set(messages)];
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const sections = upgradeSections(
    readFileSync(resolve(root, PINS_DOC), "utf8"),
  );
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
  const packages = [...new Set(sections.flatMap(({ packages }) => packages))];
  const violations = coverageViolations(packages, groups);
  if (violations.length > 0) {
    for (const violation of violations) console.error(violation);
    process.exit(1);
  }
  const count = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  console.log(
    `Dependabot checklist-pin coverage check passed: ${count(packages.length, "package")} named by ${count(sections.length, "upgrade checklist")} in ${PINS_DOC}, checked against ${count(groups.length, "npm group")} in ${CONFIG_FILE}.`,
  );
}
