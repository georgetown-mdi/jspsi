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

function analyze(file) {
  const dockerfile = readRepoFile(file);

  // Fold "\"-continued lines into one logical instruction, then drop blanks and
  // comments. The fold removes the backslash and the newline and inserts
  // nothing, which is what Docker's own parser does: a continuation with no
  // space before the backslash joins two tokens into one, and reading it as two
  // would let a command below match as something the build does not run.
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

  const runsIn = (stage) =>
    stage.filter(({ inst }) => inst === "RUN").map(({ rest }) => rest);

  return {
    file,
    dockerfile,
    instructions,
    builder,
    runtime,
    runtimeCopies,
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

// Each image's whole OS-package surface, frozen by literal the way the .npmrc
// COPY above is. The npm tree is copied from the builder and resolves nothing,
// so these installs are the only dependencies an image build fetches from a
// distribution mirror -- which is the claim docs/spec/DEPENDENCY_PINS.md
// records, and a claim prose cannot hold: a second package, or a wider spec on
// one of these lines, ships unreviewed while the sentence still reads as the
// reviewed set.
const IMAGES = [
  {
    file: "Dockerfile",
    osInstalls: ["RUN apk add --no-cache samba-client"],
  },
  {
    file: "Dockerfile.fips",
    osInstalls: [
      "RUN dnf -y --releasever=${AL2023_RELEASEVER} install tar gzip xz findutils libatomic && dnf clean all",
      "RUN dnf -y --releasever=${AL2023_RELEASEVER} install samba-client openssl && dnf clean all",
      "RUN dnf -y --releasever=${AL2023_RELEASEVER} swap openssl-fips-provider-latest ${FIPS_PROVIDER_PACKAGE}-${FIPS_PROVIDER_VERSION} && dnf clean all",
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

for (const { file, osInstalls, image } of IMAGES) {
  describe(`${file} dependency freeze`, () => {
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

    it("ships a production-only tree: the builder's last npm command is npm ci --omit=dev", () => {
      const npmRuns = image.builderRuns.filter((run) => /\bnpm\b/.test(run));
      expect(npmRuns.length).toBeGreaterThan(0);
      expect(npmRuns[npmRuns.length - 1]).toMatch(/\bnpm ci\b.*--omit=dev/);
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

  it("points OPENSSL_CONF and OPENSSL_MODULES at what the image actually carries", () => {
    expect(image.allRuntimeDests).toContain(image.runtimeEnv.OPENSSL_CONF);
    expect(image.runtimeEnv.OPENSSL_MODULES).toBe("/usr/lib64/ossl-modules");
  });

  it("carries the pinned module version into the image as an ENV", () => {
    // The entrypoint names the module from this value rather than reading one
    // back, which is sound only because the assertion above already compared it
    // against what the installed module reports. Both halves are needed: drop
    // the runtime stage's ARG redeclaration and the ENV expands to the empty
    // string, leaving the per-run assurance line naming no module at all.
    expect(image.runtimeEnv.FIPS_MODULE_VERSION).toBe("${FIPS_MODULE_VERSION}");
    expect(
      image.runtime.some(
        ({ inst, rest }) => inst === "ARG" && rest === "FIPS_MODULE_VERSION",
      ),
    ).toBe(true);
  });
});

// The two pins that decide what the variant's userland and its Node runtime are
// made of. The build's own checksum step compares the tarball against whatever
// hash the RUN carries, so it cannot notice a committed hash that has drifted
// from the value docs/spec/DEPENDENCY_PINS.md records as resolved and reviewed;
// the base digest has no build-time reader at all. These literals are what holds
// both.
describe("Dockerfile.fips base image and Node runtime pins", () => {
  const image = IMAGES.find(({ file }) => file === "Dockerfile.fips").image;

  // The multi-arch index digest, which is the one a multi-platform build can
  // resolve: a platform-specific manifest digest names one architecture and
  // fails on the other.
  const EXPECTED_BASE =
    "amazonlinux:2023@sha256:694092ae18877ed4e3cb9b643759ba95df1f12af12528fefa18f60f79d4c1568";

  // The sha256 of each architecture's official nodejs.org tarball, keyed by the
  // node_arch the `case` selects beside it.
  const EXPECTED_TARBALL_SHA256 = {
    x64: "982aa24dd8be4c889c6a8ab337ddff3b0896645b20f4239356e80552c16277ee",
    arm64: "afc7a004018485092ac8985b817b0d5684472bd9472e0b57d2ab88737e50090d",
  };

  const nodeFetch = image.instructions.find(
    ({ inst, rest }) => inst === "RUN" && rest.includes("nodejs.org"),
  );

  it("builds every stage from that base digest or from another stage of its own", () => {
    // A tag resolves to whatever the registry serves that day, and the base
    // rootfs is coupled to the release snapshot the dnf lines pin: the two are
    // the same Amazon Linux release, not merely compatible ones.
    const declaredStages = new Set();
    const externalBases = [];
    for (const { inst, rest } of image.instructions) {
      if (inst !== "FROM") continue;
      const tokens = normalize(rest).split(" ");
      if (!declaredStages.has(tokens[0])) externalBases.push(tokens[0]);
      const as = tokens.findIndex((token) => token.toUpperCase() === "AS");
      if (as !== -1) declaredStages.add(tokens[as + 1]);
    }
    expect(externalBases).toEqual([EXPECTED_BASE]);
  });

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
    // A checksum file fetched beside the tarball would be served by whatever
    // served the tarball, and would make the literals above decorative.
    expect(nodeFetch.rest).not.toContain("SHASUMS256.txt");
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
