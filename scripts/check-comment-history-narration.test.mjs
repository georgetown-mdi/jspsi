import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  NARRATION_TELLS,
  OVERRIDE_MARKER,
  SCANNED_EXTENSIONS,
  baseCandidates,
  changedLines,
  commentBlocks,
  isScannedFile,
  narrationInSource,
  resolveBase,
  scanRange,
} from "./check-comment-history-narration.mjs";
import { WORKFLOW_DIR, workflowDocument } from "./lib/workflows.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = "apps/web/src/fixture.ts";

const tells = (text) => narrationInSource(FIXTURE, text).map((f) => f.tell);

/** A throwaway repository with one commit, so real git decides every range. */
function withRepository(files, run) {
  const dir = mkdtempSync(resolve(tmpdir(), "narration-scan-"));
  try {
    for (const args of [
      ["init", "-q", "-b", "staging"],
      ["config", "user.email", "narration-test@example.invalid"],
      ["config", "user.name", "Narration Test"],
    ]) {
      execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    }
    write(dir, files);
    commit(dir, "base");
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function write(dir, files) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(resolve(dir, dirname(file)), { recursive: true });
    writeFileSync(resolve(dir, file), text);
  }
}

function commit(dir, message) {
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", message], {
    cwd: dir,
    stdio: "ignore",
  });
}

describe("the tells", () => {
  it("reports a past state named as past", () => {
    expect(tells("// The reply was previously a bare count.\n")).toEqual([
      "a past state named as past",
    ]);
    expect(tells("// Formerly on stdout, these land on stderr.\n")).toEqual([
      "a past state named as past",
    ]);
  });

  it("reports what the code used to do", () => {
    expect(
      tells("// Held here rather than the table it used to hold.\n"),
    ).toEqual(["what the code used to do"]);
  });

  it("reports code called surplus to a past need", () => {
    expect(tells("// The wrapper is no longer needed.\n")).toEqual([
      "code called surplus to a past need",
    ]);
  });

  it("reports a reference to the change itself", () => {
    expect(tells("// This change closes the residual.\n")).toEqual([
      "a reference to the change itself",
    ]);
    expect(
      tells("// The engine these steps ran on before this commit.\n"),
    ).toEqual(["a reference to the change itself"]);
  });

  it("reports an earlier version of the code named as such", () => {
    expect(tells("// The old implementation rethrew the raw errno.\n")).toEqual(
      ["an earlier version of the code named as such"],
    );
    expect(
      tells("// Kept for callers depending on the previous behavior.\n"),
    ).toEqual(["an earlier version of the code named as such"]);
  });

  it("reports the author narrating their own edit", () => {
    expect(tells("// We no longer thread the logger through here.\n")).toEqual([
      "the author narrating their own edit",
    ]);
    expect(tells("// The helper has been moved beside its caller.\n")).toEqual([
      "the author narrating their own edit",
    ]);
  });

  it("reports code described by where it came from", () => {
    expect(tells("// Moved here from the connection module.\n")).toEqual([
      "code described by where it came from",
    ]);
  });

  it("reads a tell written across a line break", () => {
    expect(tells("// The reply was\n// previously a bare count.\n")).toEqual([
      "a past state named as past",
    ]);
  });

  it("attributes a tell to the line it starts on", () => {
    const [found] = narrationInSource(
      FIXTURE,
      "// A first line of prose.\n// This change closes the residual.\n",
    );
    expect(found.line).toBe(2);
    expect(found.excerpt).toContain("This change closes");
  });
});

describe("the run-time uses the tells leave alone", () => {
  it("passes a clock reading", () => {
    expect(
      tells("// Wall-clock Date.now() of the last observed activity.\n"),
    ).toEqual([]);
  });

  it("passes a file that has stopped existing", () => {
    expect(tells("// Report a path that no longer exists.\n")).toEqual([]);
  });

  it("passes a value captured earlier in the run", () => {
    expect(
      tells("// A terminal error built from a previously captured fault.\n"),
    ).toEqual([]);
  });

  it("passes a rename the code performs", () => {
    expect(
      tells("// The data is fsync'd before the rename and the parent after.\n"),
    ).toEqual([]);
  });

  it("passes an invitation code the exchange replaced", () => {
    expect(
      tells("// The update replaces the old code and file in one step.\n"),
    ).toEqual([]);
  });

  it("passes a statement about staleness", () => {
    expect(
      tells("// It cannot rot into a record of what used to be true.\n"),
    ).toEqual([]);
  });
});

