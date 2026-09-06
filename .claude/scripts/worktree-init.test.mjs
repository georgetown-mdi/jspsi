import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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
// staging and the branches past it, a primary clone with a real install, worktrees
// cut from that clone -- and runs the script itself against it. The packages are
// local tarballs packed by `npm pack`, so the suite needs no network and no
// registry. Nothing here touches this repository or its worktrees.

const SCRIPT = fileURLToPath(new URL("./worktree-init.sh", import.meta.url));
const DRIFT_CHECK = fileURLToPath(
  new URL("../../scripts/check-node-modules-drift.mjs", import.meta.url),
);
const SCRIPT_IN_TREE = ".claude/scripts/worktree-init.sh";
const REPO = fileURLToPath(new URL("../..", import.meta.url));

// The control the fixture below is measured against: a revision of
// worktree-init.sh whose run continues out of the bytes it started on after the
// base-ref re-point. It is a pinned commit rather than a branch name, so what the
// fixture distinguishes does not depend on where a branch tip stands.
const CONTROL_REV = "24bd6975cb7b970b8d4a4b5d16bbeca03349fb83";

let root;
let cache;
let vendor;
let seed;
let originRepo;
let primary;
let inPlaceResetGit;

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

const SHEBANG = "#!/usr/bin/env bash\n";
const TAIL_ANCHOR = '\nif [ ! -d "$PRIMARY/node_modules" ]; then\n';
const DONE_ANCHOR = '\necho "worktree-init: done.';

