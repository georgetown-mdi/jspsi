import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkTree,
  driftFrom,
  formatDrift,
  lockfileInstallPaths,
  parseNpmSummary,
  runNpmDryRun,
  staleFileDependencies,
  treeRelativePath,
} from "./check-node-modules-drift.mjs";

// The half of this file that matters drives the real npm. Every claim the check
// rests on is a claim about what npm does with a tree of symlinks -- which entries
// it reports as added when it cannot see into one, what its `--json` summary looks
// like, whether a dry run writes anything -- and CLAUDE.md settles a question about
// an external tool by driving the tool, never by modeling it. So the fixtures below
// are real installs: local tarballs packed by `npm pack`, installed by `npm install`
// into a temp tree with its own cache, entirely offline and needing no registry.
//
// The mirror helper reproduces worktree-init.sh's shape (each entry of the source
// tree's node_modules shared by absolute symlink) rather than calling it: that
// script mirrors a git worktree, and what is under test here is the check's reading
// of npm's verdict over a mirror, not the mirroring itself.

const CLI = fileURLToPath(
  new URL("./check-node-modules-drift.mjs", import.meta.url),
);

let root;
let cache;
let vendor;
let drifted;

const npm = (args, cwd) =>
  execFileSync(
    "npm",
    [...args, "--offline", "--no-audit", "--no-fund", "--cache", cache],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

const tarball = (name, version) =>
  `file:${join(vendor, `${name}-${version}.tgz`)}`;

function pack(name, version, dependencies = {}) {
  const dir = join(root, "packed", `${name}-${version}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version, main: "index.js", dependencies }),
  );
  writeFileSync(
    join(dir, "index.js"),
    `module.exports = "${name}@${version}";`,
  );
  npm(["pack", "--pack-destination", vendor], dir);
}

function writeManifest(dir, dependencies) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "drift-fixture", version: "0.0.0", dependencies }),
  );
}

/** A tree sharing `source`'s installed packages by absolute symlink. */
function mirror(source, target) {
  mkdirSync(join(target, "node_modules"), { recursive: true });
  for (const file of ["package.json", "package-lock.json"]) {
    cpSync(join(source, file), join(target, file));
  }
  for (const entry of readdirSync(join(source, "node_modules"))) {
    symlinkSync(
      join(source, "node_modules", entry),
      join(target, "node_modules", entry),
    );
  }
  return target;
}

/** Content hash of a tree: every file's bytes and every symlink's target. */
function fingerprint(dir) {
  const parts = [];
  const walk = (current, relative) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const child = join(current, entry.name);
      const path = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink())
        parts.push(`${path} -> ${readlinkSync(child)}`);
      else if (entry.isDirectory()) walk(child, path);
      else {
        const hash = createHash("sha256")
          .update(readFileSync(child))
          .digest("hex");
        parts.push(`${path} ${hash}`);
      }
    }
  };
  walk(dir, "");
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

function runCli(...args) {
  const options = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
  try {
    return { status: 0, output: execFileSync("node", [CLI, ...args], options) };
  } catch (error) {
    return { status: error.status, output: `${error.stdout}${error.stderr}` };
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "node-modules-drift-"));
  cache = join(root, "npm-cache");
  vendor = join(root, "vendor");
  mkdirSync(vendor, { recursive: true });

  pack("leaf", "1.0.0");
  pack("leaf", "2.0.0");
  pack("has-nested", "1.0.0", { leaf: tarball("leaf", "1.0.0") });
  pack("stays-put", "1.0.0");
  pack("moves-on", "1.0.0");
  pack("moves-on", "2.0.0");
  pack("goes-away", "1.0.0");

  // The installed state: leaf@2 hoisted to the top, leaf@1 nested under
  // has-nested, which is what gives the mirror a package npm cannot see into.
  drifted = join(root, "drifted");
  writeManifest(drifted, {
    "has-nested": tarball("has-nested", "1.0.0"),
    leaf: tarball("leaf", "2.0.0"),
    "stays-put": tarball("stays-put", "1.0.0"),
    "moves-on": tarball("moves-on", "1.0.0"),
    "goes-away": tarball("goes-away", "1.0.0"),
  });
  npm(["install"], drifted);

  // The lockfile then moves ahead of that install, exactly as a dependency bump
  // landing on a branch moves ahead of a clone nobody has re-installed.
  writeManifest(drifted, {
    "has-nested": tarball("has-nested", "1.0.0"),
    leaf: tarball("leaf", "2.0.0"),
    "stays-put": tarball("stays-put", "1.0.0"),
    "moves-on": tarball("moves-on", "2.0.0"),
  });
  npm(["install", "--package-lock-only"], drifted);
}, 120_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("npm summary parsing", () => {
  const summary = { add: [], change: [], remove: [], added: 0 };
  const stdout = [
    "change prettier 3.8.4 => 3.9.6",
    "add estree-walker 3.0.3",
    JSON.stringify(summary, null, 2),
    "",
  ].join("\n");

  it("skips the human-readable lines npm prints ahead of the summary", () => {
    expect(parseNpmSummary(stdout)).toEqual(summary);
  });

  it("throws rather than passing when npm printed no summary", () => {
    expect(() => parseNpmSummary("change prettier 3.8.4 => 3.9.6\n")).toThrow(
      /no --json install summary/,
    );
  });
});

describe("install paths npm reports", () => {
  const lock = {
    packages: {
      "": { name: "root" },
      "node_modules/leaf": { version: "2.0.0" },
      "node_modules/has-nested": { version: "1.0.0" },
      "node_modules/has-nested/node_modules/leaf": { version: "1.0.0" },
      "apps/web/node_modules/leaf": { version: "3.0.0" },
    },
  };
  const paths = lockfileInstallPaths(lock);

  it("keeps only entries under a node_modules, longest first", () => {
    expect(paths[0]).toBe("node_modules/has-nested/node_modules/leaf");
    expect(paths).not.toContain("");
  });

  it("maps a reported path back through the longest lockfile key", () => {
    expect(
      treeRelativePath("/tmp/tree/apps/web/node_modules/leaf", paths),
    ).toBe("apps/web/node_modules/leaf");
    expect(
      treeRelativePath(
        "/tmp/tree/node_modules/has-nested/node_modules/leaf",
        paths,
      ),
    ).toBe("node_modules/has-nested/node_modules/leaf");
  });

  it("survives a masked prefix, which is why the key match is by suffix", () => {
    expect(treeRelativePath("/tmp/***/tree/node_modules/leaf", paths)).toBe(
      "node_modules/leaf",
    );
  });

  it("claims nothing for a path no lockfile entry covers", () => {
    expect(
      treeRelativePath("/tmp/tree/node_modules/stranger", paths),
    ).toBeNull();
  });
});

describe("classifying npm's verdict", () => {
  const lockPaths = ["node_modules/pkg"];
  const change = (from, to) => ({
    from: { name: "pkg", version: from, path: "/t/node_modules/pkg" },
    to: { name: "pkg", version: to, path: "/t/node_modules/pkg" },
  });
  const classify = (summary, installed) =>
    driftFrom(summary, { lockPaths, versionAt: () => installed });

  it("fails a change whose versions differ", () => {
    expect(
      classify({ change: [change("3.8.4", "3.9.6")] }, null).wrongVersion,
    ).toEqual([{ name: "pkg", installed: "3.8.4", locked: "3.9.6" }]);
  });

  it("ignores a change that only replaces a link with a directory", () => {
    const drift = classify({ change: [change("3.9.6", "3.9.6")] }, null);
    expect(drift.wrongVersion).toEqual([]);
    expect(drift.missing).toEqual([]);
  });

  it("ignores an add whose install path already holds that version", () => {
    const add = [
      { name: "pkg", version: "1.0.0", path: "/t/node_modules/pkg" },
    ];
    expect(classify({ add }, "1.0.0")).toEqual({
      wrongVersion: [],
      missing: [],
      extra: [],
    });
  });

  it("fails an add whose install path holds nothing", () => {
    const add = [
      { name: "pkg", version: "1.0.0", path: "/t/node_modules/pkg" },
    ];
    expect(classify({ add }, null).missing).toEqual([
      { name: "pkg", locked: "1.0.0" },
    ]);
  });

  it("fails an add whose install path holds another version", () => {
    const add = [
      { name: "pkg", version: "1.0.0", path: "/t/node_modules/pkg" },
    ];
    expect(classify({ add }, "0.9.0").wrongVersion).toEqual([
      { name: "pkg", installed: "0.9.0", locked: "1.0.0" },
    ]);
  });

  it("reports a removal without failing it", () => {
    const drift = classify(
      { remove: [{ name: "pkg", version: "1.0.0" }] },
      null,
    );
    expect(drift.extra).toEqual([{ name: "pkg", version: "1.0.0" }]);
    expect(drift.wrongVersion).toEqual([]);
    expect(drift.missing).toEqual([]);
  });

  it("throws on a summary entry it does not recognize", () => {
    expect(() => classify({ change: [{ from: {}, to: {} }] }, null)).toThrow(
      /unrecognized change/,
    );
    expect(() => classify({ add: [{ name: "pkg" }] }, null)).toThrow(
      /unrecognized add/,
    );
  });

  it("throws when no lockfile entry claims a reported path", () => {
    const add = [{ name: "x", version: "1.0.0", path: "/t/node_modules/x" }];
    expect(() => classify({ add }, "1.0.0")).toThrow(
      /no package-lock.json entry/,
    );
  });
});

describe("staleFileDependencies", () => {
  const fileEntry = (version, integrity) => ({
    resolved: "file:lib/vendored.tgz",
    integrity,
    version,
  });

  function writeInstalledLock(dir, packages) {
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules", ".package-lock.json"),
      JSON.stringify({ packages }),
    );
  }

  let dir;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "stale-file-deps-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does nothing when the lockfile has no file: tarball entry", () => {
    const lock = { packages: { "node_modules/pkg": { version: "1.0.0" } } };
    expect(staleFileDependencies(dir, lock)).toEqual([]);
  });

  it("ignores a workspace's own local file: link, which carries no integrity", () => {
    const lock = {
      packages: {
        "node_modules/@psilink/core": { resolved: "packages/core", link: true },
      },
    };
    expect(staleFileDependencies(dir, lock)).toEqual([]);
  });

  it("passes when the installed record's integrity matches the lockfile's", () => {
    writeInstalledLock(dir, {
      "node_modules/vendored": fileEntry("1.0.0", "sha512-same"),
    });
    const lock = {
      packages: { "node_modules/vendored": fileEntry("1.0.0", "sha512-same") },
    };
    expect(staleFileDependencies(dir, lock)).toEqual([]);
  });

  it("flags a same-version entry whose installed integrity differs", () => {
    writeInstalledLock(dir, {
      "node_modules/vendored": fileEntry("1.0.0", "sha512-old"),
    });
    const lock = {
      packages: { "node_modules/vendored": fileEntry("1.0.0", "sha512-new") },
    };
    expect(staleFileDependencies(dir, lock)).toEqual([
      { name: "vendored", version: "1.0.0" },
    ]);
  });

  it("leaves a version bump to driftFrom's own wrongVersion class", () => {
    writeInstalledLock(dir, {
      "node_modules/vendored": fileEntry("1.0.0", "sha512-old"),
    });
    const lock = {
      packages: { "node_modules/vendored": fileEntry("2.0.0", "sha512-new") },
    };
    expect(staleFileDependencies(dir, lock)).toEqual([]);
  });

  it("leaves an entry absent from the installed record to driftFrom's missing/add handling", () => {
    writeInstalledLock(dir, { "node_modules/other": fileEntry("1.0.0", "x") });
    const lock = {
      packages: { "node_modules/vendored": fileEntry("1.0.0", "sha512-new") },
    };
    expect(staleFileDependencies(dir, lock)).toEqual([]);
  });

  it("throws rather than passing when a file: entry exists but the installed record cannot be read", () => {
    const empty = mkdtempSync(join(tmpdir(), "stale-file-deps-unreadable-"));
    const lock = {
      packages: { "node_modules/vendored": fileEntry("1.0.0", "sha512-new") },
    };
    expect(() => staleFileDependencies(empty, lock)).toThrow(
      /\.package-lock\.json could not be read/,
    );
    rmSync(empty, { recursive: true, force: true });
  });
});

describe("the drift report", () => {
  const drift = {
    wrongVersion: Array.from({ length: 20 }, (_, index) => ({
      name: `pkg-${String(index).padStart(2, "0")}`,
      installed: "1.0.0",
      locked: "2.0.0",
    })),
    missing: [{ name: "absent", locked: "1.2.3" }],
    extra: [{ name: "leftover", version: "1.0.0" }],
  };

  it("caps the list and counts every class", () => {
    const report = formatDrift("/tree", drift).join("\n");
    expect(report).toContain("... and 9 more (--all lists them)");
    expect(report).toContain(
      "20 wrong versions, 1 missing package, plus 1 package on disk the lockfile does not list.",
    );
    expect(report).toContain("absent");
  });

  it("lists every drifted package when the cap is lifted", () => {
    const report = formatDrift("/tree", drift, null, Infinity).join("\n");
    expect(report).not.toContain("more (--all lists them)");
    for (const item of [...drift.wrongVersion, ...drift.missing]) {
      expect(report).toContain(item.name);
    }
  });

  it("names both remedies when the packages are shared", () => {
    const report = formatDrift("/tree", drift, "/primary").join("\n");
    expect(report).toContain("npm install` in /primary");
    expect(report).toContain("npm ci` in /tree");
    expect(report).toContain("does not write into /primary");
  });
});

