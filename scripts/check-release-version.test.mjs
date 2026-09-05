import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  agreementViolations,
  manifestVersion,
  taggedVersion,
} from "./check-release-version.mjs";
import { WORKFLOW_DIR, workflowDocument } from "./lib/workflows.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const SCRIPT = resolve(here, "check-release-version.mjs");

const readRoot = (relative) =>
  readFileSync(resolve(repoRoot, relative), "utf8");

const committedVersion = manifestVersion(readRoot("apps/cli/package.json"));

describe("the tag a release publishes under", () => {
  it("names the version its release-tag shape carries", () => {
    expect(taggedVersion("v1.2.3")).toBe("1.2.3");
    expect(taggedVersion("v10.0.11")).toBe("10.0.11");
  });

  it("names none in any other shape", () => {
    // The workflow triggers on `v[0-9]+.[0-9]+.[0-9]+` alone, so these reach the
    // check only from a hand-run or a widened trigger -- where a tag it cannot
    // parse must fail rather than compare nothing and pass.
    for (const tag of [
      "1.2.3",
      "v1.2",
      "v1.2.3.4",
      "v1.2.3-rc.1",
      "release-1.2.3",
      "",
      undefined,
    ]) {
      expect(taggedVersion(tag)).toBeUndefined();
    }
  });
});

describe("the version a manifest carries", () => {
  it("reads a release version", () => {
    expect(manifestVersion('{"name":"psilink","version":"0.4.2"}')).toBe(
      "0.4.2",
    );
  });

  it("reads an absent, empty, or non-string version as none", () => {
    // Each is a manifest the image build bakes nothing from, so each is the
    // same failure rather than three.
    expect(manifestVersion('{"name":"psilink"}')).toBeUndefined();
    expect(manifestVersion('{"version":""}')).toBeUndefined();
    expect(manifestVersion('{"version":null}')).toBeUndefined();
    expect(manifestVersion('{"version":2}')).toBeUndefined();
  });
});

describe("the agreement the check holds", () => {
  it("passes a tag naming the manifest's version", () => {
    expect(agreementViolations("v0.4.2", "0.4.2")).toEqual([]);
  });

  it("fails a disagreement, naming both values", () => {
    // Naming both is the whole report: which of the two is the wrong one is the
    // maintainer's call, and a message naming one leaves the reader to go find
    // the other.
    const [violation] = agreementViolations("v0.2.0", "0.1.0");
    expect(violation).toContain("v0.2.0");
    expect(violation).toContain("0.1.0");
  });

  it("fails a manifest carrying no version, naming the tag", () => {
    const [violation] = agreementViolations("v0.2.0", undefined);
    expect(violation).toContain("v0.2.0");
    expect(violation).toContain("apps/cli/package.json");
  });

  it("fails a tag it cannot read a version out of", () => {
    const [violation] = agreementViolations("latest", "0.1.0");
    expect(violation).toContain("latest");
    expect(violation).toContain("0.1.0");
  });

  it("passes nothing on a prefix or suffix of a matching version", () => {
    // String equality, not containment: `v0.1.0` and `0.1.0-rc.1` name
    // different builds, and so do `v0.1.0` and `10.1.0`.
    expect(agreementViolations("v0.1.0", "0.1.0-rc.1")).toHaveLength(1);
    expect(agreementViolations("v0.1.0", "10.1.0")).toHaveLength(1);
  });
});

// The script driven as the workflow runs it, against the committed manifest.
function runCheck(tag) {
  const env = { ...process.env };
  delete env.PSILINK_TAG;
  if (tag !== undefined) env.PSILINK_TAG = tag;
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      cwd: repoRoot,
      encoding: "utf8",
      env,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return { status: error.status, stdout: error.stdout, stderr: error.stderr };
  }
}

describe("the check as the release workflow runs it", () => {
  it("passes the tag the committed manifest's version names", () => {
    const { status, stdout } = runCheck(`v${committedVersion}`);
    expect(status).toBe(0);
    expect(stdout).toContain(committedVersion);
  });

  it("fails the release when the pushed tag names another version", () => {
    // The release this check exists for: a tag pushed ahead of the manifest
    // bump, which publishes an image whose accept kit names the release before
    // it.
    const [major, minor, patch] = committedVersion.split(".");
    const bumped = `v${major}.${Number(minor) + 1}.${patch}`;
    const { status, stderr } = runCheck(bumped);
    expect(status).toBe(1);
    expect(stderr).toContain(bumped);
    expect(stderr).toContain(committedVersion);
  });

  it("refuses to pass when it is handed no tag at all", () => {
    // A step whose env assignment is dropped or renamed must not read as a
    // release whose versions agree.
    expect(runCheck(undefined).status).toBe(2);
    expect(runCheck("").status).toBe(2);
  });
});

describe("the release workflow's version check step", () => {
  const releaseDocument = workflowDocument(
    repoRoot,
    `${WORKFLOW_DIR}/release.yaml`,
  );
  const publishJobs = Object.values(releaseDocument.jobs).filter((job) =>
    (job.steps ?? []).some((step) => (step.with ?? {}).push === true),
  );

  it("is registered as the command the workflow invokes", () => {
    expect(JSON.parse(readRoot("package.json")).scripts).toHaveProperty(
      "check:release-version",
      "node scripts/check-release-version.mjs",
    );
  });

  it("runs in the job that pushes the image, ahead of every build step", () => {
    // Ahead of the build, because a check after it has already published the
    // image whose kit it was to hold: the buildx step pushes as it builds.
    expect(publishJobs).toHaveLength(1);
    const steps = publishJobs[0].steps;
    const checkIndex = steps.findIndex((step) =>
      (step.run ?? "").includes("npm run check:release-version"),
    );
    const firstBuildIndex = steps.findIndex((step) =>
      (step.uses ?? "").startsWith("docker/build-push-action"),
    );
    expect(checkIndex).toBeGreaterThanOrEqual(0);
    expect(firstBuildIndex).toBeGreaterThan(checkIndex);
  });

  it("hands it the pushed tag", () => {
    // The tag arrives in the environment, which is also what keeps the ref out
    // of the `run:` line's shell.
    const step = publishJobs[0].steps.find((s) =>
      (s.run ?? "").includes("npm run check:release-version"),
    );
    expect(step.env).toEqual({ PSILINK_TAG: "${{ github.ref_name }}" });
  });

  it("runs under a Node the workflow pins", () => {
    // The publish job skips the ./.github/actions/setup prologue, so without a
    // pinned Node this step would run on whatever the runner image ships.
    const steps = publishJobs[0].steps;
    const nodeIndex = steps.findIndex((step) =>
      (step.uses ?? "").startsWith("actions/setup-node@"),
    );
    const checkIndex = steps.findIndex((step) =>
      (step.run ?? "").includes("npm run check:release-version"),
    );
    expect(nodeIndex).toBeGreaterThanOrEqual(0);
    expect(nodeIndex).toBeLessThan(checkIndex);
    expect(steps[nodeIndex].with["node-version"]).toBe("26");
  });
});
