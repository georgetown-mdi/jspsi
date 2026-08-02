import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HOOK = fileURLToPath(new URL("./block-sleep-poll.mjs", import.meta.url));

// Run the hook as a real subprocess with a synthesized PreToolUse payload on
// stdin, the way Claude Code invokes it. Exit 0 allows the Bash call, exit 2
// blocks it and feeds stderr back to Claude, so both are expected outcomes here
// and neither may throw.
function runHook(payload) {
  const { status, stderr } = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return { status, stderr };
}

function verdict(command) {
  return runHook({ tool_name: "Bash", tool_input: { command } });
}

function expectBlocked(commands) {
  for (const command of commands) {
    const { status, stderr } = verdict(command);
    expect(status, command).toBe(2);
    expect(stderr, command).toContain("block-sleep-poll");
    expect(stderr, command).toContain("run_in_background");
  }
}

function expectAllowed(commands) {
  for (const command of commands) {
    expect(verdict(command).status, command).toBe(0);
  }
}

describe("block-sleep-poll hook", () => {
  it("ignores tools other than Bash", () => {
    const { status } = runHook({
      tool_name: "Agent",
      tool_input: { prompt: "sleep 60" },
    });
    expect(status).toBe(0);
  });

  it("blocks a bare sleep at or past the threshold, in every unit", () => {
    expectBlocked(["sleep 5", "sleep 30", "  sleep 120  ", "sleep 2m"]);
  });

  it("allows a short settle, which is not a poll", () => {
    expectAllowed(["sleep 1", "sleep 0.5", "sleep 4.9"]);
  });

  it("allows a wait that is bounded by a condition rather than the clock", () => {
    expectAllowed([
      "until curl -sf localhost:3000; do sleep 5; done",
      "while ! test -f build/done; do sleep 30; done",
      "sleep 60 && npm run build",
      "npm run dev & sleep 30; curl localhost:3000",
      "timeout 60 sleep 30",
    ]);
  });

  it("allows a command that merely mentions sleeping", () => {
    expectAllowed([
      "echo sleep 60",
      "grep -rn 'sleep 60' scripts",
      'node -e "await new Promise((r) => setTimeout(r, 60000))"',
    ]);
  });

  it("names the duration it refused", () => {
    expect(verdict("sleep 1m").stderr).toContain("60-second sleep");
  });

  it("reads only a command that is a naked sleep", () => {
    expect(verdict("sleep 1.5h").stderr).toContain("5400-second sleep");
    expectAllowed(["sleep 90 &", "sleep", "sleep infinity", "sleep -- 90"]);
  });

  it("allows a malformed or absent payload rather than wedging Bash", () => {
    const { status } = spawnSync("node", [HOOK], {
      input: "not json",
      encoding: "utf8",
    });
    expect(status).toBe(0);
    expect(runHook({ tool_name: "Bash", tool_input: {} }).status).toBe(0);
  });
});
