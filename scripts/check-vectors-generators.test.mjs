import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EXCUSED_PLACEHOLDER,
  GENERATED_VECTORS,
  UNGENERATED_VECTORS,
  VECTORS_DIRECTORY,
  VERIFIERS,
  checkVectorsGenerators,
  classifyDirectory,
  maskExcusedValues,
} from "./check-vectors-generators.mjs";
import { CHECKS } from "./run-checks.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Nothing here runs the REAL generators, deliberately: the whole set of them is
// ~1.7s of WASM, openssl, and core-dist work per invocation, and running them
// inside a parallel vitest worker would put that beside every other repo-script
// suite for no signal this file cannot get from an injected runner. Their real
// run has its own home -- the `Vectors against their generators` step in
// static_checks.yaml, over the committed tree on every pull request. What is
// left for this file is the logic around them, plus the two facts that CAN be
// asserted cheaply against the real directory: that the manifests classify every
// file in it, and that the check is wired into the gate.

const FIXTURE_DIRECTORY = "vectors";

// A vectors file whose generator prints it, and one whose generator writes it in
// place. The bytes are already in the shape the injected formatter returns, so a
// difference in a test is a difference the check found rather than formatting.
const PRINTED = '{\n  "value": "printed"\n}\n';
const WRITTEN = '{\n  "value": "written"\n}\n';

const printedEntry = {
  vectors: "printed-vectors.json",
  generator: "generate-printed.mjs",
  writes: "stdout",
};
const writtenEntry = {
  vectors: "written-vectors.json",
  generator: "generate-written.mjs",
  writes: "file",
};

describe("maskExcusedValues", () => {
  const signed = `{\n  "signature": "abc-DEF_123",\n  "fingerprint": "kept"\n}\n`;

  it("replaces each named value and counts the replacements", () => {
    const masked = maskExcusedValues(signed, ["signature"]);
    expect(masked.count).toBe(1);
    expect(masked.text).toContain(`"signature": "${EXCUSED_PLACEHOLDER}"`);
    expect(masked.text).toContain('"fingerprint": "kept"');
  });

  it("masks nothing when no key is excused", () => {
    expect(maskExcusedValues(signed, [])).toEqual({
      text: signed,
      count: 0,
      byKey: [],
    });
  });

  it("counts each excused key separately", () => {
    const both = `{\n  "signature": "abc-DEF_123",\n  "signatureProducer": "OpenSSL 3.0.13"\n}\n`;
    expect(
      maskExcusedValues(both, [
        "signature",
        { key: "signatureProducer", value: 'OpenSSL [^"]*' },
      ]).byKey,
    ).toEqual([
      { key: "signature", count: 1 },
      { key: "signatureProducer", count: 1 },
    ]);
  });

  it("does not match a value outside the base64url alphabet, so a changed encoding fails closed", () => {
    const padded = `{\n  "signature": "abc+DEF/123="\n}\n`;
    expect(maskExcusedValues(padded, ["signature"]).count).toBe(0);
  });

  it("masks a value the entry gives its own shape for", () => {
    const banner = `{\n  "signatureProducer": "OpenSSL 3.0.13 30 Jan 2024",\n  "note": "kept"\n}\n`;
    const masked = maskExcusedValues(banner, [
      { key: "signatureProducer", value: 'OpenSSL [^"]*' },
    ]);
    expect(masked.count).toBe(1);
    expect(masked.text).toContain(
      `"signatureProducer": "${EXCUSED_PLACEHOLDER}"`,
    );
    expect(masked.text).toContain('"note": "kept"');
  });

  it("does not match a value outside the shape its entry names, so a changed producer fails closed", () => {
    const banner = `{\n  "signatureProducer": "LibreSSL 3.3.6"\n}\n`;
    expect(
      maskExcusedValues(banner, [
        { key: "signatureProducer", value: 'OpenSSL [^"]*' },
      ]).count,
    ).toBe(0);
  });

  it("masks by the key an entry names and not a key that merely starts with it", () => {
    const both = `{\n  "signature": "abc-DEF_123",\n  "signatureProducer": "OpenSSL 3.0.13"\n}\n`;
    const masked = maskExcusedValues(both, ["signature"]);
    expect(masked.count).toBe(1);
    expect(masked.text).toContain('"signatureProducer": "OpenSSL 3.0.13"');
  });
});

