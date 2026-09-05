// The command line a deferred-obligation check runs behind: a rule that falls
// due later, inert until a marker moves, holding its own pin constant and its
// own retirement rule.
//
// Two of them read a tree through an `inspect(root)` reporting `{blocked,
// violations}` and can be pointed at another tree: check-protocol-version-bump.mjs
// and check-exchange-record-version.mjs. The argument handling and the two
// failure reports are identical for both, so what a blocked run says, and how a
// failure is laid out, is one edit here rather than one per check.
//
// check-crossws-sbom-block.mjs and check-brace-expansion-override.mjs are the
// same family and are not on this: each reports a single verdict over the
// repository it sits in, with no tree to point elsewhere and no reasons it could
// not run, so it has nothing to read from here.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository this file sits in. */
const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/**
 * The tree a run reads, from its argument tail: `--root <tree>` where the
 * arguments name one, and the repository otherwise. `--root` is how a test
 * drives a state the repository has not reached. One naming no tree exits 2
 * rather than falling back to the repository, since a run that asked for
 * another tree and got this one would report on the wrong tree.
 */
export function obligationRoot(args, script) {
  const flag = args.indexOf("--root");
  if (flag !== -1 && args[flag + 1] === undefined) {
    console.error(`usage: node ${script} [--root <tree>]`);
    process.exit(2);
  }
  return flag === -1 ? REPOSITORY_ROOT : resolve(args[flag + 1]);
}

/**
 * Report the reasons a run could not be made at all, and whether there were
 * any. An input a check could not read leaves its rule neither met nor knowably
 * inert, so a caller exits non-zero on a true return rather than passing.
 */
export function reportBlocked(label, blocked) {
  if (blocked.length === 0) return false;
  console.error(`${label} could not run:\n`);
  for (const reason of blocked) console.error("  " + reason);
  return true;
}

/**
 * Report the ways the tree does not stand where the rule holds it, and whether
 * there were any. Each message is a paragraph naming the obligation, so they
 * are printed one blank line apart.
 */
export function reportViolations(label, violations) {
  if (violations.length === 0) return false;
  console.error(`${label} failed:\n`);
  for (const { message } of violations) console.error(message + "\n");
  return true;
}
