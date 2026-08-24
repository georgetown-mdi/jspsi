import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  checkProvenance,
  markerProblems,
  nonLookupFailure,
  readMarkerSource,
  resolveTarballName,
  verifyArgv,
} from "./verify-prebuild-provenance.mjs";

// What these cover, and what they deliberately do not. They drive this repo's
// own wiring -- arming, the offline digest binding, argv construction, and how
// a failure propagates and is named -- across an injected verifier boundary.
// They do NOT
// model what `gh attestation verify` decides: reimplementing the verifier's
// semantics here would assert a prediction rather than an outcome. The live
// half is `npm run check:prebuild-provenance`, which drives the real tool
// against the vendored bytes in CI and locally.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ARMED = {
  attestation_expected: true,
  artifact: "openmined-psi.js-9.9.9.tgz",
  sha256: "a".repeat(64),
  producer_repository: "georgetown-mdi/OpenMinedPSI",
  signer_workflow:
    "georgetown-mdi/OpenMinedPSI/.github/workflows/native-prebuilds.yml",
  source_ref: "refs/heads/master",
  source_digest: "b".repeat(40),
};

const DISARMED = {
  attestation_expected: false,
  artifact: ARMED.artifact,
  sha256: ARMED.sha256,
  producer_repository: ARMED.producer_repository,
  signer_workflow: ARMED.signer_workflow,
};

const TARBALL_PATH = "lib/openmined-psi.js-9.9.9.tgz";

// Verbatim stderr from real `gh attestation verify` 2.98.0 runs, captured on
// 2026-08-24: an egress-fenced container for the two unreachable cases, a
// blob with no attestation for the completed lookup, an empty `GH_CONFIG_DIR`
// with no token for the missing credential, and a syntactically valid but
// unknown token for the rejected one. They are fixtures of what the tool said,
// not a model of what it decides; the live half stays
// `npm run check:prebuild-provenance`.
const VERIFIER_STDERR = {
  unreachableBundleHost: `
Error: failed to fetch bundle with URL: failed to fetch bundle with URL: request to fetch bundle from URL failed: Get "https://tmaproduction.blob.core.windows.net/attestations/1015612889/2026/08/24/42646518.json.sn?se=2026-08-24T20%3A00%3A30Z&sp=r&spr=https&sr=b&sv=2026-06-06": dial tcp 20.209.163.161:443: connect: no route to host
`,
  unreachableTrustRoot: `error creating Sigstore verifier: no valid Sigstore verifiers could be initialized
`,
  noAttestation: `
Error: HTTP 404: Not Found (https://api.github.com/repos/georgetown-mdi/OpenMinedPSI/attestations/sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03?per_page=30&predicate_type=https%3A%2F%2Fslsa.dev%2Fprovenance%2Fv1)
`,
  missingCredential: `To get started with GitHub CLI, please run:  gh auth login
Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.
`,
  rejectedCredential: `
Error: HTTP 401: Bad credentials (https://api.github.com/repos/georgetown-mdi/OpenMinedPSI/attestations/sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03?per_page=30&predicate_type=https%3A%2F%2Fslsa.dev%2Fprovenance%2Fv1)
`,
};

// The conclusion an operator must not read for an outage: it is a claim about
// the vendored bytes, and only a completed lookup earns it.
const TAMPERING_SHAPED =
  /carry no attestation|does not match the recorded identity/;

// Fails the test if the verifier is reached; every case that must not consult
// GitHub uses it, so "never called" is asserted rather than assumed.
const unreachableVerifier = () => {
  throw new Error("the verifier must not be reached");
};

function check(overrides = {}) {
  const {
    marker = DISARMED,
    digest = ARMED.sha256,
    tarballPath = TARBALL_PATH,
    runVerifier = unreachableVerifier,
    markerSource = marker === undefined ? undefined : JSON.stringify(marker),
  } = overrides;
  return checkProvenance({ tarballPath, digest, markerSource, runVerifier });
}

describe("resolveTarballName", () => {
  it("resolves the single vendored tarball", () => {
    expect(
      resolveTarballName([
        "openmined-psi.js-2.0.6-seclink.3.tgz",
        "openmined-psi.js-2.0.6-seclink.3.tgz.sha256",
        "openmined-psi.js-2.0.6-seclink.3.tgz.provenance.json",
      ]),
    ).toEqual({ name: "openmined-psi.js-2.0.6-seclink.3.tgz" });
  });

  it("refuses an empty lib/ rather than passing with nothing checked", () => {
    expect(resolveTarballName([]).problem).toMatch(/no vendored prebuild/);
  });

  it("refuses two tarballs rather than picking one", () => {
    const { problem } = resolveTarballName([
      "openmined-psi.js-1.tgz",
      "openmined-psi.js-2.tgz",
    ]);
    expect(problem).toMatch(/found 2/);
  });
});

