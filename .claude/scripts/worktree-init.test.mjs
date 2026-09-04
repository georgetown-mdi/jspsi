import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// worktree-init.sh decides what it does from what git and npm report, and CLAUDE.md
// determines a question about an external tool by driving the tool. So each case here
// builds a real repository in a temp directory -- a bare origin holding main,
// staging and two branches past it, a primary clone with a real install, worktrees
// cut from that clone -- and runs the script itself against it. The packages are
// local tarballs packed by `npm pack`, so the suite needs no network and no
// registry. Nothing here touches this repository or its worktrees.

const SCRIPT = fileURLToPath(new URL("./worktree-init.sh", import.meta.url));

let root;
let cache;
let vendor;
let originRepo;
let primary;

const npm = (args, cwd) =>
  execFileSync(
    "npm",
    [...args, "--offline", "--no-audit", "--no-fund", "--cache", cache],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

const git = (args, cwd) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const tarball = (version) => `file:${join(vendor, `widget-${version}.tgz`)}`;

const head = (dir) => git(["rev-parse", "HEAD"], dir);

const readLock = (dir) => readFileSync(join(dir, "package-lock.json"), "utf8");

function pack(version) {
  const dir = join(root, "packed", version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "widget", version, main: "index.js" }),
  );
  writeFileSync(join(dir, "index.js"), `module.exports = "widget@${version}";`);
  npm(["pack", "--pack-destination", vendor], dir);
}

