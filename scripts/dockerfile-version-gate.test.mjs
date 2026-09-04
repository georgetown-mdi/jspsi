import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The gate on the release version the default image bakes into the client
// bundle, driven rather than read. scripts/dockerfile-freeze.test.mjs pins the
// step's structure -- that it reads the CLI manifest, gates the value, and runs
// the web build in the same instruction -- and structure is what a text
// assertion can hold. Whether the gate actually stops the build is a property of
// running it: `test -n` appended with `|| true`, or a `set -e` that a later
// edit's subshell swallows, leaves every structural assertion green while an
// empty version bakes and the kit names the floating tag.
//
// So the instruction's own text is lifted out of the Dockerfile and run: the
// reader against real manifests under the real node, and the whole command under
// a POSIX shell with node and npm stubbed, which is what lets the empty read and
// the failing read be produced on demand.
//
// What this cannot determine: the image builds under busybox ash and this runs
// under /bin/sh, so a divergence between the two on `set -e` in an assignment is
// outside it; the stubs are not npm and node; and nothing here observes vite
// reading the exported value. A real build is CI's ground -- image_smoke.yaml
// builds this image, and a release run builds and publishes it.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

// The one builder instruction that sets the variable, with its continuations
// folded the way Docker folds them.
const versionRun = readFileSync(resolve(repoRoot, "Dockerfile"), "utf8")
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n")
  .replace(/\\\r?\n/g, "")
  .split("\n")
  .map((line) => line.trim())
  .find(
    (line) => line.startsWith("RUN ") && line.includes("VITE_PSILINK_VERSION"),
  )
  .replace(/^RUN /, "");

// The manifest read, as the instruction spells it: the `node -p` expression and
// the path it requires, so a manifest under this test's control can be put in
// that path's place.
const [, readerExpression] = /node -p "([^"]+)"/.exec(versionRun);
const [, manifestPath] = /require\('([^']+)'\)/.exec(readerExpression);

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "psilink-version-gate-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The instruction's own reader, run by the real node against a manifest. */
function readVersion(manifest) {
  const path = join(dir, "package.json");
  if (manifest !== undefined) writeFileSync(path, manifest);
  const expression = readerExpression.replace(manifestPath, path);
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, ["-p", expression], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    };
  } catch (error) {
    return { status: error.status, stdout: error.stdout };
  }
}

/**
 * The whole instruction, run under a POSIX shell with node and npm stubbed. The
 * node stub stands in for the manifest read (its output and exit status are the
 * cases the gate exists for); the npm stub records the version it was handed, or
 * never runs at all when the gate stopped the build.
 */
function runInstruction({ output, status }) {
  const bin = join(dir, "bin");
  const record = join(dir, "npm-was-run");
  execFileSync("mkdir", ["-p", bin]);
  writeFileSync(
    join(bin, "node"),
    `#!/bin/sh\nprintf '%s\\n' '${output}'\nexit ${status}\n`,
  );
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh\nprintf '%s' "\${VITE_PSILINK_VERSION-<unset>}" > '${record}'\n`,
  );
  chmodSync(join(bin, "node"), 0o755);
  chmodSync(join(bin, "npm"), 0o755);
  let exitStatus = 0;
  try {
    execFileSync("/bin/sh", ["-c", versionRun], {
      env: { PATH: bin },
      stdio: "ignore",
    });
  } catch (error) {
    exitStatus = error.status;
  }
  return {
    status: exitStatus,
    buildRan: existsSync(record),
    buildSaw: existsSync(record) ? readFileSync(record, "utf8") : undefined,
  };
}

describe("the manifest read the image build's version step performs", () => {
  it("yields the release version the manifest has", () => {
    expect(readVersion('{"name":"psilink","version":"0.4.2"}')).toEqual({
      status: 0,
      stdout: "0.4.2\n",
    });
  });

  it("yields nothing for a manifest with no version", () => {
    // `require(...).version` on a manifest without the key renders as the text
    // "undefined", which is non-empty and would sail through the gate below and
    // into the bundle. Yielding the empty string instead is what routes an
    // absent version into the gate rather than around it.
    expect(readVersion('{"name":"psilink"}')).toEqual({
      status: 0,
      stdout: "\n",
    });
  });

  it("fails rather than yielding anything when the manifest cannot be read", () => {
    expect(readVersion(undefined).status).not.toBe(0);
    expect(readVersion("{ not json").status).not.toBe(0);
  });
});

describe("the build step that bakes it", () => {
  it("hands the read version to the web build", () => {
    expect(runInstruction({ output: "0.4.2", status: 0 })).toEqual({
      status: 0,
      buildRan: true,
      buildSaw: "0.4.2",
    });
  });

  it("fails, and never builds, when the read yields nothing", () => {
    // The failure this gate is for: an empty value reaches vite, the bundle
    // has no version, and the accept kit tells the partner to run the
    // floating tag while the image is published under a release tag.
    const run = runInstruction({ output: "", status: 0 });
    expect(run.status).not.toBe(0);
    expect(run.buildRan).toBe(false);
  });

  it("fails, and never builds, when the read itself fails", () => {
    const run = runInstruction({ output: "", status: 1 });
    expect(run.status).not.toBe(0);
    expect(run.buildRan).toBe(false);
  });
});
