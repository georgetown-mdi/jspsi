import { describe, expect, it } from "vitest";
import {
  classifySpawn,
  classifyWorkflowAgent,
  tierOf,
} from "./audit-agent-models.mjs";

// Build the two transcript indexes classifySpawn expects (tool_use.id -> input,
// tool_use.id -> canonical resolved model id) from plain object literals, so a
// fixture reads as a small table with no filesystem or JSONL parsing.
function indexes(spawns) {
  const spawnInput = new Map();
  const resolvedModel = new Map();
  for (const s of spawns) {
    if ("input" in s) spawnInput.set(s.toolUseId, s.input);
    if ("resolved" in s) resolvedModel.set(s.toolUseId, s.resolved);
  }
  return { spawnInput, resolvedModel };
}

describe("tierOf", () => {
  it("extracts the tier token after claude-", () => {
    expect(tierOf("claude-sonnet-5")).toBe("sonnet");
    expect(tierOf("claude-opus-4-8")).toBe("opus");
  });

  it("returns null for a non-string or unparseable id", () => {
    expect(tierOf(undefined)).toBe(null);
    expect(tierOf("gpt-4")).toBe(null);
  });
});

describe("classifySpawn", () => {
  const frontmatter = new Map([["implementer", "opus"]]);

  it("reports a tier mismatch (explicit model resolved to a different tier)", () => {
    const meta = {
      toolUseId: "t1",
      agentType: "general-purpose",
      description: "d",
    };
    const { spawnInput, resolvedModel } = indexes([
      {
        toolUseId: "t1",
        input: { model: "opus" },
        resolved: "claude-sonnet-5",
      },
    ]);
    const result = classifySpawn(meta, spawnInput, resolvedModel, frontmatter);
    expect(result.category).toBe("audited");
    expect(result.kind).toBe("mismatch");
    expect(result.row.intendedTier).toBe("opus");
    expect(result.row.resolvedTier).toBe("sonnet");
  });

  it("reports a session-inherited spawn (no explicit or pinned model)", () => {
    const meta = { toolUseId: "t2", agentType: "unpinned", description: "d" };
    const { spawnInput, resolvedModel } = indexes([
      { toolUseId: "t2", input: {}, resolved: "claude-sonnet-5" },
    ]);
    const result = classifySpawn(meta, spawnInput, resolvedModel, frontmatter);
    expect(result.category).toBe("audited");
    expect(result.kind).toBe("inherited");
    expect(result.row.intended).toBe("session-inherited");
  });

  it("reports nothing for a clean spawn (resolved tier matches intent)", () => {
    const explicit = classifySpawn(
      { toolUseId: "t3", agentType: "general-purpose", description: "d" },
      ...twoIndexArgs([
        {
          toolUseId: "t3",
          input: { model: "sonnet" },
          resolved: "claude-sonnet-5",
        },
      ]),
      frontmatter,
    );
    expect(explicit.category).toBe("audited");
    expect(explicit.kind).toBe("ok");

    // A pinned bare spawn whose frontmatter tier matches the resolved tier.
    const pinned = classifySpawn(
      { toolUseId: "t4", agentType: "implementer", description: "d" },
      ...twoIndexArgs([
        { toolUseId: "t4", input: {}, resolved: "claude-opus-4-8" },
      ]),
      frontmatter,
    );
    expect(pinned.category).toBe("audited");
    expect(pinned.kind).toBe("ok");
  });

  // Regression for the audit false-positive on an unresolved spawn: an in-flight
  // (async/background) spawn has its Agent tool_use present but its result absent,
  // so input is defined and resolved is undefined. It must be skipped, not audited
  // as a spurious tier mismatch (intended resolves, resolvedTier would be null).
  it("skips a spawn with an input but no resolved model", () => {
    const meta = {
      toolUseId: "t5",
      agentType: "general-purpose",
      description: "in flight",
    };
    const { spawnInput, resolvedModel } = indexes([
      { toolUseId: "t5", input: { model: "opus" } },
    ]);
    const result = classifySpawn(meta, spawnInput, resolvedModel, frontmatter);
    expect(result.category).toBe("skip");
  });

  it("skips a meta with no toolUseId", () => {
    const result = classifySpawn(
      { agentType: "general-purpose" },
      new Map(),
      new Map(),
      frontmatter,
    );
    expect(result.category).toBe("skip");
  });
});

describe("classifyWorkflowAgent", () => {
  const frontmatter = new Map([
    ["security-reviewer", "opus"],
    ["adversarial-verifier", "opus"],
  ]);
  const meta = (fields) => ({
    workflow: "run-1/agent-a.meta.json",
    description: "d",
    ...fields,
  });

  it("reports a role spawned off its pinned tier", () => {
    const result = classifyWorkflowAgent(
      meta({ agentType: "security-reviewer", model: "claude-sonnet-5" }),
      frontmatter,
    );
    expect(result.category).toBe("audited");
    expect(result.kind).toBe("mismatch");
    expect(result.row.intended).toBe("opus");
    expect(result.row.intendedTier).toBe("opus");
    expect(result.row.resolvedTier).toBe("sonnet");
    expect(result.row.workflow).toBe("run-1/agent-a.meta.json");
  });

  it("accepts a role on its pinned tier, whether the model is an alias or a canonical id", () => {
    for (const model of ["opus", "claude-opus-5"]) {
      const result = classifyWorkflowAgent(
        meta({ agentType: "adversarial-verifier", model }),
        frontmatter,
      );
      expect(result.kind).toBe("ok");
      expect(result.row.resolvedTier).toBe("opus");
    }
  });

  it("reports a meta that recorded no model at all", () => {
    const result = classifyWorkflowAgent(
      meta({ agentType: "security-reviewer" }),
      frontmatter,
    );
    expect(result.kind).toBe("inherited");
    expect(result.row.intended).toBe("session-inherited");
    expect(result.row.resolved).toBe("(unrecorded)");
  });

  it("passes an unpinned agent, which has no intent to compare against", () => {
    const result = classifyWorkflowAgent(
      meta({ model: "claude-sonnet-5" }),
      frontmatter,
    );
    expect(result.kind).toBe("ok");
    expect(result.row.agentType).toBe("(none)");
    expect(result.row.intended).toBe("claude-sonnet-5");
  });

  it("audits without a toolUseId, which a workflow meta never carries", () => {
    const result = classifyWorkflowAgent(
      meta({ agentType: "security-reviewer", model: "claude-opus-5" }),
      frontmatter,
    );
    expect(result.category).toBe("audited");
    expect(result.row.toolUseId).toBeUndefined();
  });
});

// Spread helper: classifySpawn takes (meta, spawnInput, resolvedModel, frontmatter);
// this yields the two map args in order for the spread call sites above.
function twoIndexArgs(spawns) {
  const { spawnInput, resolvedModel } = indexes(spawns);
  return [spawnInput, resolvedModel];
}
