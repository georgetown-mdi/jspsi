#!/usr/bin/env node
// Nested root-package check, run by static_checks.yaml on every PR.
//
// A workspace manifest bump can leave a second copy of a package the root
// already has: npm 11.17 does not hoist a later range bump incrementally
// while a root `overrides` block stands, so the stale hoisted copy is kept and
// the raised version is nested under the workspace that asked for it. Nothing
// at install time reports that split. What it costs is measured in
// docs/spec/DEPENDENCY_PINS.md, "What a root overrides block changes about
// later installs": the TanStack Start plugins resolve the root copy while the
// dev server runs the nested one, the dev SSR middleware never installs, every
// route 404s, and the web integration and browser suites die in their shared
// globalSetup -- no test FAILS, and CI reports a bare exit code 1 naming
// nothing. It has landed twice, and `@dependabot rebase` and
// `@dependabot recreate` each reproduce it, so the next bump is what stands
// between here and a third.
//
// So this fails on any package the committed lockfile installs at the top level
// of BOTH the root node_modules and a workspace's, naming the package and both
// entries. Every package rather than a named list: the mechanism is the
// overrides block's presence and not any one dependency, so a list would only
// ever cover the recurrences that already happened. NESTED_BY_DESIGN is where a
// split that is meant to stand is recorded, and is what keeps this from crying
// wolf over one.
//
// What it reads: the committed package-lock.json. Files only -- no install, no
// registry, no network.
//
// What it cannot see:
//   - It reports the split the committed lockfile RECORDS, not one npm would
//     resolve. Only npm can answer the latter, so a lockfile edit this check
//     greenlights is still confirmed by reinstalling from it.
//   - Its scope is the top level of the root node_modules against the top level
//     of each workspace's. A copy nested deeper -- under another package's
//     node_modules, at the root or inside a workspace -- is ordinary conflict
//     resolution, which the committed tree holds dozens of; the class above
//     was measured nesting directly under the workspace that raised its range.
//     Out of scope too is a workspace-nested package the root does not have:
//     with no root copy there is no root instance to be split against.
//   - It does not tell a stale hoist from a split some declared range requires.
//     The lockfile records neither the override nor which edge each copy
//     serves, so which of the two a split is stays a reading of the bump that
//     produced it; NESTED_BY_DESIGN is where that reading is recorded, with its
//     reason.
//   - It matches a copy by the directory it installs under, which is what a
//     bare specifier resolves through, and reads each copy's own identity from
//     the entry's `name` field to confirm both directories hold the same
//     package. Where the two disagree -- an npm alias pointing one of them at
//     another package -- it REFUSES by name rather than reporting a duplicate
//     of a package only one of them is. An alias standing anywhere else,
//     including the `string-width-cjs` family the committed tree holds at the
//     root, is none of this check's business.
//   - Workspace directories come from the lockfile's own keys that sit outside
//     every node_modules, which is npm's record of the directories it resolved.
//     The manifest's `workspaces` globs are not re-expanded here.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NM = "node_modules";
const SCRIPT = "scripts/check-nested-root-package.mjs";

/**
 * The splits that are meant to stand, keyed by the nested entry's lockfile path
 * and valued by why that workspace cannot take the version the rest of the tree
 * resolves. An entry naming a path the lockfile no longer holds as a split
 * fails alongside the rest, so a split that gets fixed cannot leave its excuse
 * behind. Empty because the committed lockfile contains no split at all.
 */
export const NESTED_BY_DESIGN = {};

const segments = (path) => path.split("/");

/**
 * Every directory the lockfile records as a project of this repository rather
 * than an installed dependency -- the workspaces, without the root entry.
 */
export function workspaceDirectories(lock) {
  return Object.keys(lock.packages).filter(
    (path) => path !== "" && !segments(path).includes(NM),
  );
}

/**
 * Every package the lockfile installs at the top level of `directory`'s
 * node_modules, keyed by the directory it installs under -- the name a bare
 * specifier resolving from `directory` reaches it through. The repository root
 * is the empty string.
 */
export function topLevelInstalls(lock, directory) {
  const base = directory === "" ? `${NM}/` : `${directory}/${NM}/`;
  const installs = new Map();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path.startsWith(base)) continue;
    const installedAs = path.slice(base.length);
    if (segments(installedAs).includes(NM)) continue;
    installs.set(installedAs, { path, entry });
  }
  return installs;
}

/**
 * The package a copy actually holds. npm writes the `name` field only where it
 * disagrees with the directory, which is what an alias does.
 */
const identity = (installedAs, entry) =>
  typeof entry?.name === "string" ? entry.name : installedAs;

/**
 * Every package the committed lockfile installs at the top level of both the
 * root node_modules and a workspace's, as
 * `{workspace, installedAs, nested, root}`.
 */