describe("what counts as a comment", () => {
  it("leaves a tell inside a string literal alone", () => {
    expect(tells('const s = "// this change closes the residual";\n')).toEqual(
      [],
    );
  });

  it("leaves a tell inside a regular expression alone", () => {
    expect(tells("const r = /\\/\\/ this change/;\n")).toEqual([]);
  });

  it("reads a block comment", () => {
    expect(
      tells("/**\n * The old implementation rethrew.\n */\nconst a = 1;\n"),
    ).toEqual(["an earlier version of the code named as such"]);
  });

  it("reads a comment past the last statement", () => {
    expect(
      tells("const a = 1;\n// This change closes the residual.\n"),
    ).toEqual(["a reference to the change itself"]);
  });

  it("leaves the code beside a trailing comment alone", () => {
    expect(
      tells(
        'const message = "This addon is no longer needed for this plan"; // shown in the billing panel\n',
      ),
    ).toEqual([]);
  });

  it("leaves the code beside a leading block comment alone", () => {
    expect(
      tells('/* flag */ const label = "the old implementation was retired";\n'),
    ).toEqual([]);
  });

  it("joins adjacent comment lines and breaks at a blank line", () => {
    const blocks = commentBlocks(
      FIXTURE,
      "// one\n// two\n\n// three\nconst a = 1;\n",
    );
    expect(blocks.map((block) => block.text)).toEqual(["one two", "three"]);
  });
});

describe("the override", () => {
  it("exempts a comment carrying the marker with a reason", () => {
    expect(
      tells(
        `// git 2.45 no longer needed the counter. ${OVERRIDE_MARKER} -- git's own history\n`,
      ),
    ).toEqual([]);
  });

  it("exempts only the comment it sits in", () => {
    const found = tells(
      `// One. ${OVERRIDE_MARKER} -- why\n\n// The old implementation rethrew.\n`,
    );
    expect(found).toEqual(["an earlier version of the code named as such"]);
  });

  it("reads a longer word ending in the marker as a different word", () => {
    for (const lookAlike of [`dis${OVERRIDE_MARKER}`, `re${OVERRIDE_MARKER}`]) {
      expect(
        tells(`// The old implementation rethrew. ${lookAlike} -- why\n`),
      ).toEqual(["an earlier version of the code named as such"]);
    }
  });

  it("reports the marker written with no reason", () => {
    const [found] = narrationInSource(
      FIXTURE,
      `// The old implementation rethrew. ${OVERRIDE_MARKER}\n`,
    );
    expect(found.tell).toContain(OVERRIDE_MARKER);
    expect(found.tell).toContain("no reason");
  });
});

describe("the range", () => {
  it("prefers the override, then the pull request's base, then staging", () => {
    expect(
      baseCandidates({
        PSILINK_NARRATION_BASE: "abc123",
        GITHUB_BASE_REF: "main",
      }),
    ).toEqual(["abc123", "origin/main", "main", "origin/staging", "staging"]);
    expect(baseCandidates({})).toEqual(["origin/staging", "staging"]);
  });

  it("takes an empty base sha as no base", () => {
    expect(
      baseCandidates({ PSILINK_NARRATION_BASE: "", GITHUB_BASE_REF: "main" }),
    ).toEqual(["origin/main", "main", "origin/staging", "staging"]);
  });

  it("reports the lines a commit adds, not the ones it leaves alone", () => {
    withRepository({ [FIXTURE]: "const a = 1;\nconst b = 2;\n" }, (dir) => {
      write(dir, { [FIXTURE]: "const a = 1;\nconst b = 3;\nconst c = 4;\n" });
      commit(dir, "edit");
      const changed = changedLines(dir, "HEAD~1");
      expect([...changed.get(FIXTURE)].sort((x, y) => x - y)).toEqual([2, 3]);
    });
  });

  it("counts an untracked file whole", () => {
    withRepository({ [FIXTURE]: "const a = 1;\n" }, (dir) => {
      write(dir, { "apps/web/src/fresh.ts": "// one\n// two\n" });
      const changed = changedLines(dir, "HEAD");
      expect([...changed.get("apps/web/src/fresh.ts")]).toEqual([1, 2, 3]);
    });
  });

  it("fails rather than reading an empty range when no base resolves", () => {
    withRepository({ [FIXTURE]: "const a = 1;\n" }, (dir) => {
      execFileSync("git", ["branch", "-m", "staging", "trunk"], {
        cwd: dir,
        stdio: "ignore",
      });
      expect(() => resolveBase(dir, {})).toThrow(/PSILINK_NARRATION_BASE/);
    });
  });

  it("falls through to the base branch when the base sha is empty", () => {
    withRepository({ [FIXTURE]: "const a = 1;\n" }, (dir) => {
      expect(resolveBase(dir, { PSILINK_NARRATION_BASE: "" }).ref).toBe(
        "staging",
      );
    });
  });

  it("resolves the base the override names", () => {
    withRepository({ [FIXTURE]: "const a = 1;\n" }, (dir) => {
      write(dir, { [FIXTURE]: "const a = 2;\n" });
      commit(dir, "edit");
      const head = execFileSync("git", ["rev-parse", "HEAD~1"], {
        cwd: dir,
        encoding: "utf8",
      }).trim();
      expect(resolveBase(dir, { PSILINK_NARRATION_BASE: head })).toEqual({
        commit: head,
        ref: head,
      });
    });
  });
});

