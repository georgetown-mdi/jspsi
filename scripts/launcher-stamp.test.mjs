import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { WORKFLOW_DIR, workflowDocument } from "./lib/workflows.mjs";

// The launchers carry the image as a digest, and the release workflow is what
// fills that digest in. Both halves of that arrangement are silent when they
// break: a launcher whose placeholder line was reworded still reads fine, and a
// substitution that no longer matches anything still exits 0 -- leaving a
// release whose published launcher refuses to run in the operator's hands, or,
// worse, one that runs an image nobody pinned.
//
// So the seam is pinned from both sides here: each launcher carries the
// placeholder line exactly once, and the release workflow's stamp step names
// that same path and that same line literally. A rename on either side fails
// this test rather than the release.
//
// What this cannot see: whether the stamped file the workflow writes is the one
// it uploads, and whether the digest it substitutes is the digest cosign signed.
// Those are properties of a run, not of the text; the workflow's own guard --
// refusing when the placeholder is not found exactly once, and again when one
// survives the substitution -- is what covers them, and its presence is pinned
// below.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const PLACEHOLDER = "@@PSILINK_IMAGE_DIGEST@@";

// The fully qualified reference: podman requires the registry prefix and docker
// accepts it, so both launchers name it in full rather than relying on a
// default.
const IMAGE_REPOSITORY = "docker.io/vdorie/psi-link";

const LAUNCHERS = [
  {
    path: "support/windows-network-filedrop/start-psilink.sh",
    digestLine: `PSILINK_IMAGE_DIGEST='${PLACEHOLDER}'`,
    repositoryLine: `PSILINK_IMAGE_REPOSITORY='${IMAGE_REPOSITORY}'`,
  },
  {
    path: "support/windows-network-filedrop/Start-Psilink.ps1",
    digestLine: `$PsilinkImageDigest = '${PLACEHOLDER}'`,
    repositoryLine: `$PsilinkImageRepository = '${IMAGE_REPOSITORY}'`,
  },
];

const read = (relative) => readFileSync(resolve(repoRoot, relative), "utf8");

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

const RELEASE_WORKFLOW = `${WORKFLOW_DIR}/release.yaml`;
const releaseWorkflow = read(RELEASE_WORKFLOW);
const releaseDocument = workflowDocument(repoRoot, RELEASE_WORKFLOW);

// Every `run:` script in the workflow, joined. The stamp step is identified by
// the literals it must carry rather than by its name, so renaming the step does
// not quietly move the assertions off it.
const runScripts = Object.values(releaseDocument.jobs)
  .flatMap((job) => job.steps ?? [])
  .map((step) => step.run)
  .filter((run) => typeof run === "string");

describe("the launcher digest stamp", () => {
  for (const launcher of LAUNCHERS) {
    describe(launcher.path, () => {
      const source = read(launcher.path);

      it("carries the placeholder on exactly one line", () => {
        // Exactly one, because the release step substitutes a whole line and
        // asserts the same count: a second occurrence -- a launcher comparing
        // its own digest against a literal copy of the token, say -- would make
        // that assertion fail and the release with it.
        expect(occurrences(source, PLACEHOLDER)).toBe(1);
        expect(source.split("\n")).toContain(launcher.digestLine);
      });

      it("names the fully qualified image repository", () => {
        expect(source.split("\n")).toContain(launcher.repositoryLine);
      });

      it("refuses an unstamped copy rather than falling back to a tag", () => {
        // The refusal is what makes the pin load-bearing; without it an
        // unstamped copy would run whatever a floating tag resolves to today.
        // Held here as the absence of any floating tag in the file: a `:latest`
        // reference is the shape that regression takes.
        expect(source).not.toMatch(/vdorie\/psi-link:[A-Za-z0-9._-]+/);
      });
    });
  }
});

describe("the release workflow's stamp step", () => {
  const stampScripts = runScripts.filter((run) => run.includes(PLACEHOLDER));

  it("substitutes the placeholder in exactly one step", () => {
    expect(stampScripts).toHaveLength(1);
  });

  const stamp = stampScripts[0] ?? "";

  for (const launcher of LAUNCHERS) {
    it(`names ${launcher.path} and the line it rewrites`, () => {
      expect(stamp).toContain(launcher.path);
      // The literal the step matches on. Reword the launcher's line without
      // rewording this one and the substitution silently matches nothing --
      // which is the failure this test exists for.
      expect(stamp).toContain(launcher.digestLine);
    });
  }

  it("fails the release when a launcher does not carry the placeholder", () => {
    // The step counts the placeholder line before substituting and exits
    // non-zero on anything but one occurrence, so a rename cannot no-op.
    expect(stamp).toMatch(/exit 1/);
  });

  it("fails the release when a placeholder survives the substitution", () => {
    // Read as a second, independent look at the output: the count above is
    // taken before the rewrite, this one after it.
    expect(stamp).toMatch(/grep[^\n]*\$\{PSILINK_PLACEHOLDER\}/);
  });

  it("runs in a job whose write permission is scoped to it", () => {
    const writers = Object.entries(releaseDocument.jobs).filter(
      ([, job]) => job.permissions?.contents === "write",
    );
    expect(writers).toHaveLength(1);
    const [, writer] = writers[0];
    expect(writer.steps.map((step) => step.run ?? "")).toContain(stamp);
  });
});
