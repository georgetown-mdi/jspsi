#!/usr/bin/env node
// Checkout ref override check, run by static_checks.yaml on every PR.
//
// The rebase re-attestation route (.claude/commands/assess-review.md, Step 4,
// argued in docs/notes/rebase-reattestation.md) re-attests a review across a
// rebase with no fresh round. What covers the composition it does not read is
// mechanical: the pull-request gates re-run at the new head, against the head
// merged with the base tip. That is what actions/checkout produces on a
// `pull_request` event when the step names no ref of its own, and this check is
// what holds the repository to it.
//
// The rule: in a workflow triggered by `pull_request` or `pull_request_target`,
// no `actions/checkout` step sets `ref` or `sha` under `with:`.
//
// The rule is flat in three places where a narrower one would need judgment:
//
//   - A `ref` spelling out the expression the action would default to anyway
//     still fails. Deciding that two refs agree means evaluating an expression
//     against an event payload, so the rule is that the step names none.
//   - actions/checkout has no `sha` input, so a `sha:` key supplies the action
//     nothing. It states the same intent as a `ref`, and it fails here rather
//     than passing on the ground that it happens to be inert.
//   - `pull_request_target` is held to the same rule, though its own checkout
//     default is the base branch rather than the merge result. A run under that
//     event does not cover the merge result either way, and a ref there is the
//     one shape that makes it look as though it might.
//
// What this check cannot see:
//   - A checkout by any route other than an `actions/checkout` step: a `run:`
//     line invoking git, or a fork of the action under a different name.
//   - A composite action or a reusable workflow that a pull-request-triggered
//     workflow calls. Only the files under .github/workflows are read, and a
//     checkout inside a called definition is outside the rule.
//   - Whether a run in fact built the merge result. This holds one property of
//     the committed tree and confirms nothing about any run.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  WORKFLOW_DIR,
  parseActionReference,
  parseWorkflow,
  readWorkflows,
  usesNodes,
} from "./lib/workflows.mjs";

const CHECKOUT = "actions/checkout";
const PULL_REQUEST_TRIGGERS = ["pull_request", "pull_request_target"];
const OVERRIDE_KEYS = ["ref", "sha"];

/**
 * The trigger names a parsed workflow declares, or null when its `on:` block
 * has a shape this check cannot read: a mapping, a list of names, and a single
 * name are the three GitHub accepts.
 */
export function triggerNames(document) {
  const on =
    document === null || typeof document !== "object" ? undefined : document.on;
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) {
    return on.every((name) => typeof name === "string") ? on : null;
  }
  if (on !== null && typeof on === "object") return Object.keys(on);
  return null;
}

const isCheckout = (uses) => {
  const reference = parseActionReference(uses);
  return reference !== null && reference.name.trim().toLowerCase() === CHECKOUT;
};

const render = (value) =>
  typeof value === "string" ? value : JSON.stringify(value ?? null);

function describeOverride(path, location, triggers, key, value) {
  const inert =
    key === "sha"
      ? " actions/checkout has no `sha` input, so the key supplies the action nothing; it is refused for the override it states."
      : "";
  return `${path} (${location}): actions/checkout sets \`${key}: ${render(value)}\` in a workflow triggered by ${triggers.join(" and ")}. On a pull request the action defaults to the head merged with the base tip, and the rebase re-attestation route in .claude/commands/assess-review.md rests on a gate having run that merge; a step naming its own ref runs something else.${inert} Remove the key to take the default, or move the step into a workflow with no pull-request trigger.`;
}

/**
 * Every checkout ref override the given workflows hold, as message strings,
 * with the counts a caller needs to tell an empty read from a clean one. Each
 * workflow is `{path, source}`, as `readWorkflows` returns them.
 */
export function checkoutOverrides(workflows) {
  const violations = [];
  let pullRequestWorkflows = 0;
  let checkoutSteps = 0;

  for (const { path, source } of workflows) {
    const document = parseWorkflow(path, source);
    const triggers = triggerNames(document);
    if (triggers === null) {
      violations.push(
        `${path}: its \`on:\` block has a shape this check cannot read, so whether the workflow runs on a pull request is undecided. Write the triggers as a mapping, a list of names, or a single name.`,
      );
      continue;
    }
    const gating = triggers.filter((name) =>
      PULL_REQUEST_TRIGGERS.includes(name),
    );
    if (gating.length === 0) continue;
    pullRequestWorkflows += 1;

    for (const { location, uses, inputs } of usesNodes(document)) {
      if (!isCheckout(uses)) continue;
      checkoutSteps += 1;
      if (inputs === null) continue;
      for (const key of OVERRIDE_KEYS) {
        if (!Object.hasOwn(inputs, key)) continue;
        violations.push(
          describeOverride(path, location, gating, key, inputs[key]),
        );
      }
    }
  }

  return { violations, pullRequestWorkflows, checkoutSteps };
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { violations, pullRequestWorkflows, checkoutSteps } = checkoutOverrides(
    readWorkflows(root),
  );

  if (pullRequestWorkflows === 0 || checkoutSteps === 0) {
    console.error(
      `${WORKFLOW_DIR}: no ${CHECKOUT} step matched under any pull-request trigger -- the reading rotted; fix scripts/lib/workflows.mjs or this check.`,
    );
    process.exit(1);
  }
  if (violations.length > 0) {
    for (const violation of violations) console.error(violation);
    process.exit(1);
  }
  const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  console.log(
    `Checkout ref override check passed: ${plural(checkoutSteps, "checkout step")} across ${plural(pullRequestWorkflows, "pull-request-triggered workflow")} take the default ref.`,
  );
}
