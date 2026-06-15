import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getLogger } from "@psilink/core";

const log = getLogger("file-utils");

// Generic filesystem helpers shared across the CLI's file-custody modules
// (the key file, the config writer, exchange records, and the signing
// identity). Kept here -- rather than in any one feature module -- so those
// modules depend on a neutral utility instead of on each other.

let _whoami: string | undefined;
function whoami(): string {
  if (_whoami === undefined) {
    const value = execFileSync("whoami", [], { encoding: "utf8" }).trim();
    // An empty whoami would cause icacls to receive a bare `:(M)` grant later
    // and reject; fail loudly here so the misconfiguration surfaces with a
    // clear message rather than as a downstream icacls error.
    if (value === "")
      throw new Error(
        "whoami returned an empty string; cannot identify the current user " +
          "for key file ACL operations",
      );
    _whoami = value;
  }
  return _whoami;
}

// SYSTEM (S-1-5-18) and Administrators (S-1-5-32-544) having access to files
// is normal on Windows even on tightly restricted files; do not warn about
// them. The icacls fallback cannot exempt by SID (icacls outputs locale-
// dependent display names for built-ins); it achieves the same practical result
// by skipping inherited ACEs entirely -- these accounts appear only via
// inheritance on normally-configured systems. Explicit non-inherited ACEs for
// these accounts can only arise on files not created by writeFileOwnerOnly
// (which strips inheritance), so the fallback produces no false positives on
// psilink-managed files.
const EXEMPT_SIDS = new Set(["S-1-5-18", "S-1-5-32-544"]);
// FILE_READ_DATA = 0x1; GenericRead = 0x80000000 (bit 31, negative as signed
// int32); GenericAll = 0x10000000.
// All grant or imply read access; check each independently since they don't
// share bits. Windows maps generic rights to object-specific rights before
// storing in ACEs, but a stored ACE carrying an unmapped GENERIC_ALL bit
// (malformed or from old tooling) would be missed by the other two checks.
const GENERIC_READ = 0x80000000;
const GENERIC_ALL = 0x10000000;

