import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  getLogger,
  keepOperatorSuppliedText,
  messageWithOperatorText,
  operatorSuppliedText,
} from "@alcove/core";

import { ownerOnlyTempPath } from "./fileUtils";

/** The consequence every pre-flight rejection states. */
const FAILS_AFTER_KEY_EXCHANGE =
  "otherwise saving the rotated key would fail after the key exchange and " +
  "both parties would need to re-invite";

/** Refuse a key path whose own name, or temp sibling `name`, is too long. */
function nameTooLongError(keyFilePath: string, name: string): Error {
  const which =
    name === keyFilePath
      ? messageWithOperatorText`its file name`
      : messageWithOperatorText`the temporary file written beside it (${operatorSuppliedText(name)})`;
  const message = messageWithOperatorText`key file path ${operatorSuppliedText(
    keyFilePath,
  )} is too long: ${which} exceeds the filesystem's name limit (ENAMETOOLONG). Choose a shorter key file name before running the exchange; ${FAILS_AFTER_KEY_EXCHANGE}.`;
  return keepOperatorSuppliedText(new Error(message.text), message);
}

/**
 * The mount points `/proc/self/mountinfo` lists: the fifth field of each line,
 * with the octal escapes the kernel writes for a space, tab, newline, or
 * backslash decoded.
 */
function mountPointsOf(mountinfo: string): Set<string> {
  const points = new Set<string>();
  for (const line of mountinfo.split("\n")) {
    const field = line.split(" ")[4];
    if (field !== undefined && field !== "")
      points.add(
        field.replace(/\\([0-7]{3})/g, (_, octal: string) =>
          String.fromCharCode(parseInt(octal, 8)),
        ),
      );
  }
  return points;
}

/**
 * Whether the directory entry at `keyFilePath` is itself a mount point, as a
 * key file bind-mounted on its own into a container is. Read from
 * `/proc/self/mountinfo`, so it answers only on Linux; elsewhere, or where that
 * file cannot be read, it answers false.
 */
function keyFileIsMountPoint(keyFilePath: string): boolean {
  let mountinfo: string;
  try {
    mountinfo = fs.readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return false;
  }
  const entry = path.join(
    fs.realpathSync(path.dirname(keyFilePath)),
    path.basename(keyFilePath),
  );
  return mountPointsOf(mountinfo).has(entry);
}

/**
 * Pre-flight validation for an authenticated exchange's key-file path, run
 * before any credential is presented. Mirrors what {@link saveKeyFile} does
 * post-handshake (recursive parent `mkdir`, a write, and on POSIX a
 * parent-directory fsync that opens the parent for reading) and rejects up
 * front the cases where that write would fail. Why the check runs
 * pre-handshake: docs/spec/CREDENTIAL_STORAGE.md, "Writable-and-readable-
 * parent pre-flight".
 *
 * Returns the trimmed key-file path (leading/trailing whitespace removed,
 * without mutating the caller's value); the trimmed result is what the
 * caller must hand to {@link saveKeyFile}. Throws -- with the user-facing
 * error strings -- when:
 *
 * - `keyFilePath` is missing or whitespace-only;
 * - the path already exists but is a directory or other non-regular node;
 * - the path, or the temp name the write creates beside it, is too long;
 * - the parent exists but is not a directory, or cannot be created, written,
 *   or (on POSIX) read;
 * - on Linux, the key file is a mount point of its own.
 *
 * Side effect: creates the parent directory (recursively) when it does not yet
 * exist, mirroring {@link saveKeyFile}; the creation is logged and left in place
 * even if a subsequent handshake or exchange fails.
 *
 * `log` receives the parent-directory-created notice; pass the same logger
 * `runProtocol` uses so the message holds the run's context.
 */
