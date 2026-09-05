#!/usr/bin/env node
// The repository-wide check runner behind `npm run check:all`, and the one list
// the checks are named on.
//
// static_checks.yaml's `repo-guards` job is where a repository-wide obligation
// gets gated: it has no path filter, and the merge-gating workflows beside
// it are each scoped to one concern (code scanning, dependency review, the
// Alpine native build). So the set only grows. CHECKS below is that set, a line
// per check, and the job is a single step invoking this runner -- which is also
// the command a contributor runs before pushing, rather than meeting a check
// when CI reddens. Each check's reasoning stays in its own script header; the
// line here says what the check holds, not why.
//
// Serial, and it does not stop at the first failure. Serial because two of the
// checks regenerate a file in the working tree and restore it (check:routetree
// rewrites apps/web/src/routeTree.gen.ts, check:vectors the known-answer
// vectors), so nothing else may read those paths while they run. It runs past a
// failure so one red check does not hide the state of the rest: the summary
// names every failure, and the exit code is 1 if there was one.
//
// The typecheck/lint/format trio is not here by design. It has its own
// required-status-check identity (`Typecheck, Lint, Format`), kept separate so
// the context on the merge gate's critical path is the one a contributor
// iterates on; CONTRIBUTING.md names it beside this command.
//
// OUT_OF_CHECK_ALL holds the checks that stay off the list, each with what puts
// it there: a check needing the network, a token, a release trigger, or CI's own
// install cannot run from a plain checkout, and one whose cost is measured in
// minutes does not belong on the unfiltered merge path.
// scripts/run-checks.test.mjs holds every `check:*` script in the root
// package.json to one list or the other, so a new check cannot be added without
// being classified, and holds the repo-guards job to this one step plus the
// dependency audit.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The checks `npm run check:all` runs, in order. `script` is a root
 * package.json script name; `description` states in one line what the check
 * holds.
 */
export const CHECKS = [
  {
    script: "linkcheck",
    description:
      "Every Markdown link target and heading anchor across the repository resolves.",
  },
  {
    script: "check:contributing",
    description:
      "CONTRIBUTING.md stays a quickstart: no heading outside its allowlist, no node_modules/ source path.",
  },
  {
    script: "check:claudemd-budget",
    description:
      "CLAUDE.md stays under the byte budget every agent session pays to load it, so a new rule relocates its own weight.",
  },
  {
    script: "check:command-inventory",
    description:
      "Every CLI subcommand the parser registers is named in docs/DESIGN.md and docs/CLI.md.",
  },
  {
    script: "check:image-capabilities",
    description:
      "Every psilink argument vector the file-drop support scripts use has an image_smoke.yaml capability gate exercising it.",
  },
  {
    script: "check:enforcement-claims",
    description:
      "Every CLAUDE.md enforcement claim names a hook that exists, is registered, and matches the tool the rule is about, and every hook has a test.",
  },
  {
    script: "check:egress-claims",
    description:
      "No absolute URL literal in shipped source outside the reasoned allowlist, which is what PRIVACY.md's no-egress statement rests on.",
  },
  {
    script: "check:workflow-agent-models",
    description:
      "Every agent() call in a committed Workflow script pins a literal model tier rather than inheriting the session model.",
  },
  {
    script: "check:workflow-args-resolve",
    description:
      "Every committed Workflow script reads its arguments through resolveWorkflowArgs, which fails closed on a shape it cannot use.",
  },
  {
    script: "check:action-pin-drift",
    description:
      "Every action pin in .github/actions is mirrored by one in .github/workflows, the path Dependabot is configured against.",
  },
  {
    script: "check:merge-gate-identities",
    description:
      "No gating job is renamed out from under the required check that names it, and no path filter is added to a gating workflow. The branch-rule half needs a token and states a skip without one.",
  },
  {
    script: "check:dependabot-ignore-shape",
    description:
      "Every github-actions pin under a within-major Dependabot ignore floats within its major, so the ignore does not freeze it.",
  },
  {
    script: "check:dependabot-pin-coverage",
    description:
      "Every package with an upgrade checklist in docs/spec/DEPENDENCY_PINS.md is excluded from the batched npm Dependabot groups.",
  },
  {
    script: "check:brace-expansion-override",
    description:
      "The root brace-expansion override still overrules a range the committed lockfile declares.",
  },
  {
    script: "check:crossws-sbom-block",
    description:
      "The release SBOM's crossws workaround is still needed: the unflagged command docs/RELEASES.md documents still refuses.",
  },
  {
    script: "check:nested-root-package",
    description:
      "No package the committed lockfile installs at the root is also installed under a workspace.",
  },
  {
    script: "check:routetree",
    description:
      "The checked-in apps/web/src/routeTree.gen.ts matches what the pinned generator produces.",
  },
  {
    script: "check:web-config-native-load",
    description:
      "apps/web/vite.config.ts and its import graph load under the strip-only type stripping Vite's native config loader and a plain node import use.",
  },
  {
    script: "check:nitro-websocket-unset",
    description:
      "Nitro's experimental.websocket stays off, so nothing attaches a second upgrade listener beside the signaling route.",
  },
  {
    script: "check:vectors",
    description:
      "Every known-answer vector under packages/core/test/vectors/ still reproduces from its generator.",
  },
  {
    script: "check:protocol-version-bump",
    description:
      "A wire-format change from the first published release onward moves PROTOCOL_VERSION.",
  },
  {
    script: "check:exchange-record-version",
    description:
      "EXCHANGE_RECORD_VERSION stands where the disclosure-accounting recovery was driven against it, and is the reset value at and above the release marker apps/cli/package.json states, not below.",
  },
  {
    script: "check:stun-default-claims",
    description:
      "Every hand-written copy of the WebRTC library's built-in STUN default matches the one constant the CLI measures against the library.",
  },
  {
    script: "check:webrtc-provider-options-unread",
    description:
      "No WebRTC transport or entry point on either side reads connection.provider_options, which the spec states is inert on that channel.",
  },
  {
    script: "check:zero-setup-keys",
    description:
      "Every built-in linkage key is built from the built-in field set, so a zero-setup exchange strands no party over a field its file lacks.",
  },
  {
    script: "check:built-in-set-versions",
    description:
      "The built-in field set and key set match the pin recorded for the version each declares, cascade order included.",
  },
  {
    script: "check:release-signing",
    description:
      "The cosign verify command docs/RELEASES.md publishes, the release workflow's self-verify step, and the publish sequence name one release identity.",
  },
  {
    script: "test:scripts",
    description:
      "The vitest projects outside the workspaces: scripts/, .claude/scripts/, the hooks, and the harness.",
  },
];

