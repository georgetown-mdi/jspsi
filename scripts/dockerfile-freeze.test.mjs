import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

// One COPY's sources and its absolute in-image destinations, resolved against
// the WORKDIR in effect at that instruction.
const copyTargets = (cwd, rest) => {
  const tokens = rest.split(/\s+/);
  const flags = tokens.filter((t) => t.startsWith("--"));
  const paths = tokens.filter((t) => !t.startsWith("--"));
  const sources = paths.slice(0, -1);
  const rawDest = paths[paths.length - 1];
  // A directory destination (trailing "/" or ".") receives the source's
  // basename; a file destination is the path itself.
  const dests =
    rawDest.endsWith("/") || rawDest === "."
      ? sources.map((s) => posix.resolve(cwd, rawDest, posix.basename(s)))
      : [posix.resolve(cwd, rawDest)];
  return { flags, sources, dests };
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
      for (const dest of copyTargets(cwd, rest).dests) {
        if (posix.basename(dest) === ".npmrc")
          npmrcDirs.add(posix.dirname(dest));
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

describe("Dockerfile dependency freeze", () => {
  it("installs only with npm ci, never npm install", () => {
    expect(dockerfile).not.toMatch(/\bnpm\s+install\b/);
    expect(builderRuns.some((run) => /\bnpm ci\b/.test(run))).toBe(true);
  });

  it("copies the committed lockfile into the builder before the first npm ci", () => {
    const firstCi = builder.findIndex(
      ({ inst, rest }) => inst === "RUN" && /\bnpm ci\b/.test(rest),
    );
    const lockCopy = builder.findIndex(
      ({ inst, rest }) => inst === "COPY" && rest.includes("package-lock.json"),
    );
    expect(lockCopy).toBeGreaterThanOrEqual(0);
    expect(firstCi).toBeGreaterThan(lockCopy);
  });

  it("runs every npm ci under the root .npmrc, so its install policy binds", () => {
    // Without the .npmrc in the install directory the image builds under npm's
    // defaults: strict-allow-scripts is off, and a package that gains an
    // install script runs it here while grounding every other install.
    expect(installSites.length).toBeGreaterThan(0);
    expect(
      installSites.filter(({ underRootNpmrc }) => !underRootNpmrc),
    ).toEqual([]);
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

describe("the root .npmrc the builder installs under", () => {
  // The file is committed and public, and the builder copies it into the build
  // context, so it may state configuration and nothing else: registry
  // credentials belong in the user-level ~/.npmrc, which no build reads.
  const settings = readFileSync(resolve(here, "..", ".npmrc"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^[#;]/.test(line));

  it("states no credential-bearing key", () => {
    const credentials = settings.filter((line) =>
      /^(?:\/\/\S+:)?(?:_auth|_authToken|_password|username)\s*=/i.test(line),
    );
    expect(credentials).toEqual([]);
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