export function preflightKeyFilePath(
  keyFilePath: string,
  log: ReturnType<typeof getLogger>,
): string {
  // A missing or whitespace-only keyFilePath would otherwise create a file
  // named " " in the current directory instead of failing clearly; trimming
  // matches what the caller must hand to saveKeyFile (see the JSDoc above).
  if (typeof keyFilePath !== "string" || keyFilePath.trim().length === 0)
    throw new Error(
      "the key file path is empty. Name the key file with --key-file " +
        `before running the exchange; ${FAILS_AFTER_KEY_EXCHANGE}.`,
    );
  const kfp = keyFilePath.trim();
  // Accepted as-is if it is a regular file or a symlink (to anything,
  // including a directory): saveKeyFile writes a temp file and renames it
  // onto this path, and rename() replaces the final path component in
  // place -- acting on a symlink as the link itself, never following it --
  // so both are overwritten cleanly. Only a real directory or other special
  // node, which rename() cannot overwrite, is rejected here. lstatSync (not
  // statSync) classifies a symlink as itself rather than resolving to its
  // target's type.
  let targetStat: fs.Stats | undefined;
  try {
    targetStat = fs.lstatSync(kfp);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Fall through (leaving targetStat undefined) only for ENOENT, ENOTDIR,
    // EACCES, and ELOOP -- the codes the downstream parent/probe checks
    // re-encounter and re-classify with actionable guidance. Any other code
    // (above all ENAMETOOLONG, which those checks do not reproduce) is
    // rethrown, so pre-flight does not wrongly pass and leave saveKeyFile to
    // fail post-handshake, after the secret has rotated.
    if (code === "ENAMETOOLONG") throw nameTooLongError(kfp, kfp);
    if (
      code !== "ENOENT" &&
      code !== "ENOTDIR" &&
      code !== "EACCES" &&
      code !== "ELOOP"
    )
      throw err;
  }
  // The directory/special-node rejection runs outside the try because it
  // applies only when lstat SUCCEEDED and returned a stat (a non-file, non-
  // symlink node); gating it on targetStat being set keeps the "lstat threw"
  // errno handling above and this "lstat returned a bad node" check as separate
  // concerns.
  if (targetStat && !targetStat.isFile() && !targetStat.isSymbolicLink())
    throw new Error(
      `key file path ${kfp} exists but is not a regular file (` +
        `${
          targetStat.isDirectory()
            ? "directory"
            : "non-regular filesystem entry"
        }). Remove or rename it before running the exchange; ` +
        `${FAILS_AFTER_KEY_EXCHANGE}.`,
    );
  // The write's first act is on `<name>.tmp.<pid>`, a longer final component
  // than the key path's own, so a name within a few bytes of the limit passes
  // the lstat above and fails there after the secret rotated.
  const tempPath = ownerOnlyTempPath(kfp);
  try {
    fs.lstatSync(tempPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENAMETOOLONG")
      throw nameTooLongError(kfp, tempPath);
  }
  // Pre-validate the parent: create it if missing (mirroring saveKeyFile's
  // `mkdirSync({ recursive: true })`) and confirm it is a directory, so
  // saveKeyFile cannot fail here after the handshake (see the JSDoc above).
  const parent = path.dirname(kfp);
  let parentStat: fs.Stats | undefined;
  try {
    parentStat = fs.statSync(parent);
  } catch (err) {
    // ENOENT means the parent does not yet exist. saveKeyFile would create
    // it via `mkdirSync({ recursive: true })`, so do the same here. Any
    // failure that prevents creation (EACCES on a read-only ancestor, a
    // dangling symlink whose target cannot be created) is the real
    // misconfiguration and is reported with a clearer message.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(
        `key file parent directory ${parent} is not accessible: ` +
          (err instanceof Error ? err.message : String(err)) +
          ". Make the directory reachable, or choose a key file path " +
          `elsewhere, before running the exchange; ${FAILS_AFTER_KEY_EXCHANGE}.`,
      );
    try {
      fs.mkdirSync(parent, { recursive: true });
      // Logged so a directory that appeared is explained even if the run
      // fails afterwards (see the JSDoc above).
      log.info(
        `created key file parent directory ${parent} (left in place if the ` +
          "exchange fails)",
      );
      parentStat = fs.statSync(parent);
    } catch (createErr) {
      // lstat can distinguish a dangling symlink (target missing) from a
      // truly absent path so the hint points at the actual cause.
      let hint = "";
      try {
        if (fs.lstatSync(parent).isSymbolicLink())
          hint = " (path is a symbolic link, possibly dangling)";
      } catch {
        /* lstat failure: parent truly absent; default message applies. */
      }
      throw new Error(
        `key file parent directory ${parent} cannot be created${hint}: ` +
          (createErr instanceof Error ? createErr.message : String(createErr)) +
          ". Create the directory, or choose a key file path in an existing " +
          `writable directory, before running the exchange; ` +
          `${FAILS_AFTER_KEY_EXCHANGE}.`,
      );
    }
  }
  if (!parentStat.isDirectory())
    throw new Error(
      `key file parent ${parent} exists but is not a directory. Choose a key ` +
        "file path inside a directory before running the exchange; " +
        `${FAILS_AFTER_KEY_EXCHANGE}.`,
    );
  // Best-effort writability check for the common case of a read-only parent
  // before the secret rotates: fs.accessSync(W_OK) is unreliable here
  // (Windows checks only the read-only attribute; Linux can misreport under
  // capabilities like CAP_DAC_OVERRIDE), so a create-and-unlink probe on a
  // sentinel file exercises the real permission path saveKeyFile will use.
  // PID + a random nonce avoid collisions between concurrent runs; the
  // `finally` unlink cleans up even on a partial failure.
  //
  // Sweep stale probe files left by an earlier SIGKILL'd/OOM'd run so the
  // directory does not accumulate zero-byte litter, matching the exact name
  // pattern (`.alcove-write-probe-<pid>-<8 hex chars>`) so an unrelated
  // file with this prefix is not unlinked. Safe on POSIX even against a
  // concurrent run's open probe (unlink does not invalidate its fd); on
  // Windows a peer's open probe cannot be unlinked (EPERM, swallowed) and
  // is left as cosmetic litter for the next sweep.
  const PROBE_NAME_RE = /^\.alcove-write-probe-\d+-[0-9a-f]{8}$/;
  try {
    for (const entry of fs.readdirSync(parent)) {
      if (PROBE_NAME_RE.test(entry)) {
        try {
          fs.unlinkSync(path.join(parent, entry));
        } catch {
          /* best-effort cleanup; ignore failures (e.g. ENOENT from a
           * concurrent run that just unlinked its own probe). */
        }
      }
    }
  } catch {
    /* readdir failure (permission, transient) is non-fatal: the probe
     * itself will report the underlying access problem with a clearer
     * message. */
  }
  const probeName =
    `.alcove-write-probe-${process.pid}-` + crypto.randomUUID().slice(0, 8);
  const probePath = path.join(parent, probeName);
  let probeFd: number | undefined;
  try {
    probeFd = fs.openSync(
      probePath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    );
  } catch (err) {
    throw new Error(
      `key file parent directory ${parent} is not writable: ` +
        (err instanceof Error ? err.message : String(err)) +
        ". Restore write access -- the directory's owner as well as its " +
        "permissions, since in a container Alcove runs as its own account " +
        "and a mounted directory keeps the owner it has outside -- before " +
        `running the exchange; ${FAILS_AFTER_KEY_EXCHANGE}.`,
    );
  } finally {
    if (probeFd !== undefined) {
      try {
        fs.closeSync(probeFd);
      } catch {
        /* best-effort cleanup */
      }
    }
    try {
      fs.unlinkSync(probePath);
    } catch {
      /* best-effort cleanup; open() may have failed before the file was
       * created, in which case unlink ENOENT is expected. */
    }
  }
  // Mirrors saveKeyFile's post-rename durability step (fsyncParentDir opens
  // the parent for read); a write+execute-but-not-readable parent (mode
  // 0o300) would pass the write probe above yet fail that read-open after
  // the handshake. Why the pre-flight covers it up front: docs/spec/
  // CREDENTIAL_STORAGE.md, "Writable-and-readable-parent pre-flight".
  // POSIX-only: on Windows openSync on a directory fails outright and the
  // parent fsync is skipped, so there is no read requirement to verify.
  if (process.platform !== "win32") {
    let parentReadFd: number | undefined;
    try {
      parentReadFd = fs.openSync(parent, "r");
    } catch (err) {
      throw new Error(
        `key file parent directory ${parent} is not readable: ` +
          (err instanceof Error ? err.message : String(err)) +
          ". Restore read permission on the directory before running the " +
          `exchange; ${FAILS_AFTER_KEY_EXCHANGE}.`,
      );
    } finally {
      if (parentReadFd !== undefined) {
        try {
          fs.closeSync(parentReadFd);
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  }
  // A bind mount of the key file alone passes every check above, but the
  // rename that saves the rotated key fails EBUSY on a mount point.
  if (targetStat !== undefined && keyFileIsMountPoint(kfp))
    throw new Error(
      `key file ${kfp} is a mount point of its own, and saving the rotated ` +
        "key renames a new file over it, which a mount point refuses. Mount " +
        "the directory that holds the key file instead, and name the file " +
        "inside it with --key-file, before running the exchange; " +
        `${FAILS_AFTER_KEY_EXCHANGE}.`,
    );
  return kfp;
}
