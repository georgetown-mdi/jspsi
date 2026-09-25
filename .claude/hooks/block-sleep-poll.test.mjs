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

function background(command) {
  return runHook({
    tool_name: "Bash",
    tool_input: { command, run_in_background: true },
  });
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

  it("allows a sleep that is not part of a wait loop", () => {
    expectAllowed([
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

  it("names the timeout wrapper a background wait needs", () => {
    const { status, stderr } = background("sleep 800");
    expect(status).toBe(2);
    expect(stderr).toContain("800-second sleep");
    expect(stderr).toContain("run_in_background, opening with `timeout <N>`");
  });

  it("names the duration it refused", () => {
    expect(verdict("sleep 1m").stderr).toContain("60-second sleep");
  });

  it("reads only a command that is a naked sleep", () => {
    expect(verdict("sleep 1.5h").stderr).toContain("5400-second sleep");
    expectAllowed(["sleep 90 &", "sleep", "sleep infinity", "sleep -- 90"]);
  });

  it("blocks a sleeping wait loop with no bound, whatever it waits on", () => {
    const refused = [
      'until ! ps aux | grep -q "[e]slint"; do sleep 10; done',
      'while ps aux | grep "[e]slint" >/dev/null; do sleep 30; done; echo linted',
      "until curl -sf localhost:3000; do sleep 5; done",
      "while ! test -f build/done; do sleep 30; done",
      "until [ -f /tmp/out ] && ! kill -0 $(pgrep -f vitest); do sleep 30; done",
      'while kill -0 "$pid" 2>/dev/null; do sleep 2; done',
      "while pgrep -f 'npm run build' >/dev/null\ndo\n  sleep 5\ndone",
      "while sleep 5; do curl -sf localhost:3000 && break; done",
      "npm run build & until ! pgrep -f rollup; do sleep 1; done; echo built",
      "timeout 30 npm test; while kill -0 1234; do sleep 2; done",
      "timeout 5 bash -c 'true'; while kill -0 1234; do sleep 2; done",
      "timeout 5 bash -c 'true' && until ! pgrep -f vitest; do sleep 3; done",
    ];
    for (const command of refused) {
      const { status, stderr } = verdict(command);
      expect(status, command).toBe(2);
      expect(stderr, command).toContain("no upper bound");
      expect(stderr, command).toContain("timeout 600 sh -c");
      expect(stderr, command).toContain("$((n+=1))");
    }
  });

  it("allows a wait loop bounded by a timeout wrapper, a counter or a deadline", () => {
    expectAllowed([
      `timeout 600 sh -c 'until ! ps aux | grep -q "[e]slint"; do sleep 10; done'`,
      "timeout 600 bash -c 'until curl -sf localhost:3000; do sleep 2; done'",
      'timeout 600 bash -c "while kill -0 $pid 2>/dev/null; do sleep 2; done"',
      "timeout -s KILL 10m sh -c 'until ! pgrep -f vitest; do sleep 5; done'",
      "gtimeout 600 zsh -c 'until test -f build/done; do sleep 2; done'",
      "n=0; until curl -sf localhost:3000 || [ $((n+=1)) -gt 300 ]; do sleep 2; done",
      "i=0; until ! pgrep vitest; do sleep 2; i=$((i+1)); [ $i -ge 60 ] && break; done",
      "while ! test -f out && (( SECONDS < 600 )); do sleep 2; done",
      "end=$((SECONDS+600)); while kill -0 $pid && [ $SECONDS -lt $end ]; do sleep 2; done",
      "stop=$(( $(date +%s) + 600 )); until curl -sf localhost:3000 || [ $(date +%s) -ge $stop ]; do sleep 2; done",
    ]);
  });

  it("allows a loop that does not sleep, or that is not an until or while loop", () => {
    expectAllowed([
      "kill -0 1234 && echo alive",
      "pgrep -f vitest || npm test",
      "while pgrep -f vitest; do pkill -f vitest; done",
      "for i in $(seq 60); do curl -sf localhost:3000 && break; sleep 2; done",
      "grep -n 'until ! kill -0' .claude/hooks/*.mjs",
    ]);
  });

  it("blocks a background command that no timeout bounds, naming the wrapped form", () => {
    const refused = [
      "npm run lint",
      "sleep 20; echo done",
      "cd apps/web && timeout 900 npm test",
      "timeout 0 npm run dev",
      "timeout 0s npm run dev",
      "timeout 600",
      "timeout npm run dev",
      "timeout 600 npm run build && npm run dev",
      "timeout 600 npm run build; npm run dev",
      "timeout 600 npm run build || npm run dev",
      "timeout 600 npm run build\nnpm run dev",
      "timeout 5 true & sleep 999",
      "timeout 5 true &",
      "env timeout 600 npm run lint",
    ];
    for (const command of refused) {
      const { status, stderr } = background(command);
      expect(status, command).toBe(2);
      expect(stderr, command).toContain("run_in_background");
      expect(stderr, command).toContain("timeout 900 sh -c");
    }
  });

  it("allows a background command a non-zero timeout bounds whole", () => {
    for (const command of [
      "timeout 900 npm run lint",
      "  timeout 15m npm test -w apps/cli",
      "timeout 900 npm run lint 2>&1 | tee /tmp/lint.log",
      "timeout -s KILL -k 5 1h npm run test:browser -w apps/web",
      "timeout --kill-after=5 --preserve-status 0.5h npm test",
      "gtimeout 600 npm run build",
      "timeout 900 sh -c 'cd apps/web && npm test; echo done'",
      'timeout 900 bash -c "npm run build && npm test"',
      "timeout 600 sh -c 'until curl -sf localhost:3000; do sleep 2; done'",
      "timeout 5 sh -c 'a && b'",
      "timeout 900 sh -c 'npm run dev & npm test'",
      "timeout 900 npm test &> /tmp/test.log",
      "timeout 900 npm test >& /tmp/test.log",
      "timeout 900 npm test |& tee /tmp/test.log",
    ]) {
      expect(background(command).status, command).toBe(0);
    }
  });

  it("reads the background rule only on a run_in_background call", () => {
    expectAllowed(["npm run lint", "timeout 0 npm test"]);
    expect(
      runHook({
        tool_name: "Bash",
        tool_input: { command: "npm run lint", run_in_background: false },
      }).status,
    ).toBe(0);
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