describe("marker shape", () => {
  it("accepts the armed and disarmed shapes", () => {
    expect(markerProblems(ARMED)).toEqual([]);
    expect(markerProblems(DISARMED)).toEqual([]);
  });

  it("requires the source commit once armed", () => {
    const { source_ref, source_digest, ...withoutSource } = ARMED;
    expect(source_ref).toBeDefined();
    expect(source_digest).toBeDefined();
    const problems = markerProblems(withoutSource);
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toMatch(/source_ref/);
    expect(problems.join("\n")).toMatch(/source_digest/);
  });

  it("does not require the source commit while disarmed", () => {
    expect(markerProblems({ ...DISARMED })).toEqual([]);
  });

  it.each([
    ["attestation_expected", "yes"],
    ["sha256", "A".repeat(64)],
    ["sha256", "abc"],
    ["producer_repository", "OpenMinedPSI"],
    ["signer_workflow", "georgetown-mdi/OpenMinedPSI"],
    ["source_digest", "not-a-commit"],
    ["artifact", ""],
  ])("rejects a bad %s", (field, value) => {
    expect(markerProblems({ ...ARMED, [field]: value })).not.toEqual([]);
  });

  it("rejects a marker that is not an object", () => {
    expect(markerProblems([])).toEqual(["the marker is not a JSON object"]);
    expect(markerProblems(null)).toEqual(["the marker is not a JSON object"]);
  });
});

