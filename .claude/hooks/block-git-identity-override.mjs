#!/usr/bin/env node
// PreToolUse hook: refuse a Bash command that sets the git author or committer
// identity, so the only identity that can reach a commit is the one git resolves
// from .git/config.
//
// Why this exists: every session and every subagent receives the harness login's
// address in its context block, and an agent that reaches for it commits under an
// identity that appears in no git config on the machine -- unrelated to the
// repository's account, and invisible in review because the commit reads as
// ordinary. Overriding the identity is never the agent's call: a wrong configured
// identity is something to report to the maintainer, not to correct on the command
// line. The refusal happens at the tool call because the after-the-fact repair is a
// history rewrite.
//
// Exit 0 allows the call; exit 2 blocks it and feeds stderr back to Claude. Any
// unexpected failure here falls through to exit 0 (fail open) so a bug in this hook
// can never wedge every Bash command.

import { commandOf, eventForTools } from "./lib/event.mjs";
import { splitSegments, tokenize } from "./lib/shell.mjs";

const IDENTITY_ENV = new Set([
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
]);

function block(reason) {
  process.stderr.write(
    `Blocked by block-git-identity-override hook: ${reason}.\n` +
      "Let git resolve the identity from .git/config; if the configured identity is " +
      "wrong, say so to the maintainer instead of overriding it on the command line.\n",
  );
  process.exit(2);
}

// Words that stand in front of the real command word without changing which
// command runs; `export` earns its place here because `export FOO=bar` sets the
// same variable a `FOO=bar cmd` prefix does.
const COMMAND_PREFIX_WORDS = new Set([
  "sudo",
  "command",
  "env",
  "nice",
  "export",
]);

// Peel the leading environment assignments and prefix words off a segment,
// returning those assignments and the command that follows them.
function splitCommandPrefix(tokens) {
  const assignments = [];
  let sawPrefixWord = false;
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      assignments.push(token);
      i++;
      continue;
    }
    if (COMMAND_PREFIX_WORDS.has(token)) {
      sawPrefixWord = true;
      i++;
      continue;
    }
    // A flag belonging to a prefix word (`env -i FOO=bar git ...`); before any
    // prefix word a flag means this segment is not a command invocation at all.
    if (sawPrefixWord && token.startsWith("-")) {
      i++;
      continue;
    }
    break;
  }
  return { assignments, rest: tokens.slice(i) };
}

function identityAssignment(assignments) {
  for (const assignment of assignments) {
    const name = assignment.slice(0, assignment.indexOf("="));
    if (IDENTITY_ENV.has(name)) return name;
  }
  return null;
}

// git global options that consume a following token as their value, so the
// subcommand scan does not mistake that value for the subcommand.
const VALUE_GLOBALS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
]);