describe("driving npm against a real tree", () => {
  it("finds no drift once the tree is installed from its own lockfile", () => {
    const clean = join(root, "clean");
    cpSync(drifted, clean, { recursive: true, verbatimSymlinks: true });
    npm(["install"], clean);

    expect(checkTree(clean)).toEqual({
      wrongVersion: [],
      missing: [],
      extra: [],
      staleFile: [],
    });
    const { status, output } = runCli(clean);
    expect(status).toBe(0);
    expect(output).toContain("agrees with package-lock.json");
  }, 120_000);

  it("names the package, both versions, and the remedy when the lockfile moved ahead", () => {
    const drift = checkTree(drifted);
    expect(drift.wrongVersion).toEqual([
      { name: "moves-on", installed: "1.0.0", locked: "2.0.0" },
    ]);
    expect(drift.missing).toEqual([]);
    expect(drift.extra).toEqual([{ name: "goes-away", version: "1.0.0" }]);

    const { status, output } = runCli(drifted, "--shared-from", "/primary");
    expect(status).toBe(1);
    expect(output).toContain("moves-on");
    expect(output).toContain("1.0.0 installed, lockfile pins 2.0.0");
    expect(output).toContain("npm install` in /primary");
  }, 120_000);

  it("reads the same verdict through a symlink mirror of that tree", () => {
    const shared = mirror(drifted, join(root, "shared"));
    const summary = parseNpmSummary(runNpmDryRun(shared));

    // npm cannot see into a linked package, so it reports the dep nested under
    // has-nested as an addition, and every shared package as a change to itself.
    expect(summary.add.map((entry) => entry.name)).toContain("leaf");
    expect(
      summary.change.filter((entry) => entry.from.version === entry.to.version),
    ).not.toEqual([]);

    // Neither is drift: only the version npm would replace is.
    expect(checkTree(shared)).toEqual({
      wrongVersion: [{ name: "moves-on", installed: "1.0.0", locked: "2.0.0" }],
      missing: [],
      extra: [{ name: "goes-away", version: "1.0.0" }],
      staleFile: [],
    });
  }, 120_000);

  it("writes nothing -- not the tree it checks, not the tree it shares from", () => {
    const shared = mirror(drifted, join(root, "read-only"));
    const before = [fingerprint(shared), fingerprint(drifted)];

    runCli(shared);

    expect([fingerprint(shared), fingerprint(drifted)]).toEqual(before);
  }, 120_000);

  it("reads the same verdict when npm masks the tree's path", () => {
    // npm rewrites uuid-shaped path segments in everything it prints, so an
    // install path in its summary can name a directory that cannot be opened --
    // and a tree under a temp directory named for a session id is exactly that.
    // Probed as reported, every add entry reads as a missing package.
    const masked = mirror(
      drifted,
      join(root, "11111111-2222-3333-4444-555555555555", "tree"),
    );
    const summary = parseNpmSummary(runNpmDryRun(masked));

    expect(summary.add).not.toEqual([]);
    expect(summary.add.every((entry) => existsSync(entry.path))).toBe(false);
    expect(checkTree(masked)).toEqual({
      wrongVersion: [{ name: "moves-on", installed: "1.0.0", locked: "2.0.0" }],
      missing: [],
      extra: [{ name: "goes-away", version: "1.0.0" }],
      staleFile: [],
    });
  }, 120_000);

  it("clears the drift by the remedy the report names, leaving the shared tree alone", () => {
    const shared = mirror(drifted, join(root, "remedied"));
    const before = fingerprint(drifted);

    npm(["install"], shared);

    expect(checkTree(shared)).toEqual({
      wrongVersion: [],
      missing: [],
      extra: [],
      staleFile: [],
    });
    expect(fingerprint(drifted)).toBe(before);
  }, 120_000);
});