describe("classifyDirectory", () => {
  const manifests = {
    generated: [printedEntry],
    verifiers: [{ script: "verify-something.mjs" }],
    ungenerated: [{ vectors: "hand-written-vectors.json" }],
  };

  it("accounts for a fully classified directory", () => {
    expect(
      classifyDirectory(
        [
          "printed-vectors.json",
          "generate-printed.mjs",
          "verify-something.mjs",
          "hand-written-vectors.json",
        ],
        manifests,
      ),
    ).toEqual({ unclassified: [], missing: [] });
  });

  it("names a vectors file and a generator nobody classified", () => {
    expect(
      classifyDirectory(
        ["printed-vectors.json", "generate-printed.mjs", "new-vectors.json"],
        manifests,
      ).unclassified,
    ).toEqual(["new-vectors.json"]);
  });

  it("names a classified file the directory no longer holds", () => {
    expect(
      classifyDirectory(["printed-vectors.json"], manifests).missing,
    ).toEqual([
      "generate-printed.mjs",
      "hand-written-vectors.json",
      "verify-something.mjs",
    ]);
  });
});

describe("the check against injected generators", () => {
  let root;
  let dir;
  let ran;

  const target = (name) => join(dir, name);

  const run = (options = {}) =>
    checkVectorsGenerators({
      root,
      directory: FIXTURE_DIRECTORY,
      generated: [printedEntry, writtenEntry],
      verifiers: [],
      ungenerated: [],
      format: (text) => text,
      coreDistStaleness: () => null,
      runGenerator: ({ generatorPath }) => {
        ran.push(generatorPath);
        if (generatorPath.endsWith("generate-written.mjs")) {
          writeFileSync(target(writtenEntry.vectors), WRITTEN);
          return "";
        }
        return PRINTED;
      },
      ...options,
    });

  beforeEach(() => {
    ran = [];
    root = mkdtempSync(join(tmpdir(), "vectors-generators-test-"));
    dir = join(root, FIXTURE_DIRECTORY);
    mkdirSync(dir, { recursive: true });
    writeFileSync(target(printedEntry.vectors), PRINTED);
    writeFileSync(target(writtenEntry.vectors), WRITTEN);
    writeFileSync(target(printedEntry.generator), "// printed\n");
    writeFileSync(target(writtenEntry.generator), "// written\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("passes when every generator reproduces its checked-in file", async () => {
    const result = await run();
    expect(result.ok).toBe(true);
    expect(result.results.map((entry) => entry.status)).toEqual([
      "reproduces",
      "reproduces",
    ]);
    expect(readFileSync(target(writtenEntry.vectors), "utf8")).toBe(WRITTEN);
  });

  it("formats the generated text before comparing, as the refresh does", async () => {
    writeFileSync(target(printedEntry.vectors), '{ "value": "printed" }\n');
    const result = await run({
      format: (text) => text.replace(/\s+/g, " ").trim() + "\n",
    });
    expect(
      result.results.find((entry) => entry.vectors === printedEntry.vectors)
        .status,
    ).toBe("reproduces");
  });

  it("fails on a hand-edited file, naming the file, the generator, and the line", async () => {
    writeFileSync(target(writtenEntry.vectors), '{\n  "value": "edited"\n}\n');
    const result = await run();
    expect(result.ok).toBe(false);
    const failure = result.results.find(
      (entry) => entry.vectors === writtenEntry.vectors,
    );
    expect(failure.status).toBe("differs");
    expect(failure.detail).toContain("written-vectors.json");
    expect(failure.detail).toContain("generate-written.mjs");
    expect(failure.detail).toContain("first difference at line 2");
    expect(result.report).toContain("FAIL  written-vectors.json");
  });

  it("puts the working-tree bytes and timestamps back after regenerating", async () => {
    const path = target(writtenEntry.vectors);
    const when = new Date("2026-01-02T03:04:05Z");
    utimesSync(path, when, when);
    await run();
    expect(readFileSync(path, "utf8")).toBe(WRITTEN);
    expect(statSync(path).mtimeMs).toBe(when.getTime());
  });

  it("restores the working-tree bytes even when the generator disagrees with them", async () => {
    const edited = '{\n  "value": "edited"\n}\n';
    writeFileSync(target(writtenEntry.vectors), edited);
    await run();
    expect(readFileSync(target(writtenEntry.vectors), "utf8")).toBe(edited);
  });

  it("fails closed when a file generator writes nothing", async () => {
    const result = await run({
      runGenerator: () => "",
    });
    const failure = result.results.find(
      (entry) => entry.vectors === writtenEntry.vectors,
    );
    expect(failure.status).toBe("did-not-write");
    expect(failure.detail).toContain("a comparison it never made");
  });

  it("fails closed when a stdout generator writes the file instead", async () => {
    const result = await run({
      runGenerator: ({ target: path }) => {
        writeFileSync(path, PRINTED);
        return PRINTED;
      },
    });
    const failure = result.results.find(
      (entry) => entry.vectors === printedEntry.vectors,
    );
    expect(failure.status).toBe("wrote-unexpectedly");
  });

  it("fails closed when the generator removes the file", async () => {
    const result = await run({
      runGenerator: ({ target: path }) => {
        rmSync(path);
        return "";
      },
    });
    expect(result.results.map((entry) => entry.status)).toEqual([
      "removed-the-file",
      "removed-the-file",
    ]);
    expect(readFileSync(target(printedEntry.vectors), "utf8")).toBe(PRINTED);
  });

  it("fails carrying the generator's own output when it exits non-zero", async () => {
    const result = await run({
      runGenerator: () => {
        const error = new Error("Command failed");
        error.stdout = "";
        error.stderr = "Error: Cannot find module '@openmined/psi.js'";
        throw error;
      },
    });
    const failure = result.results[0];
    expect(failure.status).toBe("generator-failed");
    expect(failure.detail).toContain("Cannot find module '@openmined/psi.js'");
  });

  it("fails without running the generator when the vectors file is absent", async () => {
    rmSync(target(printedEntry.vectors));
    const result = await run({ generated: [printedEntry] });
    expect(result.results[0].status).toBe("absent");
    expect(ran).toEqual([]);
  });

  it("fails when the generator itself is absent", async () => {
    rmSync(target(printedEntry.generator));
    const result = await run({ generated: [printedEntry] });
    expect(result.results[0].status).toBe("generator-absent");
  });

  it("fails on a declared output shape it cannot read", async () => {
    const result = await run({
      generated: [{ ...printedEntry, writes: "somewhere" }],
    });
    expect(result.results[0].status).toBe("bad-manifest");
  });

  it("fails on a directory entry no manifest classifies", async () => {
    writeFileSync(target("surprise-vectors.json"), "{}\n");
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.coverage.unclassified).toEqual(["surprise-vectors.json"]);
    expect(result.report).toContain("surprise-vectors.json");
  });

  it("fails on a classified file the directory no longer holds", async () => {
    const result = await run({
      ungenerated: [{ vectors: "gone-vectors.json", reason: "gone" }],
    });
    expect(result.ok).toBe(false);
    expect(result.coverage.missing).toEqual(["gone-vectors.json"]);
  });

  it("does not run the generators at all when the core dist is stale", async () => {
    const result = await run({
      generated: [{ ...writtenEntry, needsCoreDist: true }],
      coreDistStaleness: () => ({
        kind: "stale",
        source: { path: "src/main.ts", mtimeMs: 2 },
        dist: { path: "dist/core.esm.js", mtimeMs: 1 },
      }),
    });
    expect(result.ok).toBe(false);
    expect(ran).toEqual([]);
    expect(result.report).toContain("npm run build -w packages/core");
  });

  it("does not consult the core dist when no generator needs it", async () => {
    let consulted = false;
    await run({
      coreDistStaleness: () => {
        consulted = true;
        return null;
      },
    });
    expect(consulted).toBe(false);
  });
});

