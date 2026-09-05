#!/usr/bin/env node
// crossws SBOM block clear-trigger check, run by static_checks.yaml on every
// PR.
//
// Release step 9's full-scope CycloneDX SBOM command refuses unflagged on an
// unsatisfiable `crossws` optional peer (docs/spec/DEPENDENCY_PINS.md, "The
// crossws peer conflict blocks the release SBOM"), so docs/RELEASES.md runs it
// with `--legacy-peer-deps` as a workaround. That workaround is only justified
// while the unflagged command still refuses; once upstream converges and the
// unflagged command starts succeeding, the flag, its cost note in
// docs/RELEASES.md, and the crossws section of DEPENDENCY_PINS.md are all dead
// weight that nothing else here watches for. A revisit trigger left to prose
// -- "re-check after a bump" -- depends on someone remembering to run the
// check by hand on the right pull request, which is not a property a build
// gate should rest on.
//
// So this fails once the unflagged command succeeds while docs/RELEASES.md
// still prescribes the flag -- the one state in which the doc and the
// workaround have drifted out of step. It passes in both states the drift
// bounds: today's, where the unflagged command still refuses and the flag is
// justified, and the post-cleanup one, where the unflagged command succeeds
// and the docs do not include the flag. A passing message names only the state
// it observed: reading an absent flag as "no longer prescribed" would claim a
// history this check has no way to see, since it cannot tell that state from
// one where the flag was never adopted.
//
// This answers "does npm's own tree-validity check still refuse this command"
// by running the command, never by modeling npm's peer resolution or hoisting
// (CLAUDE.md: an external tool's behavior is settled by driving the tool). The
// command runs `--package-lock-only`, which resolves from the committed
// lockfile alone -- confirmed by running it with an unreachable registry
// configured and zero fetch retries, which reproduced the same crossws
// refusal in well under a second, so this check is deterministic on a clean
// checkout and a registry outage cannot redden an unrelated pull request.
//
// What this check does not cover:
//   - It does not distinguish a crossws-specific refusal from any other reason
//     the unflagged command might fail (a different peer conflict, a timeout
//     under SBOM_TIMEOUT_MS below). Both read as "still blocked", which keeps
//     the check passing rather than manufacturing a false "cleared" verdict --
//     the cost is that a *different* new conflict is treated as this one still
//     standing rather than as its own finding.
//   - It reads docs/RELEASES.md's step 9 section for the literal
//     `--legacy-peer-deps` token, not the command's full spelling, so a reword
//     of the paragraphs around the command does not retrigger it. Any
//     occurrence in that section counts, the flag's cost note included, so the
//     flag is treated as prescribed until the whole cleanup the failure message
//     asks for -- flag and cost note together -- is done.
//   - It evaluates the exact SBOM_ARGS below. A step 9 that changes its scoping
//     workspaces or its `--omit`/`--sbom-format` flags needs this file's
//     SBOM_ARGS kept in step, which nothing else enforces.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The release step 9 heading in docs/RELEASES.md, read as this section's anchor. */
export const STEP_9_HEADING = "### 9. Generate and attach the SBOM";

/** Any heading that closes the step 9 section, so only its own prose is read. */
const NEXT_HEADING = /\n#{2,3} /;

/** The workaround flag this check watches for. */
export const LEGACY_PEER_DEPS_FLAG = "--legacy-peer-deps";

/**
 * The unflagged, full-scope release step 9 SBOM command, as argv. Kept beside
 * SBOM_COMMAND so the command this check runs and the command a contributor
 * would type cannot drift apart.
 */
export const SBOM_ARGS = [
  "sbom",
  "--sbom-format",
  "cyclonedx",
  "--package-lock-only",
  "--omit=dev",
  "-w",
  "packages/core",
  "-w",
  "apps/cli",
  "-w",
  "apps/web",
];

/** The unflagged step 9 command, as a contributor would type it. */
export const SBOM_COMMAND = ["npm", ...SBOM_ARGS].join(" ");

/** Generous against the ~0.4s this command measures at; bounds a hung process. */
const SBOM_TIMEOUT_MS = 30_000;

