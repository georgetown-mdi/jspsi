import fs from "node:fs";
import path from "node:path";

import { browseSegment } from "./workInputName";

/**
 * One entry in a mount listing: an admissible segment name and whether it is a
 * directory or a regular file. Classified from `statSync` (which follows a
 * symlink), so a symlink to a directory reads as `dir` and one to a file as
 * `file`; a broken or otherwise unstattable entry is dropped. No file bytes are
 * ever read.
 */
export interface MountEntry {
  name: string;
  kind: "dir" | "file";
}

/**
 * The `listMountEntries` result. `readable` is false when the requested subpath
 * is inadmissible, escapes the mount (lexically or by realpath), or cannot be
 * enumerated -- carried as a bare boolean with an empty list, so a mis-mount or a
 * traversal attempt is indistinguishable from an empty-but-readable directory and
 * neither the errno nor the absolute path rides the wire.
 */
export interface MountListing {
  readable: boolean;
  entries: Array<MountEntry>;
}

/**
 * Resolve `subPath` (a sequence of segments, never a slash-joined string) under
 * `mountRoot` to a realpath confined to the mount, or null when it is not.
 *
 * Every segment must pass {@link browseSegment} (single-segment shape, so no
 * `..`, separator, or control character composes a traversal). The candidate is
 * then confined twice: first lexically (`resolve` + the `startsWith(root + sep)`
 * idiom from {@link ./workdir}), then -- hardened -- by `realpathSync`, so a
 * symlink anywhere in the chain that lexically looks contained but resolves
 * outside the mount is refused. The realpath of the mount root is the anchor, so
 * a symlinked mount is handled too. Returns the confined realpath; the caller
 * never reads bytes through it.
 */
function resolveConfinedRealpath(
  mountRoot: string,
  subPath: Array<string>,
): string | null {
  for (const segment of subPath) if (!browseSegment(segment)) return null;

  const resolvedRoot = path.resolve(mountRoot);
  const candidate = path.resolve(resolvedRoot, ...subPath);
  if (!isContained(resolvedRoot, candidate)) return null;

  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = fs.realpathSync(resolvedRoot);
    realCandidate = fs.realpathSync(candidate);
  } catch {
    return null;
  }
  if (!isContained(realRoot, realCandidate)) return null;
  return realCandidate;
}

/** Whether `candidate` is `root` itself or strictly nested under it, over
 * already-resolved absolute paths (the `startsWith(root + sep)` idiom). */
function isContained(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate.startsWith(rootWithSep);
}

/**
 * List the admissible entries of the mount subdirectory named by `subPath`,
 * confined to `mountRoot`. Reads the directory non-recursively, keeps entries
 * whose name passes {@link browseSegment} (so each returned name is itself a
 * valid next segment) and that stat as a directory or regular file, and sorts by
 * name. An inadmissible, escaping, or unreadable subpath is `readable: false`
 * with an empty list. Never reads file bytes.
 */
export function listMountEntries(
  mountRoot: string,
  subPath: Array<string>,
): MountListing {
  const dir = resolveConfinedRealpath(mountRoot, subPath);
  if (dir === null) return { readable: false, entries: [] };

  let names: Array<string>;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { readable: false, entries: [] };
  }
  const entries: Array<MountEntry> = [];
  for (const name of names) {
    if (!browseSegment(name)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(path.join(dir, name));
    } catch {
      continue;
    }
    if (stat.isDirectory()) entries.push({ name, kind: "dir" });
    else if (stat.isFile()) entries.push({ name, kind: "file" });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { readable: true, entries };
}

/**
 * Resolve `subPath` under `mountRoot` to a confined regular file's absolute
 * (realpath) path, or null when the subpath is empty, inadmissible, escapes the
 * mount, or is not a regular file. Same admission and realpath re-confinement as
 * {@link listMountEntries}. Never reads file bytes -- it stats only, so the caller
 * gets a path to hand on as a credential reference without any secret entering
 * the server.
 */
export function resolveMountFile(
  mountRoot: string,
  subPath: Array<string>,
): { absolutePath: string } | null {
  if (subPath.length === 0) return null;
  const filePath = resolveConfinedRealpath(mountRoot, subPath);
  if (filePath === null) return null;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  return { absolutePath: filePath };
}