// Warn if the key file's ACL grants read access to principals other than the
// current user and well-known system accounts.  Runs in two tiers:
//
//   1. PowerShell Get-Acl with SID translation: locale-independent and checks
//      both inherited and explicit ACEs.  May be unavailable in Nano Server
//      containers, WDAC-locked environments, or Constrained Language Mode.
//   2. icacls fallback: explicit ACEs only (inherited ACEs not checked).
//      Locale-independent: the only name comparison is whoami vs. the ACE
//      principal, and both come from the same OS name-resolution path.
//      SYSTEM and Administrators are not exempted by name because their
//      display names are locale-dependent; skipping inherited ACEs (the (I)
//      flag) covers their normal case -- see EXEMPT_SIDS above.
function warnIfWindowsAclOverPermissive(
  keyFilePath: string,
  secretLabel: string,
): void {
  // path is caller-supplied; '' escaping suffices because the user controls the
  // key file path
  const escaped = keyFilePath.replace(/'/g, "''");
  const cmd =
    `$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;` +
    `$acl=Get-Acl -LiteralPath '${escaped}';` +
    `$aces=@($acl.Access|%{` +
    `$s=try{$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{$null};` +
    `if($null -ne $s){'{"s":"'+$s+'","r":'+([int]$_.FileSystemRights)+',"t":'+([int]$_.AccessControlType)+'}'}` +
    `});` +
    `Write-Output($sid+'|['+($aces -join ',')+']')`;
  try {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", cmd],
      { encoding: "utf8", timeout: 5000 },
    ).trim();
    const sep = out.indexOf("|");
    if (sep !== -1) {
      const currentSid = out.slice(0, sep);
      const aces = JSON.parse(out.slice(sep + 1)) as Array<{
        s: string;
        r: number;
        t: number;
      }>;
      if (
        aces.some(
          (ace) =>
            ace.t === 0 &&
            ((ace.r & 1) !== 0 ||
              (ace.r & GENERIC_READ) !== 0 ||
              (ace.r & GENERIC_ALL) !== 0) &&
            ace.s !== currentSid &&
            !EXEMPT_SIDS.has(ace.s),
        )
      ) {
        log.warn(
          `${keyFilePath} has ACL entries granting read access to other ` +
            "users; restrict to owner-read-only via icacls or File " +
            `Properties to prevent other users from reading the ${secretLabel}`,
        );
      }
      return;
    }
  } catch {
    // PowerShell unavailable; fall through to icacls.
  }

  // icacls fallback: explicit ACEs only.
  try {
    const output = execFileSync("icacls", [keyFilePath], {
      encoding: "utf8",
      timeout: 5000,
    });
    const lines = output.split(/\r?\n/);
    const aces: string[] = [];
    // icacls echoes the path on the first line before the first ACE entry;
    // normalize separators since icacls always outputs backslashes.
    const echoed = keyFilePath.replace(/\//g, "\\");
    const firstLine = lines[0] ?? "";
    if (firstLine.toLowerCase().startsWith(echoed.toLowerCase())) {
      const rest = firstLine.slice(echoed.length);
      // rest[0] must be a space (path + " " + ACE) or absent (path only on
      // first line). Checking the character avoids a false prefix match if
      // echoed is a strict prefix of a longer path (e.g. "C:\foo" vs
      // "C:\foobar").
      if (rest === "" || rest[0] === " ") {
        const ace = rest.trimStart();
        if (ace) aces.push(ace);
      }
    }
    for (const line of lines.slice(1)) {
      const trimmed = line.trim();
      // Collect only lines that structurally look like ACE entries (contain the
      // principal:(flags) separator). This avoids matching the icacls summary
      // line ("Successfully processed N files..."), which is locale-dependent.
      if (trimmed.includes(":(")) aces.push(trimmed);
    }
    const id = whoami();
    const overPermissive = aces.some((ace) => {
      const sep = ace.indexOf(":(");
      if (sep === -1) return false;
      const flags = ace.slice(sep + 1);
      const isInherited = flags.includes("(I)");
      // icacls marks deny ACEs with "(DENY)" before the rights; these are
      // restrictive, not permissive. "(DENY)" is a structural token in icacls
      // output, locale-independent in the same way as "(I)".
      const isDeny = flags.includes("(DENY)");
      return (
        !isInherited &&
        !isDeny &&
        ace.slice(0, sep).trim().toLowerCase() !== id.toLowerCase()
      );
    });
    if (overPermissive) {
      // The fallback does not inspect the rights an ACE grants (icacls' rights
      // notation is complex and locale-adjacent), so it warns about any explicit
      // non-owner ACE without claiming it specifically grants read -- a
      // write-only grant on a secret file is a misconfiguration worth flagging
      // too. The PowerShell tier above does mask for read and keeps that wording.
      log.warn(
        `${keyFilePath} has ACL entries granting access to other users ` +
          "(inherited entries and specific rights not inspected); restrict to " +
          "owner-only via icacls or File Properties to prevent other users " +
          `from accessing the ${secretLabel}`,
      );
    }
  } catch {
    // icacls unavailable; warning is advisory
  }
}

/**
 * Warn if `filePath` is readable by users other than its owner. On Unix this is
 * the POSIX-mode check (any group/other bit set); on Windows it is the ACL check
 * (`warnIfWindowsAclOverPermissive`). `secretLabel` names the secret in the
 * warning so the message fits the file (a "shared secret" vs a "signing private
 * key"). Advisory only: a removed file or unavailable tooling is swallowed.
 *
 * Shared by every loader of an owner-only secret file (the key file and the
 * signing-identity loader) so they get the same permission check from one
 * implementation.
 */
export function warnIfFileOverPermissive(
  filePath: string,
  secretLabel: string,
): void {
  if (process.platform !== "win32") {
    try {
      const { mode } = fs.statSync(filePath);
      if (mode & 0o077) {
        log.warn(
          `${filePath} has permissions ` +
            `${(mode & 0o777).toString(8).padStart(4, "0")}; restrict to ` +
            `0600 (owner-read-only) to prevent other users from reading the ` +
            secretLabel,
        );
      }
    } catch {
      // file may have been removed between read and statSync; warning is
      // advisory
    }
  } else {
    // fs.statSync returns synthetic POSIX mode bits on Windows that do not
    // reflect the actual ACL; warnIfWindowsAclOverPermissive handles its own
    // error paths.
    warnIfWindowsAclOverPermissive(filePath, secretLabel);
  }
}

/**
 * Pure existence check used to detect a provisioning conflict before anything is
 * written -- and before any network activity. Returns the subset of `paths`
 * that are occupied, preserving order; an empty array means no conflict. Kept
 * separate from the writers (it neither writes nor connects) so callers can run
 * it up front and it is straightforward to unit-test.
 *
 * Uses `lstatSync` rather than `existsSync` so a path is reported occupied if
 * any directory entry is present -- including a dangling symlink, which
 * `existsSync` resolves to false yet which a write would still follow or fail
 * on. A path whose parent denies access (e.g. EACCES) is also reported occupied
 * rather than silently passing the gate: we cannot prove it is free, and
 * refusing is the safe direction. Only a confirmed `ENOENT` clears a path.
 */
export function detectFileConflicts(paths: string[]): string[] {
  return paths.filter((p) => {
    try {
      fs.lstatSync(p);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code !== "ENOENT";
    }
  });
}

/**
 * Thrown by {@link writeFileOwnerOnly} in `exclusive` mode when the destination
 * already exists (another process created it first). Distinct from a generic
 * write failure so a caller can recover -- e.g. by loading the file the winning
 * process wrote -- rather than treating the lost race as a hard error.
 */
export class FileExistsError extends Error {
  constructor(public readonly path: string) {
    super(
      `refusing to overwrite ${path}: it already exists (another process may ` +
        "have created it concurrently)",
    );
    this.name = "FileExistsError";
  }
}

/** Options for {@link writeFileOwnerOnly}. */
export interface WriteFileOwnerOnlyOptions {
  /**
   * Refuse to overwrite an existing destination: create the file atomically
   * only if it does not already exist, failing otherwise. Use for a credential
   * that must be generated exactly once (the signing identity), so two
   * concurrent first-time creators cannot both win -- which would leave one
   * process holding a key whose fingerprint no longer matches the file on disk.
   * The default (`false`) overwrites, as a rotating key file or a rewritten
   * config requires.
   */
  exclusive?: boolean;
}

// Flush the parent directory of `filePath` so a directory entry just created by
// a rename or link is itself durable across a power loss -- not only the file's
// data. The data fsync the writers do before the rename is not enough on its
// own: the entry that names the file is separate directory metadata, which a
// crash could lose while the data survives (or the reverse), the reordering that
// defeats the exchange record's opening-before-record crash ordering. POSIX
// only -- Node's fs cannot open a directory handle on Windows (openSync on a
// directory fails), so the entry flush there is left to the OS (NTFS metadata
// journaling) and the cross-write crash-ordering guarantee is POSIX-only. A
// no-op on win32. Shared by both atomic writers so their durability stays
// identical rather than diverging.
function fsyncParentDir(filePath: string): void {
  if (process.platform === "win32") return;
  const dirFd = fs.openSync(path.dirname(filePath), "r");
  try {
    fs.fsyncSync(dirFd);
  } finally {
    try {
      fs.closeSync(dirFd);
    } catch {
      // Swallow a close failure on either path: if fsyncSync threw, that error
      // surfaces from the try body and must not be masked; if it succeeded, the
      // directory is already durable and a close hiccup changes nothing. A
      // directory-fd close failure is pathological regardless, and the fd is
      // released at process exit.
    }
  }
}

/**
 * Atomically write `content` to `destPath` with owner-only permissions: `0600`
 * on Unix, a restricted ACL (current user, inheritance stripped) on Windows.
 * Writes to a sibling temp file and renames so the destination never exists
 * with wrong permissions, and removes the temp file on any failure so a crashed
 * write leaves no `.tmp.<pid>` orphan. With `exclusive`, the final step is an
 * atomic create-if-absent that throws rather than overwriting an existing file.
 *
 * Durability: the temp file's data is `fsync`'d before the rename and the parent
 * directory is `fsync`'d after it, so a power loss cannot surface the rename
 * while losing the file's contents. Because each call flushes its own directory
 * entry before returning, two sequential calls are crash-ordered: if the second
 * call's rename is durable, the first call's rename and contents are too. That
 * ordering is what the self-attested exchange record relies on -- it writes the
 * opening file before the record (see `recordFile.ts`) so a crash between the two
 * preserves the proof material -- and what keeps a freshly rotated shared-secret
 * token (`saveKeyFile`) from being lost. The data flush runs on every platform
 * (the Windows branch reopens the ACL-narrowed placeholder to write and flush
 * through a retained fd, like {@link writeFileAtomic}), but the parent-directory
 * flush is POSIX-only -- Node's `fs` cannot open a directory handle to
 * `FlushFileBuffers` on Windows -- so the cross-call crash-ordering guarantee is
 * POSIX-only and NTFS metadata journaling governs the Windows directory entry.
 * Within POSIX the guarantee is full on Linux (the CLI's production/Docker
 * target); on macOS Node issues `fsync(2)`, not `F_FULLFSYNC`, which moves the
 * data from the OS to the drive but does not force the drive's volatile cache to
 * media or stop the drive reordering writes, so there the crash-ordering holds
 * against process death but not necessarily a true power loss -- recoverable by
 * re-running. See SECURITY_DESIGN.md ("Required permissions").
 *
 * On the `exclusive` path the directory flush runs after the create-if-absent
 * (hard link) has already succeeded, so a flush failure -- a rare I/O error --
 * throws though `destPath` was created, and not as a {@link FileExistsError}.
 * The created file is left in place and a later run observes it as already
 * present (the signing-identity caller adopts it); the data was fsync'd before
 * the link, so only the directory entry's durability is in question there.
 *
 * Shared by every owner-only writer (the key file, the config writer,
 * exchange records, and the signing identity) so they all get the same
 * protection from one implementation rather than diverging.
 */
export function writeFileOwnerOnly(
  destPath: string,
  content: string,
  options: WriteFileOwnerOnlyOptions = {},
): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  // Write to a sibling temp file then rename so the destination is never
  // visible with wrong permissions (rename is atomic on the same filesystem).
  // Placing the temp file in the same directory as the destination guarantees
  // they share a filesystem; a cross-filesystem rename (EXDEV) would not be
  // atomic and is not attempted. A PID-qualified suffix prevents concurrent
  // invocations against the same path from clobbering each other's temp file.
  const tmp = `${destPath}.tmp.${process.pid}`;
  // Remove any stale temp file left by a previous crashed run so the subsequent
  // create always produces a fresh file rather than reusing one whose
  // permissions may not match what we are about to set.
  try {
    fs.unlinkSync(tmp);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  try {
    if (process.platform === "win32") {
      // whoami returns the domain-qualified name (DOMAIN\user or COMPUTER\user),
      // which icacls requires to resolve domain accounts unambiguously. Resolve
      // it before creating the temp file so a whoami failure does not leave a
      // placeholder on disk.
      const owner = whoami();
      // Create an empty placeholder and narrow its ACL before writing any
      // sensitive content. The brief window while the empty file carries
      // inherited ACEs (e.g. BUILTIN\Users read) exposes only the file's
      // existence, not its contents.
      const fd = fs.openSync(
        tmp,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      );
      fs.closeSync(fd);
      try {
        // /inheritance:r strips inherited ACEs (e.g. BUILTIN\Users group read);
        // /grant:r replaces any existing explicit grant for owner only.
        // (M) is the standard Modify level: FILE_GENERIC_READ |
        // FILE_GENERIC_WRITE | DELETE; it unambiguously includes the DELETE
        // right that MoveFileEx requires on the source file to complete the
        // subsequent rename.
        execFileSync(
          "icacls",
          [tmp, "/inheritance:r", "/grant:r", `${owner}:(M)`],
          { stdio: "ignore", timeout: 5000 },
        );
      } catch {
        // Surface a clear remediation; the outer catch removes the placeholder.
        throw new Error(
          `Could not restrict ACLs on ${destPath}; restrict manually to ` +
            "owner-read-only via icacls or File Properties",
        );
      }
      // ACL is now restricted; write the content into the already-protected
      // file through a retained fd so the data can be fsync'd before the rename,
      // matching writeFileAtomic and the POSIX branch. Reopen by path -- the same
      // exposure the prior path-based writeFileSync already had -- rather than
      // disturb the placeholder-create/close/icacls sequence above. O_TRUNC
      // mirrors writeFileSync's 'w' semantics; the placeholder is empty, so it is
      // a no-op that also defends against any stale tail. FlushFileBuffers on the
      // write handle is reachable because the owner's Modify (M) grant includes
      // FILE_GENERIC_WRITE. Only the directory-entry flush (fsyncParentDir below)
      // stays POSIX-only -- Node's fs offers no directory handle on Windows.
      const contentFd = fs.openSync(
        tmp,
        fs.constants.O_WRONLY | fs.constants.O_TRUNC,
      );
      try {
        fs.writeFileSync(contentFd, content, "utf8");
        fs.fsyncSync(contentFd);
      } finally {
        try {
          fs.closeSync(contentFd);
        } catch {
          /* best-effort close; a genuine write/fsync failure surfaces above */
        }
      }
    } else {
      // Create the temp file on an exclusive, non-following descriptor so a
      // symlink planted at the temp path in the unlink->create window cannot
      // redirect the write to the link's target. O_EXCL refuses to open through
      // an existing entry at the temp path; O_NOFOLLOW additionally refuses when
      // the final component is itself a symlink. fchmodSync then sets the exact
      // mode on the descriptor -- correcting for a restrictive umask (e.g. 0277
      // -> 0400) that would otherwise prevent a later rewrite of the rotated
      // token -- rather than chmod-ing a resolved path after the write.
      const fd = fs.openSync(
        tmp,
        fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_WRONLY |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        fs.fchmodSync(fd, 0o600);
        fs.writeFileSync(fd, content, "utf8");
        // Flush the temp file's data to stable storage before the rename, so a
        // power loss cannot leave the rename durable while the contents are
        // lost. Paired with the parent-directory fsync after the rename below.
        fs.fsyncSync(fd);
      } finally {
        // Guard the close so its failure cannot mask an fchmod/write/fsync error
        // in flight; the outer catch removes the temp file regardless.
        try {
          fs.closeSync(fd);
        } catch {
          /* best-effort close; a genuine failure surfaces from the body above */
        }
      }
    }
    // Known limitation: the exclusive create above closes the unlink->create
    // window, but a narrow one remains between it and the rename/link below,
    // where a directory-writer could swap tmp for a symlink and leave destPath a
    // redirecting link. It leaks nothing -- the secret is already in the real
    // tmp inode, never written through a link -- and the next write heals it;
    // fully closing it needs renameat2(RENAME_NOREPLACE)/O_TMPFILE, which Node's
    // fs does not expose.
    if (options.exclusive) {
      // Atomic create-if-absent: linkSync fails if destPath already exists,
      // closing the create-time race that renameSync (which silently overwrites)
      // would leave open. The temp file already carries the owner-only
      // permissions/ACL, and a hard link shares them, so the destination is
      // owner-only the instant it appears.
      try {
        fs.linkSync(tmp, destPath);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        // EEXIST is the normal "lost the race" signal. On Windows,
        // CreateHardLink can report EPERM instead of EEXIST on some filesystems
        // (FAT32, network shares) when the target exists; treat that as
        // "exists" only when the destination is in fact present, otherwise
        // rethrow the original error. The temp file is cleaned up by the outer
        // catch.
        if (code === "EEXIST" || (code === "EPERM" && fs.existsSync(destPath)))
          throw new FileExistsError(destPath);
        throw e;
      }
      // The link succeeded; destPath is the authoritative copy. Removing the
      // temp name is best-effort -- an orphaned temp is harmless and the next
      // run's stale-temp sweep removes it -- so a failure here must NOT mask the
      // successful creation by propagating to the outer catch.
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* best-effort: destination is already correctly created */
      }
    } else {
      fs.renameSync(tmp, destPath);
    }
    // Flush the parent directory so the rename/link's new directory entry is
    // durable across a power loss too -- the entry naming the file is separate
    // metadata from its (already fsync'd) contents. Inside the try so a flush
    // failure runs the temp cleanup and propagates; that cleanup is a no-op on
    // either path -- after a successful rename the temp name is gone, and on the
    // exclusive path the best-effort unlink above already removed it. On the
    // exclusive path the create-if-absent has already succeeded by the time this
    // runs, so a flush failure throws (not a FileExistsError) though destPath was
    // created -- see the JSDoc contract note.
    fsyncParentDir(destPath);
  } catch (err) {
    // Remove the temp file on any failure -- not just the icacls case -- so a
    // partial write never leaves a `.tmp.<pid>` orphan beside the destination.
    // A caller's own rollback cannot do this: it does not know the pid-qualified
    // temp name. When the failure was the exclusive open refusing a symlink
    // planted at the temp path, this removes that link itself (unlink never
    // follows it, so the link's target is untouched), clearing the slot.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup before re-throwing */
    }
    throw err;
  }
}

