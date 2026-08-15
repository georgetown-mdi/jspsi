import fs from "node:fs";
import path from "node:path";

import { DEFAULT_MAX_DISPLAY_LENGTH, sanitizeForDisplay } from "@psilink/core";

import { JOB_DATA_ROOT_ENV } from "./gate";
import { browseSegment } from "./workInputName";

/**
 * The environment variable naming the operator-mounted rendezvous directory a
 * filedrop exchange reads and writes, symmetric with `JOB_INPUT_DIR`. When unset or
 * empty the rendezvous directory falls back to `JOB_DATA_ROOT`, so a single-folder
 * console -- one mount, only `JOB_DATA_ROOT` set -- rendezvouses out of the data
 * root. The filedrop transport is unavailable only when both are unset: the invite
 * chooser then disables its card and the accept flow reports the unavailable state.
 * The directory is server-side configuration, never a browser-sent path; it feeds
 * the CLI config the child reads, so nothing about it reaches argv.
 */
export const JOB_RENDEZVOUS_DIR_ENV = "JOB_RENDEZVOUS_DIR";

/**
 * The environment variable naming the SHARED FOLDER the rendezvous mount stands
 * for -- the folder the operator picked, as they and their partner know it --
 * rather than the container mount point it is bound to. It exists because the
 * mount point is not always the operator's to name: a launcher that picks the
 * mount point itself binds every operator's folder at the same fixed path, so
 * the mount point's own last segment names the launcher's layout instead of the
 * folder. Set it, and the invitation's advisory locator carries this name.
 *
 * Unset is the operator-authored mount, where the mount point IS the operator's
 * naming and its last segment is the folder's name. A value that is not a bare
 * folder name -- empty, `.`/`..`, or carrying a path separator, a control
 * character, or more than the shared segment rule's 255 characters
 * ({@link browseSegment}) -- leaves the console with no name rather than falling back to the mount
 * point, because a caller that set this variable has already said the mount
 * point does not name the folder.
 *
 * Server-side configuration, never a browser-sent value: it reaches the partner
 * in the invitation's locator and on the accept kit.
 */
export const JOB_RENDEZVOUS_NAME_ENV = "JOB_RENDEZVOUS_NAME";

declare global {
  var jobRendezvousDirConfig:
    { resolvedDir?: string; folderName?: string } | undefined;
}

/** Resolve the rendezvous directory to an absolute path from
 * {@link JOB_RENDEZVOUS_DIR_ENV}, falling back to {@link JOB_DATA_ROOT_ENV} when it is
 * unset so one mount runs a full console, or undefined when both are unset. A plain
 * resolve -- the rendezvous mount is the operator's own directory; the preflight
 * below warns rather than fails on anything wrong. Exported so the SFTP credential
 * validator can exclude this resolved directory (as it excludes the data root) from
 * a credential `@path` reference. */
export function resolveJobRendezvousDir(
  env: NodeJS.ProcessEnv,
): string | undefined {
  const configured = (env[JOB_RENDEZVOUS_DIR_ENV] ?? "").trim();
  const resolved =
    configured.length > 0 ? configured : (env[JOB_DATA_ROOT_ENV] ?? "").trim();
  if (resolved.length === 0) return undefined;
  return path.resolve(resolved);
}

/** The last non-empty segment of a directory path, on either separator, or the
 * empty string when it has none (the filesystem root). Separator-agnostic so a
 * path authored on Windows reduces the same way one authored on POSIX does. */