describe("excused values", () => {
  let root;
  let dir;

  const excusedEntry = {
    vectors: "signed-vectors.json",
    generator: "generate-signed.mjs",
    writes: "stdout",
    excusedKeys: ["signature"],
    excuse: "ECDSA draws a fresh nonce per signature.",
  };
  const committed = `{\n  "signature": "AAAA-bbbb_1",\n  "fingerprint": "pinned"\n}\n`;
  const resigned = `{\n  "signature": "CCCC-dddd_2",\n  "fingerprint": "pinned"\n}\n`;

  const run = (produced) =>
    checkVectorsGenerators({
      root,
      directory: FIXTURE_DIRECTORY,
      generated: [excusedEntry],
      verifiers: [],
      ungenerated: [],
      format: (text) => text,
      coreDistStaleness: () => null,
      runGenerator: () => produced,
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vectors-excused-test-"));
    dir = join(root, FIXTURE_DIRECTORY);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, excusedEntry.vectors), committed);
    writeFileSync(join(dir, excusedEntry.generator), "// signed\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("passes when only the excused values moved, and says how many", async () => {
    const result = await run(resigned);
    expect(result.ok).toBe(true);
    expect(result.results[0].excused).toBe(1);
    expect(result.report).toContain("1 excused value(s)");
  });

  it("still fails on a deterministic field beside an excused one", async () => {
    const result = await run(
      `{\n  "signature": "CCCC-dddd_2",\n  "fingerprint": "moved"\n}\n`,
    );
    expect(result.ok).toBe(false);
    expect(result.results[0].status).toBe("differs");
    expect(result.results[0].detail).toContain("fingerprint");
  });

  it("fails closed when the excuse matches nothing, rather than excusing the file", async () => {
    writeFileSync(
      join(dir, excusedEntry.vectors),
      `{\n  "fingerprint": "pinned"\n}\n`,
    );
    const result = await run(`{\n  "fingerprint": "pinned"\n}\n`);
    expect(result.ok).toBe(false);
    expect(result.results[0].status).toBe("excuse-inert");
    expect(result.results[0].detail).toContain("ECDSA");
  });

  it("fails closed when the two sides carry different numbers of excused values", async () => {
    const result = await run(`{\n  "fingerprint": "pinned"\n}\n`);
    expect(result.ok).toBe(false);
    expect(result.results[0].status).toBe("excuse-inert");
    expect(result.results[0].detail).toContain("1 time(s) in the committed");
  });

  it("does not mask a near-miss key, so a renamed field is compared", async () => {
    const result = await run(
      `{\n  "signature": "CCCC-dddd_2",\n  "signature2": "EEEE",\n  "fingerprint": "pinned"\n}\n`,
    );
    expect(result.ok).toBe(false);
    expect(result.results[0].status).toBe("differs");
    expect(result.results[0].detail).toContain("signature2");
  });
});

