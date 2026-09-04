#!/usr/bin/env node
// Dependabot ignore-shape check, run by static_checks.yaml on every PR.
//
// The `github-actions` block in .github/dependabot.yml ignores within-major
// updates for several orgs. That suppression is only sound over pins that float
// within their major: an exact pin (actions/checkout@v7.0.1), a commit sha, or a
// branch name under a covered org sits under an ignore that suppresses every
// update it could ever receive, so it freezes with no pull request to surface a
// fix. This fails the build on that pairing instead.
//
// The rule:
//
//   A pin under .github/workflows or .github/actions whose name is covered by a
//   `github-actions` `ignore` entry that suppresses within-major updates must
//   name a bare floating major tag.
//
// The entries are read out of the config, so editing the ignore list changes
// what is enforced without a second edit here. An entry suppresses within-major
// updates when its `update-types` names `version-update:semver-minor` or
// `version-update:semver-patch`, or names no update type at all; one that
// suppresses neither imposes no shape requirement on the pins it covers.
//
// This is a coherence property of this repository's configuration, not a
// prediction of Dependabot's behavior: whether those ignores in fact suppress a
// v7.0.1 -> v7.0.2 bump has not been driven against the real tool, and the rule
// does not rest on it. A pin the config's own stated rationale assumes to be
// floating is worth holding to that shape either way.
//
// Glob reading: `*` matches across `/`, so `github/*` covers the subpath action
// `github/codeql-action/init`. Whether that is Dependabot's own reading is
// unsettled -- see the open premise in docs/spec/DEPENDENCY_PINS.md. The
// inclusive reading is the fail-closed one: it requires more pins to be bare
// majors, so the rule stays correct if the narrower reading turns out to be
// Dependabot's.
//
// What this check does not cover:
//   - A bare-major pin from an org NO ignore entry names. Whether the ignore
//     list is complete is unchecked; only the direction that fails silently is.
//   - A reference naming no ref at all. Rule C of check-action-pin-drift.mjs
//     owns that shape, and a test here holds that delegation.
//   - The npm and docker Dependabot blocks, whose ignore and exclude-patterns
//     lists carry different rationales.
//   - What `@v7` resolves to. The ref is read as text, so a tag named like a
//     bare major that in fact points at a frozen commit is outside this.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { WORKFLOW_DIR, treeReferences } from "./lib/workflows.mjs";

const CONFIG_FILE = ".github/dependabot.yml";
const ECOSYSTEM = "github-actions";
const WITHIN_MAJOR_UPDATE_TYPES = [
  "version-update:semver-minor",
  "version-update:semver-patch",
];
const FLOATING_MAJOR = /^v\d+$/;

/**
 * The `ignore` entries the `github-actions` update block declares, as
 * `{dependencyName, updateTypes}` pairs in config order, or null when the source
 * carries no `github-actions` block at all. A null `updateTypes` is an entry
 * naming no update type.
 */
export function githubActionsIgnoreEntries(source) {
  const updates = parse(source)?.updates;
  const block = (Array.isArray(updates) ? updates : []).find(
    (candidate) => candidate?.["package-ecosystem"] === ECOSYSTEM,
  );
  if (!block) return null;
  const ignore = Array.isArray(block.ignore) ? block.ignore : [];
  return ignore.flatMap((entry) => {
    const dependencyName = entry?.["dependency-name"];
    if (typeof dependencyName !== "string") return [];
    const updateTypes = entry["update-types"];
    return [
      {
        dependencyName,
        updateTypes: Array.isArray(updateTypes) ? updateTypes : null,
      },
    ];
  });
}

/**
 * Whether an ignore entry suppresses updates within a major version. An entry
 * naming no update type suppresses every update, within-major included.
 */
export function suppressesWithinMajor({ updateTypes }) {
  if (updateTypes === null) return true;
  return updateTypes.some((type) => WITHIN_MAJOR_UPDATE_TYPES.includes(type));
}

/**
 * Whether a `dependency-name` pattern covers an action name. `*` matches any run
 * of characters including `/`; every other character is literal.
 */
export function coversAction(pattern, name) {
  const expression = pattern.replace(/[.*+?^${}()|[\]\\]/g, (character) =>
    character === "*" ? ".*" : `\\${character}`,
  );
  return new RegExp(`^${expression}$`).test(name);
}

/**
 * Whether a ref is a bare floating major tag -- the shape a within-major ignore
 * entry's rationale assumes of every pin it covers.
 */
export function isFloatingMajor(ref) {
  return FLOATING_MAJOR.test(ref);
}

/**
 * Every pin covered by a within-major ignore entry whose ref is not a bare
 * floating major, as message strings. Empty means the ignore list and the pin
 * shapes it covers agree.
 */
export function shapeViolations(references, entries) {
  const suppressing = entries.filter(suppressesWithinMajor);
  const messages = references.flatMap(({ file, name, ref }) => {
    if (ref === null || isFloatingMajor(ref)) return [];
    const entry = suppressing.find(({ dependencyName }) =>
      coversAction(dependencyName, name),
    );
    if (!entry) return [];
    return [
      `${name}@${ref} in ${file} is not pinned to a bare floating major tag, but ${CONFIG_FILE} ignores within-major updates for it under dependency-name "${entry.dependencyName}" -- so nothing will ever open a pull request moving this pin off @${ref}, however many fixes land within the major. Re-pin it to the floating major tag that entry assumes (${name}@v<major>), or drop or narrow the entry so this pin's within-major bumps surface.`,
    ];
  });
  return [...new Set(messages)];
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const entries = githubActionsIgnoreEntries(
    readFileSync(resolve(root, CONFIG_FILE), "utf8"),
  );
  if (entries === null) {
    console.error(
      `${CONFIG_FILE}: no ${ECOSYSTEM} update block matched -- either Dependabot no longer covers GitHub Actions, in which case delete this check, or the extraction rotted; fix scripts/check-dependabot-ignore-shape.mjs`,
    );
    process.exit(1);
  }
  const { workflowReferences, actionReferences } = treeReferences(root);
  if (workflowReferences.length === 0) {
    console.error(
      `${WORKFLOW_DIR}: no action references matched in any workflow -- the shared extraction rotted; fix scripts/lib/workflows.mjs`,
    );
    process.exit(1);
  }
  const references = [...workflowReferences, ...actionReferences];
  const violations = shapeViolations(references, entries);
  if (violations.length > 0) {
    for (const violation of violations) console.error(violation);
    process.exit(1);
  }
  const pins = `${references.length} pin${references.length === 1 ? "" : "s"}`;
  const suppressing = entries.filter(suppressesWithinMajor).length;
  console.log(
    `Dependabot ignore shape check passed: ${pins} checked against ${suppressing} of ${entries.length} ${ECOSYSTEM} ignore entries in ${CONFIG_FILE}, the ones suppressing within-major updates.`,
  );
}