function lastPathSegment(dirPath: string): string {
  const segments = dirPath.split(/[/\\]+/).filter((part) => part.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : "";
}

/** A bare folder name, or undefined when the value cannot be one. Nothing here
 * is a security boundary -- the value is the operator's own -- but a name that
 * carries a separator would put a path fragment in the partner's invitation,
 * and one that is empty or a relative-path segment names no folder at all.
 * The shape rule is {@link browseSegment}, the single-segment predicate the
 * job surfaces share so their callers cannot drift; a folder name keeps its
 * leading dot, exactly as a browse segment does. */
function usableFolderName(value: string): string | undefined {
  const name = value.trim();
  return browseSegment(name) ? name : undefined;
}

/**
 * The shared folder's own name, or undefined when the console cannot name it.
 * {@link JOB_RENDEZVOUS_NAME_ENV} when it is set, else the resolved mount's own
 * last segment -- the operator-authored mount, whose mount point they chose.
 * A set-but-unusable name resolves to undefined rather than falling back to the
 * mount point (see {@link JOB_RENDEZVOUS_NAME_ENV}), and so does a mount with no
 * last segment at all.
 */
export function resolveJobRendezvousFolderName(
  env: NodeJS.ProcessEnv,
  rendezvousDir: string | undefined,
): string | undefined {
  const configured = env[JOB_RENDEZVOUS_NAME_ENV];
  if (configured !== undefined) return usableFolderName(configured);
  if (rendezvousDir === undefined) return undefined;
  return usableFolderName(lastPathSegment(rendezvousDir));
}

/**
 * The advisory locator a filedrop invitation minted on this console carries: the
 * shared folder's name where the console can name it, else the rendezvous
 * mount's own last segment, which names nothing about the host machine and is
 * what the partner's CLI remaps anyway. Undefined when no rendezvous directory
 * is configured, and for the one configured mount that reduces to no segment at
 * all (the filesystem root).
 *
 * The two are separate because only the first is safe to PRINT as the shared
 * folder's name: the accept kit and the console's own confirm line take the
 * folder name and say nothing where there is none, while the token always needs
 * a locator (core's endpoint schema requires a filedrop directory).
 */
export function resolveJobRendezvousLocator(
  rendezvousDir: string | undefined,
  folderName: string | undefined,
): string | undefined {
  if (folderName !== undefined) return folderName;
  if (rendezvousDir === undefined) return undefined;
  const segment = lastPathSegment(rendezvousDir);
  return segment.length > 0 ? segment : undefined;
}

/**
 * Resolve the rendezvous directory once and memoize it on globalThis, so dev-mode
 * HMR does not re-read it. Undefined when the variable is unset.
 */
export function useJobRendezvousDir(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return useJobRendezvousConfig(env).resolvedDir;
}

/** The shared folder's name for the memoized rendezvous mount, or undefined when
 * the console cannot name it. See {@link resolveJobRendezvousFolderName}. */
export function useJobRendezvousFolderName(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return useJobRendezvousConfig(env).folderName;
}

function useJobRendezvousConfig(env: NodeJS.ProcessEnv): {
  resolvedDir?: string;
  folderName?: string;
} {
  if (globalThis.jobRendezvousDirConfig === undefined) {
    const resolvedDir = resolveJobRendezvousDir(env);
    globalThis.jobRendezvousDirConfig = {
      resolvedDir,
      folderName: resolveJobRendezvousFolderName(env, resolvedDir),
    };
  }
  return globalThis.jobRendezvousDirConfig;
}

/** Whether `child` is `parent` or nested under it (a lexical containment test over
 * resolved absolute paths). */
function containsOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * How many entries a not-empty warning names before it counts the rest. A retain-mode
 * transcript holds a file per message, so naming every entry would bury the recovery
 * the warning exists to deliver.
 *
 * @internal exported for testing
 */
export const MAX_NAMED_RENDEZVOUS_ENTRIES = 10;

/**
 * What a fragment costs in the RENDERED warning, which is not its own length: a
 * warning message is composed raw here and escaped once where it is shown, which
 * expands a code point outside printable ASCII to as many as ten characters and
 * doubles a literal backslash. Arithmetic on raw lengths under-counts.
 *
 * Measuring is not escaping: what the composition keeps is the raw fragment, so the
 * console's display sink stays the one and only altitude that escapes it.
 */
function renderedDisplayCost(fragment: string): number {
  return sanitizeForDisplay(fragment, { maxLength: Infinity }).length;
}

/** The suffix that absorbs the entries a listing does not name. */
function andMoreSuffix(count: number): string {
  return ` and ${count} more`;
}

/**
 * The lead of a non-empty rendezvous directory's warning: what is wrong, what an
 * exchange does about it, the step that clears it, and the files the operator must
 * NOT be read as being told to delete.
 *
 * The sink escapes and CAPS what it renders, so the whole sentence has to fit the
 * budget this composition is measured against ({@link DEFAULT_MAX_DISPLAY_LENGTH},
 * at or under the sink's own) or the clause that neutralizes the delete instruction
 * is what falls off the end. The rendezvous path is the one unbounded part, and it is
 * the operator's own server-side configuration for the console's single rendezvous
 * mount, so a path too long to fit beside the sentence is left out rather than
 * allowed to crowd out the recovery. What this measures at the rendered boundary is
 * pinned by a test.
 *
 * @internal exported for testing
 */
export function notEmptyLead(rendezvousDir: string): string {
  const recovery =
    " is not empty; an exchange refuses to start on files an earlier " +
    "exchange left there, so delete those on the host first. Your own " +
    "input and results are not what it refuses over.";
  const withPath = `the rendezvous directory ${rendezvousDir}${recovery}`;
  return renderedDisplayCost(withPath) <= DEFAULT_MAX_DISPLAY_LENGTH
    ? withPath
    : `the rendezvous directory${recovery}`;
}

/**
 * What a non-empty rendezvous directory holds, as its own warning message. Sorted,
 * because readdir order is the filesystem's and not a promise, so the same directory
 * reads the same way twice.
 *
 * Entry names are partner-chosen -- the partner syncs its own files into this
 * directory -- and reach the operator through the display sink that escapes the
 * message, so they are composed raw and fitted by their RENDERED cost. A name is
 * shown only when it fits whole: a name the cap chopped reads like a whole name the
 * operator could go and delete, so one that does not fit is counted instead, and
 * every later name is still tested rather than suppressed behind it. The count is
 * then the only part that can still grow, and each iteration reserves the width it
 * could reach.
 */
function describeRendezvousEntries(entries: Array<string>): string {
  const head = "the rendezvous directory holds ";
  const budget = DEFAULT_MAX_DISPLAY_LENGTH - renderedDisplayCost(head);
  let listed = "";
  let listedCost = 0;
  let shown = 0;
  for (const entry of entries.slice(0, MAX_NAMED_RENDEZVOUS_ENTRIES)) {
    const candidate = shown === 0 ? entry : `, ${entry}`;
    // What the count would say if this name were the last one shown, so the width
    // reserved is at least the width the listing ends on: skipping a name only
    // lowers the final count.
    const remaining = entries.length - shown - 1;
    const cost =
      listedCost +
      renderedDisplayCost(candidate) +
      (remaining > 0 ? renderedDisplayCost(andMoreSuffix(remaining)) : 0);
    if (cost > budget) continue;
    listed += candidate;
    listedCost += renderedDisplayCost(candidate);
    shown += 1;
  }
  if (shown === 0)
    return (
      `${head}${entries.length} ` +
      `${entries.length === 1 ? "entry" : "entries"}, with names too long ` +
      "to show here"
    );
  const omitted = entries.length - shown;
  return `${head}${listed}${omitted > 0 ? andMoreSuffix(omitted) : ""}`;
}

/**
 * The preflight warnings for a filedrop job's rendezvous directory, surfaced through
 * the job's warning channel at start. Defensive, never fatal: a synced mount may
 * populate lazily and the CLI child is the runtime backstop for a truly-broken path,
 * so a missing, non-directory, non-writable, or unlistable mount only warns. An
 * overlap with the input directory or the data root also warns -- a partner with sync
 * write access to an overlapping mount could reach the operator's `.psilink.key`,
 * input, or results -- but the operator's own directory layout is theirs to choose, so
 * it is not refused.
 *
 * A directory that is not empty warns for a different reason: the console rendezvouses
 * every filedrop job out of the one mount, so a completed retain-mode run leaves its
 * whole transcript where the next run's entry guard refuses it, with no crash anywhere
 * in the story. It takes two warnings in order -- the recovery, then what the mount
 * holds -- because the display sink caps each message it renders, and one message
 * carrying both would spend the recovery's budget on the listing. The listing leaves
 * out one entry: the workdir this launch itself just created, which in the
 * single-folder layout (rendezvous directory equal to the data root) always sits
 * inside the mount by the time this preflight runs. It names what remains and leaves
 * the launch to the operator, whose own input and results may sit in that listing too
 * and are not what the guard objects to. It deliberately does not sort protocol files
 * from foreign ones: that grammar is the exchange's, and predicting the guard's
 * verdict here would be a second implementation of it.
 *
 * This does not create the directory, canonicalize it, reject a symlinked mount, or
 * enforce a mode.
 */
export function rendezvousStartupWarnings(
  rendezvousDir: string,
  jobInputDir: string | undefined,
  dataRoot: string,
  jobWorkdir: string,
): Array<string> {
  const warnings: Array<string> = [];
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(rendezvousDir);
  } catch {
    warnings.push(
      `the rendezvous directory ${rendezvousDir} does not exist yet; ` +
        "the exchange cannot rendezvous until both parties can reach it",
    );
  }
  if (stat !== undefined) {
    if (!stat.isDirectory())
      warnings.push(`the rendezvous path ${rendezvousDir} is not a directory`);
    else {
      try {
        fs.accessSync(rendezvousDir, fs.constants.W_OK);
      } catch {
        warnings.push(
          `the rendezvous directory ${rendezvousDir} is not writable; ` +
            "the exchange writes its half of the rendezvous there",
        );
      }
      let entries: Array<string> | undefined;
      try {
        entries = fs
          .readdirSync(rendezvousDir)
          .filter(
            (entry) =>
              path.resolve(rendezvousDir, entry) !== path.resolve(jobWorkdir),
          )
          .sort();
      } catch {
        warnings.push(
          `the rendezvous directory ${rendezvousDir} cannot be listed, so ` +
            "whether an earlier exchange left files there is unknown until " +
            "the exchange runs",
        );
      }
      if (entries !== undefined && entries.length > 0)
        warnings.push(
          notEmptyLead(rendezvousDir),
          describeRendezvousEntries(entries),
        );
    }
  }

  const dataRootResolved = path.resolve(dataRoot);
  const overlaps: Array<[string, string]> = [
    [dataRootResolved, "the job data root"],
  ];
  if (jobInputDir !== undefined)
    overlaps.push([path.resolve(jobInputDir), "the work-input directory"]);
  for (const [other, label] of overlaps) {
    if (
      containsOrEqual(other, rendezvousDir) ||
      containsOrEqual(rendezvousDir, other)
    )
      warnings.push(
        `the rendezvous directory ${rendezvousDir} overlaps ${label} ` +
          `(${other}); a partner's sync writes would reach it`,
      );
  }
  return warnings;
}