/**
 * The checks `npm run check:all` does not run, each with what keeps it off the
 * list. A `check:*` script belongs here or in CHECKS; nothing else.
 */
export const OUT_OF_CHECK_ALL = [
  {
    script: "check:pr-checklist",
    reason:
      "Reads the pull request's body and head sha from the API, so it needs a token and a pull request. Run by pr_checklist.yaml.",
  },
  {
    script: "check:release-version",
    reason:
      "Reads the version out of the pushed release tag the run was triggered by, which a plain checkout does not have. Run by release.yaml.",
  },
  {
    script: "check:prebuild-provenance",
    reason:
      "Run by .github/actions/setup ahead of every install in every workflow, and reaches `gh attestation verify` and the network once arming is switched on.",
  },
  {
    script: "check:deploy-trigger-graph",
    reason:
      "Reads the deployed import graph out of a full apps/web production build, minutes the merge path does not have. Run by eb_build_and_test.yaml, path-filtered to the changes that can move that graph.",
  },
  {
    script: "test:mutation",
    reason:
      "A minutes-long corpus kept off the merge path by design: nightly_mutation.yaml runs it on a schedule and a manual dispatch, never on a push or a pull request.",
  },
];

/**
 * The commands the `repo-guards` job may run beside `npm run check:all`, and
 * why each stays a step of its own. Held against the workflow by the test
 * beside this file.
 *
 */
export const SEPARATE_WORKFLOW_STEPS = [
  {
    command: "npm run audit:production",
    reason:
      "Reaches the npm registry's advisory endpoint, so it does not run from an offline checkout, and it runs last so an advisory standing open over the production tree does not mask the guards' results.",
  },
];

/** Absolute path of the repository this file sits in. */
export function repositoryRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** The root package.json's `scripts` block. */
export function rootScripts(root = repositoryRoot()) {
  return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
    .scripts;
}

/**
 * Runs one check and reports how it went.
 *
 */
function runCheck(check, root) {
  const startedAt = Date.now();
  const result = spawnSync("npm", ["run", check.script], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return {
    script: check.script,
    ok: result.status === 0,
    seconds: (Date.now() - startedAt) / 1000,
  };
}

/**
 * Runs every check in CHECKS, in order, past any failure. Returns each result
 * in the order run.
 *
 */
export function runAll(root, log = console.log) {
  const results = [];
  for (const [index, check] of CHECKS.entries()) {
    log(`\n[${index + 1}/${CHECKS.length}] ${check.script}`);
    log(`  ${check.description}`);
    results.push(runCheck(check, root));
  }
  return results;
}

/**
 * Formats the closing summary: one line per check, then the failures.
 *
 */
export function summarize(results) {
  const width = Math.max(...results.map((result) => result.script.length));
  const lines = results.map(
    (result) =>
      `  ${result.ok ? "pass" : "FAIL"}  ${result.script.padEnd(width)}  ${result.seconds.toFixed(1)}s`,
  );
  const total = results.reduce((sum, result) => sum + result.seconds, 0);
  const failed = results.filter((result) => !result.ok);
  lines.push(
    `\n${results.length - failed.length} of ${results.length} checks passed in ${total.toFixed(1)}s.`,
  );
  if (failed.length > 0) {
    lines.push(
      `Failed: ${failed.map((result) => result.script).join(", ")}. Each check's output is above, and its reasoning is in its own script header.`,
    );
  }
  return lines.join("\n");
}

/**
 * Formats the `--list` inventory: what runs, then what does not and why.
 *
 */
export function inventory() {
  const lines = [`${CHECKS.length} checks run by \`npm run check:all\`:\n`];
  for (const check of CHECKS) {
    lines.push(`  ${check.script}\n    ${check.description}`);
  }
  lines.push("\nNot run by it:\n");
  for (const check of OUT_OF_CHECK_ALL) {
    lines.push(`  ${check.script}\n    ${check.reason}`);
  }
  for (const step of SEPARATE_WORKFLOW_STEPS) {
    lines.push(`  ${step.command}\n    ${step.reason}`);
  }
  return lines.join("\n");
}

// Only runs when invoked directly, so the test can import the list and the pure
// functions without running the checks.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--list")) {
    console.log(inventory());
  } else {
    const results = runAll(repositoryRoot());
    const summary = summarize(results);
    const failed = results.some((result) => !result.ok);
    (failed ? console.error : console.log)(`\n${summary}`);
    if (failed) process.exit(1);
  }
}
