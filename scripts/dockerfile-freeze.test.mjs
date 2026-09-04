import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Structural invariants of the Dockerfiles that keep each shipped image's
// dependency tree frozen to the committed package-lock.json, and keep the
// runtime layout the CLI's resolution depends on. Each test names the runtime
// claim it stands in for; docs/spec/DEPENDENCY_PINS.md holds the rationale.
//
// Two images ship from this repository and both are held to the same
// invariants: the default `Dockerfile` on node:26-alpine, and `Dockerfile.fips`
// on Amazon Linux 2023 carrying a CMVP-validated OpenSSL FIPS provider. What
// diverges is the OS package manager and the packages each fetches, which is
// per-file data below rather than a loosened assertion; what the FIPS variant
// adds on top of the shared set -- its certificate pins, its provider
// assertion, and its fips-only OpenSSL configuration -- is asserted at the end.
//
// This is a static parser. It cannot observe a running process, so what a build
// or a container actually does is CI's ground: image_smoke.yaml builds both
// images and, for the variant, asserts through support/fips-probe/ that the
// provider is engaged rather than merely installed.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const readRepoFile = (name) => readFileSync(resolve(repoRoot, name), "utf8");

// Collapsed on the ASCII blanks a shell treats as separators, since indenting a
// "\"-continued line changes the run of spaces between two tokens and nothing
// else. Deliberately not /\s+/: that also eats U+00A0, which the shell does not
// separate on.
const normalize = (rest) => rest.trim().replace(/[ \t]+/g, " ");

// The package managers whose installs are frozen by literal per file below. A
// runtime-stage fetch by some other route -- curl and extract, `rpm` driven
// directly, or another language's package manager -- is outside what this sees,
// as docs/spec/DEPENDENCY_PINS.md records.
const OS_PACKAGE_MANAGER = /\b(apk|apt|apt-get|dnf|microdnf|yum|pip|pip3)\b/;

// The instruction classes this file reads. Every other class is refused rather
// than modeled, because ownership and content both ride only the instructions
// parsed below: ADD names itself here, since it takes the same --chown and
// --chmod flags COPY does and can fetch a remote source, so a single
// `ADD --chown=node:node ... /app/x` in either stage would hand the runtime
// account a path under /app -- and pull in something the lockfile does not
// pin -- while every assertion in this file, all of which read COPY and RUN,
// still passed. Neither Dockerfile uses anything outside this list; a build that
// needs another class extends it, where the review reads the instruction rather
// than a verdict about it.
const REVIEWED_INSTRUCTIONS = [
  "ARG",
  "COPY",
  "ENTRYPOINT",
  "ENV",
  "EXPOSE",
  "FROM",
  "RUN",
  "USER",
  "WORKDIR",
];

// The ownership verbs the parse in analyze() reads: their path operands are
// extracted and tested against the writable trees.
const PARSED_OWNERSHIP_VERB = /^(?:chown|chgrp|chmod)\s/;

// The account verbs it reads, which hand a path to the runtime account by a
// route no ownership verb appears on: an account's home directory is created
// owned by that account, so `useradd --create-home --home-dir /app node` hands
// over /app with no chown anywhere in the stage. The FIPS variant runs these --
// Amazon Linux 2023 ships no `node` account -- so refusing them outright, the
// way install and setfacl are refused, is not available.
const PARSED_ACCOUNT_VERB = /^(?:useradd|adduser|usermod|groupadd)\s/;

// The flags that parse understands on one of those verbs, split by whether the
// value is the next token. Everything outside these two sets is reported rather
// than classified: most of the rest names a path of its own (-b/--base-dir,
// -k/--skel, -R/--root), and a walk that stepped over an unknown value-taking
// flag would read its value as the account name. A short form that no committed
// instruction uses is left out for the same reason the mode flags are -- the
// build that needs one extends this, where the review reads the argv.
const ACCOUNT_FLAG_TAKING_A_VALUE = new Set([
  "--uid",
  "--gid",
  "--home",
  "--home-dir",
  "-d",
]);
const ACCOUNT_FLAG_ALONE = new Set(["--create-home", "-m"]);
// Which of the value-taking ones names the home directory handed over.
const ACCOUNT_HOME_FLAG = new Set(["--home", "--home-dir", "-d"]);

// One account command's argv, walked token by token. `homePaths` is what the
// home flags named, resolved against the instruction's WORKDIR the way an
// ownership operand is; `unreadTokens` is every token the walk does not
// understand -- an unknown flag, a flag whose value is missing, a positional
// that is a path rather than an account name, or a second positional where
// these verbs take one.
function readAccountArgv(command, cwd) {
  const argv = command.split(" ");
  const homePaths = [];
  const unreadTokens = [];
  let names = 0;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("-")) {
      names += 1;
      if (names > 1 || token.includes("/")) unreadTokens.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const flag = equals === -1 ? token : token.slice(0, equals);
    if (equals === -1 && ACCOUNT_FLAG_ALONE.has(flag)) continue;
    if (!ACCOUNT_FLAG_TAKING_A_VALUE.has(flag)) {
      unreadTokens.push(token);
      continue;
    }
    let value;
    if (equals === -1) {
      index += 1;
      value = argv[index];
    } else {
      value = token.slice(equals + 1);
    }
    if (value === undefined || value === "") {
      unreadTokens.push(token);
      continue;
    }
    if (ACCOUNT_HOME_FLAG.has(flag)) homePaths.push(posix.resolve(cwd, value));
  }
  return { verb: argv[0], homePaths, unreadTokens };
}