describe("an excused value recorded from the host", () => {
  let root;
  let dir;

  const excusedEntry = {
    vectors: "signed-vectors.json",
    generator: "generate-signed.mjs",
    writes: "stdout",
    excusedKeys: [{ key: "signatureProducer", value: 'OpenSSL [^"]*' }],
    excuse: "signatureProducer records the openssl that signed the file.",
  };
  const onThisHost = `{\n  "signatureProducer": "OpenSSL 3.0.20 7 Apr 2026",\n  "fingerprint": "pinned"\n}\n`;
  const onTheRunner = `{\n  "signatureProducer": "OpenSSL 3.0.13 30 Jan 2024",\n  "fingerprint": "pinned"\n}\n`;

  const run = (produced) =>
    checkVectorsGenerators({
      root,
      directory: FIXTURE_DIRECTORY,
      generated: [excusedEntry],
      verifiers: [],
      ungenerated: [],
      format: (text) => text,
      coreDistStaleness: () => null,
      runGenerator: () => produced,
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vectors-producer-test-"));
    dir = join(root, FIXTURE_DIRECTORY);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, excusedEntry.vectors), onThisHost);
    writeFileSync(join(dir, excusedEntry.generator), "// signed\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("passes when only the recorded producer moved, so another host's openssl does not fail the check", async () => {
    const result = await run(onTheRunner);
    expect(result.ok).toBe(true);
    expect(result.results[0].excused).toBe(1);
  });

  it("still fails on a deterministic field beside it", async () => {
    const result = await run(
      `{\n  "signatureProducer": "OpenSSL 3.0.13 30 Jan 2024",\n  "fingerprint": "moved"\n}\n`,
    );
    expect(result.ok).toBe(false);
    expect(result.results[0].status).toBe("differs");
    expect(result.results[0].detail).toContain("fingerprint");
  });

  it("fails closed when the producer stops matching the shape the excuse names", async () => {
    const result = await run(
      `{\n  "signatureProducer": "LibreSSL 3.3.6",\n  "fingerprint": "pinned"\n}\n`,
    );
    expect(result.ok).toBe(false);
    expect(result.results[0].status).toBe("excuse-inert");
    expect(result.results[0].detail).toContain("signatureProducer");
  });
});

