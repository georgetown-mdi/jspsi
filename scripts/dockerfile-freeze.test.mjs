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
// comments. The fold removes the backslash and the newline and inserts nothing,
// which is what Docker's own parser does: a continuation with no space before
// the backslash joins two tokens into one, and reading it as two would let the
// frozen text below match a command the build does not run.
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

// The version the policy's behavior in docs/spec/DEPENDENCY_PINS.md was measured
// against. npm reads `allowScripts` and honors `strict-allow-scripts` from
// 11.16.0 -- 11.15.0 and earlier have neither the config key nor the preflight,
// so the map goes unread and the flag draws only an unknown-config warning --
// and 11.17 adds the same preflight to `npm exec`. Which npm the builder gets is
// a property of the base image's digest rather than of anything in this repo.
const NPM_POLICY_FLOOR = "11.17";

// Collapsed on the ASCII blanks a shell treats as separators, since indenting a
// "\"-continued line changes the run of spaces between two tokens and nothing
// else. Deliberately not /\s+/: that also eats U+00A0, which the shell does not
// separate on, so a command carrying one would compare equal to this text while
// running as something else.
const normalize = (rest) => rest.trim().replace(/[ \t]+/g, " ");

// Every RUN in the Dockerfile that names npm, frozen to its exact text. This is
// what stands between the image and an install running under something other
// than the policy the root .npmrc states, and it is a frozen list rather than a
// model of npm's command line because that command line is npm's to change: the
// spellings that turn a policy off (`--no-strict-allow-scripts`,
// `--strict-allow-scripts=false`, the space-separated form), the ones that move
// which config npm reads (`--prefix`, `--userconfig`), an `npm_config_` variable
// assigned ahead of the command, a wrapper in front of it, an install spelled
// `npm i` -- each is a set that grows with npm rather than with this repo, and a
// reader that enumerates them is only ever as complete as its last revision.
// Every one of them changes this text. Changing an npm command in the Dockerfile
// therefore means changing the literal here in the same diff, where the review
// reads the command rather than a verdict about it.
const EXPECTED_NPM_RUNS = [
  "--mount=type=cache,target=/root/.npm " +
    'npm_version="$(npm --version)"; npm_major="${npm_version%%.*}"; ' +
    'npm_minor="${npm_version#*.}"; npm_minor="${npm_minor%%.*}"; ' +
    'if ! { [ "$npm_major" -gt 11 ] || ' +
    '{ [ "$npm_major" = 11 ] && [ "$npm_minor" -ge 17 ]; }; }; then ' +
    'echo "npm $npm_version is below the 11.17 floor the allowScripts install policy needs" >&2; ' +
    "exit 1; " +
    "fi; " +
    "for policy in strict-allow-scripts engine-strict; do " +
    'value="$(npm config get "$policy")"; ' +
    'if [ "$value" != "true" ]; then ' +
    "echo \"npm resolves $policy to '$value', not true: this build would not run under the repo's install policy\" >&2; " +
    "exit 1; " +
    "fi; " +
    "done",
  "--mount=type=cache,target=/root/.npm npm ci -w packages/core -w apps/cli -w apps/web",
  "npm run build -w packages/core -w apps/cli",
  "npm run build -w apps/web",
  "--mount=type=cache,target=/root/.npm npm ci --omit=dev -w packages/core -w apps/cli",
];

// The guard is the one that asks npm what it will do; the installs are the two
// that do it. Naming them by index into the frozen list is a statement about
// known text rather than a parse of unknown text -- the freeze is what keeps it
// known.
const POLICY_GUARD = EXPECTED_NPM_RUNS[0];
const INSTALL_RUNS = [EXPECTED_NPM_RUNS[1], EXPECTED_NPM_RUNS[4]];

// npx as well as npm: npx is npm exec, which fetches and runs a package from the
// registry into a layer the release build exports to a shared cache.
const npmRuns = instructions
  .filter(({ inst, rest }) => inst === "RUN" && /\bnp[mx]\b/.test(rest))
  .map(({ rest }) => normalize(rest));

// A RUN that writes the file out from inside the image replaces the
// configuration the checks here read off the build context.
const npmrcRewrites = instructions.filter(
  ({ inst, rest }) => inst === "RUN" && /\.npmrc/.test(rest),
);

// npm resolves an npm_config_-prefixed variable ahead of the project .npmrc, and
// the guard below reads npm's answer once, in its own process: a variable set
// after it runs is one it cannot see and the frozen command text does not carry.
// Measured on npm 11.17.0, `npm_config_strict_allow_scripts=false` resolves the
// policy to false. This is a whole class of instruction the file has no occasion
// to use, so none is permitted rather than a list of the harmful names.
const npmConfigEnv = instructions.filter(
  ({ inst, rest }) =>
    (inst === "ENV" || inst === "ARG") && /\bnpm_config_/i.test(rest),
);