/**
 * Whether the step 9 section of a docs/RELEASES.md source still prescribes
 * `--legacy-peer-deps`, or `null` when the section heading itself cannot be
 * found. A doc that has drifted enough to lose its own anchor is read as "this
 * check cannot answer" rather than silently as either verdict.
 */
export function releasesPrescribesFlag(releasesSource) {
  const start = releasesSource.indexOf(STEP_9_HEADING);
  if (start === -1) return null;
  const rest = releasesSource.slice(start + STEP_9_HEADING.length);
  const nextHeading = rest.match(NEXT_HEADING);
  const section =
    nextHeading === null ? rest : rest.slice(0, nextHeading.index);
  return section.includes(LEGACY_PEER_DEPS_FLAG);
}

/**
 * Runs the real, unflagged step 9 SBOM command against `root`'s committed
 * lockfile. Resolves from the lockfile alone (`--package-lock-only`), so it
 * never reaches the registry. Throws (with stdout/stderr attached) on a
 * non-zero exit; callers read success from whether this throws.
 */
export function runUnflaggedSbom(root) {
  execFileSync("npm", SBOM_ARGS, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: SBOM_TIMEOUT_MS,
  });
}

const CLEANUP_MESSAGE = [
  "The crossws peer conflict has cleared -- the unflagged release step 9 SBOM",
  `command ("${SBOM_COMMAND}") now succeeds -- but docs/RELEASES.md still`,
  `prescribes \`${LEGACY_PEER_DEPS_FLAG}\`. Re-run step 9 unflagged to confirm`,
  "it, drop the flag and its cost note from docs/RELEASES.md, retire the",
  "crossws section of docs/spec/DEPENDENCY_PINS.md, and re-check the SBOM",
  "section's hoisting residual in the same pass.",
].join(" ");

const unreadableDocMessage = () =>
  [
    `docs/RELEASES.md carries no "${STEP_9_HEADING}" heading, so this check`,
    "cannot tell whether the flag is still prescribed. Update STEP_9_HEADING in",
    "scripts/check-crossws-sbom-block.mjs to match wherever the step moved.",
  ].join(" ");

/**
 * The check's verdict over whether the unflagged command succeeded and
 * whether docs/RELEASES.md still prescribes the flag: `{ok, message}`.
 */
export function assess({ unflaggedSucceeded, flagPrescribed }) {
  if (flagPrescribed === null) {
    return { ok: false, message: unreadableDocMessage() };
  }
  if (unflaggedSucceeded && flagPrescribed) {
    return { ok: false, message: CLEANUP_MESSAGE };
  }
  const commandState = unflaggedSucceeded
    ? "the unflagged release step 9 SBOM command succeeds"
    : "the unflagged release step 9 SBOM command still refuses on the crossws peer conflict";
  const docState = flagPrescribed
    ? `docs/RELEASES.md still prescribes \`${LEGACY_PEER_DEPS_FLAG}\``
    : `docs/RELEASES.md does not prescribe \`${LEGACY_PEER_DEPS_FLAG}\``;
  return {
    ok: true,
    message: `${commandState[0].toUpperCase()}${commandState.slice(1)}, and ${docState}.`,
  };
}

/**
 * Reads docs/RELEASES.md under `root` (or takes `releasesSource` directly, for
 * a test) and drives `runSbom` (real by default, injectable for a test) to
 * reach the verdict above.
 */
export function checkCrossbomBlock({
  root,
  runSbom = runUnflaggedSbom,
  releasesSource,
} = {}) {
  const source =
    releasesSource ?? readFileSync(resolve(root, "docs/RELEASES.md"), "utf8");
  const flagPrescribed = releasesPrescribesFlag(source);
  let unflaggedSucceeded = true;
  try {
    runSbom(root);
  } catch {
    unflaggedSucceeded = false;
  }
  return assess({ unflaggedSucceeded, flagPrescribed });
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { ok, message } = checkCrossbomBlock({ root });
  (ok ? console.log : console.error)(
    `crossws SBOM block check ${ok ? "passed" : "failed"}: ${message}`,
  );
  if (!ok) process.exit(1);
}