/**
 * Atomically write `content` to `destPath` with an explicit, world-readable mode
 * (default `0644`), via a sibling temp file and rename. For NON-secret,
 * shareable artifacts -- the exported public certificate -- where
 * {@link writeFileOwnerOnly} would be wrong (it forces owner-only `0600`, which
 * a partner could not read). The temp+rename gives crash-atomicity (a truncated
 * file is never visible at `destPath`) and the explicit `chmod` makes the mode
 * independent of the process umask. Kept deliberately separate from
 * `writeFileOwnerOnly` so the owner-only, ACL-hardened path -- the
 * security-sensitive one -- is not entangled with public-file semantics.
 *
 * Durability matches {@link writeFileOwnerOnly}: the temp file's data is
 * `fsync`'d before the rename (on every platform -- both writers retain a write
 * fd) so a power loss cannot surface the rename with the contents lost, and the
 * parent directory is `fsync`'d after the rename so the new directory entry is
 * durable too. Only that directory flush is POSIX-only (`fsyncParentDir` is a
 * no-op on Windows, where Node's `fs` cannot open a directory handle to flush).
 */
export function writeFileAtomic(
  destPath: string,
  content: string,
  mode = 0o644,
): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  // Same-directory temp guarantees a same-filesystem (atomic) rename; the
  // PID-qualified suffix keeps concurrent writers from clobbering each other.
  const tmp = `${destPath}.tmp.${process.pid}`;
  try {
    fs.unlinkSync(tmp);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  try {
    // Create the temp file on an exclusive, non-following descriptor so a
    // symlink planted at the temp path in the unlink->create window cannot
    // redirect the write to the link's target. O_EXCL is the cross-platform
    // guard -- it refuses to create over any existing entry, a symlink included;
    // O_NOFOLLOW adds POSIX-only defense-in-depth against a final-component
    // symlink. @types/node types O_NOFOLLOW as a number, but it is genuinely
    // absent on Windows, so `?? 0` drops it from the mask there (rather than
    // relying on `undefined | x === x`), leaving the O_EXCL create unchanged.
    const fd = fs.openSync(
      tmp,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        (fs.constants.O_NOFOLLOW ?? 0),
      mode,
    );
    try {
      // The open mode is masked by the umask; fchmod sets it exactly on the
      // descriptor so a restrictive umask cannot leave the shared file
      // unreadable to its audience. (On Windows fchmod only toggles the
      // read-only bit; the public default ACL already lets a partner read the
      // exported certificate.)
      fs.fchmodSync(fd, mode);
      fs.writeFileSync(fd, content, "utf8");
      // Flush the temp file's data before the rename so a power loss cannot
      // leave the rename durable while the contents are lost; the parent
      // directory is flushed after the rename below. Mirrors writeFileOwnerOnly,
      // including its Windows branch: both writers retain a write fd and fsync
      // the data on every platform, so only the directory flush below is
      // POSIX-only.
      fs.fsyncSync(fd);
    } finally {
      // Guard the close so its failure cannot mask an fchmod/write/fsync error
      // in flight; the outer catch removes the temp file regardless.
      try {
        fs.closeSync(fd);
      } catch {
        /* best-effort close; a genuine failure surfaces from the body above */
      }
    }
    // Same narrow tmp-swap window as writeFileOwnerOnly (between the close above
    // and this rename); for this public artifact it only risks leaving destPath
    // a redirecting symlink, which the next write heals. No portable fix in
    // Node's fs (it needs renameat2/O_TMPFILE).
    fs.renameSync(tmp, destPath);
    // Flush the parent directory so the rename's new directory entry is durable
    // too (POSIX only; see fsyncParentDir). Inside the try so a flush failure
    // runs the temp cleanup -- a no-op after a successful rename -- and propagates.
    fsyncParentDir(destPath);
  } catch (err) {
    // Remove the temp file on any failure so a partial write leaves no orphan.
    // If the failure was the exclusive open refusing a symlink planted at the
    // temp path, this removes that link itself (unlink never follows it, so the
    // link's target is untouched).
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup before re-throwing */
    }
    throw err;
  }
}

