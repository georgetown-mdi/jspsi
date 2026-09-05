// Reading a Bash command line, and putting a read-only question to git.
//
// Three hooks split a command line into stages and tokenize it before deciding
// anything, and five ran git to answer a question about a repository. Each
// carried its own copy. The splitters and the tokenizer are the code most likely
// to need a shared fix -- they are pragmatic and say so -- and a hole closed in
// one copy stayed open in the others.
//
// None of this is a shell parser and none will become one. What it reads is a
// plain command line: a subshell, a brace group, a command substitution, an
// alias, and a shell function all keep whatever they hold, and no expansion is
// performed. Each hook states in its own header what that leaves it unable to
// see.

import { execFileSync } from "node:child_process";

// A lone `&` is deliberately not a separator: the same byte sits inside redirect
// words (`2>&1`, `&>`), where a split severs a command from operands that follow
// the redirect, and a backgrounded `cd X &` runs in a subshell that never moves
// the parent shell's directory. Both measured against real bash.
const PIPELINE_SEPARATOR = /\s*(?:&&|\|\||[;\n])\s*/;
const STAGE_SEPARATOR = /\s*\|\s*/;
const TOKEN = /(?:[^\s'"]+|'[^']*'|"[^"]*")+/g;

/** A command line's pipelines, split on &&, ||, ; and a newline. */
export function splitPipelines(command) {
  return command.split(PIPELINE_SEPARATOR);
}

/** One pipeline's stages, split on the pipe. */
export function splitStages(pipeline) {
  return pipeline.split(STAGE_SEPARATOR);
}

/**
 * Every stage of every pipeline, for a hook that reads each stage on its own and
 * has no use for which pipeline carried it.
 */
export function splitSegments(command) {
  return splitPipelines(command).flatMap(splitStages);
}

/**
 * A segment's words, quoted spans kept whole and then stripped of every quote
 * character, so a quoted path or ref reads the same as a bare one. Stripping ALL
 * quotes rather than an outermost pair is what makes `HEAD:'staging'` normalize
 * to `HEAD:staging`; branch, remote and path names carry no quote of their own.
 * Not POSIX-complete.
 */
export function tokenize(segment) {
  return (segment.match(TOKEN) ?? []).map((token) =>
    token.replace(/['"]/g, ""),
  );
}

/**
 * Run git and return its trimmed stdout, or null on any failure: a non-zero
 * exit, no git on PATH, a directory that is not a repository. What a null means
 * is the caller's to decide, since these hooks do not fail the same way.
 */
export function git(args, { cwd } = {}) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
