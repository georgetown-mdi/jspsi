#!/usr/bin/env node
// Zero-setup key-field check, run by static_checks.yaml on every PR.
//
// A zero-setup exchange authors no linkage terms. Each party derives them from
// its own input file: getDefaultLinkageTerms keeps a built-in key only when the
// file supplies every field the key's elements name, and the two parties then
// cross-check the terms they derived. So the built-in keys work with no
// authoring for exactly one reason -- every one of them is built from the
// guaranteed-minimum PII both parties are sure to bring, which is what the
// built-in FIELD set is. A key over a field outside that set strands the party
// whose file does not contain it: either the two parties derive different key
// lists and the terms cross-check cancels the exchange, or the key survives over
// a field the terms never declare and the terms are invalid. Neither failure
// names its cause at the point it happens, and both arrive at run time on an
// operator who authored nothing.
//
// docs/notes/default-linkage-rule-set.md's "What zero-setup rests on" states
// the property, and cites this check for it: held by review, it is the shape
// that rots, because the edit that breaks it is one nobody would recognize as
// touching zero-setup at all.
//
// Two things are read from packages/core/src/defaults/linkageTerms.ts and
// nothing is restated: the field set, which IS the guaranteed minimum, and the
// keys held to it. For each element of each key:
//
//   A. Its `field` must name a field the field set declares. This is the
//      invariant proper: a key over `phone_number`, `email_address`, or
//      `zip_code` -- matchable semantic types no built-in field covers -- fails
//      here.
//
//   B. That field's `name` must equal its `type`. The satisfiability filter
//      compares an element's `field` against the semantic TYPES the input file
//      supplies, so a built-in field whose name is not its type names a type no
//      file can offer: every key referencing it is dropped from a zero-setup
//      party's terms no matter which columns that party brings.
//
// What this check cannot see:
//   - Whether a field the set declares is one a party really always holds. It
//     reads the declared set as the guaranteed minimum; widening that set is not
//     silent, because the set's content is pinned by
//     check-built-in-set-versions.mjs and a widening takes a version bump there,
//     but whether the wider set is still guaranteed is a judgment no check
//     makes.
//   - The emitter itself. It reads the two declared sets, not
//     getDefaultLinkageTerms; that the filter binds an element by semantic type
//     -- which is what makes B critical -- is covered by the core suite.
//   - A file that supplies a column of the right type but no usable value. The
//     property here is that the KEYS stay inside the substrate, not that any
//     given file matches on them.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RULE_SET_SOURCE, readRuleSetsFrom } from "./lib/builtInRuleSets.mjs";

export { RULE_SET_SOURCE };

/** The note stating the property, named by every failure this check reports. */
export const NOTE_SECTION =
  'docs/notes/default-linkage-rule-set.md, "What zero-setup rests on"';

/**
 * The reasons a key leaves the field set, as `{kind, message}`; empty when every
 * key stays inside it. `kind` is `outside` (an element names no declared field)
 * or `unbindable` (it names one a zero-setup input can never supply).
 */
export function keyFieldViolations({ fieldSet, keySet }) {
  const declared = new Map(
    fieldSet.content.map((field) => [field.name, field]),
  );
  const violations = [];
  for (const key of keySet.content) {
    for (const element of key.elements) {
      const field = declared.get(element.field);
      if (field === undefined) {
        violations.push({
          kind: "outside",
          message: `Key "${key.name}" of ${keySet.name} matches on \`${element.field}\`, which ${fieldSet.name} does not declare. A zero-setup party derives its terms from its own file, so a built-in key over a field outside the guaranteed minimum strands whoever does not carry it. Build the key from the declared fields, or take the decision to widen ${fieldSet.name} deliberately (${NOTE_SECTION}).`,
        });
      } else if (field.type !== field.name) {
        violations.push({
          kind: "unbindable",
          message: `Key "${key.name}" of ${keySet.name} matches on \`${element.field}\`, which ${fieldSet.name} declares with type \`${field.type}\`. A zero-setup party's input satisfies a key element by semantic TYPE, so a field whose name is not its type is one no file supplies and every key over it is dropped from the derived terms (${NOTE_SECTION}).`,
        });
      }
    }
  }
  return violations;
}

/**
 * Read the tree at `root` and report what the property holds there, as
 * `{fieldSet, keySet, violations, blocked}`. `blocked` contains the reasons the
 * check could not read a declaration at all, which fail rather than passing as
 * an empty set.
 */
export function inspect(root) {
  const { fieldSet, keySet, unreadable } = readRuleSetsFrom(root);
  const blocked = unreadable.map(({ declaration, reason }) =>
    declaration === RULE_SET_SOURCE
      ? `${RULE_SET_SOURCE} could not be read: ${reason}. A set this check cannot read is one it cannot hold anything to.`
      : `${RULE_SET_SOURCE}'s \`${declaration}\` could not be read: ${reason}. A set this check cannot read is one it cannot hold anything to.`,
  );
  return {
    fieldSet,
    keySet,
    violations:
      blocked.length === 0 ? keyFieldViolations({ fieldSet, keySet }) : [],
    blocked,
  };
}

/**
 * One line per field of the guaranteed minimum, and one naming the keys held to
 * it. Reported on every passing run so the substrate the whole property rests on
 * is read rather than inferred.
 */
export function substrateReport({ fieldSet, keySet }) {
  return [
    ...fieldSet.content.map(
      (field) => `  ${fieldSet.name}  ${field.name} -- type ${field.type}`,
    ),
    `  ${keySet.name}  ${keySet.content.length} key${keySet.content.length === 1 ? "" : "s"}, every element inside ${fieldSet.name}`,
  ];
}

// CLI entry: only runs when invoked directly, so the tests can import the pure
// functions without the process.exit. `--root` points the run at another tree,
// which is how the tests drive a set this repository does not hold.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootFlag = args.indexOf("--root");
  if (rootFlag !== -1 && args[rootFlag + 1] === undefined) {
    console.error(
      "usage: node scripts/check-zero-setup-keys.mjs [--root <tree>]",
    );
    process.exit(2);
  }
  const root =
    rootFlag === -1
      ? resolve(dirname(fileURLToPath(import.meta.url)), "..")
      : resolve(args[rootFlag + 1]);

  const report = inspect(root);
  if (report.blocked.length > 0) {
    console.error("Zero-setup key-field check could not run:\n");
    for (const reason of report.blocked) console.error("  " + reason);
    process.exit(1);
  }

  if (report.violations.length > 0) {
    console.error("Zero-setup key-field check failed:\n");
    for (const { message } of report.violations) console.error("  " + message);
    process.exit(1);
  }

  for (const line of substrateReport(report)) console.log(line);
  console.log(
    `\nZero-setup key-field check passed: every element of every ${report.keySet.name} key names a field ${report.fieldSet.name} declares and a zero-setup input can supply by type.`,
  );
}
