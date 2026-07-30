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
// comments. The fold removes the backslash and the newline and inserts nothing,
// which is what Docker's own parser does: a continuation with no space before
// the backslash joins two tokens into one, and reading it as two would let a
// command below match as something the build does not run.
const instructions = dockerfile
  .replace(/\\\r?\n/g, "")
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

// Resolve the runtime stage's COPY destinations against the WORKDIR in effect
// at each instruction, so assertions hold absolute in-image paths.
const runtimeCopies = [];
{
  let cwd = "/";
  for (const { inst, rest } of runtime) {
    if (inst === "WORKDIR") cwd = posix.resolve(cwd, rest);
    if (inst !== "COPY") continue;
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
    runtimeCopies.push({ flags, sources, dests });
  }
}
const allRuntimeDests = runtimeCopies.flatMap(({ dests }) => dests);

const builderRuns = builder
  .filter(({ inst }) => inst === "RUN")
  .map(({ rest }) => rest);

// Collapsed on the ASCII blanks a shell treats as separators, since indenting a
// "\"-continued line changes the run of spaces between two tokens and nothing
// else. Deliberately not /\s+/: that also eats U+00A0, which the shell does not
// separate on.
const normalize = (rest) => rest.trim().replace(/[ \t]+/g, " ");

// The instruction that puts the root .npmrc in the builder, frozen. The
// committed file's bytes are held below; this holds which file the builder
// copies, so a second one cannot land on the name and state whatever its author
// put in it. It is a text comparison rather than a model of where a COPY's
// sources land -- Docker copies a directory source's contents, so a file can
// arrive without being named in the instruction at all, which this does not
// reach and docs/spec/DEPENDENCY_PINS.md records as a limit.
const EXPECTED_NPMRC_COPY = "COPY .npmrc package.json package-lock.json ./";
const npmrcCopies = instructions
  .filter(({ inst, rest }) => inst === "COPY" && /\.npmrc/.test(rest))
  .map(({ rest }) => `COPY ${normalize(rest)}`);

