#!/usr/bin/env node
// Built-in rule set version bump check, run by static_checks.yaml on every PR.
//
// docs/notes/default-linkage-rule-set.md's "What the versions mean" states the
// rule in prose: an edit to the built-in FIELD set bumps the field set's
// version, and an edit to the built-in KEY set bumps the key set's -- a reorder
// of the keys included, because the order is cascade order and moving a key
// changes which one claims a record more than one would match. The recorded
// validation attaches to a name and a version together, so an edited set
// holding the old version leaves that note describing rules nobody ran, which
// is the exact failure the naming exists to prevent. A future obligation written
// as prose is the shape that rots: nothing fails when it is forgotten. This is
// that obligation as a check.
//
// Two parts, each read from the tree alone:
//
//   A. THE SET CONTENT, digested per set out of
//      packages/core/src/defaults/linkageTerms.ts: the fields with their
//      constraints, and the keys with their elements, transforms, swaps, and the
//      order they are applied in. The digest is taken over the evaluated
//      declarations rather than the file text, so a comment, a reflow, a move
//      within the file, or a property written in another order moves nothing --
//      the "leaves a version alone" case the note names.
//
//   B. THE PIN LEDGER, scripts/built-in-set-pins.json: the digest recorded for
//      each version of each named set. Unlike the protocol-version pin, this
//      rule binds from the outset rather than from a first publication, so the
//      ledger ships populated and every run holds the tree to it.
//
// The ledger is keyed by set name and then by version, and is append-only: a
// bump ADDS an entry, so a legitimate bump and an in-place rewrite of a recorded
// version's pin are different diffs. This check cannot tell a legitimate re-pin
// from a rewrite that dodges the bump -- the same limit the pull-request
// checklist's security-review sha has -- so an edit to an already-recorded
// entry is a reviewer's call, not this check's.
//
// What this check cannot see:
//   - Whether the version decision taken was the RIGHT one. It fails content
//     that has moved without a bump, and it fails a bump that records no pin; it
//     cannot judge which semver component a change deserved, nor a bump that was
//     not needed.
//   - The difference between a content change and a cosmetic one below the
//     property level. Renaming a key, or reordering a constraint's `exclude`
//     list, moves the digest. Both fail toward taking the version decision
//     rather than away from it, and a key's name is not cosmetic between the
//     parties: the terms cross-check canonically encodes the key list whole, so
//     two parties whose builds spell a key differently cancel the exchange.
//   - A declaration that is not a literal. The sets are read by evaluating their
//     source initializers, and a declaration that stopped being a plain literal
//     fails rather than being guessed at.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FIELD_SET_DECLARATIONS,
  KEY_SET_DECLARATIONS,
  RULE_SET_SOURCE,
  contentDigest,
  readRuleSetsFrom,
} from "./lib/builtInRuleSets.mjs";

export { RULE_SET_SOURCE };

/** The recorded pin per version of each named set. */
export const PINS_FILE = "scripts/built-in-set-pins.json";

/** The section stating the rule, named by every failure this check reports. */
export const NOTE_SECTION =
  'docs/notes/default-linkage-rule-set.md, "What the versions mean"';

/** What each set's version declaration is called, for a message that names it. */
export const VERSION_DECLARATIONS = {
  fieldSet: FIELD_SET_DECLARATIONS.version,
  keySet: KEY_SET_DECLARATIONS.version,
};

/** What each set's content declaration is called. */
export const CONTENT_DECLARATIONS = {
  fieldSet: FIELD_SET_DECLARATIONS.content,
  keySet: KEY_SET_DECLARATIONS.content,
};

/**
 * The `major.minor.patch` triple a version names, or undefined when the value is
 * not in that shape. These versions order and nothing more -- there is no
 * prerelease channel for a rule set -- so anything past the triple is refused.
 */
export function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(
    typeof version === "string" ? version : "",
  );
  return match === null
    ? undefined
    : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative, zero, or positive as `a` orders before, with, or after `b`. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/**
 * The version a suggested ledger records under: the declared one when the ledger
 * holds no entry for it, the next minor when its entry has moved -- so the
 * printed block is never the in-place rewrite of a recorded pin. Which component
 * a real change deserves is the author's call; this only keeps the suggestion
 * off a version that already means something.
 */
