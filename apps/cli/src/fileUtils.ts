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
    // and reject; fail loudly here so the misconfiguration shows up with a
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

// SYSTEM (S-1-5-18) and Administrators (S-1-5-32-544) have access to files by
// default on Windows; do not warn about them. The icacls fallback exempts
// them by skipping inherited ACEs instead of matching by SID, since icacls'
// display names for built-ins are locale-dependent. See
// docs/spec/CREDENTIAL_STORAGE.md#windows-write-discipline-and-load-check.
const EXEMPT_SIDS = new Set(["S-1-5-18", "S-1-5-32-544"]);
// FILE_READ_DATA = 0x1; GenericRead = 0x80000000 (bit 31, negative as signed
// int32); GenericAll = 0x10000000.
// All grant or imply read access; check each independently since they don't
// share bits. Windows maps generic rights to object-specific rights before
// storing in ACEs, but a stored ACE holding an unmapped GENERIC_ALL bit
// (malformed or from old tooling) would be missed by the other two checks.
const GENERIC_READ = 0x80000000;
const GENERIC_ALL = 0x10000000;

// Warn if the key file's ACL grants read access to principals other than the
// current user and well-known system accounts. Tries PowerShell's Get-Acl
// (locale-independent, checks inherited and explicit ACEs; may be unavailable
// in Nano Server, WDAC, or Constrained Language Mode) and falls back to
// icacls (explicit ACEs only). See
// docs/spec/CREDENTIAL_STORAGE.md#windows-write-discipline-and-load-check.
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
      // Non-sensitive: PowerShell ACL-listing output, not a credential file, so
      // there is no secret for a parse error to leak.
      // eslint-disable-next-line no-restricted-properties -- non-credential parse, see above
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
 * Delete every extended (NFSv4) ACL entry on `targetPath` -- a file or a
 * directory -- so an owner-only mode is its whole access story. A no-op off
 * macOS, where a numeric `chmod` (Linux) or `icacls` (Windows) already governs
 * access.
 *
 * `symlinks` sets whether the strip follows a symlink at `targetPath`: pass
 * `"do-not-follow"` for psilink's own temp/work paths (opened `O_NOFOLLOW`,
 * so a symlink there is a plant) and `"follow"` for an operator-supplied path
 * that the write itself resolves. `reportedPath` names the destination in a
 * failure message when it differs from `targetPath`.
 *
 * A failed strip throws and the caller must fail closed. Byte-level operand
 * construction and the per-call-site rationale:
 * docs/spec/CREDENTIAL_STORAGE.md#macos-extended-acl-strip.
 */
export function stripExtendedAcls(
  targetPath: string,
  {
    symlinks,
    reportedPath = targetPath,
  }: { symlinks: "do-not-follow" | "follow"; reportedPath?: string },
): void {
  if (process.platform !== "darwin") return;
  try {
    // Built inside the fail-closed try: process.cwd() throws ENOENT once the
    // working directory is gone, and that must count as a strip that did not
    // run, not a bare errno past the writers' contract. Only a relative path
    // needs cwd, so an already-absolute operand is unaffected. See
    // docs/spec/CREDENTIAL_STORAGE.md#macos-extended-acl-strip.
    const operand = targetPath.startsWith("/")
      ? targetPath
      : absolutizeAgainstWorkingDirectory(targetPath);
    const args =
      symlinks === "do-not-follow" ? ["-h", "-N", operand] : ["-N", operand];
    execFileSync("/bin/chmod", args, {
      stdio: "ignore",
      timeout: 5000,
    });
  } catch (err) {
    // Fail closed, as the Windows icacls path does: refuse to write content
    // into a file whose extended ACL could not be cleared. Each caller's own
    // catch handles what it created -- see
    // docs/spec/CREDENTIAL_STORAGE.md#macos-extended-acl-strip.
    throw new Error(aclStripFailureMessage(reportedPath, err), { cause: err });
  }
}

// Prefix the process working directory. The root is the one working directory
// that already ends in a separator, so its own is dropped rather than emitting a
// `//name` whose leading double separator POSIX leaves to the implementation.
function absolutizeAgainstWorkingDirectory(filePath: string): string {
  const cwd = process.cwd();
  return `${cwd === "/" ? "" : cwd}/${filePath}`;
}

// Distinguishes a refusal that may have already altered the ACL (chmod was
// spawned: a status or a signal is present) from one that never ran (neither
// field present), so the operator is pointed at `ls -le` / `chmod -N` only
// when there is an ACL state to inspect. The underlying error rides along as
// `cause`. See docs/spec/CREDENTIAL_STORAGE.md#macos-extended-acl-strip.
function aclStripFailureMessage(reportedPath: string, err: unknown): string {
  const chmodMayHaveRun =
    typeof err === "object" &&
    err !== null &&
    (typeof (err as { status?: unknown }).status === "number" ||
      typeof (err as { signal?: unknown }).signal === "string");
  return chmodMayHaveRun
    ? `Could not clear extended ACLs on ${reportedPath}; inspect them with ` +
        "`ls -le` and clear them manually with `chmod -N`"
    : `Could not run the extended-ACL strip on ${reportedPath}; no content ` +
        "was written";
}