// The runtime stage's whole OS-package surface, frozen by literal the way the
// .npmrc COPY above is. The npm tree is copied from the builder and resolves
// nothing, so this one install is the only dependency the image build fetches --
// which is the claim docs/spec/DEPENDENCY_PINS.md records as a single named
// exception, and a claim prose cannot hold: a second package, or a wider spec on
// this line, ships unreviewed while the sentence still reads as one package.
const EXPECTED_OS_INSTALL = "RUN apk add --no-cache samba-client";
const OS_PACKAGE_MANAGER = /\b(apk|apt|apt-get|pip|pip3)\b/;
const runtimeRuns = runtime
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

  it("copies the root .npmrc into the builder before the first npm ci, and copies no other", () => {
    // Without it the image builds under npm's defaults: strict-allow-scripts is
    // off, and a package that gains an install script installs unreviewed.
    expect(npmrcCopies).toEqual([EXPECTED_NPMRC_COPY]);
    const firstCi = builder.findIndex(
      ({ inst, rest }) => inst === "RUN" && /\bnpm ci\b/.test(rest),
    );
    const npmrcCopy = builder.findIndex(
      ({ inst, rest }) => inst === "COPY" && /\.npmrc/.test(rest),
    );
    expect(npmrcCopy).toBeGreaterThanOrEqual(0);
    expect(firstCi).toBeGreaterThan(npmrcCopy);
  });

  it("ships a production-only tree: the builder's last npm command is npm ci --omit=dev", () => {
    const npmRuns = builderRuns.filter((run) => /\bnpm\b/.test(run));
    expect(npmRuns.length).toBeGreaterThan(0);
    expect(npmRuns[npmRuns.length - 1]).toMatch(/\bnpm ci\b.*--omit=dev/);
  });

  it("runs no npm in the runtime stage, so the copied tree is what ships", () => {
    expect(runtimeRuns.filter((run) => /\bnpm\b/.test(run))).toEqual([]);
  });

  it("installs one OS package in the runtime stage, the reviewed one", () => {
    expect(
      runtimeRuns
        .filter((run) => OS_PACKAGE_MANAGER.test(run))
        .map((run) => `RUN ${normalize(run)}`),
    ).toEqual([EXPECTED_OS_INSTALL]);
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

// The committed root .npmrc, byte for byte. Equality with this literal is what
// holds the file to configuration and nothing else, in place of a reader that
// decides which of its lines are credentials. Such a reader has two gaps this
// has neither of: npm authenticates from more of its config surface than its
// `_auth`-shaped keys -- an inline `cert`/`key` PEM pair is presented to the
// registry as an mTLS client credential, `certfile`/`keyfile` name a file
// holding one -- and that surface grows with npm rather than with this repo; and
// the reader must agree with npm's own parser about which bytes are a line at
// all, which the next test is about. The cost is that changing the file
// legitimately means changing this literal in the same diff, where the review
// reads the bytes rather than a verdict about them.
const EXPECTED_NPMRC = `# Make the root engines.node constraint a hard install failure rather than npm's
# default advisory warning, so CI, the docs, and a local install cannot diverge
# on the Node version.
engine-strict=true

# Make a package with no \`allowScripts\` verdict a hard install failure rather
# than npm's advisory warning, so a DECLARED install script cannot run first and
# be noticed after -- npm's refusal is a pre-extraction preflight, so the
# synthetic \`node-gyp rebuild\` a shipped binding.gyp earns is outside it (see
# docs/spec/DEPENDENCY_PINS.md). Safe to set because the map covers every install
# script the committed lockfile records -- completeness that
# scripts/allow-scripts-policy.test.mjs holds as a check rather than prose.
strict-allow-scripts=true

# npm's own defaults, stated so a user-level ~/.npmrc cannot turn the refusal
# above off underneath the project. Either key defeats it there:
# \`dangerously-allow-all-scripts\` lets the uncovered script run, and
# \`ignore-scripts\` skips the preflight so the package installs unreviewed. The
# project file outranks the user file, so stating them here closes that route
# (measured on npm 11.17.0). The environment outranks both and this file cannot
# reach it; see docs/spec/DEPENDENCY_PINS.md.
ignore-scripts=false
dangerously-allow-all-scripts=false
`;

describe("the root .npmrc the builder installs under", () => {
  // The file is committed and public, and the builder copies it into a layer the
  // release workflow exports to a shared build cache, so it may state
  // configuration and nothing else: registry credentials belong in the
  // user-level ~/.npmrc, which no build reads.
  const committed = readFileSync(resolve(here, "..", ".npmrc"));

  it("is the file this literal was reviewed as, byte for byte", () => {
    // The string compare is the one that prints a diff; the byte compare is the
    // claim, since what ships in the layer is bytes and a decode of them is not.
    expect(committed.toString("utf8")).toBe(EXPECTED_NPMRC);
    expect(committed.equals(Buffer.from(EXPECTED_NPMRC, "utf8"))).toBe(true);
  });

  it("carries no CR, so npm's line split and the one below cannot disagree", () => {
    // npm parses with the `ini` package, which breaks lines on /[\r\n]+/, so a
    // lone CR ends a line there while a split on "\n" alone reads
    // `# note<CR>//host/:_authToken=x` as one comment. Measured against npm
    // 11.17.0 driven at a local registry, a token smuggled that way is one npm
    // sends as `Authorization: Bearer`. No CR in the file is what makes the
    // enumeration below the same set of lines npm reads.
    expect(EXPECTED_NPMRC).not.toMatch(/\r/);
  });

  it("states the four policies its readers rest on, and states nothing else", () => {
    // Drop either of the first two and npm reverts to an advisory warning it
    // prints after the fact: an uncovered install script runs, and an engines
    // mismatch installs. Drop either of the last two and a user-level ~/.npmrc
    // decides them instead. Anything beyond them is configuration nobody
    // reviewed as safe to bake into a cached image layer.
    const stated = EXPECTED_NPMRC.split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !/^[#;]/.test(line));
    expect(stated).toEqual([
      "engine-strict=true",
      "strict-allow-scripts=true",
      "ignore-scripts=false",
      "dangerously-allow-all-scripts=false",
    ]);
  });

  it("carries no URL userinfo anywhere in it", () => {
    // A credential rides in on a value rather than on a key name:
    // `registry=https://user:secret@host/`, including under an `@scope:registry`
    // key, is one npm turns into an Authorization: Basic header for that
    // registry. No policy above takes a URL, so this is what stands over a
    // URL-valued key that later joins them in the literal -- the one path a
    // legitimate widening could carry a credential in on.
    expect(EXPECTED_NPMRC).not.toMatch(/[a-z][a-z0-9+.-]*:\/\/[^/?#\s@]*@/i);
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
