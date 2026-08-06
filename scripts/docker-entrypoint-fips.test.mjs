import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The three runtime checks the FIPS variant image rests on, each driven against
// the real tool rather than a model of it: the entrypoint preamble an operator
// reads at every container start, the engagement probe that preamble's verdict
// comes from, and the `sha256sum` invocation the image's whole Node runtime
// rests on.
//
// The preamble's provider line is an assurance line -- it is the only per-run
// signal that the module the image was built around is the one serving -- so
// what it declines to say matters as much as what it says. It performs no text
// parsing at all: the probe's exit status decides, the module version comes from
// the image's own ENV, and the probe's output is replayed verbatim on the
// failure path. `node` is stubbed on PATH rather than mocked out of the script,
// so the real shell runs.
//
// What these cannot reach: the built image, a running FIPS provider, and the
// dispatch itself -- the script ends by exec'ing an absolute path that exists
// only inside the image, so the run exits non-zero after the preamble has been
// written. The preamble is what these cases read, and image_smoke.yaml covers
// the positive path against a real build.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const ENTRYPOINT = resolve(repoRoot, "docker-entrypoint-fips.sh");
const PROBE = resolve(repoRoot, "support/fips-probe/image-engagement.mjs");

const CERTIFIED_MODULE = "3.0.8-d694bfa693b76001";

let workdir;

afterEach(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
  workdir = undefined;
});

// Runs the real entrypoint with a `node` on PATH that echoes its own argv and
// the given text and then exits with the given status, standing in for the
// engagement probe the image ships. Returns everything the preamble wrote to
// stderr.
function runPreamble({
  probeOutput = "",
  exitCode = 0,
  moduleVersion = CERTIFIED_MODULE,
  opensslOutput = null,
} = {}) {
  workdir = mkdtempSync(join(tmpdir(), "fips-entrypoint-"));
  const stub = join(workdir, "node");
  writeFileSync(
    stub,
    `#!/bin/sh\necho "ran: $*"\ncat <<'PROBE'\n${probeOutput}\nPROBE\nexit ${exitCode}\n`,
  );
  chmodSync(stub, 0o755);
  if (opensslOutput !== null) {
    const openssl = join(workdir, "openssl");
    writeFileSync(
      openssl,
      `#!/bin/sh\ncat <<'PROVIDERS'\n${opensslOutput}\nPROVIDERS\n`,
    );
    chmodSync(openssl, 0o755);
  }

  const result = spawnSync("sh", [ENTRYPOINT, "--help"], {
    encoding: "utf8",
    env: {
      ...process.env,
      FIPS_MODULE_VERSION: moduleVersion,
      PATH: `${workdir}:${process.env.PATH}`,
    },
  });
  return result.stderr;
}

describe("the FIPS entrypoint's provider report", () => {
  it("names the image's pinned module when the probe exits zero", () => {
    const stderr = runPreamble({ exitCode: 0 });

    expect(stderr).toContain("[psilink] FIPS provider active:");
    expect(stderr).toContain(CERTIFIED_MODULE);
  });

  it("reports the version the image baked in, not one read back at run time", () => {
    // The build asserted the installed module reports FIPS_MODULE_VERSION, so
    // the runtime line repeats a fact rather than parsing a claim. A stub
    // reporting some other module is exactly what the old parse would have
    // believed.
    const stderr = runPreamble({
      exitCode: 0,
      moduleVersion: "9.9.9-baked-into-the-image",
      probeOutput: 'IMAGE_ENGAGEMENT_JSON: {"verdict":"ENGAGED"}',
    });

    expect(stderr).toContain("module 9.9.9-baked-into-the-image");
    expect(stderr).not.toContain(CERTIFIED_MODULE);
  });

  it("keeps the probe's transcript off the success path", () => {
    const stderr = runPreamble({
      exitCode: 0,
      probeOutput: "IMAGE ENGAGEMENT VERDICT: ENGAGED",
    });

    expect(stderr).not.toContain("IMAGE ENGAGEMENT VERDICT");
  });

  it("warns and replays the probe's reasons when the probe exits non-zero", () => {
    const stderr = runPreamble({
      exitCode: 1,
      probeOutput: "- fips.so was not mapped into the process",
    });

    expect(stderr).toContain("[psilink] WARNING:");
    expect(stderr).toContain(
      "This image's cryptography is not running in the module it was built around.",
    );
    expect(stderr).toContain("- fips.so was not mapped into the process");
    expect(stderr).not.toContain("FIPS provider active:");
  });

  it("runs the probe the image ships, by its in-image path", () => {
    // The stub echoes its argv, and the failure path replays that. The path
    // asserted here is the one scripts/dockerfile-freeze.test.mjs requires the
    // runtime stage to COPY, which is what binds the two files together.
    const stderr = runPreamble({ exitCode: 1 });

    expect(stderr).toContain("ran: /app/fips-probe/image-engagement.mjs");
  });

  // The regression this pins is the whole reason the report was rebuilt: the
  // Amazon Linux `openssl` CLI is a different libcrypto from the one inside the
  // `node` binary that runs psilink, so a provider it reports as active says
  // nothing about the consumer psilink uses. Nothing in the preamble may consult
  // it, whatever it says.
  it("does not believe the system openssl over the probe", () => {
    const stderr = runPreamble({
      exitCode: 1,
      opensslOutput: `Providers:
  fips
    name: OpenSSL FIPS Provider
    version: ${CERTIFIED_MODULE}
    status: active`,
    });

    expect(stderr).toContain("[psilink] WARNING:");
    expect(stderr).not.toContain("FIPS provider active:");
  });
});