// A heredoc RUN body is not one logical line, so the line-based read above would
// take `RUN <<EOF` as a RUN naming no npm and the lines inside it as their own
// instructions. The file has no occasion to use one, and refusing is what keeps
// the freeze speaking for every command the builder runs.
const heredocRuns = instructions.filter(
  ({ inst, rest }) => inst === "RUN" && rest.includes("<<"),
);

// The directory each instruction runs in, tracked through WORKDIR. The guard
// reads npm's configuration at its own prefix, so an install that has since
// moved to another directory is one the guard did not speak for -- npm resolves
// the .npmrc at the prefix, and there is none in a subdirectory.
const cwdAt = [];
{
  let cwd = "/";
  for (const { inst, rest } of instructions) {
    if (inst === "FROM") cwd = "/";
    if (inst === "WORKDIR") cwd = posix.resolve(cwd, rest);
    cwdAt.push(cwd);
  }
}

const builderRuns = builder
  .filter(({ inst }) => inst === "RUN")
  .map(({ rest }) => rest);

const builderIndexOf = (body) =>
  builder.findIndex(
    ({ inst, rest }) => inst === "RUN" && normalize(rest) === body,
  );

// -1 when the builder does not carry it, which reddens the ordering tests below
// rather than passing them on a comparison against an instruction that is absent.
const firstInstall = Math.min(
  ...INSTALL_RUNS.map(builderIndexOf).map((i) => (i === -1 ? Infinity : i)),
);
const policyGuard = builderIndexOf(POLICY_GUARD);

// A RUN's own flags (`--mount=...`) precede the command Docker hands the shell,
// so they come off before the body is run as one.
const shellBody = (body) => body.replace(/^(?:--\S+\s+)*/, "");

