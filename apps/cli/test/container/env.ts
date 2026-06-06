import fs from "node:fs";

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
