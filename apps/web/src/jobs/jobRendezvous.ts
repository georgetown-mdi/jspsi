import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_MAX_DISPLAY_LENGTH,
  pathsResolveToSameDir,
  renderedDisplayCost,
} from "@psilink/core";

import { JOB_DATA_ROOT_ENV } from "./gate";
import { browseSegment } from "./workInputName";
import { isPathWithin } from "./pathContainment";

/**
 * Names the operator-mounted rendezvous directory a filedrop exchange reads and
 * writes. Falls back to `JOB_DATA_ROOT` when unset or empty; filedrop is
 * unavailable only when both are unset. Server-side configuration, never a
 * browser-sent path.
 *
 * With {@link JOB_RENDEZVOUS_OUTBOUND_DIR_ENV} also set, this names the INBOUND
 * (peer-written) leg of a split rendezvous, not a directory both parties write.
 */
const JOB_RENDEZVOUS_DIR_ENV = "JOB_RENDEZVOUS_DIR";

/**
 * Names the OUTBOUND (self-written) rendezvous directory of a split filedrop
 * exchange, the companion to {@link JOB_RENDEZVOUS_DIR_ENV}'s inbound leg. Set it
 * when the partner-shared mailbox is two folders; every filedrop exchange the
 * console runs then uses the CLI's `inbound_path`/`outbound_path` pair instead of
 * a single shared `path`.
 *
 * No {@link JOB_DATA_ROOT_ENV} fallback: this variable being set is the only signal
 * that a split is provisioned. An inbound leg that arrived through the data-root
 * fallback is refused rather than synced (see {@link rendezvousSplitFaults}).
 * Server-side configuration, never a browser-sent path.
 */
const JOB_RENDEZVOUS_OUTBOUND_DIR_ENV = "JOB_RENDEZVOUS_OUTBOUND_DIR";

/**
 * Names the SHARED FOLDER the rendezvous mount stands for, for when a launcher
 * fixes the container mount point and its last segment cannot name the folder.
 * Unset, the mount point's last segment is the name. A value that is not a bare
 * folder name ({@link browseSegment}) leaves the console with no name rather than
 * falling back to the mount point.
 *
 * Server-side configuration; reaches the partner in the invitation's locator and
 * accept kit.
 */
const JOB_RENDEZVOUS_NAME_ENV = "JOB_RENDEZVOUS_NAME";

/**
 * Names the SHARED FOLDER the OUTBOUND mount of a split rendezvous stands for, the
 * companion to {@link JOB_RENDEZVOUS_NAME_ENV} and governed by the same rules.
 *
 * Both legs need distinct names to mint an invitation: core refuses a filedrop
 * endpoint whose two halves resolve alike, so two mounts whose last segments
 * coincide (e.g. `/mnt/in/psilink` and `/mnt/out/psilink`) need this variable set.
 *
 * Server-side configuration; reaches the partner in the invitation's locator and
 * accept kit.
 */
const JOB_RENDEZVOUS_OUTBOUND_NAME_ENV = "JOB_RENDEZVOUS_OUTBOUND_NAME";

declare global {
  var jobRendezvousProvisioning: JobRendezvousProvisioning | undefined;
}

/**
 * How this console is provisioned to rendezvous a filedrop exchange, resolved once
 * from the environment: a single shared mount (`outboundDir` absent) or a split
 * pair, plus each leg's name and locator.
 *
 * `problem` is why a filedrop exchange CANNOT run as provisioned, in the operator's
 * own terms and naming the variable to fix. When set, no filedrop exchange is
 * offered or created.
 */
interface JobRendezvousProvisioning {
  /** The inbound (peer-written) leg, or the single shared mount when no outbound leg
   * is provisioned. Undefined when no rendezvous mount resolves at all. */
  dir?: string;
  /** The outbound (self-written) leg; present only on a split console. */
  outboundDir?: string;
  folderName?: string;
  outboundFolderName?: string;
  /** The advisory locator an invitation minted here states for {@link dir}. */
  locator?: string;
  /** The advisory locator for {@link outboundDir}, on a split console. */
  outboundLocator?: string;
  problem?: string;
  /**
   * Why the split pair's containment check was decided on the configured paths
   * alone: one leg's real path could not be read, so a symlink joining the two
   * legs could not be seen. A warning, not a refusal, logged at startup beside
   * {@link problem}, which it qualifies rather than replaces.
   */
  unresolvedLegWarning?: string;
  /**
   * Whether a rendezvous leg HOLDS the job data root -- the mounted working
   * directory holding this party's signing key, config, input, and results. Set
   * only when true, so a separately-provisioned console holds nothing: where
   * it holds, anything the partner syncs into that folder is also readable there,
   * so the signing key is a file they reach. See {@link rendezvousHoldsDataRoot}.
   */
  sharesDataRoot?: boolean;
  /**
   * Whether {@link sharesDataRoot} is a default from an unresolved real path
   * rather than a positively established match. Present only alongside
   * `sharesDataRoot: true`. The console reads it to choose between stating the
   * shared layout as fact and hedging it (see `receiptsModel.ts`).
   */
  sharesDataRootUncertain?: boolean;
}

