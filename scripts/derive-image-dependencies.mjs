#!/usr/bin/env node
// What the shipped file-drop support scripts ask of the psilink image, read out
// of the scripts themselves rather than kept in a list beside them.
//
// Those scripts delegate every check they make to a capability of the image:
// they hand a container a psilink subcommand, or they pipe one of their helper
// scripts into a shell inside it and depend on the tools that shell can resolve.
// Nothing in the repository connects the two, so a script can ask for a
// capability the image does not have and the mismatch shows only on an
// operator's PC. scripts/assert-image-capabilities.mjs exercises the set this
// module derives against a real image; the derivation lives apart from it so a
// new call site can be noticed on every pull request, without a Docker daemon.
//
// The two derivations and their anchors:
//
//   - A psilink subcommand is a run of literal argument tokens beginning with a
//     name the image answers to, on a logical line that also names the image (a
//     `vdorie/psi-link` reference, or one of the helpers the launchers resolve
//     it through) or an argument-vector parameter (`-Args`, `_ARGUMENTS`) before
//     it. The names come from the image's own two dispatchers -- the words
//     docker-entrypoint.sh routes on, and the commands apps/cli/src/cliParser.ts
//     registers -- so a command that ships without being registered, or a call
//     site that invokes one this never saw, changes the derived set rather than
//     going unnoticed.
//   - A helper script is one cmd_Setup-PsilinkFileDrop.cmd redirects into a
//     shell in the image, together with the environment and mounts that call
//     site gives it. Running the script is what resolves the tools it needs, so
//     no list of tool names is kept anywhere: a helper that gains a dependency
//     on another in-image binary is covered by the run it already has.
//
// What it does not reach:
//
//   - The subcommand-less invocation (`<image> file:///sync input.csv out.csv`),
//     which names no registered command. image_smoke.yaml runs a full exchange
//     over a bind mount, which is that shape.
//   - A call site that splits an argument vector across logical lines, or builds
//     one from values this cannot see. Both fail closed only insofar as the
//     capability then goes underived, so the tripwires below assert that each
//     derivation found something at all.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { registeredCommands } from "./check-command-inventory.mjs";

export const CLI_PARSER = "apps/cli/src/cliParser.ts";
export const ENTRYPOINT = "docker-entrypoint.sh";
export const SUPPORT_DIR = "support/windows-network-filedrop";

/** Every support script a derivation reads, relative to SUPPORT_DIR. */
export const SUPPORT_SCRIPTS = [
  "Setup-PsilinkFileDrop.ps1",
  "Start-Psilink.ps1",
  "start-psilink.sh",
  "cmd_Setup-PsilinkFileDrop.cmd",
  "cmd_psilink-credcheck.sh",
  "cmd_psilink-probe.sh",
  "cmd_psilink-volcheck.sh",
];

/** The `.cmd` path's setup script, whose redirects name the helper scripts. */
export const CMD_SETUP_SCRIPT = "cmd_Setup-PsilinkFileDrop.cmd";

/** The launchers that declare which `--json` verdict version they read. */
export const VERDICT_VERSION_SOURCES = {
  "Start-Psilink.ps1": /\$PsilinkVerdictVersion\s*=\s*'?(\d+)'?/,
  "start-psilink.sh": /PSILINK_VERDICT_VERSION='(\d+)'/,
};

const LANGUAGE_BY_EXTENSION = { ps1: "powershell", sh: "shell", cmd: "batch" };

