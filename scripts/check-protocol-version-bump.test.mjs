import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  COVERED_VECTORS,
  PINS_FILE,
  PRE_PUBLICATION_RELEASE,
  PROTOCOL_VERSION_SOURCE,
  RELEASE_MANIFEST,
  UNCOVERED_VECTORS,
  VECTORS_DIRECTORY,
  classificationReport,
  classifyVectorsDirectory,
  isPublishedRelease,
  ledgerSuggestionVersion,
  manifestVersion,
  parseReleaseVersion,
  pinViolations,
  protocolVersionFrom,
  wireFormatDigest,
} from "./check-protocol-version-bump.mjs";
import { CHECKS } from "./run-checks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const SCRIPT = resolve(here, "check-protocol-version-bump.mjs");

const readRoot = (relative) =>
  readFileSync(resolve(repoRoot, relative), "utf8");

// The script driven as the workflow runs it, against `root` or -- with no root
// -- against this repository.
function runCheck(root) {
  const args = root === undefined ? [SCRIPT] : [SCRIPT, "--root", root];
  try {
    const stdout = execFileSync(process.execPath, args, {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return { status: error.status, stdout: error.stdout, stderr: error.stderr };
  }
}

const temporaryRoots = [];
afterAll(() => {
  for (const root of temporaryRoots)
    rmSync(root, { recursive: true, force: true });
});

/** Every classified vectors file's content, with `overrides` applied by name. */
function vectorsSources(overrides = {}) {
  const sources = {};
  for (const { vectors } of [...COVERED_VECTORS, ...UNCOVERED_VECTORS]) {
    sources[vectors] =
      overrides[vectors] ?? JSON.stringify({ pinned: vectors });
  }
  return sources;
}

/** The ledger entry those sources imply for the covered files. */
function pinOf(sources) {
  const digests = {};
  for (const { vectors } of COVERED_VECTORS) {
    digests[vectors] = wireFormatDigest(sources[vectors]);
  }
  return digests;
}

/**
 * A tree carrying only what the check reads: the release manifest, the
 * PROTOCOL_VERSION source, the vectors directory, and the pin ledger. This is
 * how the armed states -- which this repository has not reached -- are driven
 * end to end through the real script.
 */
function fixtureTree({
  releaseVersion = PRE_PUBLICATION_RELEASE,
  protocolVersion = 1,
  sources = vectorsSources(),
  pins = {},
  extraVectors = {},
}) {
  const root = mkdtempSync(resolve(tmpdir(), "psilink-protocol-pin-"));
  temporaryRoots.push(root);
  const write = (relative, content) => {
    mkdirSync(resolve(root, dirname(relative)), { recursive: true });
    writeFileSync(resolve(root, relative), content);
  };
  write(RELEASE_MANIFEST, JSON.stringify({ version: releaseVersion }));
  write(
    PROTOCOL_VERSION_SOURCE,
    `export const PROTOCOL_VERSION = ${protocolVersion};\n`,
  );
  for (const [vectors, content] of Object.entries({
    ...sources,
    ...extraVectors,
  })) {
    write(`${VECTORS_DIRECTORY}/${vectors}`, content);
  }
  write(PINS_FILE, JSON.stringify({ pins }, null, 2));
  return root;
}

describe("the release marker the rule arms on", () => {
  it("reads a release version out of its shape", () => {
    expect(parseReleaseVersion("0.2.0")).toEqual([0, 2, 0]);
    expect(parseReleaseVersion("10.4.11")).toEqual([10, 4, 11]);
  });

  it("reads a prerelease or build suffix as the release it qualifies", () => {
    // A published `0.2.0-rc.1` puts peers in the field exactly as `0.2.0` does,
    // so the suffix must not disarm the rule.
    expect(isPublishedRelease("0.2.0-rc.1")).toBe(true);
    expect(isPublishedRelease("0.2.0+build.5")).toBe(true);
  });

  it("holds the rule inert at and below the pre-publication release", () => {
    expect(isPublishedRelease(PRE_PUBLICATION_RELEASE)).toBe(false);
    expect(isPublishedRelease("0.0.9")).toBe(false);
  });

  it("arms on the next release of any number, not on a 1.0 milestone", () => {
    // A marker waiting for 1.0 would read a published 0.2.0 as pre-publication,
    // which is the silent miss this floor exists to avoid.
    expect(isPublishedRelease("0.1.1")).toBe(true);
    expect(isPublishedRelease("0.2.0")).toBe(true);
    expect(isPublishedRelease("1.0.0")).toBe(true);
  });

  it("reads a version it cannot parse as neither, rather than as inert", () => {
    for (const version of ["", "latest", "0.1", "v0.2.0", undefined]) {
      expect(isPublishedRelease(version)).toBeUndefined();
    }
  });

  it("reads an absent, empty, or non-string manifest version as none", () => {
    expect(manifestVersion('{"version":"0.1.0"}')).toBe("0.1.0");
    expect(manifestVersion('{"name":"psilink"}')).toBeUndefined();
    expect(manifestVersion('{"version":""}')).toBeUndefined();
    expect(manifestVersion('{"version":2}')).toBeUndefined();
  });
});

describe("the PROTOCOL_VERSION the pin is held against", () => {
  it("reads the integer literal the source exports", () => {
    expect(protocolVersionFrom("export const PROTOCOL_VERSION = 1;\n")).toBe(1);
    expect(
      protocolVersionFrom(
        "const x = 3;\nexport const PROTOCOL_VERSION = 42;\n",
      ),
    ).toBe(42);
  });

  it("reads anything else as none rather than guessing", () => {
    // A computed or re-exported value is not a literal this can read, and a
    // check that guessed at one would hold the pin against a version the build
    // does not advertise.
    expect(
      protocolVersionFrom("export const PROTOCOL_VERSION = VERSIONS.wire;\n"),
    ).toBeUndefined();
    expect(
      protocolVersionFrom("export { PROTOCOL_VERSION };\n"),
    ).toBeUndefined();
  });

  it("reads the committed source", () => {
    expect(protocolVersionFrom(readRoot(PROTOCOL_VERSION_SOURCE))).toBe(1);
  });
});

describe("the digest standing in for the wire format", () => {
  it("does not move on formatting", () => {
    // The committed vectors are prettier-formatted and a prettier release can
    // reflow them; that is not a wire-format delta and must not read as one.
    expect(wireFormatDigest('{"a":1,"b":[2,3]}')).toBe(
      wireFormatDigest('{\n  "a": 1,\n  "b": [2, 3]\n}\n'),
    );
  });

  it("moves on any value, key, or ordering", () => {
    const base = wireFormatDigest('{"a":1,"b":2}');
    expect(wireFormatDigest('{"a":2,"b":2}')).not.toBe(base);
    expect(wireFormatDigest('{"a":1,"c":2}')).not.toBe(base);
    expect(wireFormatDigest('{"b":2,"a":1}')).not.toBe(base);
  });
});

describe("the vectors directory's classification", () => {
  it("accounts for every committed vectors file", () => {
    // The coverage guard: a vectors file added beside the others is classified
    // or it fails, so a new wire-format pin cannot escape the check by being
    // nobody's business.
    const { unclassified, missing } = classifyVectorsDirectory(
      readdirSync(resolve(repoRoot, VECTORS_DIRECTORY)),
    );
    expect(unclassified).toEqual([]);
    expect(missing).toEqual([]);
  });

  it("states every file's marker on a passing run", () => {
    // The classification is the whole basis of the check and nothing else
    // displays it, so a run that passes still says what it covered and under
    // which marker it let the rest through.
    const { stdout } = runCheck();
    for (const { vectors } of [...COVERED_VECTORS, ...UNCOVERED_VECTORS]) {
      expect(stdout).toContain(vectors);
    }
    expect(classificationReport()).toHaveLength(
      COVERED_VECTORS.length + UNCOVERED_VECTORS.length,
    );
  });

  it("ignores the generators beside them", () => {
    // check-vectors-generators.mjs classifies those; only *.json carries a pin.
    const { unclassified } = classifyVectorsDirectory([
      ...[...COVERED_VECTORS, ...UNCOVERED_VECTORS].map((e) => e.vectors),
      "generate-kex-vectors.mjs",
      "verify-native-wire-vectors.mjs",
    ]);
    expect(unclassified).toEqual([]);
  });
});

describe("the ledger block a failure prints", () => {
  it("adds the current version's entry when the ledger holds none", () => {
    expect(ledgerSuggestionVersion({}, 1)).toBe(1);
    expect(ledgerSuggestionVersion({ 1: {} }, 2)).toBe(2);
  });

  it("adds the NEXT version's entry when the current one has moved", () => {
    // Printing the in-place rewrite of a published pin would hand over the one
    // edit this check exists to prevent.
    expect(ledgerSuggestionVersion({ 1: {} }, 1)).toBe(2);
  });
});

describe("the rule while it is inert", () => {
  it("holds nothing against a moved wire format", () => {
    // The pre-publication allowance the spec paragraph states: a delta ships
    // within PROTOCOL_VERSION 1, so the pin binds nothing yet.
    expect(
      pinViolations({
        published: false,
        protocolVersion: 1,
        digests: { "psi-engine-wire-vectors.json": "sha256:moved" },
        pins: { 1: { "psi-engine-wire-vectors.json": "sha256:recorded" } },
      }),
    ).toEqual([]);
  });

  it("passes against this repository, which carries no release marker", () => {
    const { status, stdout } = runCheck();
    expect(status).toBe(0);
    expect(stdout).toContain(PRE_PUBLICATION_RELEASE);
    expect(stdout).toContain("Wire-format deltas");
  });

  it("passes a tree whose wire format moved with no bump", () => {
    const sources = vectorsSources();
    const moved = vectorsSources({
      "psi-engine-wire-vectors.json": '{"pinned":"moved"}',
    });
    const root = fixtureTree({
      releaseVersion: PRE_PUBLICATION_RELEASE,
      sources: moved,
      pins: { 1: pinOf(sources) },
    });
    expect(runCheck(root).status).toBe(0);
  });
});

describe("the rule once a release marker arms it", () => {
  it("asks for the pin on the release that first publishes one", () => {
    // The arming moment: the ledger is empty by design, and the first armed run
    // records the wire format this release publishes. It needs no edit to the
    // check itself -- only the marker moved.
    const root = fixtureTree({ releaseVersion: "0.2.0", pins: {} });
    const { status, stderr } = runCheck(root);
    expect(status).toBe(1);
    expect(stderr).toContain("records none for PROTOCOL_VERSION 1");
    expect(stderr).toContain('"psi-engine-wire-vectors.json": "sha256:');
  });

  it("passes an unchanged wire format", () => {
    const sources = vectorsSources();
    const root = fixtureTree({
      releaseVersion: "0.2.0",
      sources,
      pins: { 1: pinOf(sources) },
    });
    const { status, stdout } = runCheck(root);
    expect(status).toBe(0);
    expect(stdout).toContain("published release 0.2.0");
  });

  it("fails a moved wire format carrying no bump, naming the spec paragraph", () => {
    const sources = vectorsSources();
    const moved = vectorsSources({
      "psi-engine-wire-vectors.json": '{"pinned":"a ragged table"}',
    });
    const root = fixtureTree({
      releaseVersion: "0.2.0",
      protocolVersion: 1,
      sources: moved,
      pins: { 1: pinOf(sources) },
    });
    const { status, stderr } = runCheck(root);
    expect(status).toBe(1);
    expect(stderr).toContain("psi-engine-wire-vectors.json has moved");
    expect(stderr).toContain("docs/spec/PROTOCOL.md");
    expect(stderr).toContain("Wire-format deltas");
    // The block it prints records the NEXT version, never a rewrite of the one
    // that shipped.
    expect(stderr).toContain("PROTOCOL_VERSION 2");
  });

  it("passes the same change once it bumps and records the new pin", () => {
    const sources = vectorsSources();
    const moved = vectorsSources({
      "psi-engine-wire-vectors.json": '{"pinned":"a ragged table"}',
    });
    const root = fixtureTree({
      releaseVersion: "0.2.0",
      protocolVersion: 2,
      sources: moved,
      pins: { 1: pinOf(sources), 2: pinOf(moved) },
    });
    expect(runCheck(root).status).toBe(0);
  });

  it("fails a bump that records no pin for the version it introduces", () => {
    const sources = vectorsSources();
    const moved = vectorsSources({
      "psi-engine-wire-vectors.json": '{"pinned":"a ragged table"}',
    });
    const root = fixtureTree({
      releaseVersion: "0.2.0",
      protocolVersion: 2,
      sources: moved,
      pins: { 1: pinOf(sources) },
    });
    const { status, stderr } = runCheck(root);
    expect(status).toBe(1);
    expect(stderr).toContain("records no pin for PROTOCOL_VERSION 2");
  });

  it("holds nothing against a file whose version marker is elsewhere", () => {
    // The classification is load-bearing: a transform-dialect or receipt-format
    // change moves no pin here, because another marker versions it.
    const sources = vectorsSources();
    const moved = vectorsSources({
      "transform-regex-vectors.json": '{"pinned":"a new dialect"}',
      "kex-vectors.json": '{"pinned":"a new suite"}',
    });
    const root = fixtureTree({
      releaseVersion: "0.2.0",
      sources: moved,
      pins: { 1: pinOf(sources) },
    });
    expect(runCheck(root).status).toBe(0);
  });

  it("fails a ledger entry that pins a file this check does not cover", () => {
    const sources = vectorsSources();
    const root = fixtureTree({
      releaseVersion: "0.2.0",
      sources,
      pins: {
        1: { ...pinOf(sources), "kex-vectors.json": "sha256:elsewhere" },
      },
    });
    const { status, stderr } = runCheck(root);
    expect(status).toBe(1);
    expect(stderr).toContain("which this check does not cover");
  });

  it("fails a covered file the ledger entry pins nothing for", () => {
    const sources = vectorsSources();
    const { "psi-intersection-vectors.json": _dropped, ...partial } =
      pinOf(sources);
    const root = fixtureTree({
      releaseVersion: "0.2.0",
      sources,
      pins: { 1: partial },
    });
    const { status, stderr } = runCheck(root);
    expect(status).toBe(1);
    expect(stderr).toContain("pins nothing for");
  });

  it("fails a pin recorded ahead of the version the build advertises", () => {
    const sources = vectorsSources();
    const root = fixtureTree({
      releaseVersion: "0.2.0",
      protocolVersion: 1,
      sources,
      pins: { 1: pinOf(sources), 2: pinOf(sources) },
    });
    const { status, stderr } = runCheck(root);
    expect(status).toBe(1);
    expect(stderr).toContain("above the 1 this build advertises");
    // A malformed ledger is not repaired by a pin to write, so none is printed.
    expect(stderr).not.toContain("would carry for PROTOCOL_VERSION");
  });

  it("fails a ledger with an entry dropped out of the middle", () => {
    // Append-only is what makes a bump an ADDED entry rather than an edited one,
    // which is the difference a reviewer reads.
    const sources = vectorsSources();
    const root = fixtureTree({
      releaseVersion: "0.2.0",
      protocolVersion: 3,
      sources,
      pins: { 1: pinOf(sources), 3: pinOf(sources) },
    });
    const { status, stderr } = runCheck(root);
    expect(status).toBe(1);
    expect(stderr).toContain("but none for 2");
  });

  it("fails a ledger key that is not a PROTOCOL_VERSION, naming the key", () => {
    // A key `Number()` reads as NaN compares false against every version, so a
    // pin recorded under one is held to nothing while sitting in the ledger
    // looking recorded.
    const sources = vectorsSources();
    const root = fixtureTree({
      releaseVersion: "0.2.0",
      sources,
      pins: { 1: pinOf(sources), abc: pinOf(sources) },
    });
    const { status, stderr } = runCheck(root);
    expect(status).toBe(1);
    expect(stderr).toContain(PINS_FILE);
    expect(stderr).toContain('records a pin under "abc"');
    // A malformed ledger is not repaired by a pin to write, so none is printed.
    expect(stderr).not.toContain("would carry for PROTOCOL_VERSION");
  });

  it("fails every key shape a pin lookup would miss", () => {
    // The lookup is by `String(protocolVersion)` exactly: "01" and "1.0" name
    // version 1 to a reader and match no entry this check ever asks for, so
    // each is as unheld as "abc".
    const entry = pinOf(vectorsSources());
    for (const key of ["abc", "1.0", "01", "0", " 1", "", "-1", "1e1"]) {
      const [violation] = pinViolations({
        published: true,
        protocolVersion: 1,
        digests: entry,
        pins: { 1: entry, [key]: entry },
      });
      expect(violation.kind).toBe("ledger");
      expect(violation.message).toContain(`"${key}"`);
    }
    // A version of more than one digit is a ledger key, not a malformed one.
    expect(
      pinViolations({
        published: true,
        protocolVersion: 10,
        digests: entry,
        pins: { 10: entry },
      }),
    ).toEqual([]);
  });
});

describe("the inputs it refuses to run without", () => {
  it("fails a release version it cannot compare, rather than reading it as inert", () => {
    const root = fixtureTree({ releaseVersion: "nightly" });
    const { status, stderr } = runCheck(root);
    expect(status).toBe(1);
    expect(stderr).toContain("could not run");
    expect(stderr).toContain("nightly");
  });

  it("fails a PROTOCOL_VERSION it cannot read", () => {
    const root = fixtureTree({ releaseVersion: "0.2.0" });
    writeFileSync(
      resolve(root, PROTOCOL_VERSION_SOURCE),
      "export const PROTOCOL_VERSION = VERSIONS.wire;\n",
    );
    const { status, stderr } = runCheck(root);
    expect(status).toBe(1);
    expect(stderr).toContain("could not run");
    expect(stderr).toContain(PROTOCOL_VERSION_SOURCE);
  });

  it("fails an unclassified vectors file, armed or not", () => {
    const root = fixtureTree({
      releaseVersion: PRE_PUBLICATION_RELEASE,
      extraVectors: { "new-wire-vectors.json": '{"pinned":"something new"}' },
    });
    const { status, stderr } = runCheck(root);
    expect(status).toBe(1);
    expect(stderr).toContain("new-wire-vectors.json is classified by neither");
    expect(stderr).not.toContain("would carry for PROTOCOL_VERSION");
  });

  it("refuses a --root it was handed no value for", () => {
    const { status } = (() => {
      try {
        execFileSync(process.execPath, [SCRIPT, "--root"], {
          cwd: repoRoot,
          encoding: "utf8",
        });
        return { status: 0 };
      } catch (error) {
        return { status: error.status };
      }
    })();
    expect(status).toBe(2);
  });
});

describe("the check's registration", () => {
  it("is the command the workflow invokes", () => {
    expect(JSON.parse(readRoot("package.json")).scripts).toHaveProperty(
      "check:protocol-version-bump",
      "node scripts/check-protocol-version-bump.mjs",
    );
  });

  it("is on the list the Static Checks gate runs", () => {
    expect(CHECKS.map((check) => check.script)).toContain(
      "check:protocol-version-bump",
    );
  });

  it("starts from an empty ledger, so nothing pre-publication goes stale", () => {
    expect(JSON.parse(readRoot(PINS_FILE)).pins).toEqual({});
  });
});