describe("arming", () => {
  it("passes without consulting the verifier while disarmed", () => {
    const result = check();
    expect(result.ok).toBe(true);
    expect(result.armed).toBe(false);
    expect(result.notes.join("\n")).toMatch(/not armed/);
  });

  it("consults the verifier once armed, and passes on a zero exit", () => {
    const calls = [];
    const result = check({
      marker: ARMED,
      runVerifier: (argv) => {
        calls.push(argv);
        return { status: 0 };
      },
    });
    expect(result.ok).toBe(true);
    expect(result.armed).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("propagates a non-zero verifier exit as a failure", () => {
    const result = check({ marker: ARMED, runVerifier: () => ({ status: 1 }) });
    expect(result.ok).toBe(false);
    expect(result.armed).toBe(true);
    expect(result.problems.join("\n")).toMatch(/exited 1/);
  });

  it("treats an unavailable verifier as a failure, not a skip", () => {
    // An armed check must not pass because the tool it depends on is absent.
    const result = check({
      marker: ARMED,
      runVerifier: () => ({ spawnError: "spawnSync gh ENOENT" }),
    });
    expect(result.ok).toBe(false);
  });
});

describe("what a verifier failure is reported as", () => {
  const failure = (outcome) =>
    check({ marker: ARMED, runVerifier: () => outcome }).problems.join("\n");

  it("names an unrunnable verifier rather than concluding anything about the bytes", () => {
    const problem = failure({ spawnError: "spawnSync gh ENOENT" });
    expect(problem).toMatch(/could not be run: spawnSync gh ENOENT/);
    expect(problem).toMatch(/lookup never happened/);
    expect(problem).not.toMatch(TAMPERING_SHAPED);
  });

  it("names an unreachable Sigstore blob host as a network failure", () => {
    const problem = failure({
      status: 1,
      stderr: VERIFIER_STDERR.unreachableBundleHost,
    });
    expect(problem).toMatch(/exited 1/);
    expect(problem).toMatch(/network failure/);
    expect(problem).not.toMatch(TAMPERING_SHAPED);
  });

  it("names an unreachable trust root as a network failure", () => {
    // This one is the reason the recognizer reads gh's own wording and not
    // only the Go transport strings: the fetch that fails is the TUF trust
    // root, and the message it surfaces carries no network words at all.
    const problem = failure({
      status: 1,
      stderr: VERIFIER_STDERR.unreachableTrustRoot,
    });
    expect(problem).toMatch(/network failure/);
    expect(problem).not.toMatch(TAMPERING_SHAPED);
  });

  it.each([
    ["missing", VERIFIER_STDERR.missingCredential, 4],
    ["rejected", VERIFIER_STDERR.rejectedCredential, 1],
  ])("names a %s credential as a credential failure", (_, stderr, status) => {
    const problem = failure({ status, stderr });
    expect(problem).toMatch(/missing or rejected GitHub credential/);
    expect(problem).not.toMatch(TAMPERING_SHAPED);
  });

  it("keeps the no-attestation conclusion for a lookup that completed", () => {
    const problem = failure({
      status: 1,
      stderr: VERIFIER_STDERR.noAttestation,
    });
    expect(problem).toMatch(TAMPERING_SHAPED);
    expect(problem).toMatch(ARMED.producer_repository);
    expect(problem).toMatch(ARMED.source_digest);
  });

  it("falls back to that conclusion for a shape it does not recognize", () => {
    // The recognizer is best effort, so this is the stated limit rather than a
    // desired outcome: an unrecognized cause is reported as the lookup's own
    // answer. The direction it fails in is what matters, asserted below.
    const problem = failure({ status: 1, stderr: "Error: something new\n" });
    expect(problem).toMatch(TAMPERING_SHAPED);
  });

  it("fails closed whatever the cause", () => {
    const outcomes = [
      { spawnError: "spawnSync gh ENOENT" },
      ...Object.values(VERIFIER_STDERR).map((stderr) => ({
        status: 1,
        stderr,
      })),
      { status: 1, stderr: "Error: something new\n" },
      { status: 1 },
    ];
    for (const outcome of outcomes) {
      const result = check({ marker: ARMED, runVerifier: () => outcome });
      expect(result.ok).toBe(false);
      expect(result.armed).toBe(true);
      expect(result.problems).toHaveLength(1);
    }
  });

  it.each([
    ["a bare exit status", 0],
    ["a bare non-zero status", 1],
    ["nothing at all", undefined],
    ["an outcome carrying neither field", {}],
  ])("refuses to read %s as a verified artifact", (_, outcome) => {
    // The verifier contract is an object; a caller still returning the older
    // bare status would destructure to `status: undefined`, which reads as a
    // clean exit unless this branch catches it first.
    const result = check({ marker: ARMED, runVerifier: () => outcome });
    expect(result.ok).toBe(false);
    expect(result.armed).toBe(true);
    expect(result.problems.join("\n")).toMatch(
      /neither an exit status nor a spawn failure/,
    );
  });

  it("quotes the marker it matched so the operator can judge the call", () => {
    expect(nonLookupFailure(VERIFIER_STDERR.unreachableBundleHost)).toContain(
      "`failed to fetch bundle`",
    );
    expect(nonLookupFailure(VERIFIER_STDERR.rejectedCredential)).toContain(
      "`HTTP 401`",
    );
    expect(nonLookupFailure(VERIFIER_STDERR.noAttestation)).toBeUndefined();
  });
});

describe("the offline binding between the marker and the bytes", () => {
  it("fails on a digest mismatch while disarmed", () => {
    const result = check({ digest: "c".repeat(64) });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/hashes to c{64}/);
  });

  it("fails on a digest mismatch while armed, before reaching the verifier", () => {
    const result = check({
      marker: ARMED,
      digest: "c".repeat(64),
      runVerifier: unreachableVerifier,
    });
    expect(result.ok).toBe(false);
  });

  it("fails when the marker names a different artifact", () => {
    const result = check({ tarballPath: "lib/openmined-psi.js-8.8.8.tgz" });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/8\.8\.8/);
  });

  it("fails on a missing marker rather than falling back to sidecar-only", () => {
    // Called directly: the helper's defaults cannot express an absent marker.
    const result = checkProvenance({
      tarballPath: TARBALL_PATH,
      digest: ARMED.sha256,
      markerSource: undefined,
      runVerifier: unreachableVerifier,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/is missing/);
  });

  it("fails on a marker that is not JSON", () => {
    const result = check({ markerSource: "{ not json" });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/not valid JSON/);
  });

  it("fails on a disarmed marker with a malformed shape", () => {
    // The shape gate runs ahead of the arming branch: a disarmed marker still
    // fails on a bad field, rather than passing because attestation_expected
    // is false. Pins that ordering so a refactor moving the shape check inside
    // the armed branch goes red.
    const result = check({
      marker: { ...DISARMED, producer_repository: "OpenMinedPSI" },
    });
    expect(result.ok).toBe(false);
    expect(result.armed).toBe(false);
    expect(result.problems.join("\n")).toMatch(/producer_repository/);
  });
});

