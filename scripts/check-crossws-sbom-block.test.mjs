import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LEGACY_PEER_DEPS_FLAG,
  SBOM_ARGS,
  STEP_9_HEADING,
  assess,
  checkCrossbomBlock,
  releasesPrescribesFlag,
  runUnflaggedSbom,
} from "./check-crossws-sbom-block.mjs";
import { CHECKS } from "./run-checks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const readRoot = (name) =>
  readFileSync(resolve(repoRoot, name), { encoding: "utf8" });

const STEP_10_HEADING = "### 10. Publish the GitHub Release";

/** A minimal docs/RELEASES.md whose step 9 section either has the flag or not. */
function releasesDoc({
  flagged,
  otherSectionCarriesFlag = false,
  costNoteCarriesFlag = false,
} = {}) {
  const outsideMention = otherSectionCarriesFlag
    ? `it does not need ${LEGACY_PEER_DEPS_FLAG} at all\n\n`
    : "";
  const flagLine = flagged
    ? `npm sbom --omit=dev ${LEGACY_PEER_DEPS_FLAG} -w packages/core -w apps/cli -w apps/web`
    : "npm sbom --omit=dev -w packages/core -w apps/cli -w apps/web";
  const costNote = costNoteCarriesFlag
    ? [
        "",
        `\`${LEGACY_PEER_DEPS_FLAG}\` costs this invocation's peer checking.`,
      ]
    : [];
  return [
    "## Release Checklist",
    "",
    "### 8. Build and publish the container image",
    "",
    `Some unrelated prose that happens to mention ${outsideMention}nothing else.`,
    "",
    STEP_9_HEADING,
    "",
    "```sh",
    flagLine,
    "```",
    ...costNote,
    "",
    STEP_10_HEADING,
    "",
    "Publish it.",
  ].join("\n");
}

describe("releasesPrescribesFlag", () => {
  it("reads the flag out of the step 9 section", () => {
    expect(releasesPrescribesFlag(releasesDoc({ flagged: true }))).toBe(true);
  });

  it("reads its absence from the step 9 section", () => {
    expect(releasesPrescribesFlag(releasesDoc({ flagged: false }))).toBe(false);
  });

  it("does not read past the next heading", () => {
    const doc = releasesDoc({ flagged: false, otherSectionCarriesFlag: true });
    // The flag token appears in the doc, but in step 8's prose, not step 9's.
    expect(doc).toContain(LEGACY_PEER_DEPS_FLAG);
    expect(releasesPrescribesFlag(doc)).toBe(false);
  });

  it("counts a step 9 prose mention, not only the command", () => {
    // The cleanup the failure message asks for drops the flag and its cost
    // note together, so a command stripped of the flag while the note still
    // names it is a half-done cleanup rather than the post-cleanup state.
    const doc = releasesDoc({ flagged: false, costNoteCarriesFlag: true });
    expect(releasesPrescribesFlag(doc)).toBe(true);
  });

  it("refuses when the step 9 heading itself cannot be found", () => {
    expect(releasesPrescribesFlag("# Release Process\n\nNo steps here.")).toBe(
      null,
    );
  });
});

