#!/usr/bin/env node
// PreToolUse hook: refuse `git push` whose destination is a protected branch
// (staging/main).
//
// Why this exists: the gated-autonomous-push work removes the blanket `git push`
// deny from .claude/settings.json so a contained, unattended agent can push
// feature branches and open PRs without an interactive prompt. This hook is the
// client-side half of the replacement gate; GitHub branch protection on
// staging/main is the authoritative server-side half. The hook gives an
// unattended agent instant local feedback instead of a wasted network round-trip
// the server would reject anyway -- it is defense-in-depth, not the wall.
//
// Why a hook and not an `ask` rule: the container runs in bypassPermissions mode,
// which skips `ask` prompts (and an `ask` would stall an unattended agent anyway).
// PreToolUse hooks run in every permission mode, including bypass, so the gate
// holds there. Exit 0 allows the call; exit 2 blocks it and feeds stderr back to
// Claude. Any unexpected failure here falls through to exit 0 (fail open) so a bug
// in this hook can never wedge every Bash command -- branch protection backstops a
// push this hook misses.

import { commandOf, eventCwd, eventForTools } from "./lib/event.mjs";
import { git, splitSegments, tokenize } from "./lib/shell.mjs";

const PROTECTED = new Set(["staging", "main"]);

function block(reason) {
  process.stderr.write(
    `Blocked by block-protected-push hook: ${reason}.\n` +
      "staging and main are protected; open a PR from a feature branch instead.\n",
  );
  process.exit(2);
}

// git global options that consume a following token as their value, so the
// subcommand scan does not mistake that value for the subcommand.
const VALUE_GLOBALS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
]);

// If this segment invokes `git push`, return the argument list after `push`;
// otherwise null. Requires git to be the command word (after leading env
// assignments and simple wrappers) so `echo git push ...` is not mistaken for one.
function gitPushArgs(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++; // leading env assignment: FOO=bar git ...
      continue;
    }
    if (t === "sudo" || t === "command" || t === "env" || t === "nice") {
      i++;
      continue;
    }
    break;
  }
  const cmd = tokens[i];
  if (!cmd) return null;
  if (cmd.replace(/^.*\//, "") !== "git") return null;
  i++;
  while (i < tokens.length && tokens[i].startsWith("-")) {
    i += VALUE_GLOBALS.has(tokens[i]) ? 2 : 1;
  }
  if (tokens[i] !== "push") return null;
  return tokens.slice(i + 1);
}

// Destination branch names targeted by an explicit refspec, or null when the push
// gives no refspec (a bare `git push` / `git push <remote>`), which must be
// resolved against the branch's configured push target instead.
function explicitDestinations(args) {
  const positionals = [];
  let skipNext = false;
  for (const a of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (a.startsWith("-")) {
      // push options that take a separate value, so the value is not treated as a
      // refspec (e.g. `--push-option staging`).
      if (/^(-o|--push-option|--repo|--exec|--receive-pack)$/.test(a)) {
        skipNext = true;
      }
      continue;
    }
    positionals.push(a);
  }
  // 0 positionals: bare `git push`. 1 positional: `git push <remote>` -- still no
  // refspec, so the destination follows push.default. Both resolve via @{push}.
  if (positionals.length < 2) return null;
  const [, ...refspecs] = positionals;
  return refspecs.map((r) => {
    // `src:dst` and `+src:dst` (force) target dst; `:dst` (delete) targets dst; a
    // bare ref targets itself. Normalize a refs/heads/ prefix to the branch name.
    const spec = r.replace(/^\+/, "");
    const colon = spec.indexOf(":");
    const dst = colon >= 0 ? spec.slice(colon + 1) : spec;
    return dst.replace(/^refs\/heads\//, "");
  });
}

// Decide whether a bare `git push` (no refspec) would land on a protected branch.
function barePushVerdict(cwd) {
  const current = git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd });
  if (current && PROTECTED.has(current)) {
    return `bare 'git push' while on protected branch '${current}'`;
  }
  const pushRef = git(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{push}"],
    { cwd },
  );
  if (pushRef) {
    const dst = pushRef.replace(/^[^/]+\//, ""); // strip the "origin/" remote
    if (PROTECTED.has(dst)) {
      return `bare 'git push' resolves to protected branch '${dst}' via @{push}`;
    }
    return null; // resolves to a non-protected branch -- allow
  }
  // No resolvable push target. A bare push here either errors (git will ask for
  // -u) or relies on push.default landing somewhere unverifiable; refuse and make
  // the agent name an explicit, non-protected destination.
  return "bare 'git push' has no resolvable upstream; specify an explicit destination, e.g. 'git push -u origin <branch>'";
}

function main() {
  const event = eventForTools("Bash");
  if (event === null) process.exit(0); // unreadable, or another tool
  const command = commandOf(event);
  if (command === null || !command.includes("push")) process.exit(0);
  const cwd = eventCwd(event) ?? process.cwd();

  for (const segment of splitSegments(command)) {
    const args = gitPushArgs(tokenize(segment));
    if (!args) continue;
    // --all / --mirror push (or mirror) every ref, including staging and main, and
    // hold no refspec to inspect -- so they would otherwise fall through to
    // barePushVerdict and be allowed from a feature branch. Refuse them outright; a
    // legitimate feature-branch push names an explicit refspec, never --all/--mirror.
    if (args.some((a) => a === "--all" || a === "--mirror")) {
      block(
        "'git push --all'/'--mirror' pushes every ref, including staging and main",
      );
    }
    const dests = explicitDestinations(args);
    if (dests === null) {
      const verdict = barePushVerdict(cwd);
      if (verdict) block(verdict);
      continue;
    }
    for (const dst of dests) {
      if (PROTECTED.has(dst)) block(`push targets protected branch '${dst}'`);
    }
  }
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // fail open: never wedge Bash on an unexpected hook error
}