/**
 * Open `destPath` for owner-only *streaming* writes -- the result-CSV equivalent
 * of {@link writeFileOwnerOnly} for a large, incrementally written output.
 * Returns an `fs.WriteStream` the caller writes rows to and closes. The file is
 * owner-only (`0600` on Unix; an ACL restricted to the current user with
 * inheritance stripped on Windows) before any content is written, whether it is
 * newly created or overwrites a pre-existing file -- so the tool's most sensitive
 * output is never momentarily world/group-readable, nor left readable by reusing
 * a stale loose-permission file already at the path.
 *
 * Two deliberate differences from {@link writeFileOwnerOnly}:
 *  - It streams (the caller writes row by row) rather than buffering a whole
 *    string, so a large result set is never held in memory in full.
 *  - It writes `destPath` directly, with no temp+rename, so it is NOT atomic: a
 *    crash mid-write leaves a partial CSV. That matches the prior unprotected
 *    `createWriteStream` and is acceptable for a recomputable result output --
 *    unlike a credential, whose partial state would matter.
 *
 * On Unix the descriptor is opened with the `0600` create mode (without
 * `O_TRUNC`) and then `fchmod`'d to exactly `0600`: the `fchmod` both forces the
 * mode regardless of a relaxed umask (which would otherwise apply `0600 & ~umask`)
 * and tightens an existing over-permissive file at the path. The file is
 * truncated only after that succeeds, so a failure to secure the mode (e.g.
 * `EPERM` on a file owned by another user) leaves any existing content intact
 * rather than emptied. Like the `--log-file` open in
 * `configureLogFile`, and unlike the credential writers, the path is an
 * operator-supplied flag value -- not attacker-derived -- so the open does not add
 * the `O_NOFOLLOW`/`O_EXCL` hardening those writers use for paths psilink derives
 * itself.
 *
 * On Windows the synthetic POSIX mode bits set no ACL, so -- mirroring
 * {@link writeFileOwnerOnly}'s Windows branch -- any existing file is first
 * unlinked and recreated as a fresh inode (so the destination carries no foreign
 * principal's explicit ACE that an in-place narrow would miss), its ACL narrowed
 * with `icacls` (inheritance stripped, the current user granted Modify) before any
 * content is written, then streamed into. The brief window while the empty file
 * carries inherited ACEs exposes only the file's existence, not its contents.
 */