describe("assess", () => {
  it("passes when blocked and flagged -- today's state", () => {
    const verdict = assess({ unflaggedSucceeded: false, flagPrescribed: true });
    expect(verdict.ok).toBe(true);
    expect(verdict.message).toContain("still refuses");
    expect(verdict.message).toContain("still prescribes");
  });

  it("fails when cleared and still flagged -- the drift this check exists for", () => {
    const verdict = assess({ unflaggedSucceeded: true, flagPrescribed: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("Re-run step 9 unflagged");
    expect(verdict.message).toContain("docs/RELEASES.md");
    expect(verdict.message).toContain("docs/spec/DEPENDENCY_PINS.md");
    expect(verdict.message).toContain("hoisting residual");
  });

  it("passes when cleared and unflagged -- the post-cleanup state", () => {
    const verdict = assess({ unflaggedSucceeded: true, flagPrescribed: false });
    expect(verdict.ok).toBe(true);
    expect(verdict.message).toContain("succeeds");
    expect(verdict.message).toContain("does not prescribe");
  });

  it("refuses when the doc's own anchor cannot be read", () => {
    const verdict = assess({ unflaggedSucceeded: false, flagPrescribed: null });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("STEP_9_HEADING");
  });
});

describe("checkCrossbomBlock, with the npm invocation injected", () => {
  it("passes when the injected command still refuses and the doc still flags it", () => {
    const runSbom = () => {
      throw Object.assign(new Error("ESBOMPROBLEMS"), { status: 1 });
    };
    const verdict = checkCrossbomBlock({
      root: "/unused",
      runSbom,
      releasesSource: releasesDoc({ flagged: true }),
    });
    expect(verdict.ok).toBe(true);
  });

  it("fails when the injected command succeeds and the doc still flags it", () => {
    const runSbom = () => {};
    const verdict = checkCrossbomBlock({
      root: "/unused",
      runSbom,
      releasesSource: releasesDoc({ flagged: true }),
    });
    expect(verdict.ok).toBe(false);
  });

  it("passes when the injected command succeeds and the doc no longer flags it", () => {
    const runSbom = () => {};
    const verdict = checkCrossbomBlock({
      root: "/unused",
      runSbom,
      releasesSource: releasesDoc({ flagged: false }),
    });
    expect(verdict.ok).toBe(true);
  });

  it("never touches the filesystem for the doc when a source is injected", () => {
    // root points nowhere real; a fs read of docs/RELEASES.md under it would
    // throw ENOENT, which this call must not do.
    expect(() =>
      checkCrossbomBlock({
        root: "/does/not/exist",
        runSbom: () => {},
        releasesSource: releasesDoc({ flagged: false }),
      }),
    ).not.toThrow();
  });
});

describe("the real repository", () => {
  it("is blocked with the flag prescribed, and passes on that state", () => {
    // Drives the actual npm sbom invocation against the committed lockfile
    // (package-lock-only, confirmed offline in the script's own header)
    // rather than mocking it. Both facts the verdict rests on are pinned, not
    // just its `ok`: the check passes in three of the four states, so a bare
    // pass would hold just as well on a tree the assessment does not describe.
    expect(releasesPrescribesFlag(readRoot("docs/RELEASES.md"))).toBe(true);
    expect(() => runUnflaggedSbom(repoRoot)).toThrow();

    const verdict = checkCrossbomBlock({ root: repoRoot });
    expect(verdict.ok, verdict.message).toBe(true);
    expect(verdict.message).toContain("still refuses");
    expect(verdict.message).toContain("still prescribes");
  });

  it("exits 0 from the CLI entry point", () => {
    const output = execFileSync(
      process.execPath,
      [resolve(here, "check-crossws-sbom-block.mjs")],
      { encoding: "utf8", cwd: repoRoot },
    );
    expect(output).toContain("crossws SBOM block check passed");
  });

  it("names the exact command docs/RELEASES.md step 9 prescribes, less the flag", () => {
    // Step 9's command is this check's argv with the workaround flag inserted
    // ahead of the workspace selection; the check drops that one flag and
    // keeps every other token. Reconstructing it here is what makes a step 9
    // that changes its scoping or its other flags fail, rather than leaving
    // SBOM_ARGS evaluating a command nobody runs.
    const firstWorkspace = SBOM_ARGS.indexOf("-w");
    expect(firstWorkspace).toBeGreaterThan(-1);
    const prescribed = [
      ...SBOM_ARGS.slice(0, firstWorkspace),
      LEGACY_PEER_DEPS_FLAG,
      ...SBOM_ARGS.slice(firstWorkspace),
    ].join(" ");
    expect(readRoot("docs/RELEASES.md")).toContain(prescribed);
  });

  it("is wired as a check script and on the gate's list", () => {
    const pkg = JSON.parse(readRoot("package.json"));
    expect(pkg.scripts).toHaveProperty(
      "check:crossws-sbom-block",
      "node scripts/check-crossws-sbom-block.mjs",
    );
    expect(CHECKS.map((check) => check.script)).toContain(
      "check:crossws-sbom-block",
    );
  });

  it("is what the crossws section names as watching the trigger", () => {
    expect(readRoot("docs/spec/DEPENDENCY_PINS.md")).toContain(
      "scripts/check-crossws-sbom-block.mjs",
    );
  });
});
