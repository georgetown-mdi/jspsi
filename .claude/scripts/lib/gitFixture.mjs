// Throwaway git repositories for the re-attestation verifiers' tests.
//
// The verifiers answer about real refs, so their tests drive real git through
// the same boundary the CLI uses rather than hand-writing its output. Each
// fixture builds its own repository under the system temp directory: CI checks
// out with no `fetch-depth`, and in the resulting shallow clone no historical
// sha of this repository resolves.
//
// `GIT_EDITOR` and `GIT_SEQUENCE_EDITOR` are pinned to `true` so a command that
// would open an editor -- `rebase --continue` above all -- returns instead of
// hanging the run.

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const NO_EDITOR = { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" };

/**
 * Fixture repositories sharing one cleanup list. A suite calls `cleanup` from
 * its own `afterEach`, which removes every directory the fixtures made.
 */
export function createGitFixtures() {
  const fixtureDirs = [];

  const makeTempDir = (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    fixtureDirs.push(dir);
    return dir;
  };

  /** Helpers over one working tree, whether a repository's own or linked to it. */
  const treeAt = (dir) => {
    const env = { ...process.env, ...NO_EDITOR };
    // stderr is piped rather than inherited, so a case that drives git to fail
    // on purpose reads the message off the error instead of printing it into
    // the suite's own output.
    const git = (args) =>
      execFileSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    return {
      dir,
      git,
      // For a command whose nonzero exit is the subject -- a conflicting merge
      // or rebase -- where `git` would throw before the test could read it.
      run: (args) =>
        spawnSync("git", args, { cwd: dir, encoding: "utf8", env }),
      write: (path, text) => {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
      },
      remove: (path) => rmSync(join(dir, path)),
      chmod: (path, mode) => chmodSync(join(dir, path), mode),
      commit: (message) => {
        git(["add", "-A"]);
        git(["commit", "-q", "-m", message]);
        return git(["rev-parse", "HEAD"]).trim();
      },
      head: () => git(["rev-parse", "HEAD"]).trim(),
    };
  };

  /** A repository holding one commit-free tree, with an identity to commit under. */
  const makeFixture = (prefix = "git-fixture-") => {
    const tree = treeAt(makeTempDir(prefix));
    tree.git(["init", "-q", "-b", "main"]);
    tree.git(["config", "user.email", "verifier-test@example.invalid"]);
    tree.git(["config", "user.name", "Verifier Test"]);
    return {
      ...tree,
      // A linked worktree shares the repository's object database and its
      // config, the identity set above included, while keeping its own HEAD.
      // Both that inheritance and `worktree add` accepting the existing empty
      // directory `mkdtemp` just made were measured against real git rather
      // than assumed.
      addWorktree: (branch) => {
        const linked = treeAt(makeTempDir(`${prefix}linked-`));
        tree.git(["worktree", "add", "-q", "-b", branch, linked.dir]);
        return linked;
      },
    };
  };

  const cleanup = () => {
    while (fixtureDirs.length > 0) {
      rmSync(fixtureDirs.pop(), { recursive: true, force: true });
    }
  };

  return { makeTempDir, makeFixture, cleanup };
}
