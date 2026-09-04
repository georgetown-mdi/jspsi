#!/usr/bin/env node
// Merge gate identity check, run by static_checks.yaml on every PR.
//
// A branch ruleset names each required status check by a bare context string,
// which GitHub matches against the check runs a pull request produces. Two
// ordinary edits break that match with nothing red to show for it, leaving the
// requirement pending forever and every pull request unmergeable until branch
// protection is edited:
//
//   A. Renaming a job whose `name:` is a required context. The check run the
//      ruleset waits for is never created under that name again.
//   B. Adding a `paths:` / `paths-ignore:` filter to a gating workflow. A pull
//      request touching nothing the filter globs skips the workflow, so its
//      check runs are never created on that pull request at all.
//
// Two rules, one per footgun:
//
//   1. Every required status-check context on main and staging matches a job
//      name under .github/workflows. Reading the rules needs a token, so this
//      rule states a skip -- naming the reason, and raising a run annotation
//      under Actions -- when it has none or the read fails. It never passes
//      silently: a skip says which half did not run.
//   2. The gating workflows in GATING_WORKFLOWS carry no `paths:` or
//      `paths-ignore:` under `on.pull_request`, and do carry that trigger. No
//      API, so this rule runs on every invocation including rule 1's skips.
//
// The rules are read per protected branch rather than per ruleset name, so
// renaming a ruleset does not drop coverage, and the branch endpoint reports
// what every active ruleset contributes to that branch.
//
// What this check cannot see:
//   - Rule 1 compares literal text. A job whose `name:` carries a `${{ }}`
//     expression -- a matrix leg -- is collected but never matched, because
//     resolving one means reimplementing the expansion GitHub performs. A
//     required context satisfied by such a job fails here rather than passing
//     on a guess; the failure names the templated jobs so the reason is legible.
//   - It matches names, not runs. That a job with the right name exists says
//     nothing about whether the workflow holding it runs on a pull request to
//     the protected branch, or whether the run succeeds. Rule 2 covers that
//     question for the workflows GATING_WORKFLOWS names and for no others.
//   - A job calling a reusable workflow produces composed check-run names
//     (`caller / callee`); only the caller's own name is collected here.
//   - Rule 2's scope is the hand-held GATING_WORKFLOWS list rather than the
//     branch rules. Rule 1 reads the required contexts but never maps one back
//     to the workflow declaring its job, so making a job in an unlisted
//     workflow required leaves that workflow's path filters unread here: the
//     list has to grow with the merge gate. Mapping a context back would need
//     one declaring file per name, which nothing constrains: two workflows may
//     declare the same job name, and which of their check runs satisfies the
//     requirement is GitHub's resolution to make rather than one to infer here.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  WORKFLOW_DIR,
  parseWorkflow,
  readWorkflows,
  workflowSource,
} from "./lib/workflows.mjs";

/** The branches whose rulesets carry the merge gate. */
export const PROTECTED_BRANCHES = ["main", "staging"];

/**
 * The workflows rule 2 holds filter-free: every file declaring a job the branch
 * rules require a status check from. Each is deliberately unfiltered, and the
 * header comment in each says why and points back here. Making a job in some
 * other workflow required means adding that workflow here in the same edit --
 * nothing derives this list, so nothing else notices it went short.
 */
export const GATING_WORKFLOWS = [
  `${WORKFLOW_DIR}/codeql.yaml`,
  `${WORKFLOW_DIR}/dependency_review.yaml`,
  `${WORKFLOW_DIR}/native_alpine.yaml`,
  `${WORKFLOW_DIR}/static_checks.yaml`,
];

/**
 * The GitHub Actions app. A required context attributed to any other app is
 * raised by that app rather than by a workflow job, so rule 1 reports it instead
 * of matching it. Re-derive with `gh api /apps/github-actions --jq .id`.
 */
export const GITHUB_ACTIONS_APP_ID = 15368;

const API_ROOT = "https://api.github.com";

/**
 * The check-run name of every job a parsed workflow declares, with whether the
 * name is one a required context can literally match. A job with no `name:`
 * runs under its job id, so the id stands in -- unless the job carries a
 * matrix, whose nameless check runs render as "<id> (<matrix values>)" and
 * never the bare id.
 */
export function jobCheckNames(workflow) {
  const jobs = workflow?.jobs;
  if (jobs === null || typeof jobs !== "object") return [];
  return Object.entries(jobs).map(([id, job]) => {
    const named = typeof job?.name === "string";
    const name = named ? job.name : id;
    const namelessMatrix = !named && job?.strategy?.matrix !== undefined;
    return { name, templated: name.includes("${{") || namelessMatrix };
  });
}

/**
 * Every job name the workflow tree declares: `literal` is the set a context can
 * be matched against, `templated` the `{file, name}` pairs carrying an
 * expression or a nameless matrix expansion, which no context can match here.
 */
export function workflowJobIndex(root) {
  const literal = new Set();
  const templated = [];
  for (const { path: file, source } of readWorkflows(root)) {
    for (const { name, templated: isTemplated } of jobCheckNames(
      parseWorkflow(file, source),
    )) {
      if (isTemplated) templated.push({ file, name });
      else literal.add(name);
    }
  }
  return { literal, templated };
}

