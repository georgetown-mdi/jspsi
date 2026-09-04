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
 * The environment variable naming the operator-mounted rendezvous directory a
 * filedrop exchange reads and writes, symmetric with `JOB_INPUT_DIR`. When unset or
 * empty the rendezvous directory falls back to `JOB_DATA_ROOT`, so a single-folder
 * console -- one mount, only `JOB_DATA_ROOT` set -- rendezvouses out of the data
 * root. The filedrop transport is unavailable only when both are unset: the invite
 * chooser then disables its card and the accept flow reports the unavailable state.
 * The directory is server-side configuration, never a browser-sent path; it feeds
 * the CLI config the child reads, so nothing about it reaches argv.
 *
 * On an appliance that also sets {@link JOB_RENDEZVOUS_OUTBOUND_DIR_ENV} this names
 * the INBOUND (peer-written) leg of a split rendezvous rather than a directory both
 * parties write.
 */
export const JOB_RENDEZVOUS_DIR_ENV = "JOB_RENDEZVOUS_DIR";

/**
 * The environment variable naming the OUTBOUND (self-written) rendezvous directory
 * of a split filedrop exchange, the companion to {@link JOB_RENDEZVOUS_DIR_ENV}'s
 * inbound leg. Set it on an appliance whose partner-shared mailbox is two folders
 * -- this party writes into one and reads the peer's files out of the other -- and
 * every filedrop exchange the console runs carries the CLI's
 * `inbound_path`/`outbound_path` pair instead of a single shared `path`.
 *
 * Deliberately WITHOUT a {@link JOB_DATA_ROOT_ENV} fallback, unlike the inbound leg:
 * the variable being set is the one and only signal that this appliance provisions a
 * split rendezvous, and a fallback would turn every filedrop exchange on a plain
 * single-mount console into a split one. Setting it alone provisions no split
 * either: a split takes both legs from their own variables, so an inbound leg that
 * arrived through the data-root fallback is refused (see
 * {@link rendezvousSplitFaults}) rather than synced to the partner.
 *
 * Server-side configuration, never a browser-sent path.
 */
export const JOB_RENDEZVOUS_OUTBOUND_DIR_ENV = "JOB_RENDEZVOUS_OUTBOUND_DIR";

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

/**
 * The environment variable naming the SHARED FOLDER the OUTBOUND mount of a split
 * rendezvous stands for, the companion to {@link JOB_RENDEZVOUS_NAME_ENV}. It
 * exists for the same reason that one does -- a launcher that picks the mount point
 * names its own layout, not the operator's folder -- and follows the same rules: a
 * value that is not a bare folder name leaves the console with no name for the
 * outbound leg rather than falling back to the mount point.
 *
 * A split appliance needs BOTH legs named distinctly to mint an invitation, because
 * the invitation's endpoint carries a name per leg and core refuses a filedrop
 * endpoint whose two halves resolve alike. Two mounts whose last segments coincide
 * (`/mnt/in/psilink` and `/mnt/out/psilink`) are exactly the case this variable
 * resolves.
 *
 * Server-side configuration, never a browser-sent value: it reaches the partner in
 * the invitation's locator and on the accept kit.
 */
export const JOB_RENDEZVOUS_OUTBOUND_NAME_ENV = "JOB_RENDEZVOUS_OUTBOUND_NAME";

declare global {
  var jobRendezvousProvisioning: JobRendezvousProvisioning | undefined;
}

/**
 * How this appliance is provisioned to rendezvous a filedrop exchange, resolved once
 * from the environment. Either a single shared mount (`outboundDir` absent, the
 * console's original shape) or the split pair a second mount provisions, plus the
 * names and locators an invitation minted here may carry for each leg.
 *
 * `problem` is why a filedrop exchange CANNOT run as provisioned, in the operator's
 * own terms and naming the variable to fix. It is a refusal rather than a warning:
 * the faults it reports -- two legs that are one directory, two legs the console
 * cannot name apart, or one leg of a split nobody named -- are configurations under
 * which the exchange would read its own writes as the partner's, could not mint an
 * invitation at all, or would sync a folder the operator never offered, none of
 * which the operator's own directory-layout latitude covers. When it is set, no
 * filedrop exchange is offered or created.
 */
