import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  parseActionReference,
  parseWorkflow,
  readWorkflows,
  usesNodes,
} from "./lib/workflows.mjs";

// The container image vulnerability scan runs from more than one place -- the
// pull-request gate in image_smoke.yaml, the weekly scan of the published tag
// beside it, and one gate per image in release.yaml ahead of the push -- and
// each writes its threshold out as literal `with:` inputs. Nothing makes them
// one setting, so the severity list, the vulnerability types read, the fixable
// filter or the exception list can be raised on the pre-merge gate and left
// where it was on the ship gate. The result passes review as a single-line
// change and leaves two gates answering different questions under one name,
// with no run that reports the difference. This holds them identical.
//
// The comparison is the whole `with:` block minus the inputs below, so an input
// nobody has thought of yet is compared too rather than needing to be named
// here first. The action reference is compared with it: two invocations at
// different versions of the scanner are not the same gate whatever their inputs
// say, and release.yaml's comment claims they are the same scanner.
//
// What it cannot see: whether the threshold is the right one, whether a run
// used the file the tree holds, and any scan invoked by a `run:` line rather
// than by the action. A tree with fewer than two invocations would satisfy
// every property here vacuously, so the count is asserted too.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TRIVY_ACTION = "aquasecurity/trivy-action";

// Inputs that name the site rather than the gate. `image-ref` is the image each
// one reads; `format`, `output` and `limit-severities-for-sarif` are where the
// findings go, which is SARIF for the legs that upload code-scanning alerts and
// a table for the ones that report on a run summary. Adding an input here
// exempts it from the comparison, so an entry is a decision that the input says
// nothing about what the gate accepts -- `exit-code` is not one of them, a scan
// that cannot fail being a different gate from one that can.
const PER_SITE_INPUTS = new Set([
  "image-ref",
  "format",
  "output",
  "limit-severities-for-sarif",
]);

// Inputs no invocation may leave to the action's default: each is part of what
// the gate accepts, and a default is not visible in the diff that drops one.
const REQUIRED_INPUTS = [
  "scan-type",
  "scanners",
  "vuln-type",
  "severity",
  "ignore-unfixed",
  "trivyignores",
  "exit-code",
];

/** Every trivy-action step in the workflow tree, in file and document order. */
function trivyInvocations(root) {
  return readWorkflows(root).flatMap(({ path, source }) =>
    usesNodes(parseWorkflow(path, source))
      .filter((node) => {
        const reference = parseActionReference(node.uses);
        return reference !== null && reference.name.trim() === TRIVY_ACTION;
      })
      .map((node) => ({
        site: `${path} ${node.location}`,
        ref: parseActionReference(node.uses).ref,
        inputs: node.inputs ?? {},
      })),
  );
}

/** What one invocation states about the gate, as a comparable object. */
const gateOf = (invocation) => ({
  ref: invocation.ref,
  inputs: Object.fromEntries(
    Object.entries(invocation.inputs)
      .filter(([key]) => !PER_SITE_INPUTS.has(key))
      .sort(([first], [second]) => (first < second ? -1 : 1)),
  ),
});

describe("the image vulnerability scan's threshold", () => {
  const invocations = trivyInvocations(repoRoot);

  it("is set by more than one invocation, so the comparison is not vacuous", () => {
    expect(
      invocations.map(({ site }) => site).length,
      `fewer than two ${TRIVY_ACTION} steps were found under .github/workflows, so this comparison holds nothing. Point it at the scan's new home, or drop it with the scan.`,
    ).toBeGreaterThan(1);
  });

  it("is written out at every invocation rather than left to a default", () => {
    for (const invocation of invocations) {
      const missing = REQUIRED_INPUTS.filter(
        (key) => !Object.hasOwn(invocation.inputs, key),
      );
      expect(
        missing,
        `${invocation.site} names no ${missing.join(", ")}, so the action's default decides what this gate accepts and no diff shows it. State every threshold input at the step.`,
      ).toEqual([]);
    }
  });

  it("is the same at every invocation", () => {
    const [first, ...rest] = invocations;
    for (const invocation of rest) {
      expect(
        gateOf(invocation),
        `${invocation.site} and ${first.site} run the image scan at different settings, so one gate accepts what the other refuses. Move both in the same change, or record the difference in PER_SITE_INPUTS here with the reason it says nothing about what the gate accepts.`,
      ).toEqual(gateOf(first));
    }
  });
});