describe("reading the marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "psilink-provenance-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("returns the bytes of a marker that is there", () => {
    const path = join(dir, "present.provenance.json");
    writeFileSync(path, JSON.stringify(DISARMED));
    const { markerSource, problem } = readMarkerSource(path);
    expect(problem).toBeUndefined();
    expect(markerSource).toBe(JSON.stringify(DISARMED));
  });

  it("reports an absent marker as absence rather than a read failure", () => {
    const { markerSource, problem } = readMarkerSource(
      join(dir, "absent.provenance.json"),
    );
    expect(problem).toBeUndefined();
    expect(markerSource).toBeUndefined();
  });

  it("names the read error when a directory sits in the marker's place", () => {
    // Driven against the real filesystem rather than an injected error code, so
    // the reported cause is whatever this platform actually raises.
    const path = join(dir, "directory.provenance.json");
    mkdirSync(path);
    const { markerSource, problem } = readMarkerSource(path);
    expect(markerSource).toBeUndefined();
    expect(problem).toContain(path);
    expect(problem).toMatch(/could not be read/);
    expect(problem).not.toMatch(/is missing/);
  });

  it("does not report an unreadable marker as a missing one", () => {
    const { markerSource, problem } = readMarkerSource(
      TARBALL_PATH + ".provenance.json",
      () => {
        throw Object.assign(new Error("EACCES: permission denied, open"), {
          code: "EACCES",
        });
      },
    );
    expect(markerSource).toBeUndefined();
    expect(problem).toMatch(/EACCES: permission denied/);
    expect(problem).not.toMatch(/is missing/);
  });
});

describe("the verify argument vector", () => {
  it("pins the producer repository, signer workflow, and source commit", () => {
    const argv = verifyArgv(TARBALL_PATH, ARMED);
    expect(argv.slice(0, 3)).toEqual(["attestation", "verify", TARBALL_PATH]);
    const flag = (name) => argv[argv.indexOf(name) + 1];
    expect(flag("--repo")).toBe(ARMED.producer_repository);
    expect(flag("--signer-workflow")).toBe(ARMED.signer_workflow);
    expect(flag("--source-ref")).toBe(ARMED.source_ref);
    expect(flag("--source-digest")).toBe(ARMED.source_digest);
    expect(flag("--predicate-type")).toBe("https://slsa.dev/provenance/v1");
    expect(argv).toContain("--deny-self-hosted-runners");
  });

  it("names no flag `gh attestation verify` does not define", () => {
    // The defined set below is a second hand-written literal, not a read of
    // `gh attestation verify --help`: it catches a typo or an invented flag in
    // verifyArgv, but cannot notice gh renaming or removing a flag out from
    // under it. The real tool is what decides that, at each armed run or
    // re-vendor (docs/PREBUILD_REVENDOR.md, "First armed run").
    const defined = new Set([
      "--repo",
      "--signer-workflow",
      "--source-ref",
      "--source-digest",
      "--predicate-type",
      "--deny-self-hosted-runners",
    ]);
    for (const arg of verifyArgv(TARBALL_PATH, ARMED)) {
      if (arg.startsWith("--")) expect(defined).toContain(arg);
    }
  });
});

describe("the committed marker", () => {
  const libDir = join(root, "lib");
  const { name } = resolveTarballName(readdirSync(libDir));

  it("describes the tarball this repository actually vendors", () => {
    const digest = createHash("sha256")
      .update(readFileSync(join(libDir, name)))
      .digest("hex");
    // The committed marker is armed, so the decision reaches the verifier. It
    // is stubbed to a success exit rather than run: what belongs here is that
    // the marker's own fields build the invocation that names the fork, not a
    // second opinion on what `gh attestation verify` decides about them.
    const invocations = [];
    const result = checkProvenance({
      tarballPath: join("lib", name),
      digest,
      markerSource: readFileSync(
        join(libDir, name + ".provenance.json"),
        "utf8",
      ),
      runVerifier: (argv) => {
        invocations.push(argv);
        return { status: 0 };
      },
    });
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.armed).toBe(true);
    expect(invocations).toHaveLength(1);
    const marker = JSON.parse(
      readFileSync(join(libDir, name + ".provenance.json"), "utf8"),
    );
    expect(invocations[0]).toEqual(verifyArgv(join("lib", name), marker));
  });

  it("agrees with the sha256 sidecar, which is the offline check", () => {
    const marker = JSON.parse(
      readFileSync(join(libDir, name + ".provenance.json"), "utf8"),
    );
    const sidecar = readFileSync(join(libDir, name + ".sha256"), "utf8");
    expect(sidecar.split(/\s+/)[0]).toBe(marker.sha256);
  });

  it("names the fork as producer, under the fork's native-prebuilds workflow", () => {
    const marker = JSON.parse(
      readFileSync(join(libDir, name + ".provenance.json"), "utf8"),
    );
    expect(marker.producer_repository).toBe("georgetown-mdi/OpenMinedPSI");
    expect(marker.signer_workflow).toBe(
      "georgetown-mdi/OpenMinedPSI/.github/workflows/native-prebuilds.yml",
    );
  });
});