export interface JobRendezvousProvisioning {
  /** The inbound (peer-written) leg, or the single shared mount when no outbound leg
   * is provisioned. Undefined when no rendezvous mount resolves at all. */
  dir?: string;
  /** The outbound (self-written) leg; present only on a split appliance. */
  outboundDir?: string;
  folderName?: string;
  outboundFolderName?: string;
  /** The advisory locator an invitation minted here carries for {@link dir}. */
  locator?: string;
  /** The advisory locator for {@link outboundDir}, on a split appliance. */
  outboundLocator?: string;
  problem?: string;
  /**
   * Why the split pair's containment refusal was decided on the configured paths
   * alone: the console could not read one leg's real path, so a symlink joining
   * the two legs could not be seen. A warning rather than a refusal -- a
   * filesystem that cannot answer is not a reason to stop an exchange whose legs
   * may well be distinct -- and logged at startup beside {@link problem}, which it
   * qualifies rather than replaces.
   */
  unresolvedLegWarning?: string;
  /**
   * Whether a rendezvous leg HOLDS the job data root -- the mounted working
   * directory this party's long-lived signing key, config, input, and results live
   * in. True on the single-mount console, where the inbound leg falls back to the
   * data root, and true for any leg an operator pointed at the data root or at a
   * folder containing it.
   *
   * Set only when it is true, so an appliance whose rendezvous is separately
   * provisioned carries nothing. It is the one fact the console needs to tell the
   * two layouts apart: where it holds, whatever the partner syncs into that folder
   * they can also read out of it, so the signing key is a file they reach.
   * See {@link rendezvousHoldsDataRoot} for how it is decided.
   */
  sharesDataRoot?: boolean;
  /**
   * Whether {@link sharesDataRoot} reflects a verdict the walk could not rule out
   * -- an unresolved real path somewhere in the comparison -- rather than one it
   * positively established by a lexical containment or filesystem identity match.
   * Present only alongside `sharesDataRoot: true`; withheld when the match was
   * established, on the same "set only when it applies" rule. The console reads
   * it to choose between stating the shared layout as fact and hedging it (see
   * `receiptsModel.ts`).
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
 * the appliance is then provisioned for a single shared mount. No data-root
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
 * The outbound leg's own folder name on a split appliance, resolved from
 * {@link JOB_RENDEZVOUS_OUTBOUND_NAME_ENV} exactly as
 * {@link resolveJobRendezvousFolderName} resolves the inbound one, else from the
 * outbound mount's last segment.
 *
 * The mount decides first, so an appliance with no outbound leg has no outbound name
 * whatever the name variable says: the name belongs to a folder, and a single-mount
 * console that carries a stale {@link JOB_RENDEZVOUS_OUTBOUND_NAME_ENV} would
 * otherwise report the outbound half of a split rendezvous it does not have.
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
   * there), so {@link forms} carries the configured path alone. */
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
 * missing tail re-appended, so a mount the operator has not created yet is still
 * compared through a symlinked parent: a component that does not exist cannot be
 * the symlink that joins two directories, while its parent can. A component the
 * process cannot read (a permission or I/O failure on the way to the mount) is a
 * different matter -- the symlink could be exactly there -- so the directory falls
 * back to its configured path alone and says so through `canonicalized`, because a
 * filesystem that cannot answer must not become a verdict of its own.
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
 * ANY pairing of the forms they resolve to. Comparing across forms is what carries
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
 * variable(s) whose mounts could not be resolved, or undefined when both resolved.
 * It reports a check that ran narrower than it means to rather than a fault in the
 * operator's layout, so it names the recovery for the resolution itself.
 *
 * A single unresolved leg is worded narrower than a pair of them: the other leg's
 * real path still took part in the comparison, so only a symlink sitting on the
 * unresolved side would go uncaught, not a symlink anywhere in the pair.
 */
function describeUnresolvedLegs(
  inbound: ResolvedPathForms,
  outbound: ResolvedPathForms,
): string | undefined {
  if (inbound.canonicalized && outbound.canonicalized) return undefined;
  const recovery =
    "Give the console read access to every folder on the way to the mount " +
    "and restart the appliance.";
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
 * Why a split pair with both legs of its own cannot run a filedrop exchange, or
 * undefined when it is coherent. The half-provisioned case is decided before this,
 * where the legs are not yet a pair.
 *
 * - Two legs that are one directory, or one nested inside the other, would have
 *   this party read its own writes as the partner's. Core's `pathsResolveToSameDir`
 *   refine catches only textual same-directory equality on the composed config, so
 *   the nesting half is checked here, where the appliance's own mounts are known.
 * - A leg the console cannot name, or two legs whose derived names coincide, cannot
 *   be minted into an invitation at all: the endpoint carries one name per leg and
 *   core refuses a filedrop endpoint whose halves resolve alike. Reporting that here
 *   is what turns core's refusal at mint -- with nothing an operator can act on --
 *   into the name variable to set.
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
      "or one is inside the other, so this appliance would read its own writes " +
      `as your partner's. Mount ${JOB_RENDEZVOUS_OUTBOUND_DIR_ENV} outside ` +
      `${JOB_RENDEZVOUS_DIR_ENV} and restart the appliance.`
    );
  if (locator === undefined || outboundLocator === undefined)
    return (
      "This appliance cannot name both rendezvous folders, so an invitation " +
      `minted here would carry no locator for one of them. Set ${JOB_RENDEZVOUS_NAME_ENV} ` +
      `and ${JOB_RENDEZVOUS_OUTBOUND_NAME_ENV} to the two folders' own names and ` +
      "restart the appliance."
    );
  if (pathsResolveToSameDir(locator, outboundLocator))
    return (
      "The inbound and outbound rendezvous folders resolve to the same name, so " +
      "an invitation minted here could not tell your partner which is which. Set " +
      `${JOB_RENDEZVOUS_NAME_ENV} and ${JOB_RENDEZVOUS_OUTBOUND_NAME_ENV} to ` +
      "distinct names and restart the appliance."
    );
  return undefined;
}

