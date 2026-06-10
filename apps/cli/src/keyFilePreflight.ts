import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { getLogger } from "@psilink/core";

/**
 * Pre-flight validation for an authenticated exchange's key-file path, run
 * before any connection is opened so a misconfiguration fails deterministically
 * -- with no rendezvous I/O and before the partner can be left holding a rotated
 * token this side cannot persist. It mirrors what {@link saveKeyFile} will do
 * post-handshake (a recursive parent `mkdir`, then a write) and rejects up front
 * the cases where that write would fail after a successful key exchange, when
 * recovery would otherwise require a re-invitation.
 *
 * Returns the trimmed key-file path: leading and trailing whitespace is removed
 * (a value like `"  ./key  "` is almost certainly a user typo) without mutating
 * the caller's value, and the trimmed result is what the caller must hand to
 * {@link saveKeyFile}. Throws -- with the user-facing error strings -- when:
 *
 * - `keyFilePath` is missing or whitespace-only;
 * - the path already exists but is a directory or other non-regular node;
 * - the parent exists but is not a directory, or cannot be created or written.
 *
 * Side effect: creates the parent directory (recursively) when it does not yet
 * exist, mirroring {@link saveKeyFile}; the creation is logged and left in place
 * even if a subsequent handshake or exchange fails.
 *
 * `log` receives the parent-directory-created notice; pass the same logger
 * `runProtocol` uses so the message carries the run's context.
 */