function analyze(file) {
  const dockerfile = readRepoFile(file);

  // Drop comment lines, then fold "\"-continued lines into one logical
  // instruction. That order is the load-bearing half: fold first and a comment
  // line's own trailing backslash joins the instruction below it into the
  // comment, which drops that instruction -- an ownership change among them --
  // from every assertion in this file while the build still runs it.
  //
  // The fold removes the backslash and the newline and inserts nothing, which is
  // what Docker's own parser does: a continuation with no space before the
  // backslash joins two tokens into one, and reading it as two would let a
  // command below match as something the build does not run. What the fold
  // cannot settle from here is a "#" reaching an instruction, and the refusal
  // asserted per image below is why it does not have to.
  const instructions = dockerfile
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n")
    .replace(/\\\r?\n/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
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
  // at each instruction, so assertions hold absolute in-image paths. Each RUN is
  // kept with that same WORKDIR, since a path operand it writes relative
  // resolves against it too.
  const runtimeCopies = [];
  const runtimeRunsWithCwd = [];
  {
    let cwd = "/";
    for (const { inst, rest } of runtime) {
      if (inst === "WORKDIR") cwd = posix.resolve(cwd, rest);
      if (inst === "RUN") runtimeRunsWithCwd.push({ run: rest, cwd });
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

  const runsIn = (stage) =>
    stage.filter(({ inst }) => inst === "RUN").map(({ rest }) => rest);

  // Each RUN read as the several commands it runs, split on the operators that
  // separate one from the next. The runtime stage's carry the WORKDIR their
  // instruction runs under. This reads the instruction text, so what it does NOT
  // reach is: ownership a RUN assigns through a shell variable holding the verb
  // or the path (`$SETUP /app`, `chown -R node:node "$DIR"`), ownership assigned
  // inside a script the RUN invokes rather than on the instruction line, a verb
  // outside the enumerated set below, and anything the base image already did.
  const splitCommands = (run) =>
    normalize(run)
      .split(/&&|\|\||[;|]/)
      .map((command) => command.trim())
      .filter((command) => command !== "");

  const runtimeShellCommands = runtimeRunsWithCwd.flatMap(({ run, cwd }) =>
    splitCommands(run).map((command) => ({ command, cwd })),
  );

  return {
    file,
    dockerfile,
    instructions,
    builder,
    runtime,
    runtimeCopies,
    runtimeShellCommands,
    // The builder stage's commands, read the same way. Its files cross into the
    // runtime stage through `COPY --from=builder`, so ownership assigned there
    // is on the same footing as ownership assigned here.
    builderShellCommands: runsIn(builder).flatMap(splitCommands),
    // A chown/chgrp/chmod's path operands: its argv less the command name, its
    // flags, and its first operand, which is the owner, group, or mode --
    // unless a --reference flag supplied that instead, in which case every
    // operand is a path. Each is resolved against the instruction's WORKDIR, so
    // a relative operand and a `..` traversal (`/work/../app`) are tested as the
    // path the build would write rather than as the text the author typed.
    ownershipCommands: runtimeShellCommands
      .filter(({ command }) => PARSED_OWNERSHIP_VERB.test(command))
      .map(({ command, cwd }) => {
        const argv = command.split(" ").slice(1);
        const operands = argv.filter((token) => !token.startsWith("-"));
        const pathOperands = argv.some((token) =>
          token.startsWith("--reference"),
        )
          ? operands
          : operands.slice(1);
        return {
          command,
          paths: pathOperands.map((path) => posix.resolve(cwd, path)),
        };
      }),
    // The runtime stage's account commands, read the same way: the verb's argv
    // walked token by token, so the home directory it hands the account is a
    // path this file tests rather than a string it stepped over.
    accountCommands: runtimeShellCommands
      .filter(({ command }) => PARSED_ACCOUNT_VERB.test(command))
      .map(({ command, cwd }) => ({
        command,
        ...readAccountArgv(command, cwd),
      })),
    allRuntimeDests: runtimeCopies.flatMap(({ dests }) => dests),
    builderRuns: runsIn(builder),
    runtimeRuns: runsIn(runtime),
    // Every package-manager instruction in the FILE, not just the runtime
    // stage: both images build their runtime stage FROM an earlier stage of
    // their own, so a package installed there ships just as surely.
    osInstalls: instructions
      .filter(
        ({ inst, rest }) => inst === "RUN" && OS_PACKAGE_MANAGER.test(rest),
      )
      .map(({ rest }) => `RUN ${normalize(rest)}`),
    npmrcCopies: instructions
      .filter(({ inst, rest }) => inst === "COPY" && /\.npmrc/.test(rest))
      .map(({ rest }) => `COPY ${normalize(rest)}`),
    runtimeEnv: Object.fromEntries(
      runtime
        .filter(({ inst }) => inst === "ENV")
        .map(({ rest }) => {
          const [, key, value] = rest.match(/^(\S+?)=(.*)$/) ?? [];
          return [key, value];
        })
        .filter(([key]) => key !== undefined),
    ),
  };
}

// The instruction that puts the root .npmrc in the builder, frozen. The
// committed file's bytes are held below; this holds which file the builder
// copies, so a second one cannot land on the name and state whatever its author
// put in it. It is a text comparison rather than a model of where a COPY's
// sources land -- Docker copies a directory source's contents, so a file can
// arrive without being named in the instruction at all, which this does not
// reach and docs/spec/DEPENDENCY_PINS.md records as a limit.
const EXPECTED_NPMRC_COPY = "COPY .npmrc package.json package-lock.json ./";

// The base each image's stages build from, frozen by literal. A tag resolves to
// whatever the registry serves that day, so a stage on one is a different
// runtime on every build. Each is the multi-arch index digest, which is the one
// a multi-platform build can resolve: a platform-specific manifest digest names
// one architecture and fails on the other. A builder's base is held as tightly
// as a runtime stage's, because the npm that resolves the tree the runtime
// stage ships is the one the builder's base carries -- a property of the digest
// rather than of anything in this repository, which
// docs/spec/DEPENDENCY_PINS.md records.
const DEFAULT_BASE =
  "node:26-alpine@sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3";
// The variant's base rootfs is coupled to the release snapshot its dnf lines
// pin: the two are the same Amazon Linux release, not merely compatible ones.
const FIPS_BASE =
  "amazonlinux:2023@sha256:694092ae18877ed4e3cb9b643759ba95df1f12af12528fefa18f60f79d4c1568";

// Each image's whole OS-package surface, frozen by literal the way the .npmrc
// COPY above is. The npm tree is copied from the builder and resolves nothing,
// so these installs are the only dependencies an image build fetches from a
// distribution mirror -- which is the claim docs/spec/DEPENDENCY_PINS.md
// records, and a claim prose cannot hold: a second package, or a wider spec on
// one of these lines, ships unreviewed while the sentence still reads as the
// reviewed set.
//
// `modeChangesOutside` is the other per-image literal: every mode change the
// runtime stage makes outside the writable trees, in the order the stage runs
// them. Neither image's list says anything about who owns a path -- the
// entrypoint scripts have to be executable, and each image takes off the
// setuid and setgid bits its own OS closure arrives with, which is what leaves
// both with no such file for image_smoke.yaml's inventory step to find.
const IMAGES = [
  {
    file: "Dockerfile",
    // Listed twice because both stages name the base outright rather than the
    // runtime stage building FROM the builder, so each is a separate place the
    // pin can move.
    externalBases: [DEFAULT_BASE, DEFAULT_BASE],
    osInstalls: ["RUN apk add --no-cache samba-client"],
    modeChangesOutside: [
      "chmod g-s /usr/sbin/unix_chkpwd",
      "chmod +x /app/docker-entrypoint.sh",
    ],
  },
  {
    file: "Dockerfile.fips",
    externalBases: [FIPS_BASE],
    osInstalls: [
      "RUN dnf -y --releasever=${AL2023_RELEASEVER} install tar gzip xz findutils libatomic && dnf clean all",
      "RUN dnf -y --releasever=${AL2023_RELEASEVER} install samba-client openssl && dnf clean all",
      "RUN dnf -y --releasever=${AL2023_RELEASEVER} swap openssl-fips-provider-latest ${FIPS_PROVIDER_PACKAGE}-${FIPS_PROVIDER_VERSION} && dnf clean all",
    ],
    // Ten files against the default image's one: the Amazon Linux 2023 base and
    // the samba-client closure carry account, mount and PAM helpers Alpine's
    // busybox userland does not.
    modeChangesOutside: [
      "chmod u-s,g-s /usr/bin/chage /usr/bin/gpasswd /usr/bin/mount " +
        "/usr/bin/newgrp /usr/bin/su /usr/bin/umount /usr/bin/write " +
        "/usr/libexec/utempter/utempter /usr/sbin/pam_timestamp_check " +
        "/usr/sbin/unix_chkpwd",
      "chmod +x /app/docker-entrypoint.sh /app/docker-entrypoint-fips.sh",
    ],
  },
].map((spec) => ({ ...spec, image: analyze(spec.file) }));

// Follow the ENTRYPOINT to the script that actually runs node. The FIPS variant
// puts a reporting preamble in front of the shared dispatch script, so the
// chain can be more than one file; every script on it must be copied into the
// runtime stage, or the image starts by failing to exec a path that is not
// there.
function dispatchChain(image) {
  const entrypoint = image.runtime.find(({ inst }) => inst === "ENTRYPOINT");
  const entrypointArgv = JSON.parse(entrypoint.rest);
  const chain = [entrypointArgv[entrypointArgv.length - 1]];
  let script = readRepoFile(posix.basename(chain[chain.length - 1]));
  while (!/^\s*exec\s+node\b/m.test(script)) {
    const handoff = script
      .split("\n")
      .map((line) => line.trim())
      .find((line) => /^exec\s+\S+\.sh\b/.test(line));
    if (handoff === undefined || chain.length > 4) {
      throw new Error(
        `${chain[chain.length - 1]} neither runs node nor execs another shipped script`,
      );
    }
    chain.push(handoff.replace(/^exec\s+/, "").split(/\s+/)[0]);
    script = readRepoFile(posix.basename(chain[chain.length - 1]));
  }
  return { entrypointArgv, chain, script };
}

for (const { file, externalBases, osInstalls, image } of IMAGES) {
  describe(`${file} dependency freeze`, () => {
    it("uses ADD nowhere, nor any other instruction class this file does not parse", () => {
      expect(
        image.instructions
          .filter(({ inst }) => inst === "ADD")
          .map(({ inst, rest }) => `${inst} ${rest}`),
      ).toEqual([]);
      expect(
        [...new Set(image.instructions.map(({ inst }) => inst))].filter(
          (inst) => !REVIEWED_INSTRUCTIONS.includes(inst),
        ),
      ).toEqual([]);
    });

    it("carries no # inside an instruction, so this parse and Docker's cannot disagree", () => {
      // Comment lines are gone before the fold in analyze(), so a "#" reaching
      // an instruction is either text Docker takes literally mid-line or a form
      // whose reading depends on where each parser thinks the instruction ended.
      // Neither Dockerfile has one, and refusing it is what keeps the fold from
      // having to agree with Docker about a case no build here exercises.
      expect(
        image.instructions
          .filter(({ inst, rest }) => inst.includes("#") || rest.includes("#"))
          .map(({ inst, rest }) => `${inst} ${rest}`),
      ).toEqual([]);
    });

    it("builds every stage from the reviewed base digest, or from a stage of its own", () => {
      // A FROM naming a stage this file declared earlier carries that stage's
      // base with it; every other one reaches a registry, and is held to the
      // literal above. Comparing the whole list, in order, is what covers a
      // stage that drops its digest for the bare tag, one re-pinned onto
      // another digest, and a stage added or removed -- each of which changes
      // the list rather than any single element the parse could be asked about.
      const declaredStages = new Set();
      const bases = [];
      for (const { inst, rest } of image.instructions) {
        if (inst !== "FROM") continue;
        const tokens = normalize(rest).split(" ");
        if (!declaredStages.has(tokens[0])) bases.push(tokens[0]);
        const as = tokens.findIndex((token) => token.toUpperCase() === "AS");
        if (as !== -1) declaredStages.add(tokens[as + 1]);
      }
      expect(bases).toEqual(externalBases);
    });

    it("installs only with npm ci, never npm install", () => {
      expect(image.dockerfile).not.toMatch(/\bnpm\s+install\b/);
      expect(image.builderRuns.some((run) => /\bnpm ci\b/.test(run))).toBe(
        true,
      );
    });

    it("copies the committed lockfile into the builder before the first npm ci", () => {
      const firstCi = image.builder.findIndex(
        ({ inst, rest }) => inst === "RUN" && /\bnpm ci\b/.test(rest),
      );
      const lockCopy = image.builder.findIndex(
        ({ inst, rest }) =>
          inst === "COPY" && rest.includes("package-lock.json"),
      );
      expect(lockCopy).toBeGreaterThanOrEqual(0);
      expect(firstCi).toBeGreaterThan(lockCopy);
    });

    it("copies the root .npmrc into the builder before the first npm ci, and copies no other", () => {
      // Without it the image builds under npm's defaults: strict-allow-scripts
      // is off, and a package that gains an install script installs unreviewed.
      expect(image.npmrcCopies).toEqual([EXPECTED_NPMRC_COPY]);
      const firstCi = image.builder.findIndex(
        ({ inst, rest }) => inst === "RUN" && /\bnpm ci\b/.test(rest),
      );
      const npmrcCopy = image.builder.findIndex(
        ({ inst, rest }) => inst === "COPY" && /\.npmrc/.test(rest),
      );
      expect(npmrcCopy).toBeGreaterThanOrEqual(0);
      expect(firstCi).toBeGreaterThan(npmrcCopy);
    });

    it("empties the tree and omits both dev and optional on the builder's last npm command", () => {
      // A static parse reads the instruction, never the tree the build
      // resolves, so this holds the shape of the command and claims nothing
      // about which packages ship. Each of the three parts is what a measured
      // install turned on: `npm ci` empties node_modules only when it is
      // unscoped, and drops a package flagged `dev` while keeping one flagged
      // `devOptional`, so a -w scoped `npm ci --omit=dev` with no wipe reads as
      // a production install while shipping most of the build tree.
      // docs/spec/CONTAINER_IMAGES.md carries the measurement and what remains
      // unasserted here.
      const npmRuns = image.builderRuns.filter((run) => /\bnpm\b/.test(run));
      expect(npmRuns.length).toBeGreaterThan(0);
      const last = normalize(npmRuns[npmRuns.length - 1]);
      expect(last).toMatch(/\brm -rf node_modules && npm ci\b/);
      expect(last).toMatch(/\bnpm ci\b[^&|;]*\s--omit=dev(?=\s|$)/);
      expect(last).toMatch(/\bnpm ci\b[^&|;]*\s--omit=optional(?=\s|$)/);
    });

    it("runs no npm in the runtime stage, so the copied tree is what ships", () => {
      expect(image.runtimeRuns.filter((run) => /\bnpm\b/.test(run))).toEqual(
        [],
      );
    });

    it("installs exactly the reviewed OS packages", () => {
      expect(image.osInstalls).toEqual(osInstalls);
    });

    it("copies the builder's node_modules into the runtime stage", () => {
      const copy = image.runtimeCopies.find(({ sources }) =>
        sources.includes("/build/node_modules"),
      );
      expect(copy).toBeDefined();
      expect(copy.flags).toContain("--from=builder");
      expect(copy.dests).toEqual(["/app/node_modules"]);
    });

    it("copies both workspace link targets so the node_modules links resolve", () => {
      // node_modules/@psilink/core -> ../../packages/core and
      // node_modules/psilink -> ../apps/cli must not dangle.
      expect(image.allRuntimeDests).toContain(
        "/app/packages/core/package.json",
      );
      expect(image.allRuntimeDests).toContain("/app/apps/cli/package.json");
    });
  });

  describe(`${file} runtime layout`, () => {
    // The runtime ENTRYPOINT is a dispatch script serving two roles: the default
    // CLI and, on a `serve` first argument, the web console server. The
    // node/--expose-gc and worker-colocation invariants live in that script, so
    // they are read from its `exec node ...` lines rather than from the
    // ENTRYPOINT argv directly.
    const { entrypointArgv, chain, script } = dispatchChain(image);
    const execArgv = (predicate) => {
      const line = script
        .split("\n")
        .map((l) => l.trim())
        .find((l) => /^exec\s+node\b/.test(l) && predicate(l));
      return line.replace(/^exec\s+/, "").split(/\s+/);
    };
    const cliArgv = execArgv((l) => l.includes("--expose-gc"));
    const cliEntryPath = cliArgv.find((t) => t.endsWith("index.js"));

    it("ships every script on the entrypoint chain", () => {
      expect(entrypointArgv).toEqual([chain[0]]);
      for (const scriptPath of chain) {
        expect(image.allRuntimeDests).toContain(scriptPath);
      }
    });

    it("runs the copied CLI entry under node with --expose-gc", () => {
      expect(cliArgv[0]).toBe("node");
      expect(cliArgv).toContain("--expose-gc");
      expect(cliEntryPath).toBeDefined();
      expect(image.allRuntimeDests).toContain(cliEntryPath);
    });

    it("places the PSI worker entry beside the CLI entry", () => {
      // psiWorkerHost resolves `<__dirname>/psiWorker.worker.js`; anywhere else
      // and createPsiEngine silently falls back to the in-process engine.
      expect(image.allRuntimeDests).toContain(
        posix.join(posix.dirname(cliEntryPath), "psiWorker.worker.js"),
      );
    });

    it("runs the web server entry, under a copied directory, for the serve role", () => {
      const serveArgv = execArgv((l) => l.includes(".output"));
      const serverEntry = serveArgv.find((t) => t.includes(".output"));
      expect(serverEntry).toBeDefined();
      // The server entry lives under a directory the runtime stage copies in.
      expect(
        image.allRuntimeDests.some(
          (dest) => serverEntry === dest || serverEntry.startsWith(dest + "/"),
        ),
      ).toBe(true);
    });
  });
}

// The account both roles run as, and the one instruction that makes each image
// habitable for it, frozen by literal the way the OS installs above are. Which
// directories are handed over is the whole substance of running unprivileged:
// /work is where the CLI writes its result and rotated key file, and the console
// cannot boot at all without a scratch directory under root-owned /run. Prose in
// docs/DEPLOYMENT.md tells operators the uid a bind mount must be writable by, so
// a silent change of it, or of what the account may write, is a change to
// documented deployment behavior rather than an implementation detail.
//
// Held over both published images. They differ in where the account comes from
// -- the default image inherits it from node:26-alpine, the variant creates it,
// Amazon Linux 2023 carrying none -- and in nothing this block reads.
const RUNTIME_USER = "node";
const EXPECTED_WRITABLE_SETUP =
  "RUN mkdir -p /work /run/psilink/sftp-credentials " +
  "&& chown -R node:node /work /run/psilink " +
  "&& chmod -R 700 /run/psilink";

// The other half of that claim: /app is NOT among them, so the process reads and
// executes its own code without being able to rewrite it. The Dockerfile says so
// in a comment, which cannot hold it -- a `--chown` on a COPY, or one path added
// to the chown above, hands the code to the account the entrypoint runs as and
// reads as ordinary housekeeping in a diff.
const WRITABLE_TREES = ["/work", "/run/psilink"];
const withinWritableTree = (path) =>
  WRITABLE_TREES.some((tree) => path === tree || path.startsWith(`${tree}/`));

// The verbs that hand a path to an account by a route that parse does not read
// -- install's -o/-g/-m, setfacl's ACL entry -- plus any of the parsed ones
// reached other than as a command's leading word (`sh -c 'chown ...'`, `xargs
// chown`, `find ... -exec chgrp`). Neither stage runs any of these, so they are
// refused outright rather than modeled: a build that needs one has to extend
// this test, where the review reads the argv rather than a verdict about it.
const OWNERSHIP_PROPER_VERB = /\b(?:chown|chgrp|chmod|setfacl)\b/;
const INSTALL_VERB = /\binstall\b/;
// `install` is coreutils' install(1), whose -o/-g/-m hand a path to an account.
// A package manager's `install` is that manager's own subcommand, a different
// program's argument that reaches nothing, so the exemption below releases the
// first non-flag token after the manager's name -- the subcommand position in
// every shape the committed Dockerfiles use, though a global flag carrying a
// separate value token that is literally `install` would take the release in
// its place. That stays harmless: a manager-led command never executes
// install(1), and an `install` token anywhere later is still refused. Two
// halves make the position what it says: the manager's name is the whole
// leading token, since a trailing-boundary match reads `yum-config-manager install -o node /app/x` as
// yum's; and the subcommand is the first token after it that is not a flag, so
// `npm exec -- install -o node /app/x` and `npm exec install -o node /app/x`
// are refused while `dnf -y --releasever=X install tar` passes. An install
// token anywhere else in the command is refused whatever leads the command, as
// a proper ownership verb already is (`npm exec -- chown ...`).
const PACKAGE_MANAGER_NAME = /^(?:apk|apt|apt-get|dnf|microdnf|yum|npm)$/;
// The index of the released install token, or -1. A flag carrying its value as
// the next token rather than after an `=` pushes that value into the subcommand
// position and takes the exemption with it; neither Dockerfile writes one, and
// refusing that shape is this file's standing answer to an argv it cannot read.
const releasedInstallIndex = (argv) => {
  if (!PACKAGE_MANAGER_NAME.test(argv[0])) return -1;
  const subcommand = argv.findIndex(
    (token, index) => index > 0 && !token.startsWith("-"),
  );
  return subcommand !== -1 && argv[subcommand] === "install" ? subcommand : -1;
};
const reachesInstallVerb = (command) => {
  const argv = command.split(" ");
  const released = releasedInstallIndex(argv);
  return argv.some(
    (token, index) => index !== released && INSTALL_VERB.test(token),
  );
};
const reachesAnyOwnershipVerb = (command) =>
  OWNERSHIP_PROPER_VERB.test(command) || reachesInstallVerb(command);
const reachesOwnershipOutsideTheParse = (command) =>
  reachesAnyOwnershipVerb(command) && !PARSED_OWNERSHIP_VERB.test(command);
// The dash-leading tokens that parse reads on one of those verbs: -R (or
// --recursive), and --reference=FILE, which is what moves the first operand from
// an owner or a mode to a path. Any other is refused rather than classified,
// because a mode is spelled like a flag: `chmod -R -w /app` takes the write bit
// off /app, and a parse that reads every dash-leading token as an option drops
// the mode, takes /app for the mode instead, and hands the guard below an empty
// path set. The stage passes -R alone.
const READ_OWNERSHIP_FLAGS = /^(?:-R|--recursive|--reference=\S+)$/;

// An account verb reached other than as a command's leading word -- `sh -c
// 'useradd ...'`, `xargs usermod` -- is refused rather than parsed, exactly as
// an ownership verb in that position is.
const ACCOUNT_VERB = /\b(?:useradd|adduser|usermod|groupadd)\b/;
const reachesAccountVerbOutsideTheParse = (command) =>
  ACCOUNT_VERB.test(command) && !PARSED_ACCOUNT_VERB.test(command);
// Which of them hand the account a home directory. groupadd makes no home; the
// other three must name theirs, since the home a bare `useradd node` creates is
// whatever /etc/login.defs and the distribution decide, which this file would
// have to model rather than read.
const HOME_MAKING_ACCOUNT_VERB = /^(?:useradd|adduser|usermod)$/;
// The home directory an image may hand its runtime account, frozen by literal
// the way the writable trees are. The account owns its own home, so this is the
// one path outside those trees an account command may create it under, and it
// is where the CLI writes a long-lived signing key: the default signing-identity
// directory is derived from HOME while the CLI's module loads, so which
// directory that is, and who owns it, is what decides where the key lands.
const ACCOUNT_HOME_DIRECTORIES = ["/home/node"];

describe("the ownership-verb predicate the refusals above share", () => {
  it("releases only a package manager's own install subcommand", () => {
    expect(reachesAnyOwnershipVerb("dnf -y install tar && dnf clean all")).toBe(
      false,
    );
    expect(
      reachesAnyOwnershipVerb(
        "dnf -y --releasever=2023.12.20260727 install samba-client openssl",
      ),
    ).toBe(false);
    expect(reachesAnyOwnershipVerb("apk add --no-cache samba-client")).toBe(
      false,
    );
    expect(reachesAnyOwnershipVerb("xargs install -o node /app/x")).toBe(true);
    expect(
      reachesAnyOwnershipVerb("npm exec -- chown -R 1000:1000 /build/x"),
    ).toBe(true);
    // coreutils' install(1) run under a package manager's leading word: the
    // install is the pm's argument rather than its subcommand, so it reaches
    // /app with -o and -m while starting with neither chown, chgrp nor chmod.
    expect(
      reachesAnyOwnershipVerb("npm exec -- install -o node -m 0777 /app/x"),
    ).toBe(true);
    expect(reachesAnyOwnershipVerb("npm exec install -o node /app/x")).toBe(
      true,
    );
    // A hyphen continuation of a package manager's name is a different program.
    expect(
      reachesAnyOwnershipVerb("yum-config-manager install -o node /app/x"),
    ).toBe(true);
    // The exemption covers one token, so a second install in the same command
    // is still refused -- as is one reached through a path.
    expect(
      reachesAnyOwnershipVerb("dnf -y install tar install -o node /app/x"),
    ).toBe(true);
    expect(reachesAnyOwnershipVerb("/usr/bin/install -o node /app/x")).toBe(
      true,
    );
  });

  it("refuses an account verb reached other than as the leading word", () => {
    expect(
      reachesAccountVerbOutsideTheParse(
        "useradd --uid 1000 --gid node --create-home --home-dir /home/node node",
      ),
    ).toBe(false);
    expect(reachesAccountVerbOutsideTheParse("sh -c useradd")).toBe(true);
    expect(
      reachesAccountVerbOutsideTheParse("xargs usermod -d /app node"),
    ).toBe(true);
  });

  it("reads the home directory an account command hands over", () => {
    const read = (command, cwd = "/") => readAccountArgv(command, cwd);
    expect(
      read(
        "useradd --uid 1000 --gid node --create-home --home-dir /home/node node",
      ),
    ).toEqual({ verb: "useradd", homePaths: ["/home/node"], unreadTokens: [] });
    expect(read("groupadd --gid 1000 node")).toEqual({
      verb: "groupadd",
      homePaths: [],
      unreadTokens: [],
    });
    // The two forms of naming the home, and a relative one resolved against the
    // WORKDIR its instruction runs under.
    expect(read("usermod --home-dir=/app node").homePaths).toEqual(["/app"]);
    expect(read("useradd -d ../app node", "/work").homePaths).toEqual(["/app"]);
    // Everything the walk does not understand, reported rather than skipped: an
    // unknown flag that takes a path of its own, a flag with no value left, and
    // a positional that is a path rather than an account name.
    expect(read("useradd --base-dir /srv node").unreadTokens).toEqual([
      "--base-dir",
      "/srv",
      "node",
    ]);
    expect(read("useradd node --home-dir").unreadTokens).toEqual([
      "--home-dir",
    ]);
    expect(read("useradd /app").unreadTokens).toEqual(["/app"]);
  });
});

for (const { file, modeChangesOutside, image } of IMAGES) {
  describe(`the unprivileged account ${file} runs as`, () => {
    it("drops to a single non-root runtime user for both roles", () => {
      const users = image.runtime
        .filter(({ inst }) => inst === "USER")
        .map(({ rest }) => normalize(rest));
      expect(users).toEqual([RUNTIME_USER]);
    });

    it("declares that user after the last build step, so the ENTRYPOINT inherits it", () => {
      // A USER ahead of a COPY or RUN would either fail the build or leave the
      // dropped account owning /app; one after the last of them, with no second
      // USER to undo it, is what makes the entrypoint's node process
      // unprivileged.
      const userIndex = image.runtime.findIndex(({ inst }) => inst === "USER");
      const lastBuildStep = image.runtime.reduce(
        (last, { inst }, index) =>
          inst === "RUN" || inst === "COPY" ? index : last,
        -1,
      );
      expect(userIndex).toBeGreaterThan(lastBuildStep);
    });

    it("hands that user every directory the container writes", () => {
      expect(image.runtimeRuns.map((run) => `RUN ${normalize(run)}`)).toContain(
        EXPECTED_WRITABLE_SETUP,
      );
    });

    it("assigns ownership only through the forms the two tests below parse", () => {
      // The guard on those tests reads a leading chown/chgrp/chmod and its
      // operands. Every other way an instruction can name one of those verbs --
      // wrapped in `sh -c`, driven by xargs or find, or written as install or
      // setfacl -- is refused here, so an ownership change cannot reach /app by
      // taking a form the parse skips over.
      expect(
        image.runtimeShellCommands
          .filter(({ command }) => reachesOwnershipOutsideTheParse(command))
          .map(({ command }) => command),
      ).toEqual([]);
      // The same refusal one altitude down, over the argv of the ones it does
      // read: a dash-leading token outside the two the parse understands decides
      // which operand is the mode and which are paths, so it is refused rather
      // than guessed at.
      expect(
        image.ownershipCommands.flatMap(({ command }) =>
          command
            .split(" ")
            .slice(1)
            .filter(
              (token) =>
                token.startsWith("-") && !READ_OWNERSHIP_FLAGS.test(token),
            )
            .map((token) => `${token} in: ${command}`),
        ),
      ).toEqual([]);
    });

    it("creates an account only through the forms the test below parses", () => {
      // The account verbs are the ownership set's blind spot: a home directory
      // arrives owned by the account it is created for, so an account command
      // hands over a path with no chown, chgrp or chmod anywhere in the stage.
      // The same two refusals stand over them -- reached other than as a
      // command's leading word, and carrying a token the walk cannot read --
      // and the builder creates no account at all, since its files cross into
      // /app carrying whatever ownership that stage left on them.
      expect(
        image.runtimeShellCommands
          .filter(({ command }) => reachesAccountVerbOutsideTheParse(command))
          .map(({ command }) => command),
      ).toEqual([]);
      expect(
        image.builderShellCommands.filter((command) =>
          ACCOUNT_VERB.test(command),
        ),
      ).toEqual([]);
      expect(
        image.accountCommands.flatMap(({ command, unreadTokens }) =>
          unreadTokens.map((token) => `${token} in: ${command}`),
        ),
      ).toEqual([]);
    });

    it("gives the account the reviewed home directory and no other", () => {
      // The home is the account's own to write, so it is a path outside the
      // writable trees that the runtime process can rewrite: a `--home-dir
      // /app` hands over the code the image runs. Held to the literal above
      // rather than to a reading of which paths are safe, and each home-making
      // verb must name its home, since an unnamed one is whatever
      // /etc/login.defs carries -- a value this file cannot see.
      for (const { verb, homePaths } of image.accountCommands) {
        expect(homePaths).toHaveLength(
          HOME_MAKING_ACCOUNT_VERB.test(verb) ? 1 : 0,
        );
      }
      expect(
        image.accountCommands
          .flatMap(({ homePaths }) => homePaths)
          .filter((path) => !ACCOUNT_HOME_DIRECTORIES.includes(path)),
      ).toEqual([]);
      // The other end of the same claim, and the whole of it for the image that
      // inherits its account rather than creating one: the home the runtime
      // reads from the environment is that same reviewed directory.
      expect(ACCOUNT_HOME_DIRECTORIES).toContain(image.runtimeEnv.HOME);
    });

    it("assigns no ownership in the builder stage, whose files the runtime copies in", () => {
      // `COPY --from=builder` carries the builder's files into /app, and what
      // ownership they arrive with is Docker's rule rather than this file's to
      // model. The route is closed instead: the builder assigns no ownership at
      // all, so nothing crosses the stage boundary already handed to an account.
      expect(
        image.builderShellCommands.filter(reachesAnyOwnershipVerb),
      ).toEqual([]);
      expect(
        image.builder
          .filter(({ inst }) => inst === "COPY")
          .flatMap(({ rest }) => rest.split(/\s+/))
          .filter((token) => /^--(?:chown|chmod)/.test(token)),
      ).toEqual([]);
    });

    it("gives that user no path outside those directories, so /app stays root-owned", () => {
      // Every chown and chgrp in the stage, and every COPY that assigns
      // ownership as it lands. A path outside the two writable trees is code, or
      // a mount point, that the entrypoint's own process could then rewrite -- a
      // group handed over no less than an owner, since the account carries its
      // group.
      const handedOverPaths = image.ownershipCommands
        .filter(({ command }) => /^(?:chown|chgrp) /.test(command))
        .flatMap(({ paths }) => paths);
      expect(handedOverPaths.length).toBeGreaterThan(0);
      expect(
        handedOverPaths.filter((path) => !withinWritableTree(path)),
      ).toEqual([]);
      expect(
        image.runtimeCopies
          .filter(({ flags }) => flags.some((f) => f.startsWith("--chown")))
          .flatMap(({ dests }) => dests)
          .filter((dest) => !withinWritableTree(dest)),
      ).toEqual([]);
    });

    it("changes no mode outside those directories but the reviewed ones", () => {
      // A mode is the other way the account reaches what it must not write: a
      // group- or world-writable /app needs no chown to be rewritable, and a
      // setuid or setgid bit left on a helper is a boundary the account can push
      // against. Outside the writable trees the whole set of mode changes is
      // held to this image's reviewed literals rather than to a reading of what
      // each mode grants.
      expect(
        image.ownershipCommands
          .filter(
            ({ command, paths }) =>
              command.startsWith("chmod ") &&
              paths.some((path) => !withinWritableTree(path)),
          )
          .map(({ command }) => command),
      ).toEqual(modeChangesOutside);
      expect(
        image.runtimeCopies
          .filter(({ flags }) => flags.some((f) => f.startsWith("--chmod")))
          .flatMap(({ dests }) => dests)
          .filter((dest) => !withinWritableTree(dest)),
      ).toEqual([]);
    });
  });
}

// The build step that carries the release version into the client bundle, and
// with it into every `docker run` line the partner accept kit prints
// (docs/spec/SERVER_JOB_API.md). Its two halves fail differently and both fail
// quietly: a step that stops setting the variable ships a kit naming the
// floating tag, and a read that yields nothing does the same while the build
// still exits 0. Both images publish this kit -- release.yaml builds and ships
// both -- so both are held to the same step.
describe.each(IMAGES)(
  "the release version $file bakes into the accept kit",
  ({ image }) => {
    const versionRuns = image.builderRuns.filter((run) =>
      run.includes("VITE_PSILINK_VERSION"),
    );

    it("sets the version in exactly one builder step, which is the web build", () => {
      // Same instruction, because the value is this build's process
      // environment and nothing else carries it across a RUN boundary: a
      // version set in one step and a web build in another is a bundle with
      // no version in it.
      expect(versionRuns).toHaveLength(1);
      expect(normalize(versionRuns[0])).toContain("npm run build -w apps/web");
      expect(
        image.builderRuns.filter((run) => run.includes("build -w apps/web")),
      ).toEqual(versionRuns);
    });

    it("reads it from the CLI manifest rather than taking it as a build argument", () => {
      // apps/cli/package.json is the canonical release version
      // (docs/RELEASES.md); an ARG would let `docker build --build-arg` name a
      // version the image is not, which is the disagreement the release check
      // exists to refuse.
      expect(normalize(versionRuns[0])).toContain("apps/cli/package.json");
      expect(
        image.instructions.filter(
          ({ inst, rest }) =>
            (inst === "ARG" || inst === "ENV") &&
            rest.includes("VITE_PSILINK_VERSION"),
        ),
      ).toEqual([]);
    });

    it("fails the build on an empty read rather than baking one", () => {
      // Both halves, since either alone is defeated by an edit that touches
      // neither the reader nor the build: without the gate an empty value
      // bakes, and without `set -e` the gate's non-zero exit is discarded and
      // the build walks on into the web build regardless.
      const commands = normalize(versionRuns[0])
        .split(";")
        .map((command) => command.trim());
      expect(commands[0]).toMatch(/^set -e[ux]*$/);
      expect(commands).toContain('test -n "$VITE_PSILINK_VERSION"');
    });
  },
);

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
  const committed = readFileSync(resolve(repoRoot, ".npmrc"));

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

// What the FIPS variant adds beyond the shared invariants above. Each of these
// is a claim the image makes about a CMVP certificate, and each is the kind of
// claim that goes quietly false: the package name is shared by ten builds with
// ten different modules, only one of them certified, and a configuration that
// names one of OpenSSL's two top-level keys instead of both configures one of
// the two consumers and leaves the other running as though unconfigured.
describe("Dockerfile.fips certificate pins", () => {
  const image = IMAGES.find(({ file }) => file === "Dockerfile.fips").image;
  const argDefault = (name) => {
    const arg = image.instructions.find(
      ({ inst, rest }) => inst === "ARG" && rest.startsWith(`${name}=`),
    );
    return arg?.rest.slice(name.length + 1);
  };

  it("pins the certified provider NVR and the module version the certificate names", () => {
    // Certificate 5021. The package and version decide which build is
    // installed; the module version string is what the installed module reports
    // about itself, and it is the one of the two a package name cannot lie
    // about.
    expect(argDefault("FIPS_PROVIDER_PACKAGE")).toBe(
      "openssl-fips-provider-certified",
    );
    expect(argDefault("FIPS_PROVIDER_VERSION")).toBe("3.0.8-1.amzn2023.0.1");
    expect(argDefault("FIPS_MODULE_VERSION")).toBe("3.0.8-d694bfa693b76001");
  });

  it("pins a release snapshot rather than tracking the moving repository", () => {
    // AWS retains superseded NVRs, so a dated snapshot resolves the same
    // packages on a later rebuild; `latest` does not.
    expect(argDefault("AL2023_RELEASEVER")).toMatch(/^2023\.\d+\.\d{8}$/);
  });

  it("fails the build unless the installed package and the activated module match those pins", () => {
    // The check is what keeps the certificate claim from being prose. Its two
    // halves answer different questions -- which package landed, and which
    // module the loader actually activated -- and dropping either leaves the
    // other satisfiable by a build that ships an uncertified module.
    const assertion = image.runtimeRuns.find(
      (run) => /\btest\b/.test(run) && /\bopenssl list -providers\b/.test(run),
    );
    expect(assertion).toBeDefined();
    expect(assertion).toContain("${FIPS_MODULE_VERSION}");
    const packageAssertion = image.runtimeRuns.find(
      (run) => /\brpm -qf\b/.test(run) && /\btest\b/.test(run),
    );
    expect(packageAssertion).toBeDefined();
    expect(packageAssertion).toContain("${FIPS_PROVIDER_PACKAGE}");
    expect(packageAssertion).toContain("${FIPS_PROVIDER_VERSION}");
    // Asked of the module file the loader will open, not of the package name.
    expect(packageAssertion).toContain("/usr/lib64/ossl-modules/fips.so");
  });

  it("runs every package transaction before the fips-only configuration is in force", () => {
    // Measured: under this configuration dnf's own Python dies on
    // `unsupported hash type blake2s(in FIPS mode)`. A dnf instruction that
    // lands after the ENV therefore breaks the build -- or, worse, is added to
    // a stage where it silently does nothing.
    const opensslConfIndex = image.runtime.findIndex(
      ({ inst, rest }) => inst === "ENV" && rest.startsWith("OPENSSL_CONF="),
    );
    expect(opensslConfIndex).toBeGreaterThanOrEqual(0);
    const lastPackageIndex = image.runtime.reduce(
      (last, { inst, rest }, index) =>
        inst === "RUN" && OS_PACKAGE_MANAGER.test(rest) ? index : last,
      -1,
    );
    expect(lastPackageIndex).toBeLessThan(opensslConfIndex);
  });

  it("strips the setuid and setgid bits after the last package transaction", () => {
    // A dnf transaction landing after the strip puts a bit back, and the
    // instruction ordering is the only thing in the build that decides it. CI's
    // inventory measurement catches the outcome an hour later; this catches the
    // instruction.
    const stripIndex = image.runtime.findIndex(
      ({ inst, rest }) => inst === "RUN" && /\bchmod u-s,g-s\b/.test(rest),
    );
    expect(stripIndex).toBeGreaterThanOrEqual(0);
    const lastPackageIndex = image.runtime.reduce(
      (last, { inst, rest }, index) =>
        inst === "RUN" && OS_PACKAGE_MANAGER.test(rest) ? index : last,
      -1,
    );
    expect(stripIndex).toBeGreaterThan(lastPackageIndex);
  });

  it("points OPENSSL_CONF and OPENSSL_MODULES at what the image actually carries", () => {
    expect(image.allRuntimeDests).toContain(image.runtimeEnv.OPENSSL_CONF);
    expect(image.runtimeEnv.OPENSSL_MODULES).toBe("/usr/lib64/ossl-modules");
  });

  it("carries the pinned module version into the image as an ENV", () => {
    // The entrypoint names the module from this value rather than reading one
    // back, which is sound only because the assertion above already compared it
    // against what the installed module reports. Both halves are needed: drop
    // the runtime stage's ARG redeclaration and the ENV expands to the empty
    // string, at which point every run reports a provider it cannot name --
    // which scripts/docker-entrypoint-fips.test.mjs holds the preamble to, and
    // which is the whole of the per-run assurance the image offers.
    expect(image.runtimeEnv.FIPS_MODULE_VERSION).toBe("${FIPS_MODULE_VERSION}");
    expect(
      image.runtime.some(
        ({ inst, rest }) => inst === "ARG" && rest === "FIPS_MODULE_VERSION",
      ),
    ).toBe(true);
  });
});

// The pin that decides what the variant's Node runtime is made of. The build's
// own checksum step compares the tarball against whatever hash the RUN carries,
// so it cannot notice a committed hash that has drifted from the value
// docs/spec/DEPENDENCY_PINS.md records as resolved and reviewed. These literals
// are what holds it.
describe("Dockerfile.fips Node runtime pins", () => {
  const image = IMAGES.find(({ file }) => file === "Dockerfile.fips").image;

  // The sha256 of each architecture's official nodejs.org tarball, keyed by the
  // node_arch the `case` selects beside it.
  const EXPECTED_TARBALL_SHA256 = {
    x64: "982aa24dd8be4c889c6a8ab337ddff3b0896645b20f4239356e80552c16277ee",
    arm64: "afc7a004018485092ac8985b817b0d5684472bd9472e0b57d2ab88737e50090d",
  };

  const nodeFetch = image.instructions.find(
    ({ inst, rest }) => inst === "RUN" && rest.includes("nodejs.org"),
  );

  it("checks the fetched Node tarball against the committed hash for its architecture", () => {
    expect(nodeFetch).toBeDefined();
    for (const [nodeArch, sha256] of Object.entries(EXPECTED_TARBALL_SHA256)) {
      expect(normalize(nodeFetch.rest)).toContain(
        `node_arch=${nodeArch}; node_sha256=${sha256}`,
      );
    }
    // Piped into the checker, rather than merely present in the instruction.
    expect(nodeFetch.rest).toMatch(
      /echo "\$\{node_sha256\} +node-\$\{NODE_VERSION\}-linux-\$\{node_arch\}\.tar\.xz" \| sha256sum -c -/,
    );
  });

  it("fetches no checksum file anywhere in the build", () => {
    // A checksum file fetched beside the tarball would be served by whatever
    // served the tarball, and would make the literals above decorative. Asserted
    // over every RUN rather than over the one that fetches the tarball: the
    // instruction that reintroduces it need not be the instruction that fetches.
    for (const { inst, rest } of image.instructions) {
      if (inst !== "RUN") continue;
      expect(rest).not.toContain("SHASUMS256.txt");
    }
  });

  it("aborts the layer when the checksum fails rather than carrying on", () => {
    // The pin rests on the checker's non-zero exit reaching `set -e`, and two
    // edits defang it without touching a hash, so every assertion above stays
    // green through both: appending `|| true` to the checker, and dropping the
    // `e` from `set -eux`, after which a FAILED checksum prints and the RUN
    // walks on into `tar`. These two are what hold the property the literals are
    // for.
    expect(normalize(nodeFetch.rest)).toMatch(/^set -eux;/);
    expect(normalize(nodeFetch.rest)).toMatch(/\| sha256sum -c -;/);
  });

  it("carries those hashes as literals rather than as overridable ARGs", () => {
    // `docker build --build-arg` moves an ARG, so a hash carried as one moves
    // with the artifact it is supposed to hold. NODE_VERSION stays an ARG,
    // which is why a Node bump edits these two literals in the same commit.
    const argDefaults = image.instructions
      .filter(({ inst }) => inst === "ARG")
      .map(({ rest }) => rest);
    for (const sha256 of Object.values(EXPECTED_TARBALL_SHA256)) {
      expect(argDefaults.some((arg) => arg.includes(sha256))).toBe(false);
      expect(nodeFetch.rest).toContain(sha256);
    }
  });
});

// The variant's per-run provider report is the exit status of a probe the image
// runs at every container start, so the probe and everything it imports have to
// be in the image. A path that is not there warns on every run, which reads
// exactly like a provider that failed to load.
describe("the engagement probe the FIPS variant runs at startup", () => {
  const image = IMAGES.find(({ file }) => file === "Dockerfile.fips").image;
  const preamble = readRepoFile(posix.basename(dispatchChain(image).chain[0]));
  const probePath = /\bnode\s+(\/\S+\.mjs)\b/.exec(preamble)?.[1];

  it("runs a probe the runtime stage copies in", () => {
    expect(probePath).toBeDefined();
    expect(image.allRuntimeDests).toContain(probePath);
  });

  it("copies in every module that probe imports", () => {
    // Read from the committed source of the copied file rather than from the
    // Dockerfile's source list, so an import added to the probe without a
    // matching COPY reddens here instead of at the operator's first run.
    const copy = image.runtimeCopies.find(({ dests }) =>
      dests.includes(probePath),
    );
    const source = readRepoFile(copy.sources[copy.dests.indexOf(probePath)]);
    const imports = [...source.matchAll(/\bfrom\s+"(\.[^"]+)"/g)].map(
      ([, specifier]) => posix.resolve(posix.dirname(probePath), specifier),
    );
    expect(imports.length).toBeGreaterThan(0);
    for (const imported of imports) {
      expect(image.allRuntimeDests).toContain(imported);
    }
  });
});

describe("the fips-only OpenSSL configuration the variant ships", () => {
  const image = IMAGES.find(({ file }) => file === "Dockerfile.fips").image;
  const copy = image.runtimeCopies.find(({ dests }) =>
    dests.includes(image.runtimeEnv.OPENSSL_CONF),
  );

  // Sections of an OpenSSL configuration file, with comments and blanks
  // dropped. The keys before the first section header are the top-level ones,
  // held under "".
  const sections = {};
  {
    let current = "";
    for (const raw of readRepoFile(copy.sources[0]).split("\n")) {
      const line = raw.replace(/#.*$/, "").trim();
      if (line === "") continue;
      const header = /^\[\s*([^\]\s]+)\s*\]$/.exec(line);
      if (header) {
        current = header[1];
        sections[current] ??= {};
        continue;
      }
      const [key, ...value] = line.split("=");
      (sections[current] ??= {})[key.trim()] = value.join("=").trim();
    }
  }
  const init = sections[""].nodejs_conf;

  it("names the same init section under BOTH top-level keys", () => {
    // Measured: Node's bundled OpenSSL applies `nodejs_conf` and silently
    // ignores a configuration written under `openssl_conf`, while the Amazon
    // Linux 2023 openssl CLI is the opposite. A file naming one of them
    // configures one consumer and leaves the other running unconfigured --
    // which is indistinguishable, by inspection, from a provider that cannot
    // be engaged at all.
    expect(sections[""].openssl_conf).toBe(init);
    expect(init).toBeTruthy();
  });

  it("activates the FIPS and base providers and NOT the default provider", () => {
    // Leaving `default` activated is what turns the whole arrangement into a
    // fallback: an algorithm the certified module does not carry then succeeds
    // through an uncertified implementation instead of failing.
    const providers = sections[sections[init].providers];
    expect(Object.keys(providers).sort()).toEqual(["base", "fips"]);
    for (const section of Object.values(providers)) {
      expect(sections[section].activate).toBe("1");
    }
  });

  it("requires fips=yes as the default property", () => {
    expect(sections[sections[init].alg_section].default_properties).toBe(
      "fips=yes",
    );
  });
});