/** What a split-provisioned appliance's two mounts are faulted for: the refusal
 * that stops every filedrop exchange, and the warning that the containment half of
 * it was decided without a leg's real path. Either or both may be absent. */
export interface RendezvousSplitFaults {
  problem?: string;
  unresolvedLegWarning?: string;
}

/**
 * Fault a split-provisioned appliance's rendezvous pair, or return nothing where
 * there is no split or the pair is coherent. A `problem` is a refusal with the
 * variable to set named in it, because none of the faults is a layout choice the
 * operator can be left to make -- the pair faults {@link splitPairProblem} decides,
 * and, first, an outbound leg beside an inbound one that nobody named: the
 * data-root fallback resolves on every console that runs at all, so an operator who
 * sets only the outbound variable, or mistypes the inbound one, would otherwise get
 * a split whose partner-synced INBOUND folder is the data root, holding every job
 * workdir's config, key, input, and results. A split takes both legs from their own
 * variables; the fallback stays what it is for an unsplit appliance.
 *
 * The containment half is decided over the configured paths AND the real paths
 * symlinks resolve them to (see {@link resolvePathForms}), so an outbound leg
 * symlinked onto the inbound one meets the same refusal a lexically nested one
 * does. It is the inbound leg the partner writes, and a pair provisioned as two
 * folders that silently reorients onto one is what the refusal exists for, however
 * the reorientation is spelled. A leg whose real path cannot be READ narrows the
 * comparison back to the configured paths and reports `unresolvedLegWarning`, never
 * a refusal of its own. The paths are read once, so a symlink repointed while the
 * appliance runs is not seen; the exchange's own entry guard remains the backstop.
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
        "is not, so this appliance has only one leg of a split rendezvous. Set " +
        `${JOB_RENDEZVOUS_DIR_ENV} to the folder your partner writes into and ` +
        "restart the appliance.",
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
 * Whether `leg` IS the data root, or a directory holding it, as the FILESYSTEM
 * knows the three rather than as their paths spell them.
 *
 * Aliasing the filesystem does not express as a symlink is invisible to every path
 * comparison, `realpath` included: the same host directory bind-mounted at two
 * container paths (`-v /host/psilink:/data` beside `-v /host/psilink:/mnt/share`)
 * resolves to two distinct real paths, and both name the one directory a partner's
 * sync writes into. The identity pair is what the two paths still share.
 *
 * The data root's whole ancestor chain is walked, not the data root alone, because a
 * leg aliasing a directory that HOLDS the data root reaches this party's key exactly
 * as one aliasing the data root does -- the same direction {@link pathFormsContain}
 * tests, so the aliased comparison stays directional too. Each ancestor is statted
 * lexically, which needs no realpath of its own: `stat` follows a symlinked ancestor
 * to the directory it names before reporting the pair.
 *
 * A directory the process could not stat counts as holding, the direction an
 * unreadable real path already fails in: what could not be read is precisely where
 * the aliasing would sit, and the verdict decides a warn-and-guide advisory -- and
 * that default counts as `uncertain`, since nothing was actually matched. A
 * directory that is simply absent aliases nothing and counts as nothing.
 *
 * What remains invisible is aliasing that neither `realpath` nor this identity walk
 * can see -- a leg bound onto some directory whose own contents reach the data root
 * by a route the ancestor chain does not pass through.
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
 * Whether any rendezvous leg holds the job data root, the fact
 * {@link JobRendezvousProvisioning.sharesDataRoot} carries, and whether that
 * verdict was positively established rather than defaulted
 * ({@link JobRendezvousProvisioning.sharesDataRootUncertain}).
 *
 * Every leg is asked, through the shared enumeration ({@link jobRendezvousDirs}),
 * because a partner writes into one leg of a split as readily as into the single
 * shared mount. The test is DIRECTIONAL: a leg that holds the data root puts this
 * party's files where the partner syncs, while a leg mounted INSIDE the data root
 * does not -- the sync reaches that subfolder, not the key beside it. Each leg is
 * compared as configured and as its real path (see {@link resolvePathForms}), so a
 * leg symlinked onto the data root counts exactly as one configured at it does, and
 * then by filesystem identity (see {@link legAliasesDataRootChain}), which is what
 * carries the verdict to aliasing no path expresses -- one host directory
 * bind-mounted at two container paths.
 *
 * A leg or a data root whose real path cannot be READ counts as holding: the
 * symlink that would join them is precisely what could not be resolved, and this
 * decides whether a warn-and-guide advisory is raised, so what cannot be ruled out
 * is reported rather than dropped -- as `uncertain`, since it is a default rather
 * than a match. The lexical comparison -- including the data-root fallback, where
 * the leg IS the data root -- runs only once both sides canonicalize, so it
 * shares the same gate: an unreadable data-root real path skips it and reports
 * `uncertain` for that leg exactly as an unreadable leg does. Every leg is checked
 * rather than stopping at the first that holds, so one leg's unresolved comparison
 * does not shadow another leg's lexical or filesystem match: a positive match on
 * any leg makes the whole verdict established.
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
 * Resolve this appliance's whole rendezvous provisioning from the environment: both
 * legs, their names and locators, the reason a filedrop exchange cannot run when the
 * pair is incoherent, and whether a leg holds the data root. Reads the filesystem --
 * each leg's real path, the data root's, and the identity of the data root's
 * ancestors where the paths alone leave the layout open -- for the whole appliance
 * rather than per exchange; the memoized entry point is
 * {@link useJobRendezvousProvisioning}.
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
 * shared directory of a one-mount console, or one leg of a split appliance's pair.
 * A split appliance preflights each leg independently, so every notice has to say
 * which of the two it means.
 */
