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
      "until curl -sf http://localhost:3000/health; do sleep 2; done",
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

  it("blocks an unbounded loop that waits on a process, naming the bounded form", () => {
    const refused = [
      "until [ -f /tmp/out ] && ! kill -0 $(pgrep -f vitest); do sleep 30; done",
      'while kill -0 "$pid" 2>/dev/null; do sleep 2; done',
      "while pgrep -f 'npm run build' >/dev/null\ndo\n  sleep 5\ndone",
      "npm run build & until ! pgrep -f rollup; do sleep 1; done; echo built",
      "timeout 30 npm test; while kill -0 1234; do sleep 2; done",
      "timeout 5 bash -c 'true'; while kill -0 1234; do sleep 2; done",
      "timeout 5 bash -c 'true' && until ! pgrep -f vitest; do sleep 3; done",
    ];
    for (const command of refused) {
      const { status, stderr } = verdict(command);
      expect(status, command).toBe(2);
      expect(stderr, command).toContain("no upper bound");
      expect(stderr, command).toContain("timeout 600 bash -c");
      expect(stderr, command).toContain("$((n+=1))");
    }
  });

  it("allows a process wait bounded by a timeout wrapper or a counter", () => {
    expectAllowed([
      "timeout 600 bash -c 'while kill -0 1234 2>/dev/null; do sleep 2; done'",
      'timeout 600 bash -c "while kill -0 $pid 2>/dev/null; do sleep 2; done"',
      "timeout -s KILL 10m sh -c 'until ! pgrep -f vitest; do sleep 5; done'",
      'n=0; while kill -0 "$pid" 2>/dev/null && [ $((n+=1)) -le 300 ]; do sleep 2; done',
      "i=0; until ! pgrep vitest; do sleep 2; i=$((i+1)); [ $i -ge 60 ] && break; done",
      "while kill -0 $pid && (( SECONDS < 600 )); do sleep 2; done",
      "while kill -0 $pid && [ $SECONDS -lt 600 ]; do sleep 2; done",
    ]);
  });

  it("allows a process check that is not a sleeping wait loop", () => {
    expectAllowed([
      "kill -0 1234 && echo alive",
      "pgrep -f vitest || npm test",
      "while pgrep -f vitest; do pkill -f vitest; done",
      "for i in $(seq 60); do kill -0 $pid || break; sleep 2; done",
      "grep -n 'until ! kill -0' .claude/hooks/*.mjs",
    ]);
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
