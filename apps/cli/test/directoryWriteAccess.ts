import { execFileSync } from "node:child_process";
import fs from "node:fs";

function currentUser(): string {
  return execFileSync("whoami", [], { encoding: "utf8" }).trim();
}

/**
 * Take the current user's ability to create a file in `directory` away, by
 * whichever means the platform implements: the POSIX mode bits off Windows,
 * and a deny entry for the current user on it, since Windows applies a numeric
 * `chmod` to a directory as a no-op and leaves it writable.
 *
 * Deny entries precede allow entries in a canonical access list, so the entry
 * holds even for a user who is also an administrator.
 *
 * @internal test-only helper
 */
export function denyDirectoryWrites(directory: string): void {
  if (process.platform !== "win32") {
    fs.chmodSync(directory, 0o555);
    return;
  }
  execFileSync("icacls", [directory, "/deny", `${currentUser()}:(W)`], {
    stdio: "ignore",
  });
}

/**
 * Undo {@link denyDirectoryWrites}, so the directory can be removed with the
 * rest of a test's temporary tree.
 *
 * @internal test-only helper
 */
export function restoreDirectoryWrites(directory: string): void {
  if (process.platform !== "win32") {
    fs.chmodSync(directory, 0o755);
    return;
  }
  execFileSync("icacls", [directory, "/remove:d", currentUser()], {
    stdio: "ignore",
  });
}