// The probe the preamble's verdict comes from, run as the committed file rather
// than as a reimplementation of its legs.
//
// Limit: nothing outside the built image can reach an ENGAGED verdict, there
// being no FIPS provider to load. The cases below are therefore written against
// the decision rule rather than against a fixed verdict -- each asserts that the
// failure list, the verdict and the exit status agree with the legs actually
// measured, which holds whatever the host serves. Whether psilink's four call
// shapes survive the certified module is CI's to measure against a real build.
describe("the engagement probe the image ships", () => {
  const result = spawnSync(process.execPath, [PROBE], {
    encoding: "utf8",
    cwd: repoRoot,
  });
  const line = result.stdout
    .split("\n")
    .find((l) => l.startsWith("IMAGE_ENGAGEMENT_JSON: "));
  const summary = JSON.parse(line.slice("IMAGE_ENGAGEMENT_JSON: ".length));

  // The primitives docs/COMPLIANCE.md names as dispatching into the validated
  // module, each keyed to the leg that measures it and to the sentence a
  // failure of that leg writes. A claim added there without a leg here is a
  // claim nothing measures.
  const PRODUCT_LEGS = [
    ["aes256gcm_round_trip", "the AES-256-GCM round trip failed"],
    ["hkdf_derive_bits", "the HKDF-SHA-256 derivation failed"],
    ["hmac_sha256_sign", "the HMAC-SHA-256 signature failed"],
    ["sha256_digest", "the SHA-256 digest failed"],
  ];

  it.each(PRODUCT_LEGS)("completes psilink's %s call shape", (leg) => {
    expect(summary.operations[leg]).toEqual({ ok: true, error: null });
  });

  it("fails the run for every product call that did not complete", () => {
    for (const [leg, phrase] of PRODUCT_LEGS) {
      expect(summary.failures.some((f) => f.startsWith(phrase))).toBe(
        !summary.operations[leg].ok,
      );
    }
  });

  it("fails the run when a control no FIPS provider serves succeeded", () => {
    // Attribution rests entirely on these two: an AES success while MD5 also
    // succeeds is a default-provider success wearing the same face.
    for (const [leg, phrase] of [
      ["md5_digest", "an MD5 digest succeeded"],
      ["rsa1024_keygen", "an RSA-1024 keygen succeeded"],
    ]) {
      expect(summary.failures.some((f) => f.startsWith(phrase))).toBe(
        summary.operations[leg].ok,
      );
    }
  });

  it("fails the run when fips.so was not mapped into the process", () => {
    expect(summary.failures.some((f) => f.includes("fips.so was not"))).toBe(
      !summary.fips_module_mapped,
    );
  });

  it("gates on the failures it listed, and says which verdict that is", () => {
    // The property the entrypoint and image_smoke.yaml both read: exit status
    // is the verdict, so a listed failure can never exit 0.
    expect(result.status === 0).toBe(summary.failures.length === 0);
    expect(summary.verdict).toBe(
      summary.failures.length === 0 ? "ENGAGED" : "NOT ENGAGED",
    );
    expect(result.stdout).toContain(
      `IMAGE ENGAGEMENT VERDICT: ${summary.verdict}`,
    );
  });

  it("records the X25519 observation without gating on it", () => {
    // Build-dependent -- the certified Amazon Linux module carries no X25519
    // and other FIPS builds do -- so it is recorded and never a failure.
    expect(summary.operations.x25519_derive_bits).toBeDefined();
    expect(summary.failures.some((f) => f.includes("X25519"))).toBe(false);
  });
});

// The tarball fetched in Dockerfile.fips's nodebase stage is checked against the
// release's own SHASUMS256.txt with `sha256sum -c --ignore-missing`. That the
// check fails closed is the property the image's whole Node runtime rests on,
// and CLAUDE.md's rule is to encode such a claim as a check rather than as a
// Dockerfile comment, which cannot fail. These drive the real tool rather than
// modelling it.
//
// Every digest below is 64 hex characters, valid or not, because coreutils
// rejects a whole manifest carrying no properly formatted line: a short
// placeholder digest makes every case exit non-zero for that reason instead of
// the one it names.
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
  // A well-formed digest of no file here, for the manifest lines that stand in
  // for another architecture's tarball.
  const OTHER_ARCH = "0".repeat(64);

  it("verifies the tarball when its bytes match the manifest", () => {
    const result = checkManifest({
      manifest: `${GOOD}  ${TARBALL}\n${OTHER_ARCH}  node-v26.7.0-linux-arm64.tar.xz\n`,
      files: { [TARBALL]: "hello\n" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${TARBALL}: OK`);
    expect(result.stderr).toBe("");
  });

  it("fails when the tarball's bytes do not match the manifest", () => {
    const result = checkManifest({
      manifest: `${GOOD}  ${TARBALL}\n`,
      files: { [TARBALL]: "tampered\n" },
    });

    expect(result.status).not.toBe(0);
  });

  // --ignore-missing skips manifest lines whose file is absent, so the name the
  // build fetched being absent from the manifest must not read as success. The
  // reason is asserted, not just the exit status: coreutils rejects a malformed
  // manifest with a different message and the same non-zero exit, which is what
  // an earlier version of this case was actually measuring.
  it("fails, for want of a verified file, when the tarball's name is absent from the manifest", () => {
    const result = checkManifest({
      manifest: `${OTHER_ARCH}  node-v26.7.0-linux-s390x.tar.xz\n`,
      files: { [TARBALL]: "hello\n" },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no file was verified");
    expect(result.stderr).not.toContain("no properly formatted checksum lines");
  });

  it("fails when the manifest is not a checksum file at all", () => {
    const result = checkManifest({
      manifest: "<html><body>404 Not Found</body></html>\n",
      files: { [TARBALL]: "hello\n" },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no properly formatted checksum lines");
  });
});
