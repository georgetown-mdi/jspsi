#!/usr/bin/env node
// Deferred EXCHANGE_RECORD_VERSION bump check, run by static_checks.yaml on
// every PR.
//
// A managed web exchange keeps an accounting of disclosures: one stored value per
// exchange, holding its runs' exchange records verbatim, and the source an
// operator draws a HIPAA 164.528 accounting or a FERPA 99.32 disclosure record
// from (docs/spec/MANAGED_EXCHANGE_RECORD.md, "The accounting of disclosures").
// Every entry was admissible under the record format current when it was written,
// and the reader rejects an unrecognized version rather than migrating it -- so
// moving EXCHANGE_RECORD_VERSION invalidates, on every device holding one, an
// accounting nothing else holds a copy of. The read refuses the whole value, and
// so does the APPEND, which re-reads the accounting inside its own transaction:
// a still-scheduled exchange goes on disclosing and files nothing, unattended,
// with only a completion-screen notice nobody is there to see.
//
// The recovery for that is built (the stored-form export and the
// accounting-scoped reset, offered in that order from the unreadable state), but
// it rests on a premise only the CURRENT format has been driven against: that a
// move invalidates the entries and leaves the accounting envelope readable, so
// the entries come back whole. A premise about a format that does not exist yet
// cannot be tested ahead of the bump, and prose asking a future contributor to
// re-check it is the shape that rots. This is that obligation as a check: inert
// while the literal stands where it is pinned, and failing the move with a
// message naming what to re-take before recording the new value.
//
// Two parts, each read from the tree alone:
//
//   A. THE RECORD VERSION PIN. EXCHANGE_RECORD_VERSION's literal, read out of
//      packages/core/src/exchangeRecord.ts, against RECORD_VERSION_PIN below.
//      Read from the source rather than the built package because this check
//      runs before any build, and a check that silently skipped on a missing
//      dist/ would be inert exactly when it is needed. The pin lives in this
//      file rather than a ledger beside it so that recording a new value is an
//      edit to the check itself -- the diff a reviewer sees, and the moment the
//      decision is taken.
//
//   B. THE RECOVERY PATH'S PRESENCE. Part A defers a decision to a recovery path;
//      a tree that lost that path would pass part A while deferring to nothing.
//      So the entry points the recovery is built on must be declared: the
//      envelope-only parse the export arm needs, the classifying store read that
//      reaches it, and the accounting-scoped delete behind the other arm.
//
// What this check cannot see:
//   - Whether the recovery still WORKS. It reads declarations, not behaviour. The
//     behaviour is held by apps/web/test/unit/disclosureAccounting.test.ts (the
//     envelope-parses/entries-reject split, driven against the real parsers),
//     apps/web/test/browser/managedExchangeStore.test.ts (the read's
//     classification and the reset against real IndexedDB), and
//     apps/web/test/browser/managedExchangeDetail.test.ts (both arms reachable
//     from the unreadable state, in order).
//   - Whether a recorded new pin was recorded after the decision was taken, or
//     instead of taking it. Moving the pin is a one-line edit this check cannot
//     tell from an honest one -- the same limit the pull-request checklist's
//     security-review sha carries -- so it is a reviewer's call, not this
//     check's.
//   - The CLI's record files. The CLI writes a standalone record file per run and
//     accumulates no accounting store, so it holds nothing a bump could strand: a
//     version its build does not recognize is refused at the point of reading the
//     file, with the file still in the operator's hands. The recovery obligation
//     this check defers is the web accounting's alone.
//   - A version literal that is not a literal. It reads the `export const`
//     initializer out of the source and fails rather than guessing when that line
//     does not read as a quoted string.
//   - A tree with no packages/core/src/exchangeRecord.ts in it. That read is
//     deliberately not tolerated, unlike the recovery sources' -- a missing
//     record-version source is a broken checkout rather than a state this check
//     has a diagnostic for.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The exchange-record version the recovery path has been driven against. Moving
 * it here is how the decision this check defers is recorded as taken. */
export const RECORD_VERSION_PIN = "psilink-exchange-record/v6";

/** Where the record version literal is declared. */
export const RECORD_VERSION_SOURCE = "packages/core/src/exchangeRecord.ts";

/** The entry points the recovery from a version-invalidated accounting is built
 * on, per file. Named functions rather than a surface description: a declaration
 * is a fact this check can read, where "the affordance is reachable" is not. */
