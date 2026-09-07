import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  BODY_WRAP_COLUMNS,
  normalizeDraft,
  subjectBudget,
} from "../scripts/format-squash-message.mjs";

const HOOK = fileURLToPath(
  new URL("./block-nonconforming-squash-message.mjs", import.meta.url),
);

const directories = [];
afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop(), { recursive: true, force: true });
  }
});

// A throwaway scratch/squash-messages/ directory, the shape the reminder hook
// keys these drafts by.
function draftDirectory() {
  const root = mkdtempSync(join(tmpdir(), "squash-draft-"));
  directories.push(root);
  const directory = join(root, "scratch", "squash-messages");
  mkdirSync(directory, { recursive: true });
  return directory;
}

// Run the hook as a real subprocess, piping a synthesized PreToolUse payload on
// stdin the way Claude Code invokes it.
function runHook(payload) {
  return spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
}

const writeEvent = (path, content) => ({
  tool_name: "Write",
  tool_input: { file_path: path, content },
  cwd: "/workspace",
});

const SUBJECT = "Make the squash-message wrap structural";
const draft = (body) => `${SUBJECT}\n\n${body}\n`;
const paragraph = `${"word ".repeat(30)}end`;

/** The hook's refusal for the payload; null when it allowed the call. */
function refusal(payload) {
  const result = runHook(payload);
  if (result.status === 0) return null;
  expect(result.status).toBe(2);
  return result.stderr;
}

describe("block-nonconforming-squash-message hook", () => {
  it("blocks a Write leaving a body paragraph past the wrap", () => {
    const path = join(draftDirectory(), "1374.txt");
    const blocked = refusal(writeEvent(path, draft(paragraph)));
    expect(blocked).toContain(String(BODY_WRAP_COLUMNS));
    expect(blocked).toContain("format-squash-message.mjs");
    expect(blocked).toContain("--out");
  });

  it("allows the draft the normalizer produces from that same content", () => {
    const path = join(draftDirectory(), "1374.txt");
    const normalized = normalizeDraft(draft(paragraph));
    expect(refusal(writeEvent(path, normalized))).toBeNull();
  });

  it("counts the pull-request suffix against the subject", () => {
    const path = join(draftDirectory(), "1374.txt");
    const subject = "x".repeat(subjectBudget(1374));
    expect(refusal(writeEvent(path, `${subject}\n\nBody.\n`))).toBeNull();

    const blocked = refusal(writeEvent(path, `${subject}x\n\nBody.\n`));
    expect(blocked).toContain("(#1374)");
    expect(blocked).toContain("1374 /tmp/squash-message.txt");
  });

  it("assumes a four-digit suffix for a branch-keyed draft", () => {
    const path = join(draftDirectory(), "branch-some-feature.txt");
    const subject = "x".repeat(subjectBudget(null) + 1);
    const blocked = refusal(writeEvent(path, `${subject}\n\nBody.\n`));
    expect(blocked).toContain("(#NNNN)");
    expect(blocked).toContain("unassigned /tmp/squash-message.txt");
  });

  it("blocks markdown and a top-level list, naming each rule", () => {
    const path = join(draftDirectory(), "1374.txt");
    expect(refusal(writeEvent(path, draft("## Motivation")))).toContain(
      "no markdown",
    );
    expect(refusal(writeEvent(path, draft("- first point")))).toContain(
      "prose, not a list",
    );
  });

  it("checks an Edit against the file with the replacement applied", () => {
    const directory = draftDirectory();
    const path = join(directory, "1374.txt");
    writeFileSync(path, normalizeDraft(draft("A short body sentence.")));

    const edit = (oldString, newString) => ({
      tool_name: "Edit",
      tool_input: {
        file_path: path,
        old_string: oldString,
        new_string: newString,
      },
      cwd: "/workspace",
    });
    expect(refusal(edit("A short body sentence.", paragraph))).toContain(
      String(BODY_WRAP_COLUMNS),
    );
    expect(refusal(edit("A short body sentence.", "Another one."))).toBeNull();
  });

  it("allows an Edit whose old_string is not in the file", () => {
    const directory = draftDirectory();
    const path = join(directory, "1374.txt");
    writeFileSync(path, normalizeDraft(draft("A short body sentence.")));
    expect(
      refusal({
        tool_name: "Edit",
        tool_input: {
          file_path: path,
          old_string: "absent",
          new_string: paragraph,
        },
        cwd: "/workspace",
      }),
    ).toBeNull();
  });

  it("leaves every path outside scratch/squash-messages alone", () => {
    const directory = draftDirectory();
    for (const path of [
      join(directory, "1374.md"),
      join(directory, "..", "notes.txt"),
      join(directory, "..", "..", "docs", "DESIGN.txt"),
      "/workspace/CONTRIBUTING.md",
    ]) {
      expect(refusal(writeEvent(path, draft(paragraph))), path).toBeNull();
    }
  });

  it("resolves a relative file_path against the event cwd", () => {
    const directory = draftDirectory();
    expect(
      refusal({
        tool_name: "Write",
        tool_input: {
          file_path: join("scratch", "squash-messages", "1374.txt"),
          content: draft(paragraph),
        },
        cwd: join(directory, "..", ".."),
      }),
    ).toContain(String(BODY_WRAP_COLUMNS));
  });

  it("allows a tool it does not gate and an unreadable event", () => {
    const path = join(draftDirectory(), "1374.txt");
    expect(
      refusal({
        tool_name: "Bash",
        tool_input: { command: `cat ${path}` },
        cwd: "/workspace",
      }),
    ).toBeNull();
    expect(runHook("not an event").status).toBe(0);
    expect(
      spawnSync("node", [HOOK], { input: "", encoding: "utf8" }).status,
    ).toBe(0);
  });

  it("allows a Write whose content the event does not hold as a string", () => {
    const path = join(draftDirectory(), "1374.txt");
    expect(
      refusal({
        tool_name: "Write",
        tool_input: { file_path: path },
        cwd: "/workspace",
      }),
    ).toBeNull();
  });
});
