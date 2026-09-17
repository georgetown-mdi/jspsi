// Reading a Bash command line, and putting a read-only question to git.
//
// Three hooks split a command line into stages and tokenize it before
// deciding anything, and five ran git to answer a question about a
// repository. Each carried its own copy. The splitters and the tokenizer are
// the code most likely to need a shared fix -- they are pragmatic and say so
// -- and a hole closed in one copy stayed open in the others.
//
// None of this is a shell parser and none will become one. What it reads is a
// plain command line: a subshell, a brace group, a command substitution, an
// alias, and a shell function all keep whatever they hold, and no expansion is
// performed. Each hook states in its own header what that leaves it unable to
// see.

import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

// A lone `&` is not a separator, by design: the same byte sits inside redirect
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
 * has no use for which pipeline held it.
 */
export function splitSegments(command) {
  return splitPipelines(command).flatMap(splitStages);
}

/**
 * A segment's words with their quotes still on them, for a caller reading a word
 * whose own text may hold a quote character -- an apostrophe inside a double-
 * quoted value, which `tokenize` strips along with the pair around it. Not
 * POSIX-complete.
 */
export function tokenizeRaw(segment) {
  return segment.match(TOKEN) ?? [];
}

/**
 * A segment's words, quoted spans kept whole and then stripped of every quote
 * character, so a quoted path or ref compares equal to a bare one. Stripping ALL
 * quotes rather than an outermost pair is what makes `HEAD:'staging'` normalize
 * to `HEAD:staging`; branch, remote and path names hold no quote of their own.
 * Not POSIX-complete.
 */
export function tokenize(segment) {
  return tokenizeRaw(segment).map((token) => token.replace(/['"]/g, ""));
}

// Options `cd` takes in front of its target. A lone `-` is not one of them: it
// is a target of its own, handled below.
const CD_OPTIONS = /^(?:--|-[A-Za-z]+)$/;

// A `$` or a `~` nothing here expands. The two-argument `cd` substitutes an
// argument's exact text into a pathname, so an unexpanded one would compute a
// destination the shell never visits.
const UNEXPANDED = /[$~]/;

// Targets naming a directory the shell remembers rather than one on disk: `-`
// is the previous directory and `-2`/`+1` index the directory stack. Neither is
// on the command line, so neither can be resolved from it.
const REMEMBERED_TARGET = /^[-+]\d*$/;

/**
 * The directory a command's leading `cd` moves to, from the resolved directory
 * `from` of the call. zsh's `cd` has two forms and this reads both. `cd
 * <target>` moves to the target, resolved against `from`. `cd <old> <new>`
 * moves to `from` with the first occurrence of <old> in its pathname replaced
 * by <new> -- a literal substring substitution, not a path-component one.
 *
 * Null when the command does not open with a `cd`, that `cd` names no target (a
 * bare `cd`, which goes home), it names a directory the shell remembers rather
 * than one on the command line (`-`, `-2`, `+1`), it holds more arguments than
 * either form takes (which zsh refuses), or its destination cannot be computed
 * here: an argument holding a `$` or a `~`, an <old> that does not occur in
 * `from`, a substitution whose result is relative.
 */
export function leadingCdDestination(command, from) {
  const leading = splitStages(splitPipelines(command)[0])[0];
  const tokens = tokenize(leading ?? "");
  if (tokens[0] !== "cd") return null;
  const args = tokens.slice(1).filter((token) => !CD_OPTIONS.test(token));
  if (args.length === 1) {
    return REMEMBERED_TARGET.test(args[0]) ? null : resolve(from, args[0]);
  }
  if (args.length !== 2) return null;

  const [old, replacement] = args;
  if (args.some((arg) => UNEXPANDED.test(arg))) return null;
  if (!from.includes(old)) return null;
  const destination = from.replace(old, () => replacement);
  return isAbsolute(destination) ? resolve(destination) : null;
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
