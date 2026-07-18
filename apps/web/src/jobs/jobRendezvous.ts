import fs from "node:fs";
import path from "node:path";

/**
 * The environment variable naming the one operator-mounted rendezvous directory a
 * filedrop exchange reads and writes, symmetric with `JOB_INPUT_DIR` and
 * `JOB_DATA_ROOT`. Unset or empty leaves the filedrop transport unavailable on the
 * console: the invite chooser disables its card and the accept flow reports the
 * unavailable state. The directory is server-side configuration, never a
 * browser-sent path; it feeds the CLI config the child reads, so nothing about it
 * reaches argv.
 */
export const JOB_RENDEZVOUS_DIR_ENV = "JOB_RENDEZVOUS_DIR";

declare global {
  var jobRendezvousDirConfig: { resolvedDir?: string } | undefined;
}

/** Read {@link JOB_RENDEZVOUS_DIR_ENV} and resolve it to an absolute path, or
 * undefined when unset. A plain resolve -- the rendezvous mount is the operator's
 * own directory; the preflight below warns rather than fails on anything wrong. */
function loadJobRendezvousDir(env: NodeJS.ProcessEnv): string | undefined {
  const configured = (env[JOB_RENDEZVOUS_DIR_ENV] ?? "").trim();
  if (configured.length === 0) return undefined;
  return path.resolve(configured);
}

/**
 * Resolve the rendezvous directory once and memoize it on globalThis, so dev-mode
 * HMR does not re-read it. Undefined when the variable is unset.
 */
export function useJobRendezvousDir(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  globalThis.jobRendezvousDirConfig ??= {
    resolvedDir: loadJobRendezvousDir(env),
  };
  return globalThis.jobRendezvousDirConfig.resolvedDir;
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
 * The preflight warnings for a filedrop job's rendezvous directory, surfaced through
 * the job's warning channel at start. Defensive, never fatal: a synced mount may
 * populate lazily and the CLI child is the runtime backstop for a truly-broken path,
 * so a missing, non-directory, or non-writable mount only warns. An overlap with the
 * input directory or the data root also warns -- a partner with sync write access to
 * an overlapping mount could reach the operator's `.psilink.key`, input, or results
 * -- but the operator's own directory layout is theirs to choose, so it is not
 * refused. This does not create the directory, canonicalize it, reject a symlinked
 * mount, or enforce a mode.
 */
export function rendezvousStartupWarnings(
  rendezvousDir: string,
  jobInputDir: string | undefined,
  dataRoot: string,
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
