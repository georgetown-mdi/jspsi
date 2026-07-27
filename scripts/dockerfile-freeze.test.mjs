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

// The version the policy's behavior in docs/spec/DEPENDENCY_PINS.md was measured
// against. npm reads `allowScripts` and honors `strict-allow-scripts` from
// 11.16.0 -- 11.15.0 and earlier have neither the config key nor the preflight,
// so the map goes unread and the flag draws only an unknown-config warning --
// and 11.17 adds the same preflight to `npm exec`. Which npm the builder gets is
// a property of the base image's digest rather than of anything in this repo.
const NPM_POLICY_FLOOR = "11.17";

// The npm invocations inside a RUN body: each shell-separated segment's command
// word, reached past the RUN's own flags (`--mount=...`) and any leading
// VAR=value assignment, paired with the arguments that follow it. Reading the
// command word rather than matching `npm ci` as text is what makes an install
// spelled `npm  ci`, folded across a line continuation, or written `npm i` an
// install site rather than invisible to every check below.
const npmInvocations = (rest) =>
  rest
    .split(/[;&|()`]+/)
    .map((segment) => segment.trim().split(/\s+/).filter(Boolean))
    .map((tokens) => {
      let i = 0;
      while (
        i < tokens.length &&
        (tokens[i].startsWith("--") ||
          /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))
      )
        i += 1;
      return tokens[i] === "npm" ? tokens.slice(i + 1) : null;
    })
    .filter((args) => args !== null);

// npm's command word, or "" for an invocation that leads with a flag -- which
// the install-site rule below treats as an install it cannot vouch for rather
// than as something to skip.
const npmCommand = (args) =>
  args[0] !== undefined && !args[0].startsWith("-") ? args[0] : "";

const isVersionQuery = (args) =>
  args.length === 1 && /^(?:--version|-v)$/.test(args[0]);

// The npm commands that resolve no dependency tree. Anything else is held to
// the install-site conditions, so a command this file does not use cannot
// arrive as neither an install nor a build step.
const NON_RESOLVING = new Set(["run", "run-script"]);

const isFloorGuard = ({ inst, rest }) =>
  inst === "RUN" &&
  npmInvocations(rest).some(isVersionQuery) &&
  rest.includes(NPM_POLICY_FLOOR);

// The flags this file's installs carry. An allowlist, because npm resolves its
// command line ahead of the project .npmrc: `--strict-allow-scripts=false` and
// `--strict-allow-scripts false` each turn the policy off (measured on npm
// 11.17.0), as does `--no-strict-allow-scripts`, `--prefix`, and whatever npm
// gains next. Enumerating the ways to spell "off" is the shape this file has
// already lost to; widening what an install may carry means widening this set
// in the same diff.
const PERMITTED_INSTALL_FLAGS = new Set(["--omit=dev", "-w"]);

// npm reads any npm_config_-prefixed variable ahead of the project .npmrc too,
// so a stage that sets one installs under something other than the file every
// check here reads. None is permitted, for the reason the flags are an
// allowlist.
const NPM_CONFIG_ENV = /(?:^|\s)npm_config_[a-z0-9_]+/i;

// A working directory moved inside the RUN, which decides which .npmrc npm
// reads independently of the WORKDIR the COPY tracking below follows.
const CWD_REDIRECT = /(?:^|[\s;&|(])(?:cd|pushd)\s/;

// Every dependency-resolving npm invocation in the file, paired with the
// conditions that decide whether the repo's own npm configuration is the one in
// force for it: the root .npmrc copied into the directory it runs in, the npm
// floor guard already run in the same stage, and no override of either on its
// command line or in the stage's environment.
const installSites = [];
{
  let cwd = "/";
  let npmrcDirs = new Set();
  let guarded = false;
  let envOverride = false;
  for (const [index, instruction] of instructions.entries()) {
    const { inst, rest } = instruction;
    if (inst === "FROM") {
      cwd = "/";
      npmrcDirs = new Set();
      guarded = false;
      envOverride = false;
    }
    if (inst === "WORKDIR") cwd = posix.resolve(cwd, rest);
    if ((inst === "ENV" || inst === "ARG") && NPM_CONFIG_ENV.test(rest))
      envOverride = true;
    if (isFloorGuard(instruction)) guarded = true;
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
    if (inst !== "RUN") continue;
    for (const args of npmInvocations(rest)) {
      if (isVersionQuery(args) || NON_RESOLVING.has(npmCommand(args))) continue;
      installSites.push({
        run: rest,
        cwd,
        index,
        command: npmCommand(args),
        underRootNpmrc: npmrcDirs.has(cwd) && !CWD_REDIRECT.test(rest),
        behindFloorGuard: guarded,
        policyOverridden:
          envOverride ||
          args.some(
            (token) =>
              token.startsWith("-") && !PERMITTED_INSTALL_FLAGS.has(token),
          ),
      });
    }
  }
}

// A RUN that writes the file out from inside the image replaces the
// configuration the checks here read off the build context.
const npmrcRewrites = instructions.filter(
  ({ inst, rest }) => inst === "RUN" && /\.npmrc/.test(rest),
);

const builderRuns = builder
  .filter(({ inst }) => inst === "RUN")
  .map(({ rest }) => rest);

// -1 for a builder that installs nothing, which reddens the ordering test below
// rather than passing it on a comparison against no install at all.
const builderInstalls = installSites.filter(
  ({ index }) => index < lastFromIndex,
);
const firstInstall = builderInstalls.length ? builderInstalls[0].index : -1;

// Every guard in the file, not the first one: the install-site rule above is
// satisfied by whichever guard precedes an install in its own stage, so a
// second stage's guard decides that stage's installs and has to be run too.
const floorGuards = instructions.filter(isFloorGuard).map(({ rest }) => rest);

// Run a guard's own shell body against a stub `npm` reporting `version`, or
// against no npm at all for a null one. The image's shell is busybox ash and
// this is whatever /bin/sh is here, but the body uses only POSIX parameter
// expansion and `test`, and the two ways a shell can answer a non-numeric
// operand -- a non-zero `test`, or aborting outright -- both land on the
// refusing side.
const runFloorGuard = (body, version) => {
  const bin = mkdtempSync(join(tmpdir(), "npm-floor-"));
  try {
    if (version !== null) {
      writeFileSync(join(bin, "npm"), `#!/bin/sh\necho '${version}'\n`, {
        mode: 0o755,
      });
    }
    return spawnSync("/bin/sh", ["-c", body], {
      env: { PATH: bin },
      encoding: "utf8",
    });
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
};