/** The job data root as configured, or undefined when it is unset -- which is the
 * job API's own feature gate, so on a console that runs at all it resolves. */
function resolveDataRoot(env: NodeJS.ProcessEnv): string | undefined {
  const configured = (env[JOB_DATA_ROOT_ENV] ?? "").trim();
  return configured.length > 0 ? path.resolve(configured) : undefined;
}

/** The inbound (or single shared) rendezvous mount together with WHERE it came
 * from: {@link JOB_RENDEZVOUS_DIR_ENV} itself, or the {@link JOB_DATA_ROOT_ENV}
 * fallback that lets one mount run a full console. The source is what separates a
 * provisioned split from a half-provisioned one, since the data root is the job
 * API's own feature gate and so resolves on every console that runs at all. */
function resolveInboundRendezvousMount(env: NodeJS.ProcessEnv): {
  dir: string | undefined;
  fromOwnVariable: boolean;
} {
  const configured = (env[JOB_RENDEZVOUS_DIR_ENV] ?? "").trim();
  if (configured.length > 0)
    return { dir: path.resolve(configured), fromOwnVariable: true };
  return { dir: resolveDataRoot(env), fromOwnVariable: false };
}

/** Resolve the outbound rendezvous leg from
 * {@link JOB_RENDEZVOUS_OUTBOUND_DIR_ENV}, or undefined when it is unset or empty --
 * the console is then provisioned for a single shared mount. No data-root
 * fallback: see the variable's own documentation.
 *
 * @internal exported for testing */
export function resolveJobRendezvousOutboundDir(
  env: NodeJS.ProcessEnv,
): string | undefined {
  const configured = (env[JOB_RENDEZVOUS_OUTBOUND_DIR_ENV] ?? "").trim();
  return configured.length > 0 ? path.resolve(configured) : undefined;
}

/** The last non-empty segment of a directory path, on either separator, or the
 * empty string when it has none (the filesystem root). Separator-agnostic so a
 * path authored on Windows reduces the same way one authored on POSIX does. */
