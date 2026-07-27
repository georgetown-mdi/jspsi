import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Structural invariants of the production Dockerfile that keep the shipped
// image's dependency tree frozen to the committed package-lock.json, and keep
// the runtime layout the CLI's resolution depends on. Each test names the
// runtime claim it stands in for; docs/spec/DEPENDENCY_PINS.md holds the
// rationale.

const here = dirname(fileURLToPath(import.meta.url));
const dockerfile = readFileSync(resolve(here, "..", "Dockerfile"), "utf8");

// Fold "\"-continued lines into one logical instruction, then drop blanks and
// comments.
const instructions = dockerfile
  .replace(/\\\r?\n/g, " ")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"))
  .map((line) => {
    const [, inst, rest] = line.match(/^(\S+)\s*(.*)$/);
    return { inst: inst.toUpperCase(), rest };
  });

const lastFromIndex = instructions.reduce(
  (last, { inst }, index) => (inst === "FROM" ? index : last),
  -1,
);
const builder = instructions.slice(0, lastFromIndex);
const runtime = instructions.slice(lastFromIndex);

// One COPY's sources paired with the absolute in-image path each lands at,
// resolved against the WORKDIR in effect at that instruction.
const copyTargets = (cwd, rest) => {
  const tokens = rest.split(/\s+/);
  const flags = tokens.filter((t) => t.startsWith("--"));
  const paths = tokens.filter((t) => !t.startsWith("--"));
  const sources = paths.slice(0, -1);
  const rawDest = paths[paths.length - 1];
  // A directory destination (trailing "/" or ".") receives each source's
  // basename; a file destination is the path itself, which Docker permits only
  // for a single source.
  const copies =
    rawDest.endsWith("/") || rawDest === "."
      ? sources.map((source) => ({
          source,
          dest: posix.resolve(cwd, rawDest, posix.basename(source)),
        }))
      : [{ source: sources[0], dest: posix.resolve(cwd, rawDest) }];
  return { flags, sources, copies, dests: copies.map(({ dest }) => dest) };
};

const runtimeCopies = [];
{
  let cwd = "/";
  for (const { inst, rest } of runtime) {
    if (inst === "WORKDIR") cwd = posix.resolve(cwd, rest);
    if (inst === "COPY") runtimeCopies.push(copyTargets(cwd, rest));
  }
}
const allRuntimeDests = runtimeCopies.flatMap(({ dests }) => dests);

// The build context's own root .npmrc as a COPY source. A different file copied
// to the same name states whatever its author put in it, so only this one
// carries the policy the tests below and DEPENDENCY_PINS.md speak for.
const ROOT_NPMRC_SOURCE = /^(?:\.\/)?\.npmrc$/;

// Every `npm ci` in the file, paired with whether the root .npmrc had already
// been copied into the directory that install runs in. npm reads its project
// config from the install prefix, so an install running anywhere else is one the
// repo's npm policy does not reach.
const installSites = [];
{
  let cwd = "/";
  let npmrcDirs = new Set();
  for (const { inst, rest } of instructions) {
    if (inst === "FROM") {
      cwd = "/";
      npmrcDirs = new Set();
    }
    if (inst === "WORKDIR") cwd = posix.resolve(cwd, rest);
    if (inst === "COPY") {
      for (const { source, dest } of copyTargets(cwd, rest).copies) {
        if (posix.basename(dest) !== ".npmrc") continue;
        // Whatever lands on the name last is the configuration the install
        // reads, so a later COPY of some other file over it takes the directory
        // back out of the set rather than leaving the earlier copy standing for
        // it.
        if (ROOT_NPMRC_SOURCE.test(source)) npmrcDirs.add(posix.dirname(dest));
        else npmrcDirs.delete(posix.dirname(dest));
      }
    }
    if (inst === "RUN" && /\bnpm ci\b/.test(rest)) {
      installSites.push({ run: rest, cwd, underRootNpmrc: npmrcDirs.has(cwd) });
    }
  }
}

const builderRuns = builder
  .filter(({ inst }) => inst === "RUN")
  .map(({ rest }) => rest);

const firstInstall = builder.findIndex(
  ({ inst, rest }) => inst === "RUN" && /\bnpm ci\b/.test(rest),
);

// `allowScripts` and `strict-allow-scripts` are npm 11.17 features. An older npm
// does not know the config key and reads no policy from the map, so both are
// inert with no diagnostic -- and the base image's digest, not this repo, is
// what decides which npm the builder gets.
const NPM_POLICY_FLOOR = "11.17";

const floorGuard = builder.findIndex(
  ({ inst, rest }) =>
    inst === "RUN" &&
    /\bnpm\s+(?:--version|-v)\b/.test(rest) &&
    rest.includes(NPM_POLICY_FLOOR),
);