describe("an entry excusing more than one key", () => {
  let root;
  let dir;

  const excusedEntry = {
    vectors: "signed-vectors.json",
    generator: "generate-signed.mjs",
    writes: "stdout",
    excusedKeys: [
      "signature",
      { key: "signatureProducer", value: 'OpenSSL [^"]*' },
    ],
    excuse: "Both are values a rerun does not reproduce.",
  };
  const committed = `{\n  "first": {\n    "signature": "AAAA-bbbb_1"\n  },\n  "second": {\n    "signature2": "CCCC-dddd_2"\n  },\n  "signatureProducer": "OpenSSL 3.0.20 7 Apr 2026"\n}\n`;

  const run = (produced) =>
    checkVectorsGenerators({
      root,
      directory: FIXTURE_DIRECTORY,
      generated: [excusedEntry],
      verifiers: [],
      ungenerated: [],
      format: (text) => text,
      coreDistStaleness: () => null,
      runGenerator: () => produced,
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vectors-multikey-test-"));
    dir = join(root, FIXTURE_DIRECTORY);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, excusedEntry.vectors), committed);
    writeFileSync(join(dir, excusedEntry.generator), "// signed\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("passes when every excused key moved, counting them all", async () => {
    const result = await run(
      `{\n  "first": {\n    "signature": "EEEE-ffff_3"\n  },\n  "second": {\n    "signature2": "CCCC-dddd_2"\n  },\n  "signatureProducer": "OpenSSL 3.0.13 30 Jan 2024"\n}\n`,
    );
    expect(result.ok).toBe(true);
    expect(result.results[0].excused).toBe(2);
  });

  // Both sides total two masked values here, so only a per-key comparison sees
  // that one mask picked up a second match while the other stopped matching.
  it("fails closed on an inert mask the totals agree over", async () => {
    const result = await run(
      `{\n  "first": {\n    "signature": "EEEE-ffff_3"\n  },\n  "second": {\n    "signature": "GGGG-hhhh_4"\n  },\n  "signatureProducer": "LibreSSL 3.3.6"\n}\n`,
    );
    expect(result.ok).toBe(false);
    expect(result.results[0].status).toBe("excuse-inert");
    expect(result.results[0].detail).toContain("signatureProducer");
  });
});

describe("the manifests against the real vectors directory", () => {
  const dir = resolve(repoRoot, VECTORS_DIRECTORY);

  it("classifies every file that is there", () => {
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    expect(classifyDirectory(names)).toEqual({ unclassified: [], missing: [] });
  });

  it("declares an output shape the check can read for every generator", () => {
    for (const entry of GENERATED_VECTORS) {
      expect(["file", "stdout"]).toContain(entry.writes);
    }
  });

  it("states a reason beside every excused generator and unGenerated file", () => {
    for (const entry of GENERATED_VECTORS) {
      if (entry.excusedKeys) expect(entry.excuse).toBeTruthy();
    }
    for (const entry of UNGENERATED_VECTORS) expect(entry.reason).toBeTruthy();
    for (const entry of VERIFIERS) expect(entry.reason).toBeTruthy();
  });

  // Every excused key has to fire against the committed bytes here, where the
  // suite runs on any host, rather than first being noticed by the gate on a
  // host whose openssl differs from the one that last regenerated the file.
  it("matches every excused key against the vectors file it is declared for", () => {
    const inert = [];
    for (const entry of GENERATED_VECTORS) {
      const committed = readFileSync(join(dir, entry.vectors), "utf8");
      for (const excused of entry.excusedKeys ?? []) {
        if (maskExcusedValues(committed, [excused]).count === 0) {
          inert.push({
            vectors: entry.vectors,
            key: typeof excused === "string" ? excused : excused.key,
          });
        }
      }
    }
    expect(inert).toEqual([]);
  });
});

describe("wiring", () => {
  const read = (path) => readFileSync(resolve(repoRoot, path), "utf8");

  it("is a root npm script", () => {
    expect(JSON.parse(read("package.json")).scripts["check:vectors"]).toBe(
      "node scripts/check-vectors-generators.mjs",
    );
  });

  it("runs on every pull request", () => {
    expect(CHECKS.map((check) => check.script)).toContain("check:vectors");
  });
});
