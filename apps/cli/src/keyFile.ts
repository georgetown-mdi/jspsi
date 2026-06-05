import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getLogger, PAKE_TOKEN_REGEX, UsageError } from "@psilink/core";

const log = getLogger("key-file");

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
// these accounts can only arise on files not created by saveKeyFile (which
// strips inheritance), so the fallback produces no false positives on psilink-
// managed key files.
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
function warnIfWindowsAclOverPermissive(keyFilePath: string): void {
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
            "Properties to prevent other users from reading the PAKE token",
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
      log.warn(
        `${keyFilePath} has ACL entries granting read access to other users ` +
          "(inherited not checked); restrict to owner-read-only via icacls " +
          "or File Properties to prevent other users from reading the PAKE " +
          "token",
      );
    }
  } catch {
    // icacls unavailable; warning is advisory
  }
}

/**
 * Default path for the key file written by the provisioning commands (`invite`,
 * `accept`, and `exchange --save`). Matches the default the `exchange` command
 * reads from, so a key written here is found without an explicit `--key-file`.
 */
export const DEFAULT_KEY_PATH = "./.psilink.key";

/**
 * Pure existence check used to detect a provisioning conflict before anything is
 * written -- and before any network activity. Returns the subset of `paths`
 * that are occupied, preserving order; an empty array means no conflict. Kept
 * separate from {@link saveKeyFile} and the config writer (it neither writes nor
 * connects) so callers can run it up front and it is straightforward to
 * unit-test.
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

/** Contents of a `.psilink.key` file. */
export interface KeyFile {
  /** Shared SPAKE2 token; injected into the connection config at runtime. */
  pakeToken: string;
  /** ISO 8601 datetime after which the token should be considered expired. */
  expires?: string;
}

const KeyFileSchema: z.ZodType<KeyFile> = z.object({
  pakeToken: z
    .string()
    .regex(
      PAKE_TOKEN_REGEX,
      "pakeToken must be a base64url-encoded 32-byte value (43 base64url " +
        "characters; final character must be in [AEIMQUYcgkosw048]); " +
        "tokens are generated by 'psilink invite' - to obtain a new token, " +
        "both parties must re-invite",
    ),
  expires: z.iso.datetime().optional(),
});

/** Load and parse a `.psilink.key` file; returns `undefined` if absent. */
export function loadKeyFile(keyFilePath: string): KeyFile | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(keyFilePath, "utf8"));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const result = KeyFileSchema.parse(raw);
  if (process.platform !== "win32") {
    try {
      const { mode } = fs.statSync(keyFilePath);
      if (mode & 0o077) {
        log.warn(
          `${keyFilePath} has permissions ` +
            `${(mode & 0o777).toString(8).padStart(4, "0")}; restrict to ` +
            "0600 (owner-read-only) to prevent other users from reading the " +
            "PAKE token",
        );
      }
    } catch {
      // file may have been removed between readFileSync and statSync; warning
      // is advisory
    }
  } else {
    // fs.statSync returns synthetic POSIX mode bits on Windows that do not
    // reflect the actual ACL; warnIfWindowsAclOverPermissive handles its own
    // error paths.
    warnIfWindowsAclOverPermissive(keyFilePath);
  }
  return result;
}

/**
 * Atomically write `content` to `destPath` with owner-only permissions: `0600`
 * on Unix, a restricted ACL (current user, inheritance stripped) on Windows.
 * Writes to a sibling temp file and renames so the destination never exists
 * with wrong permissions, and removes the temp file on any failure so a crashed
 * write leaves no `.tmp.<pid>` orphan.
 *
 * Shared by {@link saveKeyFile} (the key file is always a secret) and the
 * config writer (a `psilink.yaml` may carry inline SFTP credentials), so both
 * get the same protection from one implementation rather than diverging.
 */
export function writeFileOwnerOnly(destPath: string, content: string): void {
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
      // ACL is now restricted; write the content into the already-protected file.
      fs.writeFileSync(tmp, content, "utf8");
    } else {
      // chmodSync corrects for a restrictive umask (e.g. 0277 -> 0400) that
      // would prevent the CLI from rewriting the file (e.g. the rotated token)
      // on a later run.
      fs.writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
    }
    fs.renameSync(tmp, destPath);
  } catch (err) {
    // Remove the temp file on any failure -- not just the icacls case -- so a
    // partial write never leaves a `.tmp.<pid>` orphan beside the destination.
    // A caller's own rollback cannot do this: it does not know the pid-qualified
    // temp name.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup before re-throwing */
    }
    throw err;
  }
}

/** Serialize and write a {@link KeyFile} to disk, owner-read-only. */
export function saveKeyFile(keyFilePath: string, data: KeyFile): void {
  // Belt-and-suspenders runtime validation: the type system already requires
  // `pakeToken` to be a string, and today's only caller (runProtocol) derives
  // it from HKDF and so always produces a valid base64url-encoded 32-byte
  // value. A future caller (e.g. `invite` / `accept`, not yet implemented)
  // could write a malformed token that loadKeyFile would later reject; fail
  // here instead so the malformed token never reaches disk.
  //
  // UsageError (not a plain Error) so the CLI catch sites classify it as a
  // caller/usage problem (exit 64) rather than a transport failure (exit 69) --
  // a malformed token supplied via invite/accept is bad input, and
  // provisionConfigAndKey makes this the reachable write path.
  if (!PAKE_TOKEN_REGEX.test(data.pakeToken))
    throw new UsageError(
      "saveKeyFile: pakeToken must be a base64url-encoded 32-byte value " +
        "(43 base64url characters; final character must be in " +
        "[AEIMQUYcgkosw048])",
    );
  writeFileOwnerOnly(keyFilePath, JSON.stringify(data, null, 2) + "\n");
}
