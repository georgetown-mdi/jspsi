import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HOOK = fileURLToPath(new URL("./read-saved-output.mjs", import.meta.url));

// Run the hook as a real subprocess with a synthesized PostToolUse payload on
// stdin. A PostToolUse hook cannot block, so the only outcomes are exit 0 with a
// JSON additionalContext message on stdout, or exit 0 with nothing.
function runHook(payload) {
  const { status, stdout } = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  const context =
    stdout.trim().length > 0
      ? JSON.parse(stdout).hookSpecificOutput.additionalContext
      : null;
  return { status, context };
}

const bash = (tool_response) => runHook({ tool_name: "Bash", tool_response });

// The harness's rendered notice for a persisted result, measured 2026-08-31 by
// running a command with 60KB of output.
const notice = (path, size = "60.5KB") =>
  `<persisted-output>\nOutput too large (${size}). Full output saved to: ${path}\n\nPreview (first 2KB):\nLINE0 zzz\n</persisted-output>`;

describe("read-saved-output hook", () => {
  const dirs = [];
  const saved = (contents, name = "saved.txt") => {
    const dir = mkdtempSync(join(tmpdir(), "read-saved-output-"));
    dirs.push(dir);
    const path = join(dir, name);
    writeFileSync(path, contents);
    return path;
  };
  afterEach(() => {
    while (dirs.length > 0)
      rmSync(dirs.pop(), { recursive: true, force: true });
  });

  it("reads the saved file back when the notice opens the response", () => {
    const path = saved("first line\nthe verdict is here\n");
    const { status, context } = bash(notice(path));
    expect(status).toBe(0);
    expect(context).toContain("the verdict is here");
    expect(context).toContain(path);
  });

  it("reads it back from a bare string response and from stdout", () => {
    const path = saved("the verdict is here\n");
    expect(bash(notice(path)).context).toContain("the verdict is here");
    expect(bash({ stdout: notice(path) }).context).toContain(
      "the verdict is here",
    );
  });

  it("stays silent when output merely quotes the notice", () => {
    // The misfire this hook exists to avoid: printing a file that carries the
    // notice (this test, the hook's own source, a transcript) must not send it
    // chasing a path built from the quoted line.
    const path = saved("unreachable\n");
    for (const response of [
      `const NOTICE = /Output too large \\(...\\)\\. Full output saved to: (.+)/;\n`,
      `sifting the log\nOutput too large (60.5KB). Full output saved to: ${path}\ndone\n`,
      `Full output saved to: ${path}\n`,
    ]) {
      expect(bash(response), response).toEqual({ status: 0, context: null });
    }
  });

  it("stays silent on a response carrying no notice at all", () => {
    expect(bash("ordinary output\n")).toEqual({ status: 0, context: null });
    expect(bash({ stdout: "", stderr: "boom" })).toEqual({
      status: 0,
      context: null,
    });
    expect(bash(undefined)).toEqual({ status: 0, context: null });
  });

  it("ignores tools other than Bash and an unparseable event", () => {
    const path = saved("the verdict is here\n");
    expect(runHook({ tool_name: "Read", tool_response: notice(path) })).toEqual(
      { status: 0, context: null },
    );
    const { status, stdout } = spawnSync("node", [HOOK], {
      input: "not json",
      encoding: "utf8",
    });
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("warns rather than reading when the announced path is not a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "read-saved-output-"));
    dirs.push(dir);
    const missing = join(dir, "gone.txt");
    const directory = join(dir, "adirectory");
    mkdirSync(directory);
    for (const path of [missing, directory]) {
      const { context } = bash(notice(path));
      expect(context, path).toContain("not a readable file");
      expect(context, path).toContain(path);
    }
  });

  it("caps the readback and says so", () => {
    const path = saved("x".repeat(60000));
    const { context } = bash(notice(path));
    expect(context).toContain("read back to 51200 bytes");
    expect(context.length).toBeLessThan(52000);
  });
});
