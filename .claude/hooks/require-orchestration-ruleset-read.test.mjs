import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HOOK = fileURLToPath(
  new URL("./require-orchestration-ruleset-read.mjs", import.meta.url),
);
const RECORDER = fileURLToPath(
  new URL("./record-orchestration-ruleset-read.mjs", import.meta.url),
);
const RULESET = fileURLToPath(
  new URL("../orchestration/ruleset.md", import.meta.url),
);

const MARKER_SUBDIR = "psilink-orchestration-reads";
const SESSION = "8f2b1c66-0000-4000-8000-0123456789ab";
const HOUR_MS = 60 * 60 * 1000;

const dirs = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

// Every run is pointed at a throwaway TMPDIR, which is where both hooks derive
// the marker directory from, so no test sees another test's record or this
// machine's real ones.
function makeMarkerRoot() {
  const dir = mkdtempSync(join(tmpdir(), "ruleset-gate-"));
  dirs.push(dir);
  return dir;
}

function runHook(payload, markerRoot, hook = HOOK) {
  const { status, stderr } = spawnSync("node", [hook], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, TMPDIR: markerRoot },
  });
  return { status, stderr };
}

function recordRead(markerRoot, { session = SESSION, ageMs = 0 } = {}) {
  const path = join(markerRoot, MARKER_SUBDIR, session);
  mkdirSync(join(markerRoot, MARKER_SUBDIR), { recursive: true });
  writeFileSync(path, `${new Date().toISOString()}\n`);
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    utimesSync(path, when, when);
  }
  return path;
}

const spawn = (extra = {}) => ({
  tool_name: "Agent",
  tool_input: { subagent_type: "implementer", prompt: "x" },
  session_id: SESSION,
  ...extra,
});

const workflow = (extra = {}) => ({
  tool_name: "Workflow",
  tool_input: { scriptPath: ".claude/scripts/light-review-workflow.mjs" },
  session_id: SESSION,
  ...extra,
});

describe("require-orchestration-ruleset-read hook", () => {
  it("ignores tools other than Agent and Workflow", () => {
    const root = makeMarkerRoot();
    const { status } = runHook(
      { tool_name: "Bash", tool_input: { command: "ls" }, session_id: SESSION },
      root,
    );
    expect(status).toBe(0);
  });

  it("allows a call whose event cannot be read", () => {
    const root = makeMarkerRoot();
    for (const payload of ["not json", "", "null", '["Agent"]', "7"]) {
      expect(runHook(payload, root).status, payload).toBe(0);
    }
  });

  it("refuses a first spawn in a session with no recorded read", () => {
    const root = makeMarkerRoot();
    const { status, stderr } = runHook(spawn(), root);
    expect(status).toBe(2);
    expect(stderr).toContain("has not read .claude/orchestration/ruleset.md");
    expect(stderr).toContain(`cat '${RULESET}'`);
  });

  it("refuses a Workflow call the same way", () => {
    const root = makeMarkerRoot();
    const { status, stderr } = runHook(workflow(), root);
    expect(status).toBe(2);
    expect(stderr).toContain(`cat '${RULESET}'`);
  });

  it("allows every later call once the read is recorded", () => {
    const root = makeMarkerRoot();
    recordRead(root);
    expect(runHook(spawn(), root).status).toBe(0);
    expect(runHook(spawn(), root).status).toBe(0);
    expect(runHook(workflow(), root).status).toBe(0);
  });

  it("refuses again once the recorded read is stale", () => {
    const root = makeMarkerRoot();
    recordRead(root, { ageMs: 9 * HOUR_MS });
    const { status, stderr } = runHook(spawn(), root);
    expect(status).toBe(2);
    expect(stderr).toContain("9 hours ago");
    expect(stderr).toContain(`cat '${RULESET}'`);
  });

  it("allows a read recorded inside the window", () => {
    const root = makeMarkerRoot();
    recordRead(root, { ageMs: 7 * HOUR_MS });
    expect(runHook(spawn(), root).status).toBe(0);
  });

  it("does not let one session's read stand for another's", () => {
    const root = makeMarkerRoot();
    recordRead(root, { session: "another-session" });
    expect(runHook(spawn(), root).status).toBe(2);
  });

  it("allows a call whose event names no session to key a read on", () => {
    const root = makeMarkerRoot();
    for (const session_id of [undefined, "", 7, ".."]) {
      const payload = spawn({ session_id });
      if (session_id === undefined) delete payload.session_id;
      expect(runHook(payload, root).status, String(session_id)).toBe(0);
    }
  });

  // A spawned agent is told not to read the ruleset, so its own spawns pass
  // whatever session id the payload carries them under.
  it("allows a spawn made from inside a subagent", () => {
    const root = makeMarkerRoot();
    for (const transcript_path of [
      "/home/node/.claude/projects/-workspace/8f2b1c66/subagents/agent-a385eb.jsonl",
      "/home/node/.claude/projects/-workspace/8f2b1c66/agent-a385eb.jsonl",
    ]) {
      const { status } = runHook(
        spawn({ session_id: "subagent-session", transcript_path }),
        root,
      );
      expect(status, transcript_path).toBe(0);
    }
  });

  it("still gates a session whose transcript is the session's own", () => {
    const root = makeMarkerRoot();
    const { status } = runHook(
      spawn({
        transcript_path: `/home/node/.claude/projects/-workspace/${SESSION}.jsonl`,
      }),
      root,
    );
    expect(status).toBe(2);
  });

  // The two hooks derive one marker path from one session id; a divergence
  // between them would refuse every spawn in every session, so the pair is
  // driven end to end here rather than each against its own fixture.
  it("lets the call through after the recorder sees a shell read", () => {
    const root = makeMarkerRoot();
    const recorded = runHook(
      {
        tool_name: "Bash",
        tool_input: { command: `cat ${RULESET}` },
        session_id: SESSION,
      },
      root,
      RECORDER,
    );
    expect(recorded.status).toBe(0);
    expect(runHook(spawn(), root).status).toBe(0);
  });
});