// Read a git invocation as the config keys its global options set, the
// subcommand, and that subcommand's arguments; null when the segment does not
// invoke git as its command word (so `echo git commit --author=x` is not one).
function gitInvocation(tokens) {
  const command = tokens[0];
  if (!command || command.replace(/^.*\//, "") !== "git") return null;
  const configOptions = [];
  let i = 1;
  while (i < tokens.length && tokens[i].startsWith("-")) {
    const token = tokens[i];
    const equals = token.indexOf("=");
    const option = equals >= 0 ? token.slice(0, equals) : token;
    const attached = equals >= 0 ? token.slice(equals + 1) : null;
    // `-c name=value` always takes a separate token; `--config-env name=envvar`
    // takes either form.
    if (option === "-c" || option === "--config-env") {
      const setting = attached ?? tokens[i + 1];
      if (setting !== undefined) {
        configOptions.push({ option, key: configKey(setting) });
      }
      i += attached === null ? 2 : 1;
      continue;
    }
    i += VALUE_GLOBALS.has(option) && attached === null ? 2 : 1;
  }
  return { configOptions, subcommand: tokens[i], args: tokens.slice(i + 1) };
}

// Config key names are case-insensitive in git (`-c USER.NAME=x` sets user.name),
// so every key is compared lowercased.
function configKey(setting) {
  const equals = setting.indexOf("=");
  return (equals >= 0 ? setting.slice(0, equals) : setting).toLowerCase();
}

// `user` itself counts: renaming the section renames the identity out from under
// the keys git resolves.
function isIdentityKey(key) {
  return key === "user.name" || key === "user.email" || key === "user";
}

const CONFIG_READ_FLAGS = new Set([
  "--get",
  "--get-all",
  "--get-regexp",
  "--get-urlmatch",
  "--get-color",
  "--get-colorbool",
  "--list",
  "-l",
]);

const CONFIG_WRITE_FLAGS = new Set([
  "--add",
  "--replace-all",
  "--rename-section",
]);

// Flags that clear a key rather than record a value under it. Naming the mode
// keeps `git config --unset user.email <value-pattern>` -- key plus value, the
// shape a bare write has -- from reading as a write.
const CONFIG_CLEAR_FLAGS = new Set([
  "--unset",
  "--unset-all",
  "--remove-section",
]);

const CONFIG_VALUE_OPTIONS = new Set([
  "--file",
  "-f",
  "--blob",
  "--type",
  "--default",
]);

// The `git config <action> <key>` spelling (`git config set user.email ...`)
// newer git accepts, naming the mode where the older flags did.
const CONFIG_ACTION_MODES = new Map([
  ["get", "read"],
  ["list", "read"],
  ["set", "write"],
  ["unset", "clear"],
  ["rename-section", "write"],
  ["remove-section", "clear"],
]);

// The identity key a `git config` invocation records a value under, or null when
// it only reads or clears one. Clearing is left alone: it takes an identity out
// of resolution rather than substituting another, which leaves git resolving from
// the config it would have used anyway. Scope flags (--global, --local, --system,
// --file) do not enter into it: a write at any scope changes what git resolves.
function configWriteTarget(args) {
  let mode = null;
  const positionals = [];
  let skipNext = false;
  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg.startsWith("-")) {
      const option = arg.split("=")[0];
      if (CONFIG_VALUE_OPTIONS.has(option) && !arg.includes("=")) {
        skipNext = true;
      }
      if (mode === null && CONFIG_READ_FLAGS.has(option)) mode = "read";
      if (mode === null && CONFIG_WRITE_FLAGS.has(option)) mode = "write";
      if (mode === null && CONFIG_CLEAR_FLAGS.has(option)) mode = "clear";
      continue;
    }
    positionals.push(arg);
  }
  let keyIndex = 0;
  const action = CONFIG_ACTION_MODES.get(positionals[0]);
  if (mode === null && action !== undefined) {
    mode = action;
    keyIndex = 1;
  }
  // No mode named by a flag or an action word: a key alone reads it, a key
  // followed by a value writes it.
  if (mode === null) mode = positionals.length > 1 ? "write" : "read";
  if (mode !== "write") return null;
  const key = positionals[keyIndex]?.toLowerCase();
  return key !== undefined && isIdentityKey(key) ? key : null;
}

function main() {
  const event = eventForTools("Bash");
  if (event === null) process.exit(0); // unreadable, or another tool
  const command = commandOf(event);
  if (command === null) process.exit(0);
  if (!command.includes("git") && !command.includes("GIT_")) process.exit(0);

  for (const segment of splitSegments(command)) {
    const { assignments, rest } = splitCommandPrefix(tokenize(segment));
    const variable = identityAssignment(assignments);
    if (variable) {
      block(`'${variable}=...' sets the commit identity in the environment`);
    }
    const invocation = gitInvocation(rest);
    if (!invocation) continue;
    for (const { option, key } of invocation.configOptions) {
      if (isIdentityKey(key)) {
        block(
          `'git ${option} ${key}=...' overrides the identity git would resolve`,
        );
      }
    }
    // Only `git commit` records an author from --author; elsewhere (`git log
    // --author=x`, `git shortlog --author=x`) it filters and changes nothing.
    if (
      invocation.subcommand === "commit" &&
      invocation.args.some((a) => a === "--author" || a.startsWith("--author="))
    ) {
      block("'git commit --author=...' records an author git did not resolve");
    }
    if (invocation.subcommand === "config") {
      const key = configWriteTarget(invocation.args);
      if (key) block(`'git config' writes '${key}'`);
    }
  }
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // fail open: never wedge Bash on an unexpected hook error
}