export function suggestionVersion(entry, version) {
  if (entry[version] === undefined) return version;
  const [major, minor] = parseVersion(version);
  return `${major}.${minor + 1}.0`;
}

/**
 * The reasons the recorded pins and the tree do not agree, as `{kind, set,
 * message}`; empty when they agree. `sets` is the two declared sets by role,
 * each `{name, version, digest}`; `pins` is the ledger's entries by set name.
 * `kind` is `record` (no pin is recorded and printing one is the remedy),
 * `moved` (a recorded version's content has moved), or `ledger` (the ledger's
 * own shape is wrong, which no printed pin repairs).
 */
export function pinViolations({ sets, pins }) {
  const violations = [];
  const declaredNames = Object.values(sets).map((set) => set.name);

  for (const name of Object.keys(pins)) {
    if (declaredNames.includes(name)) continue;
    violations.push({
      kind: "ledger",
      set: name,
      message: `${PINS_FILE} records pins for "${name}", which ${RULE_SET_SOURCE} declares no set by. A pin is looked up by exactly the declared set name, so an entry under any other name records content nothing is ever held to. Rename the entry with the set, or drop it.`,
    });
  }

  for (const [role, set] of Object.entries(sets)) {
    const entry = pins[set.name] ?? {};
    const recorded = Object.keys(entry);

    for (const version of recorded) {
      if (parseVersion(version) === undefined) {
        violations.push({
          kind: "ledger",
          set: set.name,
          message: `${PINS_FILE} records a pin for ${set.name} under "${version}", which is not a version. A ledger key is the \`major.minor.patch\` ${VERSION_DECLARATIONS[role]} carries, and a pin is looked up by exactly that string, so a key in any other shape records content nothing is held to.`,
        });
        continue;
      }
      if (compareVersions(version, set.version) > 0) {
        violations.push({
          kind: "ledger",
          set: set.name,
          message: `${PINS_FILE} records a pin for ${set.name} ${version}, above the ${set.version} ${VERSION_DECLARATIONS[role]} declares: a pin names a version the tree shipped, so nothing should be recorded ahead of the source.`,
        });
      }
    }

    const pinned = entry[set.version];
    if (pinned === undefined) {
      const highest = recorded
        .filter((version) => parseVersion(version) !== undefined)
        .sort(compareVersions)
        .at(-1);
      violations.push({
        kind: "record",
        set: set.name,
        message:
          highest === undefined
            ? `${PINS_FILE} records no pin for ${set.name}. Record the pin below; it is the content ${set.name} ${set.version} names, and every later edit to ${CONTENT_DECLARATIONS[role]} takes a bump with its own pin beside it (${NOTE_SECTION}).`
            : `${PINS_FILE} records no pin for ${set.name} ${set.version}, the version ${VERSION_DECLARATIONS[role]} declares. A bump records the content it ships beside it -- record the pin below (${NOTE_SECTION}).`,
      });
    } else if (pinned !== set.digest) {
      violations.push({
        kind: "moved",
        set: set.name,
        message: `${CONTENT_DECLARATIONS[role]} has moved under ${set.name} ${set.version} (recorded ${pinned}, tree ${set.digest}). The recorded validation attaches to a name and a version together, so an edit to a built-in set takes a bump: raise ${VERSION_DECLARATIONS[role]} in ${RULE_SET_SOURCE} and record the new pin beside the earlier ones, or leave the content where it is (${NOTE_SECTION}).`,
      });
    }
  }

  return violations;
}

/** The ledger the tree implies, with each named set's pin added under `versions`. */
export function suggestedLedger(pins, sets, versions) {
  const suggested = { ...pins };
  for (const set of Object.values(sets)) {
    if (versions[set.name] === undefined) continue;
    suggested[set.name] = {
      ...(pins[set.name] ?? {}),
      [versions[set.name]]: set.digest,
    };
  }
  return `${JSON.stringify({ pins: suggested }, null, 2)}\n`;
}

/**
 * Read the tree at `root` and report what the rule holds there, as `{sets, pins,
 * violations, blocked}`. `blocked` holds the reasons the check could not read
 * an input at all, which fail rather than passing as agreement.
 */