describe("the scan over a range", () => {
  it("reports a tell on a line the range adds", () => {
    withRepository({ [FIXTURE]: "const a = 1;\n" }, (dir) => {
      write(dir, {
        [FIXTURE]: "// This change closes the residual.\nconst a = 1;\n",
      });
      commit(dir, "edit");
      const { files, violations } = scanRange(dir, changedLines(dir, "HEAD~1"));
      expect(files).toBe(1);
      expect(violations).toHaveLength(1);
      expect(violations[0].file).toBe(FIXTURE);
      expect(violations[0].line).toBe(1);
    });
  });

  it("leaves a tell the range does not touch alone", () => {
    withRepository(
      { [FIXTURE]: "// This change closes the residual.\nconst a = 1;\n" },
      (dir) => {
        write(dir, {
          [FIXTURE]: "// This change closes the residual.\nconst a = 2;\n",
        });
        commit(dir, "edit");
        expect(scanRange(dir, changedLines(dir, "HEAD~1")).violations).toEqual(
          [],
        );
      },
    );
  });

  it("reads a file no extension of this check names not at all", () => {
    withRepository({ "docs/a.md": "x\n" }, (dir) => {
      write(dir, {
        "docs/a.md": "<!-- This change closes the residual. -->\n",
      });
      commit(dir, "edit");
      expect(scanRange(dir, changedLines(dir, "HEAD~1")).files).toBe(0);
    });
  });
});

describe("the wiring", () => {
  it("names every tell", () => {
    for (const { tell, pattern } of NARRATION_TELLS) {
      expect(tell.trim()).not.toBe("");
      expect(pattern.flags).toContain("i");
    }
  });

  it("scans the source extensions this repository writes", () => {
    for (const extension of [".ts", ".tsx", ".mts", ".mjs", ".js"]) {
      expect(SCANNED_EXTENSIONS).toContain(extension);
      expect(isScannedFile(`a${extension}`)).toBe(true);
    }
    expect(isScannedFile("a.md")).toBe(false);
    expect(isScannedFile("a.yaml")).toBe(false);
  });

  it("gives the guard job the base sha and a history deep enough to hold it", () => {
    const job = workflowDocument(ROOT, `${WORKFLOW_DIR}/static_checks.yaml`)
      .jobs["repo-guards"];
    const checkout = job.steps.find((step) =>
      step.uses?.startsWith("actions/checkout"),
    );
    expect(
      checkout.with?.["fetch-depth"],
      "the comment history-narration check reaches its base out of the checkout, which a single-commit fetch does not carry",
    ).toBe(0);
    const checks = job.steps.find(
      (step) => step.run?.trim() === "npm run check:all",
    );
    expect(
      checks.env?.PSILINK_NARRATION_BASE,
      "the comment history-narration check takes the pull request event's base sha as its base; a ref resolving in the checkout is the fallback",
    ).toContain("github.event.pull_request.base.sha");
  });
});
