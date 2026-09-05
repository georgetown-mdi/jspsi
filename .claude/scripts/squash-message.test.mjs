import { describe, expect, it } from "vitest";
import {
  ALLOWED_TOOLS,
  DISALLOWED_TOOLS,
  claudeArgs,
  commitCountArgs,
  parseCommitCount,
  parsePrNumber,
  prompt,
  refusal,
} from "./squash-message.mjs";

describe("squash-message argument parsing", () => {
  it("takes a bare number and the #-prefixed spelling", () => {
    expect(parsePrNumber(["928"])).toBe(928);
    expect(parsePrNumber(["#928"])).toBe(928);
    expect(parsePrNumber([" 928 "])).toBe(928);
  });

  it("refuses anything that is not one positive integer", () => {
    for (const argv of [
      [],
      ["928", "929"],
      ["abc"],
      ["0"],
      ["-3"],
      ["9.5"],
      ["928; gh pr merge 928"],
      ["$(gh pr merge 928)"],
    ]) {
      expect(parsePrNumber(argv), JSON.stringify(argv)).toBeNull();
    }
  });
});

describe("squash-message prompt", () => {
  it("includes the PR number and names CONTRIBUTING.md", () => {
    expect(prompt(928)).toBe(
      "Please use the commit history, the PR body, and @CONTRIBUTING.md to write a short squash-and-merge commit message for PR #928.",
    );
  });
});

describe("squash-message single-commit guard", () => {
  it("refuses a one-commit pull request, naming the reason", () => {
    const refused = refusal(928, 1);
    expect(refused).toContain("#928");
    expect(refused).toContain("one commit");
    expect(refused).toContain("squash-merges");
  });

  it("drafts for two or more commits, and for an unknown count", () => {
    for (const count of [2, 3, 17, null]) {
      expect(refusal(928, count), String(count)).toBeNull();
    }
  });

  it("reads the count from a read-only gh view of the PR", () => {
    const args = commitCountArgs(928);
    expect(args.slice(0, 3)).toEqual(["pr", "view", "928"]);
    expect(args).toContain("commits");
    for (const arg of args) expect(arg).not.toMatch(/merge|edit|close/i);
  });

  it("takes a plain integer count and nothing else", () => {
    expect(parseCommitCount("1\n")).toBe(1);
    expect(parseCommitCount(" 12 ")).toBe(12);
    for (const stdout of [
      "",
      undefined,
      null,
      "no pull requests found",
      "1 commit",
      "-1",
      '{"commits":[{}]}',
    ]) {
      expect(parseCommitCount(stdout), JSON.stringify(stdout)).toBeNull();
    }
  });
});

describe("squash-message tool surface", () => {
  const args = claudeArgs();

  it("pins the model to sonnet and prints", () => {
    expect(args).toContain("-p");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
  });

  it("grants only read-only tools", () => {
    const mutating = /\b(merge|push|edit|close|commit|rm|write)\b/i;
    for (const tool of ALLOWED_TOOLS) {
      expect(tool, tool).not.toMatch(mutating);
    }
  });

  // The script generates a message; it does not land one. The deny list is the
  // executable form of that, so it is asserted rather than left to the header.
  it("denies the spellings that would merge, edit, or push", () => {
    for (const denied of [
      "Bash(gh pr merge:*)",
      "Bash(gh pr edit:*)",
      "Bash(git push:*)",
      "Edit",
      "Write",
    ]) {
      expect(DISALLOWED_TOOLS).toContain(denied);
    }
  });

  it("passes each list as one comma-joined argument", () => {
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(
      ALLOWED_TOOLS.join(","),
    );
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe(
      DISALLOWED_TOOLS.join(","),
    );
  });

  // Both flags are variadic, so a prompt left in argv after them is consumed as
  // more tool names and the run dies asking for the input it was handed. The
  // prompt goes on stdin, and nothing in argv may look like it.
  it("keeps the prompt out of argv", () => {
    expect(args).not.toContain(prompt(928));
    for (const arg of args) expect(arg).not.toContain("squash-and-merge");
  });
});
