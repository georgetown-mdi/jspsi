#!/usr/bin/env node
// Audit: report Agent spawns in a session whose resolved model tier differs from
// the tier the spawn intended, plus every spawn that inherited the session model.
//
// A detection backstop, not a gate: it makes a silent require-agent-model fail-open
// or a pinned-definition regression visible after the fact. Read-only; exits
// nonzero and lists the mismatches when it finds any, else exit 0.
//
// Data model (verified against real sessions under ~/.claude/projects/):
//   - subagents/<id>.meta.json carries { agentType, toolUseId, ... } per spawn.
//   - toolUseId matches the parent Agent call's tool_use.id in the session
//     transcript (robust for sync and async spawns; the agent id does not appear in
//     a sync spawn's tool_use).
//   - the ACTUAL model is the paired tool_result record's
//     toolUseResult.resolvedModel (a canonical id like "claude-sonnet-5").
//   - the INTENDED model is the spawn tool_use.input.model if explicit, else the
//     frontmatter model of subagent_type's .claude/agents/ definition, else
//     "session-inherited".
//   - a canonical id's tier is the token after "claude-" (opus/sonnet/haiku/fable).

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// An intended value is either a tier alias (an explicit-model spawn or a
// frontmatter tier like "opus") or a canonical id whose tier we extract.
const TIER_ALIASES = new Set(["opus", "sonnet", "haiku", "fable"]);

// Encode the project working directory the way ~/.claude/projects/ names it: the
// absolute path with every "/" replaced by "-" (so /workspace -> -workspace).
function projectSlug(dir) {
  return dir.replace(/\//g, "-");
}

function projectsRoot() {
  return join(homedir(), ".claude", "projects", projectSlug(PROJECT_DIR));
}

// Resolve the arg into a session directory and its transcript. Accepts a bare
// session id, a path to the .jsonl transcript, or a path to the session directory;
// with no arg, picks the latest transcript under the project's projects root.
function resolveSession(arg) {
  const root = projectsRoot();
  if (arg) {
    // A path to a .jsonl transcript.
    if (arg.endsWith(".jsonl") && existsSync(arg)) {
      return { transcript: arg, dir: arg.slice(0, -".jsonl".length) };
    }
    // A path to (or bare id resolving under root to) a session directory.
    const asDir = existsSync(arg) ? arg : join(root, arg);
    const asTranscript = `${asDir}.jsonl`;
    if (existsSync(asTranscript))
      return { transcript: asTranscript, dir: asDir };
    if (existsSync(asDir) && statSync(asDir).isDirectory()) {
      return { transcript: asTranscript, dir: asDir };
    }
    throw new Error(`could not resolve session '${arg}'`);
  }
  const latest = latestTranscript(root);
  if (!latest) throw new Error(`no session transcripts under ${root}`);
  return { transcript: latest, dir: latest.slice(0, -".jsonl".length) };
}

function latestTranscript(root) {
  let best = null;
  let bestMtime = -Infinity;
  for (const entry of readdirSync(root)) {
    if (!entry.endsWith(".jsonl")) continue;
    const path = join(root, entry);
    const mtime = statSync(path).mtimeMs;
    if (mtime > bestMtime) {
      bestMtime = mtime;
      best = path;
    }
  }
  return best;
}

// Tier is the token immediately after "claude-" in a canonical model id.
function tierOf(modelId) {
  if (typeof modelId !== "string") return null;
  const match = modelId.match(/^claude-([a-z]+)/);
  return match ? match[1] : null;
}

// Frontmatter model of every .claude/agents/*.md, keyed by frontmatter name. Used
// to resolve the intended model of a bare (no explicit model) pinned spawn.
function frontmatterModels(agentsDir) {
  const models = new Map();
  if (!existsSync(agentsDir)) return models;
  for (const entry of readdirSync(agentsDir)) {
    if (!entry.endsWith(".md")) continue;
    const text = readFileSync(join(agentsDir, entry), "utf8");
    const lines = text.split("\n");
    if (lines[0].trim() !== "---") continue;
    let name = null;
    let model = null;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") break;
      const nameMatch = lines[i].match(/^name:\s*(.+?)\s*$/);
      if (nameMatch) name = nameMatch[1];
      const modelMatch = lines[i].match(/^model:\s*(.+?)\s*$/);
      if (modelMatch) model = modelMatch[1];
    }
    if (name && model) models.set(name, model);
  }
  return models;
}

