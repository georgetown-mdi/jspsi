import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HOOK = fileURLToPath(
  new URL("./block-model-drop-sendmessage.mjs", import.meta.url),
);

// Run the hook as a real subprocess with a synthesized PreToolUse payload on
// stdin. Exit 0 allows the send, exit 2 blocks it and feeds stderr back to
// Claude; the hook is marker-gated with no file I/O, so no fixture is needed.
function runHook(payload) {
  const { status, stderr } = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return { status, stderr };
}

function send(toolInput) {
  return runHook({ tool_name: "SendMessage", tool_input: toolInput });
}

describe("block-model-drop-sendmessage hook", () => {
  it("ignores tools other than SendMessage", () => {
    const { status } = runHook({
      tool_name: "Agent",
      tool_input: { model: "opus", prompt: "carry on" },
    });
    expect(status).toBe(0);
  });

  it("ignores an unparseable event", () => {
    const { status } = spawnSync("node", [HOOK], {
      input: "not json",
      encoding: "utf8",
    });
    expect(status).toBe(0);
  });

  it("blocks a payload that parses to something other than an object", () => {
    const { status, stderr } = spawnSync("node", [HOOK], {
      input: "null",
      encoding: "utf8",
    });
    expect(status).toBe(2);
    expect(stderr).toContain("could not confirm the message");
  });

  it("blocks a send that continues a spawned agent", () => {
    const { status, stderr } = send({
      to: "agent-7",
      message: "Also fix the timeout while you are in there.",
    });
    expect(status).toBe(2);
    expect(stderr).toContain("loses its pinned tier");
    expect(stderr).toContain("[accept-model-drop]");
  });

  it("allows a subagent reporting up to main", () => {
    const { status } = send({ to: "main", message: "Done; branch pushed." });
    expect(status).toBe(0);
  });

  it("allows a send carrying the override marker", () => {
    const { status } = send({
      to: "agent-7",
      message: "[accept-model-drop] Stop after the current file.",
    });
    expect(status).toBe(0);
  });

  it("blocks when there is no message to inspect", () => {
    expect(send({ to: "agent-7" }).status).toBe(2);
    expect(send({ to: "agent-7", message: 42 }).status).toBe(2);
    expect(send({}).status).toBe(2);
  });

  it("does not accept a near-miss marker", () => {
    const { status } = send({
      to: "agent-7",
      message: "accept model drop, please continue.",
    });
    expect(status).toBe(2);
  });
});