// Run the guard's own shell body against a stub `npm` reporting `version`, or
// against no npm at all for a null one. The image's shell is busybox ash and
// this is whatever /bin/sh is here, but the body uses only POSIX parameter
// expansion and `test`, and the two ways a shell can answer a non-numeric
// operand -- a non-zero `test`, or aborting outright -- both land on the
// refusing side.
const runFloorGuard = (version) => {
  const bin = mkdtempSync(join(tmpdir(), "npm-floor-"));
  try {
    if (version !== null) {
      writeFileSync(join(bin, "npm"), `#!/bin/sh\necho '${version}'\n`, {
        mode: 0o755,
      });
    }
    return spawnSync("/bin/sh", ["-c", builder[floorGuard].rest], {
      env: { PATH: bin },
      encoding: "utf8",
    });
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
};

describe("Dockerfile dependency freeze", () => {
  it("installs only with npm ci, never npm install", () => {
    expect(dockerfile).not.toMatch(/\bnpm\s+install\b/);
    expect(builderRuns.some((run) => /\bnpm ci\b/.test(run))).toBe(true);
  });

  it("copies the committed lockfile into the builder before the first npm ci", () => {
    const lockCopy = builder.findIndex(
      ({ inst, rest }) => inst === "COPY" && rest.includes("package-lock.json"),
    );
    expect(lockCopy).toBeGreaterThanOrEqual(0);
    expect(firstInstall).toBeGreaterThan(lockCopy);
  });

  it("runs every npm ci under the root .npmrc, so its install policy binds", () => {
    // Without the root .npmrc in the install directory the image builds under
    // npm's defaults: strict-allow-scripts is off, and a package that gains an
    // install script runs it here while grounding every other install.
    expect(installSites.length).toBeGreaterThan(0);
    expect(
      installSites.filter(({ underRootNpmrc }) => !underRootNpmrc),
    ).toEqual([]);
  });

  it("holds the builder's npm to the install policy's floor before installing", () => {
    // The map and the flag are silently inert below it, so a base digest re-pin
    // onto an older node would install everything unreviewed while every check
    // and this document still read as enforcement.
    expect(floorGuard).toBeGreaterThanOrEqual(0);
    expect(firstInstall).toBeGreaterThan(floorGuard);
  });

  it("ships a production-only tree: the builder's last npm command is npm ci --omit=dev", () => {
    const npmRuns = builderRuns.filter((run) => /\bnpm\b/.test(run));
    expect(npmRuns.length).toBeGreaterThan(0);
    expect(npmRuns[npmRuns.length - 1]).toMatch(/\bnpm ci\b.*--omit=dev/);
  });

  it("performs no dependency resolution in the runtime stage", () => {
    const runtimeRuns = runtime
      .filter(({ inst }) => inst === "RUN")
      .map(({ rest }) => rest);
    expect(runtimeRuns.filter((run) => /\bnpm\b/.test(run))).toEqual([]);
  });

  it("copies the builder's node_modules into the runtime stage", () => {
    const copy = runtimeCopies.find(({ sources }) =>
      sources.includes("/build/node_modules"),
    );
    expect(copy).toBeDefined();
    expect(copy.flags).toContain("--from=builder");
    expect(copy.dests).toEqual(["/app/node_modules"]);
  });

  it("copies both workspace link targets so the node_modules links resolve", () => {
    // node_modules/@psilink/core -> ../../packages/core and
    // node_modules/psilink -> ../apps/cli must not dangle.
    expect(allRuntimeDests).toContain("/app/packages/core/package.json");
    expect(allRuntimeDests).toContain("/app/apps/cli/package.json");
  });
});

describe("what the builder's npm floor guard decides", () => {
  // The test above finds the guard by its text and pins where it sits; these
  // run it. Text alone would accept a guard neutered to `RUN npm --version #
  // floor is 11.17` or weakened to a comparison nothing fails, either of which
  // leaves the image installing under an npm the policy is inert on while every
  // check and the spec still read as enforcement.

  it.each([
    "11.17",
    "11.17.0",
    "11.17.1",
    "11.17.0-pre.1",
    "11.170.0",
    "12.0.0",
  ])("installs under npm %s", (version) => {
    expect(runFloorGuard(version).status).toBe(0);
  });

  it.each(["11.16.9", "11.9.0", "10.9.4", "11"])(
    "refuses npm %s and says why",
    (version) => {
      const { status, stderr } = runFloorGuard(version);
      expect(status).toBe(1);
      expect(stderr).toContain(NPM_POLICY_FLOOR);
    },
  );

  it.each([
    ["reports no version at all", ""],
    ["reports a non-numeric version", "abc"],
    ["reports a version npm never prints", "v11.17.0"],
    ["is not on PATH", null],
  ])("fails closed when npm %s", (_case, version) => {
    expect(runFloorGuard(version).status).not.toBe(0);
  });
});

describe("the root .npmrc the builder installs under", () => {
  // The file is committed and public, and the builder copies it into a layer the
  // release workflow exports to a shared build cache, so it may state
  // configuration and nothing else: registry credentials belong in the
  // user-level ~/.npmrc, which no build reads.
  const settings = readFileSync(resolve(here, "..", ".npmrc"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^[#;]/.test(line))
    .map((line) => {
      const separator = line.indexOf("=");
      return separator === -1
        ? { line, key: line, value: "" }
        : {
            line,
            key: line.slice(0, separator).trim(),
            value: line.slice(separator + 1).trim(),
          };
    });

  // The keys this file exists to state. An allowlist rather than an enumeration
  // of credential-named keys, because npm authenticates from more of its config
  // surface than its `_auth`-shaped keys: an inline `cert`/`key` PEM pair is
  // presented to the registry as an mTLS client credential, and
  // `certfile`/`keyfile` name a file holding one -- none of them named like a
  // secret, and the surface grows with npm rather than with this repo. Widening
  // what the file may carry means widening this set in the same diff.
  const PERMITTED_KEYS = new Set(["engine-strict", "strict-allow-scripts"]);

  // Userinfo in a URL value -- `registry=https://user:secret@host/` and its
  // `@scope:registry` form -- which npm sends as an Authorization: Basic header
  // for that registry, no credential-named key involved. Neither permitted key
  // takes a URL, so this is what stands between a URL-valued key that later
  // joins them and a credential riding in on its value.
  const URL_USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^/?#\s@]*@/i;

  it("states no key beyond the policies it is here for", () => {
    const unpermitted = settings.filter(({ key }) => !PERMITTED_KEYS.has(key));
    expect(unpermitted.map(({ line }) => line)).toEqual([]);
  });

  it("carries no URL userinfo in a permitted key's value", () => {
    const userinfo = settings.filter(({ value }) => URL_USERINFO.test(value));
    expect(userinfo.map(({ line }) => line)).toEqual([]);
  });

  it("states the two policies its readers rest on", () => {
    // Drop either and npm reverts to an advisory warning it prints after the
    // fact: an uncovered install script runs, and an engines mismatch installs.
    const stated = Object.fromEntries(
      settings.map(({ key, value }) => [key, value]),
    );
    expect(stated["strict-allow-scripts"]).toBe("true");
    expect(stated["engine-strict"]).toBe("true");
  });
});

describe("Dockerfile runtime layout", () => {
  // The runtime ENTRYPOINT is a dispatch script serving two roles: the default
  // CLI and, on a `serve` first argument, the web console server. The
  // node/--expose-gc and worker-colocation invariants moved into the script, so
  // they are read from its `exec node ...` lines rather than from the ENTRYPOINT
  // argv directly.
  const entrypoint = runtime.find(({ inst }) => inst === "ENTRYPOINT");
  const entrypointArgv = JSON.parse(entrypoint.rest);
  const entrypointScriptPath = entrypointArgv[entrypointArgv.length - 1];
  const entrypointScript = readFileSync(
    resolve(here, "..", posix.basename(entrypointScriptPath)),
    "utf8",
  );
  const execArgv = (predicate) => {
    const line = entrypointScript
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /^exec\s+node\b/.test(l) && predicate(l));
    return line.replace(/^exec\s+/, "").split(/\s+/);
  };
  const cliArgv = execArgv((l) => l.includes("--expose-gc"));
  const cliEntryPath = cliArgv.find((t) => t.endsWith("index.js"));

  it("ships the dispatch entrypoint script", () => {
    expect(entrypointArgv).toEqual([entrypointScriptPath]);
    expect(allRuntimeDests).toContain(entrypointScriptPath);
  });

  it("runs the copied CLI entry under node with --expose-gc", () => {
    expect(cliArgv[0]).toBe("node");
    expect(cliArgv).toContain("--expose-gc");
    expect(cliEntryPath).toBeDefined();
    expect(allRuntimeDests).toContain(cliEntryPath);
  });

  it("places the PSI worker entry beside the CLI entry", () => {
    // psiWorkerHost resolves `<__dirname>/psiWorker.worker.js`; anywhere else
    // and createPsiEngine silently falls back to the in-process engine.
    expect(allRuntimeDests).toContain(
      posix.join(posix.dirname(cliEntryPath), "psiWorker.worker.js"),
    );
  });

  it("runs the web server entry, under a copied directory, for the serve role", () => {
    const serveArgv = execArgv((l) => l.includes(".output"));
    const serverEntry = serveArgv.find((t) => t.includes(".output"));
    expect(serverEntry).toBeDefined();
    // The server entry lives under a directory the runtime stage copies in.
    expect(
      allRuntimeDests.some(
        (dest) => serverEntry === dest || serverEntry.startsWith(dest + "/"),
      ),
    ).toBe(true);
  });
});