export function createOwnerOnlyWriteStream(destPath: string): fs.WriteStream {
  if (process.platform === "win32") {
    const owner = whoami();
    // Replace any existing file with a fresh inode before narrowing: icacls
    // /inheritance:r strips inherited ACEs and /grant:r replaces the current
    // user's own grant, but neither removes a foreign principal's explicit
    // (non-inherited) ACE left on a pre-existing file -- so an overwrite-in-place
    // could leave the result CSV readable by that principal. writeFileOwnerOnly
    // avoids this by writing a fresh temp inode and renaming over the destination;
    // here we unlink and recreate to the same effect, so the file icacls narrows
    // carries only the inheritable ACEs a brand-new inode gets. unlinkSync does
    // not follow a symlink (it removes the link itself); ENOENT is the common
    // new-file case.
    try {
      fs.unlinkSync(destPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    fs.closeSync(
      fs.openSync(
        destPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      ),
    );
    try {
      execFileSync(
        "icacls",
        [destPath, "/inheritance:r", "/grant:r", `${owner}:(M)`],
        { stdio: "ignore", timeout: 5000 },
      );
    } catch {
      // Surface a clear remediation rather than stream PII into a file whose ACL
      // we could not restrict; the empty placeholder is left for the operator.
      throw new Error(
        `Could not restrict ACLs on ${destPath}; restrict manually to ` +
          "owner-read-only via icacls or File Properties",
      );
    }
    // The narrowed ACL is a property of the file object and survives the reopen:
    // createWriteStream's default "w" truncates the (empty) file, not its DACL.
    return fs.createWriteStream(destPath, { encoding: "utf8" });
  }

  // Open without O_TRUNC so an existing file is not emptied before its mode is
  // secured; it is truncated below, only once fchmod has succeeded.
  const fd = fs.openSync(
    destPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT,
    0o600,
  );
  try {
    // fchmod forces exactly 0600 regardless of a relaxed umask and tightens an
    // existing over-permissive file; only once that has succeeded is the file
    // truncated to overwrite it (the no-O_TRUNC create above did not). Both run
    // before createWriteStream takes ownership of the descriptor, so a failure in
    // either must close fd here rather than leak it.
    fs.fchmodSync(fd, 0o600);
    fs.ftruncateSync(fd, 0);
  } catch (err) {
    // Refuse to write the result CSV where we cannot make it owner-only (e.g. a
    // pre-existing file owned by another user, which fchmod rejects with EPERM):
    // close the descriptor and let the failure propagate rather than leave PII at
    // relaxed permissions. Because the truncate runs only after fchmod succeeds,
    // a chmod failure leaves an existing file's content intact and no empty
    // orphan behind.
    try {
      fs.closeSync(fd);
    } catch {
      // best-effort close before re-throwing
    }
    throw err;
  }
  return fs.createWriteStream(destPath, {
    fd,
    encoding: "utf8",
    autoClose: true,
  });
}

/**
 * Expand a leading `~` (or `~/`) in a filesystem path to the current user's home
 * directory. A bare `~` becomes the home directory; `~/x` becomes `<home>/x`.
 * Any other form -- including `~user` (another user's home, which we do not
 * resolve) and an embedded `~` -- is returned unchanged, as is `undefined` (so
 * optional path options pass through). Node's `fs` does not expand `~`, and a
 * path that comes from a config file is never expanded by the shell, so a user
 * who writes `~/.psilink/...` in `psilink.yaml`, or quotes a `~` path on the
 * command line, would otherwise hit a literal directory named `~`.
 */
export function expandTilde(p: string): string;
export function expandTilde(p: string | undefined): string | undefined;
export function expandTilde(p: string | undefined): string | undefined {
  if (p === undefined) return undefined;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (process.platform === "win32" && p.startsWith("~\\"))
    return path.join(os.homedir(), p.slice(2));
  return p;
}