/**
 * Warn if `filePath` is readable by users other than its owner: the POSIX
 * mode check (any group/other bit set) on Unix, the ACL check
 * (`warnIfWindowsAclOverPermissive`) on Windows. `secretLabel` names the
 * secret in the warning ("shared secret" vs "signing private key"). Advisory
 * only: a removed file or unavailable tooling is swallowed.
 *
 * Shared by every loader of an owner-only secret file so they get the same
 * check from one implementation.
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
 * Pure existence check for a provisioning conflict, run before anything is
 * written or any network activity starts. Returns the subset of `paths` that
 * are occupied, preserving order; empty means no conflict. Kept separate from
 * the writers so callers can run it up front.
 *
 * Uses `lstatSync`, not `existsSync`, so a dangling symlink -- which
 * `existsSync` reports as absent but a write would still follow or fail on --
 * counts as occupied. A path whose parent denies access (EACCES) also counts
 * as occupied: occupancy cannot be disproven, so refusing is the safe
 * direction. Only a confirmed `ENOENT` clears a path.
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
   * only if absent, failing otherwise. Use for a credential that must be
   * generated exactly once (the signing identity), so two concurrent
   * first-time creators cannot both win. The default (`false`) overwrites, as
   * a rotating key file or a rewritten config requires.
   */
  exclusive?: boolean;
}

// Flush the parent directory so a rename/link's new directory entry is
// durable too, not just the (already fsync'd) file data -- the entry is
// separate metadata a crash could lose independently. POSIX only: Node's fs
// cannot open a directory handle on Windows, so NTFS journaling governs there
// instead. Shared by both atomic writers. See
// docs/spec/CREDENTIAL_STORAGE.md#posix-write-discipline.
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
      // already propagates from the try body and must not be masked; if it
      // succeeded, the directory is already durable and a close hiccup changes
      // nothing. A directory-fd close failure is pathological regardless, and
      // the fd is released at process exit.
    }
  }
}

/**
 * Atomically write `content` to `destPath` with owner-only permissions: `0600`
 * on Unix, a restricted ACL (current user, inheritance stripped) on Windows.
 * Writes to a sibling temp file and renames so the destination is never
 * visible with wrong permissions, removing the temp file on any failure. With
 * `exclusive`, the final step is an atomic create-if-absent that throws
 * ({@link FileExistsError}) rather than overwriting an existing file.
 *
 * The temp file's data is `fsync`'d before the rename and the parent
 * directory after it, so two sequential calls are crash-ordered: this is what
 * the self-attested exchange record relies on to write its verification-keys
 * file before the record (see `recordFile.ts`), and what protects a freshly
 * rotated shared-secret token (`saveKeyFile`). On macOS the extended (NFSv4)
 * ACL is cleared alongside the mode before any content is written. Byte-level
 * construction, the crash-ordering guarantee's platform scope, and the
 * `exclusive`-path directory-flush-after-create ordering are specified in
 * docs/spec/CREDENTIAL_STORAGE.md.
 *
 * Shared by every owner-only writer (the key file, the config writer,
 * exchange records, and the signing identity).
 */