// A padding line is a fixed width so the two revisions' disagreement about where
// the tail sits is a known byte count, and that count is not a whole number of
// tail lines: a run that resumes at its old offset in the other revision's bytes
// therefore resumes mid-line, which is a shell error rather than a comment.
const headerPadding = (lines) =>
  `${Array.from(
    { length: lines },
    (_, index) =>
      `# header padding ${`${index}`.padStart(6, "0")} ${"-".repeat(40)}`,
  ).join("\n")}\n`;
const tailPadding = (lines) =>
  `${Array.from(
    { length: lines },
    (_, index) =>
      `# tail padding ${`${index}`.padStart(6, "0")} ${"-".repeat(48)}`,
  ).join("\n")}\n`;

/**
 * One revision's copy of the script: padded at the head so two revisions disagree
 * about where every later line sits, padded after the base-ref reconciliation so
 * bytes are still unread when the re-point lands, and holding a marker of its own
 * so the output names the revision that ran the tail.
 */
function revisionCopy(text, headerLines, marker) {
  for (const anchor of [SHEBANG, TAIL_ANCHOR, DONE_ANCHOR]) {
    if (text.split(anchor).length !== 2) {
      throw new Error(
        `worktree-init.sh no longer holds exactly one ${JSON.stringify(anchor)}, which this fixture pads around`,
      );
    }
  }
  return text
    .replace(SHEBANG, `${SHEBANG}${headerPadding(headerLines)}`)
    .replace(TAIL_ANCHOR, `\n${tailPadding(600)}${TAIL_ANCHOR.slice(1)}`)
    .replace(DONE_ANCHOR, `\necho "worktree-init: ${marker}"${DONE_ANCHOR}`);
}

/** The bytes of worktree-init.sh at a revision of this repository. */
function scriptAt(revision) {
  try {
    return execFileSync("git", ["show", `${revision}:${SCRIPT_IN_TREE}`], {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(
      `this suite drives ${SCRIPT_IN_TREE} as of ${revision}, and this clone cannot read it: ${error.stderr || error.message}`,
    );
  }
}

/**
 * Three revisions of one script text: the one a worktree is cut on, the base ref
 * it is re-pointed onto, and a base ref whose tree holds no script at all.
 */
function pushScriptRevisions(name, scriptText) {
  git(["checkout", "-q", "main"], seed);
  git(["checkout", "-q", "-b", name], seed);
  mkdirSync(join(seed, ".claude", "scripts"), { recursive: true });
  mkdirSync(join(seed, "scripts"), { recursive: true });
  copyFileSync(
    DRIFT_CHECK,
    join(seed, "scripts", "check-node-modules-drift.mjs"),
  );
  writeFileSync(
    join(seed, SCRIPT_IN_TREE),
    revisionCopy(scriptText, 200, `${name} started-on marker`),
  );
  commitAll(seed, `Add the fixture worktree-init.sh on ${name}`);
  git(["push", "-q", "origin", name], seed);

  git(["checkout", "-q", "-b", `${name}-base`], seed);
  writeFileSync(
    join(seed, SCRIPT_IN_TREE),
    revisionCopy(scriptText, 20, `${name} base-ref marker`),
  );
  // A drift check that refuses to verify sends the run down the `npm ci` route, so
  // the drive covers the longer of the two paths the script takes after a re-point.
  writeFileSync(
    join(seed, "scripts", "check-node-modules-drift.mjs"),
    "#!/usr/bin/env node\nprocess.exit(2);\n",
  );
  commitAll(seed, `Shorten the fixture worktree-init.sh on ${name}-base`);
  git(["push", "-q", "origin", `${name}-base`], seed);

  git(["checkout", "-q", "-b", `${name}-scriptless`], seed);
  rmSync(join(seed, SCRIPT_IN_TREE));
  commitAll(seed, `Hold no worktree-init.sh on ${name}-scriptless`);
  git(["push", "-q", "origin", `${name}-scriptless`], seed);
}

/**
 * A `git` whose `reset --hard` replaces the script's bytes without replacing the
 * file: the hard link holds the inode a running shell has open, and the
 * redirection truncates and refills that same inode. `git reset --hard` itself
 * unlinks and recreates, which leaves a running shell reading the file it opened.
 */
function writeInPlaceResetGit() {
  const dir = join(root, "in-place-reset-git");
  mkdirSync(dir, { recursive: true });
  const real = execFileSync("bash", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  const shim = join(dir, "git");
  writeFileSync(
    shim,
    [
      "#!/usr/bin/env bash",
      "set -uo pipefail",
      "is_reset=0",
      'for arg in "$@"; do [ "$arg" = "reset" ] && is_reset=1; done',
      'if [ "$is_reset" = 1 ] && [ -n "${IN_PLACE_RESET_TARGET:-}" ] && [ -f "${IN_PLACE_RESET_TARGET}" ]; then',
      '  keep="${IN_PLACE_RESET_TARGET}.inode"',
      '  ln "$IN_PLACE_RESET_TARGET" "$keep"',
      `  ${JSON.stringify(real)} "$@" || exit $?`,
      '  cat "$IN_PLACE_RESET_TARGET" > "$keep"',
      '  rm -f "$keep"',
      "  exit 0",
      "fi",
      `exec ${JSON.stringify(real)} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(shim, 0o755);
  return dir;
}

