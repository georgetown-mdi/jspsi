import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HOOK = fileURLToPath(
  new URL("./require-measured-claim-literals.mjs", import.meta.url),
);

// Run the hook as a real subprocess with a synthesized PreToolUse payload on
// stdin. Exit 0 allows the Workflow call, exit 2 blocks it and feeds stderr back
// to Claude, so both are expected outcomes and neither may throw.
function runHook(payload) {
  const { status, stderr } = spawnSync("node", [HOOK], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
  });
  return { status, stderr };
}

// A throwaway repo with one message in a source file on `primary` and a second
// one added by `branch`, so a claim can be checked against a ref whose tree
// holds a literal the base does not.
const BASE_MESSAGE = "could not reach the partner within the window";
const BRANCH_MESSAGE = "refuses a run whose secret file is world readable";

let repos = [];

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "claim-literals-"));
  repos.push(dir);
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "primary");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(
    join(dir, "source.ts"),
    `throw new Error("${BASE_MESSAGE}");\n`,
  );
  git("add", "source.ts");
  git("commit", "-q", "-m", "Base commit");
  git("checkout", "-q", "-b", "branch");
  writeFileSync(
    join(dir, "guard.ts"),
    `const refusal = "${BRANCH_MESSAGE}";\n`,
  );
  git("add", "guard.ts");
  git("commit", "-q", "-m", "Branch commit");
  return dir;
}

// The Workflow call light-review Step 2 makes for a role round.
function round(cwd, claims, rest = {}) {
  return runHook({
    tool_name: "Workflow",
    cwd,
    tool_input: {
      scriptPath: ".claude/scripts/light-review-workflow.mjs",
      args: {
        targetRef: "branch",
        docs: [],
        role: "security-reviewer",
        claims,
      },
      ...rest,
    },
  });
}

afterEach(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true });
  repos = [];
});

describe("require-measured-claim-literals hook", () => {
  it("ignores tools other than Workflow", () => {
    const { status } = runHook({
      tool_name: "Agent",
      cwd: makeRepo(),
      tool_input: {
        subagent_type: "implementer",
        prompt: 'fix "nothing here"',
      },
    });
    expect(status).toBe(0);
  });

  it("ignores an unparseable event", () => {
    expect(runHook("not json").status).toBe(0);
  });

  it("allows a lens round, which carries no claims", () => {
    const dir = makeRepo();
    const { status } = runHook({
      tool_name: "Workflow",
      cwd: dir,
      tool_input: {
        scriptPath: ".claude/scripts/light-review-workflow.mjs",
        args: { targetRef: "branch", docs: [], role: null, claims: [] },
      },
    });
    expect(status).toBe(0);
  });

  it("allows claims whose quoted literals all occur at the target ref", () => {
    const dir = makeRepo();
    const { status, stderr } = round(dir, [
      `the run refuses with "${BRANCH_MESSAGE}" among the measured deliveries`,
      `the timeout path still reports "${BASE_MESSAGE}"`,
    ]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  it("blocks a claim quoting a literal absent from the target ref, naming both", () => {
    const dir = makeRepo();
    const claim =
      'the run refuses with "secret file must not be group writable"';
    const { status, stderr } = round(dir, [claim]);
    expect(status).toBe(2);
    expect(stderr).toContain("secret file must not be group writable");
    expect(stderr).toContain(claim);
    expect(stderr).toContain("'branch'");
  });

  it("names the single-quote form for a string the round feeds the surface", () => {
    const dir = makeRepo();
    const { stderr } = round(dir, [
      'the parser rejects "0000-00-00" as a date',
    ]);
    expect(stderr).toContain("single");
  });

  it("allows an input-quoted string written per the convention", () => {
    const dir = makeRepo();
    const { status, stderr } = round(dir, [
      "the parser refuses the input '0000-00-00' rather than throwing",
      "a `--secret` path outside the mount refuses",
    ]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  it("blocks a claim about a literal the target ref removed", () => {
    const dir = makeRepo();
    execFileSync("git", ["-C", dir, "rm", "-q", "source.ts"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "Drop the message"]);
    const { status } = round(dir, [`the run still reports "${BASE_MESSAGE}"`]);
    expect(status).toBe(2);
  });

  it("checks the target ref's tree, not the base branch's", () => {
    const dir = makeRepo();
    const onBase = round(dir, [`it refuses with "${BRANCH_MESSAGE}"`], {
      args: {
        targetRef: "primary",
        docs: [],
        role: "security-reviewer",
        claims: [`it refuses with "${BRANCH_MESSAGE}"`],
      },
    });
    expect(onBase.status).toBe(2);
    expect(round(dir, [`it refuses with "${BRANCH_MESSAGE}"`]).status).toBe(0);
  });

  it("reads claims delivered as a JSON string", () => {
    const dir = makeRepo();
    const { status } = runHook({
      tool_name: "Workflow",
      cwd: dir,
      tool_input: {
        scriptPath: ".claude/scripts/light-review-workflow.mjs",
        args: JSON.stringify({
          targetRef: "branch",
          role: "adversarial-verifier",
          claims: ['it logs "no such rendezvous"'],
        }),
      },
    });
    expect(status).toBe(2);
  });

  it("allows a quoted span holding no letter or digit", () => {
    const dir = makeRepo();
    const { status } = round(dir, ['an empty payload ("") is refused']);
    expect(status).toBe(0);
  });

  it("allows a round whose target ref does not resolve", () => {
    const dir = makeRepo();
    const { status } = round(dir, ['it reports "nothing measured anywhere"'], {
      args: {
        targetRef: "no-such-branch",
        role: "security-reviewer",
        claims: ['it reports "nothing measured anywhere"'],
      },
    });
    expect(status).toBe(0);
  });

  it("allows a call whose args cannot be read as named arguments", () => {
    const dir = makeRepo();
    const { status } = runHook({
      tool_name: "Workflow",
      cwd: dir,
      tool_input: {
        scriptPath: ".claude/scripts/light-review-workflow.mjs",
        args: 'claims: it reports "nothing measured anywhere"',
      },
    });
    expect(status).toBe(0);
  });

  it("allows a call made from outside a git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "claim-literals-bare-"));
    repos.push(dir);
    const { status } = runHook({
      tool_name: "Workflow",
      cwd: dir,
      tool_input: {
        scriptPath: ".claude/scripts/light-review-workflow.mjs",
        args: {
          targetRef: "branch",
          role: "security-reviewer",
          claims: ['it reports "nothing measured anywhere"'],
        },
      },
    });
    expect(status).toBe(0);
  });
});