export function splitCopies(lock) {
  const rootInstalls = topLevelInstalls(lock, "");
  const splits = [];
  for (const workspace of workspaceDirectories(lock)) {
    for (const [installedAs, nested] of topLevelInstalls(lock, workspace)) {
      const root = rootInstalls.get(installedAs);
      if (root !== undefined) {
        splits.push({ workspace, installedAs, nested, root });
      }
    }
  }
  return splits.sort((a, b) => a.nested.path.localeCompare(b.nested.path));
}

const describeCopy = ({ path, entry }) => {
  if (typeof entry?.version === "string") {
    return `${path} installs ${entry.version}`;
  }
  if (entry?.link === true) return `${path} links ${entry.resolved}`;
  return `${path} installs an entry carrying no version`;
};

const describeSplit = ({ installedAs, nested, root }) =>
  `${installedAs} is split across the workspace boundary: ${describeCopy(nested)} while ${describeCopy(root)}.`;

const REMEDY = [
  `Delete the duplicated entries from package-lock.json and re-resolve with`,
  `\`npm install --package-lock-only\`, the route measured to work:`,
  `\`@dependabot rebase\` and \`@dependabot recreate\` each reproduce the split,`,
  `and a from-scratch resolve drifts far past the bump being landed. Where a`,
  `split is meant to stand -- a workspace that cannot take the version the rest`,
  `of the tree resolves -- record it in NESTED_BY_DESIGN in ${SCRIPT} with the`,
  `reason. Background: docs/spec/DEPENDENCY_PINS.md, "What a root overrides`,
  `block changes about later installs".`,
].join(" ");

const refusal = (reason) =>
  `${reason} -- model that shape in ${SCRIPT} before this check can answer for it.`;

/**
 * The check's verdict over a committed lockfile: `{ok, lines}`, where `lines` is
 * what the run prints either way.
 */
export function assess(lock, allowlist = NESTED_BY_DESIGN) {
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

  const unreasoned = Object.entries(allowlist).filter(
    ([, reason]) => typeof reason !== "string" || reason.trim() === "",
  );
  if (unreasoned.length > 0) {
    return {
      ok: false,
      lines: [
        `${unreasoned.length} NESTED_BY_DESIGN entr${unreasoned.length === 1 ? "y carries" : "ies carry"} no reason, and a split stands only on one.`,
        ...unreasoned.map(
          ([path]) => `${path} is allowed with no reason given.`,
        ),
      ],
    };
  }

  const splits = splitCopies(lock);

  const aliased = splits.filter(
    ({ installedAs, nested, root }) =>
      identity(installedAs, nested.entry) !== identity(installedAs, root.entry),
  );
  if (aliased.length > 0) {
    return {
      ok: false,
      lines: [
        refusal(
          `${aliased.length} directory name${aliased.length === 1 ? "" : "s"} the root and a workspace share ${aliased.length === 1 ? "holds" : "hold"} a different package on each side, so a shared name is not a duplicate there`,
        ),
        ...aliased.map(
          ({ installedAs, nested, root }) =>
            `${installedAs}: ${nested.path} holds ${identity(installedAs, nested.entry)} and ${root.path} holds ${identity(installedAs, root.entry)}.`,
        ),
      ],
    };
  }

  const lines = [];
  const flagged = splits.filter(
    ({ nested }) => !Object.hasOwn(allowlist, nested.path),
  );
  if (flagged.length > 0) {
    lines.push(
      `${flagged.length} package${flagged.length === 1 ? "" : "s"} the committed lockfile installs at the root ${flagged.length === 1 ? "is" : "are"} nested under a workspace as well.`,
      ...flagged.map(describeSplit),
      REMEDY,
    );
  }

  const dead = Object.keys(allowlist).filter(
    (path) => !splits.some(({ nested }) => nested.path === path),
  );
  if (dead.length > 0) {
    lines.push(
      `${dead.length} NESTED_BY_DESIGN entr${dead.length === 1 ? "y names" : "ies name"} a path the committed lockfile does not carry as a split, so ${dead.length === 1 ? "it excuses" : "they excuse"} nothing: drop ${dead.length === 1 ? "it" : "them"} from ${SCRIPT}.`,
      ...dead,
    );
  }

  if (lines.length > 0) return { ok: false, lines };

  const workspaces = workspaceDirectories(lock);
  const passed = [
    `Nested root-package check passed: none of the ${topLevelInstalls(lock, "").size} packages the committed lockfile installs at the root is nested under any of its ${workspaces.length} workspaces.`,
  ];
  for (const [path, reason] of Object.entries(allowlist)) {
    passed.push(`${path} stands by design: ${reason}`);
  }
  return { ok: true, lines: passed };
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const lock = JSON.parse(
    readFileSync(resolve(root, "package-lock.json"), "utf8"),
  );
  const { ok, lines } = assess(lock);
  for (const line of lines) (ok ? console.log : console.error)(line);
  if (!ok) process.exit(1);
}