// Run the guard's own shell body against a stub `npm` that answers `--version`
// with `version` and `config get` with `config`, or against no npm at all for a
// null version. The image's shell is busybox ash and this is whatever /bin/sh is
// here, but the body uses only POSIX parameter expansion, `test`, and a `for`
// loop, and the two ways a shell can answer a non-numeric operand -- a non-zero
// `test`, or aborting outright -- both land on the refusing side.
const runPolicyGuard = (version, config = "true") => {
  const bin = mkdtempSync(join(tmpdir(), "npm-floor-"));
  try {
    if (version !== null) {
      writeFileSync(
        join(bin, "npm"),
        `#!/bin/sh\ncase "$1" in\n  --version) echo '${version}' ;;\n  config) echo '${config}' ;;\nesac\n`,
        {
          mode: 0o755,
        },
      );
    }
    return spawnSync("/bin/sh", ["-c", shellBody(POLICY_GUARD)], {
      env: { PATH: bin },
      encoding: "utf8",
    });
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
};

describe("Dockerfile dependency freeze", () => {
  it("runs the npm commands this repo reviewed, and no others", () => {
    // Every way an install can end up under something other than the root
    // .npmrc's policy -- a flag, an assigned npm_config_ variable, a wrapper, an
    // `npm i`, an added stage that installs -- changes this text.
    expect(npmRuns).toEqual(EXPECTED_NPM_RUNS);
  });

  it("copies the committed lockfile into the builder before the first npm ci", () => {
    const lockCopy = builder.findIndex(
      ({ inst, rest }) => inst === "COPY" && rest.includes("package-lock.json"),
    );
    expect(lockCopy).toBeGreaterThanOrEqual(0);
    expect(firstInstall).toBeGreaterThan(lockCopy);
  });

  it("copies the root .npmrc into the builder before the first npm ci", () => {
    // Without it the image builds under npm's defaults: strict-allow-scripts is
    // off, and a package that gains an install script runs it here. A different
    // file copied to the same name states whatever its author put in it, and
    // whatever lands on the name last is what the install reads.
    const npmrcCopies = builder.flatMap(({ inst, rest }, index) =>
      inst === "COPY"
        ? copyTargets(cwdAt[index], rest)
            .copies.filter(({ dest }) => posix.basename(dest) === ".npmrc")
            .map(({ source, dest }) => ({ index, source, dest }))
        : [],
    );
    expect(npmrcCopies.length).toBeGreaterThan(0);
    const last = npmrcCopies[npmrcCopies.length - 1];
    expect(last.source).toMatch(ROOT_NPMRC_SOURCE);
    expect(firstInstall).toBeGreaterThan(last.index);
    // npm reads the .npmrc at the prefix it runs in, so the guard and both
    // installs have to run in the directory it landed in -- a WORKDIR moved
    // between them puts the install somewhere holding no .npmrc at all.
    const npmrcDir = posix.dirname(last.dest);
    expect(cwdAt[policyGuard]).toBe(npmrcDir);
    for (const body of INSTALL_RUNS)
      expect(cwdAt[builderIndexOf(body)]).toBe(npmrcDir);
  });

  it("asks npm what it will do before installing anything", () => {
    // What the .npmrc states is not yet what npm will do: npm resolves its
    // command line and environment ahead of the file, and a base image or a
    // build argument can carry either. The guard reads the answer out of npm
    // itself, which is the one reading no static model of this file can give.
    expect(policyGuard).toBeGreaterThanOrEqual(0);
    expect(firstInstall).toBeGreaterThan(policyGuard);
  });

  it("sets no npm_config_ variable the guard would not have seen", () => {
    // The guard answers for the environment as it stood when it ran; npm
    // resolves one of these ahead of the .npmrc, so one set afterwards installs
    // under something the guard never measured and no frozen command carries.
    expect(npmConfigEnv).toEqual([]);
  });

  it("spells every RUN on one logical line, so the freeze reads them all", () => {
    expect(heredocRuns).toEqual([]);
  });

  it("lets no RUN rewrite the .npmrc the guard read", () => {
    expect(npmrcRewrites).toEqual([]);
  });

  it("ships a production-only tree: the builder's last npm command is npm ci --omit=dev", () => {
    const builderNpmRuns = builderRuns.filter((run) => /\bnpm\b/.test(run));
    expect(builderNpmRuns.length).toBeGreaterThan(0);
    expect(builderNpmRuns[builderNpmRuns.length - 1]).toMatch(
      /\bnpm ci\b.*--omit=dev/,
    );
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

describe("what the builder's policy guard decides", () => {
  // The freeze above holds the guard's text; this runs it. Text alone would
  // accept one neutered to `RUN npm --version # floor is 11.17` or weakened to a
  // comparison nothing fails, either of which leaves the image installing under
  // an unmeasured npm or an unenforced policy while the freeze and the spec
  // still read as enforcement. The tables are about what the guard decides, not
  // about which npm releases exist.

  it.each([
    "11.17",
    "11.17.0",
    "11.17.1",
    "11.17.0-pre.1",
    "11.170.0",
    "12.0.0",
  ])("installs under npm %s reporting the policy on", (version) => {
    expect(runPolicyGuard(version).status).toBe(0);
  });

  it.each(["11.16.9", "11.9.0", "10.9.4", "11"])(
    "refuses npm %s and says why",
    (version) => {
      const { status, stderr } = runPolicyGuard(version);
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
    expect(runPolicyGuard(version).status).not.toBe(0);
  });

  it.each(["false", "", "undefined", "null"])(
    "refuses an npm that resolves the policy to %s, and says which",
    (config) => {
      // The version being high enough does not mean the policy is in force: the
      // .npmrc may not have been copied, or a base image or build argument may
      // carry a flag or an npm_config_ variable npm resolves ahead of it.
      const { status, stderr } = runPolicyGuard("11.17.0", config);
      expect(status).toBe(1);
      expect(stderr).toContain("strict-allow-scripts");
    },
  );

  it("checks engine-strict too, not only the install policy", () => {
    // A stub answering `true` for everything passes; the loop is what makes the
    // second policy checked rather than assumed, so a guard that dropped it
    // would still pass the table above.
    expect(POLICY_GUARD).toContain("engine-strict");
    expect(runPolicyGuard("11.17.0", "true").status).toBe(0);
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

  it("states the two policies its readers rest on, and states nothing else", () => {
    // Drop either and npm reverts to an advisory warning it prints after the
    // fact: an uncovered install script runs, and an engines mismatch installs.
    // Anything beyond them is configuration nobody reviewed as safe to bake into
    // a cached image layer.
    const stated = EXPECTED_NPMRC.split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !/^[#;]/.test(line));
    expect(stated).toEqual(["engine-strict=true", "strict-allow-scripts=true"]);
  });

  it("carries no URL userinfo anywhere in it", () => {
    // A credential rides in on a value rather than on a key name:
    // `registry=https://user:secret@host/`, including under an `@scope:registry`
    // key, is one npm turns into an Authorization: Basic header for that
    // registry. Neither policy above takes a URL, so this is what stands over a
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