// Index the transcript by tool_use.id: the spawn's input and its result's
// resolvedModel. One pass over the JSONL, tolerant of malformed lines.
function indexTranscript(transcriptPath) {
  const spawnInput = new Map(); // tool_use.id -> input object
  const resolvedModel = new Map(); // tool_use.id -> canonical model id
  const lines = readFileSync(transcriptPath, "utf8").split("\n");
  for (const line of lines) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const content = record?.message?.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item?.type === "tool_use" && item?.name === "Agent") {
          spawnInput.set(item.id, item.input || {});
        }
      }
    }
    const result = record?.toolUseResult;
    if (result && typeof result === "object" && result.resolvedModel) {
      // The result record's message.content holds the matching tool_result, but
      // toolUseResult carries agentId/resolvedModel directly; bridge by the
      // tool_use_id in the content block.
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item?.type === "tool_result" && item?.tool_use_id) {
            resolvedModel.set(item.tool_use_id, result.resolvedModel);
          }
        }
      }
    }
  }
  return { spawnInput, resolvedModel };
}

function readMetas(subagentsDir) {
  const metas = [];
  if (!existsSync(subagentsDir)) return metas;
  for (const entry of readdirSync(subagentsDir)) {
    if (!entry.endsWith(".meta.json")) continue;
    let meta;
    try {
      meta = JSON.parse(readFileSync(join(subagentsDir, entry), "utf8"));
    } catch {
      continue;
    }
    metas.push({ file: entry, ...meta });
  }
  return metas;
}

function main() {
  const arg = process.argv[2];
  const { transcript, dir } = resolveSession(arg);
  const subagentsDir = join(dir, "subagents");
  const agentsDir = join(PROJECT_DIR, ".claude", "agents");

  const frontmatter = frontmatterModels(agentsDir);
  const { spawnInput, resolvedModel } = indexTranscript(transcript);
  const metas = readMetas(subagentsDir);

  const mismatches = [];
  const inherited = [];
  let audited = 0;

  for (const meta of metas) {
    const toolUseId = meta.toolUseId;
    if (!toolUseId) continue;
    const input = spawnInput.get(toolUseId);
    const resolved = resolvedModel.get(toolUseId);
    // No paired call in this transcript (e.g. a spawn from a parent session): skip.
    if (input === undefined && resolved === undefined) continue;
    audited++;

    const agentType = meta.agentType;
    let intended;
    if (input && typeof input.model === "string" && input.model.length > 0) {
      intended = input.model;
    } else if (agentType && frontmatter.has(agentType)) {
      intended = frontmatter.get(agentType);
    } else {
      intended = "session-inherited";
    }

    const resolvedTier = tierOf(resolved);
    const row = {
      agentType,
      toolUseId,
      description: meta.description,
      intended,
      resolved: resolved ?? "(unknown)",
      resolvedTier: resolvedTier ?? "(unknown)",
    };

    if (intended === "session-inherited") {
      inherited.push(row);
      continue;
    }
    const intendedTier = TIER_ALIASES.has(intended)
      ? intended
      : tierOf(intended);
    if (intendedTier !== resolvedTier)
      mismatches.push({ ...row, intendedTier });
  }

  report({ transcript, audited, mismatches, inherited });
  process.exit(mismatches.length > 0 || inherited.length > 0 ? 1 : 0);
}

function report({ transcript, audited, mismatches, inherited }) {
  process.stdout.write(`Auditing ${transcript}\n`);
  process.stdout.write(`Spawns audited: ${audited}\n\n`);

  if (mismatches.length === 0 && inherited.length === 0) {
    process.stdout.write("OK: every spawn resolved to its intended tier.\n");
    return;
  }

  if (mismatches.length > 0) {
    process.stdout.write(`Tier mismatches (${mismatches.length}):\n`);
    for (const m of mismatches) {
      process.stdout.write(
        `  ${m.agentType} [${m.toolUseId}]: intended ${m.intended} ` +
          `(${m.intendedTier}) but resolved ${m.resolved} (${m.resolvedTier})` +
          (m.description ? ` -- ${m.description}` : "") +
          "\n",
      );
    }
    process.stdout.write("\n");
  }

  if (inherited.length > 0) {
    process.stdout.write(`Session-inherited spawns (${inherited.length}):\n`);
    for (const s of inherited) {
      process.stdout.write(
        `  ${s.agentType} [${s.toolUseId}]: no explicit or pinned model; ` +
          `resolved ${s.resolved} (${s.resolvedTier})` +
          (s.description ? ` -- ${s.description}` : "") +
          "\n",
      );
    }
  }
}

main();
