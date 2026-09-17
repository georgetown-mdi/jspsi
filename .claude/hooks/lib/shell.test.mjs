import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  git,
  leadingCdDestination,
  splitPipelines,
  splitSegments,
  splitStages,
  tokenize,
  tokenizeRaw,
} from "./shell.mjs";

const temporary = [];

afterEach(() => {
  while (temporary.length > 0) {
    rmSync(temporary.pop(), { recursive: true, force: true });
  }
});

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "hook-shell-"));
  temporary.push(dir);
  const run = (...args) => execFileSync("git", args, { cwd: dir });
  run("init", "-q", "-b", "primary");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("commit", "-q", "--allow-empty", "-m", "Base commit");
  return dir;
}

describe("splitPipelines", () => {
  it("splits on &&, ||, a semicolon and a newline", () => {
    expect(splitPipelines("a && b || c; d\ne")).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("keeps a pipeline whole, pipe and all", () => {
    expect(splitPipelines("find . | xargs rm")).toEqual(["find . | xargs rm"]);
  });

  it("leaves a lone & inside the stage that holds it", () => {
    expect(splitPipelines("build 2>&1 & rm tree")).toEqual([
      "build 2>&1 & rm tree",
    ]);
  });

  it("leaves a subshell's brackets in place", () => {
    expect(splitPipelines("(cd other && rm -rf .)")).toEqual([
      "(cd other",
      "rm -rf .)",
    ]);
  });
});

describe("splitStages", () => {
  it("splits a pipeline on the pipe", () => {
    expect(splitStages("find . | xargs rm")).toEqual(["find .", "xargs rm"]);
  });
});

describe("splitSegments", () => {
  it("flattens every pipeline's stages into one list", () => {
    expect(splitSegments("a && find . | xargs rm; b")).toEqual([
      "a",
      "find .",
      "xargs rm",
      "b",
    ]);
  });

  // The two splitters compose into what a single flat regex would split on
  // in one pass, so a hook reading stages and a hook reading segments see the
  // same set.
  it("matches a single pass over every separator including the pipe", () => {
    const flat = (command) => command.split(/\s*(?:&&|\|\||[;|\n])\s*/);
    for (const command of [
      "a|b||c&&d;e\nf",
      "echo 2>&1 | grep x",
      "  git   status  ",
      "a || | b",
      "x='a|b' && rm y",
      "",
    ]) {
      expect(splitSegments(command)).toEqual(flat(command));
    }
  });
});

describe("tokenize", () => {
  it("splits on whitespace", () => {
    expect(tokenize("rm -rf  node_modules")).toEqual([
      "rm",
      "-rf",
      "node_modules",
    ]);
  });

  it("keeps a quoted span whole and strips its quotes", () => {
    expect(tokenize(`rm "a file" 'b file'`)).toEqual([
      "rm",
      "a file",
      "b file",
    ]);
  });

  it("strips an inner quote as well as an outer pair", () => {
    expect(tokenize("push HEAD:'staging'")).toEqual(["push", "HEAD:staging"]);
    expect(tokenize('r"m" x')).toEqual(["rm", "x"]);
  });

  it("reads an empty segment as no words", () => {
    expect(tokenize("   ")).toEqual([]);
  });
});

describe("tokenizeRaw", () => {
  it("splits the same words and leaves every quote on them", () => {
    expect(tokenizeRaw(`gh pr create --title "Don't stop"`)).toEqual([
      "gh",
      "pr",
      "create",
      "--title",
      `"Don't stop"`,
    ]);
  });

  it("reads an empty segment as no words", () => {
    expect(tokenizeRaw("   ")).toEqual([]);
  });

  // A caller reading a word two ways -- matching on the stripped word and
  // measuring the raw one -- pairs them by position, which holds only while the
  // two tokenizers split a segment into the same number of words.
  it("splits a segment into as many words as tokenize does", () => {
    for (const segment of [
      `gh pr create --title "Don't stop"`,
      `"gh" pr "create" "--title" 'a b'`,
      `gh pr edit 928 -t"x y" --body ""`,
      "rm -rf  node_modules",
      "   ",
    ]) {
      expect(tokenizeRaw(segment), segment).toHaveLength(
        tokenize(segment).length,
      );
    }
  });
});

describe("leadingCdDestination", () => {
  const FROM = "/repo/.claude/worktrees/agent-a";

  it("resolves a one-argument cd against the directory of the call", () => {
    expect(leadingCdDestination("cd /tmp/tree && npm test", FROM)).toBe(
      "/tmp/tree",
    );
    expect(leadingCdDestination("cd ../agent-b", FROM)).toBe(
      "/repo/.claude/worktrees/agent-b",
    );
    expect(leadingCdDestination("cd -- 'packages/core'", FROM)).toBe(
      `${FROM}/packages/core`,
    );
  });

  it("substitutes the two-argument form into the pathname", () => {
    expect(leadingCdDestination("cd agent-a agent-b", FROM)).toBe(
      "/repo/.claude/worktrees/agent-b",
    );
    expect(leadingCdDestination("cd a b", FROM)).toBe(
      "/repo/.clbude/worktrees/agent-a",
    );
  });

  it("reads only a cd standing first in the command", () => {
    expect(leadingCdDestination("npm test && cd /tmp/tree", FROM)).toBeNull();
    expect(leadingCdDestination("echo cd /tmp/tree", FROM)).toBeNull();
    expect(leadingCdDestination("(cd /tmp/tree && npm test)", FROM)).toBeNull();
  });

  // The one-argument form resolves whatever text it is given, so a caller sees a
  // path the shell would never visit rather than a lie about where it went.
  it("expands nothing in a one-argument target", () => {
    expect(leadingCdDestination("cd $TREE", FROM)).toBe(`${FROM}/$TREE`);
    expect(leadingCdDestination("cd ~/tree", FROM)).toBe(`${FROM}/~/tree`);
  });

  it("gives up on a destination it cannot compute", () => {
    expect(leadingCdDestination("cd", FROM)).toBeNull();
    expect(leadingCdDestination("cd -", FROM)).toBeNull();
    expect(leadingCdDestination("cd -2", FROM)).toBeNull();
    expect(leadingCdDestination("cd +1", FROM)).toBeNull();
    expect(leadingCdDestination("cd agent-a ~/b", FROM)).toBeNull();
    expect(leadingCdDestination("cd absent agent-b", FROM)).toBeNull();
    expect(leadingCdDestination("cd one two three", FROM)).toBeNull();
    expect(leadingCdDestination("cd /repo relative", FROM)).toBeNull();
  });
});

describe("git", () => {
  it("returns trimmed stdout", () => {
    const dir = makeRepo();
    expect(git(["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"])).toBe(
      "primary",
    );
  });

  it("runs in the directory the caller names", () => {
    const dir = makeRepo();
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir })).toBe(
      "primary",
    );
  });

  it("returns nothing when git exits non-zero", () => {
    const dir = makeRepo();
    expect(git(["-C", dir, "rev-parse", "--verify", "--quiet", "nope"])).toBe(
      null,
    );
  });

  it("returns nothing outside a repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "hook-shell-bare-"));
    temporary.push(dir);
    expect(git(["-C", dir, "rev-parse", "--show-toplevel"])).toBeNull();
  });

  it("returns nothing when the directory is gone", () => {
    expect(
      git(["rev-parse", "HEAD"], { cwd: join(tmpdir(), "hook-shell-absent") }),
    ).toBeNull();
  });
});