export function preflightKeyFilePath(
  keyFilePath: string,
  log: ReturnType<typeof getLogger>,
): string {
  // Guards against a missing or whitespace-only keyFilePath before any
  // connection is opened (a whitespace-only path would create a file named
  // " " in the current directory rather than failing clearly). Trim leading
  // and trailing whitespace from the supplied value before using it: a
  // value like "  ./key  " is almost certainly user typo and would
  // otherwise become "  ." for dirname and " ./key  " for the file name,
  // producing a confusing on-disk artifact rather than the intended file.
  if (typeof keyFilePath !== "string" || keyFilePath.trim().length === 0)
    throw new Error(
      "connection.authentication must include a non-empty keyFilePath",
    );
  const kfp = keyFilePath.trim();
  // Pre-validate the key path itself: it is fine as a regular file or a
  // symlink, and rejected only if it already exists as a directory or other
  // special node. saveKeyFile writes a temp file and renameSync()s it onto
  // this path, and rename replaces the final component in place -- acting on a
  // symlink as the link itself rather than following it -- so a regular file or
  // a symlink (to anything, including a directory) is overwritten cleanly. Only
  // a real directory or special node, which rename cannot overwrite, would make
  // that write fail post-handshake, when the partner may already hold the
  // rotated token and recovery needs a preventable re-invitation. Use lstatSync
  // (not statSync) so a symlink is classified as a symlink and accepted as-is
  // rather than resolved to its target's type.
  try {
    const targetStat = fs.lstatSync(kfp);
    if (!targetStat.isFile() && !targetStat.isSymbolicLink())
      throw new Error(
        `keyFilePath ${kfp} exists but is not a regular file (` +
          `${
            targetStat.isDirectory()
              ? "directory"
              : "non-regular filesystem entry"
          }); saveKeyFile would fail after a successful key exchange. ` +
          "Remove or rename it before running the exchange.",
      );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT: keyFilePath does not yet exist (first run after invite/
    // accept) and saveKeyFile will create it — fine.
    // ENOTDIR: a component of the path prefix is a regular file, so kfp
    // cannot exist; fall through and let the parent-directory check below
    // raise the more specific "parent exists but is not a directory"
    // error.
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
  }
  // Pre-validate that the parent directory exists (creating it if missing,
  // mirroring saveKeyFile's `mkdirSync({ recursive: true })`) and that it
  // is a directory, so saveKeyFile failure cannot occur after a successful
  // key exchange, where the partner may already hold the rotated token
  // and recovery requires re-invitation.
  const parent = path.dirname(kfp);
  let parentStat: fs.Stats | undefined;
  try {
    parentStat = fs.statSync(parent);
  } catch (err) {
    // ENOENT means the parent does not yet exist. saveKeyFile would create
    // it via `mkdirSync({ recursive: true })`, so do the same here. Any
    // failure that prevents creation (EACCES on a read-only ancestor, a
    // dangling symlink whose target cannot be created) is the real
    // misconfiguration and is surfaced with a clearer message.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(
        `keyFilePath parent directory ${parent} is not accessible: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    try {
      fs.mkdirSync(parent, { recursive: true });
      // Surface the side effect so users can see why a directory appeared
      // even if the subsequent handshake or exchange fails and saveKeyFile
      // never writes the key file into it.
      log.info(
        `created keyFilePath parent directory ${parent} (mirrors ` +
          "saveKeyFile's recursive mkdir; left in place on failure)",
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
        `keyFilePath parent directory ${parent} cannot be created${hint}: ` +
          (createErr instanceof Error ? createErr.message : String(createErr)),
      );
    }
  }
  if (!parentStat.isDirectory())
    throw new Error(
      `keyFilePath parent ${parent} exists but is not a directory; ` +
        "saveKeyFile would fail after a successful key exchange",
    );
  // Best-effort writability check: catches the common case of a read-only
  // parent before the key exchange rotates the secret. fs.accessSync(W_OK) is
  // unreliable on Windows (it consults only the read-only attribute, not
  // the ACL) and can be inconsistent on Linux with capabilities such as
  // CAP_DAC_OVERRIDE. A create-and-unlink probe on a sentinel file
  // exercises the actual permission path that saveKeyFile will use, and
  // works identically on every platform. PID + crypto-random nonce in the
  // name prevents collisions with concurrent runs, and the unlink in
  // `finally` cleans up even if open fails partway. The real rename in
  // saveKeyFile may still fail (e.g. quota exceeded between probe and
  // write), but the common misconfiguration is caught here before the
  // partner can be left holding a rotated token this side cannot persist.
  //
  // Sweep any stale probe files from previous SIGKILL'd / OOM'd runs first
  // so the directory does not accumulate empty zero-byte litter. Names
  // include a unique nonce, so unlinking other entries that match the
  // pattern is safe on POSIX: a concurrent run that has already opened its
  // probe does not care if the path is unlinked underneath it (the fd
  // remains valid). On Windows the open file is held without
  // FILE_SHARE_DELETE, so unlinkSync on a peer's probe fails with EPERM;
  // the inner catch swallows the failure and the peer's probe remains.
  // The leftover is cosmetic (zero-byte file) and is swept on the next
  // non-concurrent invocation. This is documented rather than worked
  // around because no Node API exposes FILE_SHARE_DELETE without addons.
  // Match the exact probe-file name format produced below
  // (`.psilink-write-probe-<pid>-<8 hex chars>`) so that an unrelated
  // file the user happens to have placed with this prefix is not
  // silently unlinked.
  const PROBE_NAME_RE = /^\.psilink-write-probe-\d+-[0-9a-f]{8}$/;
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
     * itself will surface the underlying access problem with a clearer
     * message. */
  }
  const probeName =
    `.psilink-write-probe-${process.pid}-` + crypto.randomUUID().slice(0, 8);
  const probePath = path.join(parent, probeName);
  let probeFd: number | undefined;
  try {
    probeFd = fs.openSync(
      probePath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    );
  } catch (err) {
    throw new Error(
      `keyFilePath parent directory ${parent} is not writable: ` +
        (err instanceof Error ? err.message : String(err)) +
        ". Restore write permission before running the exchange, " +
        "otherwise saveKeyFile would fail after a successful key " +
        "exchange and both parties would need to re-invite.",
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
  return kfp;
}