export const RECOVERY_ENTRY_POINTS = {
  "apps/web/src/psi/disclosureAccounting.ts": [
    "parseStoredDisclosureAccounting",
  ],
  "apps/web/src/psi/disclosureAccountingStore.ts": [
    "readDisclosureAccounting",
    "resetDisclosureAccounting",
  ],
};

/**
 * The exchange-record version literal declared in the given source, or
 * `undefined` when the declaration is not a quoted string this can read.
 */
export function declaredRecordVersion(source) {
  const match = /export const EXCHANGE_RECORD_VERSION\s*=\s*"([^"]*)"/.exec(
    source,
  );
  return match === null ? undefined : match[1];
}

/**
 * The recovery entry points a source does not declare, as `{file, name}` pairs;
 * empty when every one of them is exported from the file that should carry it.
 */
export function missingRecoveryEntryPoints(sources) {
  const missing = [];
  for (const [file, names] of Object.entries(RECOVERY_ENTRY_POINTS)) {
    const source = sources[file] ?? "";
    for (const name of names) {
      const declared = new RegExp(
        `export\\s+(?:async\\s+)?function\\s+${name}\\b`,
      );
      if (!declared.test(source)) missing.push({ file, name });
    }
  }
  return missing;
}

/**
 * The reasons the tree does not stand where this check pins it; empty when the
 * record version is where the recovery was driven against it and the recovery is
 * still there to defer to. Each reason names the obligation rather than only the
 * mismatch, since the point of the failure is the decision, not the diff.
 */
export function bumpViolations(declared, sources) {
  const violations = [];
  if (declared === undefined) {
    violations.push(
      `${RECORD_VERSION_SOURCE}: EXCHANGE_RECORD_VERSION's declaration did not read as a quoted string literal -- the extraction pattern rotted; fix scripts/check-disclosure-recovery.mjs rather than dropping the check.`,
    );
  } else if (declared !== RECORD_VERSION_PIN) {
    violations.push(
      [
        `${RECORD_VERSION_SOURCE}: EXCHANGE_RECORD_VERSION moved from "${RECORD_VERSION_PIN}" to "${declared}".`,
        "",
        "A move invalidates every accounting of disclosures already at rest in a browser: the accounting's read refuses the whole value, and so does the append inside it, so a scheduled exchange goes on disclosing and files nothing. The recovery offered for that state is the stored-form export and the accounting-scoped reset, and its export arm exists only while a move leaves the accounting ENVELOPE readable with the stored entries returned verbatim.",
        "",
        "That premise has been driven against the pinned version and no other. Before recording the new one:",
        "  - re-drive the split against the moved format (apps/web/test/unit/disclosureAccounting.test.ts), so the export arm is known to still have entries to hand over;",
        "  - re-check that both arms are reachable from the unreadable state, in order (apps/web/test/browser/managedExchangeDetail.test.ts);",
        "  - state what the bump does to a stored accounting in docs/spec/MANAGED_EXCHANGE_RECORD.md and docs/MANAGED_EXCHANGE.md if the answer changed;",
        `  - then set RECORD_VERSION_PIN in scripts/check-disclosure-recovery.mjs to "${declared}".`,
      ].join("\n"),
    );
  }
  for (const { file, name } of missingRecoveryEntryPoints(sources)) {
    violations.push(
      `${file}: "${name}" is no longer exported. This check defers a version-bump decision to the recovery path from a version-invalidated accounting of disclosures; without that entry point there is nothing to defer to, and a bump would strand every stored accounting with no way out. Restore it, or retire this check along with the obligation it carries.`,
    );
  }
  return violations;
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const read = (file) => readFileSync(resolve(root, file), "utf8");
  // A recovery source that is gone entirely is the loudest form of the failure
  // this check reports, so it reads as no declarations rather than as an ENOENT:
  // the throw would exit non-zero with the diagnostic lost, which is exactly the
  // tree where naming the missing entry point matters most.
  const readIfPresent = (file) => {
    try {
      return read(file);
    } catch {
      return "";
    }
  };
  const sources = Object.fromEntries(
    Object.keys(RECOVERY_ENTRY_POINTS).map((file) => [
      file,
      readIfPresent(file),
    ]),
  );
  const violations = bumpViolations(
    declaredRecordVersion(read(RECORD_VERSION_SOURCE)),
    sources,
  );
  if (violations.length > 0) {
    for (const violation of violations) console.error(violation);
    process.exit(1);
  }
  console.log(
    `check-disclosure-recovery: EXCHANGE_RECORD_VERSION stands at "${RECORD_VERSION_PIN}", and the recovery path from a version-invalidated accounting is in place.`,
  );
}