const CONTINUATION = { powershell: /`$/, shell: /\\$/, batch: /\^$/ };

/**
 * The words the image's entrypoint routes on before the CLI ever sees them.
 *
 * `serve` reaches the web console rather than the CLI parser, so a derivation
 * reading the parser alone would miss every launcher call site that starts the
 * console -- the capability an operator's launcher depends on most.
 */
export function dispatchedWords(entrypointSource) {
  return [
    ...entrypointSource.matchAll(/\[\s*"\$1"\s*=\s*"([a-z][a-z0-9-]*)"\s*\]/g),
  ].map((match) => match[1]);
}

/** The language a support script is read as, from its extension. */
export function languageOf(filename) {
  const language = LANGUAGE_BY_EXTENSION[filename.split(".").pop()];
  if (language === undefined) {
    throw new Error(`${filename}: no reader is defined for this extension`);
  }
  return language;
}

/**
 * Strip comments and fold continued lines, quote-aware, into logical lines.
 *
 * Each entry is `{ line, text }`, where `line` is the 1-based physical line the
 * logical one starts at. A PowerShell argument vector is folded across the
 * physical lines an open bracket spans as well as across a trailing backtick,
 * because either shape puts the image reference and the argument tokens on
 * separate physical lines while they remain one call.
 */
export function logicalLines(source, language) {
  const physical = source.split(/\r?\n/);
  const folded = [];
  let pending = null;
  let inBlockComment = false;
  let depth = 0;

  for (const [index, raw] of physical.entries()) {
    let text = raw;
    if (language === "batch") {
      text = /^\s*(rem\b|::)/i.test(text) ? "" : text;
    } else {
      const stripped = stripCommentsAndMeasure(text, language, inBlockComment);
      text = stripped.text;
      inBlockComment = stripped.inBlockComment;
      // Clamped at zero: a stray closer left over from a shape this reader does
      // not follow would otherwise hold the depth negative for the rest of the
      // file, and every folded call site after it would go unread.
      if (language === "powershell")
        depth = Math.max(0, depth + stripped.depth);
    }

    // One continuation character per language rather than all three at once: a
    // batch line ending in a Windows path separator continues nothing, and
    // reading it as a continuation would glue the next call site onto it.
    const marker = CONTINUATION[language];
    const continues =
      marker.test(text.trimEnd()) || (language === "powershell" && depth > 0);
    const body = text.trimEnd().replace(marker, "");
    if (pending === null) pending = { line: index + 1, text: body };
    else pending.text += ` ${body.trim()}`;

    if (!continues) {
      folded.push(pending);
      pending = null;
    }
  }
  if (pending !== null) folded.push(pending);
  return folded.filter((entry) => entry.text.trim() !== "");
}

/**
 * Remove one physical line's comment and report the bracket depth it opens.
 *
 * Quote-aware because a `#` inside a string is not a comment and a bracket
 * inside one does not open a call: `"${VolumeName}:/rz"` would otherwise leave
 * every following line folded into the same logical one.
 */
function stripCommentsAndMeasure(line, language, startsInBlockComment) {
  let out = "";
  let depth = 0;
  let inBlockComment = startsInBlockComment;
  let quote = null;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inBlockComment) {
      if (language === "powershell" && ch === "#" && line[i + 1] === ">") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote !== null) {
      out += ch;
      if (ch === "\\" && quote === '"' && language === "shell") {
        out += line[i + 1] ?? "";
        i += 1;
      } else if (ch === "`" && quote === '"' && language === "powershell") {
        out += line[i + 1] ?? "";
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    if (language === "powershell" && ch === "<" && line[i + 1] === "#") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    // A comment opens only where a word does. Both languages require it, and
    // reading any `#` as one would truncate `${PSILINK_IMAGE_DIGEST#sha256:}`
    // and every call site folded onto the same logical line as it.
    if (ch === "#" && (i === 0 || /[\s;(&|]/.test(line[i - 1]))) break;
    if (ch === "(" || ch === "[") depth += 1;
    if (ch === ")" || ch === "]") depth -= 1;
    out += ch;
  }
  return { text: out, depth, inBlockComment };
}

/** The argument-shaped tokens of a logical line, quotes and syntax removed. */
export function tokenize(text) {
  return text.match(/[A-Za-z0-9_./:@-]+/g) ?? [];
}

/** Whether a token names the image, or the helper a launcher resolves it with. */
export function namesImage(token) {
  return (
    /psi-link/i.test(token) ||
    token === "Image" ||
    token === "psilink_image" ||
    token === "Get-PsilinkImage"
  );
}

/** Whether a token is the name of a parameter holding an argument vector. */
export function namesArgumentVector(token) {
  return /(^|[_-])[A-Za-z]*(Args|ARGUMENTS)$/.test(token);
}

const ARGUMENT_TOKEN = /^(--?[A-Za-z0-9][A-Za-z0-9-]*|\/[A-Za-z0-9_/-]*)$/;
const MODE_TOKEN = /^[a-z][a-z0-9-]*$/;

/**
 * The psilink argument vectors one logical line hands the image.
 *
 * A vector starts at a command name that follows an image reference or an
 * argument-vector parameter on the same logical line, and runs while the tokens
 * after it stay argument-shaped: a flag or an absolute path anywhere, and a bare
 * lowercase word only in the position a mode sits in, immediately after the
 * command. It stops at anything else, at a second command, and at a fixed bound.
 *
 * The bounds lean towards reading too much rather than too little. A vector read
 * one token long fails for want of a recipe in
 * scripts/assert-image-capabilities.mjs, which a run reports; a vector read one
 * token short would be exercised as something other than what the script runs,
 * and nothing would say so.
 *
 * One measured consequence of the over-read: a logical line that merely echoes
 * or returns a sample command for the operator (cmd_Setup-PsilinkFileDrop.cmd's
 * closing help text; Get-ConsoleCommandLines' read-back strings) derives like a
 * real call site. A capability introduced by such a line alone fails for want
 * of a recipe, and its coverage-gap message then cites the print site -- read
 * the cited line before writing a recipe for it.
 */
export function argvOnLine(text, commands) {
  const tokens = tokenize(text);
  const anchor = tokens.findIndex(
    (token) => namesImage(token) || namesArgumentVector(token),
  );
  if (anchor === -1) return [];

  const found = [];
  for (let i = anchor + 1; i < tokens.length; i += 1) {
    if (!commands.includes(tokens[i])) continue;
    const argv = [tokens[i]];
    for (let j = i + 1; j < tokens.length && argv.length < 6; j += 1) {
      const token = tokens[j];
      if (commands.includes(token)) break;
      const modePosition = j === i + 1;
      if (
        !ARGUMENT_TOKEN.test(token) &&
        !(modePosition && MODE_TOKEN.test(token))
      )
        break;
      argv.push(token);
    }
    found.push(argv);
    i += argv.length - 1;
  }
  return found;
}

/**
 * Every psilink argument vector the support scripts hand the image.
 *
 * Returns `[{ argv, sites }]` sorted by vector, where a site is
 * `<filename>:<line>`. The same vector reached from several call sites is one
 * entry holding all of them.
 */
export function deriveCliCapabilities(sources, commands) {
  const byArgv = new Map();
  for (const [filename, source] of Object.entries(sources)) {
    for (const { line, text } of logicalLines(source, languageOf(filename))) {
      for (const argv of argvOnLine(text, commands)) {
        const key = argv.join(" ");
        if (!byArgv.has(key)) byArgv.set(key, { argv, sites: [] });
        byArgv.get(key).sites.push(`${filename}:${line}`);
      }
    }
  }
  return [...byArgv.keys()].sort().map((key) => byArgv.get(key));
}

/**
 * Every helper script the `.cmd` setup path pipes into a shell in the image.
 *
 * Returns `[{ script, env, mounts, sites }]`: the redirected file, the
 * environment variable names that call site passes through, and the container
 * paths it mounts. Running the script with that shape is what resolves the
 * in-image tools it needs, so those are never enumerated here.
 */
export function deriveHelperInvocations(cmdSource) {
  const byScript = new Map();
  for (const { line, text } of logicalLines(cmdSource, "batch")) {
    if (!text.includes("--entrypoint sh")) continue;
    const redirect = text.match(/<"%SCRIPT_DIR%([A-Za-z0-9_.-]+)"/);
    if (redirect === null) continue;
    const script = redirect[1];
    const env = [...text.matchAll(/--env\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map(
      (match) => match[1],
    );
    const mounts = [...text.matchAll(/-v\s+"[^":]*:([^"]+)"/g)].map(
      (match) => match[1],
    );
    if (!byScript.has(script)) {
      byScript.set(script, { script, env, mounts, sites: [] });
    }
    byScript.get(script).sites.push(`${CMD_SETUP_SCRIPT}:${line}`);
  }
  return [...byScript.keys()].sort().map((key) => byScript.get(key));
}

/**
 * The `--json` verdict version the shipped launchers read.
 *
 * Both declare it, and a launcher stops rather than reads a verdict holding any
 * other version, so they must agree with each other before either is compared
 * against an image.
 */
export function deriveVerdictVersion(sources) {
  const declared = Object.entries(VERDICT_VERSION_SOURCES).map(
    ([filename, pattern]) => {
      const match = (sources[filename] ?? "").match(pattern);
      if (match === null) {
        throw new Error(
          `${filename}: no verdict version declaration matched -- the extraction pattern rotted; fix scripts/derive-image-dependencies.mjs`,
        );
      }
      return { filename, version: Number(match[1]) };
    },
  );
  const [first, ...rest] = declared;
  for (const other of rest) {
    if (other.version !== first.version) {
      throw new Error(
        `${first.filename} reads verdict version ${first.version} and ${other.filename} reads ${other.version} -- the launchers disagree`,
      );
    }
  }
  return first.version;
}

/** Read every support script and the CLI parser from a repository root. */
export function readSources(root) {
  const support = Object.fromEntries(
    SUPPORT_SCRIPTS.map((filename) => [
      filename,
      readFileSync(resolve(root, SUPPORT_DIR, filename), "utf8"),
    ]),
  );
  return {
    support,
    parser: readFileSync(resolve(root, CLI_PARSER), "utf8"),
    entrypoint: readFileSync(resolve(root, ENTRYPOINT), "utf8"),
  };
}

/**
 * The whole derived dependency set, with the tripwires that keep it accurate.
 *
 * Returns the argument vectors, the helper invocations, the verdict version and
 * the support-script sources, which a caller pipes into a container as the `.cmd`
 * path does. Each derivation throws rather than returns an empty set: a pattern
 * that stops matching would otherwise report an image with nothing to answer for
 * as clean.
 */
export function deriveImageDependencies(root) {
  const { support, parser, entrypoint } = readSources(root);
  const registered = registeredCommands(parser);
  if (registered.length === 0) {
    throw new Error(
      `${CLI_PARSER}: no .command("...") registrations matched -- the extraction pattern rotted; fix scripts/check-command-inventory.mjs`,
    );
  }
  const dispatched = dispatchedWords(entrypoint);
  if (dispatched.length === 0) {
    throw new Error(
      `${ENTRYPOINT}: no dispatch word matched -- the extraction pattern rotted; fix scripts/derive-image-dependencies.mjs`,
    );
  }
  const commands = [...new Set([...dispatched, ...registered])];

  const cli = deriveCliCapabilities(support, commands);
  if (cli.length === 0) {
    throw new Error(
      `${SUPPORT_DIR}: no psilink argument vector was derived from any support script -- the extraction pattern rotted; fix scripts/derive-image-dependencies.mjs`,
    );
  }

  const helpers = deriveHelperInvocations(support[CMD_SETUP_SCRIPT]);
  if (helpers.length === 0) {
    throw new Error(
      `${SUPPORT_DIR}/${CMD_SETUP_SCRIPT}: no helper script redirect was derived -- the extraction pattern rotted; fix scripts/derive-image-dependencies.mjs`,
    );
  }
  for (const helper of helpers) {
    if (support[helper.script] === undefined) {
      throw new Error(
        `${CMD_SETUP_SCRIPT} pipes ${helper.script} into the image, and it is not in SUPPORT_SCRIPTS -- add it to scripts/derive-image-dependencies.mjs`,
      );
    }
  }

  return {
    cli,
    helpers,
    sources: support,
    verdictVersion: deriveVerdictVersion(support),
  };
}

/** The repository root, from this file's location. */
export function repositoryRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { sources, ...derived } = deriveImageDependencies(repositoryRoot());
  void sources;
  console.log(JSON.stringify(derived, null, 2));
}