export function writeFileOwnerOnly(
  destPath: string,
  content: string,
  options: WriteFileOwnerOnlyOptions = {},
): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  // Same-directory temp guarantees an atomic (same-filesystem) rename; a
  // cross-filesystem rename (EXDEV) is not attempted. The PID-qualified
  // suffix keeps concurrent invocations from clobbering each other's temp
  // file.
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
      // sensitive content. The brief window while the empty file has
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
      // Reopen by path (rather than disturb the placeholder-create/close/
      // icacls sequence above) to write through a retained fd, so the data can
      // be fsync'd before the rename, matching the POSIX branch. O_TRUNC is a
      // no-op on the empty placeholder and guards against a stale tail. Only
      // the directory-entry flush (fsyncParentDir below) stays POSIX-only.
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
          /* best-effort close; a write/fsync failure above already propagates */
        }
      }
    } else {
      // Exclusive, non-following create (O_EXCL | O_NOFOLLOW) so a symlink
      // planted at the temp path in the unlink->create window cannot redirect
      // the write. fchmodSync then sets the exact mode on the descriptor,
      // correcting for a restrictive umask rather than chmod-ing a resolved
      // path after the write. See
      // docs/spec/CREDENTIAL_STORAGE.md#posix-write-discipline.
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
        stripExtendedAcls(tmp, {
          symlinks: "do-not-follow",
          reportedPath: destPath,
        });
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
          /* best-effort close; a failure in the body above already propagates */
        }
      }
    }
    // Known limitation: a narrow window remains between the exclusive create
    // above and the rename/link below, where a directory-writer could swap
    // tmp for a symlink and leave destPath a redirecting link. It leaks
    // nothing -- the secret was written into the real tmp inode, never
    // through a link -- and the next write heals it. Closing it needs
    // renameat2(RENAME_NOREPLACE)/O_TMPFILE, which Node's fs does not expose.
    if (options.exclusive) {
      // Atomic create-if-absent: linkSync fails if destPath already exists,
      // closing the create-time race that renameSync (which silently overwrites)
      // would leave open. The temp file already has the owner-only
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
    // Flush the parent directory so the rename/link's new entry is durable
    // too. On the exclusive path this runs after the create-if-absent has
    // already succeeded, so a flush failure here throws (not a
    // FileExistsError) though destPath was created -- see the JSDoc contract
    // note. The temp cleanup below is otherwise a no-op on both paths.
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
 * Atomically write `content` to `destPath` with an explicit, world-readable
 * mode (default `0644`), via a sibling temp file and rename. For NON-secret,
 * shareable artifacts -- the exported public certificate -- where
 * {@link writeFileOwnerOnly} would force the wrong (owner-only) mode. Kept
 * separate so the owner-only, ACL-hardened path is not entangled with
 * public-file semantics.
 *
 * The macOS extended-ACL strip that {@link writeFileOwnerOnly} performs runs
 * here too, at any `mode`, since an inherited ACE can grant access an explicit
 * mode withholds. Durability matches {@link writeFileOwnerOnly}: the data is
 * `fsync`'d before the rename and the parent directory after it. See
 * docs/spec/CREDENTIAL_STORAGE.md.
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
    // Exclusive, non-following create (O_EXCL | O_NOFOLLOW) guards the temp
    // path the same way writeFileOwnerOnly's does. @types/node types
    // O_NOFOLLOW as a number but it is genuinely absent on Windows, so `?? 0`
    // drops it from the mask there rather than relying on
    // `undefined | x === x`, leaving the O_EXCL create unchanged.
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
      stripExtendedAcls(tmp, {
        symlinks: "do-not-follow",
        reportedPath: destPath,
      });
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
        /* best-effort close; a failure in the body above already propagates */
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
 * Open `destPath` for owner-only *streaming* writes -- the result-CSV
 * equivalent of {@link writeFileOwnerOnly} for a large, incrementally written
 * output. Returns an `fs.WriteStream` the caller writes rows to and closes.
 * The file is owner-only (`0600` on Unix; a restricted ACL on Windows) before
 * any content is written, whether newly created or overwriting a pre-existing
 * file.
 *
 * Two differences from {@link writeFileOwnerOnly}: it streams
 * rather than buffering a whole string, and it writes `destPath` directly
 * with no temp+rename, so it is NOT atomic -- acceptable for a recomputable
 * result output, unlike a credential.
 *
 * Unlike the credential writers, the path is operator-supplied (not
 * attacker-derived) and the descriptor is opened without `O_NOFOLLOW`/
 * `O_EXCL`, so an existing symlink at `destPath` is followed on Unix; on
 * Windows the destination is unlinked and recreated as a fresh inode before
 * its ACL is narrowed. Byte-level construction and the macOS extended-ACL
 * strip are specified in docs/spec/CREDENTIAL_STORAGE.md#result-csv-output.
 */
export function createOwnerOnlyWriteStream(destPath: string): fs.WriteStream {
  if (process.platform === "win32") {
    const owner = whoami();
    // Replace any existing file with a fresh inode before narrowing: icacls
    // /inheritance:r doesn't remove a foreign principal's explicit ACE left on
    // a pre-existing file, only inherited ones. unlinkSync does not follow a
    // symlink (it removes the link itself); ENOENT is the common new-file
    // case.
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
    // The strip follows a symlink at destPath, matching the open (no
    // O_NOFOLLOW) and the fchmod (acts on the resolved descriptor). Known
    // limitation: the strip re-resolves destPath by path rather than the open
    // descriptor, so a destPath swapped between the fchmod and this call
    // clears a different file's ACL than the one written to -- Node's fs
    // exposes no fd-based ACL API to close that window. See
    // docs/spec/CREDENTIAL_STORAGE.md#macos-extended-acl-strip.
    stripExtendedAcls(destPath, { symlinks: "follow" });
    fs.ftruncateSync(fd, 0);
  } catch (err) {
    // Refuse to write the result CSV where it cannot be made owner-only
    // (EPERM on a file owned by another user, or an ACL that could not be
    // cleared): close and propagate rather than leave PII at relaxed
    // permissions. Because the truncate runs only once both succeed, a
    // failure leaves an existing file's content intact; a file this call
    // created is left empty rather than deleted.
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
 * Expand a leading `~` (or `~/`) in a filesystem path to the current user's
 * home directory. A bare `~` becomes the home directory; `~/x` becomes
 * `<home>/x`. Any other form -- `~user` (another user's home; not resolved),
 * an embedded `~`, or `undefined` -- is returned unchanged. Node's `fs` does
 * not expand `~`, and a config-file path is never shell-expanded, so this
 * exists for `~/.psilink/...` in `psilink.yaml` or on the command line.
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
