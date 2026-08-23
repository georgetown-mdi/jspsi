import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_MAX_DISPLAY_LENGTH,
  pathsResolveToSameDir,
  renderedDisplayCost,
} from "@psilink/core";

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
 * {@link rendezvousSplitProblem}) rather than synced to the partner.
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
  const dataRoot = (env[JOB_DATA_ROOT_ENV] ?? "").trim();
  return {
    dir: dataRoot.length > 0 ? path.resolve(dataRoot) : undefined,
    fromOwnVariable: false,
  };
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
 * Why a split-provisioned appliance cannot run a filedrop exchange, or undefined
 * when the pair is coherent. Each case is a refusal with the variable to set named
 * in it, because none of them is a layout choice the operator can be left to make:
 *
 * - An outbound leg beside an inbound one that nobody named -- the data-root
 *   fallback resolves on every console that runs at all, so an operator who sets
 *   only the outbound variable, or mistypes the inbound one, would otherwise get a
 *   split whose partner-synced INBOUND folder is the data root, holding every job
 *   workdir's config, key, input, and results. A split takes both legs from their
 *   own variables; the fallback stays what it is for an unsplit appliance.
 * - Two legs that are one directory, or one nested inside the other, would have
 *   this party read its own writes as the partner's. Core's `pathsResolveToSameDir`
 *   refine catches only textual same-directory equality on the composed config, so
 *   the nesting half is checked here, where the appliance's own mounts are known.
 * - A leg the console cannot name, or two legs whose derived names coincide, cannot
 *   be minted into an invitation at all: the endpoint carries one name per leg and
 *   core refuses a filedrop endpoint whose halves resolve alike. Reporting that here
 *   is what turns core's refusal at mint -- with nothing an operator can act on --
 *   into the name variable to set.
 *
 * The containment test is lexical over the resolved paths, exactly as the preflight
 * overlap warnings are: a symlink that makes two distinct paths the same directory
 * is not caught here, and the exchange's own entry guard remains the backstop.
 *
 * @internal exported for testing
 */
export function rendezvousSplitProblem(
  provisioning: JobRendezvousProvisioning,
  inboundDirFromOwnVariable: boolean,
): string | undefined {
  const { dir, outboundDir, locator, outboundLocator } = provisioning;
  if (outboundDir === undefined) return undefined;
  if (dir === undefined || !inboundDirFromOwnVariable)
    return (
      `${JOB_RENDEZVOUS_OUTBOUND_DIR_ENV} is set but ${JOB_RENDEZVOUS_DIR_ENV} ` +
      "is not, so this appliance has only one leg of a split rendezvous. Set " +
      `${JOB_RENDEZVOUS_DIR_ENV} to the folder your partner writes into and ` +
      "restart the appliance."
    );
  if (containsOrEqual(dir, outboundDir) || containsOrEqual(outboundDir, dir))
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

/**
 * Resolve this appliance's whole rendezvous provisioning from the environment: both
 * legs, their names and locators, and the reason a filedrop exchange cannot run when
 * the pair is incoherent. Pure -- the memoized entry point is
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
  const problem = rendezvousSplitProblem(provisioning, fromOwnVariable);
  if (problem !== undefined) provisioning.problem = problem;
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
 * The lead of a non-empty rendezvous directory's warning: what is wrong, what an
 * exchange does about it, the control that clears it, and the files the operator
 * must NOT be read as being told to delete.
 *
 * The recovery is the console's own sweep rather than a host-side deletion: the
 * operator is reading this inside the GUI, and the run form carries a control that
 * does exactly this job. It quotes the opening of that control's visible label,
 * which is as much of it as the budget below leaves beside the mount path; the two
 * are held together by a check rather than by matching copy in two files.
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
): string {
  const label = legNoun(leg, "directory");
  const recovery =
    " is not empty; an exchange refuses to start on an earlier run's " +
    'files. Turn on "Clear leftover exchange files" and re-run. Your own ' +
    "input and results are not what it refuses over.";
  return fitNotice(
    `${label} ${rendezvousDir}${recovery}`,
    `${label}${recovery}`,
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
 * A directory that is not empty warns for a different reason: the console rendezvouses
 * every filedrop job out of the same mounts, so a completed retain-mode run leaves its
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
 * This does not create the directory, canonicalize it, reject a symlinked mount, or
 * enforce a mode.
 */
export function rendezvousStartupWarnings(
  rendezvousDir: string,
  leg: RendezvousLeg,
  jobInputDir: string | undefined,
  dataRoot: string,
  jobWorkdir: string,
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
          notEmptyLead(rendezvousDir, leg),
          describeRendezvousEntries(entries, leg),
        );
    }
  }

  const dataRootResolved = path.resolve(dataRoot);
  const overlaps: Array<[string, string]> = [
    [dataRootResolved, "the job data root"],
  ];
  if (jobInputDir !== undefined)
    overlaps.push([path.resolve(jobInputDir), "the work-input directory"]);
  for (const [other, otherLabel] of overlaps) {
    if (
      containsOrEqual(other, rendezvousDir) ||
      containsOrEqual(rendezvousDir, other)
    )
      warnings.push(
        fitNotice(
          `${label} ${rendezvousDir} overlaps ${otherLabel} ` +
            `(${other}); a partner's sync writes would reach it`,
          `${label} overlaps ${otherLabel}; a partner's sync ` +
            "writes would reach it",
        ),
      );
  }
  return warnings;
}