export type RendezvousLeg = "shared" | "inbound" | "outbound";

/**
 * Every rendezvous mount this appliance runs a filedrop exchange over, paired with
 * the leg it is: one shared directory on a single-mount console, both legs on a
 * split one, and none when no mount resolves.
 *
 * The single enumeration of "every rendezvous mount", so the preflight that names
 * each leg and the containment surfaces that exclude each cannot come to different
 * answers about which mounts exist. Each leg joins independently: a mount missing
 * from the list is a partner-synced folder a credential could be referenced out of
 * unnoticed, so an outbound leg is enumerated even in the half-provisioned state
 * that no exchange runs in.
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
 * rather than to the wider whole-warning cap the seat that renders it applies.
 * Fitting at composition is what keeps the clause a notice ENDS on -- its recovery
 * step, or the reason the overlap matters -- from being the part a cap eats, and
 * the tighter of the two budgets is the one that makes the fit hold at either.
 *
 * @internal exported for testing
 */
export const RENDEZVOUS_NOTICE_BUDGET = DEFAULT_MAX_DISPLAY_LENGTH;

/**
 * A preflight notice with its interpolated paths, or the pathless wording when the
 * first does not fit {@link RENDEZVOUS_NOTICE_BUDGET} once rendered.
 *
 * All-or-nothing rather than clipped: a clipped path reads like a whole path the
 * operator could go and look at, and the paths are the only unbounded part of
 * every notice here -- the operator's own server-side configuration for the
 * console's single rendezvous mount, which they can read off their own launcher.
 * The sentence around them is what they cannot reconstruct, so the sentence is what
 * survives. A notice whose pathless wording is itself over budget is a first-party
 * copy overrun rather than a fit failure, and the checks fail on it.
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
 * The notice a directory of the overlap comparison raises when its OWN real path
 * could not be READ: the comparison narrowed back to the configured paths, so a
 * symlink joining it to the other directory goes unseen. It reports a check that
 * ran narrower than it means to rather than a fault in the operator's layout, so
 * what it names is the read access to restore -- and it stays a warning whichever
 * side could not be read, since a filesystem that cannot answer decides which
 * notice to raise and never whether the exchange runs.
 *
 * `comparedWith` names the other directory, which is what attributes the notice on
 * a split appliance: the data root and the work-input directory are compared once
 * per leg, so an unqualified sentence would reach the operator twice over with
 * nothing to tell the two apart. The mount's own notice passes none, being the side
 * every other one is compared against rather than one of them.
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
 * The lead of a non-empty rendezvous directory's warning: what is wrong, what an
 * exchange does about it, the control that clears it, and the files the operator
 * must NOT be read as being told to delete.
 *
 * The recovery is the console's own sweep rather than a host-side deletion: the
 * operator is reading this inside the GUI, and the run form carries a control that
 * does exactly this job.
 *
 * Which recovery it carries follows `sweepExchangeFiles`, the launch's own sweep
 * intent -- the same value the run's controls carry to the child. A launch that
 * already turned the control on is told the control's state and the order it runs
 * in instead of being told to turn on what it turned on, and the clause about the
 * operator's own files states what the sweep spares rather than what the entry
 * guard refuses over, because a run about to delete files is read for what it
 * deletes.
 *
 * That form states that the sweep runs, never that it clears: the CLI's sweep
 * refuses a retain-mode transcript unless the run escalates past that guard, and
 * the console does not compose the escalation (`--force-retain-sweep` is
 * unrepresentable in the job intent). A retained transcript is the headline case
 * this warning fires on, so a promised clear would be a promise the operator is
 * handed a refusal against. What that refusal costs and the command line that
 * overrules it are stated beside the control itself, where a launch carrying the
 * sweep has already read them, rather than spent from the budget this notice
 * shares with the mount path.
 *
 * The sink escapes and CAPS what it renders, so the whole sentence has to fit
 * {@link RENDEZVOUS_NOTICE_BUDGET} or the clause that keeps this from reading as
 * "empty the folder" is what falls off the end.
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
 * The preflight warnings for a filedrop job's rendezvous directory, surfaced through
 * the job's warning channel at start. Defensive, never fatal: a synced mount may
 * populate lazily and the CLI child is the runtime backstop for a truly-broken path,
 * so a missing, non-directory, non-writable, or unlistable mount only warns. An
 * overlap with the input directory or the data root also warns -- a partner with sync
 * write access to an overlapping mount could reach the operator's `.psilink.key`,
 * input, or results -- but the operator's own directory layout is theirs to choose, so
 * it is not refused.
 *
 * The overlap is decided over each path as configured AND as the real path symlinks
 * resolve it to (see {@link resolvePathForms}), so a mount symlinked onto the data
 * root raises the same notice a nested one does: what a partner's sync writes reach
 * is the directory at the far end of the link, not the path that names it. A
 * directory on EITHER side of that comparison whose own real path cannot be READ --
 * the mount, the data root, or the work-input directory -- falls back to the
 * configured comparison and says so in a further notice naming the side that could
 * not be resolved ({@link unresolvedRealPathNotice}), so a narrowed check is never
 * silent about which side narrowed it; one that simply does not exist yet is
 * resolved through its nearest existing ancestor and raises no notice about
 * resolution at all.
 *
 * A directory that is not empty warns for a different reason: the console rendezvouses
 * every filedrop job out of the same mounts, so a completed retain-mode run leaves its
 * whole transcript where the next run's entry guard refuses it, with no crash anywhere
 * in the story. It takes two warnings in order -- the recovery, then what the mount
 * holds -- because the display sink caps each message it renders, and one message
 * carrying both would spend the recovery's budget on the listing. Which recovery the
 * lead carries follows this launch's own sweep intent (see {@link notEmptyLead}), so
 * a launch already carrying the sweep is not sent to a control it is already using.
 * The listing leaves out one entry: the workdir this launch itself just created,
 * which in the single-folder layout (rendezvous directory equal to the data root)
 * always sits inside the mount by the time this preflight runs. It names what
 * remains and leaves the launch to the operator, whose own input and results may sit
 * in that listing too and are not what the guard objects to. It deliberately does not
 * sort protocol files from foreign ones: that grammar is the exchange's, and
 * predicting the guard's verdict here would be a second implementation of it.
 *
 * A split appliance runs this over EACH leg independently, which is why every notice
 * takes `leg` and names the mount it is about: an outbound directory that is missing
 * and an inbound one that is not empty are separate facts with separate recoveries,
 * and one set of notices covering "the rendezvous directory" would leave the operator
 * to guess which of their two folders to go and look at.
 *
 * Every notice raised here is fitted to {@link RENDEZVOUS_NOTICE_BUDGET} where it is
 * composed, so no clause an operator acts on can be the part the seat's cap eats;
 * what gives way is an interpolated path (see {@link fitNotice}), and the entry
 * listing gives way by name (see {@link describeRendezvousEntries}). What the whole
 * set measures at the rendered boundary is pinned by tests.
 *
 * This does not create the directory, enforce a mode, or reject a symlinked mount:
 * the real paths it reads decide which warning to raise, never whether the exchange
 * runs.
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