/** The script's own run: stderr folded into stdout, in the order it printed. */
function runInit(cwd, env = {}, script = SCRIPT) {
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
      output: execFileSync("bash", ["-c", `bash "${script}" 2>&1`], options),
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

  seed = join(root, "seed");
  mkdirSync(join(seed, "packages", "core"), { recursive: true });
  writeRootManifest(seed, "1.0.0");
  writeFileSync(
    join(seed, "packages", "core", "package.json"),
    JSON.stringify({
      name: "@fixture/core",
      version: "0.0.0",
      private: true,
      scripts: {
        // The build records which pass of the script reached it, which is the
        // only place the handover after a re-point shows from outside.
        build: `node -e "const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/built.txt',process.env.PSILINK_WORKTREE_INIT_REPOINTED?'built after the re-point':'built in the first pass')"`,
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

  pushScriptRevisions("swap", readFileSync(SCRIPT, "utf8"));
  pushScriptRevisions("control", scriptAt(CONTROL_REV));
  inPlaceResetGit = writeInPlaceResetGit();

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

describe("a re-point that replaces the script the shell is running", () => {
  const repoint = (tree, name, env = {}) =>
    runInit(
      tree,
      { PSILINK_WORKTREE_BASE_REF: `origin/${name}-base`, ...env },
      join(tree, SCRIPT_IN_TREE),
    );

  const inPlaceReset = (tree) => ({
    PATH: `${inPlaceResetGit}:${process.env.PATH}`,
    IN_PLACE_RESET_TARGET: join(tree, SCRIPT_IN_TREE),
  });

  const built = (tree) =>
    readFileSync(join(tree, "packages", "core", "dist", "built.txt"), "utf8");

  it("provisions the tree from the base ref's own copy of the script", () => {
    const tree = worktree("handover", "origin/swap");

    const { status, output } = repoint(tree, "swap");

    expect(status).toBe(0);
    expect(head(tree)).toBe(git(["rev-parse", "origin/swap-base"], primary));
    expect(output).toContain("swap base-ref marker");
    expect(output).not.toContain("swap started-on marker");
    expect(output).toContain("worktree-init: done");
    expect(built(tree)).toBe("built after the re-point");
  }, 180_000);

  it("provisions from the revision it started on without the handover", () => {
    const tree = worktree("no-handover", "origin/control");

    const { output } = repoint(tree, "control");

    expect(head(tree)).toBe(git(["rev-parse", "origin/control-base"], primary));
    expect(output).toContain("control started-on marker");
    expect(output).not.toContain("control base-ref marker");
    expect(built(tree)).toBe("built in the first pass");
  }, 180_000);

  it("provisions across a reset that rewrites the running file in place", () => {
    const tree = worktree("in-place", "origin/swap");

    const { status, output } = repoint(tree, "swap", inPlaceReset(tree));

    expect(status).toBe(0);
    expect(head(tree)).toBe(git(["rev-parse", "origin/swap-base"], primary));
    expect(output).toContain("swap base-ref marker");
    expect(output).not.toContain("swap started-on marker");
    expect(output).toContain("worktree-init: done");
    expect(built(tree)).toBe("built after the re-point");
  }, 180_000);

  it("breaks on that in-place rewrite without the handover", () => {
    const tree = worktree("in-place-control", "origin/control");

    const { status, output } = repoint(tree, "control", inPlaceReset(tree));

    expect(status).not.toBe(0);
    expect(output).not.toContain("worktree-init: done");
    expect(
      existsSync(join(tree, "packages", "core", "dist", "built.txt")),
    ).toBe(false);
  }, 180_000);

  it("re-points once and reconciles nothing on the second pass", () => {
    const tree = worktree("bounded", "origin/swap");

    const { status, output } = repoint(tree, "swap");

    expect(status).toBe(0);
    expect(output.match(/so re-pointing/g)).toHaveLength(1);
    expect(output.match(/fetching origin/g)).toHaveLength(1);
    expect(output).toContain("taking over after the re-point");
  }, 180_000);

  it("hands over nothing when the tree is already at the base ref", () => {
    const tree = worktree("already-based", "origin/swap-base");

    const { status, output } = repoint(tree, "swap");

    expect(status).toBe(0);
    expect(output).toContain("is at origin/swap-base");
    expect(output).not.toContain("taking over after the re-point");
    expect(output).toContain("swap base-ref marker");
    expect(built(tree)).toBe("built in the first pass");
  }, 180_000);

  it("stops with its own message when the base ref holds no script", () => {
    const tree = worktree("scriptless", "origin/swap");

    const { status, output } = runInit(
      tree,
      { PSILINK_WORKTREE_BASE_REF: "origin/swap-scriptless" },
      join(tree, SCRIPT_IN_TREE),
    );

    expect(status).toBe(1);
    expect(output).toContain("no script is left to provision this tree with");
    expect(output).not.toContain("error reading input file");
    expect(head(tree)).toBe(
      git(["rev-parse", "origin/swap-scriptless"], primary),
    );
    expect(existsSync(join(tree, SCRIPT_IN_TREE))).toBe(false);
  }, 180_000);
});