/**
 * The `owner/repo` slug a git remote URL names, or null when it names no
 * github.com repository. Both remote spellings resolve: the `git@host:slug` scp
 * form and a `https://` / `ssh://` URL, with or without the `.git` suffix.
 */
export function parseRepositorySlug(remoteUrl) {
  const match =
    /^(?:(?:https?|ssh|git):\/\/)?(?:[^@/]+@)?github\.com[:/](?<slug>[^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(
      String(remoteUrl ?? "").trim(),
    );
  return match ? match.groups.slug : null;
}

function originSlug(cwd) {
  try {
    return parseRepositorySlug(
      execFileSync("git", ["config", "--get", "remote.origin.url"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return null;
  }
}

/**
 * The branch-rule documents GitHub reports for one branch, as `{rules}`, or
 * `{reason}` naming why the read did not happen. Every failure mode -- an
 * unusable token, a transport error, a body that is not a rule array -- comes
 * back as a reason rather than a throw, so the caller can state the skip.
 */
export async function fetchBranchRules({
  slug,
  branch,
  token,
  fetchImpl = fetch,
}) {
  const url = `${API_ROOT}/repos/${slug}/rules/branches/${encodeURIComponent(branch)}`;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "psilink-check-merge-gate-identities",
        "x-github-api-version": "2022-11-28",
      },
    });
  } catch (cause) {
    return { rules: null, reason: `${url} could not be reached: ${cause}` };
  }
  if (!response.ok) {
    return {
      rules: null,
      reason: `${url} answered HTTP ${response.status} -- the token cannot read this repository's branch rules`,
    };
  }
  let body;
  try {
    body = await response.json();
  } catch (cause) {
    return {
      rules: null,
      reason: `${url} answered unparseable JSON: ${cause}`,
    };
  }
  if (!Array.isArray(body)) {
    return {
      rules: null,
      reason: `${url} answered a ${typeof body} where a rule array was expected`,
    };
  }
  return { rules: body, reason: null };
}

/**
 * The required status-check contexts one branch's rules carry, as
 * `{branch, context, integrationId}` triples. An entry naming no integration
 * gets a null id: GitHub accepts such a context from any app.
 */
export function branchRequiredContexts(branch, rules) {
  return rules
    .filter((rule) => rule?.type === "required_status_checks")
    .flatMap((rule) => rule?.parameters?.required_status_checks ?? [])
    .filter((check) => typeof check?.context === "string")
    .map((check) => ({
      branch,
      context: check.context,
      integrationId: check.integration_id ?? null,
    }));
}

/**
 * The same contexts keyed once each, carrying every branch that requires them,
 * so a context both rulesets share is reported once rather than per branch.
 */
export function mergeContexts(contexts) {
  const merged = new Map();
  for (const { branch, context, integrationId } of contexts) {
    const key = `${integrationId}\0${context}`;
    const seen = merged.get(key);
    if (seen) seen.branches.push(branch);
    else merged.set(key, { context, integrationId, branches: [branch] });
  }
  return [...merged.values()];
}

const isForeignContext = ({ integrationId }) =>
  integrationId !== null && integrationId !== GITHUB_ACTIONS_APP_ID;

/** The merged contexts a workflow job cannot raise, because another app does. */
export function foreignContexts(merged) {
  return merged.filter(isForeignContext);
}

const list = (values) => values.join(", ");

/**
 * Every way the merge gate's required contexts and the workflow job names can
 * be out of step, as message strings. Empty means each context an Actions job is
 * expected to raise names a job that exists.
 */
export function contextViolations(merged, index) {
  const violations = [];
  for (const branch of PROTECTED_BRANCHES) {
    if (merged.some((entry) => entry.branches.includes(branch))) continue;
    violations.push(
      `${branch}: the branch rules carry no required status checks -- the merge gate is gone from that branch, or the API response shape changed. A fork carrying no rulesets of its own reads the same way; set GITHUB_REPOSITORY to the upstream repository to check its gate instead.`,
    );
  }

  for (const entry of merged) {
    if (isForeignContext(entry)) continue;
    const { context, integrationId, branches: required } = entry;
    if (index.literal.has(context)) continue;
    const unattributed =
      integrationId === null
        ? " The ruleset entry names no app, so any app may satisfy it; if one other than GitHub Actions raises this context, pin that app on the entry so this check can tell it from a job name."
        : "";
    violations.push(
      `${list(required)}: the branch rules require the status check "${context}", which matches no job name under ${WORKFLOW_DIR} -- no check run is ever created under that name, so the requirement holds every pull request pending until branch protection is edited. Rename the job back to "${context}", or update the required context to the job's current name.${unattributed}`,
    );
  }

  if (violations.length > 0 && index.templated.length > 0) {
    violations.push(
      `Job names carrying a \${{ }} expression are not matched textually and cannot satisfy a required context here: ${list(
        index.templated.map(({ name, file }) => `"${name}" (${file})`),
      )}.`,
    );
  }
  return violations;
}

/**
 * A parsed workflow's `on.pull_request` trigger: whether it is declared at all,
 * and which path-filter keys it carries.
 */
export function pullRequestTrigger(workflow) {
  const on = workflow?.on;
  // The `on: pull_request` scalar and `on: [push, pull_request]` array
  // shorthands declare the trigger with no filter surface at all.
  if (on === "pull_request") return { declared: true, filters: [] };
  if (Array.isArray(on))
    return { declared: on.includes("pull_request"), filters: [] };
  const pullRequest = on?.pull_request;
  if (pullRequest === undefined) return { declared: false, filters: [] };
  if (pullRequest === null || typeof pullRequest !== "object") {
    return { declared: true, filters: [] };
  }
  return {
    declared: true,
    filters: ["paths", "paths-ignore"].filter((key) => key in pullRequest),
  };
}

/**
 * Every way a gating workflow's pull-request trigger can fail to run on some
 * pull request. Empty means each named file declares the trigger and filters
 * nothing out of it.
 */
export function pathFilterViolations(root, files = GATING_WORKFLOWS) {
  const violations = [];
  for (const file of files) {
    const absolute = resolve(root, file);
    if (!existsSync(absolute)) {
      violations.push(
        `${file} is named as a gating workflow but does not exist -- point GATING_WORKFLOWS in scripts/check-merge-gate-identities.mjs at the file's current path.`,
      );
      continue;
    }
    const { declared, filters } = pullRequestTrigger(
      parseWorkflow(file, workflowSource(root, file)),
    );
    if (!declared) {
      violations.push(
        `${file} declares no on.pull_request trigger, so it raises no check run on a pull request at all and any required context naming one of its jobs holds every pull request pending.`,
      );
      continue;
    }
    for (const key of filters) {
      violations.push(
        `${file} filters its pull_request trigger with ${key}: -- a pull request touching nothing it matches skips the workflow, its check runs are never created, and a required context naming one of its jobs holds that pull request pending forever. A gating workflow runs on every pull request; scope the work inside its jobs instead.`,
      );
    }
  }
  return violations;
}

/**
 * The merged required contexts of every protected branch, or a `skipped` reason
 * naming why they could not be read. The token is whatever the environment
 * offers; the repository is `GITHUB_REPOSITORY` under Actions and the origin
 * remote otherwise.
 */
export async function readRequiredContexts({
  env = process.env,
  cwd,
  fetchImpl = fetch,
} = {}) {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (!token) {
    return {
      merged: null,
      skipped:
        "neither GH_TOKEN nor GITHUB_TOKEN is set, and reading a branch's rules needs a token with repository metadata read",
    };
  }
  const slug = env.GITHUB_REPOSITORY || originSlug(cwd);
  if (!slug) {
    return {
      merged: null,
      skipped:
        "no repository to read: GITHUB_REPOSITORY is unset and the origin remote names no github.com repository",
    };
  }
  const contexts = [];
  for (const branch of PROTECTED_BRANCHES) {
    const { rules, reason } = await fetchBranchRules({
      slug,
      branch,
      token,
      fetchImpl,
    });
    if (rules === null) return { merged: null, skipped: reason };
    contexts.push(...branchRequiredContexts(branch, rules));
  }
  return { merged: mergeContexts(contexts), skipped: null };
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const index = workflowJobIndex(root);
  if (index.literal.size === 0 && index.templated.length === 0) {
    console.error(
      `${WORKFLOW_DIR}: no jobs matched in any workflow -- the extraction rotted; fix scripts/check-merge-gate-identities.mjs`,
    );
    process.exit(1);
  }

  // Stated before the rules are judged, so the skip is on the record even when
  // the path-filter rule that still ran goes on to fail.
  const { merged, skipped } = await readRequiredContexts({ cwd: root });
  if (skipped !== null) {
    const stated = `Merge gate identities: the required-context rule was SKIPPED -- ${skipped}. The pull_request path-filter rule still ran.`;
    if (process.env.GITHUB_ACTIONS === "true") {
      console.log(`::warning title=Merge gate identities::${stated}`);
    }
    console.log(stated);
  }

  const violations = merged === null ? [] : contextViolations(merged, index);
  violations.push(...pathFilterViolations(root));
  if (violations.length > 0) {
    for (const violation of violations) console.error(violation);
    process.exit(1);
  }

  if (merged === null) {
    console.log(
      `Path-filter rule passed: ${list(GATING_WORKFLOWS)} carry no pull_request path filter.`,
    );
  } else {
    const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;
    const foreign = foreignContexts(merged);
    const raisedElsewhere =
      foreign.length === 0
        ? ""
        : ` ${plural(foreign.length, "required context")} raised by an app other than GitHub Actions matched against no job name here: ${list(
            foreign.map(
              ({ context, integrationId }) =>
                `"${context}" (app ${integrationId})`,
            ),
          )}.`;
    console.log(
      `Merge gate identities check passed: ${plural(merged.length - foreign.length, "required context")} across ${list(PROTECTED_BRANCHES)} match a job name under ${WORKFLOW_DIR}, and ${list(GATING_WORKFLOWS)} carry no pull_request path filter.${raisedElsewhere}`,
    );
  }
}
