import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The FIPS variant's entrypoint preamble, driven end to end against a stub
// `openssl`.
//
// What it stands in for: the operator reading the two lines the container
// prints before it dispatches. The provider line is an assurance line -- it is
// the only per-run signal that the module the image was built around is the one
// serving -- so what it declines to say matters as much as what it says. The
// build asserts version AND status; this pins that the runtime report does too,
// rather than reporting a module the loader never activated.
//
// `openssl` is stubbed on PATH rather than mocked out of the script, so the
// real awk and the real shell parsing run on output shaped like the CLI's.
//
// What it cannot reach: the built image, the host's real
// /proc/sys/crypto/fips_enabled (the host-mode line is whatever this machine
// reports and is not asserted here), and the dispatch itself -- the script ends
// by exec'ing an absolute path that exists only inside the image, so the run
// exits non-zero after the preamble has been written. The preamble is what
// these cases read, and image_smoke.yaml covers the positive path against a
// real build.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const ENTRYPOINT = resolve(repoRoot, "docker-entrypoint-fips.sh");

const CERTIFIED_MODULE = "3.0.8-d694bfa693b76001";

let workdir;

afterEach(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
  workdir = undefined;
});

// Runs the real entrypoint with an `openssl` on PATH that prints the given
// text. Returns everything the preamble wrote to stderr.
function runPreamble(opensslOutput, { exitCode = 0 } = {}) {
  workdir = mkdtempSync(join(tmpdir(), "fips-entrypoint-"));
  const stub = join(workdir, "openssl");
  writeFileSync(
    stub,
    `#!/bin/sh\ncat <<'PROVIDERS'\n${opensslOutput}\nPROVIDERS\nexit ${exitCode}\n`,
  );
  chmodSync(stub, 0o755);

  const result = spawnSync("sh", [ENTRYPOINT, "--help"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${workdir}:${process.env.PATH}` },
  });
  return result.stderr;
}

const activeProviders = `Providers:
  base
    name: OpenSSL Base Provider
    version: 3.5.5
    status: active
  fips
    name: OpenSSL FIPS Provider
    version: ${CERTIFIED_MODULE}
    status: active`;

describe("the FIPS entrypoint's provider report", () => {
  it("names the module when the loader reports it active", () => {
    const stderr = runPreamble(activeProviders);

    expect(stderr).toContain("[psilink] FIPS provider active:");
    expect(stderr).toContain(CERTIFIED_MODULE);
    expect(stderr).not.toContain("no FIPS provider with status active");
  });

  // The regression this pins: a module can be present and named while the
  // loader reports it unavailable -- a fips.so failing its integrity self-test
  // reaches exactly that state. Reading the version line alone reported such a
  // provider as active, which is the one thing the line must never do.
  it("warns rather than claiming active when the provider is not available", () => {
    const stderr = runPreamble(`Providers:
  fips
    name: OpenSSL FIPS Provider
    version: ${CERTIFIED_MODULE}
    status: not available`);

    expect(stderr).toContain("[psilink] WARNING:");
    expect(stderr).toContain("no FIPS provider with status active");
    expect(stderr).not.toContain("FIPS provider active:");
  });

  it("warns when no fips provider is listed at all", () => {
    const stderr = runPreamble(`Providers:
  default
    name: OpenSSL Default Provider
    version: 3.5.5
    status: active`);

    expect(stderr).toContain("no FIPS provider with status active");
    expect(stderr).not.toContain("FIPS provider active:");
  });

  it("warns when openssl itself fails", () => {
    const stderr = runPreamble("", { exitCode: 1 });

    expect(stderr).toContain("no FIPS provider with status active");
    expect(stderr).not.toContain("FIPS provider active:");
  });

  // A status line with no version above it would otherwise report an active
  // provider whose module string is empty.
  it("warns when the listing carries a status but no version", () => {
    const stderr = runPreamble(`Providers:
  fips
    name: OpenSSL FIPS Provider
    status: active`);

    expect(stderr).toContain("no FIPS provider with status active");
    expect(stderr).not.toContain("FIPS provider active:");
  });

  // The scan must not run past the end of the fips block. An awk that sets its
  // flag at the fips header and never clears it keeps waiting for a status line
  // through every block that follows, so a fips block with no status of its own
  // reports the NEXT provider's version and status as the certified module --
  // the same wrong assurance line reached by a different listing shape.
  it("does not borrow a later provider's version when the fips block has no status", () => {
    const stderr = runPreamble(`Providers:
  fips
    name: OpenSSL FIPS Provider
    version: ${CERTIFIED_MODULE}
  default
    name: OpenSSL Default Provider
    version: 3.5.5
    status: active`);

    expect(stderr).toContain("no FIPS provider with status active");
    expect(stderr).not.toContain("FIPS provider active:");
    expect(stderr).not.toContain("3.5.5");
  });

  it("reads the fips block when it is not the first provider listed", () => {
    const stderr = runPreamble(`Providers:
  base
    name: OpenSSL Base Provider
    version: 3.5.5
    status: active
  fips
    name: OpenSSL FIPS Provider
    version: ${CERTIFIED_MODULE}
    status: active`);

    expect(stderr).toContain("FIPS provider active:");
    expect(stderr).toContain(CERTIFIED_MODULE);
    expect(stderr).not.toContain("module 3.5.5");
  });
});

// The tarball fetched in Dockerfile.fips's nodebase stage is checked against the
// release's own SHASUMS256.txt with `sha256sum -c --ignore-missing`. That the
// check fails closed is the property the image's whole Node runtime rests on,
// and CLAUDE.md's rule is to encode such a claim as a check rather than as the
// Dockerfile comment that used to carry it alone. These drive the real tool
// rather than modelling it.
//
// Limit: this runs whatever coreutils the dev container carries, not Amazon
// Linux 2023's coreutils-single, which is what the build will actually use.
describe("the Node tarball checksum check", () => {
  function checkManifest({ manifest, files }) {
    workdir = mkdtempSync(join(tmpdir(), "fips-shasums-"));
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(workdir, name), body);
    }
    writeFileSync(join(workdir, "SHASUMS256.txt"), manifest);

    return spawnSync(
      "sha256sum",
      ["-c", "--ignore-missing", "SHASUMS256.txt"],
      {
        cwd: workdir,
        encoding: "utf8",
      },
    );
  }

  const TARBALL = "node-v26.7.0-linux-x64.tar.xz";
  // sha256 of the exact bytes written as the good tarball below.
  const GOOD =
    "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03";

  it("verifies the tarball when its bytes match the manifest", () => {
    const result = checkManifest({
      manifest: `${GOOD}  ${TARBALL}\ndeadbeef  node-v26.7.0-linux-arm64.tar.xz\n`,
      files: { [TARBALL]: "hello\n" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${TARBALL}: OK`);
  });

  it("fails when the tarball's bytes do not match the manifest", () => {
    const result = checkManifest({
      manifest: `${GOOD}  ${TARBALL}\n`,
      files: { [TARBALL]: "tampered\n" },
    });

    expect(result.status).not.toBe(0);
  });

  // --ignore-missing skips manifest lines whose file is absent, so the name the
  // build fetched being absent from the manifest must not read as success.
  it("fails when the tarball's name is absent from the manifest", () => {
    const result = checkManifest({
      manifest: `deadbeef  node-v26.7.0-linux-s390x.tar.xz\n`,
      files: { [TARBALL]: "hello\n" },
    });

    expect(result.status).not.toBe(0);
  });

  it("fails when the manifest is not a checksum file at all", () => {
    const result = checkManifest({
      manifest: "<html><body>404 Not Found</body></html>\n",
      files: { [TARBALL]: "hello\n" },
    });

    expect(result.status).not.toBe(0);
  });
});