const eachFloorGuard = (assert) => {
  expect(floorGuards.length).toBeGreaterThan(0);
  for (const body of floorGuards) assert(body);
};

describe("Dockerfile dependency freeze", () => {
  it("installs only with npm ci, never another install spelling", () => {
    // npm ci is what installs exactly the committed lockfile; `npm install`,
    // its `i` alias, and `npm add` all re-resolve and may rewrite the file.
    expect(installSites.length).toBeGreaterThan(0);
    expect(installSites.filter(({ command }) => command !== "ci")).toEqual([]);
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

  it("holds every install to the npm the policy was measured against", () => {
    // Below 11.16 the map goes unread and the flag draws only an unknown-config
    // warning, so a base digest re-pin onto an older node would install
    // everything unreviewed while every check and the spec still read as
    // enforcement. Per install site rather than by position, so a second stage
    // cannot install ahead of its own guard.
    expect(installSites.length).toBeGreaterThan(0);
    expect(
      installSites.filter(({ behindFloorGuard }) => !behindFloorGuard),
    ).toEqual([]);
  });

  it("lets nothing override the policy the root .npmrc states", () => {
    // The COPY tracking above says which file npm would read; these are the ways
    // that file stops being the answer -- a flag or an npm_config_ variable npm
    // resolves ahead of it, and the file rewritten from inside the image.
    expect(
      installSites.filter(({ policyOverridden }) => policyOverridden),
    ).toEqual([]);
    expect(npmrcRewrites).toEqual([]);
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

describe("what the npm floor guards decide", () => {
  // The test above finds a guard by its text and holds every install behind one
  // in its own stage; these run every guard the file carries. Text alone would
  // accept a guard neutered to `RUN npm --version # floor is 11.17` or weakened
  // to a comparison nothing fails, either of which leaves the image installing
  // under an unmeasured npm while every check and the spec still read as
  // enforcement. The tables are about what a guard decides, not about which npm
  // releases exist.

  it.each([
    "11.17",
    "11.17.0",
    "11.17.1",
    "11.17.0-pre.1",
    "11.170.0",
    "12.0.0",
  ])("install under npm %s", (version) => {
    eachFloorGuard((body) =>
      expect(runFloorGuard(body, version).status).toBe(0),
    );
  });

  it.each(["11.16.9", "11.9.0", "10.9.4", "11"])(
    "refuse npm %s and say why",
    (version) => {
      eachFloorGuard((body) => {
        const { status, stderr } = runFloorGuard(body, version);
        expect(status).toBe(1);
        expect(stderr).toContain(NPM_POLICY_FLOOR);
      });
    },
  );

  it.each([
    ["reports no version at all", ""],
    ["reports a non-numeric version", "abc"],
    ["reports a version npm never prints", "v11.17.0"],
    ["is not on PATH", null],
  ])("fail closed when npm %s", (_case, version) => {
    eachFloorGuard((body) =>
      expect(runFloorGuard(body, version).status).not.toBe(0),
    );
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
