#!/usr/bin/env node
// PostToolUse hook: record that this session has read
// .claude/orchestration/ruleset.md, which is what
// require-orchestration-ruleset-read.mjs lets the session's first Agent or
// Workflow call through on.
//
// BOTH WAYS THE FILE IS READ COUNT. A Read of it is the obvious one; a Bash
// command line naming it is the common one, since an orchestrating session
// reaches for `cat`, `sed -n`, `head`, `less` or `bat` on a file this size. A
// recorder that watched the Read tool alone would leave the sessions that use
// the shell refused however carefully they had read the rules.
//
// WHAT THE BASH ARM MATCHES, and the direction it errs in. Any command line
// containing the ruleset's path counts, without deciding which command in it
// reads the file or whether the command succeeded -- a command that merely names
// the path records a read that did not happen. That is the direction to fail in:
// a spurious record costs the gate one session's worth of enforcement, while a
// missed record refuses a session that did read the rules and sends it looking
// for a reason. Command OUTPUT is not read here, so grepping or printing a file
// that quotes the path records nothing.
//
// The marker path, the session key and the freshness window: lib/rulesetRead.mjs.
//
// PostToolUse cannot block -- the call has already run -- and this hook emits no
// context either: the gate it feeds exists to keep the ruleset OUT of every
// spawn's context, and a message here would put a line of it back. So the only
// outcomes are a marker on disk or nothing at all, and every error is silent.

import { commandOf, eventForTools } from "./lib/event.mjs";
import {
  markerPath,
  recordRead,
  RULESET_PATH,
  RULESET_TAIL,
} from "./lib/rulesetRead.mjs";

function readsRuleset(event) {
  if (event.tool_name === "Bash") {
    const command = commandOf(event);
    return (
      command !== null && command.replace(/\\/g, "/").includes(RULESET_TAIL)
    );
  }
  const target = event.tool_input?.file_path;
  return (
    typeof target === "string" &&
    target.replace(/\\/g, "/").endsWith(RULESET_PATH)
  );
}

function main() {
  const event = eventForTools("Bash", "Read");
  if (event === null) process.exit(0); // unreadable, or another tool
  if (!readsRuleset(event)) process.exit(0);

  const path = markerPath(event.session_id);
  if (path === null) process.exit(0); // no session to key the read on
  recordRead(path);
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // fail open: never disrupt the session on an unexpected error
}