function writeRootManifest(dir, version) {
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "worktree-init-fixture",
        version: "0.0.0",
        private: true,
        workspaces: ["packages/*"],
        dependencies: { widget: tarball(version) },
      },
      null,
      2,
    )}\n`,
  );
}

function commitAll(dir, message) {
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", message], dir);
}

/** A worktree of the primary clone, checked out on `start` as a new branch. */
function worktree(name, start) {
  const path = join(root, "trees", name);
  git(["worktree", "add", "-b", `wt-${name}`, path, start], primary);
  return path;
}

/** The script's own run: stderr folded into stdout, in the order it printed. */
function runInit(cwd, env = {}) {
  const options = {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      npm_config_cache: cache,
      npm_config_offline: "true",
      ...env,
    },
  };
  try {
    return {
      status: 0,
      output: execFileSync("bash", ["-c", `bash "${SCRIPT}" 2>&1`], options),
    };
  } catch (error) {
    return { status: error.status, output: `${error.stdout}${error.stderr}` };
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "worktree-init-"));
  cache = join(root, "npm-cache");
  vendor = join(root, "vendor");
  mkdirSync(vendor, { recursive: true });
  pack("1.0.0");
  pack("2.0.0");

  const seed = join(root, "seed");
  mkdirSync(join(seed, "packages", "core"), { recursive: true });
  writeRootManifest(seed, "1.0.0");
  writeFileSync(
    join(seed, "packages", "core", "package.json"),
    JSON.stringify({
      name: "@fixture/core",
      version: "0.0.0",
      private: true,
      scripts: {
        build:
          "node -e \"const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/built.txt','built')\"",
      },
    }),
  );
  writeFileSync(join(seed, ".gitignore"), "node_modules\ndist\n");
  writeFileSync(join(seed, "README.md"), "fixture\n");
  npm(["install"], seed);

  git(["init", "-q", "-b", "main"], seed);
  git(["config", "user.email", "worktree-init-test@example.invalid"], seed);
  git(["config", "user.name", "Worktree Init Test"], seed);
  commitAll(seed, "Seed the fixture repository");

  originRepo = join(root, "origin.git");
  git(["init", "--bare", "-q", "-b", "main", originRepo], root);
  git(["remote", "add", "origin", originRepo], seed);
  git(["push", "-q", "origin", "main"], seed);

  // staging moves ahead of main, as it is in the real repository.
  git(["checkout", "-q", "-b", "staging"], seed);
  for (const step of [1, 2, 3]) {
    writeFileSync(join(seed, `note-${step}.txt`), `staging step ${step}\n`);
    commitAll(seed, `Add staging step ${step}`);
  }
  git(["push", "-q", "origin", "staging"], seed);

  // A branch past staging whose lockfile has moved ahead of the primary's install,
  // which is the ordinary state of any branch cut before the last dependency bump.
  git(["checkout", "-q", "-b", "bumped"], seed);
  writeRootManifest(seed, "2.0.0");
  npm(["install", "--package-lock-only"], seed);
  commitAll(seed, "Bump widget to 2.0.0");
  git(["push", "-q", "origin", "bumped"], seed);

  // The same, pinned to a version no registry (or vendor directory) can serve.
  git(["checkout", "-q", "-b", "unservable"], seed);
  for (const file of ["package.json", "package-lock.json"]) {
    const path = join(seed, file);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replaceAll(
        "widget-2.0.0.tgz",
        "widget-9.9.9.tgz",
      ),
    );
  }
  commitAll(seed, "Pin widget to a version that cannot be fetched");
  git(["push", "-q", "origin", "unservable"], seed);

  primary = join(root, "primary");
  git(["clone", "-q", originRepo, primary], root);
  git(["config", "user.email", "worktree-init-test@example.invalid"], primary);
  git(["config", "user.name", "Worktree Init Test"], primary);
  git(["checkout", "-q", "staging"], primary);
  npm(["install"], primary);
}, 180_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("the base a worktree starts on", () => {
  it("re-points a tree that holds nothing of its own onto the base ref", () => {
    const tree = worktree("pristine", "origin/main");
    const staging = git(["rev-parse", "origin/staging"], primary);

    const { status, output } = runInit(tree);

    expect(status).toBe(0);
    expect(output).toContain("re-pointing");
    expect(output).toContain("PSILINK_WORKTREE_BASE_REF");
    expect(output).toContain("agrees with package-lock.json");
    expect(head(tree)).toBe(staging);
    expect(
      existsSync(join(tree, "packages", "core", "dist", "built.txt")),
    ).toBe(true);
  }, 180_000);

  it("leaves a tree already on the base ref where it is", () => {
    const tree = worktree("on-base", "origin/staging");
    const before = head(tree);

    const { status, output } = runInit(tree);

    expect(status).toBe(0);
    expect(output).toContain("is at origin/staging");
    expect(head(tree)).toBe(before);
  }, 180_000);

  it("names the stale base of a tree holding a commit, and moves nothing", () => {
    const tree = worktree("committed", "origin/main");
    writeFileSync(join(tree, "work.txt"), "in flight\n");
    commitAll(tree, "Work in flight");
    const before = head(tree);

    const { status, output } = runInit(tree);

    expect(status).toBe(0);
    expect(output).toContain("NOT re-pointing");
    expect(output).toContain("Work in flight");
    expect(output).toContain("git rebase --onto origin/staging");
    expect(output).toContain("PSILINK_WORKTREE_BASE_REF");
    expect(head(tree)).toBe(before);
    expect(readFileSync(join(tree, "work.txt"), "utf8")).toBe("in flight\n");
    expect(
      existsSync(join(tree, "packages", "core", "dist", "built.txt")),
    ).toBe(true);
  }, 180_000);

  it("keeps the uncommitted files of a tree it declines to move", () => {
    const tree = worktree("dirty", "origin/main");
    writeFileSync(join(tree, "scratch.txt"), "unsaved\n");
    writeFileSync(join(tree, "README.md"), "edited\n");
    const before = head(tree);

    const { status, output } = runInit(tree);

    expect(status).toBe(0);
    expect(output).toContain("NOT re-pointing");
    expect(output).toContain("?? scratch.txt");
    expect(output).toContain("M README.md");
    expect(output).toContain("git stash --include-untracked");
    expect(head(tree)).toBe(before);
    expect(readFileSync(join(tree, "scratch.txt"), "utf8")).toBe("unsaved\n");
    expect(readFileSync(join(tree, "README.md"), "utf8")).toBe("edited\n");
  }, 180_000);

  it("stops when the base ref names no commit in the clone", () => {
    const tree = worktree("unknown-base", "origin/staging");

    const { status, output } = runInit(tree, {
      PSILINK_WORKTREE_BASE_REF: "origin/no-such-branch",
    });

    expect(status).toBe(1);
    expect(output).toContain("names no commit in this clone");
    expect(existsSync(join(tree, "node_modules"))).toBe(false);
  }, 180_000);

  it("provisions a deliberate other base when the override names it", () => {
    const tree = worktree("override", "origin/main");
    writeFileSync(join(tree, "work.txt"), "deliberate\n");
    commitAll(tree, "Work on a deliberate base");
    const before = head(tree);

    const { status, output } = runInit(tree, {
      PSILINK_WORKTREE_BASE_REF: "HEAD",
    });

    expect(status).toBe(0);
    expect(output).not.toContain("NOT re-pointing");
    expect(head(tree)).toBe(before);
    expect(
      existsSync(join(tree, "packages", "core", "dist", "built.txt")),
    ).toBe(true);
  }, 180_000);
});

describe("installing a branch whose lockfile the primary's install does not match", () => {
  it("installs the lockfile's own pins and leaves the lockfile untouched", () => {
    const tree = worktree("bumped", "origin/bumped");
    const before = readLock(tree);

    const { status, output } = runInit(tree);

    expect(status).toBe(0);
    expect(output).toContain("does not match its package-lock.json");
    expect(output).toContain("with 'npm ci'");
    expect(output).toContain("npm ci done");
    expect(readLock(tree)).toBe(before);
    expect(git(["status", "--porcelain"], tree)).toBe("");

    const widget = join(tree, "node_modules", "widget");
    expect(lstatSync(widget).isSymbolicLink()).toBe(false);
    expect(
      JSON.parse(readFileSync(join(widget, "package.json"), "utf8")).version,
    ).toBe("2.0.0");
  }, 180_000);

  it("names the failure when a pin cannot be fetched, rather than floating off it", () => {
    const tree = worktree("unservable", "origin/unservable");
    const before = readLock(tree);

    const { status, output } = runInit(tree);

    expect(status).toBe(1);
    expect(output).toContain("'npm ci' failed");
    expect(output).toContain("mirror lag");
    expect(output).toContain("Do NOT reach for 'npm install'");
    expect(readLock(tree)).toBe(before);
    expect(git(["status", "--porcelain"], tree)).toBe("");
  }, 180_000);

  it("restores the lockfile and stops when the install rewrites it", () => {
    // npm ci does not write package-lock.json, which is the whole reason it is the
    // fallback -- so the refusal is driven by an npm on PATH that does write it.
    const stub = join(root, "stub-npm");
    mkdirSync(stub, { recursive: true });
    writeFileSync(
      join(stub, "npm"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "ci" ]; then',
        '  printf "\\n" >> package-lock.json',
        "  exit 0",
        "fi",
        'echo "stub npm: only ci is implemented" >&2',
        "exit 3",
        "",
      ].join("\n"),
    );
    chmodSync(join(stub, "npm"), 0o755);

    const tree = worktree("rewritten", "origin/staging");
    const before = readLock(tree);

    const { status, output } = runInit(tree, {
      PATH: `${stub}:${process.env.PATH}`,
    });

    expect(status).toBe(1);
    expect(output).toContain("rewrote package-lock.json");
    expect(readLock(tree)).toBe(before);
    expect(git(["status", "--porcelain"], tree)).toBe("");
  }, 180_000);
});
