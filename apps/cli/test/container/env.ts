import fs from "node:fs";
import fsp from "node:fs/promises";

// The SFTP container's host port can be overridden per checkout via
// test/container/.env (COMPOSE_PROJECT_NAME, SFTP_PORT) so multiple worktrees
// can run the container concurrently without colliding on the default 2222. The
// make-worktree command writes that file with a free port; the SFTP_PORT env
// var takes precedence when set (e.g. CI). Resolved relative to cwd, which is
// the cli package root when the integration tests run, matching the other
// relative paths in those tests.
const ENV_FILE = "test/container/.env";

export function sftpPort(): number {
  if (process.env.SFTP_PORT) return Number(process.env.SFTP_PORT);
  try {
    const match = fs
      .readFileSync(ENV_FILE, "utf8")
      .match(/^\s*SFTP_PORT\s*=\s*(\d+)/m);
    if (match) return Number(match[1]);
  } catch {
    // no per-checkout override file; fall through to the default
  }
  return 2222;
}

// Create a server-side working directory and make it world-writable (0o777).
//
// The SFTP container serves the host-bind-mounted srv/ tree as the SFTP users'
// home (uid 1000/1001 per users.conf). When the host creates a working
// subdirectory it is owned by the host/CI-runner uid at the default 0755, so a
// container user with a different uid cannot create, rename, or delete files in
// it -- e.g. usera (1000) on a Linux runner whose uid is 1001. Docker Desktop's
// permissive bind-mount ownership mapping hides this on macOS; a native Linux
// CI runner enforces it. 0777 lets any uid operate; the protocol only creates,
// reads, renames, and deletes whole files (never modifies another uid's file in
// place), so directory-level write permission is sufficient.
export async function ensureServerDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.chmod(dir, 0o777);
}