export function inspect(root) {
  const blocked = [];
  const { fieldSet, keySet, unreadable } = readRuleSetsFrom(root);
  for (const { declaration, reason } of unreadable) {
    blocked.push(
      declaration === RULE_SET_SOURCE
        ? `${RULE_SET_SOURCE} could not be read: ${reason}. A set this check cannot read is one it cannot pin.`
        : `${RULE_SET_SOURCE}'s \`${declaration}\` could not be read: ${reason}. A set this check cannot read is one it cannot pin.`,
    );
  }

  const sets = {};
  for (const [role, declared] of Object.entries({ fieldSet, keySet })) {
    if (declared === undefined) continue;
    if (parseVersion(declared.version) === undefined) {
      blocked.push(
        `${VERSION_DECLARATIONS[role]} declares "${declared.version}", which is not a \`major.minor.patch\` version, so there is no version to record a pin under.`,
      );
      continue;
    }
    sets[role] = {
      name: declared.name,
      version: declared.version,
      digest: contentDigest(declared.content),
    };
  }

  let pins = {};
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(resolve(root, PINS_FILE), "utf8"));
  } catch {
    ledger = undefined;
  }
  const recorded =
    ledger === null || typeof ledger !== "object" ? undefined : ledger.pins;
  if (
    recorded === null ||
    typeof recorded !== "object" ||
    Array.isArray(recorded)
  ) {
    blocked.push(
      `${PINS_FILE} carries no \`pins\` object this can read, so there is no ledger to hold the tree to.`,
    );
  } else {
    pins = recorded;
  }

  return {
    sets,
    pins,
    violations: blocked.length === 0 ? pinViolations({ sets, pins }) : [],
    blocked,
  };
}

/**
 * One line per set: the name and version a citation of the built-in rules names,
 * and the pin the tree holds for it. Reported on every passing run so what is
 * pinned is read rather than inferred.
 */
export function pinReport(sets) {
  return Object.values(sets).map(
    ({ name, version, digest }) => `  ${name} ${version} -- ${digest}`,
  );
}

// CLI entry: only runs when invoked directly, so the tests can import the pure
// functions without the process.exit. `--root` points the run at another tree,
// which is how the tests drive the edited sets this repository does not have.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootFlag = args.indexOf("--root");
  if (rootFlag !== -1 && args[rootFlag + 1] === undefined) {
    console.error(
      "usage: node scripts/check-built-in-set-versions.mjs [--root <tree>]",
    );
    process.exit(2);
  }
  const root =
    rootFlag === -1
      ? resolve(dirname(fileURLToPath(import.meta.url)), "..")
      : resolve(args[rootFlag + 1]);

  const report = inspect(root);
  if (report.blocked.length > 0) {
    console.error("Built-in rule set version check could not run:\n");
    for (const reason of report.blocked) console.error("  " + reason);
    process.exit(1);
  }

  if (report.violations.length > 0) {
    console.error("Built-in rule set version check failed:\n");
    for (const { message } of report.violations) console.error("  " + message);
    const versions = {};
    for (const { kind, set } of report.violations) {
      if (kind !== "record" && kind !== "moved") continue;
      versions[set] = suggestionVersion(
        report.pins[set] ?? {},
        Object.values(report.sets).find((entry) => entry.name === set).version,
      );
    }
    if (Object.keys(versions).length > 0) {
      console.error(`\nThe ledger ${PINS_FILE} would carry:\n`);
      console.error(suggestedLedger(report.pins, report.sets, versions));
      console.error(
        report.violations.some(({ kind }) => kind === "moved")
          ? `Where the block records a version the source does not yet declare, that is the bump: raise it in ${RULE_SET_SOURCE} to match. Then write the block, run \`npm run format\`, and leave every already-recorded entry as it stands -- an entry rewritten in place records a version that never shipped that content (${NOTE_SECTION}).`
          : `Write it, run \`npm run format\`, and leave every already-recorded entry as it stands: an entry rewritten in place records a version that never shipped that content (${NOTE_SECTION}).`,
      );
    }
    process.exit(1);
  }

  for (const line of pinReport(report.sets)) console.log(line);
  console.log(
    `\nBuilt-in rule set version check passed: each set's content matches what ${PINS_FILE} records for the version ${RULE_SET_SOURCE} declares.`,
  );
}