describe("driving npm against a re-vendored file: tarball", () => {
  // The scenario driftFrom's version-keyed diff cannot see: a tarball whose
  // bytes change without its version changing, exactly what a re-vendored
  // @openmined/psi.js does. Reproduced with real installs per the module header's
  // measurement, rather than modeled: pack the same name and version twice with
  // different contents, install each separately, then mirror the second
  // install's lockfile over the first install's node_modules.
  let oldInstall;
  let newInstall;
  let mirrorTree;

  beforeAll(() => {
    pack("stalefile", "1.0.0");
    oldInstall = join(root, "stalefile-old");
    writeManifest(oldInstall, { stalefile: tarball("stalefile", "1.0.0") });
    npm(["install"], oldInstall);

    // Re-vendor: same name and version, different bytes.
    const packedDir = join(root, "packed", "stalefile-1.0.0");
    writeFileSync(
      join(packedDir, "index.js"),
      'module.exports = "stalefile@1.0.0, re-vendored";',
    );
    rmSync(join(vendor, "stalefile-1.0.0.tgz"));
    npm(["pack", "--pack-destination", vendor], packedDir);

    newInstall = join(root, "stalefile-new");
    writeManifest(newInstall, { stalefile: tarball("stalefile", "1.0.0") });
    npm(["install"], newInstall);

    // worktree-init.sh's shape when a primary has not reinstalled since the
    // tarball changed: the re-vendored lockfile over the old install's
    // node_modules.
    mirrorTree = join(root, "stalefile-mirror");
    mkdirSync(join(mirrorTree, "node_modules"), { recursive: true });
    cpSync(join(newInstall, "package.json"), join(mirrorTree, "package.json"));
    cpSync(
      join(newInstall, "package-lock.json"),
      join(mirrorTree, "package-lock.json"),
    );
    for (const entry of readdirSync(join(oldInstall, "node_modules"))) {
      symlinkSync(
        join(oldInstall, "node_modules", entry),
        join(mirrorTree, "node_modules", entry),
      );
    }
  }, 120_000);

  it("records the same version but different integrity for the two installs", () => {
    const packages = (dir) =>
      JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")).packages;
    const old = packages(oldInstall)["node_modules/stalefile"];
    const updated = packages(newInstall)["node_modules/stalefile"];
    expect(old.version).toBe(updated.version);
    expect(old.integrity).not.toBe(updated.integrity);
  });

  it("flags the stale content though the version is unchanged, and nothing else", () => {
    expect(checkTree(mirrorTree)).toEqual({
      wrongVersion: [],
      missing: [],
      extra: [],
      staleFile: [{ name: "stalefile", version: "1.0.0" }],
    });
  });

  it("fails the CLI and names the package", () => {
    const { status, output } = runCli(mirrorTree, "--shared-from", "/primary");
    expect(status).toBe(1);
    expect(output).toContain(
      "stalefile  installed content does not match the lockfile's integrity (version 1.0.0 unchanged)",
    );
    expect(output).toContain("1 stale file dependency");
    expect(output).toContain("npm install` in /primary");
  });

  it("clears once the tree is installed for real", () => {
    const fixed = join(root, "stalefile-fixed");
    cpSync(mirrorTree, fixed, { recursive: true, verbatimSymlinks: true });
    npm(["install"], fixed);

    expect(checkTree(fixed)).toEqual({
      wrongVersion: [],
      missing: [],
      extra: [],
      staleFile: [],
    });
    expect(
      readFileSync(
        join(fixed, "node_modules", "stalefile", "index.js"),
        "utf8",
      ),
    ).toContain("re-vendored");
  }, 120_000);
});