function lastPathSegment(dirPath: string): string {
  const segments = dirPath.split(/[/\\]+/).filter((part) => part.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : "";
}

/** A bare folder name, or undefined when the value cannot be one. Not a security
 * boundary -- the value is the operator's own -- but a separator would put a path
 * fragment in the partner's invitation. The shape rule is {@link browseSegment},
 * shared with the job surfaces so callers cannot drift; a folder name keeps its
 * leading dot, as a browse segment does. */
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
 *
 * @internal exported for testing
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
 * The outbound leg's own folder name on a split console: resolved from
 * {@link JOB_RENDEZVOUS_OUTBOUND_NAME_ENV} exactly as
 * {@link resolveJobRendezvousFolderName} resolves the inbound leg, else from the
 * outbound mount's last segment. The mount decides first, so a console with no
 * outbound leg reports no outbound name regardless of the variable.
 */
function resolveJobRendezvousOutboundFolderName(
  env: NodeJS.ProcessEnv,
  outboundDir: string | undefined,
): string | undefined {
  if (outboundDir === undefined) return undefined;
  const configured = env[JOB_RENDEZVOUS_OUTBOUND_NAME_ENV];
  if (configured !== undefined) return usableFolderName(configured);
  return usableFolderName(lastPathSegment(outboundDir));
}

/**
 * The advisory locator a filedrop invitation minted here states: the shared
 * folder's name where the console can name it, else the rendezvous mount's own
 * last segment (the partner's CLI remaps it anyway). Undefined when no rendezvous
 * directory is configured or it reduces to no segment (the filesystem root).
 *
 * Separate from the folder name because only the name is safe to PRINT: the
 * accept kit and confirm line say nothing where there is none, while the token
 * always needs a locator (core's endpoint schema requires a filedrop directory).
 */
function resolveJobRendezvousLocator(
  rendezvousDir: string | undefined,
  folderName: string | undefined,
): string | undefined {
  if (folderName !== undefined) return folderName;
  if (rendezvousDir === undefined) return undefined;
  const segment = lastPathSegment(rendezvousDir);
  return segment.length > 0 ? segment : undefined;
}

/**
 * A directory in every form the containment comparisons here compare it in: the
 * configured path, lexically resolved, plus the real path symlinks resolve it to
 * when that differs. Both are held because either can be the form that overlaps the
 * other directory, and holding the configured path unconditionally is what keeps a
 * directory whose real path the filesystem will not give up under the lexical test.
 */
interface ResolvedPathForms {
  /** The configured path, lexically resolved -- the form a notice names, and the
   * one form every comparison has whatever the filesystem answers. */
  resolved: string;
  forms: Array<string>;
  /** False when a path component could not be READ (as opposed to not being
   * there), so {@link forms} contains the configured path alone. */
  canonicalized: boolean;
}

/** Whether a filesystem error says a path component is simply not there, as
 * opposed to one the process could not read. */
function isMissingPathError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Resolve a directory to the forms {@link pathFormsOverlap} compares.
 *
 * The real path is read through the directory's nearest EXISTING ancestor with the
 * missing tail re-appended, so a mount not yet created is still compared through a
 * symlinked parent. A component the process cannot read is different -- the
 * symlink could be exactly there -- so the directory falls back to its configured
 * path alone and reports that through `canonicalized`.
 */
function resolvePathForms(dir: string): ResolvedPathForms {
  const resolved = path.resolve(dir);
  const missingTail: Array<string> = [];
  let current = resolved;
  for (;;) {
    let real: string;
    try {
      real = fs.realpathSync(current);
    } catch (error) {
      const parent = path.dirname(current);
      if (!isMissingPathError(error) || parent === current)
        return { resolved, forms: [resolved], canonicalized: false };
      missingTail.unshift(path.basename(current));
      current = parent;
      continue;
    }
    const canonical =
      missingTail.length === 0 ? real : path.join(real, ...missingTail);
    return {
      resolved,
      forms: [...new Set([resolved, canonical])],
      canonicalized: true,
    };
  }
}

/**
 * Whether `container` IS `contained` or holds it, in any pairing of the forms the
 * two resolve to. Directional, unlike {@link pathFormsOverlap}: a question about
 * what a directory's contents reach -- a file inside the container is a file inside
 * the contained one only in this direction -- rather than about the two overlapping
 * at all.
 */
function pathFormsContain(
  container: ResolvedPathForms,
  contained: ResolvedPathForms,
): boolean {
  return container.forms.some((containerForm) =>
    contained.forms.some((containedForm) =>
      isPathWithin(containerForm, containedForm, "at-or-under"),
    ),
  );
}

/**
 * Whether two directories are one directory, or one is nested inside the other, in
 * ANY pairing of the forms they resolve to. Comparing across forms is what extends
 * the verdict to a symlinked directory without letting an unresolvable one out of
 * it: the configured paths are always among the forms compared, so the lexical
 * verdict still stands on its own.
 */
function pathFormsOverlap(
  first: ResolvedPathForms,
  second: ResolvedPathForms,
): boolean {
  return pathFormsContain(first, second) || pathFormsContain(second, first);
}

/**
 * The warning for a pair compared without one or both legs' real paths, naming the
 * variable(s) that could not be resolved, or undefined when both resolved. Reports
 * a check that ran narrower than intended, not a fault in the operator's layout.
 *
 * A single unresolved leg is worded narrower than a pair: the other leg's real
 * path still took part, so only a symlink on the unresolved side goes uncaught.
 */
function describeUnresolvedLegs(
  inbound: ResolvedPathForms,
  outbound: ResolvedPathForms,
): string | undefined {
  if (inbound.canonicalized && outbound.canonicalized) return undefined;
  const recovery =
    "Give the console read access to every folder on the way to the mount " +
    "and restart the console.";
  if (!inbound.canonicalized && !outbound.canonicalized)
    return (
      `The real path of ${JOB_RENDEZVOUS_DIR_ENV} and ${JOB_RENDEZVOUS_OUTBOUND_DIR_ENV} ` +
      "could not be read, so the inbound and outbound rendezvous directories " +
      "were compared as configured and a symlink making them one directory " +
      `would not be caught. ${recovery}`
    );
  const [unresolvedVar, unresolvedLeg, resolvedLeg] = inbound.canonicalized
    ? [JOB_RENDEZVOUS_OUTBOUND_DIR_ENV, "outbound", "inbound"]
    : [JOB_RENDEZVOUS_DIR_ENV, "inbound", "outbound"];
  return (
    `The real path of ${unresolvedVar} could not be read, so the ` +
    `${unresolvedLeg} rendezvous directory was compared only as configured; ` +
    `the ${resolvedLeg} leg's real path still applied, so only a symlink on ` +
    `the ${unresolvedLeg} side would go uncaught. ${recovery}`
  );
}

/**
 * Why a split pair cannot run a filedrop exchange, or undefined when it is
 * coherent. (The half-provisioned case is decided earlier.)
 *
 * - Two legs that are one directory, or nested, would have this party read its
 *   own writes as the partner's; core's `pathsResolveToSameDir` catches only
 *   textual equality on the composed config, so nesting is checked here.
 * - A leg the console cannot name, or two legs whose names coincide, cannot be
 *   minted into an invitation: core refuses a filedrop endpoint whose halves
 *   resolve alike.
 */
function splitPairProblem(
  provisioning: JobRendezvousProvisioning,
  inbound: ResolvedPathForms,
  outbound: ResolvedPathForms,
): string | undefined {
  const { locator, outboundLocator } = provisioning;
  if (pathFormsOverlap(inbound, outbound))
    return (
      "The inbound and outbound rendezvous directories are the same directory, " +
      "or one is inside the other, so this console would read its own writes " +
      `as your partner's. Mount ${JOB_RENDEZVOUS_OUTBOUND_DIR_ENV} outside ` +
      `${JOB_RENDEZVOUS_DIR_ENV} and restart the console.`
    );
  if (locator === undefined || outboundLocator === undefined)
    return (
      "This console cannot name both rendezvous folders, so an invitation " +
      `minted here would carry no locator for one of them. Set ${JOB_RENDEZVOUS_NAME_ENV} ` +
      `and ${JOB_RENDEZVOUS_OUTBOUND_NAME_ENV} to the two folders' own names and ` +
      "restart the console."
    );
  if (pathsResolveToSameDir(locator, outboundLocator))
    return (
      "The inbound and outbound rendezvous folders resolve to the same name, so " +
      "an invitation minted here could not tell your partner which is which. Set " +
      `${JOB_RENDEZVOUS_NAME_ENV} and ${JOB_RENDEZVOUS_OUTBOUND_NAME_ENV} to ` +
      "distinct names and restart the console."
    );
  return undefined;
}

/** What a split-provisioned console's two mounts are faulted for: the refusal
 * that stops every filedrop exchange, and the warning that the containment half of
 * it was decided without a leg's real path. Either or both may be absent. */
interface RendezvousSplitFaults {
  problem?: string;
  unresolvedLegWarning?: string;
}

/**
 * Fault a split-provisioned console's rendezvous pair, or return nothing when
 * there is no split or the pair is coherent. An outbound leg beside an inbound one
 * that arrived only through the data-root fallback is faulted first -- a split
 * takes both legs from their own variables -- then the pair faults
 * {@link splitPairProblem} decides.
 *
 * Containment is checked over the configured paths and their real paths (see
 * {@link resolvePathForms}); a leg whose real path cannot be read narrows to the
 * configured comparison and reports `unresolvedLegWarning` instead of a refusal.
 * Paths are read once, so a symlink repointed while the console runs is not
 * seen -- the exchange's own entry guard is the safety check.
 *
 * @internal exported for testing
 */
export function rendezvousSplitFaults(
  provisioning: JobRendezvousProvisioning,
  inboundDirFromOwnVariable: boolean,
): RendezvousSplitFaults {
  const { dir, outboundDir } = provisioning;
  if (outboundDir === undefined) return {};
  if (dir === undefined || !inboundDirFromOwnVariable)
    return {
      problem:
        `${JOB_RENDEZVOUS_OUTBOUND_DIR_ENV} is set but ${JOB_RENDEZVOUS_DIR_ENV} ` +
        "is not, so this console has only one leg of a split rendezvous. Set " +
        `${JOB_RENDEZVOUS_DIR_ENV} to the folder your partner writes into and ` +
        "restart the console.",
    };
  const inbound = resolvePathForms(dir);
  const outbound = resolvePathForms(outboundDir);
  const faults: RendezvousSplitFaults = {};
  const unresolvedLegWarning = describeUnresolvedLegs(inbound, outbound);
  if (unresolvedLegWarning !== undefined)
    faults.unresolvedLegWarning = unresolvedLegWarning;
  const problem = splitPairProblem(provisioning, inbound, outbound);
  if (problem !== undefined) faults.problem = problem;
  return faults;
}

/**
 * A directory's identity as the filesystem knows it -- the `(st_dev, st_ino)` pair
 * every path for one directory shares, whatever those paths spell -- or why it has
 * none: a directory that is not there has no identity to compare, while one the
 * process could not stat has one it cannot read.
 */
type DirectoryIdentity =
  { known: true; key: string } | { known: false; unreadable: boolean };

/**
 * Read a directory's {@link DirectoryIdentity}. The pair is read as BigInt so an
 * inode number past a double's exact range compares as the filesystem reports it
 * rather than as the nearest representable number, and it is read through `stat`
 * rather than `lstat` so a symlinked path answers for the directory it names.
 */
function readDirectoryIdentity(dir: string): DirectoryIdentity {
  try {
    const stats = fs.statSync(dir, { bigint: true });
    return { known: true, key: `${stats.dev}:${stats.ino}` };
  } catch (error) {
    return { known: false, unreadable: !isMissingPathError(error) };
  }
}

/**
 * Whether a leg holds the job data root, and whether that verdict was positively
 * established -- a lexical match, or a filesystem identity match against a
 * directory the process could read -- rather than defaulted to "holds" because a
 * directory somewhere in the comparison could not be read. See
 * {@link JobRendezvousProvisioning.sharesDataRootUncertain}.
 */
interface DataRootHoldVerdict {
  holds: boolean;
  uncertain: boolean;
}

/**
 * Whether `leg` IS the data root, or holds it, by FILESYSTEM identity rather than
 * by path spelling -- catching aliasing a symlink does not express, such as one
 * host directory bind-mounted at two container paths, which `realpath` cannot see.
 *
 * The whole ancestor chain is walked, directional like {@link pathFormsContain}: a
 * leg aliasing a directory that holds the data root reaches the key too. A
 * directory the process could not stat counts as holding, `uncertain` (warn-and-
 * guide default); one simply absent counts as nothing.
 *
 * Aliasing outside the ancestor chain -- a leg bound onto a directory whose own
 * contents reach the data root by another route -- remains invisible.
 */
function legAliasesDataRootChain(
  leg: string,
  dataRoot: string,
): DataRootHoldVerdict {
  const legIdentity = readDirectoryIdentity(leg);
  if (!legIdentity.known)
    return {
      holds: legIdentity.unreadable,
      uncertain: legIdentity.unreadable,
    };
  let current = path.resolve(dataRoot);
  for (;;) {
    const identity = readDirectoryIdentity(current);
    if (identity.known) {
      if (identity.key === legIdentity.key)
        return { holds: true, uncertain: false };
    } else if (identity.unreadable) {
      return { holds: true, uncertain: true };
    }
    const parent = path.dirname(current);
    if (parent === current) return { holds: false, uncertain: false };
    current = parent;
  }
}

/**
 * Whether any rendezvous leg holds the job data root
 * ({@link JobRendezvousProvisioning.sharesDataRoot}), and whether that verdict was
 * positively established rather than defaulted
 * ({@link JobRendezvousProvisioning.sharesDataRootUncertain}).
 *
 * Every leg ({@link jobRendezvousDirs}) is tested DIRECTIONALLY: a leg that holds
 * the data root puts this party's files where the partner syncs; a leg mounted
 * INSIDE the data root does not. Each leg is compared as configured, as its real
 * path ({@link resolvePathForms}), and by filesystem identity
 * ({@link legAliasesDataRootChain}).
 *
 * A leg or the data root whose real path cannot be read counts as holding and
 * `uncertain`, since what cannot be resolved is exactly where a joining symlink
 * would sit. Every leg is checked rather than stopping at the first that holds, so
 * one leg's unresolved comparison cannot shadow another's positive match.
 */
function rendezvousHoldsDataRoot(
  provisioning: JobRendezvousProvisioning,
  dataRoot: string | undefined,
): DataRootHoldVerdict {
  if (dataRoot === undefined) return { holds: false, uncertain: false };
  const dataRootPaths = resolvePathForms(dataRoot);
  let uncertainHold = false;
  for (const dir of jobRendezvousDirs(provisioning)) {
    const legPaths = resolvePathForms(dir);
    if (!legPaths.canonicalized || !dataRootPaths.canonicalized) {
      uncertainHold = true;
      continue;
    }
    if (pathFormsContain(legPaths, dataRootPaths))
      return { holds: true, uncertain: false };
    const alias = legAliasesDataRootChain(dir, dataRoot);
    if (alias.holds && !alias.uncertain)
      return { holds: true, uncertain: false };
    if (alias.holds) uncertainHold = true;
  }
  return { holds: uncertainHold, uncertain: uncertainHold };
}

/**
 * Resolve this console's whole rendezvous provisioning from the environment: both
 * legs, their names and locators, the reason a filedrop exchange cannot run when
 * the pair is incoherent, and whether a leg holds the data root. Reads the
 * filesystem for the whole console rather than per exchange; the memoized entry
 * point is {@link useJobRendezvousProvisioning}.
 */
export function resolveJobRendezvousProvisioning(
  env: NodeJS.ProcessEnv,
): JobRendezvousProvisioning {
  const { dir, fromOwnVariable } = resolveInboundRendezvousMount(env);
  const outboundDir = resolveJobRendezvousOutboundDir(env);
  const folderName = resolveJobRendezvousFolderName(env, dir);
  const outboundFolderName = resolveJobRendezvousOutboundFolderName(
    env,
    outboundDir,
  );
  const provisioning: JobRendezvousProvisioning = {
    ...(dir !== undefined ? { dir } : {}),
    ...(outboundDir !== undefined ? { outboundDir } : {}),
    ...(folderName !== undefined ? { folderName } : {}),
    ...(outboundFolderName !== undefined ? { outboundFolderName } : {}),
  };
  const locator = resolveJobRendezvousLocator(dir, folderName);
  if (locator !== undefined) provisioning.locator = locator;
  const outboundLocator = resolveJobRendezvousLocator(
    outboundDir,
    outboundFolderName,
  );
  if (outboundLocator !== undefined)
    provisioning.outboundLocator = outboundLocator;
  const { problem, unresolvedLegWarning } = rendezvousSplitFaults(
    provisioning,
    fromOwnVariable,
  );
  if (problem !== undefined) provisioning.problem = problem;
  if (unresolvedLegWarning !== undefined)
    provisioning.unresolvedLegWarning = unresolvedLegWarning;
  const dataRootHold = rendezvousHoldsDataRoot(
    provisioning,
    resolveDataRoot(env),
  );
  if (dataRootHold.holds) {
    provisioning.sharesDataRoot = true;
    if (dataRootHold.uncertain) provisioning.sharesDataRootUncertain = true;
  }
  return provisioning;
}

/**
 * Resolve the rendezvous provisioning once and memoize it on globalThis, so dev-mode
 * HMR does not re-read it.
 */
export function useJobRendezvousProvisioning(
  env: NodeJS.ProcessEnv = process.env,
): JobRendezvousProvisioning {
  globalThis.jobRendezvousProvisioning ??=
    resolveJobRendezvousProvisioning(env);
  return globalThis.jobRendezvousProvisioning;
}

/**
 * Which mount of a filedrop rendezvous a preflight notice is about: the single
 * shared directory of a one-mount console, or one leg of a split console's pair.
 * A split console preflights each leg independently, so every notice has to say
 * which of the two it means.
 */
export type RendezvousLeg = "shared" | "inbound" | "outbound";

/**
 * Every rendezvous mount this console runs a filedrop exchange over, paired with
 * the leg it is. The single enumeration of "every rendezvous mount", so the
 * preflight and the containment surfaces cannot disagree about which mounts exist.
 * An outbound leg is enumerated even half-provisioned: a mount missing from the
 * list is a partner-synced folder a credential could be referenced out of
 * unnoticed.
 */
export function jobRendezvousLegs(
  dir: string | undefined,
  outboundDir: string | undefined,
): Array<[string, RendezvousLeg]> {
  const legs: Array<[string, RendezvousLeg]> = [];
  if (dir !== undefined)
    legs.push([dir, outboundDir === undefined ? "shared" : "inbound"]);
  if (outboundDir !== undefined) legs.push([outboundDir, "outbound"]);
  return legs;
}

/**
 * The same mounts as {@link jobRendezvousLegs}, in the form the containment surfaces
 * (the pasted-credential scratch assertion and the credential `@path` warning)
 * enumerate: the directories alone.
 */
export function jobRendezvousDirs(
  provisioning: JobRendezvousProvisioning,
): Array<string> {
  return jobRendezvousLegs(provisioning.dir, provisioning.outboundDir).map(
    ([dir]) => dir,
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
 * Every preflight notice below is fitted to this budget where it is composed,
 * rather than to the wider whole-warning cap the seat that renders it applies:
 * fitting at composition keeps the clause a notice ENDS on -- its recovery step --
 * from being the part that cap eats.
 *
 * @internal exported for testing
 */
export const RENDEZVOUS_NOTICE_BUDGET = DEFAULT_MAX_DISPLAY_LENGTH;

/**
 * A preflight notice with its interpolated paths, or the pathless wording when the
 * first does not fit {@link RENDEZVOUS_NOTICE_BUDGET} once rendered.
 *
 * All-or-nothing rather than clipped: a clipped path reads like a whole path the
 * operator could go and look at. The sentence around the paths is what the
 * operator cannot reconstruct, so it is what survives; pathless wording that is
 * itself over budget is a copy overrun the checks fail on.
 */
function fitNotice(withPaths: string, withoutPaths: string): string {
  return renderedDisplayCost(withPaths) <= RENDEZVOUS_NOTICE_BUDGET
    ? withPaths
    : withoutPaths;
}

/** The suffix that absorbs the entries a listing does not name. */
function andMoreSuffix(count: number): string {
  return ` and ${count} more`;
}

/** How a notice names the mount it is about: "the rendezvous directory" on a
 * single-mount console, "the inbound/outbound rendezvous directory" on a split
 * one. `noun` is `path` for the one notice about something that is not a
 * directory at all. */
function legNoun(leg: RendezvousLeg, noun: "directory" | "path"): string {
  return `the ${leg === "shared" ? "" : `${leg} `}rendezvous ${noun}`;
}

/**
 * The notice raised when a directory in the overlap comparison could not have its
 * OWN real path READ: the comparison narrowed to the configured paths, so a
 * symlink joining it to the other directory goes unseen. Always a warning, never a
 * refusal -- a filesystem that cannot answer decides which notice to raise, never
 * whether the exchange runs.
 *
 * `comparedWith` names the other directory, needed on a split console where the
 * data root and work-input directory are each compared once per leg. The mount's
 * own notice passes none, being the side every other one is compared against.
 */
function unresolvedRealPathNotice(
  subject: string,
  subjectPath: string,
  comparedWith?: string,
): string {
  const unresolved =
    " could not be resolved to its real path, so an overlap a symlink makes" +
    `${comparedWith === undefined ? "" : ` with ${comparedWith}`} would go ` +
    "unseen. Give the console read access to every folder on the way to it.";
  return fitNotice(
    `${subject} ${subjectPath}${unresolved}`,
    `${subject}${unresolved}`,
  );
}

/**
 * As much of the sweep control's visible label as the notice budget leaves beside
 * the mount path. Held as its own value because both recoveries below quote it,
 * and tied to the label the run form renders by a check rather than by matching
 * copy in two files.
 */
const QUOTED_SWEEP_CONTROL = "Clear leftover exchange files";

/**
 * The lead of a non-empty rendezvous directory's warning: what is wrong, the
 * console's own sweep control that clears it (never a host-side deletion), and
 * that the operator's own input and results are not what it deletes.
 *
 * Wording follows `sweepExchangeFiles`, the launch's own sweep intent: a launch
 * that already turned the control on is told its state, not told to turn on what
 * is already on.
 *
 * States that the sweep runs, never that it clears: the CLI's sweep refuses a
 * retain-mode transcript unless the run escalates past that guard, which the
 * console does not compose. The whole sentence must fit
 * {@link RENDEZVOUS_NOTICE_BUDGET}.
 *
 * @internal exported for testing
 */
export function notEmptyLead(
  rendezvousDir: string,
  leg: RendezvousLeg,
  sweepExchangeFiles: boolean,
): string {
  const label = legNoun(leg, "directory");
  const problem =
    " is not empty; an exchange refuses to start on an earlier run's files. ";
  const recovery = sweepExchangeFiles
    ? `"${QUOTED_SWEEP_CONTROL}" is on and runs first; your own input and ` +
      "results are not what it sweeps."
    : `Turn on "${QUOTED_SWEEP_CONTROL}" and re-run. Your own input and ` +
      "results are not what it refuses over.";
  return fitNotice(
    `${label} ${rendezvousDir}${problem}${recovery}`,
    `${label}${problem}${recovery}`,
  );
}

/**
 * What a non-empty rendezvous directory holds, as its own warning message. Sorted,
 * because readdir order is not a promise, so the same directory reads the same way
 * twice.
 *
 * Entry names are partner-chosen and reach the operator through the display sink
 * raw, fitted by RENDERED cost. A name is shown only when it fits whole -- a
 * chopped name reads like a whole one the operator could go and delete -- so one
 * that does not fit is counted instead, and later names are still tested rather
 * than suppressed behind it.
 */
function describeRendezvousEntries(
  entries: Array<string>,
  leg: RendezvousLeg,
): string {
  const head = `${legNoun(leg, "directory")} holds `;
  const budget = RENDEZVOUS_NOTICE_BUDGET - renderedDisplayCost(head);
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
 * The preflight warnings for a filedrop job's rendezvous directory, reported
 * through the job's warning channel at start. Defensive, never fatal: a missing,
 * non-directory, non-writable, unlistable, or non-empty mount only warns, and an
 * overlap with the input directory or data root warns rather than refuses -- the
 * operator's own directory layout is theirs to choose.
 *
 * Overlap and real-path checks run over each path as configured and as symlinks
 * resolve it ({@link resolvePathForms}); an unreadable side falls back to the
 * configured comparison and says so ({@link unresolvedRealPathNotice}).
 *
 * A split console runs this per leg, so every notice names which mount it is
 * about. This only decides which warning to raise -- it does not create the
 * directory, enforce a mode, or reject a symlinked mount.
 */
export function rendezvousStartupWarnings(
  rendezvousDir: string,
  leg: RendezvousLeg,
  jobInputDir: string | undefined,
  dataRoot: string,
  jobWorkdir: string,
  sweepExchangeFiles: boolean,
): Array<string> {
  const label = legNoun(leg, "directory");
  const warnings: Array<string> = [];
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(rendezvousDir);
  } catch {
    const missing =
      " does not exist yet; the exchange cannot rendezvous until both " +
      "parties can reach it";
    warnings.push(
      fitNotice(`${label} ${rendezvousDir}${missing}`, `${label}${missing}`),
    );
  }
  if (stat !== undefined) {
    if (!stat.isDirectory())
      warnings.push(
        fitNotice(
          `${legNoun(leg, "path")} ${rendezvousDir} is not a directory`,
          `${legNoun(leg, "path")} is not a directory`,
        ),
      );
    else {
      try {
        fs.accessSync(rendezvousDir, fs.constants.W_OK);
      } catch {
        // Write access is checked on the inbound leg too, where this party only
        // reads: the exchange's own connect probes read AND write on each
        // directory before it starts, so a read-only inbound mount stops the run
        // just as a read-only outbound one does.
        const unwritable =
          leg === "inbound"
            ? " is not writable; the exchange checks write access on both " +
              "rendezvous folders before it starts"
            : " is not writable; the exchange writes its half of the " +
              "rendezvous there";
        warnings.push(
          fitNotice(
            `${label} ${rendezvousDir}${unwritable}`,
            `${label}${unwritable}`,
          ),
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
        const unlistable =
          " cannot be listed, so whether an earlier exchange left files " +
          "there is unknown until the exchange runs";
        warnings.push(
          fitNotice(
            `${label} ${rendezvousDir}${unlistable}`,
            `${label}${unlistable}`,
          ),
        );
      }
      if (entries !== undefined && entries.length > 0)
        warnings.push(
          notEmptyLead(rendezvousDir, leg, sweepExchangeFiles),
          describeRendezvousEntries(entries, leg),
        );
    }
  }

  const rendezvousPaths = resolvePathForms(rendezvousDir);
  const overlaps: Array<[string, string]> = [[dataRoot, "the job data root"]];
  if (jobInputDir !== undefined)
    overlaps.push([jobInputDir, "the work-input directory"]);
  for (const [other, otherLabel] of overlaps) {
    const otherPaths = resolvePathForms(other);
    if (pathFormsOverlap(rendezvousPaths, otherPaths))
      warnings.push(
        fitNotice(
          `${label} ${rendezvousDir} overlaps ${otherLabel} ` +
            `(${otherPaths.resolved}); a partner's sync writes would reach it`,
          `${label} overlaps ${otherLabel}; a partner's sync ` +
            "writes would reach it",
        ),
      );
    if (!otherPaths.canonicalized)
      warnings.push(
        unresolvedRealPathNotice(otherLabel, otherPaths.resolved, label),
      );
  }
  if (!rendezvousPaths.canonicalized)
    warnings.push(unresolvedRealPathNotice(label, rendezvousDir));
  return warnings;
}
